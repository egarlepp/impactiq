import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Target, Building2, Users, FolderKanban, Clock, DollarSign, TrendingUp, Activity, UserRound, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { api } from '../../lib/api.js'
import { dashDateParams } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { cn } from '../../lib/utils.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'

type Scope = 'project' | 'opp' | 'account' | 'team'

interface Row {
  id: string
  name: string | null
  parentId: string | null
  depth: number
  activityCount: number
  hours: number
  costDollars: number
  acv: number
  uniqueContributors: number
}

interface Kpis { projects: number; hours: number; cost: number; acv: number; activities: number; contributors: number }


type StatColor = 'indigo' | 'rose' | 'emerald' | 'sky' | 'amber' | 'violet'
const COLOR_MAP: Record<StatColor, { bg: string; text: string; iconBg: string; iconFg: string; watermark: string }> = {
  indigo:  { bg: 'bg-indigo-50 dark:bg-indigo-950/40',   text: 'text-indigo-900 dark:text-indigo-100',   iconBg: 'bg-indigo-100 dark:bg-indigo-900/60',   iconFg: 'text-indigo-600 dark:text-indigo-300',   watermark: 'text-indigo-200 dark:text-indigo-800/50'   },
  rose:    { bg: 'bg-rose-50 dark:bg-rose-950/40',       text: 'text-rose-900 dark:text-rose-100',       iconBg: 'bg-rose-100 dark:bg-rose-900/60',       iconFg: 'text-rose-600 dark:text-rose-300',       watermark: 'text-rose-200 dark:text-rose-800/50'       },
  emerald: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-900 dark:text-emerald-100', iconBg: 'bg-emerald-100 dark:bg-emerald-900/60', iconFg: 'text-emerald-600 dark:text-emerald-300', watermark: 'text-emerald-200 dark:text-emerald-800/50' },
  sky:     { bg: 'bg-sky-50 dark:bg-sky-950/40',         text: 'text-sky-900 dark:text-sky-100',         iconBg: 'bg-sky-100 dark:bg-sky-900/60',         iconFg: 'text-sky-600 dark:text-sky-300',         watermark: 'text-sky-200 dark:text-sky-800/50'         },
  amber:   { bg: 'bg-amber-50 dark:bg-amber-950/40',     text: 'text-amber-900 dark:text-amber-100',     iconBg: 'bg-amber-100 dark:bg-amber-900/60',     iconFg: 'text-amber-600 dark:text-amber-300',     watermark: 'text-amber-200 dark:text-amber-800/50'     },
  violet:  { bg: 'bg-violet-50 dark:bg-violet-950/40',   text: 'text-violet-900 dark:text-violet-100',   iconBg: 'bg-violet-100 dark:bg-violet-900/60',   iconFg: 'text-violet-600 dark:text-violet-300',   watermark: 'text-violet-200 dark:text-violet-800/50'   },
}
function ColorStatCard({ label, value, Icon, color }: { label: string; value: string; Icon: React.ComponentType<{ className?: string }>; color: StatColor }) {
  const c = COLOR_MAP[color]
  return (
    <div className={cn('relative flex items-start gap-3 overflow-hidden rounded-xl border border-transparent p-4', c.bg)}>
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', c.iconBg)}>
        <Icon className={cn('h-5 w-5', c.iconFg)} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn('text-xs font-semibold uppercase tracking-wide', c.text)}>{label}</p>
        <p className={cn('mt-1 text-xl font-bold leading-tight', c.text)}>{value}</p>
      </div>
      <Icon className={cn('pointer-events-none absolute -right-2 -top-2 h-16 w-16 opacity-30', c.watermark)} />
    </div>
  )
}

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; stages?: string[]; forecast?: string[]; acv?: string[] }

export function ProjectCosting({ teamId, weeksBack, productIds = [], userId, memberIds, stages = [], forecast = [], acv = [] }: Props) {
  const { t } = useTranslation()
  const { fmt: fmtCurrency, currency } = useDisplayCurrency()
  const [scope, setScope] = useState<Scope>('project')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [loading, setLoading] = useState(true)
  // Set of expanded node ids. Empty = fully collapsed (default), so only
  // top-level rows show until the user drills in.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    setLoading(true)
    const qs = new URLSearchParams({ scope, teamId, weeks: String(weeksBack) })
    if (productIds.length > 0) qs.set('productIds', productIds.join(','))
    if (userId) qs.set('userId', userId)
    // memberIds present (even empty) means a subteam is selected — scope to
    // its members. An empty subteam sends a sentinel so nothing matches.
    if (memberIds !== undefined) qs.set('userIds', memberIds.length > 0 ? memberIds.join(',') : '00000000-0000-0000-0000-000000000000')
    if (stages.length > 0) qs.set('stages', stages.join(','))
    if (forecast.length > 0) qs.set('forecast', forecast.join(','))
    if (acv.length > 0) qs.set('acv', acv.join(','))
    if (currency !== 'USD') qs.set('displayCurrency', currency)
    for (const [k, v] of Object.entries(dashDateParams())) qs.set(k, v)
    api.get<Row[]>(`/api/dashboards/project-costing?${qs.toString()}`)
      .then((res) => {
        setRows(res.data ?? [])
        setKpis((res.meta as { kpis?: Kpis } | undefined)?.kpis ?? null)
        setExpanded(new Set()) // reset to collapsed whenever the data changes
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, teamId, weeksBack, productIds.join(','), userId, memberIds?.join(',') ?? null, stages.join(','), forecast.join(','), acv.join(','), currency])

  // Parent/children maps for the tree. Rows arrive in DFS (pre-order) so we
  // filter for visibility (all ancestors expanded) while preserving order.
  const { parentOf, parentIds } = useMemo(() => {
    const pOf = new Map<string, string | null>()
    const pIds = new Set<string>()
    for (const r of rows ?? []) {
      pOf.set(r.id, r.parentId)
      if (r.parentId) pIds.add(r.parentId)
    }
    return { parentOf: pOf, parentIds: pIds }
  }, [rows])

  const isVisible = (r: Row): boolean => {
    let p = r.parentId
    while (p) { if (!expanded.has(p)) return false; p = parentOf.get(p) ?? null }
    return true
  }
  const toggleRow = (id: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const allExpanded = parentIds.size > 0 && [...parentIds].every((id) => expanded.has(id))
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(parentIds))
  const visibleRows = (rows ?? []).filter(isVisible)

  const options: Array<{ key: Scope; icon: typeof FlaskConical; label: string }> = [
    { key: 'project', icon: FlaskConical, label: t('leader.project_costing.scope_project', 'Projects') },
    { key: 'opp', icon: Target, label: t('leader.project_costing.scope_opp', 'Opportunities with Projects') },
    { key: 'account', icon: Building2, label: t('leader.project_costing.scope_account', 'Accounts with Opportunities with Projects') },
    { key: 'team', icon: Users, label: t('leader.project_costing.scope_team', 'Team / Subteam breakdown') },
  ]

  const firstColLabel = scope === 'project' ? t('leader.project_costing.col_project', 'Project')
    : scope === 'opp' ? t('leader.project_costing.col_opp', 'Opportunity')
    : scope === 'account' ? t('leader.project_costing.col_account', 'Account')
    : t('leader.project_costing.col_team', 'Team / Subteam')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('leader.project_costing.description', 'Cost, hours and ACV of project-linked activity, grouped by project, opportunity, account, or team.')}
        </p>
        <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleAll}
          disabled={parentIds.size === 0}
          title={allExpanded ? t('leader.project_costing.collapse_all', 'Collapse all') : t('leader.project_costing.expand_all', 'Expand all')}
          aria-label={allExpanded ? t('leader.project_costing.collapse_all', 'Collapse all') : t('leader.project_costing.expand_all', 'Expand all')}
          className="flex h-7 w-8 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
        </button>
        <div className="flex overflow-hidden rounded border border-gray-200 dark:border-gray-600">
          {options.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setScope(key)}
              title={label}
              aria-label={label}
              className={cn(
                'flex h-7 w-8 items-center justify-center transition-colors',
                scope === key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* KPI cards — always project-scoped regardless of the toggle. */}
      {kpis && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <ColorStatCard label={t('leader.project_costing.kpi_projects', 'Projects')} value={String(kpis.projects)} Icon={FolderKanban} color="indigo" />
          <ColorStatCard label={t('leader.project_costing.kpi_hours', 'Total Hours')} value={kpis.hours.toFixed(1)} Icon={Clock} color="sky" />
          <ColorStatCard label={t('leader.project_costing.kpi_cost', 'Total Cost')} value={fmtCurrency(kpis.cost)} Icon={DollarSign} color="rose" />
          <ColorStatCard label={t('leader.project_costing.kpi_acv', 'Total ACV')} value={fmtCurrency(kpis.acv)} Icon={TrendingUp} color="emerald" />
          <ColorStatCard label={t('leader.project_costing.kpi_activities', 'Activities')} value={String(kpis.activities)} Icon={Activity} color="amber" />
          <ColorStatCard label={t('leader.project_costing.kpi_contributors', 'Contributors')} value={String(kpis.contributors)} Icon={UserRound} color="violet" />
        </div>
      )}

      {loading && <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>}
      {!loading && rows && rows.length === 0 && <DashboardEmptyState />}
      {!loading && rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">{firstColLabel}</th>
                <th className="px-3 py-2 text-center">{t('leader.project_costing.col_activities', 'Activities')}</th>
                <th className="px-3 py-2 text-center">{t('leader.project_costing.col_hours', 'Hours')}</th>
                <th className="px-3 py-2 text-center">{t('leader.project_costing.col_cost', 'Cost')}</th>
                <th className="px-3 py-2 text-center">{t('leader.project_costing.col_acv', 'ACV')}</th>
                <th className="px-3 py-2 text-center">{t('leader.project_costing.col_contributors', 'Contributors')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const hasChildren = parentIds.has(r.id)
                const open = expanded.has(r.id)
                return (
                <tr key={r.id} className="border-b border-gray-100 last:border-b-0 dark:border-gray-900">
                  <td className={cn('px-3 py-2', r.depth === 0 && 'font-semibold')} style={{ paddingLeft: 12 + r.depth * 20 }}>
                    <div className="flex items-center gap-1">
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={() => toggleRow(r.id)}
                          aria-label={open ? t('leader.project_costing.collapse_row', 'Collapse') : t('leader.project_costing.expand_row', 'Expand')}
                          aria-expanded={open}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="inline-block h-4 w-4 shrink-0" />
                      )}
                      <span className="truncate">{r.id.startsWith('un:') ? t('leader.project_costing.unassigned', 'Unassigned') : (r.name ?? '—')}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.activityCount}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.hours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{fmtCurrency(r.costDollars)}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.acv > 0 ? fmtCurrency(r.acv) : '—'}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.uniqueContributors}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
