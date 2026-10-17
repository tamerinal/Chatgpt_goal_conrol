import { describe, expect, it, vi } from 'vitest'
import { AppServerRpcClient } from '../src/adapters/codex-app-server/rpc-client'
import { SHARED_SERVER_URL, WebSocketTransport } from '../src/adapters/codex-app-server/websocket-transport'

class FakeSocket extends EventTarget {
  readyState = 0
  sent: Array<{ method: string; id?: number }> = []
  closes = 0
  rejectInitialize = false
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(text: string): void {
    const message = JSON.parse(text)
    this.sent.push(message)
    if (message.id !== undefined) queueMicrotask(() => {
      const payload = this.rejectInitialize && message.method === 'initialize'
        ? { id: message.id, error: { message: 'initialize rejected' } }
        : { id: message.id, result: { ok: true } }
      this.message(payload)
    })
  }
  message(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }
  close(): void { this.closes++; this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
function setup() {
  const socket = new FakeSocket()
  const transport = new WebSocketTransport(socket as unknown as WebSocket)
  const client = new AppServerRpcClient(() => transport)
  return { socket, transport, client }
}
describe('shared WebSocket transport (no network)', () => {
  it('uses a fixed loopback endpoint', () => {
    expect(SHARED_SERVER_URL).toBe('ws://127.0.0.1:4509')
  })
  it('defaults to the shared WebSocket without spawning a proxy or engine', async () => {
    let created: FakeSocket | undefined
    let endpoint: unknown
    vi.stubGlobal('WebSocket', class extends FakeSocket {
      constructor(url: string) { super(); endpoint = url; created = this }
    })
    const client = new AppServerRpcClient()
    try {
      const connecting = client.connect()
      created!.open()
      await connecting
      expect(endpoint).toBe(SHARED_SERVER_URL)
    } finally { await client.close(); vi.unstubAllGlobals() }
  })
  it('queues initialize until open, then sends one JSON request per frame', async () => {
    const { socket, client } = setup()
    const connecting = client.connect()
    expect(socket.sent).toEqual([])
    socket.open()
    await connecting
    await expect(client.request('thread/loaded/list', {})).resolves.toEqual({ ok: true })
    expect(socket.sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/loaded/list'])
    await client.close()
    expect(socket.closes).toBe(1)
  })
  it('preserves server requests without auto approving them', async () => {
    const { socket, client } = setup()
    const connecting = client.connect(); socket.open(); await connecting
    socket.message({ method: 'item/commandExecution/requestApproval', id: 'approval', params: { threadId: 't' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getPendingServerRequests()).toHaveLength(1)
    expect(socket.sent.map(m => m.method)).toEqual(['initialize', 'initialized'])
    await client.close()
  })
  it('fails closed on handshake rejection without sending a mutating request', async () => {
    const { socket, client } = setup(); socket.rejectInitialize = true
    const request = client.request('thread/goal/set', { threadId: 't', status: 'active' })
    socket.open()
    await expect(request).rejects.toThrow('initialize rejected')
    expect(socket.sent.map(m => m.method)).toEqual(['initialize'])
    expect(socket.closes).toBe(1)
  })
  it('rejects pending calls on disconnect without retrying a mutation', async () => {
    const { socket, client } = setup()
    const connecting = client.connect(); socket.open(); await connecting
    socket.send = (text) => { socket.sent.push(JSON.parse(text)) }
    const pending = client.request('thread/goal/set', { threadId: 't', status: 'paused' })
    socket.close()
    await expect(pending).rejects.toThrow('stopped')
    expect(socket.sent.filter(m => m.method === 'thread/goal/set')).toHaveLength(1)
    await client.close()
  })
  it('handles connection failure with actionable launch instructions', async () => {
    const { socket, client } = setup()
    const connecting = client.connect()
    socket.dispatchEvent(new Event('error'))
    await expect(connecting).rejects.toThrow('ortak bağlantıyı aç')
    expect(socket.sent).toEqual([])
  })
  it('accepts a pretty printed JSON frame as one response', async () => {
    const { socket, client } = setup()
    socket.send = (text) => {
      const message = JSON.parse(text)
      if (message.id !== undefined) queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: message.id, result: { ok: true } }, null, 2)
      })))
    }
    const connecting = client.connect(); socket.open(); await connecting
    await expect(client.request('thread/loaded/list')).resolves.toEqual({ ok: true })
    await client.close()
  })
  it('rejects invalid JSON without waiting or retrying initialize', async () => {
    const { socket, client } = setup()
    const connecting = client.connect()
    socket.dispatchEvent(new MessageEvent('message', { data: '{' }))
    await expect(connecting).rejects.toThrow('JSON frame')
    expect(socket.closes).toBe(1)
  })
})
