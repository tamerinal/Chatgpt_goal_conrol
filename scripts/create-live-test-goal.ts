import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppServerRpcClient } from '../src/adapters/codex-app-server/rpc-client'

async function main(): Promise<void> {
  const [mode, receiptArg] = process.argv.slice(2)
  if (!receiptArg || !['--create-paused-fixture', '--seed-one-turn'].includes(mode)) throw new Error('Explicit fixture operation and receipt path required')
  const receiptPath = resolve(receiptArg)
  const rpc = new AppServerRpcClient()
  try {
    await rpc.connect()
    if (mode === '--create-paused-fixture') {
      const cwd = mkdtempSync(join(tmpdir(), 'goal-controller-live-fixture-'))
      const result = await rpc.request<{ thread: { id: string } }>('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' })
      const receipt = { threadId: result.thread.id, cwd, createdAt: new Date().toISOString(), purpose: 'user-authorized independent Goal Controller stop/start fixture' }
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' })
      await rpc.request('thread/goal/set', { threadId: receipt.threadId, objective: 'CONTROLLER SMOKE TEST — temporary independent test Goal. Never touch repositories, accounts, network or other Goals. Only follow the bounded diagnostic input in this test chat. No self-restart or automation.', status: 'paused' })
      console.log(JSON.stringify({ ...receipt, goalStatus: 'paused', modelTurnsStarted: 0 }))
    } else {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { threadId: string }
      const state = await rpc.request<{ thread: { status?: { type: string }; turns?: unknown[] } }>('thread/read', { threadId: receipt.threadId, includeTurns: true })
      if (state.thread.status?.type === 'active' || state.thread.turns?.length) throw new Error('Fixture already has a turn; never seed twice')
      const turn = await rpc.request<{ turn: { id: string; status: string } }>('turn/start', {
        threadId: receipt.threadId,
        input: [{ type: 'text', text: 'This is a bounded stop-control smoke test. Do not read or modify files, use network, create tasks, or touch any other Goal. Run exactly one harmless shell command: powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90". After it finishes, reply TEST_WAIT_FINISHED. Do not retry or create any continuation yourself. The operator will interrupt this turn to test Goal Controller.' }]
      })
      console.log(JSON.stringify({ threadId: receipt.threadId, source: 'explicit fixture setup, NOT Controller resume', turn: turn.turn }))
    }
  } finally { await rpc.close() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
