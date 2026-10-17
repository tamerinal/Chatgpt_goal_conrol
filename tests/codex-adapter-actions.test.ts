import { describe, expect, it } from 'vitest'
import { CodexAppServerAdapter } from '../src/adapters/codex-app-server/codex-adapter'
import { ExecutionObservations } from '../src/adapters/codex-app-server/execution-observations'

class FakeRpc {
  requests: Array<{ method: string; params: unknown }> = []
  connects = 0
  closes = 0
  connectionEpoch = 1
  goalStatus = 'paused'
  loadedIds = ['goal-1']
  readonly observations = new ExecutionObservations()

  constructor(private readonly handler: (method: string, params: unknown) => unknown) {
    this.observations.connectionChanged(1, true)
  }
  async connect(): Promise<void> { this.connects += 1 }
  async close(): Promise<void> { this.closes += 1 }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'thread/goal/get') return { goal: { status: this.goalStatus } } as T
    if (method === 'thread/loaded/list') return { data: this.loadedIds } as T
    const response = this.handler(method, params) as { goal?: { status?: string } }
    if (method === 'thread/goal/set' && response?.goal?.status) this.goalStatus = response.goal.status
    return response as T
  }
}

const executionPolicy = {
  interruptActiveTurnOnPause: true,
  continueTurnOnResume: true
}

describe('native Goal continuation safety', () => {
  it('does not invent a running turn or inject Continue while the loaded native Goal stays idle', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method) => {
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [{ id: 'stale', status: 'inProgress' }] } }
      throw new Error(`Unexpected write: ${method}`)
    })
    execution.goalStatus = 'active'
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never, { timeoutMs: 100, pollMs: 1 })
    const result = await adapter.ensureGoalExecution('goal-1', executionPolicy)
    expect(result).toMatchObject({ verified: false, turnAction: 'none', execution: { activeTurnId: null, runtimeStatus: 'idle' } })
    expect(execution.requests.some((request) => request.method === 'turn/start' || request.method === 'thread/resume')).toBe(false)
  })

  it('does not verify a historical inProgress turn from an unloaded connection', async () => {
    const execution = new FakeRpc((method) => {
      if (method === 'thread/read') return { thread: { status: { type: 'active' }, turns: [{ id: 'old', status: 'inProgress' }] } }
      if (method === 'thread/resume') return {}
      throw new Error(`Unexpected write: ${method}`)
    })
    execution.goalStatus = 'active'
    execution.loadedIds = []
    const adapter = new CodexAppServerAdapter(new FakeRpc(() => ({})) as never, execution as never)
    expect((await adapter.ensureGoalExecution('goal-1', executionPolicy)).verified).toBe(false)
    expect(execution.requests.some((request) => request.method === 'turn/start')).toBe(false)
  })

  it('does not call a blocked native Goal resumed even if an old turn is present', async () => {
    const execution = new FakeRpc((method) => {
      if (method === 'thread/read') return { thread: { status: { type: 'active' }, turns: [{ id: 'old', status: 'inProgress' }] } }
      throw new Error(`Unexpected write: ${method}`)
    })
    execution.goalStatus = 'blocked'
    const adapter = new CodexAppServerAdapter(new FakeRpc(() => ({})) as never, execution as never)
    expect(await adapter.ensureGoalExecution('goal-1', executionPolicy)).toMatchObject({ goalStatus: 'blocked', verified: false })
  })
})

describe('CodexAppServerAdapter session-aware Goal actions', () => {
  it('exposes request metadata without exposing private arguments or automatically answering', () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = Object.assign(new FakeRpc(() => ({})), {
      getPendingServerRequests: () => [{
        id: 'approval-1', method: 'item/commandExecution/requestApproval',
        connectionEpoch: 1, receivedAt: 100,
        params: { threadId: 'thread-A', turnId: 'turn-A', command: 'private-command' }
      }]
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)
    expect(adapter.getPendingExecutionRequests()).toEqual([{
      id: 'approval-1', method: 'item/commandExecution/requestApproval', connectionEpoch: 1,
      receivedAt: 100, threadId: 'thread-A', turnId: 'turn-A'
    }])
    expect(JSON.stringify(adapter.getPendingExecutionRequests())).not.toContain('private-command')
    expect(execution.requests).toEqual([])
  })
  it('pauses the Goal before interrupting its active turn', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') return { thread: { status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress' }] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never, { timeoutMs: 100, pollMs: 1 })

    const result = await adapter.pauseGoal('goal-1', executionPolicy)

    expect(result).toMatchObject({ goalStatus: 'paused', turnAction: 'interruptRequested', turnId: 'turn-1', verified: false, writerConflict: false, execution: { activeTurnId: 'turn-1', lastTurnStatus: 'inProgress' } })
    expect(execution.requests[0].method).toBe('thread/goal/set')
    expect(execution.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1)
    expect(execution.requests.some((request) => request.method === 'thread/goal/get')).toBe(true)
    expect(JSON.stringify(execution.requests)).not.toContain('objective')
  })

  it('loads the same thread and verifies native continuation without sending a second Continue', async () => {
    let loaded = false
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method, params) => {
      if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
      if (method === 'thread/read') return {
        thread: {
          status: { type: loaded ? 'active' : 'notLoaded' },
          turns: loaded ? [{ id: 'turn-native', status: 'inProgress' }] : [{ id: 'turn-old', status: 'completed' }]
        }
      }
      if (method === 'thread/resume') { loaded = true; return { thread: { id: 'goal-1' } } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    const result = await adapter.resumeGoal('goal-1', executionPolicy)

    expect(result).toMatchObject({ goalStatus: 'active', turnAction: 'alreadyRunning', turnId: 'turn-native', verified: true, writerConflict: false, execution: { activeTurnId: 'turn-native' } })
    expect(execution.requests.map((request) => request.method)).toEqual([
      'thread/goal/set',
      'thread/read',
      'thread/resume',
      'thread/goal/get',
      'thread/loaded/list',
      'thread/read'
    ])
    expect(execution.requests.some((request) => request.method === 'turn/start')).toBe(false)
  })

  it('does not start a duplicate turn and monitor refresh does not close execution', async () => {
    const monitor = new FakeRpc(() => ({}))
    const execution = new FakeRpc((method) => {
      if (method === 'thread/read') return { thread: { status: { type: 'active' }, turns: [{ id: 'turn-live', status: 'inProgress' }] } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const adapter = new CodexAppServerAdapter(monitor as never, execution as never)

    execution.goalStatus = 'active'
    const result = await adapter.ensureGoalExecution('goal-1', executionPolicy)
    await adapter.refreshConnection()

    expect(result.turnAction).toBe('alreadyRunning')
    expect(result.verified).toBe(true)
    expect(execution.requests.some((request) => request.method === 'turn/start')).toBe(false)
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

function pauseFixture(onInterrupt: (fixture: ReturnType<typeof pauseFixture>) => void = () => undefined) {
  const thread = {
    status: { type: 'active' },
    turns: [{ id: 'turn-A', status: 'inProgress' }]
  }
  const monitor = new FakeRpc(() => ({}))
  const execution = new FakeRpc((method, params) => {
    if (method === 'thread/goal/set') return { goal: { status: (params as { status: string }).status } }
    if (method === 'thread/read') return { thread }
    if (method === 'turn/interrupt') { onInterrupt(fixture); return {} }
    if (method === 'thread/resume') throw new Error('thread goal-1 already has an active writer')
    throw new Error(`Unexpected method: ${method}`)
  })
  const adapter = new CodexAppServerAdapter(monitor as never, execution as never, { timeoutMs: 100, pollMs: 1 })
  const fixture = {
    adapter, execution, thread,
    terminal(status = 'interrupted', threadId = 'goal-1', turnId = 'turn-A') {
      execution.observations.observe({
        method: 'turn/completed', params: { threadId, turn: { id: turnId, status } },
        connectionEpoch: execution.connectionEpoch, receivedAt: Date.now()
      })
    },
    finish(status = 'interrupted') {
      thread.status.type = 'idle'
      thread.turns = [{ id: 'turn-A', status }]
    }
  }
  return fixture
}

describe('S2 pause outcome verification', () => {
  it('verifies exact terminal evidence and paused Goal after an interrupt', async () => {
    const fixture = pauseFixture((f) => { f.finish(); f.terminal() })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      goalStatus: 'paused', turnAction: 'interrupted', turnId: 'turn-A', verified: true,
      execution: { runtimeStatus: 'idle', activeTurnId: null },
      verification: { source: 'turn/completed', terminalStatus: 'interrupted', connectionEpoch: 1 }
    })
    expect(fixture.execution.requests.filter((r) => r.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('can verify an exact terminal history read when the event was lost', async () => {
    const fixture = pauseFixture((f) => { f.finish() })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: true, verification: { source: 'thread/read', terminalStatus: 'interrupted' }
    })
  })

  it('treats natural completion during interrupt rejection as a stopped turn', async () => {
    const fixture = pauseFixture((f) => { f.finish('completed'); throw new Error('already completed') })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: true, turnAction: 'none', verification: { terminalStatus: 'completed' }
    })
  })

  it('succeeds safely without interrupt when the loaded session is already idle', async () => {
    const fixture = pauseFixture()
    fixture.thread.status.type = 'idle'
    fixture.thread.turns = []
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: true, turnAction: 'none', verification: { source: 'loaded-idle' }
    })
    expect(fixture.execution.requests.some((r) => r.method === 'turn/interrupt')).toBe(false)
  })

  it('does not resend interrupt for a terminal turn even if history still appears active', async () => {
    const fixture = pauseFixture()
    fixture.terminal()
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({ verified: false })
    expect(fixture.execution.requests.some((r) => r.method === 'turn/interrupt')).toBe(false)
  })

  it('does not consider the session stopped when a replacement turn is running', async () => {
    const fixture = pauseFixture((f) => {
      f.terminal()
      f.thread.turns = [{ id: 'turn-A', status: 'interrupted' }, { id: 'turn-B', status: 'inProgress' }]
    })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: false, turnId: 'turn-A', execution: { activeTurnId: 'turn-B' }
    })
    expect(fixture.execution.requests.filter((r) => r.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('rechecks Goal status and reports external resume instead of a combined success', async () => {
    const fixture = pauseFixture((f) => { f.finish(); f.execution.goalStatus = 'active' })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: false, goalStatus: 'active'
    })
  })

  it('does not accept the wrong thread or wrong turn terminal event and does not blindly retry', async () => {
    const fixture = pauseFixture((f) => { f.terminal('interrupted', 'other-thread'); f.terminal('interrupted', 'goal-1', 'other-turn') })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: false, turnAction: 'interruptRequested', execution: { activeTurnId: 'turn-A' }
    })
    expect(fixture.execution.requests.filter((r) => r.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('does not verify a different execution connection generation', async () => {
    const fixture = pauseFixture((f) => {
      f.finish()
      f.execution.connectionEpoch = 2
      f.execution.observations.connectionChanged(2, true)
    })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({ verified: false })
  })

  it('does not verify idle without the targeted turn terminal evidence', async () => {
    const fixture = pauseFixture((f) => { f.thread.status.type = 'idle'; f.thread.turns = [] })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({ verified: false })
  })

  it('reports owner conflict without claiming stop or sending a steering fallback', async () => {
    const fixture = pauseFixture()
    fixture.thread.status.type = 'notLoaded'
    fixture.execution.loadedIds = []
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      goalStatus: 'paused', verified: false, writerConflict: true
    })
    expect(fixture.execution.requests.some((r) => r.method === 'turn/interrupt' || r.method === 'turn/steer')).toBe(false)
  })

  it('preserves uncertain interrupt error information when the turn remains active', async () => {
    const fixture = pauseFixture(() => { throw new Error('transport timeout after dispatch') })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      goalStatus: 'paused', verified: false, controlError: 'transport timeout after dispatch'
    })
  })

  it('does not treat an unloaded session as idle after a terminal event', async () => {
    const fixture = pauseFixture((f) => { f.finish(); f.terminal(); f.execution.loadedIds = []; f.thread.status.type = 'notLoaded' })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: false, controlError: 'Session is not loaded on the execution connection.'
    })
  })

  it('distinguishes failed work from interrupted work while verifying that execution ended', async () => {
    const fixture = pauseFixture((f) => { f.finish('failed'); f.terminal('failed') })
    await expect(fixture.adapter.pauseGoal('goal-1', executionPolicy)).resolves.toMatchObject({
      verified: true, turnAction: 'none', verification: { terminalStatus: 'failed' }
    })
  })
})
