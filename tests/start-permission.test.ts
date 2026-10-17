import { describe, expect, it } from 'vitest'
import { assertStartPermission, validateStartUsage } from '../src/core/policy/start-permission'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { evaluatePolicies, evaluateWindowPolicy } from '../src/core/policy/policy-engine'
import type { GoalRecord, UsageInfo } from '../src/shared/types'

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'target', name: 'target', objective: 'test', remoteStatus: 'paused', runtimeStatus: 'idle',
    controllerStatus: 'paused_quota', controllerManaged: true, excluded: false,
    createdAt: 1, lastActivityAt: 1, lastSeenAt: 1, pausedAt: 1, resumedAt: null,
    cooldownUntil: null, tokensUsed: 0, tokenBudget: null, lastTurnId: null, lastTurnStatus: null,
    proposedAction: 'none', proposedReason: null, policyOverride: null, sessionControlStatus: 'idle', priority: 50,
    ...overrides
  }
}
function usage(fiveUsed = 20, weeklyUsed = 20): UsageInfo {
  return { measuredAt: 1_000, limitId: 'codex',
    fiveHour: { usedPercent: fiveUsed, windowDurationMins: 300, resetsAt: 10_000 },
    weekly: { usedPercent: weeklyUsed, windowDurationMins: 10_080, resetsAt: 20_000 } }
}

describe('S3 shared start decision', () => {
  it('requires fresh complete validated windows including a sane clock', () => {
    for (const value of [null, { ...usage(), measuredAt: 989 }, { ...usage(), measuredAt: 1_010 },
      { ...usage(), weekly: undefined }, { ...usage(), fiveHour: { ...usage().fiveHour, usedPercent: NaN } },
      { ...usage(), weekly: { ...usage().weekly, windowDurationMins: 60 } }]) {
      expect(() => validateStartUsage(value as UsageInfo, 1_000)).toThrow(/güncel/)
    }
    expect(() => validateStartUsage(usage(), NaN)).toThrow()
    expect(() => validateStartUsage({ ...usage(), measuredAt: 990 }, 1_000)).not.toThrow()
  })

  it('allows the user example independently for two Goal-specific thresholds', () => {
    const target = goal({ policyOverride: {
      fiveHourPolicy: { ...DEFAULT_SETTINGS.fiveHourPolicy, stopRemainingPercent: 15 },
      weeklyPolicy: { ...DEFAULT_SETTINGS.weeklyPolicy, stopRemainingPercent: 85 },
      cooldownSeconds: 120, executionPolicy: DEFAULT_SETTINGS.executionPolicy
    } })
    expect(assertStartPermission(target, [target], usage(77, 12), DEFAULT_SETTINGS, 'manual', 1_000)).toContain('haftalık kalan %88.0')
    expect(() => assertStartPermission(target, [target], usage(85, 12), DEFAULT_SETTINGS, 'manual', 1_000)).toThrow(/5 saatlik/)
    expect(() => assertStartPermission(target, [target], usage(77, 15), DEFAULT_SETTINGS, 'manual', 1_000)).toThrow(/Haftalık/)
  })

  it('does not let a manual ownership claim bypass quota or cooldown', () => {
    const target = goal({ excluded: true, controllerManaged: false, controllerStatus: 'paused_manual' })
    expect(() => assertStartPermission(target, [target], usage(), DEFAULT_SETTINGS, 'manual', 1_000)).not.toThrow()
    expect(() => assertStartPermission(target, [target], usage(90), DEFAULT_SETTINGS, 'manual', 1_000)).toThrow(/5 saatlik/)
    expect(() => assertStartPermission({ ...target, cooldownUntil: 1_010 }, [target], usage(), DEFAULT_SETTINGS, 'manual', 1_000)).toThrow(/cooldown/)
  })

  it('does not start an unowned, excluded, external or manual pause automatically', () => {
    for (const override of [{ controllerManaged: false }, { excluded: true }, { controllerStatus: 'paused_manual' }, { controllerStatus: 'error' }]) {
      const target = goal(override as Partial<GoalRecord>)
      expect(() => assertStartPermission(target, [target], usage(), DEFAULT_SETTINGS, 'automatic', 1_000)).toThrow(/Başlatılmadı/)
    }
  })

  it('respects automatic-control off without disabling deliberate manual control', () => {
    const target = goal()
    const settings = { ...DEFAULT_SETTINGS, automaticControl: false }
    expect(() => assertStartPermission(target, [target], usage(), settings, 'automatic', 1_000)).toThrow(/kapalı/)
    expect(() => assertStartPermission(target, [target], usage(), settings, 'manual', 1_000)).not.toThrow()
  })

  it('does not reserve capacity for unstartable paused or cooldown candidates', () => {
    const target = goal()
    const unowned = goal({ id: 'unowned', priority: 100, controllerManaged: false })
    const cooling = goal({ id: 'cooling', priority: 90, cooldownUntil: 2_000 })
    const settings = { ...DEFAULT_SETTINGS, maxRunningGoals: 1 }
    expect(evaluatePolicies([unowned, cooling, target], usage(), settings, 1_000).allowedGoalIds).toEqual(['target'])
    expect(() => assertStartPermission(target, [unowned, cooling, target], usage(), settings, 'automatic', 1_000)).not.toThrow()
  })

  it('counts a paused Goal with a still-running session and unresolved starts against capacity', () => {
    const target = goal()
    const stopping = goal({ id: 'stopping', remoteStatus: 'paused', runtimeStatus: 'active', lastTurnStatus: 'inProgress', sessionControlStatus: 'unknown' })
    const settings = { ...DEFAULT_SETTINGS, maxRunningGoals: 1 }
    expect(() => assertStartPermission(target, [target, stopping], usage(), settings, 'manual', 1_000)).toThrow(/maksimum/)
    expect(() => assertStartPermission(target, [target], usage(), settings, 'manual', 1_000, new Set(['uncertain']))).toThrow(/maksimum/)
    expect(() => assertStartPermission(target, [target], usage(), settings, 'manual', 1_000, new Set(['target']))).not.toThrow()
  })

  it('does not admit a resume until a lower-priority running turn really stopped', () => {
    const target = goal({ priority: 90 })
    const running = goal({ id: 'running', priority: 10, remoteStatus: 'active', runtimeStatus: 'active' })
    const settings = { ...DEFAULT_SETTINGS, maxRunningGoals: 1 }
    expect(evaluatePolicies([target, running], usage(), settings, 1_000).allowedGoalIds).toEqual(['target'])
    expect(() => assertStartPermission(target, [target, running], usage(), settings, 'automatic', 1_000)).toThrow(/maksimum/)
  })

  it('never permits exhausted quota even during both final windows', () => {
    const limits = usage(100, 100)
    limits.fiveHour.resetsAt = limits.weekly.resetsAt = 1_001
    expect(evaluateWindowPolicy(limits.fiveHour, DEFAULT_SETTINGS.fiveHourPolicy, 1_000).blocked).toBe(true)
    expect(() => assertStartPermission(goal(), [goal()], limits, DEFAULT_SETTINGS, 'manual', 1_000)).toThrow(/tükenmiş/)
  })

  it('handles 0 minutes and invalid reset times without waiving the reserve', () => {
    for (const reset of [null, 999, Infinity, NaN]) {
      expect(evaluateWindowPolicy({ ...usage(95).fiveHour, resetsAt: reset }, DEFAULT_SETTINGS.fiveHourPolicy, 1_000)).toMatchObject({ blocked: true, finalWindowActive: false })
    }
    expect(evaluateWindowPolicy({ ...usage(95).fiveHour, resetsAt: 1_001 }, { ...DEFAULT_SETTINGS.fiveHourPolicy, finalWindowMinutes: 0 }, 1_000).blocked).toBe(true)
  })

  it('does not let one final-window exception bypass the other quota window', () => {
    const limits = usage(97, 91)
    limits.fiveHour.resetsAt = 1_060
    expect(() => assertStartPermission(goal(), [goal()], limits, DEFAULT_SETTINGS, 'manual', 1_000)).toThrow(/Haftalık/)
  })

  it('honors quota override removal and the new general settings', () => {
    const target = goal({ policyOverride: { fiveHourPolicy: { ...DEFAULT_SETTINGS.fiveHourPolicy, stopRemainingPercent: 50 }, weeklyPolicy: DEFAULT_SETTINGS.weeklyPolicy, cooldownSeconds: 20, executionPolicy: DEFAULT_SETTINGS.executionPolicy } })
    expect(() => assertStartPermission(target, [target], usage(60), DEFAULT_SETTINGS, 'manual', 1_000)).toThrow()
    const inherited = { ...target, policyOverride: null }
    expect(() => assertStartPermission(inherited, [inherited], usage(60), DEFAULT_SETTINGS, 'manual', 1_000)).not.toThrow()
    expect(() => assertStartPermission(inherited, [inherited], usage(60), { ...DEFAULT_SETTINGS, fiveHourPolicy: target.policyOverride!.fiveHourPolicy }, 'manual', 1_000)).toThrow()
  })

  it('rejects terminal, blocked or missing remote Goals', () => {
    for (const status of ['complete', 'blocked', 'usageLimited', 'budgetLimited'] as const) {
      expect(() => assertStartPermission(goal({ remoteStatus: status }), [goal()], usage(), DEFAULT_SETTINGS, 'manual', 1_000)).toThrow(/durumu/)
    }
    expect(() => assertStartPermission(undefined, [], usage(), DEFAULT_SETTINGS, 'manual', 1_000)).toThrow()
  })

  it('does not defer a quota stop because a cooldown is still active', () => {
    const target = goal({ remoteStatus: 'active', runtimeStatus: 'active', cooldownUntil: 2_000 })
    expect(evaluatePolicies([target], usage(95), DEFAULT_SETTINGS, 1_000).actions).toEqual([expect.objectContaining({ action: 'pause', reason: 'quota' })])
  })
})
