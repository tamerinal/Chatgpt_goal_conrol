import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { AppServerRpcClient } from '../src/adapters/codex-app-server/rpc-client'
import { WebSocketTransport } from '../src/adapters/codex-app-server/websocket-transport'
import { resolveCodexExecutable } from '../src/adapters/codex-app-server/executable'

// Manual integration check, never part of npm test. Empty CODEX_HOME, no auth
// copied, no model turns or approvals. Only an empty synthetic thread is made.
async function main(): Promise<void> {
  if (process.argv[2] !== '--isolated-transport-check') throw new Error('Explicit isolated check flag required')
  const directory = mkdtempSync(join(tmpdir(), 'goal-controller-shared-'))
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('No test port'))
      server.close(() => resolve(address.port))
    })
  })
  const url = `ws://127.0.0.1:${port}`
  const child = spawn(resolveCodexExecutable(), ['app-server', '--listen', url], {
    cwd: directory, env: { ...process.env, CODEX_HOME: directory, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let startupError: Error | undefined
  child.on('error', (error) => { startupError = error })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000) })
  const clients = [0, 1].map(() => new AppServerRpcClient(() => new WebSocketTransport(new WebSocket(url))))
  try {
    const deadline = Date.now() + 20_000
    let ready = false
    while (Date.now() < deadline) {
      if (startupError) throw startupError
      if (child.exitCode !== null) throw new Error(`Isolated engine exited: ${stderr}`)
      try { ready = (await fetch(url.replace('ws:', 'http:') + '/readyz', { signal: AbortSignal.timeout(500) })).ok } catch { }
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error(`Isolated engine readiness timeout: ${stderr}`)
    await Promise.all(clients.map(client => client.connect()))
    const created = await clients[0].request<{ thread: { id: string } }>('thread/start', {
      cwd: directory, approvalPolicy: 'never', sandbox: 'read-only'
    })
    const first = await clients[0].request<{ data: string[] }>('thread/loaded/list', {})
    const second = await clients[1].request<{ data: string[] }>('thread/loaded/list', {})
    const read = await clients[1].request<{ thread: { id: string; status: { type: string } } }>('thread/read', { threadId: created.thread.id, includeTurns: false })
    let ownerSawGoalUpdate = false
    clients[0].onNotification(event => {
      const params = event.params as { threadId?: string; goal?: { status?: string } } | undefined
      if (event.method === 'thread/goal/updated' && params?.threadId === created.thread.id && params.goal?.status === 'active') ownerSawGoalUpdate = true
    })
    await clients[0].request('thread/goal/set', { threadId: created.thread.id, objective: 'Isolated transport test; no model turns', status: 'paused' })
    await clients[1].request('thread/goal/set', { threadId: created.thread.id, status: 'active' })
    const goal = await clients[0].request<{ goal: { status: string } }>('thread/goal/get', { threadId: created.thread.id })
    await new Promise(resolve => setTimeout(resolve, 100))
    await clients[1].request('thread/goal/set', { threadId: created.thread.id, status: 'paused' })
    const report = { isolatedDirectory: directory, threadId: created.thread.id,
      firstLoaded: first.data.includes(created.thread.id), secondLoaded: second.data.includes(created.thread.id),
      sameThreadRead: read.thread.id === created.thread.id, status: read.thread.status.type,
      crossClientGoalRead: goal.goal.status === 'active', ownerSawGoalUpdate, modelTurnsStarted: 0 }
    writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    if (!report.firstLoaded || !report.secondLoaded || !report.sameThreadRead || !report.crossClientGoalRead || !report.ownerSawGoalUpdate) throw new Error('Shared thread/Goal visibility failed')
  } finally {
    await Promise.all(clients.map(client => client.close()))
    child.kill()
  }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1 })
