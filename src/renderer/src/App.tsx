import { useEffect, useMemo, useState } from 'react'
import type {
  DashboardSnapshot,
  GoalPolicyOverride,
  GoalRecord,
  UpdateSettingsInput,
  UsageWindow
} from '../../shared/types'
import { SettingsDialog, type SettingsTarget } from './SettingsDialog'

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp * 1000))
}

function UsageCard({
  title,
  window,
  measuredAt,
  stale
}: {
  title: string
  window: UsageWindow | null
  measuredAt: number | null
  stale: boolean
}) {
  const percentage = window?.usedPercent ?? 0
  const remaining = Math.max(0, 100 - percentage)
  return (
    <article className="usage-card">
      <div className="usage-title">
        <span>{title} · Kalan</span>
        <strong>{window ? `${remaining.toFixed(0)}%` : '—'}</strong>
      </div>
      <div className="progress" role="progressbar" aria-label="Kalan kullanım" aria-valuenow={window ? remaining : undefined} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${window ? remaining : 0}%` }} data-level={percentage >= 90 ? 'danger' : percentage >= 75 ? 'warn' : 'ok'} />
      </div>
      <div className="usage-details">
        <span>Kullanıldı <b>{window ? `%${percentage.toFixed(0)}` : '—'}</b></span>
        <span>Kaldı <b>{window ? `%${remaining.toFixed(0)}` : '—'}</b></span>
      </div>
      <p>Reset: {formatTime(window?.resetsAt)}</p>
      <p className={stale ? 'stale' : ''}>{stale ? 'Son başarılı ölçüm' : 'Ölçüm'}: {formatTime(measuredAt)}</p>
    </article>
  )
}

const statusLabels: Record<string, string> = {
  active: 'Çalışıyor',
  paused: 'Duraklatıldı',
  blocked: 'Engellendi',
  usageLimited: 'Kullanım limiti',
  budgetLimited: 'Bütçe limiti',
  complete: 'Tamamlandı',
  allowed: 'İzinli',
  paused_quota: 'Kota',
  paused_priority: 'Öncelik',
  paused_manual: 'Manuel/uzak',
  excluded: 'Hariç',
  completed: 'Tamamlandı',
  remote_blocked: 'Uzak engel',
  error: 'Hata'
}

function sessionState(goal: GoalRecord): { label: string; className: string } {
  if (goal.sessionControlStatus === 'writerConflict') return { label: 'Başka uygulamada', className: 'session-writer-conflict' }
  if (goal.remoteStatus === 'paused' && goal.controllerStatus.startsWith('paused_')) return { label: 'Duraklatıldı', className: 'session-interrupted' }
  if (goal.sessionControlStatus === 'running') return { label: 'Çalışıyor', className: 'session-active' }
  if (goal.sessionControlStatus === 'interrupted') return { label: 'Kesildi', className: 'session-interrupted' }
  if (goal.sessionControlStatus === 'error') return { label: 'Hata', className: 'session-error' }
  if (goal.lastTurnStatus === 'inProgress' || goal.runtimeStatus === 'active') return { label: 'Çalışıyor', className: 'session-active' }
  if (goal.lastTurnStatus === 'interrupted') return { label: 'Kesildi', className: 'session-interrupted' }
  if (goal.runtimeStatus === 'notLoaded') return { label: 'Yüklü değil', className: 'session-not-loaded' }
  if (goal.runtimeStatus === 'systemError') return { label: 'Hata', className: 'session-error' }
  return { label: 'Beklemede', className: 'session-idle' }
}

function GoalRowView({
  goal,
  onPriority,
  onExcluded,
  onTakeControl,
  onSettings,
  starting
}: {
  goal: GoalRecord
  onPriority: (goalId: string, priority: number) => void
  onExcluded: (goalId: string, excluded: boolean) => void
  onTakeControl: (goalId: string) => void
  onSettings: (goal: GoalRecord) => void
  starting: boolean
}) {
  const [priority, setPriority] = useState(goal.priority)
  useEffect(() => setPriority(goal.priority), [goal.priority])
  const proposed = goal.proposedAction === 'none'
    ? '—'
    : `${goal.proposedAction === 'pause' ? 'Pause' : 'Resume'} · ${goal.proposedReason}`
  const session = sessionState(goal)

  return (
    <tr>
      <td>
        <div className="goal-name">{goal.name}</div>
        <div className="goal-objective" title={goal.objective}>{goal.objective}</div>
      </td>
      <td>
        <div className="priority-control">
          <input
            aria-label={`${goal.name} önceliği`}
            type="range"
            min="0"
            max="100"
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
            onPointerUp={() => onPriority(goal.id, priority)}
            onKeyUp={() => onPriority(goal.id, priority)}
          />
          <span>{priority}</span>
        </div>
      </td>
      <td><span className={`pill remote-${goal.remoteStatus}`}>{statusLabels[goal.remoteStatus]}</span></td>
      <td><span className={`pill ${session.className}`} title={goal.lastTurnId ?? undefined}>{session.label}</span></td>
      <td><span className="pill controller">{statusLabels[goal.controllerStatus]}</span></td>
      <td><span className={goal.proposedAction === 'none' ? 'muted' : 'proposed'}>{proposed}</span></td>
      <td>
        <label className="switch compact">
          <input
            type="checkbox"
            checked={goal.excluded}
            onChange={(event) => onExcluded(goal.id, event.target.checked)}
          />
          <span aria-hidden="true" />
          <em>{goal.excluded ? 'Hariç' : 'Dahil'}</em>
        </label>
      </td>
      <td className="goal-action">
        <div className="goal-actions">
          {goal.remoteStatus === 'paused' ? (
            <button className="compact-action" disabled={starting} onClick={() => onTakeControl(goal.id)}>
              {starting ? 'Başlatılıyor…' : 'Kontrole al ve başlat'}
            </button>
          ) : goal.remoteStatus === 'active' && goal.controllerManaged ? (
            <span className="managed-state">Kontrolde</span>
          ) : (
            <span className="muted">—</span>
          )}
          <button className="compact-action secondary" onClick={() => onSettings(goal)}>
            Ayarlar{goal.policyOverride ? ' · Özel' : ''}
          </button>
        </div>
      </td>
    </tr>
  )
}

export function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [startingGoalId, setStartingGoalId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null)

  useEffect(() => {
    let mounted = true
    if (!window.goalController) {
      setNotice('Güvenli uygulama köprüsü yüklenemedi. Uygulamayı yeniden başlatın veya güncelleyin.')
      return () => { mounted = false }
    }
    void window.goalController.getSnapshot()
      .then((value) => mounted && setSnapshot(value))
      .catch((error) => mounted && setNotice(error instanceof Error ? error.message : String(error)))
    const unsubscribe = window.goalController.onSnapshot((value) => mounted && setSnapshot(value))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const activeCount = useMemo(
    () => snapshot?.goals.filter((goal) => goal.remoteStatus === 'active').length ?? 0,
    [snapshot]
  )

  async function run<T>(operation: () => Promise<T>, message?: string): Promise<boolean> {
    setBusy(true)
    setNotice(null)
    try {
      await operation()
      if (message) setNotice(message)
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function takeControlAndResume(goalId: string): Promise<void> {
    setStartingGoalId(goalId)
    try {
      await run(
        () => window.goalController.takeControlAndResume(goalId),
        'Goal canlı controller yönetimine alındı ve başlatıldı.'
      )
    } finally {
      setStartingGoalId(null)
    }
  }

  if (!snapshot) {
    return <main className="loading">
      {notice ? <div className="startup-error"><strong>Uygulama başlatılamadı</strong><p>{notice}</p></div> : <><div className="spinner" /><p>Goal Controller başlatılıyor…</p></>}
    </main>
  }

  const statusText = snapshot.status === 'MONITORING'
    ? 'İzleme aktif'
    : snapshot.status === 'MONITORING_ERROR'
      ? 'İzleme hatası'
      : 'Başlatılıyor'

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark">✓</div>
        <div className="brand-copy">
          <h1>Goal Controller</h1>
          <p>Codex Goal kaynak yöneticisi</p>
        </div>
        <div className={`health ${snapshot.status.toLowerCase()}`}>
          <span /> {statusText}
        </div>
        <div className="live-control">CANLI KONTROL</div>
      </header>

      {snapshot.lastError && <div className="error-banner"><strong>MONITORING_ERROR</strong>{snapshot.lastError}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="summary-grid">
        <UsageCard
          title="5 Saatlik Kullanım"
          window={snapshot.usage?.fiveHour ?? null}
          measuredAt={snapshot.usage?.measuredAt ?? null}
          stale={snapshot.status === 'MONITORING_ERROR'}
        />
        <UsageCard
          title="Haftalık Kullanım"
          window={snapshot.usage?.weekly ?? null}
          measuredAt={snapshot.usage?.measuredAt ?? null}
          stale={snapshot.status === 'MONITORING_ERROR'}
        />
        <article className="status-card">
          <div><span>Goal</span><strong>{snapshot.goals.length}</strong></div>
          <div><span>Aktif</span><strong>{activeCount}</strong></div>
          <p>Son kontrol: {formatTime(snapshot.lastCheckedAt)}</p>
        </article>
      </section>

      <section className="command-row" aria-label="Kontroller">
        <button className="primary" disabled={busy || snapshot.cycleRunning} onClick={() => run(() => window.goalController.runCheck())}>
          {snapshot.cycleRunning ? 'Kontrol ediliyor…' : 'Şimdi Kontrol Et'}
        </button>
        <button disabled={busy || snapshot.cycleRunning} onClick={() => {
          if (window.confirm('Kapsama dahil çalışan tüm Goal’lar duraklatılacak. Devam edilsin mi?')) {
            void run(() => window.goalController.pauseAll(), 'Kapsama dahil çalışan Goal’lar duraklatıldı.')
          }
        }}>
          Pause All
        </button>
        <button disabled={busy || snapshot.cycleRunning} onClick={() => run(() => window.goalController.resumeAllowed(), 'Controller tarafından duraklatılan izinli Goal’lar yeniden değerlendirildi.')}>
          Resume Allowed
        </button>
      </section>

      <section className="panel goals-panel">
        <div className="panel-heading">
          <div><h2>Goal’lar</h2><p>Yerel App Server’da Goal durumuna sahip Codex görevleri</p></div>
          <span>{snapshot.goals.length} kayıt</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Goal</th><th>Öncelik</th><th>Remote</th><th>Session</th><th>Controller</th><th>Öneri</th><th>Kapsam</th><th>İşlem</th></tr></thead>
            <tbody>
              {snapshot.goals.length === 0 ? (
                <tr><td colSpan={8} className="empty">Henüz yerel bir Codex Goal bulunamadı.</td></tr>
              ) : snapshot.goals.map((goal) => (
                <GoalRowView
                  key={goal.id}
                  goal={goal}
                  onPriority={(goalId, priority) => void run(() => window.goalController.updatePriority(goalId, priority))}
                  onExcluded={(goalId, excluded) => void run(() => window.goalController.setExcluded(goalId, excluded))}
                  onTakeControl={(goalId) => void takeControlAndResume(goalId)}
                  onSettings={(selectedGoal) => setSettingsTarget({ mode: 'goal', goal: selectedGoal, settings: snapshot.settings })}
                  starting={startingGoalId === goal.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="lower-grid">
        <section className="panel settings-panel">
          <div className="panel-heading"><div><h2>Ayarlar</h2><p>Policy ve scheduler</p></div></div>
          <div className="settings-summary">
            <div><span>Kontrol</span><strong>{snapshot.settings.pollIntervalSeconds} sn</strong></div>
            <div><span>Maksimum Goal</span><strong>{snapshot.settings.maxRunningGoals}</strong></div>
            <div><span>5 saatlik rezerv</span><strong>%{snapshot.settings.fiveHourPolicy.stopRemainingPercent}</strong></div>
            <div><span>Haftalık rezerv</span><strong>%{snapshot.settings.weeklyPolicy.stopRemainingPercent}</strong></div>
          </div>
          <button className="settings-open" onClick={() => setSettingsTarget({ mode: 'global', settings: snapshot.settings })}>
            Genel Ayarları Aç
          </button>
        </section>

        <section className="panel audit-panel">
          <div className="panel-heading"><div><h2>Audit Log</h2><p>Son controller kararları ve hatalar</p></div></div>
          <div className="audit-list">
            {snapshot.audit.length === 0 ? <div className="empty">Henüz audit kaydı yok.</div> : snapshot.audit.slice(0, 40).map((entry) => (
              <article key={entry.id} className={`audit-entry ${entry.status}`}>
                <time>{new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(entry.timestamp * 1000))}</time>
                <div><strong>{entry.goalName ?? entry.action}</strong><span>{entry.goalName ? `${entry.action.toUpperCase()} · ${entry.reason}` : entry.detail}</span></div>
                <b>{entry.status.toUpperCase()}</b>
              </article>
            ))}
          </div>
        </section>
      </div>

      {settingsTarget && (
        <SettingsDialog
          key={settingsTarget.mode === 'global' ? 'global' : settingsTarget.goal.id}
          target={settingsTarget}
          busy={busy}
          onClose={() => setSettingsTarget(null)}
          onSaveGlobal={(input: UpdateSettingsInput) => run(
            () => window.goalController.updateSettings(input),
            'Genel ayarlar kaydedildi.'
          )}
          onSaveGoal={(goalId: string, policy: GoalPolicyOverride | null) => run(
            () => window.goalController.updateGoalPolicy(goalId, policy),
            policy ? 'Goal özel ayarları kaydedildi.' : 'Goal genel ayarlara döndürüldü.'
          )}
        />
      )}

      <footer>
        <span>{snapshot.appServerVersion ?? 'Codex sürümü okunamadı'}</span>
        <span>Yerel SQLite · MCP yok · Canlı remote kontrol açık</span>
      </footer>
    </main>
  )
}
