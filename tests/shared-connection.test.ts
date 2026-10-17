import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerRpcClient } from '../src/adapters/codex-app-server/rpc-client'


class ProxyChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  exitCode: number | null = null
  messages: Array<{ id?: number; method?: string }> = []
  constructor(failInitialize = false) {
    super()
    let buffer = ''
    this.stdin.on('data', (chunk) => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const message = JSON.parse(line)
        this.messages.push(message)
        if (message.id === undefined) continue
        const response = failInitialize && message.method === 'initialize'
          ? { id: message.id, error: { message: 'control socket unavailable' } }
          : { id: message.id, result: {} }
        queueMicrotask(() => this.stdout.write(JSON.stringify(response) + '\n'))
      }
    })
  }
  kill(): boolean {
    this.killed = true
    this.exitCode = 0
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

afterEach(() => vi.clearAllMocks())

describe('shared local App Server transport', () => {
  it('closes only its injected connection without stopping a shared server', async () => {
    const child = new ProxyChild()
    const factory = vi.fn(() => child)
    const client = new AppServerRpcClient(factory)
    await client.connect()
    expect(factory).toHaveBeenCalledTimes(1)
    await client.close()
    expect(child.killed).toBe(true)
    expect(child.messages.map((message) => message.method)).toEqual(['initialize', 'initialized'])
  })

  it('fails closed, cleans a rejected handshake and never creates a separate engine as fallback', async () => {
    const first = new ProxyChild(true)
    const second = new ProxyChild(true)
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const client = new AppServerRpcClient(factory)
    await expect(client.request('thread/goal/set', { threadId: 'target', status: 'active' })).rejects.toThrow(/bağlanılamadı/)
    expect(first.killed).toBe(true)
    await expect(client.connect()).rejects.toThrow(/control socket unavailable/)
    expect(second.killed).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    expect([...first.messages, ...second.messages].map((message) => message.method)).toEqual(['initialize', 'initialize'])
  })
})
