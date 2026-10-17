import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  AppServerRpcClient,
  type AppServerProcessFactory
} from '../src/adapters/codex-app-server/rpc-client'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  exitCode: number | null = null
  readonly received: Array<Record<string, unknown>> = []
  private buffer = ''

  constructor(
    private readonly initializeDelayMs: number,
    private readonly emitLateError: boolean
  ) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        const message = JSON.parse(line) as { id?: number; method: string }
        this.received.push(message as unknown as Record<string, unknown>)
        if (!message.method) continue
        if (message.id === undefined || message.method === 'slow') continue
        const delay = message.method === 'initialize' ? this.initializeDelayMs : 0
        setTimeout(() => this.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`), delay)
      }
    })
  }

  kill(): boolean {
    if (this.killed) return true
    this.killed = true
    setTimeout(() => {
      this.exitCode = 0
      this.emit('exit', null, 'SIGTERM')
    }, 5)
    if (this.emitLateError) {
      setTimeout(() => this.emit('error', new Error('late old-process error')), 20)
    }
    return true
  }
}

function asFactory(children: FakeChild[]): AppServerProcessFactory {
  let index = 0
  return () => children[index++] as never
}

describe('AppServerRpcClient process ownership', () => {
  it('ignores a terminated old process while the new process initializes', async () => {
    const first = new FakeChild(0, true)
    const second = new FakeChild(45, false)
    const client = new AppServerRpcClient(asFactory([first, second]))

    await client.connect()
    await client.close()
    await expect(client.connect()).resolves.toBeUndefined()
    await client.close()
  })

  it('rejects only pending requests owned by the closed process', async () => {
    const first = new FakeChild(0, false)
    const second = new FakeChild(0, false)
    const client = new AppServerRpcClient(asFactory([first, second]))

    await client.connect()
    const oldRequest = client.request('slow')
    const oldRequestRejected = expect(oldRequest).rejects.toThrow(/refreshed/)
    await client.close()
    await oldRequestRejected

    await client.connect()
    await expect(client.request('ping')).resolves.toEqual({})
    await client.close()
  })
})

async function deliver(child: FakeChild, message: unknown): Promise<void> {
  child.stdout.write(`${JSON.stringify(message)}\n`)
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('AppServerRpcClient event routing', () => {
  it('does not confuse a colliding server request ID with a pending RPC response', async () => {
    const child = new FakeChild(0, false)
    const client = new AppServerRpcClient(asFactory([child]))
    try {
      await client.connect()
      let settled = false
      const pending = client.request('slow').then((value) => { settled = true; return value })
      const id = child.received.find((message) => message.method === 'slow')!.id as number
      await deliver(child, { id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-A' } })
      expect(settled).toBe(false)
      expect(client.getPendingServerRequests()).toHaveLength(1)
      expect(child.received.some((message) => message.id === id && Object.hasOwn(message, 'result'))).toBe(false)
      await deliver(child, { id, result: { ok: true } })
      await expect(pending).resolves.toEqual({ ok: true })
      expect(client.getPendingServerRequests()).toHaveLength(1)
    } finally { await client.close() }
  })

  it('buffers terminal notifications before the matching RPC response is delivered', async () => {
    const child = new FakeChild(0, false)
    const client = new AppServerRpcClient(asFactory([child]))
    try {
      await client.connect()
      const pending = client.request('slow')
      const id = child.received.find((message) => message.method === 'slow')!.id
      await deliver(child, { method: 'turn/completed', params: { threadId: 'thread-A', turn: { id: 'turn-A', status: 'interrupted' } } })
      await deliver(child, { id, result: {} })
      await pending
      await expect(client.observations.waitForTerminal('thread-A', 'turn-A', client.connectionEpoch)).resolves.toMatchObject({ status: 'interrupted' })
    } finally { await client.close() }
  })

  it('tracks resolution without automatically answering approval or tool requests', async () => {
    const child = new FakeChild(0, false)
    const client = new AppServerRpcClient(asFactory([child]))
    try {
      await client.connect()
      await deliver(child, { id: 'approval-1', method: 'item/tool/requestUserInput', params: { threadId: 'thread-A' } })
      expect(client.getPendingServerRequests()[0]).toMatchObject({ id: 'approval-1', method: 'item/tool/requestUserInput' })
      expect(child.received.some((message) => message.id === 'approval-1')).toBe(false)
      await deliver(child, { method: 'serverRequest/resolved', params: { threadId: 'thread-A', requestId: 'approval-1' } })
      expect(client.getPendingServerRequests()).toEqual([])
      expect(() => client.respondToServerRequest(client.connectionEpoch, 'approval-1', {})).toThrow(/no longer pending/)
    } finally { await client.close() }
  })

  it('never answers an old connection request on a newer process with the same ID', async () => {
    const first = new FakeChild(0, false)
    const second = new FakeChild(0, false)
    const client = new AppServerRpcClient(asFactory([first, second]))
    try {
      await client.connect()
      const oldEpoch = client.connectionEpoch
      await deliver(first, { id: 'same-id', method: 'item/tool/call', params: {} })
      await client.close()
      await client.connect()
      await deliver(first, { method: 'turn/completed', params: { threadId: 'thread-A', turn: { id: 'turn-old', status: 'interrupted' } } })
      await deliver(second, { id: 'same-id', method: 'item/tool/call', params: {} })
      expect(client.observations.getTerminal('thread-A', 'turn-old')).toBeNull()
      expect(() => client.respondToServerRequest(oldEpoch, 'same-id', {})).toThrow(/no longer pending/)
      expect(second.received.some((message) => message.id === 'same-id')).toBe(false)
    } finally { await client.close() }
  })

  it('responds only when explicitly requested using the current epoch and exact request ID', async () => {
    const child = new FakeChild(0, false)
    const client = new AppServerRpcClient(asFactory([child]))
    try {
      await client.connect()
      await deliver(child, { id: 'tool-1', method: 'item/tool/call', params: {} })
      client.respondToServerRequest(client.connectionEpoch, 'tool-1', { success: false })
      expect(child.received).toContainEqual({ id: 'tool-1', result: { success: false } })
      expect(client.getPendingServerRequests()).toEqual([])
    } finally { await client.close() }
  })

  it('ignores malformed frames and isolates a failing notification listener', async () => {
    const child = new FakeChild(0, false)
    const client = new AppServerRpcClient(asFactory([child]))
    try {
      await client.connect()
      client.onNotification(() => { throw new Error('consumer failed') })
      let count = 0
      client.onNotification(() => { count += 1 })
      await deliver(child, null)
      await deliver(child, [])
      await deliver(child, { method: 'turn/completed', params: { threadId: 'thread-A', turn: { id: 'turn-A', status: 'completed' } } })
      expect(count).toBe(1)
      expect(client.listenerFailureCount).toBe(1)
      await expect(client.request('ping')).resolves.toEqual({})
    } finally { await client.close() }
  })
})
