import type {
  ExecutionPolicy,
  GoalControlResult,
  PendingExecutionRequest,
  RemoteGoal,
  ThreadExecutionState,
  ThreadGoalStatus,
  UsageInfo
} from '../shared/types'

export interface ChatGPTAdapter {
  getPendingExecutionRequests?(): PendingExecutionRequest[]
  onExecutionStateChange?(listener: () => void): () => void
  connect(): Promise<void>
  refreshConnection(): Promise<void>
  close(): Promise<void>
  getUsage(): Promise<UsageInfo>
  listGoals(): Promise<RemoteGoal[]>
  getGoalStatus(goalId: string): Promise<ThreadGoalStatus>
  getExecutionState(goalId: string): Promise<ThreadExecutionState>
  pauseGoal(goalId: string, policy: ExecutionPolicy): Promise<GoalControlResult>
  resumeGoal(goalId: string, policy: ExecutionPolicy, beforeWrite?: () => Promise<void>): Promise<GoalControlResult>
  ensureGoalExecution(goalId: string, policy: ExecutionPolicy, beforeWrite?: () => Promise<void>): Promise<GoalControlResult>
  steerGoalTurn(goalId: string, turnId: string, input: string): Promise<boolean>
  getVersion(): Promise<string | null>
}
