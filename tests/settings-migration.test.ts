import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalControllerDatabase } from '../src/persistence/database'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('settings migration and Goal overrides', () => {
  it('migrates 0.1.5 settings while preserving unrelated values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-controller-settings-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'settings.db')
    new GoalControllerDatabase(filename).close()
    const raw = new Database(filename)
    raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify({
      pollIntervalSeconds: 30,
      automaticControl: false,
      launchAtLogin: false,
      maxRunningGoals: 7,
      cooldownSeconds: 456,
      hysteresisPercent: 10,
      fiveHourBands: [{ threshold: 70, minimumPriority: 40 }],
      weeklyBands: [{ threshold: 80, minimumPriority: 50 }]
    }), 'controller')
    raw.close()

    const database = new GoalControllerDatabase(filename)
    expect(database.getSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      pollIntervalSeconds: 30,
      automaticControl: false,
      launchAtLogin: false,
      maxRunningGoals: 7,
      cooldownSeconds: 456
    })
    database.close()
  })

  it('persists and removes a complete per-Goal override', () => {
    const database = new GoalControllerDatabase(':memory:')
    database.upsertGoals([{
      id: 'goal-1',
      name: 'Goal',
      objective: 'test',
      remoteStatus: 'active',
      runtimeStatus: 'idle',
      createdAt: 1,
      lastActivityAt: 1,
      tokensUsed: 0,
      tokenBudget: null,
      lastTurnId: null,
      lastTurnStatus: null
    }], 1)
    const policy = {
      cooldownSeconds: 9,
      fiveHourPolicy: { stopRemainingPercent: 4, useFullQuotaNearReset: false, finalWindowMinutes: 12 },
      weeklyPolicy: { stopRemainingPercent: 8, useFullQuotaNearReset: true, finalWindowMinutes: 45 },
      executionPolicy: { interruptActiveTurnOnPause: false, continueTurnOnResume: true }
    }
    database.updateGoalPolicy('goal-1', policy)
    expect(database.getGoals()[0].policyOverride).toEqual(policy)
    database.upsertGoals([], 2)
    expect(database.getGoals()).toEqual([])
    database.upsertGoals([{
      id: 'goal-1', name: 'Goal', objective: 'test', remoteStatus: 'paused', runtimeStatus: 'idle',
      createdAt: 1, lastActivityAt: 1, tokensUsed: 0, tokenBudget: null,
      lastTurnId: null, lastTurnStatus: null
    }], 3)
    expect(database.getGoals()[0].policyOverride).toEqual(policy)
    database.updateGoalPolicy('goal-1', null)
    expect(database.getGoals()[0].policyOverride).toBeNull()
    database.close()
  })

  it('rejects a five-hour final window longer than five hours', () => {
    const database = new GoalControllerDatabase(':memory:')
    expect(() => database.updateSettings({
      fiveHourPolicy: { ...DEFAULT_SETTINGS.fiveHourPolicy, finalWindowMinutes: 301 }
    })).toThrow()
    database.close()
  })

  it('fills both execution defaults when an older Goal override omits them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-controller-override-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'override.db')
    const database = new GoalControllerDatabase(filename)
    database.upsertGoals([{
      id: 'goal-legacy',
      name: 'Legacy Goal',
      objective: 'test',
      remoteStatus: 'active',
      runtimeStatus: 'idle',
      createdAt: 1,
      lastActivityAt: 1,
      tokensUsed: 0,
      tokenBudget: null,
      lastTurnId: null,
      lastTurnStatus: null
    }], 1)
    database.updateGoalPolicy('goal-legacy', {
      cooldownSeconds: 10,
      fiveHourPolicy: { ...DEFAULT_SETTINGS.fiveHourPolicy },
      weeklyPolicy: { ...DEFAULT_SETTINGS.weeklyPolicy },
      executionPolicy: { interruptActiveTurnOnPause: true, continueTurnOnResume: true }
    })
    database.close()
    const raw = new Database(filename)
    raw.prepare('UPDATE goal_policy_overrides SET value_json = ?').run(JSON.stringify({
      cooldownSeconds: 10,
      fiveHourPolicy: { ...DEFAULT_SETTINGS.fiveHourPolicy },
      weeklyPolicy: { ...DEFAULT_SETTINGS.weeklyPolicy }
    }))
    raw.close()
    const migrated = new GoalControllerDatabase(filename)
    expect(migrated.getGoals()[0].policyOverride?.executionPolicy).toEqual(DEFAULT_SETTINGS.executionPolicy)
    migrated.close()
  })
})
