import { EventEmitter } from 'node:events'
import type { ChatGPTAdapter } from '../../adapters/chatgpt-adapter'
import { GoalControllerDatabase } from '../../persistence/database'
import type {
  ControllerSettings,
  DashboardSnapshot,
  GoalPolicyOverride,
  GoalControlResult,
  GoalRecord,
  UsageInfo,
  ExecutionPolicy,
  ProposedAction,
  UpdateSettingsInput
} from '../../shared/types'
import { effectiveGoalPolicy, evaluatePolicies } from '../policy/policy-engine'
import { assertStartPermission, StartDeniedError, validateStartUsage, type StartIntent } from '../policy/start-permission'

export class ControllerScheduler extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private status: DashboardSnapshot['status'] = 'STARTING'
  private lastCheckedAt: number | null = null
  private lastError: string | null = null
  private appServerVersion: string | null = null
  private cyclePromise: Promise<DashboardSnapshot> | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private unsubscribeExecutionState: (() => void) | null = null
  private settingsRevision = 0
  private reservedExecutions = new Set<string>()
  private goalScopeRevision = new Map<string, number>()

  constructor(
    private readonly adapter: ChatGPTAdapter,
    private readonly database: GoalControllerDatabase,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    super()
    this.unsubscribeExecutionState = this.adapter.onExecutionStateChange?.(() => this.emitSnapshot()) ?? null
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
    const now = this.nowSeconds()
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
        const verifyManualPause = action.action === 'pause' && action.reason === 'manual' && current === 'paused'
        if (current !== expected && !verifyManualPause) {
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
          if (controlResult.verified === true) this.reservedExecutions.delete(action.goalId)
          const reason = action.reason === 'priority'
            ? 'priority'
            : action.reason === 'manual'
              ? 'manual'
              : 'quota'
          this.database.markGoalPaused(action.goalId, reason, timestamp, goalPolicy.cooldownSeconds)
        } else if (action.action === 'resume') {
          const started = await this.guardedStart(action.goalId, 'automatic')
          controlResult = started.result
          action.detail += ` ${started.detail}`
          action.usageFiveHour = started.usage.fiveHour.usedPercent
          action.usageWeekly = started.usage.weekly.usedPercent
          if (controlResult.verified === true) this.database.markGoalResumed(action.goalId, timestamp)
        }
        if (controlResult) this.persistSessionControl(action.goalId, controlResult)
        this.database.recordActionResult(
          action,
          controlResult?.verified === true ? 'executed' : 'skipped',
          timestamp,
          correlationId,
          `${action.detail}${controlResult ? ` ${this.executionDetail(controlResult)}` : ''}`.trim()
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof StartDeniedError) {
          this.database.recordActionResult(action, 'skipped', timestamp, correlationId, message)
          continue
        }
        failures.push(`${action.goalName}: ${message}`)
        this.database.recordActionResult(action, 'failed', timestamp, correlationId, message)
      }
    }

    if (failures.length > 0) throw new Error(failures.join(' | '))
  }

  private executionDetail(result: GoalControlResult): string {
    const evidence = result.verification
      ? ` Evidence=${result.verification.source}; epoch=${result.verification.connectionEpoch}; terminal=${result.verification.terminalStatus ?? 'none'}.`
      : ''
    if (result.turnAction !== 'writerConflict' && result.verified !== true) {
      return `Goal ${result.goalStatus}; session outcome unverified (${result.turnAction}, turn ${result.turnId ?? 'unknown'}).${evidence}${result.controlError ? ` ${result.controlError}` : ''}`
    }
    if (result.turnAction === 'interrupted') return `Turn ${result.turnId ?? result.execution.lastTurnId ?? 'unknown'} interrupted.${evidence}`
    if (result.turnAction === 'started') return `Continue turn ${result.execution.activeTurnId ?? 'unknown'} started.`
    if (result.turnAction === 'alreadyRunning') return `Turn ${result.execution.activeTurnId ?? 'unknown'} already running.`
    if (result.turnAction === 'writerConflict') {
      return 'Session is currently controlled by another ChatGPT/Codex process; session control is unverified.'
    }
    return `No turn action was required.${evidence}`
  }

  private persistSessionControl(goalId: string, result: GoalControlResult): void {
    if (result.turnAction === 'writerConflict') this.database.markSessionControlStatus(goalId, 'writerConflict')
    else if (result.verified !== true) this.database.markSessionControlStatus(goalId, 'unknown')
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
        const started = await this.guardedStart(goal.id, 'automatic')
        const result = started.result
        action.detail += ` ${started.detail}`
        action.usageFiveHour = started.usage.fiveHour.usedPercent
        action.usageWeekly = started.usage.weekly.usedPercent
        this.persistSessionControl(goal.id, result)
        if (result.turnAction === 'started') {
          this.database.recordActionResult(action, result.verified === true ? 'executed' : 'skipped', timestamp, correlationId, this.executionDetail(result))
        } else if (result.turnAction === 'writerConflict' && goal.sessionControlStatus !== 'writerConflict') {
          this.database.recordActionResult(action, 'skipped', timestamp, correlationId, this.executionDetail(result))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof StartDeniedError) {
          this.database.recordActionResult(action, 'skipped', timestamp, correlationId, message)
          continue
        }
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
      appServerVersion: this.appServerVersion,
      pendingExecutionRequests: this.adapter.getPendingExecutionRequests?.() ?? []
    }
  }

  updatePriority(goalId: string, priority: number): DashboardSnapshot {
    this.database.updatePriority(goalId, priority)
    this.settingsRevision += 1
    this.emitSnapshot()
    return this.snapshot()
  }

  setExcluded(goalId: string, excluded: boolean): DashboardSnapshot {
    this.database.setExcluded(goalId, excluded)
    this.settingsRevision += 1
    this.goalScopeRevision.set(goalId, (this.goalScopeRevision.get(goalId) ?? 0) + 1)
    this.emitSnapshot()
    return this.snapshot()
  }

  updateGoalPolicy(goalId: string, policy: GoalPolicyOverride | null): DashboardSnapshot {
    this.database.updateGoalPolicy(goalId, policy)
    this.settingsRevision += 1
    this.emitSnapshot()
    return this.snapshot()
  }

  updateSettings(input: UpdateSettingsInput): DashboardSnapshot {
    const settings = this.database.updateSettings(input as Partial<ControllerSettings>)
    this.settingsRevision += 1
    this.schedule()
    this.emit('settings-changed', settings)
    this.emitSnapshot()
    return this.snapshot()
  }

  takeControlAndResume(goalId: string): Promise<DashboardSnapshot> {
    return this.enqueue(async () => {
      const timestamp = this.nowSeconds()
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
        detail: 'Goal devamı istendi; sonuç ayrıca doğrulanır.',
        usageFiveHour: usage?.fiveHour.usedPercent ?? 0,
        usageWeekly: usage?.weekly.usedPercent ?? 0
      }

      this.running = true
      this.emitSnapshot()
      try {
        const started = await this.guardedStart(goalId, 'manual')
        const controlResult = started.result
        action.detail += ` ${started.detail}`
        action.usageFiveHour = started.usage.fiveHour.usedPercent
        action.usageWeekly = started.usage.weekly.usedPercent
        if (controlResult.verified === true) this.database.markGoalResumed(goalId, timestamp)
        this.persistSessionControl(goalId, controlResult)
        this.database.recordActionResult(
          action,
          controlResult.verified === true ? 'executed' : 'skipped',
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
        if (error instanceof StartDeniedError) {
          this.database.recordActionResult(action, 'skipped', timestamp, correlationId, message)
          throw error
        }
        this.database.recordActionResult(action, 'failed', timestamp, correlationId, message)
        this.handleFailure(error, timestamp)
        throw error
      } finally {
        this.running = false
        this.emitSnapshot()
      }
    })
  }

  private async guardedStart(goalId: string, intent: StartIntent): Promise<{ result: GoalControlResult; usage: UsageInfo; detail: string }> {
    const scopeRevision = this.goalScopeRevision.get(goalId) ?? 0
    let usage: UsageInfo | null = null
    let goal: GoalRecord | undefined
    let detail = ''
    const policy: ExecutionPolicy = { interruptActiveTurnOnPause: true, continueTurnOnResume: true }
    const guard = async (): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (intent === 'manual' && (this.goalScopeRevision.get(goalId) ?? 0) !== scopeRevision) {
          throw new StartDeniedError('Başlatılmadı: kullanıcı bu işlem sırasında Goal kapsamını değiştirdi.', 'context_changed')
        }
        const revision = this.settingsRevision
        if (!usage || this.nowSeconds() - usage.measuredAt > 10) {
          await this.adapter.refreshConnection()
          try { usage = await this.adapter.getUsage() }
          catch { throw new StartDeniedError('Başlatılmadı: güncel kota okunamadı.', 'usage_unavailable') }
          validateStartUsage(usage, this.nowSeconds())
          this.database.saveUsage(usage)
          this.emitSnapshot()
        }
        const remote = await this.adapter.listGoals()
        this.database.upsertGoals(remote, this.nowSeconds())
        if (!remote.some((item) => item.id === goalId)) throw new StartDeniedError('Başlatılmadı: Goal artık güncel listede bulunmuyor.', 'remote_status')
        const current = await this.adapter.getGoalStatus(goalId)
        const goals = this.database.getGoals()
        goal = goals.find((item) => item.id === goalId)
        if (goal) goal = { ...goal, remoteStatus: current }
        if (revision !== this.settingsRevision) continue
        if (this.nowSeconds() - usage.measuredAt > 10) continue
        const settings = this.database.getSettings()
        detail = assertStartPermission(goal, goals, usage, settings, intent, this.nowSeconds(), this.reservedExecutions)
        Object.assign(policy, effectiveGoalPolicy(goal!, settings).executionPolicy)
        return
      }
      throw new StartDeniedError('Başlatılmadı: kontrol sırasında ayarlar veya kota ölçümü değişti; tekrar değerlendirme gerekli.', 'context_changed')
    }
    await guard()
    this.reservedExecutions.add(goalId)
    // Kept conservatively if dispatch is uncertain; durable reconciliation is S4/S5.
    const result = goal!.remoteStatus === 'paused'
      ? await this.adapter.resumeGoal(goalId, policy, guard)
      : await this.adapter.ensureGoalExecution(goalId, policy, guard)
    if (result.verified === true) this.reservedExecutions.delete(goalId)
    return { result, usage: usage!, detail }
  }

  pauseAll(): Promise<DashboardSnapshot> {
    return this.pauseTargets()
  }

  pauseGoal(goalId: string): Promise<DashboardSnapshot> {
    return this.controlGoalDirectly(goalId, 'pause')
  }

  startGoal(goalId: string): Promise<DashboardSnapshot> {
    return this.controlGoalDirectly(goalId, 'resume')
  }

  // Explicit row commands bypass local automation policy, sharing serialization,
  // adapter verification and audit with scheduled control. They never change scope.
  private controlGoalDirectly(goalId: string, command: 'pause' | 'resume'): Promise<DashboardSnapshot> {
    if (typeof goalId !== 'string' || !goalId.trim()) return Promise.reject(new Error('Goal kimliği gerekli; işlem gönderilmedi.'))
    return this.enqueue(async () => {
      const timestamp = this.nowSeconds()
      const correlationId = crypto.randomUUID()
      let action: ProposedAction | undefined
      this.running = true
      this.emitSnapshot()
      try {
        await this.adapter.refreshConnection()
        this.database.upsertGoals(await this.adapter.listGoals(), timestamp)
        const goal = this.database.getGoals().find(item => item.id === goalId)
        if (!goal) throw new Error('Goal güncel listede bulunamadı; işlem gönderilmedi.')
        const current = await this.adapter.getGoalStatus(goalId)
        if (current === 'complete') throw new Error('Tamamlanmış Goal için işlem gönderilmedi.')
        if (command === 'resume' && current !== 'active' && this.reservedExecutions.has(goalId)) {
          throw new Error('Önceki başlatmanın sonucu belirsiz; kör tekrar gönderilmedi. Önce bu Goal için Durdur sonucunu doğrulayın.')
        }
        const usage = this.database.getLatestUsage()
        action = {
          goalId, goalName: goal.name, action: command, reason: 'manual',
          detail: command === 'pause'
            ? 'Bağımsız Durdur: Goal ve aktif session için durdurma istendi; otomatik kontrol kuralları uygulanmadı.'
            : 'Bağımsız Başlat: yerel kota, cooldown, kapasite ve kapsam kuralları uygulanmadı.',
          usageFiveHour: usage?.fiveHour.usedPercent ?? 0,
          usageWeekly: usage?.weekly.usedPercent ?? 0
        }
        const policy: ExecutionPolicy = { interruptActiveTurnOnPause: true, continueTurnOnResume: true }
        const beforeStartWrite = async (): Promise<void> => {
          if (await this.adapter.getGoalStatus(goalId) === 'complete') throw new Error('Goal tamamlandı; başlatma gönderilmedi.')
        }
        if (command === 'resume') this.reservedExecutions.add(goalId)
        const result = command === 'pause'
          ? await this.adapter.pauseGoal(goalId, policy)
          : current === 'active'
            ? await this.adapter.ensureGoalExecution(goalId, policy, beforeStartWrite)
            : await this.adapter.resumeGoal(goalId, policy, beforeStartWrite)
        if (result.verified === true) {
          this.reservedExecutions.delete(goalId)
          this.database.recordDirectGoalControl(goalId, result.goalStatus, timestamp)
        } else if (command === 'resume') this.reservedExecutions.add(goalId)
        this.database.upsertGoals(await this.adapter.listGoals(), this.nowSeconds())
        this.persistSessionControl(goalId, result)
        this.database.recordActionResult(action, result.verified === true ? 'executed' : 'skipped', timestamp, correlationId,
          `${action.detail} ${this.executionDetail(result)}`)
        this.database.clearProposals()
        this.status = 'MONITORING'
        this.lastError = null
        this.lastCheckedAt = timestamp
        return this.snapshot()
      } catch (error) {
        if (action) this.database.recordActionResult(action, 'failed', timestamp, correlationId, error instanceof Error ? error.message : String(error))
        this.handleFailure(error, timestamp)
        throw error
      } finally {
        this.running = false
        this.emitSnapshot()
      }
    })
  }

  private pauseTargets(goalId?: string): Promise<DashboardSnapshot> {
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
        const goals = this.database.getGoals()
        const target = goalId ? goals.find(goal => goal.id === goalId) : undefined
        if (goalId && !target) throw new Error('Goal güncel listede bulunamadı; durdurma gönderilmedi.')
        if (target && target.remoteStatus !== 'active' && target.remoteStatus !== 'paused') {
          throw new Error(`Goal ${target.remoteStatus} durumunda durdurulamaz.`)
        }
        const actions: ProposedAction[] = goals
          .filter((goal) => goalId ? goal.id === goalId : !goal.excluded && goal.remoteStatus === 'active')
          .map((goal) => ({
            goalId: goal.id,
            goalName: goal.name,
            action: 'pause',
            reason: 'manual',
            detail: goalId ? 'Seçili Goal için manuel durdurma istendi.' : 'Pause All was requested by the user.',
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
    this.unsubscribeExecutionState?.()
    this.unsubscribeExecutionState = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.operationTail
    await this.adapter.close()
    this.database.close()
  }
}
