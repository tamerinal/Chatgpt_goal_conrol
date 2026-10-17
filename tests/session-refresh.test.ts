import { describe, expect, it } from 'vitest'
import { GoalControllerDatabase } from '../src/persistence/database'
import type { RemoteGoal } from '../src/shared/types'

const remote: RemoteGoal = {
  id: 'target', name: 'test', objective: 'test', remoteStatus: 'active', runtimeStatus: 'active',
  createdAt: 1, lastActivityAt: 1, tokensUsed: 1, tokenBudget: null,
  lastTurnId: 'turn', lastTurnStatus: 'inProgress'
}

describe('fresh shared-server session observations', () => {
  it('removes a stale running flag once the same session is observed idle', () => {
    const db = new GoalControllerDatabase(':memory:')
    try {
      db.upsertGoals([remote], 1)
      db.markGoalResumed('target', 1)
      db.markSessionControlStatus('target', 'running')
      db.upsertGoals([{ ...remote, runtimeStatus: 'idle', lastTurnStatus: 'completed' }], 2)
      expect(db.getGoals()[0]).toMatchObject({ sessionControlStatus: 'idle', controllerManaged: true, excluded: false })
    } finally { db.close() }
  })
  it('does not infer running from unloaded historical turns or discard a writer conflict', () => {
    const db = new GoalControllerDatabase(':memory:')
    try {
      db.upsertGoals([remote], 1)
      db.markSessionControlStatus('target', 'running')
      db.upsertGoals([{ ...remote, runtimeStatus: 'notLoaded' }], 2)
      expect(db.getGoals()[0].sessionControlStatus).toBe('unknown')
      db.markSessionControlStatus('target', 'writerConflict')
      db.upsertGoals([{ ...remote, runtimeStatus: 'notLoaded' }], 3)
      expect(db.getGoals()[0].sessionControlStatus).toBe('writerConflict')
      expect(db.getGoals()[0].excluded).toBe(true)
    } finally { db.close() }
  })
})
