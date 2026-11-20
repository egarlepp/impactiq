import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { startOfMonth, endOfMonth, startOfWeek, addDays, addMonths, format, isSameMonth, isSameDay } from 'date-fns'
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { api } from '../../lib/api.js'
import { useFiscalConfig, fiscalLabelOf } from '../../hooks/useFiscalConfig.js'
import { getDateFnsLocale } from '../../lib/dateFnsLocale.js'

interface HeatmapResponse {
  starts: string[]
  // v1.363.0: start dates of activities still awaiting a Keep/Delete decision
  // after their Outlook meeting was deleted (§10) — drives the red dot.
  outlookDeletedStarts?: string[]
}

interface HeatmapData {
  counts: Record<string, number>
  max: number
  outlookDeletedDays: Set<string>
}

interface MonthHeatmapProps {
  weekStart: Date
  userId: string | null
  teamId: string | null
  onDayClick: (date: Date) => void
  // v1.237.0: mirrors the Activities page's Sun-first/Mon-first toggle so
  // the month grid's row layout and "current week" highlight box agree
  // with the day list/calendar panel above it. `weekStart` is expected to
  // already be the caller's display-adjusted week start (Monday when true,
  // the Sunday before it when false) — see WeeklyView.tsx's
  // `displayWeekStart`. Defaults to Monday-first for any other caller that
  // hasn't opted into the toggle (e.g. leader dashboards).
  weekStartsMonday?: boolean
  // v1.246.0: bumped by the parent's single-source `reloadAll` on every
  // mutation path (Approve, Approve-with-template, drawer Save/Save &
  // Approve, Delete, Unapprove, Refresh Outlook, Keep/Purge deleted) — same
  // signal CalendarPanel already consumes via its own `reloadKey`. Without
  // this the heatmap's counts were stuck at whatever they were on page
  // load/month-page/team-or-user switch, since its fetch effect below had
  // no other reason to re-run after an approval.
  reloadKey?: number
}

// Blended color scale: 5 buckets. `#F3F4F6` for zero counts (neutral), and
// four green shades ramping to full saturation at the month's max count.
const BUCKET_COLORS = ['#F3F4F6', '#DCFCE7', '#86EFAC', '#22C55E', '#15803D']
const DARK_BUCKET_COLORS = ['#374151', '#14532D', '#166534', '#22C55E', '#4ADE80']

function bucketFor(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function MonthHeatmap({ weekStart, userId, teamId, onDayClick, weekStartsMonday = true, reloadKey }: MonthHeatmapProps) {
  const { t, i18n } = useTranslation()
  const dateFnsLocale = getDateFnsLocale(i18n.language)
  const fiscalCfg = useFiscalConfig()
  const [data, setData] = useState<HeatmapData>({ counts: {}, max: 0, outlookDeletedDays: new Set() })
  const [loading, setLoading] = useState(false)
  // Month offset relative to the focused week's month. 0 = follow the week,
  // negative/positive = user paged backward/forward through months via the
  // chevrons below — a purely local browsing state that doesn't touch the
  // parent's focused week.
  //
  // Bug this guards against: paging to e.g. July while August is the focused
  // week sets monthOffset = -1, entirely independent of `weekStart`. Clicking
  // a day in July then calls onDayClick, which the parent handles by moving
  // its OWN focused week to July via setWeekOffset. That flows back down as a
  // new `weekStart` prop — but monthOffset was still -1, so the next render
  // computed startOfMonth(newWeekStart) MINUS ANOTHER MONTH, landing on June.
  // Any change to `weekStart` means the parent has navigated (whether via its
  // own prev/next-week controls or because a click here caused it to), so the
  // browsing offset is stale and must reset — the newly focused week's month
  // is exactly what offset 0 already means.
  const [monthOffset, setMonthOffset] = useState(0)
  useEffect(() => {
    setMonthOffset(0)
  }, [weekStart.getTime()])

  const baseMonth = startOfMonth(weekStart)
  const monthStart = addMonths(baseMonth, monthOffset)
  const monthEnd = endOfMonth(monthStart)
  const gridWeekStartsOn = weekStartsMonday ? 1 : 0
  const gridStart = startOfWeek(monthStart, { weekStartsOn: gridWeekStartsOn })

  const prevMonth = addMonths(monthStart, -1)
  const nextMonth = addMonths(monthStart, 1)

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({
      year: String(monthStart.getFullYear()),
      month: String(monthStart.getMonth() + 1),
    })
    if (userId) params.set('userId', userId)
    if (teamId) params.set('teamId', teamId)
    api.get<HeatmapResponse>(`/api/activities/month-heatmap?${params.toString()}`).then((res) => {
      // Bucket each start into its own local-date key so the calendar cells
      // agree with what the weekly activity list shows. Only starts that fall
      // inside the visible month contribute to `max`, otherwise a single
      // out-of-month activity would flatten the color scale for this month.
      const starts = res.data?.starts ?? []
      const counts: Record<string, number> = {}
      let max = 0
      for (const s of starts) {
        const key = dateKey(new Date(s))
        counts[key] = (counts[key] ?? 0) + 1
      }
      const monthKeyPrefix = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-`
      for (const [k, v] of Object.entries(counts)) {
        if (k.startsWith(monthKeyPrefix) && v > max) max = v
      }
      const outlookDeletedDays = new Set((res.data?.outlookDeletedStarts ?? []).map((s) => dateKey(new Date(s))))
      setData({ counts, max, outlookDeletedDays })
      setLoading(false)
    })
  }, [monthStart.getTime(), userId, teamId, reloadKey])

  const cells: { date: Date; count: number; inMonth: boolean; isFocusedWeek: boolean }[] = []
  // `weekStart` is already the caller's display-adjusted anchor (Monday, or
  // the Sunday before it) — startOfWeek with the matching weekStartsOn is a
  // no-op on it and only exists to normalize third-party callers that still
  // pass a raw Monday-anchored date regardless of `weekStartsMonday`.
  const focusedWeekStart = startOfWeek(weekStart, { weekStartsOn: gridWeekStartsOn })
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i)
    const cellWeek = startOfWeek(d, { weekStartsOn: gridWeekStartsOn })
    cells.push({
      date: d,
      count: data.counts[dateKey(d)] ?? 0,
      inMonth: isSameMonth(d, monthStart),
      isFocusedWeek: isSameDay(cellWeek, focusedWeekStart),
    })
    // Stop once we've completed a full row past month-end — row boundaries
    // are every 7th cell regardless of which weekday the grid starts on
    // (was `d.getDay() === 0`, which only matched a completed row when the
    // grid was Monday-first, i.e. Sunday fell last).
    if (d > monthEnd && (i + 1) % 7 === 0) break
  }

  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const palette = isDark ? DARK_BUCKET_COLORS : BUCKET_COLORS

  return (
    <div className="border-t border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
          <CalendarRange className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          {t('activities.heatmap.title', { month: format(monthStart, 'MMMM yyyy', { locale: dateFnsLocale }) })}
          <span className="ml-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300" title={t('weekly.fiscal_period')}>
            {fiscalLabelOf(monthStart, fiscalCfg)}
          </span>
        </span>
        <div className="flex items-center gap-1">
          {loading && <span className="text-[10px] text-gray-400">…</span>}
          <button
            type="button"
            onClick={() => setMonthOffset((m) => m - 1)}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={t('activities.heatmap.prev_month')}
            title={format(prevMonth, 'MMMM yyyy', { locale: dateFnsLocale })}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setMonthOffset((m) => m + 1)}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={t('activities.heatmap.next_month')}
            title={format(nextMonth, 'MMMM yyyy', { locale: dateFnsLocale })}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          {monthOffset !== 0 && (
            <button
              type="button"
              onClick={() => setMonthOffset(0)}
              className="ml-1 rounded px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
              title={t('activities.heatmap.this_month')}
            >
              {t('activities.heatmap.this_month')}
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {(weekStartsMonday ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['S', 'M', 'T', 'W', 'T', 'F', 'S']).map((d, i) => (
          <div key={i} className="text-center text-[9px] font-medium text-gray-400 dark:text-gray-500">{d}</div>
        ))}
        {cells.map((c, i) => {
          const bucket = bucketFor(c.count, data.max)
          const bg = palette[bucket] ?? palette[0]
          const numberBoxOnDark = bucket >= 3
          const hasOutlookDeleted = data.outlookDeletedDays.has(dateKey(c.date))
          const title = hasOutlookDeleted
            ? `${format(c.date, 'PP', { locale: dateFnsLocale })} · ${t('activities.heatmap.approved_count', { count: c.count })} · ${t('activities.heatmap.outlook_deleted_hint')}`
            : `${format(c.date, 'PP', { locale: dateFnsLocale })} · ${t('activities.heatmap.approved_count', { count: c.count })}`
          return (
            <button
              key={i}
              type="button"
              onClick={() => onDayClick(c.date)}
              className={cn(
                'relative overflow-hidden rounded text-[10px] leading-none transition-transform hover:scale-105',
                c.inMonth ? 'text-gray-800 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600 opacity-50',
                c.isFocusedWeek && 'ring-2 ring-indigo-500 ring-offset-1 dark:ring-offset-gray-900',
              )}
              style={{ backgroundColor: bg, height: 26 }}
              title={title}
            >
              {/* Date badge in top-left */}
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 rounded-sm px-0.5 py-px text-[9px] font-semibold leading-none',
                  numberBoxOnDark ? 'bg-white/70 text-gray-900' : 'bg-white/80 text-gray-800 dark:bg-gray-900/60 dark:text-gray-100',
                )}
              >
                {format(c.date, 'd')}
              </span>
              {/* Approved-activity count in bottom-right */}
              {c.count > 0 && (
                <span
                  className={cn(
                    'absolute bottom-0.5 right-0.5 text-[9px] font-semibold leading-none',
                    numberBoxOnDark ? 'text-white' : 'text-gray-700 dark:text-gray-200',
                  )}
                >
                  {c.count}
                </span>
              )}
              {/* v1.363.0: pending deleted-Outlook-meeting decision — red dot,
                  top-right corner, independent of the count badge below it. */}
              {hasOutlookDeleted && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-red-500 ring-1 ring-white dark:ring-gray-900" />
              )}
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[9px] text-gray-500 dark:text-gray-400">
        <span>{t('activities.heatmap.legend.less')}</span>
        <div className="flex items-center gap-0.5">
          {palette.map((c, i) => (
            <div key={i} className="h-3 w-3 rounded" style={{ backgroundColor: c }} />
          ))}
        </div>
        <span>{t('activities.heatmap.legend.more')}</span>
      </div>
    </div>
  )
}
