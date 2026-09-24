import { CodexAppServerAdapter } from '../src/adapters/codex-app-server/codex-adapter'

async function main(): Promise<void> {
  const adapter = new CodexAppServerAdapter()
  try {
    await adapter.refreshConnection()
    const [usage, goals, version] = await Promise.all([
      adapter.getUsage(),
      adapter.listGoals(),
      adapter.getVersion()
    ])
    console.log(JSON.stringify({
      ok: true,
      version,
      usage: {
        fiveHourUsedPercent: usage.fiveHour.usedPercent,
        weeklyUsedPercent: usage.weekly.usedPercent,
        measuredAt: usage.measuredAt
      },
      windows: {
        fiveHourMins: usage.fiveHour.windowDurationMins,
        weeklyMins: usage.weekly.windowDurationMins
      },
      goalCount: goals.length,
      writesAttempted: false
    }, null, 2))
  } finally {
    await adapter.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
