import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { createInterface, type Interface } from 'node:readline'
import { WebSocketTransport } from './websocket-transport'
import { ExecutionObservations, type RpcNotification } from './execution-observations'

export interface RpcServerRequest extends RpcNotification { id: number | string }

export interface RpcTransport extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed: boolean
  exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
}
export type AppServerProcessFactory = () => RpcTransport

interface RpcResponse {
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
  method?: string
  params?: unknown
}

interface PendingRequest {
  owner: RpcTransport
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class AppServerRpcClient {
  readonly observations = new ExecutionObservations()
  private epoch = 0
  private notificationListeners = new Set<(event: RpcNotification) => void>()
  private stateListeners = new Set<() => void>()
  private serverRequests = new Map<string, RpcServerRequest>()
  private listenerFailures = 0
  private process: RpcTransport | null = null
  private lines: Interface | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private starting: Promise<void> | null = null
  private expectedTerminations = new WeakSet<RpcTransport>()

  get connectionEpoch(): number { return this.epoch }
  get listenerFailureCount(): number { return this.listenerFailures }

  onNotification(listener: (event: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => { this.notificationListeners.delete(listener) }
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  private publish<T>(listeners: Set<(event: T) => void>, event: T): void {
    for (const listener of listeners) {
      try { listener(event) } catch { this.listenerFailures += 1 }
    }
  }

  private stateChanged(): void { this.publish(this.stateListeners, undefined) }

  getPendingServerRequests(): RpcServerRequest[] {
    return [...this.serverRequests.values()].map((request) => structuredClone(request))
  }

  // Caller must supply the exact connection and request ID; there is no automatic approval.
  respondToServerRequest(epoch: number, id: number | string, result: unknown): void {
    const key = JSON.stringify([typeof id, id])
    if (epoch !== this.epoch || !this.serverRequests.has(key) || !this.process) {
      throw new Error('Server request is no longer pending on this connection.')
    }
    this.write(this.process, { id, result })
    this.serverRequests.delete(key)
    this.stateChanged()
  }

  constructor(
    private readonly processFactory: AppServerProcessFactory = () => new WebSocketTransport()
  ) {}

  async connect(): Promise<void> {
    if (this.starting) return this.starting
    if (this.process && !this.process.killed) return

    this.starting = this.startProcess()
    try {
      await this.starting
    } catch (error) {
      await this.close()
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Çalışan Codex sunucusuna bağlanılamadı. Codex masaüstünün açık ve bu sürümün kontrol bağlantısını destekliyor olması gerekiyor. ${detail}`)
    } finally {
      this.starting = null
    }
  }

  private async startProcess(): Promise<void> {
    const child = this.processFactory()
    const stderrTail: string[] = []
    this.process = child
    this.epoch += 1
    this.observations.connectionChanged(this.epoch, true)
    this.stateChanged()
    const lines = createInterface({ input: child.stdout })
    this.lines = lines
    lines.on('line', (line) => this.handleLine(child, line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail.push(chunk.trim())
      if (stderrTail.length > 8) stderrTail.shift()
    })
    child.once('error', (error) => {
      if (!this.expectedTerminations.has(child)) this.failPendingFor(child, error)
      this.clearCurrentProcess(child, lines)
    })
    child.once('exit', (code, signal) => {
      if (!this.expectedTerminations.has(child)) {
        const detail = stderrTail.filter(Boolean).join(' ').slice(-1200)
        this.failPendingFor(
          child,
          new Error(
            `Codex App Server stopped (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`
          )
        )
      }
      this.clearCurrentProcess(child, lines)
    })

    await this.request('initialize', {
      clientInfo: {
        name: 'chatgpt_goal_controller',
        title: 'ChatGPT Goal Controller',
        version: '0.1.10-beta.2'
      },
      capabilities: { experimentalApi: true }
    })
    this.notify('initialized', {})
  }

  private clearCurrentProcess(child: RpcTransport, lines: Interface): void {
    if (this.process !== child) return
    this.process = null
    this.serverRequests.clear()
    this.observations.connectionChanged(this.epoch, false)
    this.stateChanged()
    if (this.lines === lines) this.lines = null
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (method !== 'initialize' && (this.starting || !this.process || this.process.killed)) {
      await this.connect()
    } else if (method === 'initialize' && (!this.process || this.process.killed)) {
      throw new Error('Codex App Server could not be started.')
    }

    const id = this.nextId++
    const owner = this.process
    if (!owner || owner.killed) throw new Error('Codex App Server is not connected.')
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`App Server request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        owner,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout
      })
      try {
        this.write(owner, { method, id, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    const owner = this.process
    if (!owner || owner.killed) throw new Error('Codex App Server is not connected.')
    this.write(owner, { method, ...(params === undefined ? {} : { params }) })
  }

  private write(owner: RpcTransport, message: unknown): void {
    if (this.process !== owner || owner.killed || !owner.stdin.writable) {
      throw new Error('Codex App Server is not connected.')
    }
    owner.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(owner: RpcTransport, line: string): void {
    let message: RpcResponse
    try {
      message = JSON.parse(line) as RpcResponse
    } catch {
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    if (this.process !== owner || this.expectedTerminations.has(owner)) return
    if (typeof message.method === 'string') {
      const event: RpcNotification = {
        method: message.method, params: message.params, connectionEpoch: this.epoch, receivedAt: Date.now()
      }
      if (message.id !== undefined) {
        if (typeof message.id !== 'string' && typeof message.id !== 'number') return
        const key = JSON.stringify([typeof message.id, message.id])
        this.serverRequests.set(key, { ...event, id: message.id })
        this.stateChanged()
      } else {
        if (event.method === 'serverRequest/resolved') {
          const params = event.params as { requestId?: unknown } | null
          const id = params?.requestId
          if (typeof id === 'string' || typeof id === 'number') {
            this.serverRequests.delete(JSON.stringify([typeof id, id]))
          }
        }
        this.observations.observe(event)
        this.publish(this.notificationListeners, event)
        if (event.method === 'turn/started' || event.method === 'turn/completed' || event.method === 'serverRequest/resolved') {
          this.stateChanged()
        }
      }
      return
    }
    if (typeof message.id !== 'number' &&
        !(typeof message.id === 'string' && /^(0|[1-9]\d*)$/.test(message.id))) return
    if (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) return
    const numericId = typeof message.id === 'number' ? message.id : Number(message.id)
    const pending = this.pending.get(numericId)
    if (!pending || pending.owner !== owner) return
    clearTimeout(pending.timeout)
    this.pending.delete(numericId)
    if (message.error) {
      pending.reject(
        new Error(
          `App Server error ${message.error.code ?? ''}: ${message.error.message ?? 'Unknown error'}`
        )
      )
      return
    }
    pending.resolve(message.result)
  }

  private failPendingFor(owner: RpcTransport, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.owner !== owner) continue
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  async close(): Promise<void> {
    const child = this.process
    const lines = this.lines
    this.process = null
    this.lines = null
    this.serverRequests.clear()
    this.observations.connectionChanged(this.epoch, false)
    this.stateChanged()
    if (!child) return

    this.expectedTerminations.add(child)
    lines?.close()
    this.failPendingFor(child, new Error('Codex App Server connection was refreshed.'))
    if (child.exitCode !== null || child.killed) return

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill()
    const completed = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500))
    ])
    if (!completed && child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }
}
