import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { GoalControllerDatabase, recoverControllerDatabaseIfNeeded } from '../src/persistence/database'

describe('Audit Log database recovery', () => {
  it('backs up a corrupt database and preserves all healthy controller data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-controller-recovery-'))
    const filename = join(directory, 'goal-controller.db')
    try {
      const database = new GoalControllerDatabase(filename)
      database.upsertGoals([{
        id: 'goal-1',
        name: 'Recover me',
        objective: 'test',
        remoteStatus: 'paused',
        runtimeStatus: 'notLoaded',
        createdAt: 1,
        lastActivityAt: 2,
        tokensUsed: 3,
        tokenBudget: null,
        lastTurnId: 'turn-1',
        lastTurnStatus: 'interrupted'
      }], 10)
      database.updatePriority('goal-1', 77)
      database.recordSystemEvent('test_audit', 'info', 'will be unreadable', 11)
      database.close()

      const raw = new Database(filename)
      raw.pragma('wal_checkpoint(TRUNCATE)')
      const pageSize = raw.pragma('page_size', { simple: true }) as number
      const rootPage = (raw.prepare(
        "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'controller_actions'"
      ).get() as { rootpage: number }).rootpage
      raw.close()

      const handle = openSync(filename, 'r+')
      writeSync(handle, Buffer.alloc(128), 0, 128, (rootPage - 1) * pageSize)
      closeSync(handle)

      const report = recoverControllerDatabaseIfNeeded(filename)
      expect(report).not.toBeNull()
      expect(existsSync(join(report!.backupDirectory, 'goal-controller.db'))).toBe(true)

      const recovered = new GoalControllerDatabase(filename)
      expect(recovered.getGoals()[0]).toMatchObject({
        id: 'goal-1',
        priority: 77,
        lastTurnId: 'turn-1',
        lastTurnStatus: 'interrupted'
      })
      expect(recovered.getAudit()).toEqual([])
      recovered.close()
      const verified = new Database(filename, { readonly: true })
      expect(verified.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
      verified.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
