import { describe, expect, it } from 'vitest'
import type { ChatGPTAdapter } from '../src/adapters/chatgpt-adapter'
import { ControllerScheduler } from '../src/core/scheduler/controller-scheduler'
import { GoalControllerDatabase } from '../src/persistence/database'
import type { ExecutionPolicy, GoalControlResult, RemoteGoal, ThreadExecutionState, ThreadGoalStatus, UsageInfo } from '../src/shared/types'

const safeUsage: UsageInfo = {
  measuredAt: 100,
  limitId: 'codex',
  fiveHour: { usedPercent: 20, windowDurationMins: 300, resetsAt: 10_000 },
  weekly: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 20_000 }
}

class LiveFakeAdapter implements ChatGPTAdapter {
  status: ThreadGoalStatus = 'paused'
  pauseCalls = 0
  resumeCalls = 0
  usage = safeUsage
  activeTurnId: string | null = null
  lastTurnStatus: ThreadExecutionState['lastTurnStatus'] = 'completed'
  writerConflict = false
  verified = true
  lastPausePolicy: ExecutionPolicy | undefined
  lastStartPolicy: ExecutionPolicy | undefined

  async connect(): Promise<void> {}
  async refreshConnection(): Promise<void> {}
  async close(): Promise<void> {}
  async getUsage(): Promise<UsageInfo> { return this.usage }
  async listGoals(): Promise<RemoteGoal[]> {
    return [{
      id: 'goal-1',
      name: 'Örnek görev durumunu incele',
      objective: 'test',
      remoteStatus: this.status,
      runtimeStatus: this.writerConflict || !this.verified ? 'notLoaded' : this.activeTurnId ? 'active' : 'idle',
      createdAt: 1,
      lastActivityAt: 1,
      tokensUsed: 10,
      tokenBudget: 100,
      lastTurnId: this.activeTurnId ?? 'turn-old',
      lastTurnStatus: this.activeTurnId ? 'inProgress' : this.lastTurnStatus
    }]
  }
  async getGoalStatus(): Promise<ThreadGoalStatus> { return this.status }
  async getExecutionState(): Promise<ThreadExecutionState> {
    return { runtimeStatus: this.activeTurnId ? 'active' : 'idle', activeTurnId: this.activeTurnId, lastTurnId: this.activeTurnId ?? 'turn-old', lastTurnStatus: this.activeTurnId ? 'inProgress' : this.lastTurnStatus }
  }
  async pauseGoal(_goalId?: string, policy?: ExecutionPolicy): Promise<GoalControlResult> {
    this.lastPausePolicy = policy
    this.pauseCalls += 1
    this.status = 'paused'
    const interrupted = this.activeTurnId
    this.activeTurnId = null
    this.lastTurnStatus = interrupted ? 'interrupted' : this.lastTurnStatus
    return { goalStatus: 'paused', execution: await this.getExecutionState(), turnAction: interrupted ? 'interrupted' : 'none', verified: true }
  }
  async resumeGoal(_goalId?: string, policy?: ExecutionPolicy): Promise<GoalControlResult> {
    this.lastStartPolicy = policy
    this.resumeCalls += 1
    this.status = 'active'
    return this.ensureGoalExecution()
  }
  async ensureGoalExecution(): Promise<GoalControlResult> {
    if (this.writerConflict) {
      return { goalStatus: 'active', execution: await this.getExecutionState(), turnAction: 'writerConflict', verified: false }
    }
    if (this.activeTurnId) return { goalStatus: 'active', execution: await this.getExecutionState(), turnAction: 'alreadyRunning', verified: true }
    this.activeTurnId = `turn-${this.resumeCalls}`
    this.lastTurnStatus = 'inProgress'
    return { goalStatus: 'active', execution: await this.getExecutionState(), turnAction: 'started', verified: this.verified }
  }
  async steerGoalTurn(): Promise<boolean> { return false }
  async getVersion(): Promise<string> { return 'test' }
}

function setup(): { adapter: LiveFakeAdapter; database: GoalControllerDatabase; scheduler: ControllerScheduler } {
  const adapter = new LiveFakeAdapter()
  const database = new GoalControllerDatabase(':memory:')
  database.upsertGoals([{
    id: 'goal-1',
    name: 'Örnek görev durumunu incele',
    objective: 'test',
    remoteStatus: 'paused',
    runtimeStatus: 'notLoaded',
    createdAt: 1,
    lastActivityAt: 1,
    tokensUsed: 10,
    tokenBudget: 100,
    lastTurnId: 'turn-old',
    lastTurnStatus: 'completed'
  }], 1)
  database.setExcluded('goal-1', true)
  database.updateSettings({ cooldownSeconds: 0, maxRunningGoals: 1 })
  return { adapter, database, scheduler: new ControllerScheduler(adapter, database, () => 100) }
}

describe('live controller lifecycle', () => {
  it('automatically starts an included Goal at remaining 53/93 above limits 50/90 only when automation is enabled', async () => {
    const { adapter, database, scheduler } = setup()
    database.setExcluded('goal-1', false)
    database.updateSettings({
      automaticControl: false,
      fiveHourPolicy: { stopRemainingPercent: 50, useFullQuotaNearReset: false, finalWindowMinutes: 40 },
      weeklyPolicy: { stopRemainingPercent: 90, useFullQuotaNearReset: false, finalWindowMinutes: 120 }
    })
    adapter.usage = {
      ...safeUsage,
      fiveHour: { ...safeUsage.fiveHour, usedPercent: 47 },
      weekly: { ...safeUsage.weekly, usedPercent: 7 }
    }

    await scheduler.runCycle()
    expect(database.getLatestUsage()?.fiveHour.usedPercent).toBe(47)
    expect(adapter.resumeCalls).toBe(0)

    scheduler.updateSettings({ automaticControl: true })
    await scheduler.runCycle()
    expect(adapter.resumeCalls).toBe(1)
    expect(database.getGoals()[0]).toMatchObject({ remoteStatus: 'active', excluded: false })
    expect(database.getAudit()).toContainEqual(expect.objectContaining({ action: 'resume', reason: 'quota', status: 'executed' }))

    await scheduler.runCycle()
    expect(adapter.resumeCalls).toBe(1)
    adapter.usage = { ...adapter.usage, fiveHour: { ...adapter.usage.fiveHour, usedPercent: 50 } }
    await scheduler.runCycle()
    expect(adapter.pauseCalls).toBe(1)
    expect(database.getGoals()[0]).toMatchObject({ remoteStatus: 'paused', controllerStatus: 'paused_quota', excluded: false })
    await scheduler.stop()
  })

  it('direct start bypasses unavailable usage, cooldown, full capacity, scope and disabled execution policy', async () => {
    const { adapter, database, scheduler } = setup()
    database.updateSettings({ automaticControl: false, executionPolicy: { interruptActiveTurnOnPause: false, continueTurnOnResume: false } })
    database.markGoalPaused('goal-1', 'manual', 100, 900)
    const list = adapter.listGoals.bind(adapter)
    adapter.listGoals = async () => [...await list(), { ...(await list())[0], id: 'other', remoteStatus: 'active', runtimeStatus: 'active' }]
    adapter.getUsage = async () => { throw new Error('Usage must not be read by direct commands') }
    await Promise.all([scheduler.startGoal('goal-1'), scheduler.startGoal('goal-1')])
    expect(adapter.resumeCalls).toBe(1)
    expect(adapter.lastStartPolicy?.continueTurnOnResume).toBe(true)
    expect(database.getGoals().find(g => g.id === 'goal-1')).toMatchObject({ remoteStatus: 'active', excluded: true, controllerManaged: false, cooldownUntil: 1000 })
    expect(database.getGoals().find(g => g.id === 'other')?.remoteStatus).toBe('active')
    expect(database.getAudit().filter(a => a.action === 'resume')).toHaveLength(2)
    expect(database.getLatestUsage()).toBeNull()
    await scheduler.stop()
  })

  it('direct start ignores exhausted local quota while the automatic check still stops it', async () => {
    const { adapter, database, scheduler } = setup()
    database.setExcluded('goal-1', false)
    adapter.usage = { ...safeUsage, weekly: { ...safeUsage.weekly, usedPercent: 100 } }
    database.saveUsage(adapter.usage)
    await scheduler.startGoal('goal-1')
    expect(adapter.resumeCalls).toBe(1)
    expect(database.getGoals()[0]).toMatchObject({ excluded: false, remoteStatus: 'active' })
    await scheduler.runCycle()
    expect(adapter.pauseCalls).toBe(1)
    expect(database.getGoals()[0].controllerStatus).toBe('paused_quota')
    await scheduler.stop()
  })

  it('keeps last-known rows available after a quota read failure so direct control remains usable', async () => {
    const { adapter, scheduler } = setup()
    adapter.getUsage = async () => { throw new Error('quota unavailable') }
    const failed = await scheduler.runCycle()
    expect(failed.status).toBe('MONITORING_ERROR')
    expect(failed.goals[0].id).toBe('goal-1')
    const started = await scheduler.startGoal(failed.goals[0].id)
    expect(started.audit[0]).toMatchObject({ action: 'resume', status: 'executed' })
    await scheduler.stop()
  })

  it('direct stop forces session interrupt and an included Goal can resume at the next allowed check', async () => {
    const { adapter, database, scheduler } = setup()
    database.setExcluded('goal-1', false)
    database.updateSettings({ automaticControl: false, executionPolicy: { interruptActiveTurnOnPause: false, continueTurnOnResume: false } })
    adapter.status = 'active'
    adapter.activeTurnId = 'running'
    adapter.getUsage = async () => { throw new Error('No quota read for stop') }
    await scheduler.pauseGoal('goal-1')
    expect(adapter.lastPausePolicy?.interruptActiveTurnOnPause).toBe(true)
    expect(adapter.activeTurnId).toBeNull()
    expect(database.getGoals()[0]).toMatchObject({ remoteStatus: 'paused', controllerStatus: 'paused_direct', excluded: false, controllerManaged: true, cooldownUntil: null })
    adapter.getUsage = async () => safeUsage
    await scheduler.runCycle()
    expect(adapter.resumeCalls).toBe(0)
    database.updateSettings({ automaticControl: true, executionPolicy: { interruptActiveTurnOnPause: true, continueTurnOnResume: true } })
    await scheduler.runCycle()
    expect(adapter.resumeCalls).toBe(1)
    await scheduler.stop()
  })

  it('including a previously excluded paused Goal makes it eligible for the next automatic check', async () => {
    const { adapter, database, scheduler } = setup()
    await scheduler.pauseGoal('goal-1')
    await scheduler.runCycle()
    expect(adapter.resumeCalls).toBe(0)
    scheduler.setExcluded('goal-1', false)
    await scheduler.runCycle()
    expect(adapter.resumeCalls).toBe(1)
    expect(database.getGoals()[0].excluded).toBe(false)
    await scheduler.stop()
  })

  it('direct start can reactivate a blocked Goal but rejects completed and missing targets', async () => {
    const { adapter, scheduler } = setup()
    adapter.status = 'blocked'
    await scheduler.startGoal('goal-1')
    expect(adapter.resumeCalls).toBe(1)
    adapter.status = 'complete'
    await expect(scheduler.startGoal('goal-1')).rejects.toThrow('güncel listede')
    await expect(scheduler.pauseGoal('goal-1')).rejects.toThrow('güncel listede')
    await expect(scheduler.startGoal('')).rejects.toThrow('Goal kimliği gerekli')
    expect(adapter.resumeCalls).toBe(1)
    expect(adapter.pauseCalls).toBe(0)
    await scheduler.stop()
  })

  it('direct start preserves writer conflict evidence and scope without recording success', async () => {
    const { adapter, database, scheduler } = setup()
    adapter.writerConflict = true
    await scheduler.startGoal('goal-1')
    expect(database.getGoals()[0]).toMatchObject({ excluded: true, controllerManaged: false, sessionControlStatus: 'writerConflict' })
    expect(database.getAudit()[0]).toMatchObject({ action: 'resume', status: 'skipped' })
    await scheduler.stop()
  })

  it('never blindly resends an uncertain start while the remote Goal still appears paused', async () => {
    const { adapter, database, scheduler } = setup()
    const resume = adapter.resumeGoal.bind(adapter)
    adapter.resumeGoal = async () => { adapter.resumeCalls++; throw new Error('lost response') }
    await expect(scheduler.startGoal('goal-1')).rejects.toThrow('lost response')
    await expect(scheduler.startGoal('goal-1')).rejects.toThrow('kör tekrar')
    expect(adapter.resumeCalls).toBe(1)
    expect(database.getGoals()[0].excluded).toBe(true)
    await scheduler.pauseGoal('goal-1')
    adapter.resumeGoal = resume
    await scheduler.startGoal('goal-1')
    expect(adapter.resumeCalls).toBe(2)
    await scheduler.stop()
  })

  it('row stop targets only the selected Goal, even when excluded, and reuses verified pause/resume', async () => {
    const { adapter, database, scheduler } = setup()
    adapter.status = 'active'
    adapter.activeTurnId = 'selected-turn'
    const originalList = adapter.listGoals.bind(adapter)
    const other: RemoteGoal = { ...(await originalList())[0], id: 'other-goal', name: 'Other Goal', runtimeStatus: 'active', lastTurnId: 'other-turn' }
    adapter.listGoals = async () => [...await originalList(), other]
    await scheduler.runCycle()
    database.setExcluded('other-goal', false)
    await scheduler.pauseGoal('goal-1')
    expect(adapter.pauseCalls).toBe(1)
    expect(database.getGoals().find(g => g.id === 'goal-1')).toMatchObject({ remoteStatus: 'paused', excluded: true, controllerManaged: false })
    expect(database.getGoals().find(g => g.id === 'other-goal')).toMatchObject({ remoteStatus: 'active', runtimeStatus: 'active', excluded: false, lastTurnId: 'other-turn' })
    expect(database.getAudit().filter(a => a.action === 'pause')).toEqual([expect.objectContaining({ goalId: 'goal-1', status: 'executed' })])
    await scheduler.stop()
  })

  it('row stop rechecks an already-paused Goal with active work and never claims an unverified stop', async () => {
    const { adapter, database, scheduler } = setup()
    adapter.activeTurnId = 'still-running'
    adapter.verified = false
    adapter.pauseGoal = async () => {
      adapter.pauseCalls++
      return { goalStatus: 'paused', execution: { runtimeStatus: 'active', activeTurnId: 'still-running', lastTurnId: 'still-running', lastTurnStatus: 'inProgress' }, turnAction: 'interruptRequested', verified: false }
    }
    await scheduler.pauseGoal('goal-1')
    expect(adapter.pauseCalls).toBe(1)
    expect(database.getAudit()[0]).toMatchObject({ action: 'pause', status: 'skipped', detail: expect.stringContaining('unverified') })
    await scheduler.stop()
  })

  it('row stop rejects a vanished Goal before any remote mutation', async () => {
    const { adapter, scheduler } = setup()
    await expect(scheduler.pauseGoal('')).rejects.toThrow('Goal kimliği gerekli')
    await expect(scheduler.pauseGoal('gone')).rejects.toThrow('güncel listede')
    expect(adapter.pauseCalls).toBe(0)
    await scheduler.stop()
  })

  it('does not record an unverified start as executed or as a confirmed running session', async () => {
    const { adapter, database, scheduler } = setup()
    adapter.verified = false
    await scheduler.takeControlAndResume('goal-1')
    expect(database.getAudit()[0]).toMatchObject({ status: 'skipped', detail: expect.stringContaining('unverified') })
    expect(database.getGoals()[0].sessionControlStatus).toBe('unknown')
    expect(database.getGoals()[0].controllerManaged).toBe(false)
    expect(database.getGoals()[0].excluded).toBe(true)
    await scheduler.stop()
  })
  it('claims and resumes an excluded manual Goal only after remote success', async () => {
    const { adapter, database, scheduler } = setup()
    await Promise.all([
      scheduler.takeControlAndResume('goal-1'),
      scheduler.takeControlAndResume('goal-1')
    ])

    const goal = database.getGoals()[0]
    expect(adapter.resumeCalls).toBe(1)
    expect(goal.remoteStatus).toBe('active')
    expect(goal.controllerManaged).toBe(true)
    expect(goal.excluded).toBe(false)
    expect(goal.controllerStatus).toBe('allowed')
    await scheduler.stop()
  })

  it('pauses at the remaining quota limit and resumes when allowed again', async () => {
    const { adapter, database, scheduler } = setup()
    await scheduler.takeControlAndResume('goal-1')
    await scheduler.runCycle()

    adapter.usage = {
      ...safeUsage,
      fiveHour: { ...safeUsage.fiveHour, usedPercent: 90 }
    }
    await scheduler.runCycle()
    expect(adapter.pauseCalls).toBe(1)
    expect(database.getGoals()[0]).toMatchObject({
      remoteStatus: 'paused',
      controllerStatus: 'paused_quota',
      controllerManaged: true
    })

    adapter.usage = safeUsage
    await scheduler.runCycle()
    expect(adapter.resumeCalls).toBe(2)
    expect(database.getGoals()[0]).toMatchObject({
      remoteStatus: 'active',
      controllerStatus: 'allowed',
      controllerManaged: true
    })
    await scheduler.stop()
  })

  it('does not claim an excluded Goal when the remote resume fails', async () => {
    const { adapter, database, scheduler } = setup()
    adapter.resumeGoal = async () => { throw new Error('remote resume failed') }

    await expect(scheduler.takeControlAndResume('goal-1')).rejects.toThrow('remote resume failed')
    expect(database.getGoals()[0]).toMatchObject({
      remoteStatus: 'paused',
      controllerManaged: false,
      excluded: true,
      controllerStatus: 'excluded'
    })
    expect(database.getAudit()[0]).toMatchObject({
      action: 'monitoring_error',
      status: 'failed'
    })
    expect(database.getAudit()[1]).toMatchObject({
      action: 'resume',
      status: 'failed'
    })
    await scheduler.stop()
  })

  it('preserves scope and does not claim control when another process owns the session writer', async () => {
    const { adapter, database, scheduler } = setup()
    adapter.writerConflict = true

    const snapshot = await scheduler.takeControlAndResume('goal-1')

    expect(snapshot.status).toBe('MONITORING')
    expect(snapshot.lastError).toBeNull()
    expect(database.getGoals()[0]).toMatchObject({
      remoteStatus: 'active',
      controllerManaged: false,
      excluded: true,
      sessionControlStatus: 'writerConflict'
    })
    expect(database.getAudit()[0]).toMatchObject({
      action: 'resume',
      status: 'skipped'
    })
    await scheduler.stop()
  })
})
