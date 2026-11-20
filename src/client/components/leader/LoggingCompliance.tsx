import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { addDays, startOfWeek, startOfMonth, endOfMonth, addMonths, format, isSameMonth } from 'date-fns'
import { ChevronLeft, ChevronRight, CalendarRange } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import { cn } from '../../lib/utils.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { getDateFnsLocale } from '../../lib/dateFnsLocale.js'
import { AllTimeNotApplicable } from './AllTimeNotApplicable.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

interface WeekRow { weekStart: string; pct: number; loggedCount: number; totalMembers: number }
interface Slacker { userId: string; displayName: string }
interface Resp { weekly: WeekRow[]; slackers: Slacker[] }

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; compareMode?: CompareMode }

export function LoggingCompliance({ teamId, weeksBack, productIds = [], userId, memberIds, compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorAvgPct, setPriorAvgPct] = useState<number | null>(null)
  const allTime = weeksBack === 0

  useEffect(() => {
    if (allTime) return
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Resp>(buildDashboardUrl('logging-compliance', { teamId, weeksBack, productIds, userId, memberIds }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [allTime, teamId, weeksBack, productIds.join(','), userId, memberIds?.join(',')])

  useEffect(() => {
    if (allTime) return
    if (compareMode === 'off') { setPriorAvgPct(null); return }
    api.get<Resp>(buildDashboardUrl('logging-compliance', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode) }))
      .then((res) => {
        const w = res.data?.weekly ?? []
        setPriorAvgPct(w.length === 0 ? 0 : w.reduce((s, r) => s + r.pct, 0) / w.length)
      })
  }, [allTime, teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode])

  if (allTime) return <AllTimeNotApplicable />
  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />

  const currentAvgPct = data.weekly.length === 0 ? 0 : data.weekly.reduce((s, r) => s + r.pct, 0) / data.weekly.length

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('leader.compliance.weekly_pct')}</p>
          <span className="text-xs text-gray-500 dark:text-gray-400">avg {currentAvgPct.toFixed(0)}%</span>
          {compareMode !== 'off' && priorAvgPct !== null && (
            <TrendChip current={currentAvgPct} prior={priorAvgPct} mode={compareMode} />
          )}
        </div>
        <div className="grid grid-cols-[100px_1fr_60px] items-center gap-2">
          {data.weekly.map((w) => (
            <div key={w.weekStart} className="contents">
              <span className="text-xs text-gray-600 dark:text-gray-400">{w.weekStart}</span>
              <div className="relative h-4 rounded bg-gray-100 dark:bg-gray-800">
                <div className={`h-full rounded ${w.pct >= 80 ? 'bg-green-500' : w.pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${w.pct}%` }} />
              </div>
              <span className="text-right text-xs font-medium text-gray-700 dark:text-gray-300">{w.pct}% <span className="text-gray-400">({w.loggedCount}/{w.totalMembers})</span></span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">{t('leader.compliance.this_week_missing')}</p>
        {data.slackers.length === 0 ? (
          <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">{t('leader.compliance.all_logged')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.slackers.map((s) => (
              <li key={s.userId} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {s.displayName}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="md:col-span-2">
        <EntryHeatmap teamId={teamId} productIds={productIds} userId={userId} memberIds={memberIds} />
      </div>
    </div>
  )
}

interface EntryHeatmapResp { createdAt: string[]; rangeStart: string }

// Month-calendar heatmap of when activities are entered (createdAt). Users
// can page backward/forward through months; the fetch window widens to
// cover whatever month is showing so a full year of nav still shows data.
function EntryHeatmap({ teamId, productIds, userId, memberIds }: { teamId: string; productIds: string[]; userId?: string | null; memberIds?: string[] }) {
  const { t, i18n } = useTranslation()
  const dateFnsLocale = getDateFnsLocale(i18n.language)
  const [starts, setStarts] = useState<string[] | null>(null)
  const [monthOffset, setMonthOffset] = useState(0)

  // Fetch enough history that all reachable months have data — cheap enough,
  // and it means paging never triggers another round-trip.
  const weeksToFetch = 60

  useEffect(() => {
    void (async () => {
      setStarts(null)
      const res = await api.get<EntryHeatmapResp>(buildDashboardUrl('logging-entry-heatmap', { teamId, weeksBack: weeksToFetch, productIds, userId, memberIds }))
      setStarts(res.data?.createdAt ?? [])
    })()
  }, [teamId, productIds.join(','), userId, memberIds?.join(',')])

  const today = new Date()
  const monthStart = startOfMonth(addMonths(today, monthOffset))
  const monthEnd = endOfMonth(monthStart)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 })

  const { cells, max } = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of (starts ?? [])) {
      const d = new Date(s)
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const cells: { date: Date; count: number; inMonth: boolean }[] = []
    let m = 0
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i)
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      const c = counts.get(key) ?? 0
      // Only in-month cells contribute to the color scale so an outlier in a
      // neighbouring month doesn't flatten this month's shading.
      if (isSameMonth(d, monthStart) && c > m) m = c
      cells.push({ date: d, count: c, inMonth: isSameMonth(d, monthStart) })
      if (d > monthEnd && d.getDay() === 0) break
    }
    return { cells, max: m }
  }, [starts, monthStart.getTime()])

  if (starts === null) return <div className="flex justify-center py-6"><Spinner className="h-4 w-4" /></div>

  function bucket(c: number): number {
    if (c <= 0 || max <= 0) return 0
    const r = c / max
    if (r <= 0.25) return 1
    if (r <= 0.5) return 2
    if (r <= 0.75) return 3
    return 4
  }
  const PALETTE = ['#F3F4F6', '#DBEAFE', '#93C5FD', '#3B82F6', '#1D4ED8']
  const DARK_PALETTE = ['#374151', '#1E3A8A', '#1D4ED8', '#3B82F6', '#60A5FA']
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const palette = isDark ? DARK_PALETTE : PALETTE
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`

  return (
    <div className="rounded-md border border-gray-200 p-4 dark:border-gray-700">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
        <CalendarRange className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        {t('leader.compliance.entry_heatmap_title', 'When activities are entered')}
      </p>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{format(monthStart, 'MMMM yyyy', { locale: dateFnsLocale })}</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMonthOffset((m) => m - 1)}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            title={format(addMonths(monthStart, -1), 'MMMM yyyy', { locale: dateFnsLocale })}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMonthOffset((m) => m + 1)}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            title={format(addMonths(monthStart, 1), 'MMMM yyyy', { locale: dateFnsLocale })}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {monthOffset !== 0 && (
            <button
              type="button"
              onClick={() => setMonthOffset(0)}
              className="ml-1 rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            >
              {t('activities.heatmap.this_month', 'This month')}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 7 }, (_, i) => addDays(gridStart, i)).map((d) => (
          <div key={d.getDay()} className="text-center text-sm font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300">
            {format(d, 'EEE', { locale: dateFnsLocale })}
          </div>
        ))}
        {cells.map((c, i) => {
          const b = bucket(c.count)
          const key = `${c.date.getFullYear()}-${c.date.getMonth()}-${c.date.getDate()}`
          const dark = b >= 3
          return (
            <div
              key={i}
              className={cn(
                'relative flex h-14 flex-col items-start justify-start rounded-md p-1',
                c.inMonth ? '' : 'opacity-40',
                key === todayKey && 'ring-2 ring-indigo-500 ring-offset-1 dark:ring-offset-gray-900',
              )}
              style={{ backgroundColor: palette[b] ?? palette[0] }}
              title={`${format(c.date, 'PP', { locale: dateFnsLocale })} · ${t('leader.compliance.entry_count', { count: c.count, defaultValue: '{{count}} entries' })}`}
            >
              <span className={cn(
                'text-[11px] font-semibold leading-none',
                dark ? 'text-white' : 'text-gray-800 dark:text-gray-100',
              )}>
                {format(c.date, 'd')}
              </span>
              {c.count > 0 && (
                <span className={cn(
                  'mt-auto self-end text-[11px] font-semibold leading-none',
                  dark ? 'text-white' : 'text-gray-700 dark:text-gray-200',
                )}>
                  {c.count}
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
        <span>{t('activities.heatmap.legend.less', 'Less')}</span>
        <div className="flex items-center gap-0.5">
          {palette.map((c, i) => <div key={i} className="h-2.5 w-2.5 rounded" style={{ backgroundColor: c }} />)}
        </div>
        <span>{t('activities.heatmap.legend.more', 'More')}</span>
      </div>
    </div>
  )
}
