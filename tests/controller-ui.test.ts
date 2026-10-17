import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuditEntryView, GoalRowView } from '../src/renderer/src/App'
import type { GoalRecord } from '../src/shared/types'

const goal: GoalRecord = {
  id: 'target', name: 'Test Goal', objective: 'test', priority: 50, remoteStatus: 'active',
  runtimeStatus: 'active', controllerStatus: 'allowed', controllerManaged: true, excluded: false,
  createdAt: 1, lastActivityAt: 1, lastSeenAt: 1, tokensUsed: 0, tokenBudget: null,
  lastTurnId: 'turn', lastTurnStatus: 'inProgress', pausedAt: null, resumedAt: 1,
  cooldownUntil: null, proposedAction: 'none', proposedReason: null, policyOverride: null,
  sessionControlStatus: 'running'
}
function render(overrides: Partial<GoalRecord> = {}) {
  return renderToStaticMarkup(createElement(GoalRowView, {
    goal: { ...goal, ...overrides }, starting: false,
    onPriority() {}, onExcluded() {}, onStart() {}, onPause() {}, onSettings() {}
  }))
}

describe('Goal and session evidence in the UI (no real app)', () => {
  it('keeps both row controls visible and enables stop for a paused Goal whose turn is still active', () => {
    const html = render({ remoteStatus: 'paused' })
    expect(html).toMatch(/aria-label="Test Goal: Durdur"/)
    expect(html).toMatch(/aria-label="Test Goal: Başlat"/)
    expect(html).not.toMatch(/disabled="" aria-label="Test Goal: Durdur"/)
  })
  it('disables resume for an already-running Goal and disables stop only after idle is observed', () => {
    expect(render()).toMatch(/disabled="" aria-label="Test Goal: Başlat"/)
    expect(render({ remoteStatus: 'paused', runtimeStatus: 'idle' })).toMatch(/disabled="" aria-label="Test Goal: Durdur"/)
  })
  it('explains independent control and offers start for blocked or excluded Goals', () => {
    const html = render({ remoteStatus: 'blocked', excluded: true })
    expect(html).not.toMatch(/disabled="" aria-label="Test Goal: Başlat"/)
    expect(html).toContain('yerel kota, cooldown ve kapasite kurallarını uygulamaz')
    expect(html).toContain('Dahil/Hariç değişmez')
    expect(html).toContain('sonraki otomatik kontrol yeniden başlatabilir')
  })
  it('shows an active session independently from a paused Goal', () => {
    const html = render({ remoteStatus: 'paused', controllerStatus: 'paused_quota' })
    expect(html).toContain('remote-paused">Duraklatıldı')
    expect(html).toContain('pill session-active')
    expect(html).not.toContain('session-interrupted')
  })
  it('does not reuse a stale running control flag when the session is not loaded', () => {
    const html = render({ runtimeStatus: 'notLoaded', lastTurnStatus: 'interrupted' })
    expect(html).toContain('Doğrulanmadı')
    expect(html).not.toContain('pill session-active')
    expect(html).not.toContain('Kontrolde')
  })
  it('does not label an excluded or writer-conflicted Goal as controlled', () => {
    const html = render({ excluded: true, controllerStatus: 'excluded', sessionControlStatus: 'writerConflict' })
    expect(html).toContain('Başka uygulamada')
    expect(html).toContain('Başlat')
    expect(html).not.toContain('Yönetimde')
    expect(html).not.toContain('Kontrolde')
  })
  it('actually displays the reason a resume was skipped, escaping it as text', () => {
    const html = renderToStaticMarkup(createElement(AuditEntryView, { entry: {
      id: 1, timestamp: 100, goalId: 'target', goalName: 'Test Goal',
      action: 'resume', reason: 'manual', status: 'skipped', detail: 'writer conflict <private>'
    } }))
    expect(html).toContain('writer conflict &lt;private&gt;')
    expect(html).toContain('SKIPPED')
    expect(html).not.toContain('<private>')
  })
})
