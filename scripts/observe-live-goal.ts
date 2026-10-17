// Read-only witness for a user-authorized live Controller test. Never mutates RPC state.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { AppServerRpcClient } from '../src/adapters/codex-app-server/rpc-client'

async function main(): Promise<void> {
  const [threadId, output, secondsText = '0'] = process.argv.slice(2)
  if (!threadId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Explicit thread UUID required')
  const seconds = Number(secondsText)
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 180) throw new Error('Observation duration must be 0..180 seconds')
  const file = output ? resolve(output) : null
  if (file) mkdirSync(dirname(file), { recursive: true })
  const write = (value: object): void => {
    const line = JSON.stringify({ at: new Date().toISOString(), threadId, ...value })
    if (file) appendFileSync(file, line + '\n', 'utf8')
    console.log(line)
  }
  const rpc = new AppServerRpcClient()
  const unsubscribe = rpc.onNotification(event => {
    if (!['thread/goal/updated', 'thread/status/changed', 'turn/started', 'turn/completed'].includes(event.method)) return
    const params = event.params as { threadId?: string; turn?: { id?: string; status?: string }; status?: unknown }
    if (params?.threadId !== threadId) return
    write({ kind: 'notification', method: event.method, turnId: params.turn?.id, turnStatus: params.turn?.status, status: params.status })
  })
  async function snapshot(label: string): Promise<void> {
    const goal = await rpc.request<{ goal: { status?: string; tokensUsed?: number } | null }>('thread/goal/get', { threadId })
    const result = await rpc.request<{ thread: { id: string; status?: { type?: string }; turns?: Array<{ id: string; status: string; items?: Array<{ type: string; text?: string }> }> } }>('thread/read', { threadId, includeTurns: true })
    const loaded = await rpc.request<{ data: string[] }>('thread/loaded/list', { limit: 100 })
    write({ kind: 'snapshot', label, goal: goal.goal ? { status: goal.goal.status, tokensUsed: goal.goal.tokensUsed } : null, runtime: result.thread.status, loaded: loaded.data.includes(threadId), turns: result.thread.turns?.slice(-3).map(t => ({ id: t.id, status: t.status })) })
  }
  try {
    await rpc.connect()
    await snapshot('before')
    if (seconds) {
      write({ kind: 'watching', seconds })
      await new Promise(resolve => setTimeout(resolve, seconds * 1000))
      await snapshot('after')
    }
  } finally {
    unsubscribe()
    await rpc.close()
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
