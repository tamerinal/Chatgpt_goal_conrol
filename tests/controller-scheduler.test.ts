import { describe, expect, it } from 'vitest'
import type { ChatGPTAdapter } from '../src/adapters/chatgpt-adapter'
import { ControllerScheduler } from '../src/core/scheduler/controller-scheduler'
import type { GoalControllerDatabase } from '../src/persistence/database'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { DashboardSnapshot, GoalControlResult, ThreadExecutionState, UsageInfo } from '../src/shared/types'

const testUsage: UsageInfo = {
  measuredAt: 100,
  limitId: 'codex',
  fiveHour: { usedPercent: 25, windowDurationMins: 300, resetsAt: 200 },
  weekly: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 300 }
}

class FakeAdapter implements ChatGPTAdapter {
  refreshes = 0
  reads = 0
  releaseRead: (() => void) | null = null

  async connect(): Promise<void> {}
  async refreshConnection(): Promise<void> { this.refreshes += 1 }
  async close(): Promise<void> {}
  async getUsage(): Promise<UsageInfo> {
    this.reads += 1
    if (this.releaseRead === null) {
      await new Promise<void>((resolve) => { this.releaseRead = resolve })
    }
    return testUsage
  }
  async listGoals() { return [] }
  async getGoalStatus() { return 'active' as const }
  async getExecutionState(): Promise<ThreadExecutionState> { return { runtimeStatus: 'idle', activeTurnId: null, lastTurnId: null, lastTurnStatus: null } }
  async pauseGoal(): Promise<GoalControlResult> { throw new Error('disabled') }
  async resumeGoal(): Promise<GoalControlResult> { throw new Error('disabled') }
  async ensureGoalExecution(): Promise<GoalControlResult> { throw new Error('disabled') }
  async steerGoalTurn(): Promise<boolean> { return false }
  async getVersion() { return 'test' }
}

function fakeDatabase(): GoalControllerDatabase {
  let usage: UsageInfo | null = null
  const db = {
    getSettings: () => DEFAULT_SETTINGS,
    getLatestUsage: () => usage,
    saveUsage: (next: UsageInfo) => { usage = next },
    upsertGoals: () => undefined,
    getGoals: () => [],
    getPolicyState: () => ({ fiveHourRequiredPriority: 0, weeklyRequiredPriority: 0 }),
    setPolicyState: () => undefined,
    recordProposedActions: () => undefined,
    clearProposals: () => undefined,
    recordSystemEvent: () => undefined,
    getAudit: () => [],
    close: () => undefined
  }
  return db as unknown as GoalControllerDatabase
}

describe('ControllerScheduler', () => {
  it('refreshes the App Server before reading usage', async () => {
    const adapter = new FakeAdapter()
    const scheduler = new ControllerScheduler(adapter, fakeDatabase())
    const cycle = scheduler.runCycle()
    await Promise.resolve()
    await Promise.resolve()
    expect(adapter.refreshes).toBe(1)
    expect(adapter.reads).toBe(1)
    adapter.releaseRead?.()
    const snapshot = await cycle
    expect(snapshot.usage?.fiveHour.usedPercent).toBe(25)
  })

  it('coalesces concurrent manual checks into one fresh cycle', async () => {
    const adapter = new FakeAdapter()
    const scheduler = new ControllerScheduler(adapter, fakeDatabase())
    const first = scheduler.runCycle()
    const second = scheduler.runCycle()
    await Promise.resolve()
    await Promise.resolve()
    expect(adapter.refreshes).toBe(1)
    expect(adapter.reads).toBe(1)
    adapter.releaseRead?.()
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second])
    expect(firstSnapshot.lastCheckedAt).toBe(secondSnapshot.lastCheckedAt)
    expect(adapter.refreshes).toBe(1)
  })

  it('keeps the last successful usage and marks errors as stale', async () => {
    const adapter = new FakeAdapter()
    adapter.getUsage = async () => { throw new Error('refresh failed') }
    const database = fakeDatabase()
    const scheduler = new ControllerScheduler(adapter, database)
    const snapshot: DashboardSnapshot = await scheduler.runCycle()
    expect(snapshot.status).toBe('MONITORING_ERROR')
    expect(snapshot.lastError).toContain('refresh failed')
  })
})
