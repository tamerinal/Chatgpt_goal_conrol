import { describe, expect, it } from 'vitest'
import type { ChatGPTAdapter } from '../src/adapters/chatgpt-adapter'
import { ControllerScheduler } from '../src/core/scheduler/controller-scheduler'
import { GoalControllerDatabase } from '../src/persistence/database'
import type { GoalControlResult, RemoteGoal, ThreadExecutionState, ThreadGoalStatus, UsageInfo } from '../src/shared/types'

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
      runtimeStatus: 'notLoaded',
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
  async pauseGoal(): Promise<GoalControlResult> {
    this.pauseCalls += 1
    this.status = 'paused'
    const interrupted = this.activeTurnId
    this.activeTurnId = null
    this.lastTurnStatus = interrupted ? 'interrupted' : this.lastTurnStatus
    return { goalStatus: 'paused', execution: await this.getExecutionState(), turnAction: interrupted ? 'interrupted' : 'none' }
  }
  async resumeGoal(): Promise<GoalControlResult> {
    this.resumeCalls += 1
    this.status = 'active'
    return this.ensureGoalExecution()
  }
  async ensureGoalExecution(): Promise<GoalControlResult> {
    if (this.writerConflict) {
      return { goalStatus: 'active', execution: await this.getExecutionState(), turnAction: 'writerConflict' }
    }
    if (this.activeTurnId) return { goalStatus: 'active', execution: await this.getExecutionState(), turnAction: 'alreadyRunning' }
    this.activeTurnId = `turn-${this.resumeCalls}`
    this.lastTurnStatus = 'inProgress'
    return { goalStatus: 'active', execution: await this.getExecutionState(), turnAction: 'started' }
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
  return { adapter, database, scheduler: new ControllerScheduler(adapter, database) }
}

describe('live controller lifecycle', () => {
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

  it('claims the Goal without a monitoring error when another process owns the session writer', async () => {
    const { adapter, database, scheduler } = setup()
    adapter.writerConflict = true

    const snapshot = await scheduler.takeControlAndResume('goal-1')

    expect(snapshot.status).toBe('MONITORING')
    expect(snapshot.lastError).toBeNull()
    expect(database.getGoals()[0]).toMatchObject({
      remoteStatus: 'active',
      controllerManaged: true,
      excluded: false,
      sessionControlStatus: 'writerConflict'
    })
    expect(database.getAudit()[0]).toMatchObject({
      action: 'resume',
      status: 'skipped'
    })
    await scheduler.stop()
  })
})
