import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { dashDateParams } from '../../lib/dashboard-fetch.js'
import { CalendarClock } from 'lucide-react'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { MeetingLoadInfo } from './MeetingLoadInfo.js'
import type { CompareMode } from '../../lib/period.js'

interface Row { userId: string; displayName: string; hours: number; target: number; excludedHours?: number; ptoHours?: number; holidayHours?: number; nonActivityHours?: number; meetingLoadHours?: number }
interface Resp { rows: Row[]; weekStart: string; meetingLoadEnabled?: boolean }

// Dark grey block for uncaptured meeting time — the None/Non-Activity anchor.
const NON_ACTIVITY_COLOR = '#6B7280'
// Amber block for PTO — shows the user the capacity reduction is time off.
const PTO_COLOR = '#F59E0B'
// Indigo block for company holidays — distinct from personal PTO.
const HOLIDAY_COLOR = '#6366F1'

function bucket(hours: number, target: number) {
  if (target <= 0) return 'bg-gray-200 dark:bg-gray-700'
  const pct = hours / target
  if (pct < 0.5) return 'bg-blue-200 dark:bg-blue-900'
  if (pct < 0.8) return 'bg-blue-400 dark:bg-blue-700'
  if (pct < 1.0) return 'bg-blue-600 dark:bg-blue-600'
  if (pct < 1.2) return 'bg-green-500'
  return 'bg-orange-500'
}

const OFFSET_BY_MODE: Record<Exclude<CompareMode, 'off'>, number> = {
  wow: -1,
  mom: -4,
  qoq: -13,
  yoy: -52,
}

export function ThisWeekCapacity({ teamId, productIds = [], userId, memberIds, compareMode = 'off', includeNonActivities = true }: { teamId: string; productIds?: string[]; userId?: string | null; memberIds?: string[]; compareMode?: CompareMode; includeNonActivities?: boolean }) {
  const { t } = useTranslation()
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorTotal, setPriorTotal] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const params = new URLSearchParams({ teamId })
      if (productIds.length > 0) params.set('productIds', productIds.join(','))
      if (userId) params.set('userId', userId)
      if (memberIds && memberIds.length > 0) params.set('userIds', memberIds.join(','))
      if (!includeNonActivities) params.set('nonActivities', '0')
      for (const [k, v] of Object.entries(dashDateParams())) params.set(k, v)
      const res = await api.get<Resp>(`/api/dashboards/this-week-capacity?${params.toString()}`)
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, productIds.join(','), userId, memberIds?.join(','), includeNonActivities])

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotal(null); return }
    const offset = OFFSET_BY_MODE[compareMode]
    const params = new URLSearchParams({ teamId, weekOffset: String(offset) })
    if (productIds.length > 0) params.set('productIds', productIds.join(','))
    if (userId) params.set('userId', userId)
    if (memberIds && memberIds.length > 0) params.set('userIds', memberIds.join(','))
    api.get<Resp>(`/api/dashboards/this-week-capacity?${params.toString()}`).then((res) => {
      const total = (res.data?.rows ?? []).reduce((s, r) => s + r.hours, 0)
      setPriorTotal(total)
    })
  }, [teamId, productIds.join(','), userId, memberIds?.join(','), compareMode])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />
  if (data.rows.length === 0) return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>

  const max = Math.max(...data.rows.map((r) => Math.max(r.hours + (r.nonActivityHours ?? 0) + (r.ptoHours ?? 0) + (r.holidayHours ?? 0), r.target)), 1)
  const currentTotal = data.rows.reduce((s, r) => s + r.hours, 0)
  const anyNonActivity = data.rows.some((r) => (r.nonActivityHours ?? 0) > 0)
  const anyPto = data.rows.some((r) => (r.ptoHours ?? 0) > 0)
  const anyHoliday = data.rows.some((r) => (r.holidayHours ?? 0) > 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('leader.this_week.week_starting', { date: new Date(data.weekStart).toLocaleDateString() })}
        </p>
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
          {t('leader.this_week.total', { hours: currentTotal.toFixed(1) })}
        </span>
        {priorTotal !== null && <TrendChip current={currentTotal} prior={priorTotal} mode={compareMode} />}
        <span className="ml-auto flex items-center gap-3">
          {anyPto && (
            <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: PTO_COLOR }} />
              {t('leader.this_week.pto_legend', 'PTO')}
            </span>
          )}
          {anyHoliday && (
            <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: HOLIDAY_COLOR }} />
              {t('leader.this_week.holiday_legend', 'Holiday')}
            </span>
          )}
          {anyNonActivity && (
            <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: NON_ACTIVITY_COLOR }} />
              {t('leader.non_activities.legend')}
            </span>
          )}
          {data.meetingLoadEnabled && (
            <span
              className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"
              title={t('leader.this_week.meeting_load_hint')}
            >
              <CalendarClock className="h-3 w-3" />
              {t('leader.this_week.meeting_load_legend')}
            </span>
          )}
          {/* Always rendered, unlike the legend badge above — a leader whose
              team hasn't opted in still needs a way to discover why. */}
          <MeetingLoadInfo enabled={data.meetingLoadEnabled} />
        </span>
      </div>
      <div className="grid grid-cols-[160px_1fr_80px] items-center gap-2">
        {data.rows.map((r) => {
          const nonActivity = r.nonActivityHours ?? 0
          const pto = r.ptoHours ?? 0
          const holiday = r.holidayHours ?? 0
          const pct = (r.hours / max) * 100
          const pctNon = (nonActivity / max) * 100
          const pctPto = (pto / max) * 100
          const pctHoliday = (holiday / max) * 100
          const targetPct = (r.target / max) * 100
          // % of target reflects total time used (logged + uncaptured meetings),
          // shown to the tenth so small weeks don't collapse to whole numbers.
          const pctOfTarget = ((r.hours + nonActivity) / Math.max(r.target, 1) * 100).toFixed(1)
          return (
            <div key={r.userId} className="contents">
              <span className="truncate text-xs text-gray-700 dark:text-gray-300">{r.displayName}</span>
              <div className="relative flex h-5 items-stretch overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                <div className={`h-full ${bucket(r.hours, r.target)}`} style={{ width: `${pct}%` }} title={`${r.hours.toFixed(1)}h`} />
                {nonActivity > 0 && (
                  <div className="h-full" style={{ width: `${pctNon}%`, backgroundColor: NON_ACTIVITY_COLOR }} title={`${t('leader.non_activities.legend')} · ${nonActivity.toFixed(1)}h`} />
                )}
                {pto > 0 && (
                  <div className="h-full" style={{ width: `${pctPto}%`, backgroundColor: PTO_COLOR }} title={t('leader.this_week.pto_hint', { hours: pto.toFixed(1) })} />
                )}
                {holiday > 0 && (
                  <div className="h-full" style={{ width: `${pctHoliday}%`, backgroundColor: HOLIDAY_COLOR }} title={t('leader.this_week.holiday_hint', { hours: holiday.toFixed(1) })} />
                )}
                <div className="absolute top-0 h-full w-px bg-gray-600 dark:bg-gray-300" style={{ left: `${targetPct}%` }} />
              </div>
              <span className="text-right text-xs font-medium text-gray-700 dark:text-gray-300" title={r.excludedHours ? t('leader.this_week.excluded_hint', { hours: r.excludedHours.toFixed(1) }) : undefined}>
                {r.hours.toFixed(1)}h
                {nonActivity > 0 && <span className="text-gray-400"> +{nonActivity.toFixed(1)}</span>}
                {pto > 0 && <span style={{ color: PTO_COLOR }}> · {t('leader.this_week.pto_hours', { hours: pto.toFixed(1) })}</span>}
                {holiday > 0 && <span style={{ color: HOLIDAY_COLOR }}> · {t('leader.this_week.holiday_hours', { hours: holiday.toFixed(1) })}</span>}
                <span className="text-gray-400"> / {r.target.toFixed(1)}h ({pctOfTarget}%)</span>
                {r.meetingLoadHours !== undefined && (
                  <span className="ml-1 text-gray-400" title={t('leader.this_week.meeting_load_hint')}>
                    · {t('leader.this_week.meeting_load_hours', { hours: r.meetingLoadHours.toFixed(1) })}
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
