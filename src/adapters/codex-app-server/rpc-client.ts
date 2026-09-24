import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { resolveCodexExecutable } from './executable'

export type AppServerProcessFactory = () => ChildProcessWithoutNullStreams

interface RpcResponse {
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
  method?: string
  params?: unknown
}

interface PendingRequest {
  owner: ChildProcessWithoutNullStreams
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class AppServerRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private starting: Promise<void> | null = null
  private expectedTerminations = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(
    private readonly processFactory: AppServerProcessFactory = () => {
      const executable = resolveCodexExecutable()
      return spawn(executable, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env
      })
    }
  ) {}

  async connect(): Promise<void> {
    if (this.process && !this.process.killed) return
    if (this.starting) return this.starting

    this.starting = this.startProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startProcess(): Promise<void> {
    const child = this.processFactory()
    const stderrTail: string[] = []
    this.process = child
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
        version: '0.1.0'
      }
    })
    this.notify('initialized', {})
  }

  private clearCurrentProcess(child: ChildProcessWithoutNullStreams, lines: Interface): void {
    if (this.process !== child) return
    this.process = null
    if (this.lines === lines) this.lines = null
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.process || this.process.killed) {
      if (method === 'initialize') throw new Error('Codex App Server could not be started.')
      await this.connect()
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
      this.write(owner, { method, id, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    const owner = this.process
    if (!owner || owner.killed) throw new Error('Codex App Server is not connected.')
    this.write(owner, { method, ...(params === undefined ? {} : { params }) })
  }

  private write(owner: ChildProcessWithoutNullStreams, message: unknown): void {
    if (this.process !== owner || owner.killed || !owner.stdin.writable) {
      throw new Error('Codex App Server is not connected.')
    }
    owner.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(owner: ChildProcessWithoutNullStreams, line: string): void {
    let message: RpcResponse
    try {
      message = JSON.parse(line) as RpcResponse
    } catch {
      return
    }
    if (message.id === undefined) return
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

  private failPendingFor(owner: ChildProcessWithoutNullStreams, error: Error): void {
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
