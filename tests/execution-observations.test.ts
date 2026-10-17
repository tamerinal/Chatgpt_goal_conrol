import { describe, expect, it } from 'vitest'
import { ExecutionObservations } from '../src/adapters/codex-app-server/execution-observations'

function event(method: string, threadId = 'thread-A', turnId = 'turn-A', status = 'interrupted', connectionEpoch = 1) {
  return { method, params: { threadId, turn: { id: turnId, status } }, connectionEpoch, receivedAt: 100 }
}

function setup(capacity = 512) {
  const observations = new ExecutionObservations(capacity)
  observations.connectionChanged(1, true)
  return observations
}

describe('ExecutionObservations terminal evidence', () => {
  it('buffers a terminal event arriving before the waiter is created', async () => {
    const observations = setup()
    observations.observe(event('turn/completed'))
    await expect(observations.waitForTerminal('thread-A', 'turn-A', 1)).resolves.toMatchObject({ status: 'interrupted', source: 'turn/completed' })
  })

  it('requires both thread and turn to match', async () => {
    const observations = setup()
    const pending = observations.waitForTerminal('thread-A', 'turn-A', 1)
    observations.observe(event('turn/completed', 'other-thread'))
    observations.observe(event('turn/completed', 'thread-A', 'other-turn'))
    expect(observations.getTerminal('thread-A', 'turn-A')).toBeNull()
    observations.observe(event('turn/completed'))
    await expect(pending).resolves.toMatchObject({ threadId: 'thread-A', turnId: 'turn-A' })
  })

  it('does not accept item completion as terminal turn evidence', async () => {
    const observations = setup()
    observations.observe(event('item/completed'))
    observations.observe(event('turn/completed', 'thread-A', 'turn-A', 'inProgress'))
    observations.observe({ method: 'turn/completed', params: { turn: { id: 'turn-A', status: 'completed' } }, connectionEpoch: 1, receivedAt: 100 })
    expect(observations.getTerminal('thread-A', 'turn-A')).toBeNull()
    await expect(observations.waitForTerminal('thread-A', 'turn-A', 1, 5)).rejects.toThrow(/unverified/)
  })

  it('invalidates live observations and waiters on disconnect', async () => {
    const observations = setup()
    observations.observe(event('turn/started', 'thread-A', 'turn-A', 'inProgress'))
    const pending = observations.waitForTerminal('thread-A', 'turn-A', 1)
    const rejected = expect(pending).rejects.toThrow(/connection changed/)
    observations.connectionChanged(1, false)
    expect(observations.getSession('thread-A')).toBeNull()
    await rejected
  })

  it('does not reuse old-epoch evidence or accept delayed old-epoch events', () => {
    const observations = setup()
    observations.observe(event('turn/completed'))
    observations.connectionChanged(2, true)
    observations.observe(event('turn/started', 'thread-A', 'turn-A', 'inProgress', 1))
    expect(observations.getSession('thread-A')).toBeNull()
    expect(observations.getTerminal('thread-A', 'turn-A', 2)).toBeNull()
    expect(observations.getTerminal('thread-A', 'turn-A', 1)?.status).toBe('interrupted')
  })

  it('does not let an older turn completion hide a newer running turn', () => {
    const observations = setup()
    observations.observe(event('turn/started', 'thread-A', 'turn-new', 'inProgress'))
    observations.observe(event('turn/completed', 'thread-A', 'turn-old', 'completed'))
    expect(observations.getSession('thread-A')).toMatchObject({ activeTurnId: 'turn-new', runtimeStatus: 'active' })
    expect(observations.getTerminal('thread-A', 'turn-old')?.status).toBe('completed')
  })

  it('keeps terminal evidence stable when a duplicate or delayed start arrives', () => {
    const observations = setup()
    observations.observe(event('turn/completed'))
    observations.observe(event('turn/started', 'thread-A', 'turn-A', 'inProgress'))
    observations.observe(event('turn/completed', 'thread-A', 'turn-A', 'completed'))
    expect(observations.getTerminal('thread-A', 'turn-A')?.status).toBe('interrupted')
    expect(observations.getSession('thread-A')?.activeTurnId).toBeNull()
  })

  it('retains a bounded terminal history and rejects invalid wait budgets', async () => {
    const observations = setup(2)
    for (const id of ['a', 'b', 'c']) observations.observe(event('turn/completed', 'thread-A', id))
    expect(observations.getTerminal('thread-A', 'a')).toBeNull()
    expect(observations.getTerminal('thread-A', 'c')).not.toBeNull()
    await expect(observations.waitForTerminal('thread-A', 'missing', 1, 0)).rejects.toThrow(/Invalid/)
  })

  it('uses events to record failed termination without treating it as successful work', () => {
    const observations = setup()
    observations.observe(event('turn/completed', 'thread-A', 'turn-A', 'failed'))
    expect(observations.getSession('thread-A')).toMatchObject({ activeTurnId: null, lastTurnStatus: 'failed' })
  })
})
