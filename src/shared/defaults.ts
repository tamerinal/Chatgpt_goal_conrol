import type { ControllerSettings } from './types'

export const DEFAULT_SETTINGS: ControllerSettings = {
  pollIntervalSeconds: 60,
  automaticControl: true,
  launchAtLogin: true,
  maxRunningGoals: 2,
  cooldownSeconds: 120,
  fiveHourPolicy: {
    stopRemainingPercent: 10,
    useFullQuotaNearReset: true,
    finalWindowMinutes: 30
  },
  weeklyPolicy: {
    stopRemainingPercent: 10,
    useFullQuotaNearReset: true,
    finalWindowMinutes: 30
  },
  executionPolicy: {
    interruptActiveTurnOnPause: true,
    continueTurnOnResume: true
  }
}
