import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { startOfWeek, addWeeks, addDays, format } from 'date-fns'
import { CalendarClock, ChevronLeft, ChevronRight, RefreshCw, Users, User, Globe, Clock, TrendingUp, CalendarDays, Briefcase, Layers, ClipboardCheck, Sunrise, CalendarCheck2, CalendarArrowDown } from 'lucide-react'
import { PageHeader } from '../components/ui/page-header.js'
import { Spinner } from '../components/ui/spinner.js'
import { Chip } from '../components/ui/chip.js'
import { MultiSelect } from '../components/ui/multi-select.js'
import { SingleSelect } from '../components/ui/single-select.js'
import { cn } from '../lib/utils.js'
import { busyHours } from '../lib/scheduling.js'
import { tzAbbrev } from '../lib/tz.js'
import type { SchedBlock, SchedUser } from '../hooks/useSchedulingWeek.js'
import { useTeam } from '../hooks/useTeam.js'
import { useCurrentUser } from '../hooks/useCurrentUser.js'
import { useFiscalConfig, fiscalLabelOf } from '../hooks/useFiscalConfig.js'
import { useSchedulingWeek } from '../hooks/useSchedulingWeek.js'
import { SchedulingGrid } from '../components/scheduling/SchedulingGrid.js'
import { FreeTimePanel } from '../components/scheduling/FreeTimePanel.js'
import { SchedulingCapacityPanel } from '../components/scheduling/SchedulingCapacityPanel.js'
import { SubteamFilter } from '../components/ui/subteam-filter.js'
import { DynamicIcon } from '../components/ui/icon-picker.js'

const RIGHT_WIDTH_KEY = 'impactiq.sched.rightWidth'
const RIGHT_WIDTH_MIN = 240
const RIGHT_WIDTH_DEFAULT = 340
const RIGHT_WIDTH_MAX = 620
const TOP_HEIGHT_KEY = 'impactiq.sched.rightTopHeight'
const TOP_HEIGHT_MIN = 200
const TOP_HEIGHT_DEFAULT = 460
const SHOW_WEEKENDS_KEY = 'impactiq.sched.showWeekends'
const WEEK_START_KEY = 'impactiq.sched.weekStartsMonday'
const HOURS_MODE_KEY = 'impactiq.sched.hoursMode'
const VIEW_KEY = 'impactiq.sched.view'

type ViewMode = 'all' | 'calendar' | 'logged'

// Filter a user's blocks for the selected View. "All" is a deduped union:
// every logged activity plus any calendar event that wasn't logged (so a
// meeting that became an activity isn't counted twice).
function filterBlocks(blocks: SchedBlock[], view: ViewMode): SchedBlock[] {
  if (view === 'calendar') return blocks.filter((b) => b.source === 'outlook')
  if (view === 'logged') return blocks.filter((b) => b.source === 'activity')
  return blocks.filter((b) => b.source === 'activity' || (b.source === 'outlook' && !b.logged))
}

export default function Scheduling() {
  const { t } = useTranslation()
  const { activeTeam, loading: teamLoading, activityTypes } = useTeam()
  const { user } = useCurrentUser()
  const fiscalCfg = useFiscalConfig()
  const [weekOffset, setWeekOffset] = useState(0)
  const [subteams, setSubteams] = useState<Array<{ id: string; name: string }>>([])
  const [members, setMembers] = useState<Array<{ id: string; displayName: string; timezone?: string }>>([])
  const [subteamIds, setSubteamIds] = useState<string[]>([])
  const [userIds, setUserIds] = useState<string[]>([])
  // v1.263.0: the caller's OWN subteam membership per team — PRD §7:
  // "Subteams should be checked by default for the user who is logged in.
  // The overall Team will have too many members." Fetched once; keyed by
  // teamId so switching teams re-derives the default from the right set.
  const [mySubteamsByTeam, setMySubteamsByTeam] = useState<Record<string, string[]>>({})
  useEffect(() => {
    void (async () => {
      const res = await fetch('/auth/me/teams').then((r) => r.json()).catch(() => null)
      const rows = (res?.data ?? []) as Array<{ teamId: string; subteams: Array<{ id: string }> }>
      const map: Record<string, string[]> = {}
      for (const r of rows) map[r.teamId] = r.subteams.map((s) => s.id)
      setMySubteamsByTeam(map)
    })()
  }, [])
  const [reloadKey, setReloadKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [showWeekends, setShowWeekends] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_WEEKENDS_KEY) !== '0' } catch { return true }
  })
  // v1.163.0: show the full 24-hour day vs only the work-hours band.
  const [hoursMode, setHoursMode] = useState<'all' | 'work'>(() => {
    try { return localStorage.getItem(HOURS_MODE_KEY) === 'work' ? 'work' : 'all' } catch { return 'all' }
  })
  useEffect(() => {
    try { localStorage.setItem(HOURS_MODE_KEY, hoursMode) } catch { /* ignore */ }
  }, [hoursMode])
  useEffect(() => {
    try { localStorage.setItem(SHOW_WEEKENDS_KEY, showWeekends ? '1' : '0') } catch { /* ignore */ }
  }, [showWeekends])
  // v1.236.0: same Sun-first/Mon-first display toggle as the Activities
  // page's Outlook Calendar panel — purely a column-order preference for
  // this page's own grid, tracked independently since Scheduling has its
  // own week/day computation. Default Sunday-first, matching Activities.
  const [weekStartsMonday, setWeekStartsMonday] = useState<boolean>(() => {
    try { return localStorage.getItem(WEEK_START_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(WEEK_START_KEY, weekStartsMonday ? '1' : '0') } catch { /* ignore */ }
  }, [weekStartsMonday])
  // Grid timezone override — defaults to the viewer's own zone, but the
  // header dropdown can switch to any teammate's zone in view.
  const [gridTz, setGridTz] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>(() => {
    try { const v = localStorage.getItem(VIEW_KEY); if (v === 'calendar' || v === 'logged' || v === 'all') return v } catch { /* ignore */ }
    return 'all'
  })
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view) } catch { /* ignore */ } }, [view])

  // v1.237.0: `mondayWeekStart` is the canonical Monday-anchored week
  // (offset navigation always steps by a fixed 7 days off it, regardless of
  // display mode). `weekStart` — used everywhere else in this file — is the
  // actual displayed/fetched range: unchanged when the toggle is Monday-
  // first, or shifted back one day to the preceding Sunday when it's
  // Sunday-first, giving a real Sun-Sat week (Sun Aug2–Sat Aug8), not a
  // reorder of Mon Aug3–Sun Aug9's trailing Sunday. Unlike the Activities
  // page's /api/activities (which recomputes its own week boundary
  // server-side via endOfWeek and must always get the unshifted Monday
  // value), /api/scheduling/week takes start/end as literal, trusted ISO
  // bounds — so shifting `weekStart` here is both correct and required for
  // the fetched window to match what's displayed.
  const mondayWeekStart = useMemo(() => startOfWeek(addWeeks(new Date(), weekOffset), { weekStartsOn: 1 }), [weekOffset])
  const weekStart = useMemo(() => (weekStartsMonday ? mondayWeekStart : addDays(mondayWeekStart, -1)), [mondayWeekStart, weekStartsMonday])
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])
  const allDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])
  const days = useMemo(() => (showWeekends ? allDays : allDays.filter((d) => { const dow = d.getDay(); return dow !== 0 && dow !== 6 })), [allDays, showWeekends])

  const weekLabel = `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'MMM d, yyyy')}`

  useEffect(() => {
    if (!activeTeam) { setSubteams([]); setMembers([]); return }
    void fetch(`/api/teams/${activeTeam.id}/subteams`).then((r) => r.json()).then((j) => setSubteams((j?.data ?? []) as Array<{ id: string; name: string }>)).catch(() => setSubteams([]))
    void fetch(`/api/teams/${activeTeam.id}/members`).then((r) => r.json()).then((j) => setMembers(((j?.data ?? []) as Array<{ id: string; displayName: string; timezone?: string }>))).catch(() => setMembers([]))
    // v1.263.0: default to the user's own subteam(s) on this team rather than
    // clearing the filter — the user's own defaultSubteamId (My Settings)
    // wins when it belongs to this team, else fall back to every subteam the
    // caller is actually a member of here.
    const own = mySubteamsByTeam[activeTeam.id] ?? []
    const preferred = user?.defaultSubteamId && own.includes(user.defaultSubteamId) ? [user.defaultSubteamId] : own
    setSubteamIds(preferred); setUserIds([])
  }, [activeTeam?.id, mySubteamsByTeam, user?.defaultSubteamId])

  const { data, loading, error } = useSchedulingWeek({
    teamId: activeTeam?.id ?? null,
    startIso: weekStart.toISOString(),
    endIso: addDays(weekStart, 7).toISOString(),
    subteamIds,
    userIds,
    reloadKey,
  })

  const rawUsers = data?.users ?? []
  // Apply the View filter to every user's blocks once; all panels (grid,
  // free-time, capacity, chips) render from the filtered set so the toggle
  // is consistent everywhere.
  const usersOut: SchedUser[] = useMemo(
    () => rawUsers.map((u) => ({ ...u, blocks: filterBlocks(u.blocks, view) })),
    [rawUsers, view],
  )

  // Effective timezone the grid renders in: the explicit choice, else the
  // viewer's zone, else the browser default (resolved inside tz helpers).
  const effectiveTz = gridTz ?? user?.timezone ?? null

  // Timezone dropdown options: the distinct zones of everyone in view, plus
  // the viewer's own so it's always selectable.
  const tzOptions = useMemo(() => {
    const seen = new Map<string, string>()
    const add = (tz?: string | null) => {
      if (!tz || seen.has(tz)) return
      seen.set(tz, `${tz} (${tzAbbrev(tz, weekStart)})`)
    }
    add(user?.timezone)
    for (const u of usersOut) add(u.timezone)
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }))
  }, [usersOut, user?.timezone, weekStart])

  // Header capacity chips.
  const totalBusy = usersOut.reduce((s, u) => s + busyHours(u), 0)
  const totalCap = usersOut.reduce((s, u) => s + (u.capacityHours ?? 0), 0)
  const utilPct = totalCap > 0 ? Math.round((totalBusy / totalCap) * 100) : 0

  // Resizable right column (80/20) — same mechanism as WeeklyView.
  const initialWidth = (() => { try { const r = localStorage.getItem(RIGHT_WIDTH_KEY); if (r) return Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, parseInt(r, 10) || RIGHT_WIDTH_DEFAULT)) } catch { /* ignore */ } return RIGHT_WIDTH_DEFAULT })()
  const [rightWidth, setRightWidth] = useState(initialWidth)
  const widthDrag = useRef<{ x: number; w: number } | null>(null)
  const initialTop = (() => { try { const r = localStorage.getItem(TOP_HEIGHT_KEY); if (r) return Math.max(TOP_HEIGHT_MIN, parseInt(r, 10) || TOP_HEIGHT_DEFAULT) } catch { /* ignore */ } return TOP_HEIGHT_DEFAULT })()
  const [topHeight, setTopHeight] = useState(initialTop)
  const heightDrag = useRef<{ y: number; h: number } | null>(null)

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (widthDrag.current) setRightWidth(Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, widthDrag.current.w + (widthDrag.current.x - e.clientX))))
      if (heightDrag.current) setTopHeight(Math.max(TOP_HEIGHT_MIN, heightDrag.current.h + (e.clientY - heightDrag.current.y)))
    }
    function onUp() {
      if (widthDrag.current) { widthDrag.current = null; try { localStorage.setItem(RIGHT_WIDTH_KEY, String(rightWidth)) } catch { /* ignore */ } }
      if (heightDrag.current) { heightDrag.current = null; try { localStorage.setItem(TOP_HEIGHT_KEY, String(topHeight)) } catch { /* ignore */ } }
      document.body.style.userSelect = ''; document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [rightWidth, topHeight])

  async function refresh() {
    if (!activeTeam) return
    setRefreshing(true)
    try {
      const r = await fetch('/api/scheduling/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: activeTeam.id, userIds: data?.users.map((u) => u.userId) ?? [] }),
      })
      if (r.status === 429) {
        const j = await r.json().catch(() => null)
        const sec = j?.meta?.retryAfterSec ?? 600
        alert(t('scheduling.refresh_throttled', 'Refresh available in {{min}} min.', { min: Math.ceil(sec / 60) }))
      } else if (r.ok) {
        setReloadKey((k) => k + 1)
      }
    } finally { setRefreshing(false) }
  }

  if (teamLoading) return <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6" /></div>
  if (!activeTeam) return <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('leader.no_team_selected', 'Select a team')}</div>

  const tzLabel = tzAbbrev(effectiveTz, weekStart)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={CalendarClock} title={t('nav.scheduling', 'Scheduling')} subtitle={activeTeam.name} />

      {/* Week nav bar (mirrors the Activities header) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center gap-1">
          <button onClick={() => setWeekOffset((w) => w - 1)} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label={t('weekly.prev_week', 'Previous week')}><ChevronLeft className="h-4 w-4" /></button>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{weekLabel}</span>
          <Chip variant="accent" size="xs" className="uppercase tracking-wide font-semibold" title={t('weekly.fiscal_period', 'Fiscal period')}>
            {/* Fiscal quarter/year label follows the canonical Monday-anchored
                week (matching the Activities page's chip), not the display
                toggle — a Sunday-first shift shouldn't flip which fiscal
                period this week is labeled as. */}
            {fiscalLabelOf(mondayWeekStart, fiscalCfg)}
          </Chip>
          <span className="ml-1 flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400" title={t('activity.timezone_note', { tz: effectiveTz })}>
            <Globe className="h-3 w-3" />
            {t('activity.timezone_note', { tz: tzLabel || effectiveTz })}
          </span>
          <button onClick={() => setWeekOffset((w) => w + 1)} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label={t('weekly.next_week', 'Next week')}><ChevronRight className="h-4 w-4" /></button>
          {weekOffset !== 0 && (
            <button onClick={() => setWeekOffset(0)} className="rounded px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">{t('activity.week.today', 'Today')}</button>
          )}
          <div className="ml-3 flex items-center gap-2">
            <Chip variant="info" icon={Users} title={t('scheduling.chip_people', '{{count}} people', { count: usersOut.length })}>{String(usersOut.length)}</Chip>
            <Chip variant="neutral" icon={Clock} title={t('scheduling.chip_busy', 'Total busy hours')}>{t('activity.week_stats.hours', { hours: totalBusy.toFixed(1) })}</Chip>
            <Chip variant={utilPct > 100 ? 'danger' : 'success'} icon={TrendingUp} title={t('scheduling.chip_util', 'Utilization vs capacity')}>{utilPct}%</Chip>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SubteamFilter
            teamId={activeTeam.id}
            subteams={subteams}
            subteamIds={subteamIds}
            onSubteamIdsChange={setSubteamIds}
            userIds={userIds}
            onUserIdsChange={setUserIds}
          />
          <MultiSelect
            label={t('scheduling.filter_users', 'Team members')}
            labelIcon={User}
            placeholder={t('leader.filter_user_all', 'All')}
            options={members.map((m) => ({ value: m.id, label: m.timezone ? `${m.displayName} [${tzAbbrev(m.timezone, weekStart)}]` : m.displayName, icon: User }))}
            selected={userIds}
            onChange={setUserIds}
          />
          <SingleSelect
            label={t('scheduling.filter_timezone', 'Timezone')}
            labelIcon={Globe}
            options={tzOptions}
            value={effectiveTz ?? ''}
            onChange={(v) => setGridTz(v || null)}
          />
          {/* View toggle — union / calendar-only / logged-only, to compare
              what's on the calendar vs what got logged. */}
          <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-900">
            <button type="button" onClick={() => setView('all')} title={t('scheduling.view_all_hint', 'Calendar + logged (deduped)')} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5', view === 'all' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300')}><Layers className="h-3 w-3" />{t('scheduling.view_all', 'All')}</button>
            <button type="button" onClick={() => setView('calendar')} title={t('scheduling.view_calendar_hint', 'Outlook calendar only')} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5', view === 'calendar' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300')}><CalendarDays className="h-3 w-3" />{t('scheduling.view_calendar', 'Calendar')}</button>
            <button type="button" onClick={() => setView('logged')} title={t('scheduling.view_logged_hint', 'Logged activities only')} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5', view === 'logged' ? 'bg-blue-600 font-medium text-white' : 'text-gray-600 dark:text-gray-300')}><ClipboardCheck className="h-3 w-3" />{t('scheduling.view_logged', 'Logged')}</button>
          </div>
          {/* Weekend toggle — v1.236.0: collapsed from a 2-button segmented
              control into a single icon-swapping button, matching the
              Activities page's Outlook Calendar panel. "Show weekends"
              (CalendarDays) is the default selected icon. */}
          <button
            type="button"
            onClick={() => setShowWeekends(!showWeekends)}
            title={showWeekends ? t('calendar.weekend_mode.show', 'Show weekends') : t('calendar.weekend_mode.hide', 'Weekdays only')}
            aria-label={showWeekends ? t('calendar.weekend_mode.show', 'Show weekends') : t('calendar.weekend_mode.hide', 'Weekdays only')}
            className="flex h-7 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {showWeekends ? <CalendarDays className="h-3.5 w-3.5" /> : <Briefcase className="h-3.5 w-3.5" />}
          </button>
          {/* v1.236.0: this page's own Sun-first/Mon-first week display —
              same toggle/icons as the Activities page. Default
              Sunday-first (calendar-check-2). */}
          <button
            type="button"
            onClick={() => setWeekStartsMonday(!weekStartsMonday)}
            title={weekStartsMonday ? t('calendar.week_start_mode.monday') : t('calendar.week_start_mode.sunday')}
            aria-label={weekStartsMonday ? t('calendar.week_start_mode.monday') : t('calendar.week_start_mode.sunday')}
            className="flex h-7 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {weekStartsMonday ? <CalendarArrowDown className="h-3.5 w-3.5" /> : <CalendarCheck2 className="h-3.5 w-3.5" />}
          </button>
          {/* v1.163.0: 24-hour vs work-hours grid (icon-only toggle). */}
          <button
            type="button"
            onClick={() => setHoursMode((m) => (m === 'all' ? 'work' : 'all'))}
            title={hoursMode === 'all' ? t('scheduling.hours_show_work', 'Showing 24 hours — click to show work hours only') : t('scheduling.hours_show_all', 'Showing work hours — click to show all 24 hours')}
            aria-label={hoursMode === 'all' ? t('scheduling.hours_show_work', 'Showing 24 hours — click to show work hours only') : t('scheduling.hours_show_all', 'Showing work hours — click to show all 24 hours')}
            className="flex h-7 w-8 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {hoursMode === 'all' ? <Clock className="h-3.5 w-3.5" /> : <Sunrise className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title={t('scheduling.refresh', 'Refresh from Outlook')}
            className="flex h-7 items-center gap-1 rounded border border-gray-200 bg-white px-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* v1.271.0: Activity Types legend — small color/icon key so a reader
          can tell which type each colored block on the grid below belongs
          to, without already knowing the team's palette. Same style as
          ActivitySubtypeBreakdown's legend; "None" (the inactive
          Non-Activity anchor type, §7) is filtered out like every other
          type picker in the app. */}
      {activityTypes.filter((at) => at.isActive).length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-1.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
          {activityTypes
            .filter((at) => at.isActive)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((at) => (
              <span key={at.id} className="flex items-center gap-1.5">
                {at.icon && <DynamicIcon name={at.icon} className="h-3.5 w-3.5 shrink-0" style={{ color: at.color ?? undefined }} />}
                {at.name}
              </span>
            ))}
        </div>
      )}

      {/* 80/20 split */}
      <div className="flex min-h-0 flex-1">
        {/* Left: week grid */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {loading && usersOut.length === 0 ? (
            <div className="flex flex-1 items-center justify-center"><Spinner className="h-5 w-5" /></div>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center text-sm text-rose-600 dark:text-rose-400">{error}</div>
          ) : (
            <SchedulingGrid days={days} users={usersOut} tz={effectiveTz} weekStart={weekStart} hoursMode={hoursMode} />
          )}
        </div>

        {/* Right column (resizable width) */}
        <div className="relative flex shrink-0 flex-col border-l border-gray-200 dark:border-gray-700" style={{ width: rightWidth }}>
          <div
            className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-blue-300 dark:hover:bg-blue-600"
            onMouseDown={(e) => { widthDrag.current = { x: e.clientX, w: rightWidth }; document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize' }}
            role="separator" aria-label={t('scheduling.resize_panel', 'Resize panel')}
          />
          {/* Top: free time */}
          <div style={{ height: topHeight }} className="min-h-0 shrink-0 overflow-hidden">
            <FreeTimePanel days={days} users={usersOut} tz={effectiveTz} weekStart={weekStart} />
          </div>
          {/* Horizontal divider */}
          <div
            role="separator" aria-label={t('scheduling.resize_capacity', 'Resize capacity panel')}
            onMouseDown={(e) => { heightDrag.current = { y: e.clientY, h: topHeight }; document.body.style.userSelect = 'none'; document.body.style.cursor = 'row-resize' }}
            className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-y border-gray-200 bg-gray-50 hover:bg-blue-200 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-blue-800"
          >
            <div className="h-0.5 w-8 rounded-full bg-gray-300 group-hover:bg-blue-500 dark:bg-gray-600" />
          </div>
          {/* Bottom: capacity */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <SchedulingCapacityPanel users={usersOut} weekStart={weekStart} />
          </div>
        </div>
      </div>
    </div>
  )
}
