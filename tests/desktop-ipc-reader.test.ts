import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DesktopIpcReader, DESKTOP_PIPE } from '../scripts/desktop-ipc-reader'

const uuid = 'e7fa8920-bf63-5049-978e-bbf805a79534'
function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message))
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}
class FakeSocket extends EventEmitter {
  sent: Record<string, any>[] = []
  destroyed = false
  respond = true
  wrongOwner = false
  write(bytes: Buffer): boolean {
    const request = JSON.parse(bytes.subarray(4).toString())
    this.sent.push(request)
    if (request.type !== 'request' || !this.respond) return true
    const result = request.method === 'initialize' ? { clientId: 'reader' }
      : request.method === 'thread-owner-discovery' ? { supportsUntrustedAppInput: true }
      : { settings: { model: 'test' } }
    const response = frame({ type: 'response', requestId: request.requestId, method: request.method,
      resultType: 'success', handledByClientId: this.wrongOwner && request.targetClientId ? 'other' : 'owner', result })
    queueMicrotask(() => {
      this.emit('data', response.subarray(0, 2))
      this.emit('data', response.subarray(2, 9))
      this.emit('data', response.subarray(9))
    })
    return true
  }
  destroy(): void { this.destroyed = true }
}
function make(timeout = 100) {
  const socket = new FakeSocket()
  return { socket, reader: new DesktopIpcReader(socket as unknown as Socket, timeout) }
}
describe('read-only Desktop IPC diagnostic (fake transport only)', () => {
  it('uses the observed Windows pipe and only three read methods, pinned to discovered owner', async () => {
    expect(DESKTOP_PIPE).toBe('\\\\.\\pipe\\codex-ipc')
    const { socket, reader } = make()
    try {
      await expect(reader.inspect(uuid)).resolves.toEqual({ ownerClientId: 'owner', settingsAvailable: true })
      expect(socket.sent.map(m => [m.method, m.version])).toEqual([
        ['initialize', 0], ['thread-owner-discovery', 1], ['thread-follower-read-model-settings', 1]
      ])
      expect(socket.sent[0].sourceClientId).toBe('initializing-client')
      expect(socket.sent[2]).toMatchObject({ sourceClientId: 'reader', targetClientId: 'owner' })
      expect(socket.sent.every(m => m.hostId === undefined)).toBe(true)
    } finally { reader.close() }
    expect(socket.destroyed).toBe(true)
  })
  it('declines discovery and ignores unsolicited coalesced broadcasts', () => {
    const { socket, reader } = make()
    socket.emit('data', Buffer.concat([frame({ type: 'broadcast' }), frame({ type: 'client-discovery-request', requestId: 'probe' })]))
    expect(socket.sent).toEqual([{ type: 'client-discovery-response', requestId: 'probe', response: { canHandle: false } }])
    reader.close()
  })
  it('rejects malformed or oversized frames and closes only its socket', async () => {
    for (const bytes of [Buffer.from([255, 255, 255, 127]), Buffer.from([1, 0, 0, 0, 123])]) {
      const { socket, reader } = make()
      socket.respond = false
      const pending = reader.inspect(uuid)
      socket.emit('data', bytes)
      await expect(pending).rejects.toThrow()
      expect(socket.destroyed).toBe(true)
    }
  })
  it('does not accept a changed owner', async () => {
    const { socket, reader } = make()
    socket.wrongOwner = true
    try { await expect(reader.inspect(uuid)).rejects.toThrow('owner changed') } finally { reader.close() }
  })
  it('times out without retry or sending any mutation', async () => {
    const { socket, reader } = make(10)
    socket.respond = false
    await expect(reader.inspect(uuid)).rejects.toThrow('timeout')
    expect(socket.sent).toHaveLength(1)
    expect(socket.destroyed).toBe(true)
  })
  it('requires UUID before sending', async () => {
    const { socket, reader } = make()
    await expect(reader.inspect('latest')).rejects.toThrow('UUID')
    expect(socket.sent).toHaveLength(0)
    reader.close()
  })
})
