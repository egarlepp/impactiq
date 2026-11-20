import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Bell, BellRing, X, Check, CheckCheck, Info, AlertTriangle, AlertOctagon, BellOff, MailX, Trash2, CalendarDays, Tags, ChevronDown, ChevronRight, Megaphone } from 'lucide-react'
import { api } from '../../lib/api.js'
import { useTeam } from '../../store/team.js'
import { cn } from '../../lib/utils.js'
import { DynamicIcon } from './icon-picker.js'
import { linkifyText } from '../../lib/linkify.js'

// Exported so other surfaces sharing this same cache (e.g. AnnouncementBanner.tsx)
// can filter/render its items without a duplicate fetch or type.
export interface Notification {
  id: string
  userId: string
  teamId: string | null
  kind: string
  message: string
  link: string | null
  isRead: boolean
  dedupeKey: string | null
  createdAt: string
  severity?: string | null
  icon?: string | null
  // Announcement-only (kind='announcement'): the header-banner-only custom
  // icon color pair — see AnnouncementBanner.tsx. Never read by the bell or
  // the toast.
  iconColorLight?: string | null
  iconColorDark?: string | null
  // v1.426.0: a nudge row's rule name, for the bell's "By category" view.
  // Null for a deleted rule and for every non-nudge kind.
  categoryName?: string | null
}

// v1.62.0: per-severity chrome. Info stays quiet; warning gets amber;
// critical gets red so a stuck sync or overdue eval reads at a glance.
// Exported so AnnouncementBanner.tsx uses the identical severity->color/icon
// mapping the bell does, rather than a second copy that can drift.
export const SEVERITY_STYLES: Record<string, { border: string; text: string; Icon: typeof Info }> = {
  info: { border: 'border-l-blue-400 dark:border-l-blue-500', text: 'text-blue-600 dark:text-blue-400', Icon: Info },
  warning: { border: 'border-l-amber-400 dark:border-l-amber-500', text: 'text-amber-600 dark:text-amber-400', Icon: AlertTriangle },
  critical: { border: 'border-l-red-500 dark:border-l-red-500', text: 'text-red-600 dark:text-red-400', Icon: AlertOctagon },
}

// vNext: the bottom-of-screen toast's OWN severity palette — deliberately
// separate from SEVERITY_STYLES above (which stays blue/amber/red for the
// bell dropdown and the banner's border, unchanged) since this was reported
// as its own thing: the toast should be green/orange/red, not the bell's
// blue/amber/red. Applies to every notification kind shown via the toast
// (nudge, sync-failure, announcement, anything future) — the toast already
// reads top.severity, this just makes it mean something visually.
const TOAST_SEVERITY_STYLES: Record<string, { border: string; bg: string; text: string; Icon: typeof Info }> = {
  info: { border: 'border-green-200 dark:border-green-800', bg: 'bg-green-50 dark:bg-green-950/70', text: 'text-green-600 dark:text-green-400', Icon: Info },
  warning: { border: 'border-orange-200 dark:border-orange-800', bg: 'bg-orange-50 dark:bg-orange-950/70', text: 'text-orange-600 dark:text-orange-400', Icon: AlertTriangle },
  critical: { border: 'border-red-200 dark:border-red-800', bg: 'bg-red-50 dark:bg-red-950/70', text: 'text-red-600 dark:text-red-400', Icon: AlertOctagon },
}

interface NotificationsState {
  items: Notification[]
  unreadCount: number
  syncFailedCount?: number
  // v1.242.0: approved activities whose Outlook event was deleted, awaiting a
  // Keep/Delete decision. Counts ALL weeks and all teams — a per-user
  // data-integrity signal rather than a team-configured nudge, so it rides on
  // this response's meta the way syncFailedCount already does instead of
  // becoming another poll.
  outlookDeletedCount?: number
}

let cachedState: NotificationsState = { items: [], unreadCount: 0, syncFailedCount: 0, outlookDeletedCount: 0 }
const listeners = new Set<() => void>()
function emit() {
  listeners.forEach((cb) => { cb() })
}

// Cross-component signal so the Weekly-view nudge banner/toast (a separate
// data source: /api/nudges) can drop a nudge the moment it's read/snoozed
// from the bell, instead of waiting for the next page load. Payload is the
// affected rule ids parsed from each notification's dedupeKey.
export const NUDGE_READ_EVENT = 'impactiq:nudge-read'
function announceNudgeRead(notifs: Array<{ kind?: string; dedupeKey?: string | null }>): void {
  const ruleIds = notifs
    .filter((n) => n.kind === 'nudge' && n.dedupeKey?.startsWith('nudge:'))
    .map((n) => n.dedupeKey!.split(':')[1])
    .filter((x): x is string => Boolean(x))
  if (ruleIds.length > 0 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NUDGE_READ_EVENT, { detail: { ruleIds } }))
  }
}

// Reverse direction of announceNudgeRead: other nudge surfaces (currently
// just the Weekly-view banner) call this after they dismiss a nudge
// server-side, so the bell's cached list/badge drop the matching
// notification immediately instead of waiting up to POLL_MS for the next
// poll. Without this, dismissing from one surface left the other showing
// a nudge that no longer exists until the next poll caught up.
export function dropNudgeNotification(ruleId: string): void {
  const toDrop = cachedState.items.filter((n) => n.kind === 'nudge' && n.dedupeKey?.startsWith('nudge:') && n.dedupeKey.split(':')[1] === ruleId)
  if (toDrop.length === 0) return
  const unreadDropped = toDrop.filter((n) => !n.isRead).length
  const dropIds = new Set(toDrop.map((n) => n.id))
  cachedState = {
    ...cachedState,
    items: cachedState.items.filter((n) => !dropIds.has(n.id)),
    unreadCount: Math.max(0, cachedState.unreadCount - unreadDropped),
  }
  emit()
}

const POLL_MS = 60_000

export function useNotifications() {
  const { active } = useTeam()
  const teamId = active?.isAll ? null : active?.id ?? null
  const [state, setState] = useState<NotificationsState>(cachedState)

  useEffect(() => {
    const onChange = () => setState({ ...cachedState })
    listeners.add(onChange)
    return () => { listeners.delete(onChange) }
  }, [])

  const refresh = useCallback(async () => {
    const url = teamId ? `/api/notifications?teamId=${teamId}` : '/api/notifications'
    const res = await api.get<NotificationsState>(url)
    if (res.data) {
      const meta = (res.meta ?? {}) as { syncFailedCount?: number; outlookDeletedCount?: number }
      cachedState = { ...res.data, syncFailedCount: meta.syncFailedCount ?? 0, outlookDeletedCount: meta.outlookDeletedCount ?? 0 }
      emit()
    }
  }, [teamId])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const markRead = useCallback(async (id: string) => {
    const target = cachedState.items.find((n) => n.id === id)
    await api.patch(`/api/notifications/${id}/read`, {})
    cachedState = {
      ...cachedState,
      items: cachedState.items.map((n) => n.id === id ? { ...n, isRead: true } : n),
      unreadCount: Math.max(0, cachedState.unreadCount - 1),
    }
    emit()
    if (target) announceNudgeRead([target])
  }, [])

  const markAllRead = useCallback(async () => {
    const wereUnread = cachedState.items.filter((n) => !n.isRead)
    // v1.234.0: pass the active team so the server only clears unread rows
    // for the team currently in view, matching the fetch above — otherwise
    // "mark all read" from one team's bell would also silently clear an
    // unread nudge sitting in a different team.
    await api.post('/api/notifications/read-all', teamId ? { teamId } : {})
    cachedState = {
      ...cachedState,
      items: cachedState.items.map((n) => ({ ...n, isRead: true })),
      unreadCount: 0,
    }
    emit()
    announceNudgeRead(wereUnread)
  }, [teamId])

  // v1.292.0: for a nudge-kind notification, dismiss is now the app's one
  // PERMANENT close-out surface (DELETE /api/notifications/:id →
  // closeOutNudgeRuleForever server-side) — the weekly-view card and the
  // toast deliberately don't offer this, only Mark read + Snooze, so a
  // reminder can't be silenced forever from a quick-glance surface.
  const dismiss = useCallback(async (id: string) => {
    const target = cachedState.items.find((n) => n.id === id)
    await api.delete(`/api/notifications/${id}`)
    cachedState = {
      items: cachedState.items.filter((n) => n.id !== id),
      unreadCount: target?.isRead
        ? cachedState.unreadCount
        : Math.max(0, cachedState.unreadCount - 1),
    }
    emit()
    // Announce so the Weekly-view banner/toast drop it immediately too,
    // same as markRead/snooze already do.
    if (target) announceNudgeRead([target])
  }, [])

  // Snooze: mute the underlying nudge rule for the caller for `days` days.
  // The rule id is embedded in the dedupeKey ("nudge:<ruleId>:<yyyy-mm-dd>")
  // so the card doesn't need a server round-trip to resolve it. Non-nudge
  // notifications don't have a rule id — the button is hidden for those.
  //
  // v1.294.0: this used to also call DELETE /api/notifications/:id as a
  // cleanup step to remove the bell row — but since v1.292.0 that endpoint
  // means "permanently close this rule out" for a nudge, so every Snooze
  // click was silently ALSO closing the rule out forever underneath the
  // chosen N-day snooze. POST /api/nudges/dismiss now cleans up the
  // matching notifications row itself (snoozeNudgeRuleForDays in
  // services/nudge/dismissals.ts), so no second call is needed here.
  const snooze = useCallback(async (n: Notification, days: number) => {
    const ruleId = n.dedupeKey?.startsWith('nudge:') ? n.dedupeKey.split(':')[1] : null
    if (!ruleId) return
    await api.post('/api/nudges/dismiss', { ruleId, days })
    cachedState = {
      ...cachedState,
      items: cachedState.items.filter((x) => x.id !== n.id),
      unreadCount: n.isRead ? cachedState.unreadCount : Math.max(0, cachedState.unreadCount - 1),
    }
    emit()
    announceNudgeRead([n])
  }, [])

  // v1.426.0: the bell's "Clear all". The server deletes every row in the
  // same team scope as the list above, mutes today's nudges until tomorrow
  // (never permanently) and dismisses announcements; see
  // clearNotificationsForUser in routes/notifications.ts.
  const clearAll = useCallback(async (): Promise<boolean> => {
    const cleared = cachedState.items
    const res = await api.post('/api/notifications/clear-all', teamId ? { teamId } : {})
    if (res.error) return false
    cachedState = { ...cachedState, items: [], unreadCount: 0 }
    emit()
    announceNudgeRead(cleared)
    return true
  }, [teamId])

  return {
    items: state.items,
    unreadCount: state.unreadCount,
    syncFailedCount: state.syncFailedCount ?? 0,
    outlookDeletedCount: state.outlookDeletedCount ?? 0,
    refresh,
    markRead,
    markAllRead,
    dismiss,
    snooze,
    clearAll,
  }
}

// v1.426.0: the bell can list notifications grouped by month or by category.
// The choice is a per-browser convenience, so it lives in localStorage.
type GroupMode = 'date' | 'category'
const GROUP_MODE_KEY = 'impactiq.notifications.groupBy'

function readGroupMode(): GroupMode {
  try { return localStorage.getItem(GROUP_MODE_KEY) === 'category' ? 'category' : 'date' } catch { return 'date' }
}

interface NotificationGroup {
  key: string
  label: string
  kind: 'month' | 'announcement' | 'nudge'
  items: Notification[]
  unread: number
}

// Items arrive newest first from the server, so each group's items stay
// newest first and a group's position follows its newest item: the first
// group is always the one holding the latest notification.
function groupNotifications(
  items: Notification[],
  mode: GroupMode,
  labels: { month: (d: Date) => string; announcements: string; reminders: string },
): NotificationGroup[] {
  const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const groups = new Map<string, NotificationGroup>()
  for (const n of sorted) {
    const created = new Date(n.createdAt)
    let key: string
    let label: string
    let kind: NotificationGroup['kind']
    if (mode === 'date') {
      key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`
      label = labels.month(created)
      kind = 'month'
    } else if (n.kind === 'announcement') {
      key = 'announcement'
      label = labels.announcements
      kind = 'announcement'
    } else {
      // A nudge groups under its rule's name; a deleted rule (or any other
      // kind) falls back to one generic bucket rather than a group per id.
      key = n.categoryName ? `nudge:${n.categoryName.toLowerCase()}` : 'nudge:other'
      label = n.categoryName ?? labels.reminders
      kind = 'nudge'
    }
    let g = groups.get(key)
    if (!g) {
      g = { key, label, kind, items: [], unread: 0 }
      groups.set(key, g)
    }
    g.items.push(n)
    if (!n.isRead) g.unread += 1
  }
  return [...groups.values()]
}

export function NotificationBell() {
  const { t, i18n } = useTranslation()
  const { items, unreadCount, syncFailedCount, outlookDeletedCount, markRead, markAllRead, dismiss, snooze, clearAll } = useNotifications()
  const [groupMode, setGroupMode] = useState<GroupMode>(readGroupMode)
  // Per-group open/closed choices the user made. A group with no entry uses
  // the default: only the first (latest) group is open.
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearFailed, setClearFailed] = useState(false)
  // Snooze menu is rendered in a body-level portal (not inside the scrollable
  // notifications list) so ancestor `overflow` can't clip it. We remember the
  // clicked notification + the button's screen rect to position it.
  const [snoozeMenu, setSnoozeMenu] = useState<{ n: Notification; x: number; y: number } | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const snoozeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function close(e: MouseEvent) {
      const target = e.target as Node
      // The snooze menu is portaled outside `ref`, so exclude it too —
      // otherwise clicking a snooze option would close the panel first.
      if (ref.current && !ref.current.contains(target) && !snoozeRef.current?.contains(target)) {
        setOpen(false)
        setSnoozeMenu(null)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Close the snooze menu on scroll (its position is fixed to a stale rect)
  // and whenever the panel itself closes.
  useEffect(() => {
    if (!snoozeMenu) return
    const onScroll = () => setSnoozeMenu(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [snoozeMenu])
  useEffect(() => {
    if (!open) {
      setSnoozeMenu(null)
      setConfirmClear(false)
      setClearFailed(false)
    }
  }, [open])

  function changeGroupMode(next: GroupMode) {
    setGroupMode(next)
    setExpandedOverrides({})
    try { localStorage.setItem(GROUP_MODE_KEY, next) } catch { /* private window: keep it for this visit only */ }
  }

  const groups = useMemo(() => groupNotifications(items, groupMode, {
    month: (d) => d.toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' }),
    announcements: t('notifications.category_announcements'),
    reminders: t('notifications.category_reminders'),
  }), [items, groupMode, i18n.language, t])

  async function handleClearAll() {
    setClearing(true)
    setClearFailed(false)
    const ok = await clearAll()
    setClearing(false)
    if (ok) {
      setConfirmClear(false)
      setExpandedOverrides({})
    } else {
      setClearFailed(true)
    }
  }

  function renderItem(n: Notification) {
    const sev = SEVERITY_STYLES[n.severity ?? 'info'] ?? SEVERITY_STYLES['info']!
    return (
      <div
        key={n.id}
        className={cn(
          'group flex items-start gap-2 border-b border-l-2 border-gray-100 px-3 py-2 last:border-b-0 dark:border-gray-800',
          sev.border,
          !n.isRead && 'bg-blue-50/60 dark:bg-blue-950/30',
        )}
      >
        <div className={cn('mt-0.5 shrink-0', sev.text)}>
          {/* Announcements' custom icon is header-banner-only (see AnnouncementBanner.tsx) — the bell always shows the plain severity icon for that kind. */}
          {n.kind !== 'announcement' && n.icon ? <DynamicIcon name={n.icon} className="h-3.5 w-3.5" /> : <sev.Icon className="h-3.5 w-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words text-xs text-gray-800 dark:text-gray-200">{linkifyText(n.message)}</p>
          <p className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
            {new Date(n.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {!n.isRead && (
            <button
              onClick={() => void markRead(n.id)}
              className="rounded p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
              aria-label={t('notifications.mark_read')}
              title={n.kind === 'nudge' ? t('notifications.mark_read_tip', "Mark read — won't remind you again today, but returns tomorrow if still relevant.") : t('notifications.mark_read')}
            >
              <Check className="h-3 w-3" />
            </button>
          )}
          {n.kind === 'nudge' && n.dedupeKey?.startsWith('nudge:') && (
            <button
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setSnoozeMenu((cur) => cur?.n.id === n.id ? null : { n, x: r.right, y: r.bottom })
              }}
              className="rounded p-1 text-gray-400 hover:text-amber-600 dark:hover:text-amber-400"
              aria-label={t('notifications.snooze', 'Snooze')}
              title={t('notifications.snooze_tip', 'Snooze — mute this reminder for a number of days you choose.')}
            >
              <BellOff className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={() => void dismiss(n.id)}
            className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
            aria-label={n.kind === 'nudge' ? t('nudge.close_out', 'Close out') : t('notifications.dismiss')}
            title={n.kind === 'nudge' ? t('nudge.close_out_tip', 'Close out — permanently stops this reminder. It will never show again.') : t('notifications.dismiss')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        title={t('notifications.title')}
        aria-label={t('notifications.title')}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <BellRing className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
              {t('notifications.title')}
            </p>
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <button
                  onClick={() => void markAllRead()}
                  className="flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
                >
                  <CheckCheck className="h-3 w-3" />
                  {t('notifications.mark_all_read')}
                </button>
              )}
              {items.length > 0 && (
                <button
                  onClick={() => { setConfirmClear(true); setClearFailed(false) }}
                  disabled={confirmClear}
                  className="flex items-center gap-1 text-xs text-red-600 hover:underline disabled:opacity-50 disabled:no-underline dark:text-red-400"
                  title={t('notifications.clear_all_tip')}
                >
                  <Trash2 className="h-3 w-3" />
                  {t('notifications.clear_all')}
                </button>
              )}
            </div>
          </div>
          {confirmClear && items.length > 0 && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              <p>{t('notifications.clear_all_confirm', { count: items.length })}</p>
              {clearFailed && <p className="mt-1 font-medium">{t('notifications.clear_all_failed')}</p>}
              <div className="mt-1.5 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmClear(false)}
                  disabled={clearing}
                  className="flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  <X className="h-3 w-3" />
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => void handleClearAll()}
                  disabled={clearing}
                  className="flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('notifications.clear_all')}
                </button>
              </div>
            </div>
          )}
          {items.length > 0 && (
            <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-1.5 dark:border-gray-700" role="group" aria-label={t('notifications.group_by')}>
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{t('notifications.group_by')}</span>
              {([['date', CalendarDays, 'notifications.group_by_date'], ['category', Tags, 'notifications.group_by_category']] as const).map(([mode, ModeIcon, key]) => (
                <button
                  key={mode}
                  onClick={() => changeGroupMode(mode)}
                  aria-pressed={groupMode === mode}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    groupMode === mode
                      ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800',
                  )}
                >
                  <ModeIcon className="h-3 w-3" />
                  {t(key)}
                </button>
              ))}
            </div>
          )}
          {syncFailedCount > 0 && (
            <div className="flex items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <span className="mt-0.5">⚠</span>
              <span>{t('notifications.sync_failed', { count: syncFailedCount })}</span>
            </div>
          )}
          {/* v1.242.0: approved work pointing at a meeting that no longer
              exists. Sits with the sync banner rather than in the item list
              because, like it, this is a live derived count with no row behind
              it — there'd be nothing to mark read or dismiss. */}
          {outlookDeletedCount > 0 && (
            <div className="flex items-start gap-1.5 border-b border-orange-200 bg-orange-50 px-3 py-1.5 text-[11px] text-orange-800 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
              <MailX className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t('notifications.outlook_deleted', { count: outlookDeletedCount })}</span>
            </div>
          )}
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-gray-400 dark:text-gray-500">
                {t('notifications.empty')}
              </p>
            ) : (
              groups.map((g, i) => {
                const expanded = expandedOverrides[g.key] ?? i === 0
                const GroupIcon = g.kind === 'month' ? CalendarDays : g.kind === 'announcement' ? Megaphone : Bell
                const Chevron = expanded ? ChevronDown : ChevronRight
                return (
                  <div key={g.key} className="border-b border-gray-200 last:border-b-0 dark:border-gray-700">
                    <button
                      onClick={() => setExpandedOverrides((cur) => ({ ...cur, [g.key]: !expanded }))}
                      aria-expanded={expanded}
                      className="sticky top-0 z-10 flex w-full items-center gap-1.5 bg-gray-50 px-3 py-1.5 text-left text-xs font-semibold text-gray-700 hover:bg-gray-100 dark:bg-gray-800/90 dark:text-gray-200 dark:hover:bg-gray-800"
                    >
                      <Chevron className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
                      <GroupIcon className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
                      <span className="min-w-0 truncate">{g.label}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-1.5 text-[10px] font-semibold',
                          g.unread > 0
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300'
                            : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
                        )}
                        title={t('notifications.group_count_tip', { count: g.items.length, unread: g.unread })}
                      >
                        {g.items.length}
                      </span>
                    </button>
                    {expanded && g.items.map(renderItem)}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
      {snoozeMenu && createPortal(
        <div
          ref={snoozeRef}
          className="fixed z-[100] w-40 overflow-hidden rounded-md border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
          style={{ left: Math.max(8, snoozeMenu.x - 160), top: snoozeMenu.y + 4 }}
        >
          <p className="border-b border-gray-100 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800 dark:text-gray-500">
            {t('notifications.snooze', 'Snooze this nudge')}
          </p>
          {[1, 7, 30].map((d) => (
            <button
              key={d}
              onClick={() => { const target = snoozeMenu.n; setSnoozeMenu(null); void snooze(target, d) }}
              className="block w-full px-2.5 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {t('notifications.snooze_days', { count: d, defaultValue: '{{count}} day' })}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

// Bottom-of-screen toast for the newest unread notification. Dismissible and
// re-shows when a newer unread arrives. Mounted once at the app shell level.
//
// v1.292.0: rebuilt to carry the same Mark read + Snooze icon pair as the
// notification bell and the weekly-view nudge card, with real hover
// explanations — it previously showed a single bare X with no tooltip that
// silently behaved like Mark read. Deliberately does NOT offer a permanent
// close-out; that stays exclusive to the bell (see CLAUDE.md §11).
export function NotificationToast() {
  const { t } = useTranslation()
  const { items, markRead, snooze } = useNotifications()
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const unread = items.filter((n) => !n.isRead && !dismissedIds.has(n.id))
  const top = unread[0]
  if (!top) return null
  const sev = TOAST_SEVERITY_STYLES[top.severity ?? 'info'] ?? TOAST_SEVERITY_STYLES['info']!

  async function handleMarkRead() {
    setSnoozeOpen(false)
    setDismissedIds((s) => new Set(s).add(top!.id))
    await markRead(top!.id)
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className={cn('pointer-events-auto relative flex max-w-md items-start gap-3 rounded-lg border px-4 py-3 shadow-lg', sev.border, sev.bg)}>
        <sev.Icon className={cn('mt-0.5 h-4 w-4 shrink-0', sev.text)} />
        <p className="min-w-0 flex-1 break-words text-sm text-gray-800 dark:text-gray-100">{linkifyText(top.message)}</p>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={() => void handleMarkRead()}
            className="rounded p-1 text-gray-500 hover:text-blue-700 dark:text-gray-300 dark:hover:text-blue-300"
            aria-label={t('notifications.mark_read')}
            title={top.kind === 'nudge' ? t('notifications.mark_read_tip', "Mark read — won't remind you again today, but returns tomorrow if still relevant.") : t('notifications.mark_read')}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          {top.kind === 'nudge' && top.dedupeKey?.startsWith('nudge:') && (
            <button
              onClick={() => setSnoozeOpen((v) => !v)}
              className="rounded p-1 text-gray-500 hover:text-amber-700 dark:text-gray-300 dark:hover:text-amber-300"
              aria-label={t('notifications.snooze', 'Snooze')}
              title={t('notifications.snooze_tip', 'Snooze — mute this reminder for a number of days you choose.')}
            >
              <BellOff className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {snoozeOpen && (
          <div className="absolute bottom-full right-0 z-10 mb-2 w-40 overflow-hidden rounded-md border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <p className="border-b border-gray-100 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800 dark:text-gray-500">
              {t('notifications.snooze', 'Snooze')}
            </p>
            {[1, 7, 30].map((d) => (
              <button
                key={d}
                onClick={() => {
                  setSnoozeOpen(false)
                  setDismissedIds((s) => new Set(s).add(top!.id))
                  void snooze(top!, d)
                }}
                className="block w-full px-2.5 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {t('notifications.snooze_days', { count: d, defaultValue: '{{count}} day' })}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
