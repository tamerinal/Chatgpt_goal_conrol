import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChatGPTAdapter } from '../chatgpt-adapter'
import type {
  ExecutionPolicy,
  GoalControlResult,
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

export const CONTINUE_GOAL_PROMPT =
  'Continue working toward the active Goal from where the previous turn stopped. Re-check the current repository and thread state, proceed with the next unfinished step, and do not repeat completed work.'
const PAUSE_GOAL_PROMPT =
  'The Goal has been paused because the usage quota is at its configured stop limit. Stop current work safely, do not start another action, and wait for a later Continue instruction.'

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

interface TurnStartResponse {
  turn: AppServerTurn
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
    activeTurnId: active?.id ?? null,
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
  verified = true
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
  constructor(
    private readonly monitorRpc = new AppServerRpcClient(),
    private readonly executionRpc = new AppServerRpcClient()
  ) {}

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
          const [goalResult, readResult] = await Promise.all([
            this.monitorRpc.request<ThreadGoalResponse>('thread/goal/get', { threadId: thread.id }),
            this.monitorRpc.request<ThreadReadResponse>('thread/read', { threadId: thread.id, includeTurns: true })
          ])
          if (!goalResult.goal) return null
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

  private async setGoalStatus(goalId: string, status: 'paused' | 'active'): Promise<void> {
    await this.executionRpc.connect()
    const result = await this.executionRpc.request<ThreadGoalResponse>('thread/goal/set', {
      threadId: goalId,
      status
    })
    if (result.goal?.status !== status) throw new Error(`Goal ${status} was not confirmed: ${goalId}`)
  }

  async pauseGoal(goalId: string, policy: ExecutionPolicy): Promise<GoalControlResult> {
    await this.setGoalStatus(goalId, 'paused')
    let state = await this.getExecutionState(goalId)
    if (!policy.interruptActiveTurnOnPause) {
      return controlResult('paused', state, 'none')
    }

    if (!state.activeTurnId && state.runtimeStatus === 'notLoaded') {
      try {
        await this.executionRpc.request('thread/resume', { threadId: goalId })
        state = await this.getExecutionState(goalId)
      } catch (error) {
        if (isActiveWriterConflict(error)) {
          return controlResult('paused', state, 'writerConflict', false)
        }
        throw error
      }
    }
    if (!state.activeTurnId) return controlResult('paused', state, 'none')

    const turnId = state.activeTurnId
    try {
      await this.executionRpc.request('turn/interrupt', { threadId: goalId, turnId })
      state = {
        ...state,
        runtimeStatus: 'idle',
        activeTurnId: null,
        lastTurnId: turnId,
        lastTurnStatus: 'interrupted'
      }
      return controlResult('paused', state, 'interrupted')
    } catch (error) {
      if (isActiveWriterConflict(error)) {
        if (turnId) await this.steerGoalTurn(goalId, turnId, PAUSE_GOAL_PROMPT)
        return controlResult('paused', state, 'writerConflict', false)
      }
      state = await this.getExecutionState(goalId)
      if (!state.activeTurnId) return controlResult('paused', state, 'none')
      throw error
    }
  }

  async ensureGoalExecution(goalId: string, policy: ExecutionPolicy): Promise<GoalControlResult> {
    let state = await this.getExecutionState(goalId)
    if (!policy.continueTurnOnResume) {
      return controlResult('active', state, 'none')
    }
    if (state.activeTurnId) {
      return controlResult('active', state, 'alreadyRunning')
    }

    if (state.runtimeStatus === 'notLoaded') {
      try {
        await this.executionRpc.request('thread/resume', { threadId: goalId })
      } catch (error) {
        if (isActiveWriterConflict(error)) {
          return controlResult('active', state, 'writerConflict', false)
        }
        throw error
      }
      state = await this.getExecutionState(goalId)
      if (state.activeTurnId) {
        return controlResult('active', state, 'alreadyRunning')
      }
    }

    try {
      const result = await this.executionRpc.request<TurnStartResponse>('turn/start', {
        threadId: goalId,
        input: [{ type: 'text', text: CONTINUE_GOAL_PROMPT }]
      })
      const started: ThreadExecutionState = {
        runtimeStatus: 'active',
        activeTurnId: result.turn.id,
        lastTurnId: result.turn.id,
        lastTurnStatus: normalizeTurnStatus(result.turn.status) ?? 'inProgress'
      }
      return controlResult('active', started, 'started')
    } catch (error) {
      if (isActiveWriterConflict(error)) {
        return controlResult('active', state, 'writerConflict', false)
      }
      state = await this.getExecutionState(goalId)
      if (state.activeTurnId) {
        return controlResult('active', state, 'alreadyRunning')
      }
      throw error
    }
  }

  async resumeGoal(goalId: string, policy: ExecutionPolicy): Promise<GoalControlResult> {
    await this.setGoalStatus(goalId, 'active')
    return this.ensureGoalExecution(goalId, policy)
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
