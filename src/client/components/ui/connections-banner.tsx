import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, X, MailX } from 'lucide-react'
import { format } from 'date-fns'
import { useSalesforce } from '../../hooks/useSalesforce.js'
import { useOutlookStatus } from '../../hooks/useCalendar.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useNotifications } from './notifications.js'
import { api } from '../../lib/api.js'

// Sticky banner at the top of the app shell reminding the user to
// hook up Salesforce and Outlook if they haven't yet. Dismissible per
// session (sessionStorage key), so it reappears at each login until
// the underlying connection is completed. One banner per missing
// integration.
export function ConnectionsBanner() {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const { status: crmStatus } = useSalesforce()
  const { status: outlookStatus } = useOutlookStatus()
  // v1.242.0: approved activities whose Outlook meeting was deleted. Reuses
  // the notifications poll rather than adding another — the count already
  // rides on that response's meta.
  const { outlookDeletedCount } = useNotifications()
  const [dismissedSf, setDismissedSf] = useState<boolean>(() => {
    try { return sessionStorage.getItem('conn_banner_dismissed_sf') === '1' } catch { return false }
  })
  const [dismissedSfBroken, setDismissedSfBroken] = useState<boolean>(() => {
    try { return sessionStorage.getItem('conn_banner_dismissed_sf_broken') === '1' } catch { return false }
  })
  const [dismissedOutlook, setDismissedOutlook] = useState<boolean>(() => {
    try { return sessionStorage.getItem('conn_banner_dismissed_outlook') === '1' } catch { return false }
  })
  // Dismissible per session like its siblings, but the underlying condition
  // only clears when the user actually decides Keep or Delete — so it comes
  // back next login until the queue is empty, which is the point.
  const [dismissedDeleted, setDismissedDeleted] = useState<boolean>(() => {
    try { return sessionStorage.getItem('conn_banner_dismissed_outlook_deleted') === '1' } catch { return false }
  })
  useEffect(() => {
    try { sessionStorage.setItem('conn_banner_dismissed_outlook_deleted', dismissedDeleted ? '1' : '0') } catch { /* ignore */ }
  }, [dismissedDeleted])
  useEffect(() => {
    try { sessionStorage.setItem('conn_banner_dismissed_sf', dismissedSf ? '1' : '0') } catch { /* ignore */ }
  }, [dismissedSf])
  useEffect(() => {
    try { sessionStorage.setItem('conn_banner_dismissed_sf_broken', dismissedSfBroken ? '1' : '0') } catch { /* ignore */ }
  }, [dismissedSfBroken])
  useEffect(() => {
    try { sessionStorage.setItem('conn_banner_dismissed_outlook', dismissedOutlook ? '1' : '0') } catch { /* ignore */ }
  }, [dismissedOutlook])

  const showDeletedRaw = (outlookDeletedCount ?? 0) > 0 && !dismissedDeleted

  // v1.362.0: the Review link previously always pointed at "/" (today's
  // week), regardless of which week the flagged activity/activities actually
  // live in — landing on today with no matching activity and no visible next
  // step whenever the deletion happened on a meeting from a different week.
  // Fetch the flagged queue (unscoped — every week) once whenever the count
  // is non-zero, and deep-link to the EARLIEST flagged item's own week via
  // the same `?openActivityId=&startDate=` pattern leader-dashboard drill-
  // downs already use (WeeklyView.tsx already reads both). Falls back to "/"
  // if the fetch hasn't resolved yet or genuinely finds nothing (e.g. the
  // count is momentarily stale right after a Keep/Delete elsewhere). Must
  // run unconditionally (before the `!user` early return below) — Hooks
  // can't be called after a conditional return.
  const [reviewHref, setReviewHref] = useState('/')
  useEffect(() => {
    if (!showDeletedRaw) return
    let cancelled = false
    api.get<{ id: string; startDatetime: string }[]>('/api/activities/outlook-deleted').then((res) => {
      if (cancelled) return
      const first = (res.data ?? [])[0]
      if (!first) return
      const day = format(new Date(first.startDatetime), 'yyyy-MM-dd')
      setReviewHref(`/?openActivityId=${first.id}&startDate=${day}`)
    })
    return () => { cancelled = true }
  }, [showDeletedRaw, outlookDeletedCount])

  // Don't render until we know who the user is + we've had a chance to
  // load statuses. `configured=false` means the tenant admin hasn't
  // wired up the integration at all — no point nagging users when they
  // can't connect anyway. Only nag on personal connect: configured &&
  // !connected.
  if (!user) return null
  const showSf = !!crmStatus?.configured && !crmStatus?.connected && !dismissedSf
  // v1.99.0: connected-but-not-healthy = token exists but SF rejected
  // it (revoked, password reset, session killed). Card lookups will
  // silently return "Unassigned" / no Account until the user reconnects.
  const showSfBroken = !!crmStatus?.configured && !!crmStatus?.connected && crmStatus?.healthy === false && !dismissedSfBroken
  const showOutlook = !!outlookStatus?.configured && !outlookStatus?.connected && !dismissedOutlook
  const showDeleted = showDeletedRaw

  if (!showSf && !showSfBroken && !showOutlook && !showDeleted) return null

  return (
    <div className="flex flex-col gap-1 border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-800 dark:bg-amber-950/40">
      {showSf && (
        <div className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t('conn_banner.sf', 'Your Salesforce account is not connected. Head to My Settings → Integrations to link it so activity write-back and SF search work.')}
          </span>
          <a href="/settings" className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60">
            {t('conn_banner.go_connect', 'Connect')}
          </a>
          <button
            type="button"
            onClick={() => setDismissedSf(true)}
            className="rounded p-0.5 text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
            aria-label={t('conn_banner.dismiss', 'Dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {showSfBroken && (
        <div className="flex items-center gap-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t('conn_banner.sf_broken', 'Your Salesforce connection has stopped working (token revoked or expired). Reconnect from My Settings → Integrations so activity cards and write-back can talk to SF again.')}
          </span>
          <a href="/settings" className="rounded border border-red-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100 dark:hover:bg-red-900/60">
            {t('conn_banner.go_reconnect', 'Reconnect')}
          </a>
          <button
            type="button"
            onClick={() => setDismissedSfBroken(true)}
            className="rounded p-0.5 text-red-700 hover:text-red-900 dark:text-red-200 dark:hover:text-red-100"
            aria-label={t('conn_banner.dismiss', 'Dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {/* v1.242.0: approved work whose calendar meeting is gone. Orange
          rather than the amber "not connected" tone — this isn't a setup
          reminder, it's existing data needing a decision. */}
      {showDeleted && (
        <div className="flex items-center gap-2 rounded border border-orange-300 bg-orange-50 px-2 py-1.5 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-200">
          <MailX className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t('conn_banner.outlook_deleted', { count: outlookDeletedCount ?? 0 })}
          </span>
          <a href={reviewHref} className="rounded border border-orange-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-orange-900 hover:bg-orange-100 dark:border-orange-700 dark:bg-orange-900/40 dark:text-orange-100 dark:hover:bg-orange-900/60">
            {t('conn_banner.go_review', 'Review')}
          </a>
          <button
            type="button"
            onClick={() => setDismissedDeleted(true)}
            className="rounded p-0.5 text-orange-800 hover:text-orange-900 dark:text-orange-200 dark:hover:text-orange-100"
            aria-label={t('conn_banner.dismiss', 'Dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {showOutlook && (
        <div className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t('conn_banner.outlook', 'Your Outlook calendar is not connected. Head to My Settings → Integrations to link it so the calendar panel can pre-fill activities from meetings.')}
          </span>
          <a href="/settings" className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60">
            {t('conn_banner.go_connect', 'Connect')}
          </a>
          <button
            type="button"
            onClick={() => setDismissedOutlook(true)}
            className="rounded p-0.5 text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
            aria-label={t('conn_banner.dismiss', 'Dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
