import { describe, expect, it } from 'vitest'
import { evaluatePolicies, evaluateWindowPolicy } from '../src/core/policy/policy-engine'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { GoalRecord, UsageInfo } from '../src/shared/types'

function goal(overrides: Partial<GoalRecord> & Pick<GoalRecord, 'id' | 'priority'>): GoalRecord {
  return {
    name: overrides.id,
    objective: 'test',
    remoteStatus: 'active',
    runtimeStatus: 'active',
    controllerStatus: 'allowed',
    controllerManaged: false,
    excluded: false,
    createdAt: 1,
    lastActivityAt: 1,
    lastSeenAt: 1,
    pausedAt: null,
    resumedAt: null,
    cooldownUntil: null,
    tokensUsed: 0,
    tokenBudget: null,
    lastTurnId: null,
    lastTurnStatus: null,
    proposedAction: 'none',
    proposedReason: null,
    policyOverride: null,
    sessionControlStatus: 'unknown',
    ...overrides
  }
}

function usage(
  fiveHour: number,
  weekly: number,
  fiveHourReset: number | null = 10_000,
  weeklyReset: number | null = 20_000
): UsageInfo {
  return {
    measuredAt: 1_000,
    limitId: 'codex',
    fiveHour: { usedPercent: fiveHour, windowDurationMins: 300, resetsAt: fiveHourReset },
    weekly: { usedPercent: weekly, windowDurationMins: 10_080, resetsAt: weeklyReset }
  }
}

describe('quota window policy', () => {
  it('blocks at the configured remaining boundary but not immediately above it', () => {
    expect(evaluateWindowPolicy(usage(90, 0).fiveHour, DEFAULT_SETTINGS.fiveHourPolicy, 1_000).blocked).toBe(true)
    expect(evaluateWindowPolicy(usage(89, 0).fiveHour, DEFAULT_SETTINGS.fiveHourPolicy, 1_000).blocked).toBe(false)
  })

  it('allows full use inside the configured final window', () => {
    const decision = evaluateWindowPolicy(
      usage(97, 0, 1_000 + 29 * 60).fiveHour,
      DEFAULT_SETTINGS.fiveHourPolicy,
      1_000
    )
    expect(decision).toMatchObject({ blocked: false, finalWindowActive: true, remainingPercent: 3 })
  })

  it('does not activate the final window for missing or past reset times', () => {
    expect(evaluateWindowPolicy(usage(95, 0, null).fiveHour, DEFAULT_SETTINGS.fiveHourPolicy, 1_000)).toMatchObject({ blocked: true, finalWindowActive: false })
    expect(evaluateWindowPolicy(usage(95, 0, 999).fiveHour, DEFAULT_SETTINGS.fiveHourPolicy, 1_000)).toMatchObject({ blocked: true, finalWindowActive: false })
  })

  it('supports zero and one-hundred percent stop limits', () => {
    expect(evaluateWindowPolicy(usage(100, 0).fiveHour, { ...DEFAULT_SETTINGS.fiveHourPolicy, stopRemainingPercent: 0, useFullQuotaNearReset: false }, 1_000).blocked).toBe(true)
    expect(evaluateWindowPolicy(usage(0, 0).fiveHour, { ...DEFAULT_SETTINGS.fiveHourPolicy, stopRemainingPercent: 100, useFullQuotaNearReset: false }, 1_000).blocked).toBe(true)
  })
})

describe('Goal quota evaluation', () => {
  it('requires both windows to allow the Goal', () => {
    const result = evaluatePolicies(
      [goal({ id: 'goal', priority: 50 })],
      usage(95, 90, 1_000 + 20 * 60, 20_000),
      DEFAULT_SETTINGS,
      1_000
    )
    expect(result.actions).toEqual([
      expect.objectContaining({ action: 'pause', reason: 'quota', detail: expect.stringContaining('Weekly') })
    ])
  })

  it('resumes a controller-owned Goal during a final full-use window', () => {
    const result = evaluatePolicies(
      [goal({ id: 'goal', priority: 50, remoteStatus: 'paused', controllerManaged: true, controllerStatus: 'paused_quota' })],
      usage(95, 20, 1_000 + 20 * 60, 20_000),
      DEFAULT_SETTINGS,
      1_000
    )
    expect(result.actions).toEqual([
      expect.objectContaining({ action: 'resume', detail: expect.stringContaining('full-use') })
    ])
  })

  it('uses a Goal override instead of the general policy', () => {
    const result = evaluatePolicies(
      [goal({
        id: 'custom',
        priority: 50,
        policyOverride: {
          fiveHourPolicy: { stopRemainingPercent: 20, useFullQuotaNearReset: false, finalWindowMinutes: 30 },
          weeklyPolicy: DEFAULT_SETTINGS.weeklyPolicy,
          cooldownSeconds: 5,
          executionPolicy: DEFAULT_SETTINGS.executionPolicy
        }
      })],
      usage(85, 20),
      DEFAULT_SETTINGS,
      1_000
    )
    expect(result.actions).toEqual([
      expect.objectContaining({ goalId: 'custom', action: 'pause', detail: expect.stringContaining('20%') })
    ])
  })

  it('uses priority only to enforce the concurrency limit', () => {
    const result = evaluatePolicies(
      [goal({ id: 'p50', priority: 50 }), goal({ id: 'p90', priority: 90 })],
      usage(20, 20),
      { ...DEFAULT_SETTINGS, maxRunningGoals: 1 },
      1_000
    )
    expect(result.allowedGoalIds).toEqual(['p90'])
    expect(result.actions).toEqual([
      expect.objectContaining({ goalId: 'p50', action: 'pause', reason: 'priority' })
    ])
  })

  it('does not resume manual pauses and honors cooldown', () => {
    const result = evaluatePolicies(
      [
        goal({ id: 'manual', priority: 100, remoteStatus: 'paused', controllerStatus: 'paused_manual' }),
        goal({ id: 'cooldown', priority: 90, cooldownUntil: 2_000 })
      ],
      usage(99, 99),
      DEFAULT_SETTINGS,
      1_000
    )
    expect(result.actions).toHaveLength(0)
  })
})
