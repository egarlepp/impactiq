import { useState, useEffect, useMemo, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import {
  History,
  ListChecks,
  Clock,
  Building2,
  Users,
  CalendarRange,
  Repeat,
  Sun,
  AlertTriangle,
} from 'lucide-react'
import { Spinner } from '../ui/spinner.js'
import { SingleSelect } from '../ui/single-select.js'
import { SortableTh, TablePagination } from '../ui/table-controls.js'
import { useTableView } from '../../lib/tableView.js'
import { HistoricalEstimateBanner } from '../ui/historical.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'

// v1.214.0: leader view of pre-ImpactIQ Salesforce activity.
//
// Reads crm_historical_events only. No cost, no utilization, no per-owner
// leaderboard — the hours here are estimates from SF scheduled meeting
// length, and ranking people on an estimate invites exactly the
// performance-review reading this app is positioned against.

interface Overview {
  totals: {
    activities: number
    estimatedHours: number
    rowsMissingDuration: number
    distinctAccounts: number
    distinctOwners: number
    earliest: string | null
    latest: string | null
    recurringCount: number
    allDayCount: number
  }
  linkage: { rowsWithUser: number; rowsWithoutUser: number; pctLinked: number }
  byYear: Array<{ year: number; activities: number; estimatedHours: number }>
  byQuarter: Array<{ period: string; year: number; quarter: number; activities: number; estimatedHours: number }>
  byType: Array<{ label: string; activities: number; estimatedHours: number }>
}

interface AccountRow {
  crmAccountId: string | null
  crmAccountName: string | null
  activities: number
  estimatedHours: number
  distinctOwners: number
  firstTouch: string | null
  lastTouch: string | null
}

interface CoverageRow {
  period: string
  distinctAccounts: number
  activities: number
  estimatedHours: number
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/25">
      <Icon className="pointer-events-none absolute -right-2 -top-2 h-16 w-16 text-amber-200/50 dark:text-amber-900/30" />
      <div className="relative">
        <div className="mb-1 inline-flex rounded-md bg-amber-100 p-1.5 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <p className="text-[11px] uppercase tracking-wide text-amber-800/80 dark:text-amber-300/80">{label}</p>
        <p className="text-xl font-semibold text-amber-900 dark:text-amber-100">{value}</p>
        {sub && <p className="text-[11px] text-amber-700/70 dark:text-amber-400/70">{sub}</p>}
      </div>
    </div>
  )
}

/** Simple CSS bar chart — matches how ActivityMix / CapacityTrend render. */
function BarRow({ label, value, max, caption }: { label: string; value: number; max: number; caption: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <div className="h-4 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
        <div className="h-full rounded bg-amber-400 dark:bg-amber-600" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-20 shrink-0 text-right tabular-nums text-gray-600 dark:text-gray-300">{caption}</span>
    </div>
  )
}

export function HistoryDashboard({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [coverage, setCoverage] = useState<CoverageRow[]>([])
  const [loading, setLoading] = useState(true)
  // Counts are the primary axis because they're real; hours are a secondary
  // toggle because they're estimated.
  const [metric, setMetric] = useState<'counts' | 'hours'>('counts')
  const [bucket, setBucket] = useState<'month' | 'quarter'>('month')
  const [recurring, setRecurring] = useState('all')
  const [allDay, setAllDay] = useState('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const q = `teamId=${encodeURIComponent(teamId || 'all')}&recurring=${recurring}&allDay=${allDay}`
    void Promise.all([
      api.get<Overview>(`/api/dashboards/history-overview?${q}`),
      api.get<AccountRow[]>(`/api/dashboards/history-accounts?${q}&limit=200`),
      api.get<CoverageRow[]>(`/api/dashboards/history-coverage?${q}&bucket=${bucket}`),
    ])
      .then(([o, a, c]) => {
        if (cancelled) return
        setOverview(o.data ?? null)
        setAccounts(a.data ?? [])
        setCoverage(c.data ?? [])
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [teamId, bucket, recurring, allDay])

  const view = useTableView<AccountRow>(
    accounts,
    {
      account: (r) => r.crmAccountName ?? r.crmAccountId ?? '',
      activities: (r) => String(r.activities).padStart(8, '0'),
      hours: (r) => String(Math.round(r.estimatedHours)).padStart(8, '0'),
      owners: (r) => String(r.distinctOwners).padStart(4, '0'),
      first: (r) => r.firstTouch ?? '',
      last: (r) => r.lastTouch ?? '',
    },
    { pageSize: 20 },
  )

  const yearMax = useMemo(
    () =>
      Math.max(
        1,
        ...(overview?.byYear ?? []).map((y) => (metric === 'counts' ? y.activities : y.estimatedHours)),
      ),
    [overview, metric],
  )
  const coverageMax = useMemo(
    () => Math.max(1, ...coverage.map((c) => c.distinctAccounts)),
    [coverage],
  )

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    )
  }

  if (!overview || overview.totals.activities === 0) {
    return (
      <div className="space-y-4">
        <HistoricalEstimateBanner variant="full" />
        <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('leader.history.empty', { context: crmCtx })}
        </p>
      </div>
    )
  }

  const { totals, linkage } = overview
  const rangeLabel =
    totals.earliest && totals.latest ? `${totals.earliest.slice(0, 7)} → ${totals.latest.slice(0, 7)}` : '—'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          <History className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          {t('leader.history.title')}
        </h2>
        {/* Pre-empts "why doesn't this match the sum of people's pages". */}
        <span
          className="inline-flex items-center gap-1 rounded-full border border-amber-300 px-2 py-0.5 text-[11px] text-amber-800 dark:border-amber-800 dark:text-amber-300"
          title={t('history.linkage_warning', { pct: linkage.pctLinked })}
        >
          <AlertTriangle className="h-3 w-3" />
          {t('history.linkage_warning', { pct: linkage.pctLinked })}
        </span>
      </div>

      <HistoricalEstimateBanner variant="full" />

      {/* Counts in the option labels come from an UNFILTERED aggregate, so the
          size of the lever is visible before anyone pulls it. */}
      <div className="flex flex-wrap items-center gap-2">
        <SingleSelect
          label={t('history.filter_recurring')}
          labelIcon={Repeat}
          options={[
            { value: 'all', label: t('history.filter_recurring_all'), hint: String(totals.recurringCount) },
            { value: 'only', label: t('history.filter_recurring_only') },
            { value: 'exclude', label: t('history.filter_recurring_exclude') },
          ]}
          value={recurring}
          onChange={setRecurring}
        />
        <SingleSelect
          label={t('history.filter_all_day')}
          labelIcon={Sun}
          options={[
            { value: 'all', label: t('history.filter_all_day_all'), hint: String(totals.allDayCount) },
            { value: 'only', label: t('history.filter_all_day_only') },
            { value: 'exclude', label: t('history.filter_all_day_exclude') },
          ]}
          value={allDay}
          onChange={setAllDay}
        />
        {(recurring !== 'all' || allDay !== 'all') && (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">
            {t('history.filtered_note')}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile icon={ListChecks} label={t('leader.history.kpi_activities')} value={String(totals.activities)} />
        <StatTile
          icon={Clock}
          label={t('leader.history.kpi_est_hours')}
          value={`~${Math.round(totals.estimatedHours)}h`}
          sub={t('history.est_from_sf', { context: crmCtx })}
        />
        <StatTile icon={Building2} label={t('leader.history.kpi_accounts')} value={String(totals.distinctAccounts)} />
        <StatTile icon={Users} label={t('leader.history.kpi_owners', { context: crmCtx })} value={String(totals.distinctOwners)} />
        <StatTile icon={CalendarRange} label={t('leader.history.kpi_range')} value={rangeLabel} />
      </div>

      {/* YoY volume */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('leader.history.yoy_title')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.history.yoy_hint')}</p>
          </div>
          <SingleSelect
            label={t('leader.history.metric')}
            options={[
              { value: 'counts', label: t('leader.history.toggle_counts') },
              { value: 'hours', label: t('leader.history.toggle_hours') },
            ]}
            value={metric}
            onChange={(v) => setMetric(v as 'counts' | 'hours')}
          />
        </div>
        <div className="space-y-1.5">
          {overview.byYear.map((y) => {
            const v = metric === 'counts' ? y.activities : y.estimatedHours
            return (
              <BarRow
                key={y.year}
                label={String(y.year)}
                value={v}
                max={yearMax}
                caption={metric === 'counts' ? String(y.activities) : `~${Math.round(y.estimatedHours)}h`}
              />
            )
          })}
        </div>
      </div>

      {/* Coverage over time */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('leader.history.coverage_title')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.history.coverage_hint')}</p>
          </div>
          <SingleSelect
            label={t('leader.history.bucket')}
            options={[
              { value: 'month', label: t('leader.history.bucket_month') },
              { value: 'quarter', label: t('leader.history.bucket_quarter') },
            ]}
            value={bucket}
            onChange={(v) => setBucket(v as 'month' | 'quarter')}
          />
        </div>
        <div className="space-y-1">
          {coverage.map((c) => (
            <BarRow
              key={c.period}
              label={c.period}
              value={c.distinctAccounts}
              max={coverageMax}
              caption={String(c.distinctAccounts)}
            />
          ))}
        </div>
      </div>

      {/* Top accounts — the workhorse. A 2023 last-touch on a top-10 account
          is the actionable signal here. */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('leader.history.accounts_title')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.history.accounts_hint')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              <tr>
                <SortableTh label={t('history.col.account', { context: crmCtx })} colKey="account" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters['account'] ?? ''} onFilter={(v) => view.setFilter('account', v)} />
                <SortableTh label={t('history.col.activities')} colKey="activities" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="right" />
                <SortableTh label={t('history.col.est_hours')} colKey="hours" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="right" />
                <SortableTh label={t('history.col.distinct_owners')} colKey="owners" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="right" />
                <SortableTh label={t('history.col.first_touch')} colKey="first" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
                <SortableTh label={t('history.col.last_touch')} colKey="last" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
              </tr>
            </thead>
            <tbody>
              {view.visible.map((r) => (
                <tr key={r.crmAccountId ?? '—'} className={cn('border-b border-gray-100 last:border-0 dark:border-gray-800')}>
                  <td className="px-3 py-2 text-gray-800 dark:text-gray-100">{r.crmAccountName ?? r.crmAccountId ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-200">{r.activities}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">~{Math.round(r.estimatedHours)}h</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">{r.distinctOwners}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500 dark:text-gray-400">{r.firstTouch ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500 dark:text-gray-400">{r.lastTouch ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
      </div>
    </div>
  )
}
