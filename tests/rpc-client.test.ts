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
