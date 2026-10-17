import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

// Internal Desktop protocol observed in 26.1007.2314.0. Diagnostic only.
// Never starts a router, claims a writer, handles approvals, or sends mutations.
export const DESKTOP_PIPE = '\\\\.\\pipe\\codex-ipc'
const revisions = { initialize: 0, 'thread-owner-discovery': 1, 'thread-follower-read-model-settings': 1 } as const
type Method = keyof typeof revisions
type Message = Record<string, unknown>

export class DesktopIpcReader {
  private buffer = Buffer.alloc(0)
  private clientId = 'initializing-client'
  private closed = false
  private pending = new Map<string, { method: Method; resolve: (m: Message) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private socket: Socket, private timeoutMs = 5000) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', (error) => this.close(error))
    socket.on('close', () => this.close(new Error('Desktop IPC disconnected')))
  }

  private send(message: Message): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(body.length)
    this.socket.write(Buffer.concat([prefix, body]))
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0)
        if (length === 0 || length > 8 * 1024 * 1024) throw new Error('Invalid Desktop IPC frame length')
        if (this.buffer.length < 4 + length) return
        const message: Message = JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8'))
        this.buffer = this.buffer.subarray(4 + length)
        if (!message || typeof message !== 'object') throw new Error('Invalid Desktop IPC message')
        if (message.type === 'client-discovery-request') {
          this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } })
        } else if (message.type === 'response' && typeof message.requestId === 'string') {
          const pending = this.pending.get(message.requestId)
          if (!pending) continue
          this.pending.delete(message.requestId)
          clearTimeout(pending.timer)
          if (message.method !== pending.method || message.resultType !== 'success') {
            pending.reject(new Error('Desktop IPC request rejected or protocol mismatch'))
          } else pending.resolve(message)
        }
      }
    } catch (error) { this.close(error instanceof Error ? error : new Error('Desktop IPC parse failure')) }
  }

  private request(method: Method, params: Message, targetClientId?: string): Promise<Message> {
    if (this.closed) return Promise.reject(new Error('Desktop IPC closed'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Desktop IPC timeout')), this.timeoutMs)
      this.pending.set(requestId, { method, resolve, reject, timer })
      try {
        this.send({ type: 'request', requestId, sourceClientId: this.clientId, version: revisions[method], method, params, ...(targetClientId ? { targetClientId } : {}) })
      } catch (error) { this.close(error instanceof Error ? error : new Error('Desktop IPC write failure')) }
    })
  }

  async inspect(conversationId: string): Promise<{ ownerClientId: string; settingsAvailable: boolean }> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversationId)) throw new Error('Explicit conversation UUID required')
    const initialized = await this.request('initialize', { clientType: 'goal-controller-diagnostic' })
    const result = initialized.result as { clientId?: unknown } | undefined
    if (typeof result?.clientId !== 'string' || !result.clientId) throw new Error('Desktop IPC initialize format mismatch')
    this.clientId = result.clientId
    const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId })
    if (typeof owner.handledByClientId !== 'string' || !owner.handledByClientId) throw new Error('Desktop owner not verified')
    const settings = await this.request('thread-follower-read-model-settings', { conversationId }, owner.handledByClientId)
    if (settings.handledByClientId !== owner.handledByClientId) throw new Error('Desktop owner changed')
    const payload = settings.result as { settings?: unknown } | undefined
    if (!payload || typeof payload !== 'object' || !('settings' in payload)) throw new Error('Desktop settings format mismatch')
    return { ownerClientId: owner.handledByClientId, settingsAvailable: payload.settings != null }
  }

  close(error = new Error('Desktop IPC reader closed')): void {
    if (this.closed) return
    this.closed = true
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
    this.buffer = Buffer.alloc(0)
    this.socket.destroy()
  }
}

export function connectDesktopReader(): DesktopIpcReader {
  if (process.platform !== 'win32') throw new Error('This diagnostic targets Windows Desktop only')
  return new DesktopIpcReader(createConnection(DESKTOP_PIPE))
}
