import type { ControllerSettings, GoalRecord, UsageInfo } from '../../shared/types'
import { effectiveGoalPolicy, evaluatePolicies, evaluateWindowPolicy } from './policy-engine'

export type StartIntent = 'manual' | 'automatic'
export class StartDeniedError extends Error {
  constructor(message: string, readonly reason: string) { super(message); this.name = 'StartDeniedError' }
}

export function validateStartUsage(usage: UsageInfo | null | undefined, now: number): asserts usage is UsageInfo {
  if (!Number.isFinite(now) || !usage || !Number.isFinite(usage.measuredAt) || usage.measuredAt > now + 1 || now - usage.measuredAt > 10 ||
      !usage.fiveHour || !usage.weekly || usage.fiveHour.windowDurationMins !== 300 || usage.weekly.windowDurationMins !== 10_080 ||
      [usage.fiveHour.usedPercent, usage.weekly.usedPercent].some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new StartDeniedError('Başlatılmadı: güncel ve geçerli iki kota ölçümü alınamadı.', 'usage_unavailable')
  }
}

export function occupiesExecutionSlot(goal: GoalRecord): boolean {
  return goal.remoteStatus === 'active' || goal.runtimeStatus === 'active' || goal.sessionControlStatus === 'running' ||
    (goal.lastTurnStatus === 'inProgress' && goal.sessionControlStatus !== 'idle' && goal.sessionControlStatus !== 'interrupted')
}

export function assertStartPermission(
  goal: GoalRecord | undefined,
  goals: GoalRecord[],
  usage: UsageInfo,
  settings: ControllerSettings,
  intent: StartIntent,
  now: number,
  reservedGoalIds: ReadonlySet<string> = new Set()
): string {
  validateStartUsage(usage, now)
  if (!goal || (goal.remoteStatus !== 'paused' && goal.remoteStatus !== 'active')) {
    throw new StartDeniedError('Başlatılmadı: güncel Goal bulunamadı veya durumu başlatmaya uygun değil.', 'remote_status')
  }
  if (intent === 'automatic') {
    if (!settings.automaticControl) throw new StartDeniedError('Otomatik kontrol kapalı; yeni çalışma başlatılmadı.', 'automatic_disabled')
    if (goal.excluded || !goal.controllerManaged || goal.controllerStatus === 'paused_manual') {
      throw new StartDeniedError('Başlatılmadı: Goal hariç, manuel duraklatılmış veya controller sahipliğinde değil.', 'ownership')
    }
    if (goal.remoteStatus === 'paused' && goal.controllerStatus !== 'paused_quota' && goal.controllerStatus !== 'paused_priority' && goal.controllerStatus !== 'paused_direct') {
      throw new StartDeniedError('Başlatılmadı: bu duraklatma controller tarafından yapılmadı.', 'ownership')
    }
  }
  if (goal.cooldownUntil !== null && goal.cooldownUntil > now) {
    throw new StartDeniedError(`Başlatılmadı: cooldown için ${Math.ceil(goal.cooldownUntil - now)} saniye kaldı.`, 'cooldown')
  }
  const policy = effectiveGoalPolicy(goal, settings)
  for (const [label, window, rule] of [
    ['5 saatlik', usage.fiveHour, policy.fiveHourPolicy],
    ['Haftalık', usage.weekly, policy.weeklyPolicy]
  ] as const) {
    const decision = evaluateWindowPolicy(window, rule, now)
    if (decision.blocked) throw new StartDeniedError(
      `Başlatılmadı: ${label} kalan %${decision.remainingPercent.toFixed(1)}, durdurma sınırı %${rule.stopRemainingPercent}${decision.remainingPercent <= 0 ? '; kota tükenmiş' : ''}.`, 'quota'
    )
  }
  if (!Number.isInteger(settings.maxRunningGoals) || settings.maxRunningGoals < 1) {
    throw new StartDeniedError('Başlatılmadı: çalışma sayısı sınırı geçersiz.', 'capacity')
  }
  const occupied = new Set(reservedGoalIds)
  for (const item of goals) if (occupiesExecutionSlot(item)) occupied.add(item.id)
  occupied.delete(goal.id)
  if (occupied.size >= settings.maxRunningGoals) {
    throw new StartDeniedError('Başlatılmadı: çalışan veya sonucu belirsiz işler maksimum çalışma sayısını dolduruyor.', 'capacity')
  }
  if (intent === 'automatic' && !evaluatePolicies(goals, usage, settings, now).allowedGoalIds.includes(goal.id)) {
    throw new StartDeniedError('Başlatılmadı: öncelik sıralamasında bu Goal için çalışma yeri yok.', 'priority')
  }
  const five = evaluateWindowPolicy(usage.fiveHour, policy.fiveHourPolicy, now)
  const weekly = evaluateWindowPolicy(usage.weekly, policy.weeklyPolicy, now)
  return `Kota ölçümü ${usage.measuredAt}; 5 saatlik kalan %${five.remainingPercent.toFixed(1)} (sınır %${policy.fiveHourPolicy.stopRemainingPercent}, son-dakika ${five.finalWindowActive ? 'açık' : 'kapalı'}); haftalık kalan %${weekly.remainingPercent.toFixed(1)} (sınır %${policy.weeklyPolicy.stopRemainingPercent}, son-dakika ${weekly.finalWindowActive ? 'açık' : 'kapalı'}).`
}
