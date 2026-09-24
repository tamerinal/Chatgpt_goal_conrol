import { CodexAppServerAdapter } from '../src/adapters/codex-app-server/codex-adapter'

async function main(): Promise<void> {
  const adapter = new CodexAppServerAdapter()
  const readings: Array<{ cycle: number; fiveHour: number; weekly: number }> = []
  try {
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      await adapter.refreshConnection()
      const usage = await adapter.getUsage()
      readings.push({
        cycle,
        fiveHour: usage.fiveHour.usedPercent,
        weekly: usage.weekly.usedPercent
      })
    }
    console.log(JSON.stringify({ ok: true, cycles: readings, writesAttempted: false }, null, 2))
  } finally {
    await adapter.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
