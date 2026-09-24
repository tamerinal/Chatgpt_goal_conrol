import { EventEmitter } from 'node:events'
import type { ChatGPTAdapter } from '../../adapters/chatgpt-adapter'
import { GoalControllerDatabase } from '../../persistence/database'
import type {
  ControllerSettings,
  DashboardSnapshot,
  GoalPolicyOverride,
  GoalControlResult,
  ProposedAction,
  UpdateSettingsInput
} from '../../shared/types'
import { effectiveGoalPolicy, evaluatePolicies } from '../policy/policy-engine'

export class ControllerScheduler extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private status: DashboardSnapshot['status'] = 'STARTING'
  private lastCheckedAt: number | null = null
  private lastError: string | null = null
  private appServerVersion: string | null = null
  private cyclePromise: Promise<DashboardSnapshot> | null = null
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly adapter: ChatGPTAdapter,
    private readonly database: GoalControllerDatabase
  ) {
    super()
  }

  async start(): Promise<void> {
    try {
      this.appServerVersion = await this.adapter.getVersion()
      await this.runCycle()
    } catch (error) {
      this.handleFailure(error)
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const { pollIntervalSeconds } = this.database.getSettings()
    this.timer = setTimeout(async () => {
      await this.runCycle()
      this.schedule()
    }, pollIntervalSeconds * 1000)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  runCycle(): Promise<DashboardSnapshot> {
    if (this.cyclePromise) return this.cyclePromise
    const promise = this.enqueue(() => this.performCycle())
    this.cyclePromise = promise
    void promise.then(
      () => { if (this.cyclePromise === promise) this.cyclePromise = null },
      () => { if (this.cyclePromise === promise) this.cyclePromise = null }
    )
    return promise
  }

  private async performCycle(): Promise<DashboardSnapshot> {
    this.running = true
    this.emitSnapshot()
    const now = Math.floor(Date.now() / 1000)
    const correlationId = crypto.randomUUID()

    try {
      await this.adapter.refreshConnection()
      const usage = await this.adapter.getUsage()
      const goals = await this.adapter.listGoals()
      const previousUsage = this.database.getLatestUsage()
      this.database.saveUsage(usage)
      this.recordDetectedResets(previousUsage, usage, now)
      this.database.upsertGoals(goals, now)

      const settings = this.database.getSettings()
      if (settings.automaticControl) {
        const evaluation = evaluatePolicies(
          this.database.getGoals(),
          usage,
          settings,
          now
        )
        this.database.recordProposedActions(evaluation.actions, now, correlationId)
        await this.executeActions(evaluation.actions, settings, now, correlationId)
        if (evaluation.actions.length > 0) {
          this.database.upsertGoals(await this.adapter.listGoals(), Math.floor(Date.now() / 1000))
        }
        await this.ensureAllowedExecutions(evaluation.allowedGoalIds, settings, now, correlationId)
        this.database.upsertGoals(await this.adapter.listGoals(), Math.floor(Date.now() / 1000))
        this.database.clearProposals()
      } else {
        this.database.clearProposals()
      }

      this.status = 'MONITORING'
      this.lastError = null
      this.lastCheckedAt = now
    } catch (error) {
      this.handleFailure(error, now)
    } finally {
      this.running = false
      this.emitSnapshot()
    }
    return this.snapshot()
  }

  private async executeActions(
    actions: ProposedAction[],
    settings: ControllerSettings,
    timestamp: number,
    correlationId: string
  ): Promise<void> {
    const ordered = [...actions].sort((left, right) => {
      if (left.action === right.action) return left.goalId.localeCompare(right.goalId)
      return left.action === 'pause' ? -1 : 1
    })
    const failures: string[] = []

    for (const action of ordered) {
      try {
        const current = await this.adapter.getGoalStatus(action.goalId)
        const expected = action.action === 'pause' ? 'active' : 'paused'
        if (current !== expected) {
          this.database.recordActionResult(
            action,
            'skipped',
            timestamp,
            correlationId,
            `Remote status changed to ${current}; expected ${expected}.`
          )
          continue
        }

        let controlResult: GoalControlResult | null = null
        const goal = this.database.getGoals().find((item) => item.id === action.goalId)
        if (!goal) throw new Error('Goal not found.')
        const goalPolicy = effectiveGoalPolicy(goal, settings)
        if (action.action === 'pause') {
          controlResult = await this.adapter.pauseGoal(action.goalId, goalPolicy.executionPolicy)
          const reason = action.reason === 'priority'
            ? 'priority'
            : action.reason === 'manual'
              ? 'manual'
              : 'quota'
          this.database.markGoalPaused(action.goalId, reason, timestamp, goalPolicy.cooldownSeconds)
        } else if (action.action === 'resume') {
          controlResult = await this.adapter.resumeGoal(action.goalId, goalPolicy.executionPolicy)
          this.database.markGoalResumed(action.goalId, timestamp)
        }
        if (controlResult) this.persistSessionControl(action.goalId, controlResult)
        this.database.recordActionResult(
          action,
          controlResult?.turnAction === 'writerConflict' ? 'skipped' : 'executed',
          timestamp,
          correlationId,
          `${action.detail}${controlResult ? ` ${this.executionDetail(controlResult)}` : ''}`.trim()
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${action.goalName}: ${message}`)
        this.database.recordActionResult(action, 'failed', timestamp, correlationId, message)
      }
    }

    if (failures.length > 0) throw new Error(failures.join(' | '))
  }

  private executionDetail(result: GoalControlResult): string {
    if (result.turnAction === 'interrupted') return `Turn ${result.execution.lastTurnId ?? 'unknown'} interrupted.`
    if (result.turnAction === 'started') return `Continue turn ${result.execution.activeTurnId ?? 'unknown'} started.`
    if (result.turnAction === 'alreadyRunning') return `Turn ${result.execution.activeTurnId ?? 'unknown'} already running.`
    if (result.turnAction === 'writerConflict') {
      return 'Session is currently controlled by another ChatGPT/Codex process; it will be retried automatically.'
    }
    return 'No turn action was required.'
  }

  private persistSessionControl(goalId: string, result: GoalControlResult): void {
    if (result.turnAction === 'writerConflict') this.database.markSessionControlStatus(goalId, 'writerConflict')
    else if (result.turnAction === 'interrupted') this.database.markSessionControlStatus(goalId, 'interrupted')
    else if (result.turnAction === 'started' || result.turnAction === 'alreadyRunning') {
      this.database.markSessionControlStatus(goalId, 'running')
    } else this.database.markSessionControlStatus(goalId, 'idle')
  }

  private async ensureAllowedExecutions(
    allowedGoalIds: string[],
    settings: ControllerSettings,
    timestamp: number,
    correlationId: string
  ): Promise<void> {
    const allowed = new Set(allowedGoalIds)
    const failures: string[] = []
    for (const goal of this.database.getGoals()) {
      if (!allowed.has(goal.id) || goal.remoteStatus !== 'active' || !goal.controllerManaged || goal.excluded) continue
      const policy = effectiveGoalPolicy(goal, settings).executionPolicy
      if (!policy.continueTurnOnResume) continue
      const action: ProposedAction = {
        goalId: goal.id,
        goalName: goal.name,
        action: 'continue',
        reason: 'quota',
        detail: 'Ensured that the allowed active Goal has a running session turn.',
        usageFiveHour: this.database.getLatestUsage()?.fiveHour.usedPercent ?? 0,
        usageWeekly: this.database.getLatestUsage()?.weekly.usedPercent ?? 0
      }
      try {
        const result = await this.adapter.ensureGoalExecution(goal.id, policy)
        this.persistSessionControl(goal.id, result)
        if (result.turnAction === 'started') {
          this.database.recordActionResult(action, 'executed', timestamp, correlationId, this.executionDetail(result))
        } else if (result.turnAction === 'writerConflict' && goal.sessionControlStatus !== 'writerConflict') {
          this.database.recordActionResult(action, 'skipped', timestamp, correlationId, this.executionDetail(result))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.database.markSessionControlStatus(goal.id, 'error')
        failures.push(`${goal.name}: ${message}`)
        this.database.recordActionResult(action, 'failed', timestamp, correlationId, message)
      }
    }
    if (failures.length > 0) throw new Error(failures.join(' | '))
  }

  private recordDetectedResets(
    previous: DashboardSnapshot['usage'],
    current: NonNullable<DashboardSnapshot['usage']>,
    timestamp: number
  ): void {
    if (!previous) return
    const resetWindows: string[] = []
    const resetDetected = (oldPercent: number, nextPercent: number, oldReset: number | null, nextReset: number | null) =>
      (oldReset !== null && nextReset !== null && nextReset > oldReset && nextPercent < oldPercent) ||
      nextPercent <= oldPercent - 20
    if (resetDetected(
      previous.fiveHour.usedPercent,
      current.fiveHour.usedPercent,
      previous.fiveHour.resetsAt,
      current.fiveHour.resetsAt
    )) resetWindows.push('5-hour')
    if (resetDetected(
      previous.weekly.usedPercent,
      current.weekly.usedPercent,
      previous.weekly.resetsAt,
      current.weekly.resetsAt
    )) resetWindows.push('weekly')
    if (resetWindows.length) {
      this.database.recordSystemEvent(
        'quota_reset_detected',
        'info',
        `${resetWindows.join(' and ')} quota reset detected.`,
        timestamp
      )
    }
  }

  private handleFailure(error: unknown, timestamp = Math.floor(Date.now() / 1000)): void {
    this.status = 'MONITORING_ERROR'
    this.lastError = error instanceof Error ? error.message : String(error)
    this.lastCheckedAt = timestamp
    this.database.clearProposals()
    this.database.recordSystemEvent('monitoring_error', 'failed', this.lastError, timestamp)
  }

  snapshot(): DashboardSnapshot {
    return {
      status: this.status,
      usage: this.database.getLatestUsage(),
      goals: this.database.getGoals(),
      audit: this.database.getAudit(),
      settings: this.database.getSettings(),
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      cycleRunning: this.running,
      appServerVersion: this.appServerVersion
    }
  }

  updatePriority(goalId: string, priority: number): DashboardSnapshot {
    this.database.updatePriority(goalId, priority)
    this.emitSnapshot()
    return this.snapshot()
  }

  setExcluded(goalId: string, excluded: boolean): DashboardSnapshot {
    this.database.setExcluded(goalId, excluded)
    this.emitSnapshot()
    return this.snapshot()
  }

  updateGoalPolicy(goalId: string, policy: GoalPolicyOverride | null): DashboardSnapshot {
    this.database.updateGoalPolicy(goalId, policy)
    this.emitSnapshot()
    return this.snapshot()
  }

  updateSettings(input: UpdateSettingsInput): DashboardSnapshot {
    const settings = this.database.updateSettings(input as Partial<ControllerSettings>)
    this.schedule()
    this.emit('settings-changed', settings)
    this.emitSnapshot()
    return this.snapshot()
  }

  takeControlAndResume(goalId: string): Promise<DashboardSnapshot> {
    return this.enqueue(async () => {
      const timestamp = Math.floor(Date.now() / 1000)
      const correlationId = crypto.randomUUID()
      const goal = this.database.getGoals().find((item) => item.id === goalId)
      if (!goal) throw new Error('Goal not found.')
      if (goal.remoteStatus !== 'paused' && goal.remoteStatus !== 'active') {
        throw new Error(`This Goal cannot be resumed from ${goal.remoteStatus}.`)
      }

      const usage = this.database.getLatestUsage()
      const action: ProposedAction = {
        goalId: goal.id,
        goalName: goal.name,
        action: 'resume',
        reason: 'manual',
        detail: 'Goal was explicitly taken under controller management and resumed.',
        usageFiveHour: usage?.fiveHour.usedPercent ?? 0,
        usageWeekly: usage?.weekly.usedPercent ?? 0
      }

      this.running = true
      this.emitSnapshot()
      try {
        await this.adapter.refreshConnection()
        const current = await this.adapter.getGoalStatus(goalId)
        const settings = this.database.getSettings()
        const executionPolicy = effectiveGoalPolicy(goal, settings).executionPolicy
        let controlResult: GoalControlResult
        if (current === 'paused') controlResult = await this.adapter.resumeGoal(goalId, executionPolicy)
        else if (current === 'active') controlResult = await this.adapter.ensureGoalExecution(goalId, executionPolicy)
        else throw new Error(`Remote Goal status is ${current}.`)
        this.database.markGoalResumed(goalId, timestamp)
        this.persistSessionControl(goalId, controlResult)
        this.database.recordActionResult(
          action,
          controlResult.turnAction === 'writerConflict' ? 'skipped' : 'executed',
          timestamp,
          correlationId,
          `${action.detail} ${this.executionDetail(controlResult)}`
        )
        this.database.upsertGoals(await this.adapter.listGoals(), Math.floor(Date.now() / 1000))
        this.database.clearProposals()
        this.status = 'MONITORING'
        this.lastError = null
        this.lastCheckedAt = timestamp
        return this.snapshot()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.database.recordActionResult(action, 'failed', timestamp, correlationId, message)
        this.handleFailure(error, timestamp)
        throw error
      } finally {
        this.running = false
        this.emitSnapshot()
      }
    })
  }

  pauseAll(): Promise<DashboardSnapshot> {
    return this.enqueue(async () => {
      const timestamp = Math.floor(Date.now() / 1000)
      const correlationId = crypto.randomUUID()
      const settings = this.database.getSettings()
      this.running = true
      this.emitSnapshot()
      try {
        await this.adapter.refreshConnection()
        this.database.upsertGoals(await this.adapter.listGoals(), timestamp)
        const usage = this.database.getLatestUsage()
        const actions: ProposedAction[] = this.database.getGoals()
          .filter((goal) => !goal.excluded && goal.remoteStatus === 'active')
          .map((goal) => ({
            goalId: goal.id,
            goalName: goal.name,
            action: 'pause',
            reason: 'manual',
            detail: 'Pause All was requested by the user.',
            usageFiveHour: usage?.fiveHour.usedPercent ?? 0,
            usageWeekly: usage?.weekly.usedPercent ?? 0
          }))
        await this.executeActions(actions, settings, timestamp, correlationId)
        if (actions.length > 0) {
          this.database.upsertGoals(await this.adapter.listGoals(), Math.floor(Date.now() / 1000))
        }
        this.database.clearProposals()
        this.status = 'MONITORING'
        this.lastError = null
        this.lastCheckedAt = timestamp
        return this.snapshot()
      } catch (error) {
        this.handleFailure(error, timestamp)
        throw error
      } finally {
        this.running = false
        this.emitSnapshot()
      }
    })
  }

  resumeAllowed(): Promise<DashboardSnapshot> {
    return this.runCycle()
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.snapshot())
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.operationTail
    await this.adapter.close()
    this.database.close()
  }
}
