import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { format, addDays, isSameDay } from 'date-fns'
import { weekOffsetForDate } from '../../shared/weekNav.js'
import { Plus, ChevronLeft, ChevronRight, Info, CalendarDays, AlertCircle, Clock, Bell, BellOff, ChevronDown, Palmtree, PanelRightOpen, Check, Globe, CalendarOff, ChevronsDownUp, ChevronsUpDown, ListChevronsDownUp, CalendarArrowUp, CalendarArrowDown, TrendingUp, User, UserPlus, UserLock, MapPin, List } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Spinner } from '../components/ui/spinner.js'
import { PageHeader } from '../components/ui/page-header.js'
import { NUDGE_READ_EVENT, dropNudgeNotification } from '../components/ui/notifications.js'
import { ActivityCard } from '../components/activities/ActivityCard.js'
import { ActivityForm } from '../components/activities/ActivityForm.js'
import { TemplateQuickButton } from '../components/activities/TemplateQuickButton.js'
import { RefreshOutlookButton } from '../components/activities/RefreshOutlookButton.js'
import { SuggestedActivityCard } from '../components/activities/SuggestedActivityCard.js'
import { useGongWeek, useGongTranscriptsEnabled } from '../hooks/useGongWeek.js'
import { useSuggestions, type Suggestion } from '../hooks/useSuggestions.js'
import { useOutlookDeleted } from '../hooks/useOutlookDeleted.js'
import { DeletedActivitiesSection } from '../components/activities/DeletedActivitiesSection.js'
import { CalendarPanel } from '../components/calendar/CalendarPanel.js'
import { EventDetailsModal } from '../components/calendar/EventDetailsModal.js'
import { useCalendarEvents, useOutlookStatus, type CalendarEvent } from '../hooks/useCalendar.js'
import { MonthHeatmap } from '../components/activities/MonthHeatmap.js'
import { CapacityPie } from '../components/activities/CapacityPie.js'
import { WeeklyCapacityBar } from '../components/activities/WeeklyCapacityBar.js'
import { Chip } from '../components/ui/chip.js'
import { ActivityTypePie } from '../components/activities/ActivityTypePie.js'
import { AcvImpactTiles } from '../components/activities/AcvImpactTiles.js'
import { DisplayCurrencyProvider } from '../lib/displayCurrency.js'
import { useCurrentUser } from '../hooks/useCurrentUser.js'
import { useIsMobile } from '../hooks/useIsMobile.js'
import { usePto } from '../hooks/usePto.js'
import { useActivities, type Activity } from '../hooks/useActivities.js'
import { useNonActivities } from '../hooks/useNonActivities.js'
import { useTeam } from '../hooks/useTeam.js'
import { api } from '../lib/api.js'
import { cn } from '../lib/utils.js'
import { useFiscalConfig, fiscalLabelOf } from '../hooks/useFiscalConfig.js'
import { isRealMeetingLoad } from '../../shared/meetingLoad.js'

interface NudgeNotification {
  ruleId: string
  message: string
  triggerType: string
}

const RIGHT_COLUMN_WIDTH_KEY = 'impactiq.rightColumnWidth'
const RIGHT_COLUMN_MIN = 380
const RIGHT_COLUMN_DEFAULT = 640
const RIGHT_COLUMN_MAX = 960
const CALENDAR_HEIGHT_KEY = 'impactiq.rightCalendarHeight'
const CALENDAR_HEIGHT_MIN = 240
const CALENDAR_HEIGHT_DEFAULT = 520

function VerticalSplit({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) {
  const { t } = useTranslation()
  // Whether the user has an explicit saved calendar height. When they don't,
  // we default the calendar to 70% of the column's height (measured on mount)
  // so the layout is dynamic to the viewport rather than a fixed pixel value.
  const hasStored = React.useRef<boolean>(false)
  const initial = (() => {
    try {
      const raw = localStorage.getItem(CALENDAR_HEIGHT_KEY)
      if (raw) { hasStored.current = true; return Math.max(CALENDAR_HEIGHT_MIN, parseInt(raw, 10) || CALENDAR_HEIGHT_DEFAULT) }
    } catch { /* ignore */ }
    return CALENDAR_HEIGHT_DEFAULT
  })()
  const [topHeight, setTopHeight] = useState<number>(initial)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const dragStart = React.useRef<{ y: number; h: number } | null>(null)

  // Default the calendar to 70% of the available column height (dynamic) until
  // the user drags to their own preference.
  React.useLayoutEffect(() => {
    if (hasStored.current) return
    const h = containerRef.current?.clientHeight ?? 0
    if (h > 0) setTopHeight(Math.max(CALENDAR_HEIGHT_MIN, Math.round(h * 0.60)))
  }, [])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragStart.current) return
      const dy = e.clientY - dragStart.current.y
      const next = Math.max(CALENDAR_HEIGHT_MIN, dragStart.current.h + dy)
      setTopHeight(next)
    }
    function onUp() {
      if (!dragStart.current) return
      dragStart.current = null
      try { localStorage.setItem(CALENDAR_HEIGHT_KEY, String(topHeight)) } catch { /* ignore */ }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [topHeight])

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-1 flex-col">
      <div style={{ height: topHeight }} className="min-h-0 shrink-0 overflow-hidden">
        {top}
      </div>
      <div
        role="separator"
        aria-label={t('weekly.resize_calendar_height', 'Resize calendar height')}
        onMouseDown={(e) => {
          dragStart.current = { y: e.clientY, h: topHeight }
          document.body.style.userSelect = 'none'
          document.body.style.cursor = 'row-resize'
        }}
        className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-y border-gray-200 bg-gray-50 transition-colors hover:bg-blue-200 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-blue-800"
      >
        <div className="h-0.5 w-8 rounded-full bg-gray-300 group-hover:bg-blue-500 dark:bg-gray-600" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{bottom}</div>
    </div>
  )
}

function ResizableRightColumn({
  children,
  collapsed,
  onExpand,
}: {
  children: React.ReactNode
  collapsed: boolean
  onExpand: () => void
}) {
  const { t } = useTranslation()
  const initial = (() => {
    try {
      const raw = localStorage.getItem(RIGHT_COLUMN_WIDTH_KEY)
      if (raw) return Math.min(RIGHT_COLUMN_MAX, Math.max(RIGHT_COLUMN_MIN, parseInt(raw, 10) || RIGHT_COLUMN_DEFAULT))
    } catch { /* localStorage may be unavailable */ }
    return RIGHT_COLUMN_DEFAULT
  })()
  const [width, setWidth] = useState<number>(initial)
  const dragStart = React.useRef<{ x: number; w: number } | null>(null)

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragStart.current) return
      const dx = dragStart.current.x - e.clientX
      const next = Math.min(RIGHT_COLUMN_MAX, Math.max(RIGHT_COLUMN_MIN, dragStart.current.w + dx))
      setWidth(next)
    }
    function onUp() {
      if (!dragStart.current) return
      dragStart.current = null
      try { localStorage.setItem(RIGHT_COLUMN_WIDTH_KEY, String(width)) } catch { /* ignore */ }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [width])

  if (collapsed) {
    return (
      <div className="flex w-8 shrink-0 flex-col items-center border-l border-gray-200 bg-white py-4 dark:border-gray-700 dark:bg-gray-900">
        <button
          type="button"
          onClick={onExpand}
          className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          aria-label={t('weekly.expand_right_panel', 'Expand right panel')}
          title={t('weekly.expand', 'Expand')}
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    )
  }
  return (
    <div className="relative flex shrink-0 flex-col overflow-hidden" style={{ width }}>
      <div
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-blue-300 dark:hover:bg-blue-600"
        onMouseDown={(e) => {
          dragStart.current = { x: e.clientX, w: width }
          document.body.style.userSelect = 'none'
          document.body.style.cursor = 'col-resize'
        }}
        aria-label={t('weekly.resize_calendar_column', 'Resize calendar column')}
        role="separator"
      />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

function nudgeIconFor(triggerType: string): { icon: typeof AlertCircle; bg: string; fg: string } {
  switch (triggerType) {
    case 'no_activity_days':
      return { icon: Clock, bg: 'bg-yellow-100 dark:bg-yellow-900/40', fg: 'text-yellow-700 dark:text-yellow-300' }
    case 'stage_no_type':
      return { icon: AlertCircle, bg: 'bg-amber-100 dark:bg-amber-900/40', fg: 'text-amber-700 dark:text-amber-300' }
    case 'type_no_followup':
      return { icon: Bell, bg: 'bg-indigo-100 dark:bg-indigo-900/40', fg: 'text-indigo-700 dark:text-indigo-300' }
    default:
      return { icon: AlertCircle, bg: 'bg-amber-100 dark:bg-amber-900/40', fg: 'text-amber-700 dark:text-amber-300' }
  }
}

export default function WeeklyView() {
  const { t, i18n: i18nHook } = useTranslation()
  const { activeTeam, active, activityTypes, loading: teamLoading } = useTeam()
  const fiscalCfg = useFiscalConfig()
  const { user: currentUser } = useCurrentUser()
  // Default the Activities page to the caller's own week — the "my day"
  // scope. Admins/leaders can pick a specific teammate via the person
  // switcher on the Outlook column header to inspect their week.
  const [viewingUserId, setViewingUserId] = useState<string | null>(null)
  const [templateSeedId, setTemplateSeedId] = useState<string | null>(null)
  useEffect(() => {
    if (currentUser?.id && !viewingUserId) setViewingUserId(currentUser.id)
  }, [currentUser?.id])
  // v1.233.0: the v1.228.0 fix only refreshed the person switcher's member
  // LIST on a team switch (see CalendarPanel.tsx's PersonSwitcher) — the
  // SELECTED person was left untouched. That left the switcher showing a
  // stale label (or an id that's no longer even in the new team's roster,
  // silently querying activities/calendar/suggestions for a person outside
  // the newly-selected team). Reset back to "self" — the only value that's
  // always valid regardless of which team is active — whenever the active
  // team changes, mirroring the initial-mount default above.
  const prevActiveTeamIdRef = useRef<string | null>(null)
  useEffect(() => {
    const teamId = activeTeam?.id ?? null
    if (teamId && prevActiveTeamIdRef.current && teamId !== prevActiveTeamIdRef.current) {
      setViewingUserId(currentUser?.id ?? null)
    }
    prevActiveTeamIdRef.current = teamId
  }, [activeTeam?.id, currentUser?.id])
  // Sun-first / Mon-first toggle (see the `displayWeekStart` note below).
  // Declared before the deep-link effect and `useActivities`, which both need
  // it to pick the right week (v1.456.1).
  const [calendarWeekStartsMonday, setCalendarWeekStartsMonday] = useState<boolean>(() => {
    try { return localStorage.getItem('activities.weekStartsMonday') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('activities.weekStartsMonday', calendarWeekStartsMonday ? '1' : '0') } catch { /* ignore */ }
  }, [calendarWeekStartsMonday])
  // Drill-down support: leader dashboards navigate here with
  // ?userId=X&startDate=Y&endDate=Z to inspect a specific contributor + week.
  // Reads once on mount so the query string acts as a hand-off, not a
  // persistent filter.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const sp = new URLSearchParams(window.location.search)
    const uid = sp.get('userId')
    if (uid) setViewingUserId(uid)
    const startDate = sp.get('startDate')
    if (startDate) {
      const target = new Date(startDate + 'T00:00:00')
      if (!Number.isNaN(target.getTime())) {
        // v1.456.1: the week that DISPLAYS the target day under the current
        // Sun-first/Mon-first toggle (a Sunday target used to land a week early).
        setWeekOffset(weekOffsetForDate(target, calendarWeekStartsMonday))
      }
    }
    // Intentionally an effect that only runs once — subsequent nav within
    // the page updates viewingUserId/weekOffset directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // While currentUser is loading, viewingUserId can briefly be null. Fall
  // back to the caller's own id so the initial fetch never shows the whole
  // team when the person switcher hasn't intentionally been cleared.
  const effectiveViewingUserId = viewingUserId ?? currentUser?.id ?? null
  const { activities, loading, error, weekStart, weekOffset, setWeekOffset, reload } =
    useActivities(activeTeam?.id ?? null, effectiveViewingUserId, calendarWeekStartsMonday)

  // v1.235.0/v1.237.0: Sun-first vs Mon-first week display, shared by the
  // left-side activity list and the Outlook Calendar panel. Default
  // Sunday-first, per request. This is a genuine calendar-week shift, not a
  // reorder of the same 7 days: `weekStart` above is always the app's
  // canonical Monday-anchored week (activity list grouping, capacity math,
  // and /api/activities' own server-side `endOfWeek` all depend on it
  // staying that way — never feed a shifted value into `useActivities`).
  // `displayWeekStart` is the actual first day of the 7 days this page
  // DISPLAYS: unchanged (Monday) when the toggle is on, or the Sunday
  // immediately before it when off — i.e. Sun Aug2–Sat Aug8, not Mon
  // Aug3–Sun Aug9's trailing Sunday rotated to the front. Every real
  // data-fetch window below (PTO, suggestions, calendar events, holidays)
  // must use `displayWeekStart`, since none of those routes recompute the
  // week boundary server-side — they trust whatever range the client sends.
  const displayWeekStart = calendarWeekStartsMonday ? weekStart : addDays(weekStart, -1)

  const [formOpen, setFormOpen] = useState(false)
  const [editActivity, setEditActivity] = useState<Activity | null>(null)
  // v1.460.0: drawer tab to open on (the card's Transcripts icon asks for Transcripts).
  const [editInitialTab, setEditInitialTab] = useState<'edit' | 'transcripts'>('edit')

  // Deep-link support: /activities?openActivityId=<id>[&start=<iso>] opens
  // that activity's edit drawer. Used by Admin → Sync History rows so an
  // admin can click through to the affected activity. If the id isn't in
  // this week's loaded set, we ignore (user shifts weeks manually).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('openActivityId')
    if (!id) return
    const match = activities.find((a) => a.id === id)
    if (match) {
      setEditActivity(match)
      setPrefill(null)
      setFormOpen(true)
      params.delete('openActivityId')
      params.delete('start')
      const q = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${q ? '?' + q : ''}`)
    }
  }, [activities])
  const [prefill, setPrefill] = useState<{ outlookEventId: string; title: string; startDatetime: string; endDatetime: string; activityTypeId?: string | null; descriptionBody?: string; meetingOwner?: string; meetingOwnerEmail?: string | null; attendees?: { name?: string; email?: string }[]; isAllDay?: boolean; eventType?: string; seriesMasterId?: string; isPrivate?: boolean } | null>(null)
  const [nudges, setNudges] = useState<NudgeNotification[]>([])
  // Which nudge the stacked card shows (clamped at render when the list shrinks).
  const [nudgeIndex, setNudgeIndex] = useState(0)
  // v1.287.0: snooze-duration menu for the nudge card, portaled outside the
  // card's own layout so ancestor `overflow` can't clip it — same pattern
  // as the notification bell's snooze menu.
  const [nudgeSnoozeMenu, setNudgeSnoozeMenu] = useState<{ ruleId: string; x: number; y: number } | null>(null)
  const nudgeSnoozeMenuRef = useRef<HTMLDivElement>(null)
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const [typeFilterId, setTypeFilterId] = useState<string | null>(null)
  // v1.342.0: a Weekly Capacity chip filter is scoped to the week it was
  // clicked on. Carrying it across a week navigation left the capacity bar
  // showing the new week's real per-type totals while the activity list
  // silently kept filtering to a type id that may not exist that week, with
  // no "Showing X only" banner to explain why — filteredTypeName (below)
  // falls back to null the moment the new week has no matching activity, so
  // the banner just disappears instead of naming the stale filter. Reset on
  // every week change so a filter never survives navigating away from the
  // week it was set on.
  // Keyed on `weekOffset` (a primitive from useActivities), NOT `weekStart` —
  // weekStart is `startOfWeek(addWeeks(new Date(), weekOffset), ...)`,
  // recomputed to a brand-new Date object on every render, so using it as a
  // dependency here fired this effect on every render (not just real week
  // navigation) and reset the filter the instant it was set.
  useEffect(() => {
    setTypeFilterId(null)
  }, [weekOffset])
  const { ptoDates, togglePto } = usePto(displayWeekStart, addDays(displayWeekStart, 6))
  const { suggestions, reload: reloadSuggestions, nonActivityColor } = useSuggestions(activeTeam?.id ?? null, displayWeekStart, viewingUserId ?? currentUser?.id ?? null)
  const [calendarReloadKey, setCalendarReloadKey] = useState(0)
  // v1.118.0: single-source refresh used by every mutation path
  // (Approve, Approve-with-template, drawer Save/Save & Approve,
  // Delete, Unapprove). Activities, suggestions, AND calendar all
  // refetch together so the left-side list, right-side calendar
  // badges, and Suggested cards can't drift out of sync.
  const reloadAll = useCallback(() => {
    void reload()
    void reloadSuggestions()
    setCalendarReloadKey((k) => k + 1)
  }, [reload, reloadSuggestions])
  // v1.456.0: "Recorded in Gong" / "Gong call" marks, own week only.
  const transcriptsIconEnabled = useGongTranscriptsEnabled(activeTeam?.id)
  const gongMarks = useGongWeek(
    !!currentUser?.id && effectiveViewingUserId === currentUser.id,
    displayWeekStart.getTime(),
    addDays(displayWeekStart, 7).getTime(),
    calendarReloadKey,
  )
  const [calendarViewMode, setCalendarViewMode] = useState<'all_meetings' | 'activities_approved' | 'not_approved'>('all_meetings')
  // All four toolbar toggles below persist to localStorage so a user's
  // preferences carry across refreshes and logout/login. Keys are
  // namespaced under `activities.*` so they're easy to trace.
  const [calendarShowWeekends, setCalendarShowWeekends] = useState<boolean>(() => {
    try { return localStorage.getItem('activities.showWeekends') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('activities.showWeekends', calendarShowWeekends ? '1' : '0') } catch { /* ignore */ }
  }, [calendarShowWeekends])
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(false)
  // v1.419.0: on a phone there's no room for the list and the calendar side
  // by side, so the page shows one pane at a time with a List / Calendar
  // toggle in the week bar. Always opens on the list.
  const isMobile = useIsMobile()
  const [mobilePane, setMobilePane] = useState<'list' | 'calendar'>('list')
  const [detailsEvent, setDetailsEvent] = useState<CalendarEvent | null>(null)
  const [showNonActivities, setShowNonActivities] = useState<boolean>(() => {
    try { return localStorage.getItem('activities.showNonActivities') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('activities.showNonActivities', showNonActivities ? '1' : '0') } catch { /* ignore */ }
  }, [showNonActivities])
  const [compactApproved, setCompactApproved] = useState<boolean>(() => {
    try { return localStorage.getItem('activities.compactApproved') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('activities.compactApproved', compactApproved ? '1' : '0') } catch { /* ignore */ }
  }, [compactApproved])
  // Per-day sort direction. Descending = earliest at the top (SF /
  // Outlook convention). Ascending = latest at the top.
  const [dayAsc, setDayAsc] = useState<boolean>(() => {
    try { return localStorage.getItem('activities.dayAsc') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('activities.dayAsc', dayAsc ? '1' : '0') } catch { /* ignore */ }
  }, [dayAsc])
  // v1.240.0: cycles All -> Optional -> Required -> All. Filters UNAPPROVED
  // (suggested) meetings only, by whether the CURRENT user's own Graph
  // attendee entry on that meeting is required or optional — never approved
  // activities, which don't retain per-attendee type once logged.
  //
  // Deliberately keyed off currentUser's own email rather than whoever's week
  // is being viewed: a leader browsing an SE's week is essentially never
  // themselves an attendee on that SE's meetings, so Optional/Required would
  // filter down to nothing for them anyway. This isn't special-cased — it's
  // the same computation in both cases, and correctly filters most things out
  // for a leader, which is the honest answer for "am I on this meeting".
  const [myAttendeeFilter, setMyAttendeeFilter] = useState<'all' | 'optional' | 'required'>(() => {
    try {
      const v = localStorage.getItem('activities.myAttendeeFilter')
      return v === 'optional' || v === 'required' ? v : 'all'
    } catch { return 'all' }
  })
  useEffect(() => {
    try { localStorage.setItem('activities.myAttendeeFilter', myAttendeeFilter) } catch { /* ignore */ }
  }, [myAttendeeFilter])
  const { ids: nonActivityIds, mark: markNonActivity, unmark: unmarkNonActivity } = useNonActivities()
  // v1.242.0: approved activities whose Outlook meeting was deleted. Scoped to
  // the displayed week for the review section; the hook's totalCount covers
  // every week (the bell/header banner use their own global count).
  const {
    items: deletedItems,
    busy: deletedBusy,
    keep: keepDeleted,
    purge: purgeDeleted,
  } = useOutlookDeleted(displayWeekStart, calendarReloadKey)

  useEffect(() => {
    if (!activeTeam) return
    api.get<NudgeNotification[]>(`/api/nudges?teamId=${activeTeam.id}&locale=${encodeURIComponent(i18nHook.language || 'en')}`).then((res) => {
      setNudges(res.data ?? [])
      setNudgeIndex(0)
    })
  }, [activeTeam?.id, i18nHook.language])

  // When a nudge is read/snoozed from the notifications bell, drop its banner
  // here immediately instead of waiting for a reload (the bell + this banner
  // are separate data sources).
  useEffect(() => {
    const onRead = (e: Event) => {
      const ruleIds = (e as CustomEvent<{ ruleIds?: string[] }>).detail?.ruleIds
      if (!ruleIds?.length) return
      const drop = new Set(ruleIds)
      setNudges((n) => n.filter((x) => !drop.has(x.ruleId)))
    }
    window.addEventListener(NUDGE_READ_EVENT, onRead)
    return () => window.removeEventListener(NUDGE_READ_EVENT, onRead)
  }, [])

  // Close the snooze menu on an outside click or scroll — its position is a
  // fixed rect captured at open time, so scrolling would leave it floating
  // over the wrong spot. Trigger buttons stopPropagation on mousedown (see
  // render below) so clicking one to toggle it open doesn't also trip this.
  useEffect(() => {
    if (!nudgeSnoozeMenu) return
    function close(e: MouseEvent) {
      if (nudgeSnoozeMenuRef.current && !nudgeSnoozeMenuRef.current.contains(e.target as Node)) {
        setNudgeSnoozeMenu(null)
      }
    }
    function onScroll() { setNudgeSnoozeMenu(null) }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [nudgeSnoozeMenu])

  // v1.292.0: "mark read" — mutes the rule until next UTC midnight, same
  // semantic as the notification bell's checkmark (and now the only
  // non-snooze dismiss action this card offers — permanent close-out moved
  // to the bell exclusively, see CLAUDE.md §11).
  async function markReadNudge(ruleId: string) {
    setNudges((n) => n.filter((x) => x.ruleId !== ruleId))
    await api.post('/api/nudges/mark-read', { ruleId })
    // Keep the bell's notification list/badge in sync immediately — it has
    // its own cached copy of the same nudge and previously only dropped it
    // on its next 60s poll, so the two surfaces could disagree about
    // whether a nudge was still active.
    dropNudgeNotification(ruleId)
  }

  async function snoozeNudge(ruleId: string, days: number) {
    setNudgeSnoozeMenu(null)
    setNudges((n) => n.filter((x) => x.ruleId !== ruleId))
    await api.post('/api/nudges/dismiss', { ruleId, days })
    dropNudgeNotification(ruleId)
  }

  function openNew() {
    setEditActivity(null)
    setPrefill(null)
    setFormOpen(true)
  }

  function openEdit(activity: Activity, tab?: 'transcripts') {
    setEditInitialTab(tab ?? 'edit')
    setEditActivity(activity)
    setPrefill(null)
    setFormOpen(true)
  }

  function closeForm() {
    setFormOpen(false)
    setEditInitialTab('edit')
    setEditActivity(null)
    setPrefill(null)
    setTemplateSeedId(null)
  }

  // Group activities by day, respecting the top-bar view mode:
  //  - all_meetings: approved activities + suggested (unapproved) meetings
  //  - activities_approved: only approved activities
  //  - not_approved: only suggested (unapproved) meetings
  // v1.237.0: `displayWeekStart` (computed above) is already the correct
  // first day of the 7 dates to show — Monday or the Sunday before it —
  // so this is a plain sequential span, not a reorder of `weekStart`.
  const allDays = Array.from({ length: 7 }, (_, i) => addDays(displayWeekStart, i))
  const days = calendarShowWeekends ? allDays : allDays.filter((d) => { const dow = d.getDay(); return dow !== 0 && dow !== 6 })
  const showApproved = calendarViewMode !== 'not_approved'
  const showSuggestions = calendarViewMode !== 'activities_approved'
  const filteredActivities = typeFilterId
    ? activities.filter((a) => a.activityTypeId === typeFilterId)
    : activities
  const filteredTypeName = typeFilterId
    ? activities.find((a) => a.activityTypeId === typeFilterId)?.activityTypeName ?? null
    : null
  const filteredTypeColor = typeFilterId
    ? activities.find((a) => a.activityTypeId === typeFilterId)?.activityTypeColor ?? null
    : null
  const sortDir = dayAsc ? 1 : -1
  // v1.240.0: the current user's own attendee.type on a suggested meeting.
  // Graph omits the organizer from `attendees` entirely, so a meeting the
  // user organized themselves — a self-scheduled call later marked Non-
  // Activity, say — has no attendee entry for them at all. Falling through
  // to organizerEmail treats that as Required (organizing is at least as
  // "required" as being invited), rather than resolving to null and getting
  // hidden by the Optional/Required filter no matter which state is picked.
  const myEmail = currentUser?.email?.toLowerCase() ?? null
  function myAttendeeType(s: Suggestion): 'required' | 'optional' | null {
    if (!myEmail) return null
    const mine = s.attendees?.find((a) => a.email?.toLowerCase() === myEmail)
    if (mine) return mine.type === 'optional' ? 'optional' : 'required'
    if (s.organizerEmail?.toLowerCase() === myEmail) return 'required'
    return null
  }
  const byDay = days.map((day) => ({
    day,
    items: showApproved
      ? filteredActivities
          .filter((a) => isSameDay(new Date(a.startDatetime), day))
          .slice()
          .sort((a, b) => sortDir * (new Date(a.startDatetime).getTime() - new Date(b.startDatetime).getTime()))
      : [],
    // Suggestions aren't tied to an activity type yet — hide them entirely
    // when the user is filtering by type so the day list only shows the
    // matching entries.
    suggestions: showSuggestions && !typeFilterId
      ? suggestions
          .filter((s) => {
            const isNonActivity = nonActivityIds.has(s.outlookEventId) || s.isNonActivitySuggestion
            if (!isSameDay(new Date(s.start), day)) return false
            if (!showNonActivities && isNonActivity) return false
            if (myAttendeeFilter !== 'all' && myAttendeeType(s) !== myAttendeeFilter) return false
            return true
          })
          .slice()
          .sort((a, b) => sortDir * (new Date(a.start).getTime() - new Date(b.start).getTime()))
      : [],
  }))

  // Week-level counters displayed next to the week nav. Meetings = Outlook
  // events for the week (approved + not). Falls back to suggestion count when
  // Outlook is not connected.
  const { status: outlookStatus } = useOutlookStatus()
  const { events: weekEvents } = useCalendarEvents(displayWeekStart, !!outlookStatus?.connected, effectiveViewingUserId, calendarReloadKey)
  // Meetings = approved activities linked to the week + not-approved
  // suggested meetings. Prefer the raw Outlook events count when it exceeds
  // both (accounts for calendar events not yet turned into suggestions).
  const combinedCount = suggestions.length + activities.length
  const weekMeetingCount = Math.max(combinedCount, weekEvents.length)
  const weekApprovedCount = activities.length
  const weekTotalHours = activities.reduce((s, a) => s + Number(a.effortHours), 0)
  // Hours from Outlook meetings this week that aren't logged as ImpactIQ
  // activities — both Non-Activity-marked and simply uncategorized. They still
  // consume capacity, so the weekly bar shows them as a dark-grey block.
  // alreadyLogged events are excluded (their hours live in the activity
  // segments); isRealMeetingLoad additionally excludes all-day, cancelled,
  // declined, and non-busy/tentative/oof events — the same predicate
  // resolver.ts's calendar_derived capacity method and the leader-dashboard
  // "Meeting Load" figure use server-side (CLAUDE.md §12.1, v1.309.0 fix —
  // this client-side math previously only excluded alreadyLogged/isAllDay).
  const otherMeetingHours = useMemo(
    () => weekEvents.reduce((sum, e) => {
      if (e.alreadyLogged) return sum
      if (!isRealMeetingLoad(e)) return sum
      const hrs = (new Date(e.end).getTime() - new Date(e.start).getTime()) / 3_600_000
      return sum + (Number.isFinite(hrs) && hrs > 0 ? hrs : 0)
    }, 0),
    [weekEvents],
  )

  // v1.241.0: outlookEventId -> the viewer's own RSVP, so an APPROVED
  // activity can still show the tentative hatch. Derived from the live
  // calendar rather than a column on `activities` on purpose: the RSVP can
  // change after approval, and the user asked for the stripe to track that
  // instead of freezing at approval time. Covers the writeback id too, since
  // an ImpactIQ-created event is the one linked for those.
  const tentativeEventIds = useMemo(() => {
    const s = new Set<string>()
    for (const e of weekEvents) {
      if (e.responseStatus === 'tentativelyAccepted') s.add(e.id)
    }
    return s
  }, [weekEvents])

  // v1.321.0: outlookEventId -> the live event's organizer name/email. A
  // card renders the activity's own stored meetingOwnerEmail, but a legacy
  // activity approved before v1.319.0 added that column has a stored owner
  // NAME with a null email — this backfills the hover tooltip from the
  // still-linked calendar event (only when the organizer name matches the
  // stored owner, same guard as ActivityForm's edit-drawer fallback), same
  // pattern as tentativeEventIds above.
  const organizerByEventId = useMemo(() => {
    const m = new Map<string, { name: string; email: string }>()
    for (const e of weekEvents) {
      if (e.organizer?.email) m.set(e.id, e.organizer)
    }
    return m
  }, [weekEvents])

  // Default-expanded state: only today's card expanded on load; every other day collapsed.
  // Re-derived when the week changes so today is respected.
  useEffect(() => {
    const initial = new Set<string>()
    for (const d of days) {
      if (!isSameDay(d, new Date())) initial.add(d.toISOString())
    }
    setCollapsedDays(initial)
  }, [weekStart.getTime()])

  function toggleDay(iso: string) {
    setCollapsedDays((prev) => {
      const next = new Set(prev)
      if (next.has(iso)) next.delete(iso)
      else next.add(iso)
      return next
    })
  }
  function expandAll() { setCollapsedDays(new Set()) }
  function collapseAll() { setCollapsedDays(new Set(days.map((d) => d.toISOString()))) }

  const userTimezone = currentUser?.timezone
    || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC')

  const weekLabel = `${format(displayWeekStart, 'MMM d')} – ${format(addDays(displayWeekStart, 6), 'MMM d, yyyy')}`
  const prevStart = addDays(displayWeekStart, -7)
  const nextStart = addDays(displayWeekStart, 7)
  const prevRangeLabel = `${format(prevStart, 'MMM d')} – ${format(addDays(prevStart, 6), 'MMM d, yyyy')}`
  const nextRangeLabel = `${format(nextStart, 'MMM d')} – ${format(addDays(nextStart, 6), 'MMM d, yyyy')}`

  if (teamLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (!activeTeam) {
    const allTeamsSelected = active?.isAll === true
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
        <Info className="h-8 w-8" />
        <p className="text-sm">
          {allTeamsSelected
            ? t('activities.all_teams_pick_one')
            : t('activities.no_team_membership')}
        </p>
      </div>
    )
  }

  // The calendar and the panels under it, shared by the desktop right column
  // and the phone's Calendar pane so the two can't drift.
  const calendarPanel = (
    <CalendarPanel
      weekStart={displayWeekStart}
      activities={activities}
      suggestions={suggestions}
      reloadKey={calendarReloadKey}
      viewMode={calendarViewMode}
      onViewModeChange={setCalendarViewMode}
      showWeekends={calendarShowWeekends}
      onShowWeekendsChange={setCalendarShowWeekends}
      weekStartsMonday={calendarWeekStartsMonday}
      onWeekStartsMondayChange={setCalendarWeekStartsMonday}
      onCollapseRight={() => { if (isMobile) setMobilePane('list'); else setRightCollapsed(true) }}
      onEventClick={(evt) => setDetailsEvent(evt)}
      onWeekChange={setWeekOffset}
      weekOffset={weekOffset}
      activeTeamId={activeTeam.id}
      viewingUserId={viewingUserId}
      onViewingUserChange={setViewingUserId}
      onActivityClick={(a) => openEdit(a)}
      nonActivityIds={nonActivityIds}
      showNonActivities={showNonActivities}
    />
  )
  const calendarExtras = (
    <>
      {/* Heatmap renders at its natural height so the full month grid
          + legend are always visible (never clipped). */}
      <div className="shrink-0">
        <MonthHeatmap
          weekStart={displayWeekStart}
          weekStartsMonday={calendarWeekStartsMonday}
          userId={viewingUserId ?? null}
          teamId={activeTeam?.id ?? null}
          reloadKey={calendarReloadKey}
          onDayClick={(date) => {
            // v1.456.1: one shared mapping (src/shared/weekNav.ts) for
            // "which week offset displays this day", the same one
            // useActivities uses for offset 0. The v1.237.0 version
            // measured the click from startOfWeek(today, Sunday) while
            // offset 0 was startOfWeek(today, Monday); on a Sunday those
            // differ by a week, so every click opened the week before.
            setWeekOffset(weekOffsetForDate(date, calendarWeekStartsMonday))
          }}
        />
      </div>
      {/* Data points (capacity, activity types, ACV impact) fill the
          space under the heatmap; scroll if they can't all fit. */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-gray-200 dark:border-gray-700">
        <div className="grid grid-cols-2 gap-0">
          <CapacityPie
            activities={activities}
            weekStart={displayWeekStart}
            workDays={currentUser?.workDays ?? 31}
            workDayStartHour={currentUser?.workDayStartHour ?? 8}
            workDayEndHour={currentUser?.workDayEndHour ?? 18}
            otherMeetingHours={otherMeetingHours}
          />
          <ActivityTypePie activities={activities} weekStart={displayWeekStart} />
        </div>
        {viewingUserId === currentUser?.id && (
          <DisplayCurrencyProvider>
            <AcvImpactTiles />
          </DisplayCurrencyProvider>
        )}
      </div>
    </>
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader icon={CalendarDays} title={t('nav.activities')} subtitle={activeTeam.name} />
    <div className="flex flex-1 overflow-hidden">
      {/* Left panel — activity list (the List pane on a phone) */}
      <div className={cn('flex min-w-0 flex-1 flex-col overflow-hidden', isMobile && mobilePane !== 'list' && 'hidden')}>
        {/* Week nav */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-2 md:flex-nowrap md:px-6 md:py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
            <Button variant="ghost" size="icon" onClick={() => setWeekOffset(weekOffset - 1)} title={prevRangeLabel}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{weekLabel}</span>
            <Chip variant="accent" size="xs" className="uppercase tracking-wide font-semibold" title={t('weekly.fiscal_period', 'Fiscal period')}>
              {fiscalLabelOf(weekStart, fiscalCfg)}
            </Chip>
            <span
              className="ml-1 hidden items-center gap-1 text-[10px] text-gray-500 md:flex dark:text-gray-400"
              title={t('activity.timezone_note', { tz: userTimezone })}
            >
              <Globe className="h-3 w-3" />
              {t('activity.timezone_note', { tz: userTimezone })}
            </span>
            <Button variant="ghost" size="icon" onClick={() => setWeekOffset(weekOffset + 1)} title={nextRangeLabel}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            {weekOffset !== 0 && (
              <Button variant="ghost" size="sm" onClick={() => setWeekOffset(0)}>
                {t('activity.week.today')}
              </Button>
            )}
            <div className="flex flex-wrap items-center gap-2 md:ml-3 md:flex-nowrap">
              {/* v1.75.0: meetings & approved chips collapse the label
                  into an icon + count. The full label lives in the
                  tooltip via title. */}
              <Chip
                variant="info"
                icon={CalendarDays}
                title={t('activity.week_stats.meetings', { count: weekMeetingCount })}
              >
                {String(weekMeetingCount)}
              </Chip>
              <Chip
                variant="success"
                icon={Check}
                title={t('activity.week_stats.approved', { count: weekApprovedCount })}
              >
                {String(weekApprovedCount)}
              </Chip>
              <Chip variant="neutral" icon={Clock} title={t('activity.week_stats.hours_hint')}>
                {t('activity.week_stats.hours', { hours: weekTotalHours.toFixed(1) })}
              </Chip>
              <WeeklyRevenueChip activities={activities} />
              <WeeklyIncidentalChip activities={activities} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isMobile && (
              <div className="flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600" role="group" aria-label={t('weekly.mobile.pane_toggle')}>
                {([
                  { key: 'list', icon: List, label: t('weekly.mobile.list') },
                  { key: 'calendar', icon: CalendarDays, label: t('weekly.mobile.calendar') },
                ] as const).map(({ key, icon: PaneIcon, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setMobilePane(key)}
                    aria-pressed={mobilePane === key}
                    title={label}
                    aria-label={label}
                    className={cn(
                      'flex h-8 w-9 items-center justify-center',
                      mobilePane === key
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
                    )}
                  >
                    <PaneIcon className="h-4 w-4" />
                  </button>
                ))}
              </div>
            )}
            <RefreshOutlookButton onRefreshed={reloadAll} />
            <TemplateQuickButton onPickTemplate={(id) => { setEditActivity(null); setTemplateSeedId(id); setPrefill(null); setFormOpen(true) }} />
            <Button onClick={openNew} size="sm" title={t('activity.logActivity')}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t('activity.logActivity')}</span>
            </Button>
          </div>
        </div>

        {/* Nudge banners (v1.480.0): one stacked card, not a list. The count and
            arrows on the left move through them; Mark read / Snooze removes the
            current one and the next slides into its place. */}
        {nudges.length > 0 && (() => {
          const idx = Math.min(nudgeIndex, nudges.length - 1)
          const nudge = nudges[idx]
          if (!nudge) return null
          const iconMeta = nudgeIconFor(nudge.triggerType)
          const Icon = iconMeta.icon
          const many = nudges.length > 1
          const navBtn = 'flex h-6 w-6 items-center justify-center rounded text-amber-600 hover:bg-amber-100 hover:text-amber-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-amber-400 dark:hover:bg-amber-900/40 dark:hover:text-amber-200'
          return (
          <div className={cn('px-3 pt-3 md:px-6', many && (nudges.length > 2 ? 'pb-3' : 'pb-1.5'))}>
            <div className="relative">
              {/* Cards peeking out underneath, so it reads as a stack. */}
              {nudges.length > 2 && (
                <div aria-hidden="true" className="absolute inset-x-4 -bottom-3 h-full rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30" />
              )}
              {many && (
                <div aria-hidden="true" className="absolute inset-x-2 -bottom-1.5 h-full rounded-lg border border-amber-200 bg-amber-50/80 dark:border-amber-800 dark:bg-amber-950/40" />
              )}
              <div
                key={nudge.ruleId}
                role="status"
                aria-live="polite"
                className="relative flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-sm dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
              >
                {many && (
                  <div className="flex shrink-0 items-center gap-0.5 border-r border-amber-200 pr-2 dark:border-amber-800">
                    <button
                      type="button"
                      onClick={() => setNudgeIndex(idx - 1)}
                      disabled={idx === 0}
                      className={navBtn}
                      aria-label={t('nudge.previous')}
                      title={t('nudge.previous')}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="min-w-[3.25rem] text-center text-xs font-semibold tabular-nums">
                      {t('nudge.position', { current: idx + 1, total: nudges.length })}
                    </span>
                    <button
                      type="button"
                      onClick={() => setNudgeIndex(idx + 1)}
                      disabled={idx >= nudges.length - 1}
                      className={navBtn}
                      aria-label={t('nudge.next')}
                      title={t('nudge.next')}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', iconMeta.bg)}>
                  <Icon className={cn('h-4 w-4', iconMeta.fg)} aria-hidden="true" />
                </span>
                <span className="flex-1">{nudge.message}</span>
                <button
                  onClick={() => void markReadNudge(nudge.ruleId)}
                  className="shrink-0 text-amber-600 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
                  aria-label={t('notifications.mark_read')}
                  title={t('notifications.mark_read_tip', "Mark read — won't remind you again today, but returns tomorrow if still relevant.")}
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setNudgeSnoozeMenu((cur) => cur?.ruleId === nudge.ruleId ? null : { ruleId: nudge.ruleId, x: r.right, y: r.bottom })
                  }}
                  className="shrink-0 text-amber-600 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
                  aria-label={t('notifications.snooze', 'Snooze')}
                  title={t('notifications.snooze_tip', 'Snooze — mute this reminder for a number of days you choose.')}
                >
                  <BellOff className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          )
        })()}
        {nudgeSnoozeMenu && createPortal(
          <div
            ref={nudgeSnoozeMenuRef}
            className="fixed z-[100] w-40 overflow-hidden rounded-md border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
            style={{ left: Math.max(8, nudgeSnoozeMenu.x - 160), top: nudgeSnoozeMenu.y + 4 }}
          >
            <p className="border-b border-gray-100 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800 dark:text-gray-500">
              {t('notifications.snooze', 'Snooze this nudge')}
            </p>
            {[1, 7, 30].map((d) => (
              <button
                key={d}
                onClick={() => void snoozeNudge(nudgeSnoozeMenu.ruleId, d)}
                className="block w-full px-2.5 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {t('notifications.snooze_days', { count: d, defaultValue: '{{count}} day' })}
              </button>
            ))}
          </div>,
          document.body,
        )}

        {/* Activity list */}
        <div className="flex-1 overflow-y-auto px-3 py-3 md:px-6 md:py-4">
          {loading && (
            <div className="flex justify-center py-8">
              <Spinner className="h-5 w-5" />
            </div>
          )}
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}
          {!loading && !error && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3 md:flex-nowrap">
                <div className="min-w-0 flex-1 basis-60 md:basis-auto">
                  <WeeklyCapacityBar
                    activities={activities}
                    weekStart={displayWeekStart}
                    workDays={currentUser?.workDays ?? 31}
                    workDayStartHour={currentUser?.workDayStartHour ?? 8}
                    workDayEndHour={currentUser?.workDayEndHour ?? 18}
                    onFilterType={setTypeFilterId}
                    filterTypeId={typeFilterId}
                    otherMeetingHours={otherMeetingHours}
                  />
                </div>
                {/* Toolbar cluster: six icon-only toggles flush against
                    each other, ordered so the most-used (Show Non-Activities,
                    the attendee filter, sort) sit leftmost. Each remembers its
                    state across refresh + login/logout via localStorage
                    above. */}
                <div className="flex shrink-0 items-center gap-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowNonActivities((v) => !v)}
                    className={showNonActivities ? 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/50 dark:text-blue-200 dark:hover:bg-blue-900/50' : undefined}
                    aria-pressed={showNonActivities}
                    title={t('activity.non_activity.toggle', 'Show Non-Activities')}
                    aria-label={t('activity.non_activity.toggle', 'Show Non-Activities')}
                  >
                    <CalendarOff className="h-3.5 w-3.5" />
                  </Button>
                  {/* v1.240.0: cycles All -> Optional -> Required -> All,
                      filtering UNAPPROVED (suggested) meetings by whether the
                      current user's own attendee entry on that meeting is
                      required or optional. Icon-only like its neighbors — the
                      icon itself (User / UserPlus / UserLock) carries the
                      state, and the color change (gray -> blue -> amber)
                      mirrors it, so there's no need for a label here. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setMyAttendeeFilter((v) => (v === 'all' ? 'optional' : v === 'optional' ? 'required' : 'all'))}
                    aria-pressed={myAttendeeFilter !== 'all'}
                    title={myAttendeeFilter === 'optional'
                      ? t('activity.attendee_filter.hint_optional', 'Showing meetings where you are Optional only (click to show Required only)')
                      : myAttendeeFilter === 'required'
                      ? t('activity.attendee_filter.hint_required', 'Showing meetings where you are Required only (click to show all)')
                      : t('activity.attendee_filter.hint_all', 'Showing all Required/Optional meetings (click to show Optional only)')}
                    aria-label={t('activity.attendee_filter.hint', 'Filter unapproved meetings by whether you are Required or Optional')}
                    className={
                      myAttendeeFilter === 'optional'
                        ? 'text-blue-600 dark:text-blue-400'
                        : myAttendeeFilter === 'required'
                        ? 'text-amber-600 dark:text-amber-400'
                        : undefined
                    }
                  >
                    {myAttendeeFilter === 'optional' ? (
                      <UserPlus className="h-3.5 w-3.5" />
                    ) : myAttendeeFilter === 'required' ? (
                      <UserLock className="h-3.5 w-3.5" />
                    ) : (
                      <User className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {/* Per-day sort toggle. Descending default (earliest at
                      top, matching SF/Outlook). Icon flips to indicate the
                      order that clicking will produce next. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDayAsc((v) => !v)}
                    title={dayAsc
                      ? t('activity.sort_ascending_active', 'Sort: latest first (click to switch)')
                      : t('activity.sort_descending_active', 'Sort: earliest first (click to switch)')}
                    aria-label={t('activity.sort_toggle', 'Toggle day sort order')}
                    aria-pressed={dayAsc}
                  >
                    {dayAsc
                      ? <CalendarArrowUp className="h-3.5 w-3.5" />
                      : <CalendarArrowDown className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => (collapsedDays.size === 0 ? collapseAll() : expandAll())}
                    title={collapsedDays.size === 0 ? t('activity.collapse_all') : t('activity.expand_all')}
                    aria-label={collapsedDays.size === 0 ? t('activity.collapse_all') : t('activity.expand_all')}
                  >
                    {collapsedDays.size === 0
                      ? <ChevronsDownUp className="h-3.5 w-3.5" />
                      : <ChevronsUpDown className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setCompactApproved((v) => !v)}
                    className={compactApproved ? 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/50 dark:text-blue-200 dark:hover:bg-blue-900/50' : undefined}
                    aria-pressed={compactApproved}
                    title={t('activity.compact_approved_tooltip', 'Compact Approved Activity Cards')}
                    aria-label={t('activity.compact_approved_tooltip', 'Compact Approved Activity Cards')}
                  >
                    <ListChevronsDownUp className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {typeFilterId && filteredTypeName && (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: filteredTypeColor ?? '#3b82f6' }}
                    />
                    <span>{t('activity.filter.showing_type', 'Showing {{name}} activities only', { name: filteredTypeName })}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setTypeFilterId(null)}
                    className="ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40"
                  >
                    {t('activity.filter.clear', 'Clear filter')}
                  </button>
                </div>
              )}
              <div className="flex flex-col gap-3">
                {/* v1.242.0: above the first day, and deliberately outside the
                    filter row above — an exception queue a filter can hide is
                    one that silently loses items. */}
                {activeTeam && (
                  <DeletedActivitiesSection
                    items={deletedItems}
                    weekStartIso={displayWeekStart.toISOString()}
                    busy={deletedBusy}
                    onKeep={(opts) => { void (async () => { await keepDeleted(opts); reloadAll() })() }}
                    onPurge={(opts) => { void (async () => { await purgeDeleted(opts); reloadAll() })() }}
                  />
                )}
                {byDay.map(({ day, items, suggestions: daySuggestions }) => {
                  const iso = day.toISOString()
                  const collapsed = collapsedDays.has(iso)
                  const isToday = isSameDay(day, new Date())
                  const totalHours = items.reduce((s, a) => s + Number(a.effortHours), 0)
                  return (
                    <section
                      key={iso}
                      className={cn(
                        'overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900',
                        isToday && 'border-blue-300 dark:border-blue-800',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleDay(iso)}
                        className={cn(
                          'flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-gray-200 bg-gray-50 px-3 py-2.5 text-left md:flex-nowrap md:px-4 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800/60 dark:hover:bg-gray-800',
                          isToday && 'bg-blue-50 dark:bg-blue-950/30',
                        )}
                      >
                        <span className="flex items-center gap-2">
                          {collapsed ? <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-500 dark:text-gray-400" />}
                          <span className={cn(
                            'whitespace-nowrap text-base font-semibold',
                            isToday ? 'text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-gray-100',
                          )}>
                            {format(day, 'EEEE, MMM d')}
                          </span>
                          {isToday && (
                            <Chip variant="info" size="xs" className="uppercase tracking-wide font-semibold">
                              {t('activity.today')}
                            </Chip>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-xs text-gray-600 md:flex-nowrap md:gap-3 dark:text-gray-400">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void togglePto(format(day, 'yyyy-MM-dd')) }}
                            className={cn(
                              'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
                              ptoDates.has(format(day, 'yyyy-MM-dd'))
                                ? 'border-amber-400 bg-amber-100 text-amber-800 hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60'
                                : 'border-gray-300 bg-white text-gray-500 hover:text-amber-700 hover:border-amber-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400 dark:hover:border-amber-700 dark:hover:text-amber-300',
                            )}
                            title={ptoDates.has(format(day, 'yyyy-MM-dd')) ? t('activity.pto.remove') : t('activity.pto.mark')}
                          >
                            <Palmtree className="h-3 w-3" />
                            {ptoDates.has(format(day, 'yyyy-MM-dd')) ? t('activity.pto.short') : t('activity.pto.short_off')}
                          </button>
                          <Chip variant="neutral" title={t('activity.day_totals.meetings_hint')}>
                            {items.length + daySuggestions.length} {t('activity.day_totals.meetings')}
                          </Chip>
                          <span>{t('activity.day_totals.activities', { count: items.length })}</span>
                          <span className="rounded-full bg-white px-2 py-0.5 font-medium text-gray-700 shadow-sm dark:bg-gray-900 dark:text-gray-200">
                            {totalHours.toFixed(1)}h
                          </span>
                        </span>
                      </button>
                      {!collapsed && (
                        <div className="p-3">
                          {items.length === 0 && daySuggestions.length === 0 ? (
                            <p className="text-xs text-gray-400 dark:text-gray-500">{t('activity.empty_day', 'No activities logged this day.')}</p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {items.map((a) => (
                                <ActivityCard key={a.id} activity={a} teamId={activeTeam.id} onEdit={openEdit} onReload={reloadAll} compact={compactApproved} isTentative={!!a.outlookEventId && tentativeEventIds.has(a.outlookEventId)} nonActivityColor={nonActivityColor} transcriptsEnabled={transcriptsIconEnabled} meetingOwnerEmailOverride={(() => {
                                  const evtOrganizer = a.outlookEventId ? organizerByEventId.get(a.outlookEventId) : undefined
                                  return evtOrganizer && a.meetingOwner && evtOrganizer.name.trim().toLowerCase() === a.meetingOwner.trim().toLowerCase()
                                    ? evtOrganizer.email
                                    : null
                                })()} />
                              ))}
                              {daySuggestions.map((s) => (
                                <SuggestedActivityCard
                                  key={s.outlookEventId}
                                  suggestion={s}
                                  gongRecorded={gongMarks.recorded.has(s.outlookEventId)}
                                  teamId={activeTeam.id}
                                  onApproved={reloadAll}
                                  onEdit={(pre) => {
                                    // v1.92.0: forward the full prefill payload from the Suggested card.
                                    // The old handler picked only 5 fields, dropping descriptionBody /
                                    // meetingOwner / attendees on the floor — that's why the form
                                    // opened blank even though the card and calendar modal showed the
                                    // Outlook context. Spread everything so any future prefill field
                                    // propagates without another patch here.
                                    setPrefill({
                                      outlookEventId: pre.outlookEventId,
                                      title: pre.title,
                                      startDatetime: pre.startDatetime,
                                      endDatetime: pre.endDatetime,
                                      activityTypeId: pre.activityTypeId ?? null,
                                      descriptionBody: pre.descriptionBody,
                                      meetingOwner: pre.meetingOwner,
                                      meetingOwnerEmail: pre.meetingOwnerEmail,
                                      attendees: pre.attendees,
                                      isPrivate: pre.isPrivate,
                                    })
                                    setEditActivity(null)
                                    setFormOpen(true)
                                  }}
                                  onMarkNonActivity={(id) => { void markNonActivity(id) }}
                                  onUnmarkNonActivity={(id) => { void unmarkNonActivity(id) }}
                                  isNonActivity={nonActivityIds.has(s.outlookEventId) || s.isNonActivitySuggestion}
                                  nonActivityColor={nonActivityColor}
                                  myAttendeeType={myAttendeeType(s)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right column — calendar + month heatmap. User-resizable via the
          drag handle on the left edge; width persists to localStorage.
          On a phone it's the Calendar pane instead: the calendar at a fixed
          share of the screen, with the heatmap and charts scrolling below. */}
      {isMobile ? (
        mobilePane === 'calendar' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="h-[70vh] shrink-0 overflow-hidden">{calendarPanel}</div>
            {calendarExtras}
          </div>
        )
      ) : (
        <ResizableRightColumn collapsed={rightCollapsed} onExpand={() => setRightCollapsed(false)}>
          <VerticalSplit top={calendarPanel} bottom={calendarExtras} />
        </ResizableRightColumn>
      )}

      <EventDetailsModal
        open={detailsEvent !== null}
        event={detailsEvent}
        onClose={() => setDetailsEvent(null)}
        isNonActivity={!!detailsEvent && nonActivityIds.has(detailsEvent.id)}
        onMarkAsActivity={(evt) => { void unmarkNonActivity(evt.id) }}
        onLogActivity={(evt) => {
          setPrefill({
            outlookEventId: evt.id,
            title: evt.subject,
            startDatetime: evt.start,
            endDatetime: evt.end,
            descriptionBody: evt.bodyPreview,
            meetingOwner: evt.organizer ? (evt.organizer.name || evt.organizer.email) : undefined,
            meetingOwnerEmail: evt.organizer?.email ?? undefined,
            // v1.239.0: was stripped to {name,email} — now passes response/
            // type through too, for the form's read-only "meeting responses"
            // summary. ActivityForm.tsx strips it back down before it ever
            // reaches the persisted `attendees` field.
            attendees: evt.attendees?.map((a) => ({ name: a.name, email: a.email, response: a.response, type: a.type })),
            isAllDay: evt.isAllDay,
            eventType: evt.eventType,
            seriesMasterId: evt.seriesMasterId,
            isPrivate: evt.isPrivate,
          })
          setEditActivity(null)
          setFormOpen(true)
        }}
      />

      {/* Activity form slide-in */}
      {activeTeam && (
        <ActivityForm
          open={formOpen}
          onClose={closeForm}
          onSaved={reloadAll}
          teamId={activeTeam.id}
          activityTypes={activityTypes}
          editActivity={editActivity}
          prefill={prefill}
          weekEvents={weekEvents}
          seedTemplateId={templateSeedId}
          initialTab={editInitialTab}
          isNonActivity={!!prefill && nonActivityIds.has(prefill.outlookEventId)}
          onUnmarkNonActivity={prefill ? () => { void unmarkNonActivity(prefill.outlookEventId) } : undefined}
        />
      )}
    </div>
    </div>
  )
}

// v1.75.0: Weekly Revenue Impact chip. Sums the ACV of every UNIQUE
// Opportunity the SE touched this week (each Opp counted once, no
// matter how many activities point at it), converts from USD → user's
// preferred currency via /auth/fx-rates, and shows a compact "$XXk"
// pill next to Hours. Tooltip surfaces the FX rate + as-of date so
// SEs can tell how stale the conversion is.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', AUD: 'A$', CAD: 'C$',
  CHF: 'Fr.', HKD: 'HK$', SGD: 'S$', KRW: '₩', INR: '₹', MXN: 'Mex$',
  BRL: 'R$', TWD: 'NT$', ZAR: 'R', AED: 'د.إ', SAR: '﷼',
}
interface FxRow { currency: string; ratePerUsd: number; asOf: string; source: string }
function fmtCompact(n: number, currency: string): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sym}${Math.round(n / 1000)}k`
  return `${sym}${Math.round(n)}`
}
function WeeklyRevenueChip({ activities }: { activities: Array<{ crmWhatType: string | null; crmWhatId: string | null; acv: string | number | null }> }) {
  const { t } = useTranslation()
  const [pref, setPref] = React.useState<string>('USD')
  const [rates, setRates] = React.useState<FxRow[]>([])
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const [prefRes, ratesRes] = await Promise.all([
        api.get<{ code: string | null }>('/auth/me/preferred-currency'),
        api.get<FxRow[]>('/auth/fx-rates'),
      ])
      if (cancelled) return
      setPref(prefRes.data?.code ?? 'USD')
      setRates(ratesRes.data ?? [])
    })()
    return () => { cancelled = true }
  }, [])
  // Sum ACV once per unique Opp. Activities without an Opp id or an
  // ACV don't contribute; deduping happens on crmWhatId.
  const uniqueOppAcv = new Map<string, number>()
  for (const a of activities) {
    if (a.crmWhatType !== 'Opportunity' || !a.crmWhatId || a.acv == null) continue
    const acv = Number(a.acv)
    if (!Number.isFinite(acv) || acv <= 0) continue
    if (!uniqueOppAcv.has(a.crmWhatId)) uniqueOppAcv.set(a.crmWhatId, acv)
  }
  const totalUsd = Array.from(uniqueOppAcv.values()).reduce((s, x) => s + x, 0)
  if (totalUsd <= 0) return null
  const rate = rates.find((r) => r.currency === pref)
  const converted = rate ? totalUsd * rate.ratePerUsd : totalUsd
  const asOf = rate?.asOf ? new Date(rate.asOf).toISOString().slice(0, 10) : t('common.na', 'n/a')
  const tooltip = t('activity.week_stats.weekly_revenue_tooltip', {
    defaultValue: 'Weekly Revenue Impact — FX Rate ({{asOf}}, {{rate}} per USD)',
    asOf,
    rate: rate ? rate.ratePerUsd.toFixed(4) : '1.0000',
  })
  return (
    <Chip variant="success" icon={TrendingUp} title={tooltip}>
      {fmtCompact(converted, pref)}
    </Chip>
  )
}

// Onsite Incidental costs chip — same shape/rules as WeeklyRevenueChip
// (sum → convert to the user's preferred currency via /auth/fx-rates →
// compact "$XXk" pill, hidden entirely at zero), but summing every onsite
// activity's Direct Costs (transportation + lodging + food) instead of
// Opportunity ACV. Unlike ACV, incidental costs aren't deduped by Opp —
// every onsite activity's own entered cost counts once. Each activity's
// cost is stored in whatever currency was active when it was entered
// (incidentalCurrency), so conversion goes cost-currency → USD → pref,
// not straight from USD like ACV.
function WeeklyIncidentalChip({ activities }: { activities: Array<{ locationMode: 'remote' | 'onsite'; costTransportation?: string | null; costLodging?: string | null; costFood?: string | null; incidentalCurrency?: string | null }> }) {
  const { t } = useTranslation()
  const [pref, setPref] = React.useState<string>('USD')
  const [rates, setRates] = React.useState<FxRow[]>([])
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const [prefRes, ratesRes] = await Promise.all([
        api.get<{ code: string | null }>('/auth/me/preferred-currency'),
        api.get<FxRow[]>('/auth/fx-rates'),
      ])
      if (cancelled) return
      setPref(prefRes.data?.code ?? 'USD')
      setRates(ratesRes.data ?? [])
    })()
    return () => { cancelled = true }
  }, [])
  const rateFor = (cur: string) => (cur === 'USD' ? 1 : rates.find((r) => r.currency === cur)?.ratePerUsd)
  let totalUsd = 0
  for (const a of activities) {
    if (a.locationMode !== 'onsite') continue
    const cost = (Number(a.costTransportation) || 0) + (Number(a.costLodging) || 0) + (Number(a.costFood) || 0)
    if (cost <= 0) continue
    const cur = a.incidentalCurrency || pref
    const rate = rateFor(cur)
    if (rate) totalUsd += cost / rate
  }
  if (totalUsd <= 0) return null
  const prefRate = rateFor(pref)
  const converted = prefRate ? totalUsd * prefRate : totalUsd
  const asOf = rates.find((r) => r.currency === pref)?.asOf
  const tooltip = t('activity.week_stats.weekly_incidental_tooltip', {
    asOf: asOf ? new Date(asOf).toISOString().slice(0, 10) : t('common.na', 'n/a'),
    rate: prefRate ? prefRate.toFixed(4) : '1.0000',
  })
  return (
    <Chip variant="warning" icon={MapPin} title={tooltip}>
      {fmtCompact(converted, pref)}
    </Chip>
  )
}
