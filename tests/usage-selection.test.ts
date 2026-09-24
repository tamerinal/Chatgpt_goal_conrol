import { describe, expect, it } from 'vitest'
import { selectUsageWindows } from '../src/adapters/codex-app-server/codex-adapter'

describe('usage window selection', () => {
  it('selects windows by duration instead of position', () => {
    const result = selectUsageWindows(
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 300 },
            secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 200 }
          }
        }
      },
      100
    )
    expect(result.fiveHour.usedPercent).toBe(10)
    expect(result.weekly.usedPercent).toBe(20)
  })

  it('fails closed when either required window is missing', () => {
    expect(() => selectUsageWindows({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300 } }
    })).toThrow(/both 5-hour and weekly/)
  })

  it('rejects malformed usage percentages', () => {
    expect(() => selectUsageWindows({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 101, windowDurationMins: 300 },
        secondary: { usedPercent: 10, windowDurationMins: 10_080 }
      }
    })).toThrow()
  })
})
