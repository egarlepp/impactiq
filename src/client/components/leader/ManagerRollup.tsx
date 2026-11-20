import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Clock, DollarSign, TrendingUp, Activity, Building2, Award } from 'lucide-react'
import { api } from '../../lib/api.js'
import { dashDateParams } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { cn } from '../../lib/utils.js'
import { useTableView } from '../../lib/tableView.js'
import { SortableTh, TablePagination } from '../ui/table-controls.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'
import { useCrmFeatures } from '../../store/crmFeatures.js'

interface RollupRow {
  teamId: string
  teamName: string
  hours: number
  costDollars: number
  acv: number
  activityCount: number
  uniqueContributors: number
  uniqueOpps: number
  uniqueAccounts: number
  uniqueCampaigns: number
  uniqueLeads: number
}

interface Props {
  weeksBack: number
  acv?: string[]
  // v1.245.0: previously accepted but silently ignored — see CLAUDE.md §13.
  productIds?: string[]
  stages?: string[]
  forecast?: string[]
  userId?: string
  memberIds?: string[]
}

interface SubteamRow {
  subteamId: string | null
  subteamName: string
  parentSubteamId: string | null
  depth: number
  hours: number
  costDollars: number
  activityCount: number
  acv: number
  uniqueContributors: number
  uniqueOpps: number
  uniqueAccounts: number
  uniqueLeads: number
  uniqueCampaigns: number
}

interface RollupDiagnostics {
  scopeSize: number
  teamRowsCount: number
  rawRowCount: number
  rangeStart: string
  rangeEnd: string
  callerIsAppAdmin?: boolean
  totalTeams?: number
  activeTeams?: number
  requestedTeamIds?: string[]
  accessibleTeamIds?: string[]
  activitiesInScopeAllTime?: number
  activitiesInScopeSubmitted?: number
}

export function ManagerRollup({ weeksBack, acv = [], productIds = [], stages = [], forecast = [], userId, memberIds }: Props) {
  const { fmt: fmtCurrency, currency } = useDisplayCurrency()
  const [rows, setRows] = useState<RollupRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [reason, setReason] = useState<'no_data' | 'no_accessible_teams' | null>(null)
  const [subteamsByTeam, setSubteamsByTeam] = useState<Record<string, SubteamRow[]>>({})
  const [debug, setDebug] = useState<{ raw: unknown; error: string | null } | null>(null)
  const [mostExpensiveAccount, setMostExpensiveAccount] = useState<{ id: string; name: string | null; cost: number } | null>(null)
  const [topUser, setTopUser] = useState<{ id: string; displayName: string; acv: number } | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setRows(null); setReason(null); setDebug(null); setMostExpensiveAccount(null); setTopUser(null)
      const mrqs = new URLSearchParams({ weeks: String(weeksBack) })
      if (acv.length > 0) mrqs.set('acv', acv.join(','))
      if (productIds.length > 0) mrqs.set('productIds', productIds.join(','))
      if (stages.length > 0) mrqs.set('stages', stages.join(','))
      if (forecast.length > 0) mrqs.set('forecast', forecast.join(','))
      if (userId) mrqs.set('userId', userId)
      if (memberIds && memberIds.length > 0) mrqs.set('userIds', memberIds.join(','))
      if (currency !== 'USD') mrqs.set('displayCurrency', currency)
      for (const [k, v] of Object.entries(dashDateParams())) mrqs.set(k, v)
      const res = await api.get<RollupRow[]>(`/api/dashboards/manager-rollup?${mrqs.toString()}`)
      const meta = (res.meta ?? {}) as { reason?: string; subteamsByTeam?: Record<string, SubteamRow[]>; diagnostics?: unknown; mostExpensiveAccount?: { id: string; name: string | null; cost: number } | null; topUser?: { id: string; displayName: string; acv: number } | null }
      setSubteamsByTeam(meta.subteamsByTeam ?? {})
      setMostExpensiveAccount(meta.mostExpensiveAccount ?? null)
      setTopUser(meta.topUser ?? null)
      setDebug({ raw: meta, error: res.error })
      const data = res.data ?? []
      setRows(data)
      if (data.length === 0) setReason(meta.reason === 'no_accessible_teams' ? 'no_accessible_teams' : 'no_data')
      setLoading(false)
    })()
  }, [weeksBack, acv.join(','), productIds.join(','), stages.join(','), forecast.join(','), userId, memberIds?.join(','), currency])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!rows) return <DashboardEmptyState />
  if (rows.length === 0) return (
    <div className="flex flex-col items-center gap-2">
      <DashboardEmptyState reason={reason ?? 'no_data'} />
      <details className="mx-auto max-w-2xl text-[10px] text-gray-500 dark:text-gray-400" open>
        <summary className="cursor-pointer font-semibold text-amber-700 dark:text-amber-400">
          Diagnostics (share this JSON so we can investigate)
        </summary>
        <pre className="mt-1 whitespace-pre-wrap rounded border-2 border-amber-300 bg-amber-50 p-3 text-left dark:border-amber-800 dark:bg-amber-950/40">
{JSON.stringify(debug ?? { note: 'no meta captured yet' }, null, 2)}
        </pre>
      </details>
    </div>
  )

  const totals = rows.reduce(
    (acc, r) => ({ hours: acc.hours + r.hours, cost: acc.cost + r.costDollars, acv: acc.acv + r.acv, count: acc.count + r.activityCount }),
    { hours: 0, cost: 0, acv: 0, count: 0 },
  )
  const maxHours = Math.max(...rows.map((r) => r.hours), 1)

  return <ManagerRollupTable rows={rows} subteamsByTeam={subteamsByTeam} totals={totals} maxHours={maxHours} mostExpensiveAccount={mostExpensiveAccount} topUser={topUser} />
}

function ManagerRollupTable({ rows, subteamsByTeam, totals, maxHours, mostExpensiveAccount, topUser }: { rows: RollupRow[]; subteamsByTeam: Record<string, SubteamRow[]>; totals: { hours: number; cost: number; acv: number; count: number }; maxHours: number; mostExpensiveAccount: { id: string; name: string | null; cost: number } | null; topUser: { id: string; displayName: string; acv: number } | null }) {
  const { t } = useTranslation()
  const { fmt: fmtCurrency } = useDisplayCurrency()
  const { campaignsEnabled, leadsEnabled } = useCrmFeatures()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  function toggle(id: string) {
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const getters = useMemo(() => ({
    team: (r: RollupRow) => r.teamName,
    hours: (r: RollupRow) => String(r.hours),
    cost: (r: RollupRow) => String(r.costDollars),
    acv: (r: RollupRow) => String(r.acv),
    activities: (r: RollupRow) => String(r.activityCount),
    contributors: (r: RollupRow) => String(r.uniqueContributors),
    accounts: (r: RollupRow) => String(r.uniqueAccounts),
    leads: (r: RollupRow) => String(r.uniqueLeads),
    campaigns: (r: RollupRow) => String(r.uniqueCampaigns),
    opps: (r: RollupRow) => String(r.uniqueOpps),
  }), [])
  const view = useTableView<RollupRow>(rows, getters)

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">{t('leader.manager_rollup.description')}</p>
      {/* v1.133.0: colorful KPI cards — big value, small label,
          decorative background icon in the top-right, tinted panel per
          metric. Replaces the plain gray stat tiles. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <ColorStatCard
          label={t('leader.manager_rollup.total_hours', 'Total hours')}
          value={totals.hours.toFixed(1)}
          Icon={Clock}
          color="indigo"
        />
        <ColorStatCard
          label={t('leader.manager_rollup.total_cost', 'Total cost')}
          value={fmtCurrency(totals.cost)}
          Icon={DollarSign}
          color="rose"
        />
        <ColorStatCard
          label={t('leader.manager_rollup.total_acv', 'Total ACV')}
          value={fmtCurrency(totals.acv)}
          Icon={TrendingUp}
          color="emerald"
        />
        <ColorStatCard
          label={t('leader.manager_rollup.total_activities', 'Activities')}
          value={String(totals.count)}
          Icon={Activity}
          color="sky"
        />
        <ColorStatCard
          label={t('leader.manager_rollup.most_expensive_account', 'Most expensive Account')}
          value={mostExpensiveAccount ? fmtCurrency(mostExpensiveAccount.cost) : '—'}
          sub={mostExpensiveAccount?.name ?? ''}
          Icon={Building2}
          color="amber"
        />
        <ColorStatCard
          label={t('leader.manager_rollup.biggest_impact', 'Biggest impact')}
          value={topUser ? fmtCurrency(topUser.acv) : '—'}
          sub={topUser?.displayName ?? ''}
          Icon={Award}
          color="violet"
        />
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <SortableTh label={t('leader.manager_rollup.col_team')} colKey="team" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters['team']} onFilter={(v) => view.setFilter('team', v)} filterPlaceholder={t('common.search_placeholder')} align="left" />
              <SortableTh label={t('leader.manager_rollup.col_hours')} colKey="hours" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.manager_rollup.col_cost')} colKey="cost" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.manager_rollup.col_acv')} colKey="acv" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.manager_rollup.col_activities')} colKey="activities" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.manager_rollup.col_contributors')} colKey="contributors" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              <SortableTh label={t('leader.manager_rollup.col_accounts', 'Accounts')} colKey="accounts" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
              {leadsEnabled && <SortableTh label={t('leader.manager_rollup.col_leads', 'Leads')} colKey="leads" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />}
              {campaignsEnabled && <SortableTh label={t('leader.manager_rollup.col_campaigns', 'Campaigns')} colKey="campaigns" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />}
              <SortableTh label={t('leader.manager_rollup.col_opps')} colKey="opps" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} align="center" />
            </tr>
          </thead>
          <tbody>
            {view.visible.map((r) => {
              const barPct = (r.hours / maxHours) * 100
              const subs = subteamsByTeam[r.teamId] ?? []
              const hasSubs = subs.length > 0
              const isOpen = expanded.has(r.teamId)
              return (
                <>
                <tr key={r.teamId} className={cn('border-b border-gray-100 dark:border-gray-900', r.activityCount === 0 && 'bg-amber-50/50 dark:bg-amber-950/20', !hasSubs && 'last:border-b-0')}>
                  <td className="px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {hasSubs ? (
                        <button
                          type="button"
                          onClick={() => toggle(r.teamId)}
                          className="rounded p-0.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                          aria-label={isOpen ? t('leader.collapse', 'Collapse') : t('leader.expand', 'Expand')}
                          title={isOpen ? t('leader.collapse', 'Collapse') : t('leader.expand', 'Expand')}
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : <span className="inline-block w-4" />}
                      {r.teamName}
                      {hasSubs && (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                          {subs.length} {t('leader.manager_rollup.subteams', 'subteams')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">
                    <div className="flex items-center justify-center gap-2">
                      <div className="relative h-1.5 w-20 rounded bg-gray-100 dark:bg-gray-800">
                        <div className="absolute inset-y-0 left-0 rounded bg-indigo-500" style={{ width: `${barPct}%` }} />
                      </div>
                      {r.hours.toFixed(1)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{fmtCurrency(r.costDollars)}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{fmtCurrency(r.acv)}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.activityCount}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.uniqueContributors}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.uniqueAccounts}</td>
                  {leadsEnabled && <td className="px-3 py-2 text-center tabular-nums">{r.uniqueLeads}</td>}
                  {campaignsEnabled && <td className="px-3 py-2 text-center tabular-nums">{r.uniqueCampaigns}</td>}
                  <td className="px-3 py-2 text-center tabular-nums">{r.uniqueOpps}</td>
                </tr>
                {isOpen && (() => {
                  // Render the subteam tree. A node shows only when the team is
                  // open and every ancestor node is expanded; indentation +
                  // its own chevron follow `depth` and children presence.
                  const visibleByKey = new Map<string, boolean>()
                  return subs.map((s) => {
                    const key = `${r.teamId}::${s.subteamId ?? 'unassigned'}`
                    const parentKey = s.parentSubteamId ? `${r.teamId}::${s.parentSubteamId}` : null
                    const visible = !parentKey ? true : (visibleByKey.get(parentKey) ?? false) && expanded.has(parentKey)
                    visibleByKey.set(key, visible)
                    if (!visible) return null
                    const hasKids = s.subteamId !== null && subs.some((c) => c.parentSubteamId === s.subteamId)
                    const nodeOpen = expanded.has(key)
                    return (
                      <tr key={key} className="border-b border-gray-100 bg-gray-50/60 dark:border-gray-900 dark:bg-gray-900/40">
                        <td className="py-1.5 pr-3 text-xs text-gray-600 dark:text-gray-400" style={{ paddingLeft: 16 + s.depth * 20 }}>
                          <span className="inline-flex items-center gap-1.5">
                            {hasKids ? (
                              <button
                                type="button"
                                onClick={() => toggle(key)}
                                className="rounded p-0.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                                aria-label={nodeOpen ? t('leader.collapse', 'Collapse') : t('leader.expand', 'Expand')}
                                title={nodeOpen ? t('leader.collapse', 'Collapse') : t('leader.expand', 'Expand')}
                              >
                                {nodeOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              </button>
                            ) : <span className="inline-block w-4" />}
                            {s.subteamName}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{s.hours.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{fmtCurrency(s.costDollars)}</td>
                        <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{fmtCurrency(s.acv)}</td>
                        <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{s.activityCount}</td>
                        <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{s.uniqueContributors}</td>
                        <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{s.uniqueAccounts}</td>
                        {leadsEnabled && <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{s.uniqueLeads}</td>}
                        {campaignsEnabled && <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{s.uniqueCampaigns}</td>}
                        <td className="px-3 py-1.5 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{s.uniqueOpps}</td>
                      </tr>
                    )
                  })
                })()}
                </>
              )
            })}
          </tbody>
        </table>
        <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.manager_rollup.footnote')}</p>
    </div>
  )
}

// v1.133.0: colorful KPI card with background icon, tinted panel, and
// bold value. Colors map to a Tailwind palette + a subtle background
// icon in the top-right corner (like the attached mockup). `sub` is
// an optional second line (used for Most-expensive-account name and
// Biggest-impact user name).
type StatColor = 'indigo' | 'rose' | 'emerald' | 'sky' | 'amber' | 'violet'

const COLOR_MAP: Record<StatColor, { bg: string; text: string; iconBg: string; iconFg: string; watermark: string }> = {
  indigo:  { bg: 'bg-indigo-50 dark:bg-indigo-950/40',   text: 'text-indigo-900 dark:text-indigo-100',   iconBg: 'bg-indigo-100 dark:bg-indigo-900/60',   iconFg: 'text-indigo-600 dark:text-indigo-300',   watermark: 'text-indigo-200 dark:text-indigo-800/50'   },
  rose:    { bg: 'bg-rose-50 dark:bg-rose-950/40',       text: 'text-rose-900 dark:text-rose-100',       iconBg: 'bg-rose-100 dark:bg-rose-900/60',       iconFg: 'text-rose-600 dark:text-rose-300',       watermark: 'text-rose-200 dark:text-rose-800/50'       },
  emerald: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-900 dark:text-emerald-100', iconBg: 'bg-emerald-100 dark:bg-emerald-900/60', iconFg: 'text-emerald-600 dark:text-emerald-300', watermark: 'text-emerald-200 dark:text-emerald-800/50' },
  sky:     { bg: 'bg-sky-50 dark:bg-sky-950/40',         text: 'text-sky-900 dark:text-sky-100',         iconBg: 'bg-sky-100 dark:bg-sky-900/60',         iconFg: 'text-sky-600 dark:text-sky-300',         watermark: 'text-sky-200 dark:text-sky-800/50'         },
  amber:   { bg: 'bg-amber-50 dark:bg-amber-950/40',     text: 'text-amber-900 dark:text-amber-100',     iconBg: 'bg-amber-100 dark:bg-amber-900/60',     iconFg: 'text-amber-600 dark:text-amber-300',     watermark: 'text-amber-200 dark:text-amber-800/50'     },
  violet:  { bg: 'bg-violet-50 dark:bg-violet-950/40',   text: 'text-violet-900 dark:text-violet-100',   iconBg: 'bg-violet-100 dark:bg-violet-900/60',   iconFg: 'text-violet-600 dark:text-violet-300',   watermark: 'text-violet-200 dark:text-violet-800/50'   },
}

function ColorStatCard({
  label,
  value,
  sub,
  Icon,
  color,
}: {
  label: string
  value: string
  sub?: string
  Icon: React.ComponentType<{ className?: string }>
  color: StatColor
}) {
  const c = COLOR_MAP[color]
  return (
    <div className={cn('relative flex items-start gap-3 overflow-hidden rounded-xl border border-transparent p-4', c.bg)}>
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', c.iconBg)}>
        <Icon className={cn('h-5 w-5', c.iconFg)} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn('text-xs font-semibold uppercase tracking-wide', c.text)}>{label}</p>
        <p className={cn('mt-1 text-xl font-bold leading-tight', c.text)}>{value}</p>
        {sub && (
          <p className="mt-0.5 truncate text-xs text-gray-600 dark:text-gray-300" title={sub}>{sub}</p>
        )}
      </div>
      {/* Decorative watermark icon in the top-right. */}
      <Icon className={cn('pointer-events-none absolute -right-2 -top-2 h-16 w-16 opacity-30', c.watermark)} />
    </div>
  )
}
