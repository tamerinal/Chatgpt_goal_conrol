import { useState, type FormEvent } from 'react'
import type {
  ControllerSettings,
  ExecutionPolicy,
  GoalPolicyOverride,
  GoalRecord,
  QuotaWindowPolicy,
  UpdateSettingsInput
} from '../../shared/types'

export type SettingsTarget =
  | { mode: 'global'; settings: ControllerSettings }
  | { mode: 'goal'; settings: ControllerSettings; goal: GoalRecord }

interface Draft {
  pollIntervalSeconds: 30 | 60 | 120 | 300
  automaticControl: boolean
  launchAtLogin: boolean
  maxRunningGoals: number
  cooldownSeconds: number
  fiveHourPolicy: QuotaWindowPolicy
  weeklyPolicy: QuotaWindowPolicy
  executionPolicy: ExecutionPolicy
}

function initialDraft(target: SettingsTarget): Draft {
  const override = target.mode === 'goal' ? target.goal.policyOverride : null
  return {
    pollIntervalSeconds: target.settings.pollIntervalSeconds,
    automaticControl: target.settings.automaticControl,
    launchAtLogin: target.settings.launchAtLogin,
    maxRunningGoals: target.settings.maxRunningGoals,
    cooldownSeconds: override?.cooldownSeconds ?? target.settings.cooldownSeconds,
    fiveHourPolicy: structuredClone(override?.fiveHourPolicy ?? target.settings.fiveHourPolicy),
    weeklyPolicy: structuredClone(override?.weeklyPolicy ?? target.settings.weeklyPolicy),
    executionPolicy: structuredClone(override?.executionPolicy ?? target.settings.executionPolicy)
  }
}

function WindowPolicyFields({
  title,
  policy,
  maxMinutes,
  disabled,
  onChange
}: {
  title: string
  policy: QuotaWindowPolicy
  maxMinutes: number
  disabled: boolean
  onChange: (policy: QuotaWindowPolicy) => void
}) {
  return (
    <fieldset className="quota-policy" disabled={disabled}>
      <legend>{title}</legend>
      <label className="field">
        <span>Kalan yüzdeye gelince durdur<small className="field-hint">%{100 - policy.stopRemainingPercent} kullanıldığında durur</small></span>
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          value={policy.stopRemainingPercent}
          onChange={(event) => onChange({ ...policy, stopRemainingPercent: Number(event.target.value) })}
        />
      </label>
      <label className="switch-row quota-switch">
        <span><strong>Resetten önce kotayı tamamen kullan</strong><small>Son dakika penceresinde rezervi kaldırır</small></span>
        <input
          type="checkbox"
          checked={policy.useFullQuotaNearReset}
          onChange={(event) => onChange({ ...policy, useFullQuotaNearReset: event.target.checked })}
        />
      </label>
      <label className="field">
        <span>Son dakika</span>
        <input
          type="number"
          min="0"
          max={maxMinutes}
          step="1"
          disabled={disabled || !policy.useFullQuotaNearReset}
          value={policy.finalWindowMinutes}
          onChange={(event) => onChange({ ...policy, finalWindowMinutes: Number(event.target.value) })}
        />
      </label>
    </fieldset>
  )
}

export function SettingsDialog({
  target,
  busy,
  onClose,
  onSaveGlobal,
  onSaveGoal
}: {
  target: SettingsTarget
  busy: boolean
  onClose: () => void
  onSaveGlobal: (settings: UpdateSettingsInput) => Promise<boolean>
  onSaveGoal: (goalId: string, policy: GoalPolicyOverride | null) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(() => initialDraft(target))
  const [usesGeneral, setUsesGeneral] = useState(
    target.mode === 'goal' && target.goal.policyOverride === null
  )

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const saved = target.mode === 'global'
      ? await onSaveGlobal(draft)
      : await onSaveGoal(
          target.goal.id,
          usesGeneral
            ? null
            : {
                cooldownSeconds: draft.cooldownSeconds,
                fiveHourPolicy: draft.fiveHourPolicy,
                weeklyPolicy: draft.weeklyPolicy,
                executionPolicy: draft.executionPolicy
              }
        )
    if (saved) onClose()
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-heading">
          <div>
            <h2 id="settings-title">{target.mode === 'global' ? 'Genel Ayarlar' : `${target.goal.name} · Ayarlar`}</h2>
            <p>{target.mode === 'global' ? 'Bütün Goal’ların varsayılan politikası' : 'Bu Goal için özel politika'}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Kapat" onClick={onClose}>×</button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {target.mode === 'goal' && (
            <label className="inherit-control">
              <input type="checkbox" checked={usesGeneral} onChange={(event) => setUsesGeneral(event.target.checked)} />
              <span><strong>Genel ayarları kullan</strong><small>Açıkken bu Goal genel değerleri devralır</small></span>
            </label>
          )}

          {target.mode === 'global' && (
            <div className="global-fields">
              <label className="field">
                <span>Kontrol aralığı</span>
                <select value={draft.pollIntervalSeconds} onChange={(event) => setDraft({ ...draft, pollIntervalSeconds: Number(event.target.value) as Draft['pollIntervalSeconds'] })}>
                  <option value="30">30 saniye</option><option value="60">60 saniye</option>
                  <option value="120">120 saniye</option><option value="300">300 saniye</option>
                </select>
              </label>
              <label className="field">
                <span>Maksimum çalışan Goal</span>
                <input type="number" min="1" max="100" value={draft.maxRunningGoals} onChange={(event) => setDraft({ ...draft, maxRunningGoals: Number(event.target.value) })} />
              </label>
              <label className="switch-row">
                <span><strong>Otomatik değerlendirme</strong><small>Kapatıldığında yalnız izler</small></span>
                <input type="checkbox" checked={draft.automaticControl} onChange={(event) => setDraft({ ...draft, automaticControl: event.target.checked })} />
              </label>
              <label className="switch-row">
                <span><strong>Windows ile başlat</strong><small>Paketlenmiş uygulamada etkinleşir</small></span>
                <input type="checkbox" checked={draft.launchAtLogin} onChange={(event) => setDraft({ ...draft, launchAtLogin: event.target.checked })} />
              </label>
            </div>
          )}

          <div className="quota-grid">
            <WindowPolicyFields
              title="5 Saatlik Kota"
              policy={draft.fiveHourPolicy}
              maxMinutes={300}
              disabled={usesGeneral}
              onChange={(fiveHourPolicy) => setDraft({ ...draft, fiveHourPolicy })}
            />
            <WindowPolicyFields
              title="Haftalık Kota"
              policy={draft.weeklyPolicy}
              maxMinutes={10_080}
              disabled={usesGeneral}
              onChange={(weeklyPolicy) => setDraft({ ...draft, weeklyPolicy })}
            />
          </div>

          <label className="field cooldown-field">
            <span>Cooldown (saniye)</span>
            <input
              type="number"
              min="0"
              max="86400"
              disabled={usesGeneral}
              value={draft.cooldownSeconds}
              onChange={(event) => setDraft({ ...draft, cooldownSeconds: Number(event.target.value) })}
            />
          </label>

          <fieldset className="execution-policy" disabled={usesGeneral}>
            <legend>Session Kontrolü</legend>
            <label className="switch-row">
              <span><strong>Goal durunca aktif çalışmayı da kes</strong><small>Aktif turn’e interrupt gönderir</small></span>
              <input
                type="checkbox"
                checked={draft.executionPolicy.interruptActiveTurnOnPause}
                onChange={(event) => setDraft({ ...draft, executionPolicy: { ...draft.executionPolicy, interruptActiveTurnOnPause: event.target.checked } })}
              />
            </label>
            <label className="switch-row">
              <span><strong>Goal başlayınca session’a Continue gönder</strong><small>Aynı thread’de yeni turn başlatır</small></span>
              <input
                type="checkbox"
                checked={draft.executionPolicy.continueTurnOnResume}
                onChange={(event) => setDraft({ ...draft, executionPolicy: { ...draft.executionPolicy, continueTurnOnResume: event.target.checked } })}
              />
            </label>
          </fieldset>

          <div className="dialog-actions">
            {target.mode === 'goal' && !usesGeneral && (
              <button type="button" onClick={() => setUsesGeneral(true)}>Genel ayarlara dön</button>
            )}
            <span />
            <button type="button" disabled={busy} onClick={onClose}>İptal</button>
            <button className="primary" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}
