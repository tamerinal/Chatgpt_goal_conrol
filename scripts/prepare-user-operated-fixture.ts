// Explicit live setup only. Never called by npm test; row start/stop belongs to the user.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppServerRpcClient } from '../src/adapters/codex-app-server/rpc-client'

async function main(): Promise<void> {
  const [flag, receiptArg, budgetText = '100000'] = process.argv.slice(2)
  if (flag !== '--prepare-user-operated-test' || !receiptArg) throw new Error('Explicit live preparation flag and new receipt path required')
  const tokenBudget = Number(budgetText)
  if (!Number.isInteger(tokenBudget) || tokenBudget < 100000 || tokenBudget > 200000) throw new Error('Manual test budget must be 100000..200000 tokens')
  const receiptPath = resolve(receiptArg)
  if (existsSync(receiptPath)) throw new Error('Receipt already exists; do not create or seed a second fixture blindly')
  const rpc = new AppServerRpcClient()
  const receipt: Record<string, unknown> = { purpose: 'user-operated independent manual Start/Stop acceptance test', tokenBudget, createdAt: new Date().toISOString() }
  const save = (): void => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8')
  // Claim this invocation before any remote mutation; an uncertain dispatch is never retried automatically.
  writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx' })
  try {
    await rpc.connect()
    const cwd = mkdtempSync(join(tmpdir(), 'goal-controller-manual-test-'))
    receipt.cwd = cwd
    receipt.threadCreateDispatchedAt = new Date().toISOString()
    save()
    const created = await rpc.request<{ thread: { id: string } }>('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' })
    const threadId = created.thread.id
    receipt.threadId = threadId
    save()
    const objective = 'MANUEL START STOP TEST 2 — User-operated Controller test, isolated from real work. ' +
      'Initial setup input: only reply HAZIR, no tools, leave this Goal paused. ' +
      'On later active Goal continuation, perform exactly one harmless 90-second shell wait per turn (PowerShell Start-Sleep -Seconds 90), then report BEKLEME_TAMAM. ' +
      'The operator will pause/interrupt and resume through Controller; interruption is expected and each later explicit activation authorizes a fresh wait attempt. ' +
      'Do not mark blocked because the operator interrupted a previous attempt. Do not start, pause, complete or change any Goal yourself. ' +
      'No file reads or writes, repository access, network, account changes, background jobs, scheduled tasks or other sessions. ' +
      'Use native Goal continuation only; never create a self-restart. This diagnostic ends after 20 completed waits or when the operator stops it.'
    await rpc.request('thread/goal/set', { threadId, objective, status: 'paused', tokenBudget })
    receipt.goalCreatedPaused = true
    receipt.preparationDispatchedAt = new Date().toISOString()
    save()
    const started = await rpc.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'MANUEL START STOP TEST 2\nBu yalnız hazırlık turudur. Sadece HAZIR yaz ve bu turu bitir; araç kullanma, Goal durumunu değiştirme. Başlat ve Durdur düğmelerine operatör daha sonra basacak. Goal daha sonra active olursa objective içindeki zararsız bekleme denemesini uygula.' }]
    })
    receipt.preparationTurnId = started.turn.id
    save()
    const deadline = Date.now() + 60_000
    do {
      const read = await rpc.request<{ thread: { status?: { type: string }; turns?: Array<{ id: string; status: string }> } }>('thread/read', { threadId, includeTurns: true })
      const goal = await rpc.request<{ goal: { status: string; tokenBudget: number | null } | null }>('thread/goal/get', { threadId })
      const turn = read.thread.turns?.find(item => item.id === started.turn.id)
      receipt.observed = { at: new Date().toISOString(), goalStatus: goal.goal?.status, tokenBudget: goal.goal?.tokenBudget, runtimeStatus: read.thread.status?.type, preparationTurnStatus: turn?.status }
      save()
      if (turn && turn.status !== 'inProgress') {
        if (turn.status !== 'completed' || goal.goal?.status !== 'paused' || goal.goal.tokenBudget !== tokenBudget || read.thread.status?.type !== 'idle') throw new Error('Preparation did not reach paused Goal / idle session / completed setup turn / expected budget')
        receipt.readyForUser = true
        save()
        console.log(JSON.stringify(receipt))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    } while (Date.now() < deadline)
    throw new Error('Preparation outcome still pending; inspect receipt and same turn, do not resend')
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error)
    save()
    throw error
  } finally { await rpc.close() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
