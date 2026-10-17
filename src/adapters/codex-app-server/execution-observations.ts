import type { ThreadExecutionState } from '../../shared/types'

export interface RpcNotification {
  method: string
  params: unknown
  connectionEpoch: number
  receivedAt: number
}

export interface TerminalTurnEvidence {
  threadId: string
  turnId: string
  status: 'completed' | 'interrupted' | 'failed'
  connectionEpoch: number
  observedAt: number
  source: 'turn/completed'
}

export interface ExecutionObservation extends ThreadExecutionState {
  threadId: string
  connectionEpoch: number
  observedAt: number
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

// Evidence is bounded and connection-scoped. This is not a durable control intent.
export class ExecutionObservations {
  private epoch = 0
  private connected = false
  private terminal = new Map<string, TerminalTurnEvidence>()
  private sessions = new Map<string, ExecutionObservation>()
  private listeners = new Set<() => void>()
  private listenerFailures = 0

  constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid evidence capacity.')
  }

  get connectionEpoch(): number { return this.epoch }
  get listenerFailureCount(): number { return this.listenerFailures }

  connectionChanged(epoch: number, connected: boolean): void {
    if (epoch < this.epoch) return
    if (epoch !== this.epoch || !connected) this.sessions.clear()
    this.epoch = epoch
    this.connected = connected
    this.changed()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { this.listenerFailures += 1 }
    }
  }

  observe(notification: RpcNotification): void {
    if (!this.connected || notification.connectionEpoch !== this.epoch) return
    if (notification.method !== 'turn/started' && notification.method !== 'turn/completed') return
    const params = object(notification.params)
    const turn = object(params?.turn)
    if (typeof params?.threadId !== 'string' || !params.threadId ||
        typeof turn?.id !== 'string' || !turn.id) return
    const threadId = params.threadId
    const turnId = turn.id
    const key = this.key(threadId, turnId, this.epoch)
    const previous = this.sessions.get(threadId)
    if (notification.method === 'turn/started') {
      if (turn.status !== 'inProgress' || this.terminal.has(key)) return
      this.remember(this.sessions, threadId, {
        threadId, connectionEpoch: this.epoch, observedAt: notification.receivedAt,
        runtimeStatus: 'active', activeTurnId: turnId, lastTurnId: turnId,
        lastTurnStatus: 'inProgress'
      })
    } else {
      const status = turn.status
      if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') return
      if (this.terminal.has(key)) return
      this.remember(this.terminal, key, {
        threadId, turnId, status, connectionEpoch: this.epoch,
        observedAt: notification.receivedAt, source: 'turn/completed'
      })
      // An earlier turn's completion must not make a newer running turn idle.
      if (!previous?.activeTurnId || previous.activeTurnId === turnId) {
        this.remember(this.sessions, threadId, {
          threadId, connectionEpoch: this.epoch, observedAt: notification.receivedAt,
          runtimeStatus: 'idle', activeTurnId: null, lastTurnId: turnId, lastTurnStatus: status
        })
      }
    }
    this.changed()
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key)
    map.set(key, value)
    if (map.size > this.capacity) map.delete(map.keys().next().value!)
  }

  private key(threadId: string, turnId: string, epoch: number): string {
    return JSON.stringify([epoch, threadId, turnId])
  }

  getSession(threadId: string): ExecutionObservation | null {
    const value = this.sessions.get(threadId)
    return value ? { ...value } : null
  }

  getTerminal(threadId: string, turnId: string, epoch = this.epoch): TerminalTurnEvidence | null {
    const value = this.terminal.get(this.key(threadId, turnId, epoch))
    return value ? { ...value } : null
  }

  waitForTerminal(threadId: string, turnId: string, epoch: number, timeoutMs = 30_000): Promise<TerminalTurnEvidence> {
    const known = this.getTerminal(threadId, turnId, epoch)
    if (known) return Promise.resolve(known)
    if (!this.connected || epoch !== this.epoch) return Promise.reject(new Error('Execution connection changed.'))
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Invalid observation timeout.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Terminal outcome unverified: ${threadId}/${turnId}`))
      }, timeoutMs)
      const unsubscribe = this.onChange(() => {
        const evidence = this.getTerminal(threadId, turnId, epoch)
        if (evidence) {
          clearTimeout(timer)
          unsubscribe()
          resolve(evidence)
        } else if (!this.connected || epoch !== this.epoch) {
          clearTimeout(timer)
          unsubscribe()
          reject(new Error('Execution connection changed before terminal verification.'))
        }
      })
    })
  }
}
