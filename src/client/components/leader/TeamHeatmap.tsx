import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import { cn } from '../../lib/utils.js'
import { format } from 'date-fns'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { detectAnomalies } from '../../lib/anomalies.js'
import { AnomalyBadge } from './AnomalyBadge.js'
import { AllTimeNotApplicable } from './AllTimeNotApplicable.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { MeetingLoadInfo } from './MeetingLoadInfo.js'
import { useNavigate } from 'react-router-dom'

interface HeatmapRow {
  userId: string
  displayName: string
  weekStart: string
  totalHours: number
}

interface HeatmapData {
  rows: HeatmapRow[]
  weeks: string[]
  capacityByUser: Record<string, number>
  excludedByUserWeek?: Record<string, Record<string, number>>
  // PTO-only slice of excludedByUserWeek — lets us tell a PTO week apart from
  // a company-holiday week (both reduce capacity, but only PTO is "PTO").
  ptoByUserWeek?: Record<string, Record<string, number>>
  nonActivityByUserWeek?: Record<string, Record<string, number>>
  // v1.226.0: corrected "real meeting load" figure — see CLAUDE.md §12.1.
  // Admin opt-in per capacity group; meetingLoadEnabled tells the always-
  // visible explainer whether this team currently has it on.
  meetingLoadByUserWeek?: Record<string, Record<string, number>>
  meetingLoadEnabled?: boolean
}

// Dark grey for uncaptured meeting time — the None/Non-Activity anchor color.
const NON_ACTIVITY_COLOR = '#6B7280'
// Teal for real meeting load — distinct from the gray/amber/indigo already
// in use for non-activity/PTO/holiday.
const MEETING_LOAD_COLOR = '#0D9488'

function heatColor(hours: number, target: number): string {
  if (hours === 0) return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
  const ratio = hours / target
  if (ratio < 0.5) return 'bg-blue-100 dark:bg-blue-950 text-blue-900 dark:text-blue-100'
  if (ratio < 0.8) return 'bg-blue-200 dark:bg-blue-900 text-blue-900 dark:text-blue-100'
  if (ratio < 1.0) return 'bg-blue-400 dark:bg-blue-700 text-white'
  if (ratio < 1.2) return 'bg-green-400 dark:bg-green-700 text-white'
  return 'bg-orange-400 dark:bg-orange-600 text-white'
}

interface TeamHeatmapProps {
  teamId: string
  weeksBack?: number
  productIds?: string[]
  userId?: string | null
  // v1.265.0: union of every individually-picked person + every member of
  // every checked subteam (Dashboard.tsx's SubteamFilter mode="multi").
  memberIds?: string[]
  compareMode?: CompareMode
  includeNonActivities?: boolean
}

export function TeamHeatmap({ teamId, weeksBack = 8, productIds = [], userId, memberIds, compareMode = 'off', includeNonActivities = true }: TeamHeatmapProps) {
  const { t } = useTranslation()
  const [data, setData] = useState<HeatmapData | null>(null)
  const [priorTotal, setPriorTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [drillUser, setDrillUser] = useState<string | null>(null)
  const navigate = useNavigate()

  // All-time (weeksBack=0) short-circuits before the fetch — the heatmap
  // is one-column-per-week and can't render a bounded grid without a
  // window.
  const allTime = weeksBack === 0

  useEffect(() => {
    if (allTime) return
    setLoading(true)
    api.get<HeatmapData>(buildDashboardUrl('heatmap', { teamId, weeksBack, productIds, userId, memberIds, extra: { nonActivities: includeNonActivities ? '1' : '0' } }))
      .then((res) => { if (res.data) setData(res.data) })
      .finally(() => setLoading(false))
  }, [allTime, teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), includeNonActivities])

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotal(null); return }
    api.get<HeatmapData>(buildDashboardUrl('heatmap', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode) }))
      .then((res) => setPriorTotal((res.data?.rows ?? []).reduce((s, r) => s + Number(r.totalHours), 0)))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode])

  if (allTime) return <AllTimeNotApplicable />
  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />

  // Build contributor → week → hours map
  const contributors = [...new Set(data.rows.map((r) => r.userId))]
  // No team members (or no activity for any of them) → show the shared empty
  // state instead of a header-only table with a lone "no data" cell.
  if (contributors.length === 0) return <DashboardEmptyState />
  const nameMap = Object.fromEntries(data.rows.map((r) => [r.userId, r.displayName]))
  const lookup: Record<string, Record<string, number>> = {}
  for (const row of data.rows) {
    if (!lookup[row.userId]) lookup[row.userId] = {}
    lookup[row.userId]![row.weekStart.slice(0, 10)] = Number(row.totalHours)
  }

  const currentTotal = data.rows.reduce((s, r) => s + Number(r.totalHours), 0)
  const anyMeetingLoad = contributors.some((uid) =>
    data.weeks.some((w) => (data.meetingLoadByUserWeek?.[uid]?.[w] ?? 0) > 0))

  return (
    <div className="overflow-x-auto">
      {compareMode !== 'off' && priorTotal !== null && (
        <div className="mb-2 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <span>Total: {currentTotal.toFixed(1)}h</span>
          <TrendChip current={currentTotal} prior={priorTotal} mode={compareMode} />
        </div>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400">
              {t('leader.heatmap.contributor')}
            </th>
            {data.weeks.map((w) => (
              <th key={w} className="px-1 py-2 text-center font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                {format(new Date(w), 'MMM d')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contributors.map((uid) => {
            const baseTarget = data.capacityByUser[uid] ?? 30
            // Compute anomalies from this user's weekly rollup.
            const weekly = data.weeks.map((w) => ({
              weekStart: w,
              hours: lookup[uid]?.[w] ?? 0,
              capacity: Math.max(0, baseTarget - (data.excludedByUserWeek?.[uid]?.[w] ?? 0)),
            }))
            const anomalies = detectAnomalies(weekly, {
              labels: {
                under: t('leader.anomaly.under'),
                silent: t('leader.anomaly.silent'),
                over: t('leader.anomaly.over'),
                imbalance: (typeName) => t('leader.anomaly.imbalance', { type: typeName }),
              },
            })
            const firstWeek = data.weeks[0]
            const lastWeek = data.weeks[data.weeks.length - 1]
            return (
              <tr key={uid} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <td
                  className="cursor-pointer py-1 pr-4 font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap"
                  onClick={() => setDrillUser(drillUser === uid ? null : uid)}
                >
                  <span className="inline-flex items-center gap-2">
                    {nameMap[uid]}
                    <AnomalyBadge anomalies={anomalies} userId={uid} startDate={firstWeek} endDate={lastWeek} />
                  </span>
                </td>
                {data.weeks.map((w) => {
                  const hrs = lookup[uid]?.[w] ?? 0
                  const nonActivity = data.nonActivityByUserWeek?.[uid]?.[w] ?? 0
                  const excluded = data.excludedByUserWeek?.[uid]?.[w] ?? 0
                  const ptoHrs = data.ptoByUserWeek?.[uid]?.[w] ?? 0
                  const meetingLoad = data.meetingLoadByUserWeek?.[uid]?.[w] ?? 0
                  // A reduced-capacity week is PTO only if this user actually
                  // has PTO that week; otherwise it's a company holiday.
                  const isHoliday = excluded > 0 && ptoHrs <= 0
                  const target = Math.max(0, baseTarget - excluded)
                  const titleParts = [
                    excluded > 0 ? t(isHoliday ? 'leader.heatmap.holiday_tip' : 'leader.heatmap.pto_tip', { hours: excluded }) : null,
                    nonActivity > 0 ? `${t('leader.non_activities.legend')}: ${nonActivity.toFixed(1)}h` : null,
                    meetingLoad > 0 ? `${t('leader.this_week.meeting_load_legend')}: ${meetingLoad.toFixed(1)}h` : null,
                  ].filter(Boolean)
                  const title = titleParts.length > 0 ? titleParts.join(' · ') : undefined
                  // Drill: clicking a cell filters activities to this user + this week.
                  const onCellClick = () => {
                    const start = w
                    const end = new Date(new Date(w).getTime() + 6 * 86400000).toISOString().slice(0, 10)
                    navigate(`/activities?userId=${uid}&startDate=${start}&endDate=${end}`)
                  }
                  return (
                    <td key={w} className="px-1 py-1 text-center" title={title}>
                      <div
                        onClick={onCellClick}
                        className={cn('cursor-pointer rounded px-1.5 py-0.5 font-mono hover:ring-1 hover:ring-blue-400', heatColor(hrs, Math.max(1, target)), excluded > 0 && 'ring-1 ring-amber-400')}
                      >
                        {hrs > 0 ? hrs.toFixed(1) : (excluded > 0 ? (isHoliday ? t('leader.heatmap.holiday_short', 'Hol') : t('leader.heatmap.pto_short', 'PTO')) : '—')}
                        {nonActivity > 0 && (
                          <span className="ml-0.5 font-semibold" style={{ color: NON_ACTIVITY_COLOR }}>
                            +{nonActivity.toFixed(1)}
                          </span>
                        )}
                        {meetingLoad > 0 && (
                          <span className="ml-0.5 font-semibold" style={{ color: MEETING_LOAD_COLOR }}>
                            ~{meetingLoad.toFixed(1)}
                          </span>
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* Legend */}
      <div className="mt-3 flex items-center gap-4 text-[10px] text-gray-500 dark:text-gray-400">
        <span>{t('leader.heatmap.hours')}:</span>
        {[
          { label: '< 50%', cls: 'bg-blue-100 dark:bg-blue-950' },
          { label: '50–80%', cls: 'bg-blue-200 dark:bg-blue-900' },
          { label: '80–100%', cls: 'bg-blue-400 dark:bg-blue-700' },
          { label: '100–120%', cls: 'bg-green-400 dark:bg-green-700' },
          { label: '> 120%', cls: 'bg-orange-400 dark:bg-orange-600' },
        ].map((l) => (
          <div key={l.label} className="flex items-center gap-1">
            <div className={cn('h-3 w-3 rounded', l.cls)} />
            <span>{l.label}</span>
          </div>
        ))}
        {includeNonActivities && (
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 rounded" style={{ backgroundColor: NON_ACTIVITY_COLOR }} />
            <span>{t('leader.non_activities.legend')} (+h)</span>
          </div>
        )}
        {anyMeetingLoad && (
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 rounded" style={{ backgroundColor: MEETING_LOAD_COLOR }} />
            <span>{t('leader.this_week.meeting_load_legend')} (~h)</span>
          </div>
        )}
        {/* Always rendered, unlike the swatch above — a leader whose team
            hasn't opted in still needs a way to discover why. */}
        <MeetingLoadInfo enabled={data.meetingLoadEnabled} />
      </div>
    </div>
  )
}
