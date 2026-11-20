import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { format, addDays, isSameDay, differenceInMinutes } from 'date-fns'
import {
  ChevronLeft,
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  CheckCircle2,
  Cloud,
  Loader2,
  Info,
  ChevronDown,
  Layers,
  Check,
  Sparkles,
  CalendarDays,
  Briefcase,
  CalendarCheck2,
  CalendarArrowDown,
  Lock,
} from 'lucide-react'
import { Button } from '../ui/button.js'
import { cn } from '../../lib/utils.js'
import type { Activity } from '../../hooks/useActivities.js'
import { useCalendarEvents, useOutlookStatus, type CalendarEvent } from '../../hooks/useCalendar.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useHolidays } from '../../hooks/useHolidays.js'
import { usePto } from '../../hooks/usePto.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { api } from '../../lib/api.js'
import { formatTimeInTZ, wallClockInTZ, ymdInTZ } from '../../lib/tz.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

interface CalendarPanelProps {
  weekStart: Date
  activities: Activity[]
  suggestions?: import('../../hooks/useSuggestions.js').Suggestion[]
  onEventClick: (event: CalendarEvent) => void
  onActivityClick?: (activity: Activity) => void
  onWeekChange: (offset: number) => void
  weekOffset: number
  activeTeamId?: string | null
  viewingUserId?: string | null
  onViewingUserChange?: (userId: string | null) => void
  reloadKey?: number
  viewMode?: 'all_meetings' | 'activities_approved' | 'not_approved'
  onViewModeChange?: (m: 'all_meetings' | 'activities_approved' | 'not_approved') => void
  showWeekends?: boolean
  onShowWeekendsChange?: (v: boolean) => void
  // v1.235.0: this panel's own week-start display — false (default) renders
  // Sunday-first columns, true renders Monday-first. Purely visual; the
  // underlying `weekStart` prop stays Monday-anchored either way.
  weekStartsMonday?: boolean
  onWeekStartsMondayChange?: (v: boolean) => void
  onCollapseRight?: () => void
  nonActivityIds?: Set<string>
  // Mirrors the Activities list's "Show Non-Activities" toggle (WeeklyView) —
  // when false (default), meetings marked Non-Activity are hidden from the
  // calendar grid entirely rather than just painted dark gray, so the two
  // panels agree on what's currently visible.
  showNonActivities?: boolean
}

const SLOT_HEIGHT_PX = 36

// Workday bit mask (Settings.tsx: bit 1=Mon … bit 64=Sun) is keyed by the
// day's actual weekday, not its position in a `days` display array — that
// position shifts with the week-start-day toggle below, so this always
// recomputes from the date itself rather than assuming array index.
function workDayBit(d: Date): number {
  return 1 << ((d.getDay() + 6) % 7)
}

// Measure the platform scrollbar width once (0 on overlay-scrollbar systems
// like macOS). Used to reserve a matching gutter on the calendar header so it
// stays column-aligned with the always-scrolling grid body.
function useScrollbarWidth(): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const outer = document.createElement('div')
    outer.style.visibility = 'hidden'
    outer.style.overflow = 'scroll'
    document.body.appendChild(outer)
    const inner = document.createElement('div')
    outer.appendChild(inner)
    setWidth(outer.offsetWidth - inner.offsetWidth)
    outer.remove()
  }, [])
  return width
}

export function CalendarPanel({
  weekStart,
  activities,
  suggestions = [],
  onEventClick,
  onActivityClick,
  onWeekChange,
  weekOffset,
  activeTeamId,
  viewingUserId,
  onViewingUserChange,
  reloadKey,
  viewMode = 'all_meetings',
  onViewModeChange,
  showWeekends = true,
  onShowWeekendsChange,
  weekStartsMonday = false,
  onWeekStartsMondayChange,
  onCollapseRight,
  nonActivityIds,
  showNonActivities = false,
}: CalendarPanelProps) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const { status, loading: statusLoading, connect } = useOutlookStatus()
  const enabled = !!status?.connected
  const { events, meta, loading: eventsLoading, error } = useCalendarEvents(weekStart, enabled, viewingUserId ?? null, reloadKey)

  const dayStart = user?.workDayStartHour ?? 8
  const dayEnd = user?.workDayEndHour ?? 18
  const workDayLen = Math.max(1, dayEnd - dayStart)
  const workDaysMask = user?.workDays ?? 31
  // Render the full 24-hour column so activities/events that fall outside the
  // user's working window (early-morning demo prep, evening client calls)
  // remain visible via scroll. Off-hours rows are tinted gray in the grid.
  const gridStartHour = 0
  const gridEndHour = 24
  const hours = Array.from({ length: gridEndHour - gridStartHour }, (_, i) => i + gridStartHour)
  // v1.237.0: `weekStart` is the caller's already display-adjusted anchor
  // (WeeklyView.tsx's `displayWeekStart` — Monday when the toggle is on, or
  // the Sunday immediately before it when off), so this panel just lays out
  // 7 sequential days from it. `weekStartsMonday` only controls this
  // toggle's own icon state now — the actual date shift happens upstream,
  // once, so every fetch below (events, holidays, PTO) automatically gets
  // the correct window without special-casing.
  const allDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const days = showWeekends ? allDays : allDays.filter((d) => { const dow = d.getDay(); return dow !== 0 && dow !== 6 })
  const { byIso: holidayByIso } = useHolidays(weekStart, addDays(weekStart, 6))
  const { ptoDates } = usePto(weekStart, addDays(weekStart, 6))
  // The day-name header sits above the scrolling grid body, so when the body
  // shows a scrollbar its 1fr day columns get narrower than the header's and
  // the two rows drift out of alignment (most visible with the PTO tint).
  // Reserve the same gutter on the header so the columns line up. 0 on
  // overlay-scrollbar platforms (macOS), where nothing is reserved.
  const scrollbarWidth = useScrollbarWidth()

  const prevRange = () => {
    const s = addDays(weekStart, -7)
    return `${format(s, 'MMM d')} – ${format(addDays(s, 6), 'MMM d, yyyy')}`
  }
  const nextRange = () => {
    const s = addDays(weekStart, 7)
    return `${format(s, 'MMM d')} – ${format(addDays(s, 6), 'MMM d, yyyy')}`
  }

  const showFallbackBanner = meta.fallback === 'no_app_only_graph'
  const personName = meta.personName ?? null

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-l border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-3 md:flex-nowrap md:px-4 dark:border-gray-700">
        <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
          <span className="flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold text-gray-900 dark:text-gray-100">
            <CalendarDays className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            {t('calendar.title')}
          </span>
          {activeTeamId && onViewingUserChange && (
            <PersonSwitcher teamId={activeTeamId} value={viewingUserId ?? null} onChange={onViewingUserChange} selfLabel={user?.displayName ?? t('calendar.person_switcher.you')} selfValue={user?.id ?? null} />
          )}
          {onViewModeChange && (
            <div className="ml-1 flex overflow-hidden rounded border border-gray-200 dark:border-gray-600">
              <button
                type="button"
                onClick={() => onViewModeChange('all_meetings')}
                className={cn('flex h-6 w-7 items-center justify-center', viewMode === 'all_meetings' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700')}
                title={t('calendar.view_mode.all_meetings')}
                aria-label={t('calendar.view_mode.all_meetings')}
              ><Layers className="h-3.5 w-3.5" /></button>
              <button
                type="button"
                onClick={() => onViewModeChange('activities_approved')}
                className={cn('flex h-6 w-7 items-center justify-center', viewMode === 'activities_approved' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700')}
                title={t('calendar.view_mode.activities_approved')}
                aria-label={t('calendar.view_mode.activities_approved')}
              ><Check className="h-3.5 w-3.5" /></button>
              <button
                type="button"
                onClick={() => onViewModeChange('not_approved')}
                className={cn('flex h-6 w-7 items-center justify-center', viewMode === 'not_approved' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700')}
                title={t('calendar.view_mode.not_approved')}
                aria-label={t('calendar.view_mode.not_approved')}
              ><Sparkles className="h-3.5 w-3.5" /></button>
            </div>
          )}
          {onShowWeekendsChange && (
            // v1.235.0: was a 2-button segmented control (Show/Hide as
            // separate buttons); collapsed into one button whose icon
            // swaps with state, matching the week-start toggle beside it.
            // "Show weekends" (CalendarDays) is the default selected icon.
            <button
              type="button"
              onClick={() => onShowWeekendsChange(!showWeekends)}
              className="ml-1 flex h-6 w-7 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              title={showWeekends ? t('calendar.weekend_mode.show') : t('calendar.weekend_mode.hide')}
              aria-label={showWeekends ? t('calendar.weekend_mode.show') : t('calendar.weekend_mode.hide')}
            >
              {showWeekends ? <CalendarDays className="h-3.5 w-3.5" /> : <Briefcase className="h-3.5 w-3.5" />}
            </button>
          )}
          {onWeekStartsMondayChange && (
            // v1.235.0: this panel's own week-start display. Default
            // Sunday-first (calendar-check-2); toggling switches to
            // Monday-first (calendar-arrow-down). Purely a display order —
            // see the `dayOffsets` comment above.
            <button
              type="button"
              onClick={() => onWeekStartsMondayChange(!weekStartsMonday)}
              className="ml-1 flex h-6 w-7 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              title={weekStartsMonday ? t('calendar.week_start_mode.monday') : t('calendar.week_start_mode.sunday')}
              aria-label={weekStartsMonday ? t('calendar.week_start_mode.monday') : t('calendar.week_start_mode.sunday')}
            >
              {weekStartsMonday ? <CalendarArrowDown className="h-3.5 w-3.5" /> : <CalendarCheck2 className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => onWeekChange(weekOffset - 1)} title={prevRange()}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => onWeekChange(weekOffset + 1)} title={nextRange()}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => onCollapseRight?.()} title={t('calendar.collapse')}>
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        className="grid border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
        style={{ gridTemplateColumns: `40px repeat(${days.length}, minmax(0, 1fr))`, paddingRight: scrollbarWidth }}
      >
        <div />
        {days.map((day) => {
          const bit = workDayBit(day)
          const isWorkDay = (workDaysMask & bit) !== 0
          const iso = format(day, 'yyyy-MM-dd')
          const holidayName = holidayByIso.get(iso)
          const isPto = ptoDates.has(iso)
          const dayActivities = activities.filter((a) => isSameDay(new Date(a.startDatetime), day))
          const daySuggestions = viewMode !== 'activities_approved' ? suggestions.filter((s) => isSameDay(new Date(s.start), day)) : []
          const totalCount = dayActivities.length + daySuggestions.length
          const totalHours = dayActivities.reduce((s, a) => s + Number(a.effortHours), 0)
          void totalCount
          // v1.363.0: an approved activity here is still awaiting a Keep/Delete
          // decision after its Outlook meeting was deleted (§10) — surfaced as
          // a red day number rather than buried in the day's card list.
          const hasOutlookDeleted = dayActivities.some((a) => a.outlookDeletedAt && !a.outlookDeletedKept)
          return (
            <div
              key={day.toISOString()}
              className={cn(
                'px-1 py-2 text-center text-xs font-medium',
                isSameDay(day, new Date()) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400',
                !isWorkDay && 'opacity-60',
                holidayName && 'bg-indigo-50 dark:bg-indigo-950/30',
                isPto && 'bg-amber-100 dark:bg-amber-950/40',
              )}
              title={isPto ? 'PTO' : holidayName ?? undefined}
            >
              <div>{format(day, 'EEE')}</div>
              <div
                className={cn(
                  'mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-sm',
                  isSameDay(day, new Date())
                    ? cn('bg-blue-600 text-white dark:bg-blue-500', hasOutlookDeleted && 'ring-2 ring-red-500 ring-offset-1 dark:ring-offset-gray-900')
                    : hasOutlookDeleted && 'font-bold text-red-600 dark:text-red-400',
                )}
                title={hasOutlookDeleted ? t('calendar.outlook_deleted_day_hint', 'An approved activity here is linked to a deleted Outlook meeting — still awaiting a Keep or Delete decision.') : undefined}
              >
                {format(day, 'd')}
              </div>
              <div className="mt-0.5 text-[9px] font-normal text-gray-500 dark:text-gray-400">
                {totalCount}/{totalHours.toFixed(0)}h
              </div>
              {holidayName && (
                <div className="mt-0.5 truncate text-[8px] font-normal uppercase tracking-wide text-indigo-600 dark:text-indigo-400" title={holidayName}>
                  {holidayName}
                </div>
              )}
              {isPto && (
                <div className="mt-0.5 truncate text-[8px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  PTO
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showFallbackBanner && (
          <div className="mx-3 my-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <p>
                <strong>{t('calendar.person_switcher.not_connected_prefix')}</strong>{' '}
                {t('calendar.person_switcher.real_calendar_unavailable', { name: personName ?? '' })}
              </p>
              <a
                href="https://github.com/egarlepp/impactiq/blob/main/docs/outlook-app-only.md"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 inline-block underline"
              >{t('calendar.person_switcher.link_to_docs')}</a>
            </div>
          </div>
        )}
        {statusLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        )}
        {!statusLoading && status && !status.configured && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>{t('calendar.not_configured')}</span>
          </div>
        )}
        {!statusLoading && status && status.configured && !status.connected && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('calendar.connect_required')}</p>
            <Button size="sm" onClick={connect}>
              <Cloud className="h-4 w-4" />
              {t('calendar.connect_button')}
            </Button>
          </div>
        )}
        {(enabled || activities.length > 0) && (
          <>
            {eventsLoading && (
              <div className="flex justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              </div>
            )}
            {error && !showFallbackBanner && (
              <p className="mx-3 my-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </p>
            )}
            {!eventsLoading && !error && (
              <CalendarGrid
                days={days}
                hours={hours}
                dayStart={dayStart}
                dayEnd={dayEnd}
                gridStartHour={gridStartHour}
                gridEndHour={gridEndHour}
                workDayLen={workDayLen}
                workDaysMask={workDaysMask}
                ptoDates={ptoDates}
                events={
                  viewMode === 'activities_approved'
                    ? []
                    : showNonActivities
                    ? events
                    : events.filter((e) => !nonActivityIds?.has(e.id))
                }
                activities={viewMode === 'not_approved' ? [] : activities}
                onEventClick={onEventClick}
                onActivityClick={onActivityClick}
                nonActivityIds={nonActivityIds}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function CalendarGrid({
  days,
  hours,
  dayStart,
  dayEnd,
  gridStartHour,
  gridEndHour,
  workDayLen: _workDayLen,
  workDaysMask,
  ptoDates,
  events,
  activities,
  onEventClick,
  onActivityClick,
  nonActivityIds,
}: {
  days: Date[]
  hours: number[]
  dayStart: number
  dayEnd: number
  gridStartHour: number
  gridEndHour: number
  workDayLen: number
  workDaysMask: number
  ptoDates: Set<string>
  events: CalendarEvent[]
  activities: Activity[]
  onEventClick: (e: CalendarEvent) => void
  onActivityClick?: (a: Activity) => void
  nonActivityIds?: Set<string>
}) {
  // Auto-scroll to the work-day start so 24-hour grid opens on the productive
  // window; user can still scroll up/down to see off-hours items.
  const gridRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (gridRef.current) {
      const offset = Math.max(0, (dayStart - gridStartHour) * SLOT_HEIGHT_PX - 8)
      gridRef.current.scrollTop = offset
    }
  }, [dayStart, gridStartHour])
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const { user: gridUser } = useCurrentUser()
  const gridTz = gridUser?.timezone ?? null
  // Bucket into per-day lists using the user's TZ so events near
  // midnight don't land on the wrong column when browser TZ ≠ user TZ.
  const dayYmds = days.map((d) => ymdInTZ(d, gridTz))
  const activitiesByDay: Activity[][] = days.map(() => [])
  for (const a of activities) {
    const ymd = ymdInTZ(a.startDatetime, gridTz)
    const i = dayYmds.indexOf(ymd)
    if (i >= 0) {
      activitiesByDay[i]!.push(a)
    }
  }
  // Only render outlook events that aren't already covered by an activity —
  // the activity itself will draw with its type color.
  const eventsByDay: CalendarEvent[][] = days.map(() => [])
  for (const e of events) {
    if (e.alreadyLogged) continue
    const ymd = ymdInTZ(e.start, gridTz)
    const i = dayYmds.indexOf(ymd)
    if (i >= 0) eventsByDay[i]!.push(e)
  }
  // v1.241.0: the viewer's own Tentative RSVPs, for the hatch pattern. Built
  // from the full `events` list (not eventsByDay, which drops already-logged
  // ones) precisely so an APPROVED activity's block can be matched back to
  // its source meeting and stay striped.
  const tentativeEventIds = new Set<string>()
  for (const e of events) {
    if (e.responseStatus === 'tentativelyAccepted') tentativeEventIds.add(e.id)
  }

  return (
    <div ref={gridRef} className="relative min-h-0 flex-1 overflow-y-scroll">
      <div
        className="grid"
        style={{ gridTemplateColumns: `40px repeat(${days.length}, minmax(0, 1fr))` }}
      >
        <div className="flex flex-col">
          {hours.map((h) => {
            const isOffHour = h < dayStart || h >= dayEnd
            return (
              <div key={h} className={cn('relative border-b border-gray-100 dark:border-gray-700', isOffHour && 'bg-gray-50 dark:bg-black/40')} style={{ height: SLOT_HEIGHT_PX }}>
                <span className={cn('absolute right-1 top-0 text-[10px]', isOffHour ? 'text-gray-300 dark:text-gray-600' : 'text-gray-400 dark:text-gray-500')}>
                  {format(new Date().setHours(h, 0), 'h a')}
                </span>
              </div>
            )
          })}
        </div>

        {days.map((day, dayIdx) => {
          const bit = workDayBit(day)
          const isWorkDay = (workDaysMask & bit) !== 0
          const isPto = ptoDates.has(format(day, 'yyyy-MM-dd'))
          return (
            <div
              key={day.toISOString()}
              className={cn(
                'relative border-l border-gray-100 dark:border-gray-700',
                !isWorkDay && 'bg-gray-100/60 dark:bg-gray-800/40',
                isPto && 'bg-amber-100/50 dark:bg-amber-950/30',
              )}
            >
              {isPto && (
                <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] flex justify-center pt-1">
                  <div className="sticky top-1 rounded-md bg-amber-500/90 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                    PTO
                  </div>
                </div>
              )}
              {hours.map((h) => {
                const isOffHour = h < dayStart || h >= dayEnd
                return (
                  <div key={h} className={cn('border-b border-gray-100 dark:border-gray-700', isOffHour && !isPto && 'bg-gray-100/40 dark:bg-black/40')} style={{ height: SLOT_HEIGHT_PX }} />
                )
              })}
              {activitiesByDay[dayIdx]?.map((a) => {
                const s = new Date(a.startDatetime)
                const e = new Date(a.endDatetime)
                // Position the chip using the user's TZ so the row it
                // paints in matches the label rendered by formatTimeInTZ.
                // Using s.getHours() would use the browser TZ and
                // disagree with the label when the two differ.
                const wall = wallClockInTZ(s, gridTz)
                const startMin = wall.hour * 60 + wall.minute - gridStartHour * 60
                const durMin = Math.max(15, differenceInMinutes(e, s))
                if (startMin + durMin < 0 || startMin > (gridEndHour - gridStartHour) * 60) return null
                const top = (startMin / 60) * SLOT_HEIGHT_PX
                const height = (durMin / 60) * SLOT_HEIGHT_PX
                const color = a.activityTypeColor ?? null
                const style: React.CSSProperties = { top, height: Math.max(SLOT_HEIGHT_PX / 2, height) }
                if (color) {
                  style.backgroundColor = `${color}33`
                  style.borderLeft = `3px solid ${color}`
                  style.color = color
                }
                // v1.242.0: Keep was chosen after the Outlook meeting was
                // deleted — this activity lives in ImpactIQ + Salesforce only.
                // Marked on the RIGHT edge specifically because the left edge
                // already carries the activity-type color bar.
                if (a.outlookDeletedKept) {
                  style.borderRight = '3px solid rgb(156 163 175)'
                }
                return (
                  <button
                    key={`a-${a.id}`}
                    onClick={() => onActivityClick?.(a)}
                    className={cn(
                      'absolute left-0.5 right-0.5 overflow-hidden rounded border px-1 py-0.5 text-left text-[10px] leading-tight transition-colors',
                      !color && 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/50 dark:text-green-300',
                      color && 'border-transparent',
                      !!a.outlookEventId && tentativeEventIds.has(a.outlookEventId) && 'stripe-tentative',
                    )}
                    style={style}
                    title={a.isPrivateMeeting ? t('activity.private_meeting.title', 'Private meeting') : a.outlookDeletedKept ? `${a.title} — ${t('activity.outlook_deleted.kept_hint', { context: crmCtx })}` : a.title}
                  >
                    <div className="flex items-center gap-1">
                      {a.isPrivateMeeting ? (
                        <Lock className="h-2.5 w-2.5 shrink-0" />
                      ) : a.activityTypeIcon ? (
                        <DynamicIcon name={a.activityTypeIcon} className="h-2.5 w-2.5 shrink-0" />
                      ) : (
                        <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
                      )}
                      <span className="truncate font-medium">{a.isPrivateMeeting ? t('activity.private_meeting.title', 'Private meeting') : a.title}</span>
                    </div>
                    <span className="text-[9px] opacity-70">{formatTimeInTZ(s, gridTz)} · {Number(a.effortHours).toFixed(1)}h</span>
                  </button>
                )
              })}
              {eventsByDay[dayIdx]?.map((event) => {
                const start = new Date(event.start)
                const end = new Date(event.end)
                const eWall = wallClockInTZ(start, gridTz)
                const startMin = eWall.hour * 60 + eWall.minute - gridStartHour * 60
                const durMin = Math.max(15, differenceInMinutes(end, start))
                if (startMin + durMin < 0 || startMin > (gridEndHour - gridStartHour) * 60) return null
                const top = (startMin / 60) * SLOT_HEIGHT_PX
                const height = (durMin / 60) * SLOT_HEIGHT_PX
                const isNonActivity = nonActivityIds?.has(event.id) ?? false
                const isTentative = event.responseStatus === 'tentativelyAccepted'
                return (
                  <button
                    key={event.id}
                    onClick={() => onEventClick(event)}
                    className={cn(
                      'absolute left-0.5 right-0.5 overflow-hidden rounded border px-1 py-0.5 text-left text-[10px] leading-tight transition-colors',
                      isNonActivity
                        ? 'border-gray-600 bg-gray-600 text-gray-100 hover:bg-gray-700 dark:border-gray-500 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
                        : 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800/60 dark:text-gray-300',
                      isTentative && 'stripe-tentative',
                    )}
                    style={{ top, height: Math.max(SLOT_HEIGHT_PX / 2, height) }}
                    title={event.isPrivate ? t('activity.private_meeting.title', 'Private meeting') : isTentative ? `${event.subject} — ${t('activity.tentative.label')}` : event.subject}
                  >
                    <span className="flex items-center gap-1 truncate font-medium">
                      {event.isPrivate && <Lock className="h-2.5 w-2.5 shrink-0" />}
                      <span className="truncate">{event.isPrivate ? t('activity.private_meeting.title', 'Private meeting') : event.subject}</span>
                    </span>
                    <span className="text-[9px] opacity-70">{formatTimeInTZ(start, gridTz)}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface TeamMemberRow {
  userId: string
  displayName: string
  email: string
  role: string
}

function PersonSwitcher({ teamId, value, onChange, selfLabel, selfValue }: { teamId: string; value: string | null; onChange: (userId: string | null) => void; selfLabel: string; selfValue: string | null }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<TeamMemberRow[]>([])
  // v1.228.0: keyed by teamId, not a plain boolean — `if (loaded) return`
  // meant a team switch never re-fetched, so the switcher kept showing the
  // PREVIOUS team's members instead of the newly-selected team's (or an
  // empty list, if the new team genuinely has none).
  const [loadedForTeamId, setLoadedForTeamId] = useState<string | null>(null)
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const loaded = loadedForTeamId === teamId

  useEffect(() => {
    if (loadedForTeamId === teamId) return
    let cancelled = false
    void (async () => {
      const res = await api.get<TeamMemberRow[]>(`/api/admin/teams/${teamId}/users`)
      if (cancelled) return
      const rows = res.data ?? []
      if (res.data) {
        setMembers(rows)
        setAllowed(true)
      } else {
        setMembers([])
        setAllowed(false)
      }
      setLoadedForTeamId(teamId)
      // v1.233.0: the member list is now fresh for the new team, but the
      // caller's selected `value` may still point at a teammate from the
      // PREVIOUS team who isn't in `rows` at all — that read as a stale
      // "…" label, and more importantly kept feeding an out-of-team user
      // id into the calendar/activity data hooks above. Drop back to
      // "self" (always valid) if the current selection no longer resolves.
      if (value && value !== selfValue && !rows.some((m) => m.userId === value)) {
        onChange(selfValue)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, loadedForTeamId])

  if (loaded && !allowed) return null

  const isSelf = !value || value === selfValue
  const selectedLabel = isSelf ? selfLabel : (members.find((m) => m.userId === value)?.displayName ?? '…')

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        title={t('calendar.person_switcher.label')}
      >
        {selectedLabel}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          <button
            type="button"
            onClick={() => { onChange(selfValue); setOpen(false) }}
            className={cn('block w-full px-3 py-1 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700', isSelf && 'font-semibold')}
          >
            {selfLabel}
          </button>
          <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
          {members.map((m) => (
            <button
              key={m.userId}
              type="button"
              onClick={() => { onChange(m.userId); setOpen(false) }}
              className={cn('block w-full px-3 py-1 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700', value === m.userId && 'font-semibold')}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
