import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_SETTINGS } from '../shared/defaults'
import type {
  ActionReason,
  AuditEntry,
  ControllerSettings,
  ControllerStatus,
  GoalPolicyOverride,
  GoalRecord,
  ProposedAction,
  RemoteGoal,
  ThreadGoalStatus,
  ThreadRuntimeStatus,
  SessionControlStatus,
  ThreadTurnStatus,
  UsageInfo
} from '../shared/types'

const fiveHourPolicySchema = z.object({
  stopRemainingPercent: z.number().int().min(0).max(100),
  useFullQuotaNearReset: z.boolean(),
  finalWindowMinutes: z.number().int().min(0).max(300)
})

const weeklyPolicySchema = z.object({
  stopRemainingPercent: z.number().int().min(0).max(100),
  useFullQuotaNearReset: z.boolean(),
  finalWindowMinutes: z.number().int().min(0).max(10_080)
})

const executionPolicySchema = z.object({
  interruptActiveTurnOnPause: z.boolean(),
  continueTurnOnResume: z.boolean()
})

const goalPolicyOverrideSchema = z.object({
  fiveHourPolicy: fiveHourPolicySchema,
  weeklyPolicy: weeklyPolicySchema,
  cooldownSeconds: z.number().int().min(0).max(86_400),
  executionPolicy: executionPolicySchema.default(DEFAULT_SETTINGS.executionPolicy)
})

function parseGoalPolicyOverride(value: unknown): GoalPolicyOverride | null {
  if (!value || typeof value !== 'object') return null
  const stored = value as Partial<GoalPolicyOverride>
  const parsed = goalPolicyOverrideSchema.safeParse({
    ...stored,
    executionPolicy: {
      ...DEFAULT_SETTINGS.executionPolicy,
      ...(stored.executionPolicy ?? {})
    }
  })
  return parsed.success ? parsed.data : null
}

const settingsSchema = z.object({
  pollIntervalSeconds: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(300)]),
  automaticControl: z.boolean(),
  launchAtLogin: z.boolean(),
  maxRunningGoals: z.number().int().min(1).max(100),
  cooldownSeconds: z.number().int().min(0).max(86_400),
  fiveHourPolicy: fiveHourPolicySchema,
  weeklyPolicy: weeklyPolicySchema,
  executionPolicy: executionPolicySchema
})

function parseSettings(valueJson: string): ControllerSettings {
  const stored = JSON.parse(valueJson) as Partial<ControllerSettings>
  const parsed = settingsSchema.safeParse({
    ...DEFAULT_SETTINGS,
    ...stored,
    fiveHourPolicy: stored.fiveHourPolicy ?? DEFAULT_SETTINGS.fiveHourPolicy,
    weeklyPolicy: stored.weeklyPolicy ?? DEFAULT_SETTINGS.weeklyPolicy,
    executionPolicy: stored.executionPolicy ?? DEFAULT_SETTINGS.executionPolicy
  })
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS)
}

interface GoalRow {
  remote_goal_id: string
  name: string
  objective: string
  priority: number
  remote_status: ThreadGoalStatus
  runtime_status: ThreadRuntimeStatus
  controller_status: ControllerStatus
  controller_managed: number
  excluded: number
  remote_created_at: number | null
  last_activity_at: number | null
  last_seen_at: number
  paused_at: number | null
  resumed_at: number | null
  cooldown_until: number | null
  tokens_used: number
  token_budget: number | null
  last_turn_id: string | null
  last_turn_status: ThreadTurnStatus | null
  session_control_status: SessionControlStatus
}

function statusForRemote(goal: RemoteGoal, previous?: GoalRow): ControllerStatus {
  if (previous?.excluded) return 'excluded'
  if (goal.remoteStatus === 'complete') return 'completed'
  if (
    goal.remoteStatus === 'blocked' ||
    goal.remoteStatus === 'usageLimited' ||
    goal.remoteStatus === 'budgetLimited'
  ) {
    return 'remote_blocked'
  }
  if (goal.remoteStatus === 'paused') {
    if (
      previous?.controller_managed &&
      (previous.controller_status === 'paused_quota' || previous.controller_status === 'paused_priority')
    ) {
      return previous.controller_status
    }
    return 'paused_manual'
  }
  return 'allowed'
}

export class GoalControllerDatabase {
  private readonly db: Database.Database

  constructor(filename: string) {
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        remote_goal_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
        remote_status TEXT NOT NULL,
        runtime_status TEXT NOT NULL,
        controller_status TEXT NOT NULL,
        controller_managed INTEGER NOT NULL DEFAULT 0,
        excluded INTEGER NOT NULL DEFAULT 0,
        remote_created_at INTEGER,
        last_activity_at INTEGER,
        last_seen_at INTEGER NOT NULL,
        paused_at INTEGER,
        resumed_at INTEGER,
        cooldown_until INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        token_budget INTEGER,
        last_turn_id TEXT,
        last_turn_status TEXT,
        session_control_status TEXT NOT NULL DEFAULT 'unknown',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS goal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        goal_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        source TEXT NOT NULL,
        FOREIGN KEY(goal_id) REFERENCES goals(remote_goal_id)
      );

      CREATE TABLE IF NOT EXISTS usage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        five_hour_percent REAL NOT NULL,
        five_hour_reset INTEGER,
        weekly_percent REAL NOT NULL,
        weekly_reset INTEGER,
        quality TEXT NOT NULL DEFAULT 'fresh'
      );

      CREATE INDEX IF NOT EXISTS idx_usage_history_timestamp ON usage_history(timestamp DESC);

      CREATE TABLE IF NOT EXISTS controller_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        goal_id TEXT,
        goal_name TEXT,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        usage_5h REAL,
        usage_weekly REAL,
        status TEXT NOT NULL,
        detail TEXT,
        correlation_id TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_controller_actions_timestamp ON controller_actions(timestamp DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policy_state (
        window_key TEXT PRIMARY KEY,
        required_priority INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS current_proposals (
        goal_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(goal_id) REFERENCES goals(remote_goal_id)
      );

      CREATE TABLE IF NOT EXISTS goal_policy_overrides (
        goal_id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(goal_id) REFERENCES goals(remote_goal_id) ON DELETE CASCADE
      );
    `)

    const goalColumns = new Set(
      (this.db.prepare('PRAGMA table_info(goals)').all() as Array<{ name: string }>).map((column) => column.name)
    )
    if (!goalColumns.has('last_turn_id')) this.db.exec('ALTER TABLE goals ADD COLUMN last_turn_id TEXT')
    if (!goalColumns.has('last_turn_status')) this.db.exec('ALTER TABLE goals ADD COLUMN last_turn_status TEXT')
    if (!goalColumns.has('session_control_status')) {
      this.db.exec("ALTER TABLE goals ADD COLUMN session_control_status TEXT NOT NULL DEFAULT 'unknown'")
    }

    const now = Math.floor(Date.now() / 1000)
    this.db
      .prepare('INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('controller', JSON.stringify(DEFAULT_SETTINGS), now)
    const storedSettings = this.db.prepare(
      'SELECT value_json FROM settings WHERE key = ?'
    ).get('controller') as { value_json: string }
    const migratedSettings = parseSettings(storedSettings.value_json)
    if (JSON.stringify(migratedSettings) !== storedSettings.value_json) {
      this.db.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?')
        .run(JSON.stringify(migratedSettings), now, 'controller')
    }
    this.db
      .prepare('INSERT OR IGNORE INTO policy_state(window_key, required_priority, updated_at) VALUES (?, 0, ?)')
      .run('five_hour', now)
    this.db
      .prepare('INSERT OR IGNORE INTO policy_state(window_key, required_priority, updated_at) VALUES (?, 0, ?)')
      .run('weekly', now)
  }

  getSettings(): ControllerSettings {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get('controller') as
      | { value_json: string }
      | undefined
    if (!row) return structuredClone(DEFAULT_SETTINGS)
    return parseSettings(row.value_json)
  }

  updateSettings(patch: Partial<ControllerSettings>): ControllerSettings {
    const current = this.getSettings()
    const next = settingsSchema.parse({ ...current, ...patch })
    this.db
      .prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?')
      .run(JSON.stringify(next), Math.floor(Date.now() / 1000), 'controller')
    return next
  }

  upsertGoals(remoteGoals: RemoteGoal[], now: number): void {
    const existingRows = this.db.prepare('SELECT * FROM goals').all() as GoalRow[]
    const existingById = new Map(existingRows.map((row) => [row.remote_goal_id, row]))
    const upsert = this.db.prepare(`
      INSERT INTO goals (
        remote_goal_id, name, objective, priority, remote_status, runtime_status,
        controller_status, controller_managed, excluded, remote_created_at,
        last_activity_at, last_seen_at, tokens_used, token_budget,
        last_turn_id, last_turn_status, updated_at
      ) VALUES (
        @id, @name, @objective, 50, @remoteStatus, @runtimeStatus,
        @controllerStatus, 0, @excluded, @createdAt, @lastActivityAt, @now,
        @tokensUsed, @tokenBudget, @lastTurnId, @lastTurnStatus, @now
      )
      ON CONFLICT(remote_goal_id) DO UPDATE SET
        name = excluded.name,
        objective = excluded.objective,
        remote_status = excluded.remote_status,
        runtime_status = excluded.runtime_status,
        controller_status = excluded.controller_status,
        remote_created_at = excluded.remote_created_at,
        last_activity_at = excluded.last_activity_at,
        last_seen_at = excluded.last_seen_at,
        tokens_used = excluded.tokens_used,
        token_budget = excluded.token_budget,
        last_turn_id = excluded.last_turn_id,
        last_turn_status = excluded.last_turn_status,
        updated_at = excluded.updated_at
    `)
    const event = this.db.prepare(`
      INSERT INTO goal_events(timestamp, goal_id, event_type, old_value, new_value, source)
      VALUES (?, ?, ?, ?, ?, 'app_server')
    `)

    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE goals SET controller_status = CASE WHEN excluded = 1 THEN 'excluded' ELSE 'error' END").run()
      for (const goal of remoteGoals) {
        const previous = existingById.get(goal.id)
        const controllerStatus = previous ? statusForRemote(goal, previous) : 'excluded'
        upsert.run({ ...goal, controllerStatus, excluded: previous?.excluded ?? 1, now })
        if (previous && previous.remote_status !== goal.remoteStatus) {
          event.run(now, goal.id, 'remote_status', previous.remote_status, goal.remoteStatus)
        }
        if (previous && previous.runtime_status !== goal.runtimeStatus) {
          event.run(now, goal.id, 'runtime_status', previous.runtime_status, goal.runtimeStatus)
        }
      }
    })
    transaction()
  }

  getGoals(): GoalRecord[] {
    const rows = this.db.prepare('SELECT * FROM goals ORDER BY priority DESC, name COLLATE NOCASE').all() as GoalRow[]
    const latest = this.db.prepare(
      'SELECT goal_id, action, reason FROM current_proposals'
    ).all() as Array<{ goal_id: string; action: 'pause' | 'resume'; reason: ActionReason }>
    const proposed = new Map(latest.map((item) => [item.goal_id, item]))
    const overrideRows = this.db.prepare(
      'SELECT goal_id, value_json FROM goal_policy_overrides'
    ).all() as Array<{ goal_id: string; value_json: string }>
    const overrides = new Map<string, GoalPolicyOverride>()
    for (const row of overrideRows) {
      const parsed = parseGoalPolicyOverride(JSON.parse(row.value_json))
      if (parsed) overrides.set(row.goal_id, parsed)
    }
    return rows.map((row) => ({
      id: row.remote_goal_id,
      name: row.name,
      objective: row.objective,
      priority: row.priority,
      remoteStatus: row.remote_status,
      runtimeStatus: row.runtime_status,
      controllerStatus: row.controller_status,
      controllerManaged: Boolean(row.controller_managed),
      excluded: Boolean(row.excluded),
      createdAt: row.remote_created_at,
      lastActivityAt: row.last_activity_at,
      lastSeenAt: row.last_seen_at,
      pausedAt: row.paused_at,
      resumedAt: row.resumed_at,
      cooldownUntil: row.cooldown_until,
      tokensUsed: row.tokens_used,
      tokenBudget: row.token_budget,
      lastTurnId: row.last_turn_id,
      lastTurnStatus: row.last_turn_status,
      proposedAction: proposed.get(row.remote_goal_id)?.action ?? 'none',
      proposedReason: proposed.get(row.remote_goal_id)?.reason ?? null,
      policyOverride: overrides.get(row.remote_goal_id) ?? null,
      sessionControlStatus: row.session_control_status
    }))
  }

  markSessionControlStatus(goalId: string, status: SessionControlStatus): void {
    const result = this.db.prepare(`
      UPDATE goals SET session_control_status = ?, updated_at = ? WHERE remote_goal_id = ?
    `).run(status, Math.floor(Date.now() / 1000), goalId)
    if (!result.changes) throw new Error('Goal not found.')
  }

  saveUsage(usage: UsageInfo): void {
    this.db.prepare(`
      INSERT INTO usage_history(
        timestamp, limit_id, five_hour_percent, five_hour_reset,
        weekly_percent, weekly_reset, quality
      ) VALUES (?, ?, ?, ?, ?, ?, 'fresh')
    `).run(
      usage.measuredAt,
      usage.limitId,
      usage.fiveHour.usedPercent,
      usage.fiveHour.resetsAt,
      usage.weekly.usedPercent,
      usage.weekly.resetsAt
    )
  }

  getLatestUsage(): UsageInfo | null {
    const row = this.db.prepare('SELECT * FROM usage_history ORDER BY id DESC LIMIT 1').get() as
      | {
          timestamp: number
          limit_id: string
          five_hour_percent: number
          five_hour_reset: number | null
          weekly_percent: number
          weekly_reset: number | null
        }
      | undefined
    if (!row) return null
    return {
      measuredAt: row.timestamp,
      limitId: row.limit_id,
      fiveHour: {
        usedPercent: row.five_hour_percent,
        windowDurationMins: 300,
        resetsAt: row.five_hour_reset
      },
      weekly: {
        usedPercent: row.weekly_percent,
        windowDurationMins: 10_080,
        resetsAt: row.weekly_reset
      }
    }
  }

  recordProposedActions(actions: ProposedAction[], timestamp: number, correlationId: string): void {
    const insert = this.db.prepare(`
      INSERT INTO controller_actions(
        timestamp, goal_id, goal_name, action, reason, usage_5h,
        usage_weekly, status, detail, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
    `)
    const current = this.db.prepare(`
      INSERT INTO current_proposals(goal_id, action, reason, detail, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM current_proposals').run()
      for (const action of actions) {
        insert.run(
          timestamp,
          action.goalId,
          action.goalName,
          action.action,
          action.reason,
          action.usageFiveHour,
          action.usageWeekly,
          action.detail,
          correlationId
        )
        current.run(action.goalId, action.action, action.reason, action.detail, timestamp)
      }
    })
    transaction()
  }

  clearProposals(): void {
    this.db.prepare('DELETE FROM current_proposals').run()
  }

  recordSystemEvent(
    action: string,
    status: AuditEntry['status'],
    detail: string,
    timestamp = Math.floor(Date.now() / 1000)
  ): void {
    if (status === 'failed') {
      const last = this.db.prepare(`
        SELECT action, status, detail FROM controller_actions ORDER BY id DESC LIMIT 1
      `).get() as { action: string; status: string; detail: string | null } | undefined
      if (last?.action === action && last.status === status && last.detail === detail) return
    }
    this.db.prepare(`
      INSERT INTO controller_actions(
        timestamp, goal_id, goal_name, action, reason,
        status, detail, correlation_id
      ) VALUES (?, NULL, NULL, ?, 'unknown', ?, ?, ?)
    `).run(timestamp, action, status, detail, crypto.randomUUID())
  }

  getAudit(limit = 100): AuditEntry[] {
    return this.db.prepare(`
      SELECT id, timestamp, goal_id AS goalId, goal_name AS goalName,
             action, reason, status, detail
      FROM controller_actions
      ORDER BY id DESC LIMIT ?
    `).all(limit) as AuditEntry[]
  }

  updatePriority(goalId: string, priority: number): void {
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new Error('Priority must be an integer from 0 to 100.')
    }
    const result = this.db
      .prepare('UPDATE goals SET priority = ?, updated_at = ? WHERE remote_goal_id = ?')
      .run(priority, Math.floor(Date.now() / 1000), goalId)
    if (!result.changes) throw new Error('Goal not found.')
  }

  setExcluded(goalId: string, excluded: boolean): void {
    const result = this.db.prepare(`
      UPDATE goals
      SET excluded = ?, controller_status = CASE WHEN ? = 1 THEN 'excluded' ELSE 'allowed' END,
          updated_at = ?
      WHERE remote_goal_id = ?
    `).run(excluded ? 1 : 0, excluded ? 1 : 0, Math.floor(Date.now() / 1000), goalId)
    if (!result.changes) throw new Error('Goal not found.')
  }

  updateGoalPolicy(goalId: string, policy: GoalPolicyOverride | null): void {
    const exists = this.db.prepare('SELECT 1 FROM goals WHERE remote_goal_id = ?').get(goalId)
    if (!exists) throw new Error('Goal not found.')
    if (policy === null) {
      this.db.prepare('DELETE FROM goal_policy_overrides WHERE goal_id = ?').run(goalId)
      return
    }
    const validated = goalPolicyOverrideSchema.parse(policy)
    this.db.prepare(`
      INSERT INTO goal_policy_overrides(goal_id, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(goal_id) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(goalId, JSON.stringify(validated), Math.floor(Date.now() / 1000))
  }

  markGoalResumed(goalId: string, timestamp: number): void {
    const result = this.db.prepare(`
      UPDATE goals
      SET remote_status = 'active', controller_status = 'allowed', controller_managed = 1,
          excluded = 0, resumed_at = ?, cooldown_until = NULL, updated_at = ?
      WHERE remote_goal_id = ?
    `).run(timestamp, timestamp, goalId)
    if (!result.changes) throw new Error('Goal not found.')
  }

  markGoalPaused(
    goalId: string,
    reason: 'quota' | 'priority' | 'manual',
    timestamp: number,
    cooldownSeconds: number
  ): void {
    const controllerStatus: ControllerStatus = reason === 'quota'
      ? 'paused_quota'
      : reason === 'priority'
        ? 'paused_priority'
        : 'paused_manual'
    const controllerManaged = reason === 'manual' ? 0 : 1
    const result = this.db.prepare(`
      UPDATE goals
      SET remote_status = 'paused', controller_status = ?, controller_managed = ?,
          paused_at = ?, cooldown_until = ?, updated_at = ?
      WHERE remote_goal_id = ?
    `).run(
      controllerStatus,
      controllerManaged,
      timestamp,
      timestamp + cooldownSeconds,
      timestamp,
      goalId
    )
    if (!result.changes) throw new Error('Goal not found.')
  }

  recordActionResult(
    action: ProposedAction,
    status: Extract<AuditEntry['status'], 'executed' | 'failed' | 'skipped'>,
    timestamp: number,
    correlationId: string,
    detail = action.detail
  ): void {
    this.db.prepare(`
      INSERT INTO controller_actions(
        timestamp, goal_id, goal_name, action, reason, usage_5h,
        usage_weekly, status, detail, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      timestamp,
      action.goalId,
      action.goalName,
      action.action,
      action.reason,
      action.usageFiveHour,
      action.usageWeekly,
      status,
      detail,
      correlationId
    )
  }

  close(): void {
    this.db.close()
  }
}

export function validateGoalPolicyOverride(policy: GoalPolicyOverride): GoalPolicyOverride {
  return goalPolicyOverrideSchema.parse(policy)
}

export interface DatabaseRecoveryReport {
  backupDirectory: string
  skippedAuditRows: number
}

const RECOVERY_TABLES = [
  'goals',
  'goal_events',
  'usage_history',
  'settings',
  'goal_policy_overrides'
] as const

function copyIfPresent(source: string, destination: string): void {
  if (existsSync(source)) copyFileSync(source, destination)
}

function insertRecoveredRows(
  target: Database.Database,
  table: string,
  rows: Array<Record<string, unknown>>
): void {
  if (rows.length === 0) return
  const targetColumns = new Set(
    (target.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((item) => item.name)
  )
  const columns = Object.keys(rows[0]).filter((column) => targetColumns.has(column))
  const names = columns.map((column) => `"${column}"`).join(', ')
  const values = columns.map((column) => `@${column}`).join(', ')
  const insert = target.prepare(`INSERT OR REPLACE INTO ${table} (${names}) VALUES (${values})`)
  for (const row of rows) insert.run(Object.fromEntries(columns.map((column) => [column, row[column]])))
}

export function recoverControllerDatabaseIfNeeded(filename: string): DatabaseRecoveryReport | null {
  if (!existsSync(filename)) return null
  const source = new Database(filename, { readonly: true })
  try {
    let healthy = false
    try {
      const quick = source.pragma('quick_check') as Array<Record<string, string>>
      const integrity = source.pragma('integrity_check') as Array<Record<string, string>>
      healthy = quick.length === 1 && Object.values(quick[0])[0] === 'ok' &&
        integrity.length === 1 && Object.values(integrity[0])[0] === 'ok'
    } catch {
      // Continue only when all non-audit tables can be read in full.
    }
    if (healthy) return null

    const recovered = new Map<string, Array<Record<string, unknown>>>()
    for (const table of RECOVERY_TABLES) {
      try {
        recovered.set(table, source.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>)
      } catch (error) {
        throw new Error(`Database recovery stopped because core table ${table} is unreadable.`, { cause: error })
      }
    }

    let skippedAuditRows = 0
    try {
      const auditRows = source.prepare('SELECT * FROM controller_actions').all()
      throw new Error(`Database integrity failed outside the Audit Log; ${auditRows.length} audit rows are still readable.`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Database integrity failed outside')) throw error
      try {
        skippedAuditRows = (source.prepare('SELECT count(*) AS count FROM controller_actions').get() as { count: number }).count
      } catch {
        skippedAuditRows = 0
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDirectory = join(dirname(filename), 'backups', `audit-corrupt-${stamp}`)
    mkdirSync(backupDirectory, { recursive: true })
    copyIfPresent(filename, join(backupDirectory, basename(filename)))
    copyIfPresent(`${filename}-wal`, join(backupDirectory, `${basename(filename)}-wal`))
    copyIfPresent(`${filename}-shm`, join(backupDirectory, `${basename(filename)}-shm`))

    const recoveredFilename = `${filename}.recovered`
    rmSync(recoveredFilename, { force: true })
    rmSync(`${recoveredFilename}-wal`, { force: true })
    rmSync(`${recoveredFilename}-shm`, { force: true })
    const fresh = new GoalControllerDatabase(recoveredFilename)
    fresh.close()
    const target = new Database(recoveredFilename)
    try {
      target.pragma('foreign_keys = OFF')
      target.transaction(() => {
        for (const table of RECOVERY_TABLES) insertRecoveredRows(target, table, recovered.get(table) ?? [])
      })()
      target.pragma('foreign_keys = ON')
      const result = target.pragma('quick_check') as Array<Record<string, string>>
      if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') {
        throw new Error('Recovered database failed SQLite quick_check.')
      }
    } finally {
      target.close()
    }

    source.close()
    rmSync(filename, { force: true })
    rmSync(`${filename}-wal`, { force: true })
    rmSync(`${filename}-shm`, { force: true })
    renameSync(recoveredFilename, filename)
    return { backupDirectory, skippedAuditRows }
  } finally {
    if (source.open) source.close()
  }
}
