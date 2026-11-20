import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { AllTimeNotApplicable } from './AllTimeNotApplicable.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { MeetingLoadInfo } from './MeetingLoadInfo.js'

interface Row { weekStart: string; totalHours: number }
interface Resp {
  rows: Row[]
  weeks: string[]
  teamCapacityPerWeek: number
  capacityByWeek?: Record<string, number>
  excludedByWeek?: Record<string, number>
  nonActivityByWeek?: Record<string, number>
  // v1.226.0: corrected "real meeting load" figure — see CLAUDE.md §12.1.
  meetingLoadByWeek?: Record<string, number>
  meetingLoadEnabled?: boolean
}

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; compareMode?: CompareMode; includeNonActivities?: boolean }

// Dark grey / near-black block for uncaptured meeting time — matches the
// None/Non-Activity anchor color used across the app.
const NON_ACTIVITY_COLOR = '#374151'
// Teal for real meeting load — distinct from the gray already in use for
// non-activity.
const MEETING_LOAD_COLOR = '#0D9488'

export function CapacityTrend({ teamId, weeksBack, productIds = [], userId, memberIds, compareMode = 'off', includeNonActivities = true }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorTotal, setPriorTotal] = useState<number | null>(null)
  // All-time (weeksBack=0) short-circuits — this chart is one-column-per-
  // week and rendering years of columns would be unreadable.
  const allTime = weeksBack === 0

  useEffect(() => {
    if (allTime) return
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Resp>(buildDashboardUrl('capacity-trend', { teamId, weeksBack, productIds, userId, memberIds, extra: { nonActivities: includeNonActivities ? '1' : '0' } }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [allTime, teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), includeNonActivities])

  useEffect(() => {
    if (allTime) return
    if (compareMode === 'off') { setPriorTotal(null); return }
    api.get<Resp>(buildDashboardUrl('capacity-trend', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode) }))
      .then((res) => setPriorTotal((res.data?.rows ?? []).reduce((s, r) => s + Number(r.totalHours), 0)))
  }, [allTime, teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode])

  if (allTime) return <AllTimeNotApplicable />
  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />

  const byWeek = Object.fromEntries(data.rows.map((r) => [r.weekStart.slice(0, 10), Number(r.totalHours)]))
  const naByWeek = data.nonActivityByWeek ?? {}
  const capByWeek = data.capacityByWeek ?? {}
  const exclByWeek = data.excludedByWeek ?? {}
  const mlByWeek = data.meetingLoadByWeek ?? {}
  const baseCap = data.teamCapacityPerWeek
  // Per-week capacity net of the team's PTO + holidays that week (falls back
  // to the flat base if the server didn't send a per-week value).
  const series = data.weeks.map((w) => ({
    week: w,
    hours: byWeek[w] ?? 0,
    nonActivity: naByWeek[w] ?? 0,
    cap: capByWeek[w] ?? baseCap,
    excluded: exclByWeek[w] ?? 0,
    meetingLoad: mlByWeek[w] ?? 0,
  }))
  const anyNonActivity = series.some((s) => s.nonActivity > 0)
  const anyExcluded = series.some((s) => s.excluded > 0)
  const anyMeetingLoad = series.some((s) => s.meetingLoad > 0)
  const max = Math.max(baseCap * 1.2, ...series.map((s) => s.hours + s.nonActivity + s.meetingLoad), 1)

  if (series.every((s) => s.hours === 0 && s.nonActivity === 0 && s.meetingLoad === 0)) {
    return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>
  }

  const currentTotal = series.reduce((s, x) => s + x.hours, 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-600 dark:text-gray-300">
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-blue-500" />{t('leader.capacity_trend.logged')}</span>
        {anyNonActivity && (
          <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm" style={{ backgroundColor: NON_ACTIVITY_COLOR }} />{t('leader.non_activities.legend')}</span>
        )}
        {anyMeetingLoad && (
          <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm" style={{ backgroundColor: MEETING_LOAD_COLOR }} />{t('leader.this_week.meeting_load_legend')}</span>
        )}
        <span className="flex items-center gap-1.5"><span className="h-px w-3 bg-orange-500" />{t('leader.capacity_trend.capacity', { hours: baseCap })}</span>
        {anyExcluded && (
          <span className="text-gray-400 dark:text-gray-500">{t('leader.capacity_trend.capacity_net_note', 'Capacity marker drops on weeks with team PTO / holidays')}</span>
        )}
        {/* Always rendered, unlike the swatch above — a leader whose team
            hasn't opted in still needs a way to discover why. */}
        <MeetingLoadInfo enabled={data.meetingLoadEnabled} />
        {compareMode !== 'off' && priorTotal !== null && (
          <span className="ml-auto flex items-center gap-2"><span>Total: {currentTotal.toFixed(1)}h</span><TrendChip current={currentTotal} prior={priorTotal} mode={compareMode} /></span>
        )}
      </div>
      <div className="grid grid-cols-[120px_1fr_60px] items-center gap-2">
        {series.map((s) => {
          const pctHours = (s.hours / max) * 100
          const pctNon = (s.nonActivity / max) * 100
          const pctMeeting = (s.meetingLoad / max) * 100
          const pctCap = (s.cap / max) * 100
          const over = s.hours + s.nonActivity > s.cap
          return (
            <div key={s.week} className="contents">
              <span className="text-xs text-gray-600 dark:text-gray-400">{s.week}</span>
              <div className="relative flex h-5 items-stretch overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                <div
                  className={over ? 'h-full bg-orange-500' : 'h-full bg-blue-500'}
                  style={{ width: `${pctHours}%` }}
                  title={`${t('leader.capacity_trend.logged')} · ${s.hours.toFixed(1)}h`}
                />
                {s.nonActivity > 0 && (
                  <div
                    className="h-full"
                    style={{ width: `${pctNon}%`, backgroundColor: NON_ACTIVITY_COLOR }}
                    title={`${t('leader.non_activities.legend')} · ${s.nonActivity.toFixed(1)}h`}
                  />
                )}
                {s.meetingLoad > 0 && (
                  <div
                    className="h-full"
                    style={{ width: `${pctMeeting}%`, backgroundColor: MEETING_LOAD_COLOR }}
                    title={`${t('leader.this_week.meeting_load_legend')} · ${s.meetingLoad.toFixed(1)}h`}
                  />
                )}
                <div
                  className="absolute top-0 h-full w-px bg-orange-500"
                  style={{ left: `${pctCap}%` }}
                  title={s.excluded > 0 ? t('leader.capacity_trend.capacity_net', { hours: s.cap.toFixed(1), excluded: s.excluded.toFixed(1) }) : t('leader.capacity_trend.capacity', { hours: s.cap })}
                />
              </div>
              <span className="text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                {s.hours.toFixed(1)}h
                {s.nonActivity > 0 && <span className="ml-1 font-normal text-gray-400 dark:text-gray-500">+{s.nonActivity.toFixed(1)}</span>}
                {s.meetingLoad > 0 && <span className="ml-1 font-normal" style={{ color: MEETING_LOAD_COLOR }}>~{s.meetingLoad.toFixed(1)}</span>}
                {s.excluded > 0 && <span className="ml-1 font-normal text-orange-500" title={t('leader.capacity_trend.capacity_net', { hours: s.cap.toFixed(1), excluded: s.excluded.toFixed(1) })}>/{s.cap.toFixed(0)}h</span>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
