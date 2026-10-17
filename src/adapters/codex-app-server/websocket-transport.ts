import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

export const SHARED_SERVER_URL = 'ws://127.0.0.1:4509'

// A connection, not an engine process. kill() only closes this connection.
export class WebSocketTransport extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  killed = false
  exitCode: number | null = null
  private queue: string[] = []
  private input = ''
  private queuedBytes = 0
  private openTimer: ReturnType<typeof setTimeout>
  private ended = false

  constructor(private socket: WebSocket = new WebSocket(SHARED_SERVER_URL)) {
    super()
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      try {
        this.input += chunk.toString()
        if (Buffer.byteLength(this.input) > 8 * 1024 * 1024) throw new Error('App Server request is too large')
        const lines = this.input.split('\n')
        this.input = lines.pop() ?? ''
        for (const line of lines) if (line) this.send(line)
        done()
      } catch (error) {
        // Writable callbacks are intentionally successful: the transport error
        // rejects RPC promises without an unhandled stream error.
        this.fail(error instanceof Error ? error : new Error('WebSocket write failed'))
        done()
      }
    } })
    this.openTimer = setTimeout(() => this.fail(new Error('Shared Codex WebSocket open timeout')), 10_000)
    socket.addEventListener('open', () => {
      clearTimeout(this.openTimer)
      if (this.ended) return
      try {
        for (const line of this.queue) socket.send(line)
        this.queue = []
        this.queuedBytes = 0
      } catch (error) { this.fail(error instanceof Error ? error : new Error('WebSocket open send failed')) }
    })
    socket.addEventListener('message', (event) => {
      if (this.ended) return
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 32 * 1024 * 1024) {
        this.fail(new Error('Invalid App Server WebSocket frame'))
        return
      }
      try {
        const message = JSON.parse(event.data)
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid App Server message')
        this.stdout.write(JSON.stringify(message) + '\n')
      } catch { this.fail(new Error('Invalid App Server JSON frame')) }
    })
    socket.addEventListener('error', () => this.fail(new Error('Ortak Codex bağlantısı kapalı. Codex’i kapatıp “Codex ile ortak bağlantıyı aç” düğmesini kullanın.')))
    socket.addEventListener('close', () => this.finish())
  }

  private send(line: string): void {
    if (this.ended) throw new Error('Shared Codex connection is closed')
    if (this.socket.readyState === 1) this.socket.send(line)
    else if (this.socket.readyState === 0) {
      this.queuedBytes += Buffer.byteLength(line)
      if (this.queuedBytes > 1024 * 1024) throw new Error('WebSocket initialization queue exceeded')
      this.queue.push(line)
    } else throw new Error('Shared Codex connection is not open')
  }

  private fail(error: Error): void {
    if (this.ended) return
    // finish first: RPC error handlers may synchronously close the transport.
    this.finish(false)
    this.emit('error', error)
    this.emit('exit', 1)
    this.socket.close()
  }

  private finish(emit = true): void {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.openTimer)
    this.exitCode = this.killed ? 0 : 1
    this.queue = []
    this.input = ''
    this.queuedBytes = 0
    this.stdout.end()
    this.stderr.end()
    if (emit) this.emit('exit', this.exitCode)
  }

  kill(): boolean {
    this.killed = true
    this.finish()
    this.socket.close()
    return true
  }
}
