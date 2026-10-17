import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChatGPTAdapter } from '../chatgpt-adapter'
import type {
  ExecutionPolicy,
  GoalControlResult,
  PendingExecutionRequest,
  RemoteGoal,
  ThreadExecutionState,
  ThreadGoalStatus,
  ThreadRuntimeStatus,
  ThreadTurnStatus,
  UsageInfo,
  UsageWindow
} from '../../shared/types'
import { AppServerRpcClient } from './rpc-client'
import { resolveCodexExecutable } from './executable'

const execFileAsync = promisify(execFile)

interface AppServerTurn {
  id: string
  status?: string
}

interface AppServerThread {
  id: string
  name?: string | null
  preview?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  status?: { type?: string }
  turns?: AppServerTurn[]
}

interface ThreadListResponse {
  data: AppServerThread[]
  nextCursor?: string | null
}

interface ThreadReadResponse {
  thread: AppServerThread
}

interface ThreadGoalResponse {
  goal: {
    threadId: string
    objective: string
    status: ThreadGoalStatus
    tokenBudget: number | null
    tokensUsed: number
    createdAt: number
    updatedAt: number
  } | null
}

interface RateLimitWindowRaw {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

interface RateLimitSnapshotRaw {
  limitId?: string | null
  primary?: RateLimitWindowRaw | null
  secondary?: RateLimitWindowRaw | null
}

interface RateLimitsResponse {
  rateLimits?: RateLimitSnapshotRaw | null
  rateLimitsByLimitId?: Record<string, RateLimitSnapshotRaw> | null
}

function normalizeRuntimeStatus(value?: string): ThreadRuntimeStatus {
  if (value === 'notLoaded' || value === 'idle' || value === 'systemError' || value === 'active') {
    return value
  }
  return 'unknown'
}

function normalizeTurnStatus(value?: string): ThreadTurnStatus | null {
  if (value === 'inProgress' || value === 'completed' || value === 'failed' || value === 'interrupted') {
    return value
  }
  return value ? 'unknown' : null
}

function executionState(thread: AppServerThread): ThreadExecutionState {
  const turns = thread.turns ?? []
  const active = [...turns].reverse().find((turn) => turn.status === 'inProgress') ?? null
  const last = turns.at(-1) ?? null
  return {
    runtimeStatus: normalizeRuntimeStatus(thread.status?.type),
    activeTurnId: thread.status?.type === 'active' ? active?.id ?? null : null,
    lastTurnId: last?.id ?? null,
    lastTurnStatus: normalizeTurnStatus(last?.status)
  }
}

function isActiveWriterConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /active writer|already has.*writer/i.test(message)
}

function controlResult(
  goalStatus: ThreadGoalStatus,
  execution: ThreadExecutionState,
  turnAction: GoalControlResult['turnAction'],
  verified = false
): GoalControlResult {
  return {
    goalStatus,
    execution,
    turnAction,
    turnId: execution.activeTurnId ?? execution.lastTurnId,
    verified,
    writerConflict: turnAction === 'writerConflict'
  }
}

function normalizeWindow(raw: RateLimitWindowRaw | null | undefined, duration: number): UsageWindow | null {
  if (!raw || raw.windowDurationMins !== duration || typeof raw.usedPercent !== 'number') return null
  if (!Number.isFinite(raw.usedPercent) || raw.usedPercent < 0 || raw.usedPercent > 100) return null
  return {
    usedPercent: raw.usedPercent,
    windowDurationMins: duration,
    resetsAt: typeof raw.resetsAt === 'number' ? raw.resetsAt : null
  }
}

export function selectUsageWindows(response: RateLimitsResponse, measuredAt = Math.floor(Date.now() / 1000)): UsageInfo {
  const snapshots = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)
    : response.rateLimits
      ? [response.rateLimits]
      : []
  for (const snapshot of snapshots) {
    const windows = [snapshot.primary, snapshot.secondary]
    const fiveHour = windows.map((item) => normalizeWindow(item, 300)).find(Boolean)
    const weekly = windows.map((item) => normalizeWindow(item, 10_080)).find(Boolean)
    if (fiveHour && weekly) {
      return {
        fiveHour,
        weekly,
        measuredAt,
        limitId: snapshot.limitId ?? 'codex'
      }
    }
  }
  throw new Error('The App Server response does not contain both 5-hour and weekly usage windows.')
}

export class CodexAppServerAdapter implements ChatGPTAdapter {
  getPendingExecutionRequests(): PendingExecutionRequest[] {
    return (this.executionRpc.getPendingServerRequests?.() ?? []).map((request) => {
      const params = request.params as { threadId?: unknown; turnId?: unknown } | null
      return {
        id: request.id, method: request.method, connectionEpoch: request.connectionEpoch,
        receivedAt: request.receivedAt,
        threadId: typeof params?.threadId === 'string' ? params.threadId : null,
        turnId: typeof params?.turnId === 'string' ? params.turnId : null
      }
    })
  }

  onExecutionStateChange(listener: () => void): () => void {
    return this.executionRpc.onStateChange?.(listener) ?? (() => undefined)
  }

  constructor(
    private readonly monitorRpc = new AppServerRpcClient(),
    private readonly executionRpc = new AppServerRpcClient(),
    private readonly pauseVerification = { timeoutMs: 30_000, pollMs: 1_000 }
  ) {
    if (!Number.isFinite(pauseVerification.timeoutMs) || pauseVerification.timeoutMs < 1 ||
        !Number.isFinite(pauseVerification.pollMs) || pauseVerification.pollMs < 1) {
      throw new Error('Invalid pause verification budget.')
    }
  }

  connect(): Promise<void> {
    return this.monitorRpc.connect()
  }

  async refreshConnection(): Promise<void> {
    await this.monitorRpc.close()
    await this.monitorRpc.connect()
  }

  async close(): Promise<void> {
    if (this.monitorRpc === this.executionRpc) {
      await this.monitorRpc.close()
      return
    }
    await Promise.all([this.monitorRpc.close(), this.executionRpc.close()])
  }

  async getUsage(): Promise<UsageInfo> {
    const result = await this.monitorRpc.request<RateLimitsResponse>('account/rateLimits/read', {
      excludeResetCreditDetails: true
    })
    return selectUsageWindows(result)
  }

  async listGoals(): Promise<RemoteGoal[]> {
    const threads: AppServerThread[] = []
    let cursor: string | null = null
    do {
      const result: ThreadListResponse = await this.monitorRpc.request<ThreadListResponse>('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer']
      })
      threads.push(...(result.data ?? []))
      cursor = result.nextCursor ?? null
    } while (cursor)

    const goals: RemoteGoal[] = []
    const batchSize = 8
    for (let index = 0; index < threads.length; index += batchSize) {
      const batch = threads.slice(index, index + batchSize)
      const results = await Promise.allSettled(
        batch.map(async (thread) => {
          const goalResult = await this.monitorRpc.request<ThreadGoalResponse>('thread/goal/get', { threadId: thread.id })
          if (!goalResult.goal) return null
          let readResult: ThreadReadResponse
          try {
            readResult = await this.monitorRpc.request<ThreadReadResponse>('thread/read', { threadId: thread.id, includeTurns: true })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (!/list_turns is not supported yet|ephemeral threads do not support includeTurns/.test(message)) throw error
            // Empty threads can expose runtime but no persisted turn history.
            // Do not invent a turn ID or a terminal result from this response.
            readResult = await this.monitorRpc.request<ThreadReadResponse>('thread/read', { threadId: thread.id, includeTurns: false })
          }
          const state = executionState(readResult.thread)
          return {
            id: thread.id,
            name: thread.name?.trim() || thread.preview?.trim() || goalResult.goal.objective.slice(0, 80),
            objective: goalResult.goal.objective,
            remoteStatus: goalResult.goal.status,
            runtimeStatus: state.runtimeStatus,
            createdAt: goalResult.goal.createdAt ?? thread.createdAt ?? null,
            lastActivityAt: Math.max(goalResult.goal.updatedAt ?? 0, thread.updatedAt ?? 0) || null,
            tokensUsed: goalResult.goal.tokensUsed,
            tokenBudget: goalResult.goal.tokenBudget,
            lastTurnId: state.lastTurnId,
            lastTurnStatus: state.lastTurnStatus
          } satisfies RemoteGoal
        })
      )
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) goals.push(result.value)
        if (result.status === 'rejected') {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
          if (!/thread not found|goal not found/i.test(message)) throw result.reason
        }
      }
    }
    return goals
  }

  async getGoalStatus(goalId: string): Promise<ThreadGoalStatus> {
    const result = await this.monitorRpc.request<ThreadGoalResponse>('thread/goal/get', { threadId: goalId })
    if (!result.goal) throw new Error(`Goal not found: ${goalId}`)
    return result.goal.status
  }

  async getExecutionState(goalId: string): Promise<ThreadExecutionState> {
    await this.executionRpc.connect()
    const result = await this.executionRpc.request<ThreadReadResponse>('thread/read', {
      threadId: goalId,
      includeTurns: true
    })
    return executionState(result.thread)
  }

  private async setGoalStatus(goalId: string, status: 'paused' | 'active', beforeWrite?: () => Promise<void>): Promise<void> {
    await this.executionRpc.connect()
    await beforeWrite?.()
    const result = await this.executionRpc.request<ThreadGoalResponse>('thread/goal/set', {
      threadId: goalId,
      status
    })
    if (result.goal?.status !== status) throw new Error(`Goal ${status} was not confirmed: ${goalId}`)
  }

  async pauseGoal(goalId: string, policy: ExecutionPolicy): Promise<GoalControlResult> {
    await this.setGoalStatus(goalId, 'paused')
    const deadline = Date.now() + this.pauseVerification.timeoutMs
    const epoch = this.executionRpc.connectionEpoch
    let state = await this.getExecutionState(goalId)
    if (!policy.interruptActiveTurnOnPause) {
      return this.checkPausedGoalOnly(goalId, state, epoch)
    }
    if (state.runtimeStatus === 'notLoaded' || !await this.isThreadLoaded(goalId, deadline)) {
      try {
        await this.executionRpc.request('thread/resume', { threadId: goalId }, this.pauseRpcBudget(deadline))
        state = await this.getExecutionState(goalId)
      } catch (error) {
        if (isActiveWriterConflict(error)) {
          return controlResult('paused', state, 'writerConflict', false)
        }
        throw error
      }
    }
    const turnId = state.activeTurnId
    const before = await this.readPauseVerification(goalId, turnId, epoch, deadline)
    if (before.verified || !turnId || before.goalStatus !== 'paused' ||
        before.execution.activeTurnId !== turnId || before.verification?.terminalStatus ||
        this.executionRpc.connectionEpoch !== epoch ||
        before.controlError === 'Session is not loaded on the execution connection.') return before
    let interruptError: string | undefined
    // Do not resend an interrupt for a turn that already has terminal evidence.
    if (!this.executionRpc.observations?.getTerminal(goalId, turnId, epoch)) {
      try {
        await this.executionRpc.request('turn/interrupt', { threadId: goalId, turnId }, this.pauseRpcBudget(deadline))
      } catch (error) {
        if (isActiveWriterConflict(error)) {
          return { ...controlResult('paused', state, 'writerConflict', false), turnId }
        }
        // A lost ACK or a completion race is not proof of failure; inspect outcome first.
        interruptError = error instanceof Error ? error.message : String(error)
      }
    }
    let outcome: GoalControlResult = { ...before, turnAction: 'interruptRequested', turnId }
    do {
      try {
        outcome = await this.readPauseVerification(goalId, turnId, epoch, deadline)
        if (!outcome.verified) outcome.turnAction = 'interruptRequested'
      } catch (error) {
        return { ...outcome, verified: false, controlError: error instanceof Error ? error.message : String(error) }
      }
      if (outcome.verified || outcome.goalStatus !== 'paused' ||
          this.executionRpc.connectionEpoch !== epoch ||
          (outcome.execution.activeTurnId && outcome.execution.activeTurnId !== turnId) ||
          outcome.controlError === 'Session is not loaded on the execution connection.') return outcome
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.pauseVerification.pollMs, remaining)))
    } while (Date.now() <= deadline)
    return {
      ...outcome, verified: false, turnAction: 'interruptRequested', turnId,
      controlError: interruptError ?? 'Pause terminal outcome could not be verified within the observation budget.'
    }
  }

  private pauseRpcBudget(deadline: number): number {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Control verification deadline exceeded.')
    return Math.min(15_000, remaining)
  }

  private async isThreadLoaded(goalId: string, deadline = Date.now() + this.pauseVerification.timeoutMs): Promise<boolean> {
    let cursor: string | undefined
    const cursors = new Set<string>()
    for (let page = 0; page < 100; page += 1) {
      const result = await this.executionRpc.request<{ data: string[]; nextCursor?: string | null }>(
        'thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }, this.pauseRpcBudget(deadline)
      )
      if (!Array.isArray(result.data) || !result.data.every((id) => typeof id === 'string')) return false
      if (result.data.includes(goalId)) return true
      if (!result.nextCursor || cursors.has(result.nextCursor)) return false
      cursor = result.nextCursor
      cursors.add(cursor)
    }
    return false
  }

  private async checkPausedGoalOnly(goalId: string, state: ThreadExecutionState, epoch: number): Promise<GoalControlResult> {
    const { goal } = await this.executionRpc.request<ThreadGoalResponse>('thread/goal/get', { threadId: goalId })
    if (!goal) throw new Error(`Goal not found: ${goalId}`)
    const verified = goal.status === 'paused' && this.executionRpc.connectionEpoch === epoch
    return {
      ...controlResult(goal.status, state, 'none', verified),
      verification: { source: verified ? 'goal-only' : 'unverified', connectionEpoch: epoch, observedAt: Date.now() }
    }
  }

  private async readPauseVerification(goalId: string, turnId: string | null, epoch: number, deadline: number): Promise<GoalControlResult> {
    const { goal } = await this.executionRpc.request<ThreadGoalResponse>('thread/goal/get', { threadId: goalId }, this.pauseRpcBudget(deadline))
    if (!goal) throw new Error(`Goal not found: ${goalId}`)
    const loaded = await this.isThreadLoaded(goalId, deadline)
    const { thread } = await this.executionRpc.request<ThreadReadResponse>('thread/read', { threadId: goalId, includeTurns: true }, this.pauseRpcBudget(deadline))
    const state = executionState(thread)
    const event = turnId ? this.executionRpc.observations?.getTerminal(goalId, turnId, epoch) : null
    const target = turnId ? thread.turns?.find((turn) => turn.id === turnId) : null
    const terminalStatus = event?.status ?? (target?.status === 'completed' || target?.status === 'interrupted' || target?.status === 'failed' ? target.status : undefined)
    const verified = goal.status === 'paused' && this.executionRpc.connectionEpoch === epoch && loaded &&
      state.runtimeStatus === 'idle' && !state.activeTurnId && (!turnId || terminalStatus !== undefined)
    const result: GoalControlResult = {
      ...controlResult(goal.status, state, terminalStatus === 'interrupted' ? 'interrupted' : 'none', verified), turnId,
      verification: {
        source: !verified ? 'unverified' : event ? 'turn/completed' : turnId ? 'thread/read' : 'loaded-idle',
        connectionEpoch: epoch, observedAt: Date.now(), terminalStatus
      }
    }
    if (!loaded) result.controlError = 'Session is not loaded on the execution connection.'
    else if (!verified) result.controlError = 'Goal or session pause is not yet verified.'
    return result
  }

  async ensureGoalExecution(goalId: string, policy: ExecutionPolicy, beforeWrite?: () => Promise<void>): Promise<GoalControlResult> {
    let state = await this.getExecutionState(goalId)
    const epoch = this.executionRpc.connectionEpoch
    if (!policy.continueTurnOnResume) {
      const { goal } = await this.executionRpc.request<ThreadGoalResponse>('thread/goal/get', { threadId: goalId })
      if (!goal) throw new Error(`Goal not found: ${goalId}`)
      return {
        ...controlResult(goal.status, state, 'none', goal.status === 'active' && epoch === this.executionRpc.connectionEpoch),
        verification: { source: 'goal-only', connectionEpoch: epoch, observedAt: Date.now() }
      }
    }

    if (state.runtimeStatus === 'notLoaded' || !await this.isThreadLoaded(goalId)) {
      await beforeWrite?.()
      if (!policy.continueTurnOnResume) return this.ensureGoalExecution(goalId, policy)
      try {
        // Reopen the same thread on the shared server. Native Goal continuation
        // owns turn scheduling; never race it with an extra Continue message.
        await this.executionRpc.request('thread/resume', { threadId: goalId })
      } catch (error) {
        if (isActiveWriterConflict(error)) {
          return controlResult('active', state, 'writerConflict', false)
        }
        throw error
      }
    }

    const deadline = Date.now() + Math.min(2_000, this.pauseVerification.timeoutMs)
    do {
      const { goal } = await this.executionRpc.request<ThreadGoalResponse>('thread/goal/get', { threadId: goalId }, this.pauseRpcBudget(deadline))
      if (!goal) throw new Error(`Goal not found: ${goalId}`)
      const loaded = await this.isThreadLoaded(goalId, deadline)
      const { thread } = await this.executionRpc.request<ThreadReadResponse>('thread/read', { threadId: goalId, includeTurns: true }, this.pauseRpcBudget(deadline))
      state = executionState(thread)
      const verified = goal.status === 'active' && epoch === this.executionRpc.connectionEpoch &&
        loaded && state.runtimeStatus === 'active' && state.activeTurnId !== null
      const result: GoalControlResult = {
        ...controlResult(goal.status, state, state.activeTurnId ? 'alreadyRunning' : 'none', verified),
        verification: { source: verified ? 'thread/read' : 'unverified', connectionEpoch: epoch, observedAt: Date.now() }
      }
      if (verified || goal.status !== 'active' || epoch !== this.executionRpc.connectionEpoch || !loaded) return result
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        result.controlError = 'Goal aktif; yerel Goal devamının başladığı doğrulanmadı. Ek Continue gönderilmedi.'
        return result
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)))
    } while (Date.now() < deadline)
    return { ...controlResult('active', state, 'none', false), controlError: 'Goal aktif; çalışma başlangıcı henüz doğrulanmadı.' }
  }

  async resumeGoal(goalId: string, policy: ExecutionPolicy, beforeWrite?: () => Promise<void>): Promise<GoalControlResult> {
    await this.setGoalStatus(goalId, 'active', beforeWrite)
    return this.ensureGoalExecution(goalId, policy, beforeWrite)
  }

  async steerGoalTurn(goalId: string, turnId: string, input: string): Promise<boolean> {
    try {
      await this.executionRpc.request('turn/steer', {
        threadId: goalId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: input }]
      })
      return true
    } catch (error) {
      if (isActiveWriterConflict(error)) return false
      throw error
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const executable = resolveCodexExecutable()
      const { stdout } = await execFileAsync(executable, ['--version'], { windowsHide: true })
      return stdout.trim() || null
    } catch {
      return null
    }
  }
}
