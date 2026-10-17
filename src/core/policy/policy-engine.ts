import type {
  GoalPolicyOverride,
  GoalRecord,
  ProposedAction,
  QuotaWindowPolicy,
  UsageInfo,
  UsageWindow
} from '../../shared/types'

export interface WindowPolicyDecision {
  blocked: boolean
  finalWindowActive: boolean
  remainingPercent: number
  minutesUntilReset: number | null
}

export interface EffectiveGoalPolicy extends GoalPolicyOverride {}

export interface PolicyEvaluation {
  actions: ProposedAction[]
  allowedGoalIds: string[]
}

export function evaluateWindowPolicy(
  window: UsageWindow,
  policy: QuotaWindowPolicy,
  measuredAt: number
): WindowPolicyDecision {
  if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 ||
      !Number.isInteger(policy.stopRemainingPercent) || policy.stopRemainingPercent < 0 || policy.stopRemainingPercent > 100) {
    return { blocked: true, finalWindowActive: false, remainingPercent: 0, minutesUntilReset: null }
  }
  const remainingPercent = Math.max(0, 100 - window.usedPercent)
  const secondsUntilReset = window.resetsAt === null || !Number.isFinite(window.resetsAt)
    ? null : window.resetsAt - measuredAt
  const minutesUntilReset = secondsUntilReset !== null && secondsUntilReset > 0
    ? secondsUntilReset / 60
    : null
  const finalWindowActive =
    policy.useFullQuotaNearReset &&
    Number.isInteger(policy.finalWindowMinutes) && policy.finalWindowMinutes > 0 &&
    minutesUntilReset !== null &&
    minutesUntilReset <= policy.finalWindowMinutes
  return {
    blocked: remainingPercent <= 0 || (!finalWindowActive && remainingPercent <= policy.stopRemainingPercent),
    finalWindowActive,
    remainingPercent,
    minutesUntilReset
  }
}

export function effectiveGoalPolicy(
  goal: GoalRecord,
  settings: {
    fiveHourPolicy: QuotaWindowPolicy
    weeklyPolicy: QuotaWindowPolicy
    cooldownSeconds: number
    executionPolicy: GoalPolicyOverride['executionPolicy']
  }
): EffectiveGoalPolicy {
  return goal.policyOverride ?? {
    fiveHourPolicy: settings.fiveHourPolicy,
    weeklyPolicy: settings.weeklyPolicy,
    cooldownSeconds: settings.cooldownSeconds,
    executionPolicy: settings.executionPolicy
  }
}

function windowDetail(
  label: string,
  decision: WindowPolicyDecision,
  policy: QuotaWindowPolicy
): string | null {
  if (decision.blocked) {
    return `${label} remaining ${decision.remainingPercent.toFixed(0)}% reached stop limit ${policy.stopRemainingPercent}%.`
  }
  if (decision.finalWindowActive) {
    return `${label} final ${policy.finalWindowMinutes}-minute full-use window is active.`
  }
  return null
}

export function evaluatePolicies(
  goals: GoalRecord[],
  usage: UsageInfo,
  settings: {
    fiveHourPolicy: QuotaWindowPolicy
    weeklyPolicy: QuotaWindowPolicy
    cooldownSeconds: number
    executionPolicy: GoalPolicyOverride['executionPolicy']
    maxRunningGoals: number
  },
  now: number
): PolicyEvaluation {
  const decisions = new Map(goals.map((goal) => {
    const policy = effectiveGoalPolicy(goal, settings)
    return [goal.id, {
      policy,
      fiveHour: evaluateWindowPolicy(usage.fiveHour, policy.fiveHourPolicy, now),
      weekly: evaluateWindowPolicy(usage.weekly, policy.weeklyPolicy, now)
    }] as const
  }))

  const candidates = goals
    .filter((goal) => {
      const decision = decisions.get(goal.id)!
      const selectable = goal.remoteStatus === 'active' || (
        goal.remoteStatus === 'paused' && goal.controllerManaged &&
        (goal.controllerStatus === 'paused_quota' || goal.controllerStatus === 'paused_priority' || goal.controllerStatus === 'paused_direct') &&
        (!goal.cooldownUntil || goal.cooldownUntil <= now)
      )
      return !goal.excluded &&
        selectable &&
        goal.remoteStatus !== 'complete' &&
        goal.remoteStatus !== 'blocked' &&
        goal.remoteStatus !== 'usageLimited' &&
        goal.remoteStatus !== 'budgetLimited' &&
        goal.controllerStatus !== 'paused_manual' &&
        !decision.fiveHour.blocked &&
        !decision.weekly.blocked
    })
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        (left.pausedAt ?? Number.MAX_SAFE_INTEGER) - (right.pausedAt ?? Number.MAX_SAFE_INTEGER) ||
        (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
    )

  const allowed = new Set(candidates.slice(0, settings.maxRunningGoals).map((goal) => goal.id))
  const actions: ProposedAction[] = []

  for (const goal of goals) {
    if (goal.excluded || goal.remoteStatus === 'complete') continue
    const decision = decisions.get(goal.id)!
    const details = [
      windowDetail('5-hour', decision.fiveHour, decision.policy.fiveHourPolicy),
      windowDetail('Weekly', decision.weekly, decision.policy.weeklyPolicy)
    ].filter((item): item is string => item !== null)
    const quotaDenied = decision.fiveHour.blocked || decision.weekly.blocked

    if (goal.remoteStatus === 'active' && !allowed.has(goal.id)) {
      actions.push({
        goalId: goal.id,
        goalName: goal.name,
        action: 'pause',
        reason: quotaDenied ? 'quota' : 'priority',
        detail: quotaDenied
          ? details.join(' ')
          : `Concurrency limit ${settings.maxRunningGoals} selected higher-ranked Goals.`,
        usageFiveHour: usage.fiveHour.usedPercent,
        usageWeekly: usage.weekly.usedPercent
      })
    }

    const resumable =
      goal.remoteStatus === 'paused' &&
      goal.controllerManaged &&
      (goal.controllerStatus === 'paused_quota' || goal.controllerStatus === 'paused_priority' || goal.controllerStatus === 'paused_direct')
    if (resumable && (!goal.cooldownUntil || goal.cooldownUntil <= now) && allowed.has(goal.id)) {
      actions.push({
        goalId: goal.id,
        goalName: goal.name,
        action: 'resume',
        reason: 'quota',
        detail: details.length > 0
          ? details.join(' ')
          : 'Both quota windows are above their stop limits.',
        usageFiveHour: usage.fiveHour.usedPercent,
        usageWeekly: usage.weekly.usedPercent
      })
    }
  }

  return { actions, allowedGoalIds: [...allowed] }
}
