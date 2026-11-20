import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, X, Loader2 } from 'lucide-react'
import { api } from '../../lib/api.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'

interface MaintenanceWindowData {
  scheduledAt: string
  message: string | null
  status: 'scheduled' | 'completed' | 'cancelled'
  createdBy: string
  createdByEmail: string | null
  createdAt: string
  completedAt: string | null
}

const COUNTDOWN_THRESHOLD_MS = 30 * 60 * 1000
// How long the post-restart "you're updated" confirmation stays visible —
// long enough that anyone who logs in a bit late still sees it, short
// enough that it doesn't linger for days.
const CONFIRMATION_VISIBLE_MS = 2 * 60 * 60 * 1000

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// v1.333.0: App Updates Phase 2 — announces a default-admin-scheduled
// maintenance window to every signed-in user, mirroring connections-banner.tsx's
// sticky-banner-at-the-top-of-the-shell pattern (same amber tone, same X-to-
// dismiss-per-session convention) rather than inventing a new visual language
// for "something needs your attention." Three states, in order:
//   1. Advance notice — dismissible per session, reappears next login (same
//      contract as the Outlook/SF connection reminders).
//   2. Live countdown, final 30 minutes — NOT dismissible. A scheduled
//      restart with data-loss potential for anyone mid-edit is the one case
//      in this app worth overriding "let the user hide it."
//   3. Post-restart confirmation — dismissible, auto-expires after 2h.
// Polls every 60s (cheap) and, once a window exists, ticks a local clock
// every 1s for the countdown display — the actual restart timing is driven
// server-side by restartScheduler.ts, this is display only.
export function MaintenanceBanner() {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const [win, setWin] = useState<MaintenanceWindowData | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [dismissedAdvanceKey, setDismissedAdvanceKey] = useState<string | null>(() => {
    try { return sessionStorage.getItem('maint_banner_dismissed_advance') } catch { return null }
  })
  const [dismissedConfirmKey, setDismissedConfirmKey] = useState<string | null>(() => {
    try { return sessionStorage.getItem('maint_banner_dismissed_confirm') } catch { return null }
  })

  useEffect(() => {
    if (!user) return
    let cancelled = false
    async function reload() {
      const res = await api.get<MaintenanceWindowData | null>('/api/admin/maintenance-window')
      // On a transient failure (e.g. the exact moment the process is
      // restarting), keep whatever we last knew rather than blanking the
      // banner right when it matters most.
      if (!cancelled && !res.error) setWin(res.data ?? null)
    }
    void reload()
    const poll = setInterval(() => void reload(), 60_000)
    return () => { cancelled = true; clearInterval(poll) }
  }, [user])

  useEffect(() => {
    if (!win) return
    const tick = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(tick)
  }, [win])

  if (!user || !win) return null

  const scheduledAt = new Date(win.scheduledAt)
  const msUntil = scheduledAt.getTime() - now.getTime()
  const when = scheduledAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  if (win.status === 'completed') {
    if (!win.completedAt) return null
    const sinceCompleted = now.getTime() - new Date(win.completedAt).getTime()
    if (sinceCompleted > CONFIRMATION_VISIBLE_MS || dismissedConfirmKey === win.completedAt) return null
    return (
      <div className="flex items-center gap-2 border-b border-green-200 bg-green-50 px-4 py-2 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t('maintenance.completed')}</span>
        <button
          type="button"
          onClick={() => {
            setDismissedConfirmKey(win.completedAt)
            try { sessionStorage.setItem('maint_banner_dismissed_confirm', win.completedAt ?? '') } catch { /* ignore */ }
          }}
          className="rounded p-0.5 text-green-800 hover:text-green-900 dark:text-green-200 dark:hover:text-green-100"
          aria-label={t('conn_banner.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  if (win.status !== 'scheduled') return null

  if (msUntil <= 0) {
    // Due, but the 15s-tick restart-scheduler job hasn't fired yet (or is
    // in its own short grace delay before exiting) — a brief, expected gap
    // rather than a stuck countdown reading "0:00".
    return (
      <div className="flex items-center gap-2 border-b border-red-300 bg-red-50 px-4 py-2 text-xs font-medium text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="flex-1">{t('maintenance.restarting_now')}</span>
      </div>
    )
  }

  if (msUntil <= COUNTDOWN_THRESHOLD_MS) {
    return (
      <div className="flex items-center gap-2 border-b border-red-300 bg-red-50 px-4 py-2 text-xs font-medium text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          {t('maintenance.countdown', { time: formatCountdown(msUntil) })}
          {win.message && <span className="ml-1 font-normal opacity-90">— {win.message}</span>}
        </span>
      </div>
    )
  }

  if (dismissedAdvanceKey === win.scheduledAt) return null
  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        {t('maintenance.advance_notice', { when })}
        {win.message && <span className="ml-1 opacity-90">— {win.message}</span>}
      </span>
      <button
        type="button"
        onClick={() => {
          setDismissedAdvanceKey(win.scheduledAt)
          try { sessionStorage.setItem('maint_banner_dismissed_advance', win.scheduledAt) } catch { /* ignore */ }
        }}
        className="rounded p-0.5 text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
        aria-label={t('conn_banner.dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
