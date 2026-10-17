export type ThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export type ThreadRuntimeStatus = 'notLoaded' | 'idle' | 'systemError' | 'active' | 'unknown'
export type ThreadTurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown'
export type SessionControlStatus = 'unknown' | 'idle' | 'running' | 'interrupted' | 'writerConflict' | 'error'

export type ControllerStatus =
  | 'allowed'
  | 'paused_quota'
  | 'paused_priority'
  | 'paused_direct'
  | 'paused_manual'
  | 'excluded'
  | 'completed'
  | 'remote_blocked'
  | 'error'

export type ActionReason = 'quota' | 'priority' | 'manual' | 'remote' | 'unknown'
export type ProposedActionType = 'pause' | 'resume' | 'continue' | 'none'

export interface UsageWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt: number | null
}

export interface UsageInfo {
  fiveHour: UsageWindow
  weekly: UsageWindow
  measuredAt: number
  limitId: string
}

export interface RemoteGoal {
  id: string
  name: string
  objective: string
  remoteStatus: ThreadGoalStatus
  runtimeStatus: ThreadRuntimeStatus
  createdAt: number | null
  lastActivityAt: number | null
  tokensUsed: number
  tokenBudget: number | null
  lastTurnId: string | null
  lastTurnStatus: ThreadTurnStatus | null
}

export interface GoalRecord extends RemoteGoal {
  priority: number
  controllerStatus: ControllerStatus
  controllerManaged: boolean
  excluded: boolean
  lastSeenAt: number
  pausedAt: number | null
  resumedAt: number | null
  cooldownUntil: number | null
  proposedAction: ProposedActionType
  proposedReason: ActionReason | null
  policyOverride: GoalPolicyOverride | null
  sessionControlStatus: SessionControlStatus
}

export interface QuotaWindowPolicy {
  stopRemainingPercent: number
  useFullQuotaNearReset: boolean
  finalWindowMinutes: number
}

export interface GoalPolicyOverride {
  fiveHourPolicy: QuotaWindowPolicy
  weeklyPolicy: QuotaWindowPolicy
  cooldownSeconds: number
  executionPolicy: ExecutionPolicy
}

export interface ExecutionPolicy {
  interruptActiveTurnOnPause: boolean
  continueTurnOnResume: boolean
}

export interface ThreadExecutionState {
  runtimeStatus: ThreadRuntimeStatus
  activeTurnId: string | null
  lastTurnId: string | null
  lastTurnStatus: ThreadTurnStatus | null
}

export interface GoalControlResult {
  goalStatus: ThreadGoalStatus
  execution: ThreadExecutionState
  turnAction: 'none' | 'alreadyRunning' | 'interrupted' | 'interruptRequested' | 'started' | 'writerConflict'
  turnId?: string | null
  verified?: boolean
  writerConflict?: boolean
  controlError?: string
  verification?: {
    source: 'turn/completed' | 'thread/read' | 'loaded-idle' | 'goal-only' | 'unverified'
    connectionEpoch: number
    observedAt: number
    terminalStatus?: 'completed' | 'interrupted' | 'failed'
  }
}

export interface ControllerSettings {
  pollIntervalSeconds: 30 | 60 | 120 | 300
  automaticControl: boolean
  launchAtLogin: boolean
  maxRunningGoals: number
  cooldownSeconds: number
  fiveHourPolicy: QuotaWindowPolicy
  weeklyPolicy: QuotaWindowPolicy
  executionPolicy: ExecutionPolicy
}

export interface ProposedAction {
  goalId: string
  goalName: string
  action: ProposedActionType
  reason: ActionReason
  detail: string
  usageFiveHour: number
  usageWeekly: number
}

export interface AuditEntry {
  id: number
  timestamp: number
  goalId: string | null
  goalName: string | null
  action: string
  reason: string
  status: 'proposed' | 'executed' | 'failed' | 'skipped' | 'info'
  detail: string | null
}

export interface DashboardSnapshot {
  pendingExecutionRequests?: PendingExecutionRequest[]
  status: 'STARTING' | 'MONITORING' | 'MONITORING_ERROR'
  usage: UsageInfo | null
  goals: GoalRecord[]
  audit: AuditEntry[]
  settings: ControllerSettings
  lastCheckedAt: number | null
  lastError: string | null
  cycleRunning: boolean
  appServerVersion: string | null
}

export interface PendingExecutionRequest {
  id: number | string
  method: string
  connectionEpoch: number
  receivedAt: number
  threadId: string | null
  turnId: string | null
}

export interface UpdateSettingsInput {
  pollIntervalSeconds?: 30 | 60 | 120 | 300
  automaticControl?: boolean
  launchAtLogin?: boolean
  maxRunningGoals?: number
  cooldownSeconds?: number
  fiveHourPolicy?: QuotaWindowPolicy
  weeklyPolicy?: QuotaWindowPolicy
  executionPolicy?: ExecutionPolicy
}

export interface GoalControllerApi {
  openSharedCodex(): Promise<string>
  getSnapshot(): Promise<DashboardSnapshot>
  runCheck(): Promise<DashboardSnapshot>
  updatePriority(goalId: string, priority: number): Promise<DashboardSnapshot>
  setExcluded(goalId: string, excluded: boolean): Promise<DashboardSnapshot>
  updateGoalPolicy(goalId: string, policy: GoalPolicyOverride | null): Promise<DashboardSnapshot>
  takeControlAndResume(goalId: string): Promise<DashboardSnapshot>
  startGoal(goalId: string): Promise<DashboardSnapshot>
  pauseGoal(goalId: string): Promise<DashboardSnapshot>
  updateSettings(input: UpdateSettingsInput): Promise<DashboardSnapshot>
  pauseAll(): Promise<DashboardSnapshot>
  resumeAllowed(): Promise<DashboardSnapshot>
  onSnapshot(callback: (snapshot: DashboardSnapshot) => void): () => void
}
