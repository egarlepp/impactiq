import { useMemo, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { addDays, isSameDay } from 'date-fns'
import { Gauge } from 'lucide-react'
import type { Activity } from '../../hooks/useActivities.js'
import { useWeeklyCapacity } from '../../lib/weeklyCapacity.js'
import { cn } from '../../lib/utils.js'
import { DynamicIcon } from '../ui/icon-picker.js'

interface Props {
  activities: Activity[]
  weekStart: Date
  workDays: number
  workDayStartHour: number
  workDayEndHour: number
  onFilterType?: (typeId: string | null) => void
  filterTypeId?: string | null
  // Hours from Outlook meetings this week that are NOT logged as ImpactIQ
  // activities — both meetings explicitly marked Non-Activity and meetings
  // that simply haven't been categorized. They still consume the user's time,
  // so they're shown as a dark-grey segment for a complete capacity picture.
  otherMeetingHours?: number
}

const FALLBACK_COLOR = '#94A3B8'
// Dark grey — the None/Non-Activity anchor color (CLAUDE.md §7) so the bar
// agrees with how those meetings render elsewhere.
const OTHER_COLOR = '#6B7280'

interface Segment {
  key: string
  name: string
  color: string
  icon: string | null
  hours: number
}

// Reserve for the "+N more" chip — a fixed estimate rather than a measured
// width, since its own text length depends on the count we're solving for.
const MORE_CHIP_RESERVE_PX = 64
const LEGEND_GAP_PX = 8 // gap-x-2

function LegendChip({
  segment: s,
  active,
  clickable,
  onClick,
  hint,
}: {
  segment: Segment
  active: boolean
  clickable: boolean
  onClick: () => void
  hint?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      title={hint}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-gray-600 transition-colors dark:text-gray-400',
        clickable && 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800',
        active && 'bg-blue-100 text-blue-700 ring-1 ring-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:ring-blue-800',
      )}
    >
      {s.icon ? (
        <DynamicIcon name={s.icon} className="h-2 w-2 shrink-0" style={{ color: s.color }} />
      ) : (
        <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
      )}
      <span className="truncate max-w-[8rem]">{s.name}</span>
      <span className="text-gray-400 dark:text-gray-500">{s.hours.toFixed(1)}h</span>
    </button>
  )
}

export function WeeklyCapacityBar({
  activities,
  weekStart,
  workDays,
  workDayStartHour,
  workDayEndHour,
  onFilterType,
  filterTypeId = null,
  otherMeetingHours = 0,
}: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const cap = useWeeklyCapacity(activities, weekStart, workDays, workDayStartHour, workDayEndHour)
  const { capacity, logged } = cap
  const otherHours = Math.max(0, otherMeetingHours)
  // "True" utilization counts uncaptured meeting time too, not just logged
  // activities — otherwise a week that's all meetings reads as ~0%.
  const combinedPct = capacity > 0 ? Math.round(((logged + otherHours) / capacity) * 100) : 0

  const segments = useMemo<Segment[]>(() => {
    const days7 = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
    const inWeek = activities.filter((a) => days7.some((d) => isSameDay(new Date(a.startDatetime), d)))
    const byType = new Map<string, Segment>()
    for (const a of inWeek) {
      const key = a.activityTypeId
      const entry = byType.get(key) ?? {
        key,
        name: a.activityTypeName ?? '—',
        color: a.activityTypeColor ?? FALLBACK_COLOR,
        icon: a.activityTypeIcon ?? null,
        hours: 0,
      }
      entry.hours += Number(a.effortHours)
      byType.set(key, entry)
    }
    return Array.from(byType.values()).sort((a, b) => b.hours - a.hours)
  }, [activities, weekStart])

  const otherSegment: Segment | null = otherHours > 0
    ? { key: '__other__', name: t('activity.weekly_bar.other_meetings_label'), color: OTHER_COLOR, icon: null, hours: otherHours }
    : null

  // v1.281.0: the legend stays on one row (no wrap) and shows only as many
  // type chips as actually fit, with "+N more" for the rest — width-aware
  // instead of the old hardcoded "top 4". The "Other meetings" chip is
  // always shown (reserved space, not subject to truncation) since it's a
  // distinct, always-relevant figure, not just another type.
  const legendWrapRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(segments.length)

  useLayoutEffect(() => {
    const wrap = legendWrapRef.current
    const measure = measureRef.current
    if (!wrap || !measure) return
    function recompute() {
      if (!wrap || !measure) return
      const available = wrap.clientWidth
      const kids = Array.from(measure.children) as HTMLElement[]
      const otherWidth = otherSegment ? (kids[kids.length - 1]?.offsetWidth ?? 0) : 0
      const typeKids = otherSegment ? kids.slice(0, -1) : kids
      const budget = available - otherWidth - (otherSegment ? LEGEND_GAP_PX : 0)
      let used = 0
      let count = 0
      for (let i = 0; i < typeKids.length; i++) {
        const w = typeKids[i]?.offsetWidth ?? 0
        const gap = i > 0 ? LEGEND_GAP_PX : 0
        const isLast = i === typeKids.length - 1
        const cap2 = isLast ? budget : budget - MORE_CHIP_RESERVE_PX
        if (used + gap + w > cap2) break
        used += gap + w
        count += 1
      }
      setVisibleCount(count)
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [segments, otherSegment])

  const visibleSegments = segments.slice(0, visibleCount)
  const restCount = segments.length - visibleSegments.length

  // Total time consumed this week = logged ImpactIQ hours + uncaptured meeting
  // hours. Widths, remainder, and overflow are all measured against this total
  // so the grey "other meetings" block counts toward utilization.
  const totalUtilized = logged + otherHours
  const denom = Math.max(capacity, totalUtilized, 0.0001)
  const remainderHours = Math.max(0, capacity - totalUtilized)
  const overflow = Math.max(0, totalUtilized - capacity)
  const overCapacity = overflow > 0

  const handleBarClick = () => {
    navigate('/dashboard')
  }
  const toggleFilter = (typeId: string) => {
    if (!onFilterType) return
    onFilterType(filterTypeId === typeId ? null : typeId)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-gray-300">
          <Gauge className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          {t('activity.weekly_bar.title')}
          <span className={cn(
            'ml-1 font-normal',
            overCapacity ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400',
          )}>
            {logged.toFixed(1)}h / {capacity}h · {combinedPct}%
          </span>
          {otherHours > 0 && (
            <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">
              · {t('activity.weekly_bar.other_meetings', { hours: otherHours.toFixed(1) })}
            </span>
          )}
          {overCapacity && (
            <span className="text-red-600 dark:text-red-400">
              · {t('activity.weekly_bar.over_by', { hours: overflow.toFixed(1) })}
            </span>
          )}
        </span>
        <div ref={legendWrapRef} className="flex min-w-0 flex-1 items-center justify-end gap-x-2 overflow-hidden">
          {visibleSegments.map((s) => (
            <LegendChip
              key={s.key}
              segment={s}
              active={filterTypeId === s.key}
              clickable={Boolean(onFilterType)}
              onClick={() => toggleFilter(s.key)}
              hint={onFilterType ? t('activity.weekly_bar.filter_by_type', { name: s.name }) : undefined}
            />
          ))}
          {restCount > 0 && (
            <span className="shrink-0 text-gray-500 dark:text-gray-400">
              {t('activity.weekly_bar.more', { count: restCount })}
            </span>
          )}
          {otherSegment && (
            <span
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-gray-600 dark:text-gray-400"
              title={t('activity.weekly_bar.other_meetings_hint')}
            >
              <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: OTHER_COLOR }} />
              <span className="truncate max-w-[8rem]">{otherSegment.name}</span>
              <span className="text-gray-400 dark:text-gray-500">{otherSegment.hours.toFixed(1)}h</span>
            </span>
          )}
        </div>
        {/* Hidden measurement row — same chips, off-screen, used only to
            read natural widths so the visible row above can decide how many
            fit in one line without ever wrapping (see the ResizeObserver
            effect above). */}
        <div
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute flex items-center gap-x-2 whitespace-nowrap"
          style={{ left: -99999, top: -99999 }}
        >
          {segments.map((s) => <LegendChip key={s.key} segment={s} active={false} clickable={false} onClick={() => {}} />)}
          {otherSegment && <LegendChip segment={otherSegment} active={false} clickable={false} onClick={() => {}} />}
        </div>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={handleBarClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleBarClick() } }}
        title={t('activity.weekly_bar.click_to_dashboard')}
        className="group relative flex h-3.5 w-full cursor-pointer items-stretch overflow-hidden rounded-md bg-gray-200 ring-1 ring-inset ring-gray-200 transition-shadow hover:ring-blue-400 dark:bg-gray-800 dark:ring-gray-700 dark:hover:ring-blue-500"
        aria-label={t('activity.weekly_bar.click_to_dashboard')}
      >
        {segments.map((s) => {
          const width = (s.hours / denom) * 100
          if (width <= 0) return null
          const active = filterTypeId === s.key
          const dim = filterTypeId !== null && !active
          const clickable = Boolean(onFilterType)
          return (
            <button
              key={s.key}
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleFilter(s.key) }}
              disabled={!clickable}
              style={{ width: `${width}%`, backgroundColor: s.color }}
              className={cn(
                'h-full transition-opacity',
                clickable && 'cursor-pointer hover:opacity-100',
                dim && 'opacity-40',
                active && 'ring-2 ring-inset ring-white dark:ring-gray-100',
              )}
              title={clickable ? t('activity.weekly_bar.filter_by_type', { name: s.name }) : `${s.name} · ${s.hours.toFixed(1)}h`}
              aria-label={`${s.name} · ${s.hours.toFixed(1)}h`}
            />
          )
        })}
        {otherHours > 0 && (() => {
          const width = (otherHours / denom) * 100
          if (width <= 0) return null
          const label = t('activity.weekly_bar.other_meetings_label')
          return (
            <div
              style={{ width: `${width}%`, backgroundColor: OTHER_COLOR }}
              className="h-full"
              title={`${label} · ${otherHours.toFixed(1)}h`}
              aria-label={`${label} · ${otherHours.toFixed(1)}h`}
            />
          )
        })()}
        {remainderHours > 0 && !overCapacity && (
          <span
            style={{ width: `${(remainderHours / denom) * 100}%` }}
            className="h-full bg-transparent"
          />
        )}
        {overCapacity && (
          <span
            className="pointer-events-none absolute inset-y-0 right-0 border-l-2 border-red-500/70 bg-red-500/20"
            style={{ width: `${(overflow / denom) * 100}%` }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  )
}
