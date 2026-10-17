import { describe, expect, it } from 'vitest'
import { CodexAppServerAdapter } from '../src/adapters/codex-app-server/codex-adapter'

describe('Goal discovery without unrelated empty thread failures', () => {
  it('does not request turn history for a thread with no Goal', async () => {
    const requests: string[] = []
    const rpc = { async request(method: string) {
      requests.push(method)
      if (method === 'thread/list') return { data: [{ id: 'empty' }] }
      if (method === 'thread/goal/get') return { goal: null }
      throw new Error('Unexpected history request')
    } }
    const adapter = new CodexAppServerAdapter(rpc as never, rpc as never)
    await expect(adapter.listGoals()).resolves.toEqual([])
    expect(requests).toEqual(['thread/list', 'thread/goal/get'])
  })
  it('reads runtime without inventing turns when empty history is unsupported', async () => {
    const rpc = { async request(method: string, params: any) {
      if (method === 'thread/list') return { data: [{ id: 'empty' }] }
      if (method === 'thread/goal/get') return { goal: { objective: 'test', status: 'paused' } }
      if (method === 'thread/read') {
        if (params.includeTurns) throw new Error('list_turns is not supported yet')
        return { thread: { id: 'empty', status: { type: 'active' } } }
      }
      throw new Error('Unexpected request')
    } }
    const adapter = new CodexAppServerAdapter(rpc as never, rpc as never)
    const result = await adapter.listGoals()
    expect(result[0]).toMatchObject({ id: 'empty', runtimeStatus: 'active', lastTurnId: null, lastTurnStatus: null })
  })
  it('does not hide unrelated transport/read failures', async () => {
    const rpc = { async request(method: string) {
      if (method === 'thread/list') return { data: [{ id: 'target' }] }
      if (method === 'thread/goal/get') return { goal: { objective: 'test', status: 'paused' } }
      throw new Error('connection lost')
    } }
    await expect(new CodexAppServerAdapter(rpc as never, rpc as never).listGoals()).rejects.toThrow('connection lost')
  })
})
