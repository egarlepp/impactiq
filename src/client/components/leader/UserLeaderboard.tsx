import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownWideNarrow } from 'lucide-react'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { dashDateParams } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { SortableTh } from '../ui/table-controls.js'
import { SingleSelect } from '../ui/single-select.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useTableView } from '../../lib/tableView.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'

// v1.257.0: which metric the "Top 10" bar chart ranks by. PRD roadmap ask —
// previously hardcoded to Total ACV; the table below already sorts by any
// of these four, the chart just never followed.
type ChartMetric = 'acv' | 'closed' | 'margin' | 'efficiency'

interface Row {
  userId: string
  displayName: string
  teamName: string
  // v1.267.0: the user's deepest-matching subteam within teamName (same
  // attribution rule as Team Activity Deep-Dive), or null when they're not
  // in any subteam on that team.
  subteamName: string | null
  totalAcv: number
  closedAcv: number
  totalCost: number
  netDealMargin: number
  efficiencyRatio: number | null
  activityCount: number
  oppsTouched: number
}

interface Props {
  weeksBack: number
  stages?: string[]
  forecast?: string[]
  acv?: string[]
  // v1.245.0: previously accepted but silently ignored — see CLAUDE.md §13.
  productIds?: string[]
  memberIds?: string[]
}

export function UserLeaderboard({ weeksBack, stages = [], forecast = [], acv = [], productIds = [], memberIds }: Props) {
  const { t } = useTranslation()
  const { fmt: fmtCurrency, currency } = useDisplayCurrency()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [chartMetric, setChartMetric] = useState<ChartMetric>('acv')

  useEffect(() => {
    setLoading(true)
    setRows(null)
    const qs = new URLSearchParams({ weeks: String(weeksBack) })
    if (stages.length > 0) qs.set('stages', stages.join(','))
    if (forecast.length > 0) qs.set('forecast', forecast.join(','))
    if (acv.length > 0) qs.set('acv', acv.join(','))
    if (productIds.length > 0) qs.set('productIds', productIds.join(','))
    if (memberIds && memberIds.length > 0) qs.set('userIds', memberIds.join(','))
    if (currency !== 'USD') qs.set('displayCurrency', currency)
    for (const [k, v] of Object.entries(dashDateParams())) qs.set(k, v)
    api.get<Row[]>(`/api/dashboards/user-leaderboard?${qs.toString()}`)
      .then((res) => setRows(res.data ?? []))
      .finally(() => setLoading(false))
  }, [weeksBack, stages.join(','), forecast.join(','), acv.join(','), productIds.join(','), memberIds?.join(','), currency])

  const getters = useMemo(() => ({
    user: (r: Row) => r.displayName,
    team: (r: Row) => r.teamName,
    subteam: (r: Row) => r.subteamName ?? '',
    acv: (r: Row) => String(r.totalAcv),
    closed: (r: Row) => String(r.closedAcv),
    cost: (r: Row) => String(r.totalCost),
    margin: (r: Row) => String(r.netDealMargin),
    efficiency: (r: Row) => String(r.efficiencyRatio ?? -1),
    activities: (r: Row) => String(r.activityCount),
    opps: (r: Row) => String(r.oppsTouched),
  }), [])
  const view = useTableView<Row>(rows ?? [], getters)

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (rows === null) return <DashboardEmptyState />
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty', 'No data in this period.')}</p>

  // Nulls (efficiencyRatio has no closed-won cost basis yet) sort last
  // regardless of direction — a missing ratio isn't "worst", it's unranked.
  const metricValue: Record<ChartMetric, (r: Row) => number | null> = {
    acv: (r) => r.totalAcv,
    closed: (r) => r.closedAcv,
    margin: (r) => r.netDealMargin,
    efficiency: (r) => r.efficiencyRatio,
  }
  const metricLabels: Record<ChartMetric, string> = {
    acv: t('leader.user_leaderboard.col_acv', 'Total ACV'),
    closed: t('leader.user_leaderboard.col_closed', 'Closed ACV'),
    margin: t('leader.user_leaderboard.col_margin', 'Net Deal Margin'),
    efficiency: t('leader.user_leaderboard.col_efficiency', 'Efficiency Ratio'),
  }
  const metricOptions: Array<{ value: ChartMetric; label: string }> = [
    { value: 'acv', label: metricLabels.acv },
    { value: 'closed', label: metricLabels.closed },
    { value: 'margin', label: metricLabels.margin },
    { value: 'efficiency', label: metricLabels.efficiency },
  ]
  const getMetric = metricValue[chartMetric]
  const top10 = [...rows]
    .sort((a, b) => {
      const av = getMetric(a)
      const bv = getMetric(b)
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return bv - av
    })
    .slice(0, 10)
  const maxMetric = Math.max(...top10.map((r) => Math.abs(getMetric(r) ?? 0)), 1)
  const fmtMetric = (v: number | null) => v === null ? '—' : chartMetric === 'efficiency' ? v.toFixed(2) : fmtCurrency(v)

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('leader.user_leaderboard.description', 'Per-user totals. Efficiency Ratio = closed-won ACV ÷ total cost.')}
      </p>

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('leader.user_leaderboard.chart_title', 'Top 10 by {{metric}}', { metric: metricLabels[chartMetric] })}
          </p>
          <SingleSelect
            label={t('leader.user_leaderboard.chart_metric_label', 'Rank By')}
            labelIcon={ArrowDownWideNarrow}
            options={metricOptions}
            value={chartMetric}
            onChange={(v) => setChartMetric(v as ChartMetric)}
          />
        </div>
        <div className="space-y-1.5">
          {top10.map((r) => {
            const v = getMetric(r) ?? 0
            const pct = (Math.abs(v) / maxMetric) * 100
            return (
              <div key={r.userId} className="flex items-center gap-2 text-xs">
                <span className="w-40 truncate text-gray-700 dark:text-gray-200" title={r.displayName}>{r.displayName}</span>
                <div className="relative h-3 flex-1 rounded bg-gray-100 dark:bg-gray-800">
                  <div className={cn('absolute inset-y-0 left-0 rounded', v < 0 ? 'bg-rose-500' : 'bg-indigo-500')} style={{ width: `${pct}%` }} />
                </div>
                <span className="w-24 text-right tabular-nums text-gray-700 dark:text-gray-200">{fmtMetric(getMetric(r))}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            <tr>
              <SortableTh label={t('leader.user_leaderboard.col_user', 'User')} colKey="user" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="left" />
              <SortableTh label={t('leader.user_leaderboard.col_team', 'Team')} colKey="team" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="left" />
              <SortableTh label={t('leader.user_leaderboard.col_subteam', 'Main Subteam')} colKey="subteam" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="left" />
              <SortableTh label={t('leader.user_leaderboard.col_acv', 'Total ACV')} colKey="acv" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.user_leaderboard.col_closed', 'Closed ACV')} colKey="closed" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.user_leaderboard.col_cost', 'Cost')} colKey="cost" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.user_leaderboard.col_margin', 'Net Deal Margin')} colKey="margin" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.user_leaderboard.col_efficiency', 'Efficiency Ratio')} colKey="efficiency" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.user_leaderboard.col_activities', 'Activities')} colKey="activities" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.user_leaderboard.col_opps', 'Opps')} colKey="opps" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
            </tr>
          </thead>
          <tbody>
            {view.visible.map((r) => (
              <tr key={r.userId} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
                <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{r.displayName}</td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{r.teamName || '—'}</td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{r.subteamName || '—'}</td>
                <td className="px-3 py-2 text-center tabular-nums">{fmtCurrency(r.totalAcv)}</td>
                <td className="px-3 py-2 text-center tabular-nums">{fmtCurrency(r.closedAcv)}</td>
                <td className="px-3 py-2 text-center tabular-nums">{fmtCurrency(r.totalCost)}</td>
                <td className={`px-3 py-2 text-center tabular-nums ${r.netDealMargin < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{fmtCurrency(r.netDealMargin)}</td>
                <td className="px-3 py-2 text-center tabular-nums">{r.efficiencyRatio !== null ? r.efficiencyRatio.toFixed(2) : '—'}</td>
                <td className="px-3 py-2 text-center tabular-nums">{r.activityCount}</td>
                <td className="px-3 py-2 text-center tabular-nums">{r.oppsTouched}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
