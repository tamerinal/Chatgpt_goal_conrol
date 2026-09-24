import { describe, expect, it } from 'vitest'
import { CONTINUE_GOAL_PROMPT, CodexAppServerAdapter } from '../src/adapters/codex-app-server/codex-adapter'

class FakeRpc {
  requests: Array<{ method: string; params: unknown }> = []
  connects = 0
  closes = 0

  constructor(private readonly handler: (method: string, params: unknown) => unknown) {}
  async connect(): Promise<void> { this.connects += 1 }
  async close(): Promise<void> { this.closes += 1 }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    return this.handler(method, params) as T
  }
}

const executionPolicy = {
  interruptActiveTurnOnPause: true,
  continueTurnOnResume: true
}

describe('CodexAppServerAdapter session-aware Goal actions', () => {
  it('pauses the Goal before interrupting its active turn', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') return { thread: { status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress' }] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    const result = await adapter.pauseGoal('goal-1', executionPolicy)

    expect(result).toMatchObject({ goalStatus: 'paused', turnAction: 'interrupted', turnId: 'turn-1', verified: true, writerConflict: false, execution: { lastTurnId: 'turn-1', lastTurnStatus: 'interrupted' } })
    expect(execution.requests.map((request) => request.method)).toEqual([
      'thread/goal/set',
      'thread/read',
      'turn/interrupt'
    ])
    expect(JSON.stringify(execution.requests)).not.toContain('objective')
  })

  it('loads the same thread and starts one Continue turn on resume', async () => {
    let loaded = false
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') return {
        thread: {
          status: { type: loaded ? 'idle' : 'notLoaded' },
          turns: [{ id: 'turn-old', status: 'completed' }]
        }
      }
      if (method === 'thread/resume') { loaded = true; return { thread: { id: 'goal-1' } } }
      if (method === 'turn/start') return { turn: { id: 'turn-new', status: 'inProgress' } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    const result = await adapter.resumeGoal('goal-1', executionPolicy)

    expect(result).toMatchObject({ goalStatus: 'active', turnAction: 'started', turnId: 'turn-new', verified: true, writerConflict: false, execution: { activeTurnId: 'turn-new' } })
    expect(execution.requests.map((request) => request.method)).toEqual([
      'thread/goal/set',
      'thread/read',
      'thread/resume',
      'thread/read',
      'turn/start'
    ])
    expect(execution.requests.at(-1)?.params).toEqual({
      threadId: 'goal-1',
      input: [{ type: 'text', text: CONTINUE_GOAL_PROMPT }]
    })
  })

  it('does not start a duplicate turn and monitor refresh does not close execution', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method) => {
      if (method === 'thread/read') return { thread: { status: { type: 'active' }, turns: [{ id: 'turn-live', status: 'inProgress' }] } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    const result = await adapter.ensureGoalExecution('goal-1', executionPolicy)
    await adapter.refreshConnection()

    expect(result.turnAction).toBe('alreadyRunning')
    expect(execution.requests.map((request) => request.method)).toEqual(['thread/read'])
    expect(execution.closes).toBe(0)
    expect(monitor.closes).toBe(1)
  })

  it('supports soft pause and status-only resume when execution controls are disabled', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') return { thread: { status: { type: 'active' }, turns: [{ id: 'turn-live', status: 'inProgress' }] } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)
    const disabled = { interruptActiveTurnOnPause: false, continueTurnOnResume: false }

    expect((await adapter.pauseGoal('goal-1', disabled)).turnAction).toBe('none')
    expect((await adapter.resumeGoal('goal-1', disabled)).turnAction).toBe('none')
    expect(execution.requests.map((request) => request.method)).not.toContain('turn/interrupt')
    expect(execution.requests.map((request) => request.method)).not.toContain('turn/start')
  })

  it('treats a naturally completed turn as a successful pause race', async () => {
    let readCount = 0
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') {
        readCount += 1
        return readCount === 1
          ? { thread: { status: { type: 'active' }, turns: [{ id: 'turn-race', status: 'inProgress' }] } }
          : { thread: { status: { type: 'idle' }, turns: [{ id: 'turn-race', status: 'completed' }] } }
      }
      if (method === 'turn/interrupt') throw new Error('turn already completed')
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    await expect(adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      goalStatus: 'paused',
      turnAction: 'none',
      execution: { lastTurnStatus: 'completed' }
    })
  })

  it('reports an active-writer conflict without failing Goal resume', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') return {
        thread: { status: { type: 'notLoaded' }, turns: [{ id: 'turn-old', status: 'completed' }] }
      }
      if (method === 'thread/resume') throw new Error('thread goal-1 already has an active writer')
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    await expect(adapter.resumeGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      goalStatus: 'active',
      turnAction: 'writerConflict',
      execution: { runtimeStatus: 'notLoaded', activeTurnId: null }
    })
  })

  it('reports an active-writer conflict when a paused Goal session cannot be inspected for interrupt', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') return { thread: { status: { type: 'notLoaded' }, turns: [] } }
      if (method === 'thread/resume') throw new Error('thread goal-1 already has an active writer')
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    await expect(adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      goalStatus: 'paused',
      turnAction: 'writerConflict',
      verified: false,
      writerConflict: true
    })
  })

  it('steers an active turn with the expected turn id', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'turn/steer') {
        expect(params).toMatchObject({ threadId: 'goal-1', expectedTurnId: 'turn-live' })
        return { turnId: 'turn-live' }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    await expect(adapter.steerGoalTurn('goal-1', 'turn-live', 'pause now')).resolves.toBe(true)
  })
})
