import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, ListChecks, Users } from 'lucide-react'
import { api } from '../../lib/api.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { cn } from '../../lib/utils.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'

// Must match subteamAttribution.ts's UNASSIGNED_SUBTEAM_ID on the server.
// Duplicated (not imported) because that module lives server-side only —
// the client detects the bucket purely from the id shape, same convention
// ProjectCosting uses for its own synthetic "un:" rows.
const UNASSIGNED_KEY = '__unassigned__'

interface Metrics {
  totalCount: number
  totalHours: number
  avgDurationHours: number
  totalAcv: number
  avgCountPerOppty: number
  avgPerWeek: number
  avgPerMonth: number
  avgPerQuarter: number
  avgPerYear: number
}

interface Row {
  id: string
  name: string
  parentId: string | null
  depth: number
  metrics: Metrics
}

interface Props {
  teamId: string
  weeksBack: number
  productIds?: string[]
  subteamId?: string
  // v1.265.0: multi-select superset — OR'd server-side with subteamId
  // above, so passing both together is safe. See dashboards.ts's comment
  // on /team-activity-deep-dive for why Subteam stays a roster-narrowing
  // row axis here rather than the generic memberIds content filter.
  subteamIds?: string[]
  userId?: string | null
  memberIds?: string[]
  // v1.267.0: Subtype filter (§7/Batch 6) — a content filter here, unlike
  // subteamId/subteamIds above, since it narrows which activities count at
  // every tier rather than acting as a roster axis. See dashboards.ts.
  subtypeIds?: string[]
  stages?: string[]
  forecast?: string[]
  acv?: string[]
}

export function TeamActivityDeepDive({ teamId, weeksBack, productIds = [], subteamId, subteamIds, userId, memberIds, subtypeIds, stages = [], forecast = [], acv = [] }: Props) {
  const { t } = useTranslation()
  const { fmt: fmtCurrency, currency } = useDisplayCurrency()
  const [rows, setRows] = useState<Row[] | null>(null)
  // v1.320.0: the alternate Subteam-first tree, fetched alongside `rows` in
  // the same response (server reorganizes the same underlying facts, no
  // second query) so the view toggle below switches instantly with no
  // extra round trip.
  const [bySubteamRows, setBySubteamRows] = useState<Row[] | null>(null)
  const [view, setView] = useState<'activity_type' | 'subteam'>('activity_type')
  const [hasContentFilter, setHasContentFilter] = useState(false)
  const [loading, setLoading] = useState(true)
  // Set of expanded node ids. Empty = fully collapsed (default), so only
  // top-level rows show until the user drills in. Keyed per-view below
  // since the two trees use overlapping id shapes at different depths.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const activeRows = view === 'activity_type' ? rows : bySubteamRows

  const isAllTeams = !teamId || teamId === 'all'

  useEffect(() => {
    if (isAllTeams) { setRows(null); setLoading(false); return }
    setLoading(true)
    const url = buildDashboardUrl('team-activity-deep-dive', {
      teamId,
      weeksBack,
      productIds,
      userId: userId || null,
      memberIds,
      extra: {
        subteamId,
        subteamIds: subteamIds && subteamIds.length > 0 ? subteamIds.join(',') : undefined,
        subtypeIds: subtypeIds && subtypeIds.length > 0 ? subtypeIds.join(',') : undefined,
        stages: stages.join(','),
        forecast: forecast.join(','),
        acv: acv.join(','),
        displayCurrency: currency !== 'USD' ? currency : undefined,
      },
    })
    void api.get<Row[]>(url).then((res) => {
      setRows(res.data ?? [])
      setBySubteamRows((res.meta as { bySubteamRows?: Row[] } | undefined)?.bySubteamRows ?? [])
      setHasContentFilter((res.meta as { hasContentFilter?: boolean } | undefined)?.hasContentFilter ?? false)
      setExpanded(new Set()) // reset to collapsed whenever the data changes
    }).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, weeksBack, productIds.join(','), subteamId, subteamIds?.join(','), userId, memberIds?.join(','), subtypeIds?.join(','), stages.join(','), forecast.join(','), acv.join(','), currency, isAllTeams])

  // Switching the view swaps in a differently-shaped tree (same id
  // convention, different parents/depths) — stale expand state from the
  // other tree wouldn't map onto it correctly, so reset on toggle.
  function switchView(next: 'activity_type' | 'subteam') {
    if (next === view) return
    setView(next)
    setExpanded(new Set())
  }

  // Parent/children maps for the tree. Rows arrive in DFS (pre-order),
  // already sorted by Total Count descending at every tier, so we just
  // filter for visibility (all ancestors expanded) while preserving order.
  const { parentOf, parentIds } = useMemo(() => {
    const pOf = new Map<string, string | null>()
    const pIds = new Set<string>()
    for (const r of activeRows ?? []) {
      pOf.set(r.id, r.parentId)
      if (r.parentId) pIds.add(r.parentId)
    }
    return { parentOf: pOf, parentIds: pIds }
  }, [activeRows])

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
  const visibleRows = (activeRows ?? []).filter(isVisible)

  const displayName = (r: Row): string =>
    r.id.includes(`sub:${UNASSIGNED_KEY}`) ? t('leader.team_activity_deep_dive.unassigned', 'Unassigned') : r.name

  const fmtNum = (n: number) => n.toFixed(1)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {view === 'activity_type'
            ? t('leader.team_activity_deep_dive.description', 'Activity volume, duration, and ACV reach for this team, broken down by Activity Type → Subteam → Team Member.')
            : t('leader.team_activity_deep_dive.description_by_subteam', 'Activity volume, duration, and ACV reach for this team, broken down by Subteam → Team Member → Activity Type.')}
        </p>
        {!isAllTeams && (
          <div className="flex shrink-0 items-center gap-1">
            {/* v1.320.0: view toggle — Activity Type first (default, matches
                the tree this dashboard originally shipped with) or Subteam
                first. Both trees are already in hand from the same fetch, so
                switching is instant with no re-fetch. */}
            <div className="flex overflow-hidden rounded border border-gray-200 dark:border-gray-600">
              <button
                type="button"
                onClick={() => switchView('activity_type')}
                title={t('leader.team_activity_deep_dive.view_by_activity_type', 'View by Activity Type')}
                aria-label={t('leader.team_activity_deep_dive.view_by_activity_type', 'View by Activity Type')}
                aria-pressed={view === 'activity_type'}
                className={cn(
                  'flex h-7 w-8 items-center justify-center transition-colors',
                  view === 'activity_type'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
              >
                <ListChecks className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => switchView('subteam')}
                title={t('leader.team_activity_deep_dive.view_by_subteam', 'View by Subteam')}
                aria-label={t('leader.team_activity_deep_dive.view_by_subteam', 'View by Subteam')}
                aria-pressed={view === 'subteam'}
                className={cn(
                  'flex h-7 w-8 items-center justify-center border-l border-gray-200 transition-colors dark:border-gray-600',
                  view === 'subteam'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
              >
                <Users className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              onClick={toggleAll}
              disabled={parentIds.size === 0}
              title={allExpanded ? t('leader.team_activity_deep_dive.collapse_all', 'Collapse all') : t('leader.team_activity_deep_dive.expand_all', 'Expand all')}
              aria-label={allExpanded ? t('leader.team_activity_deep_dive.collapse_all', 'Collapse all') : t('leader.team_activity_deep_dive.expand_all', 'Expand all')}
              className="flex h-7 w-8 shrink-0 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
      </div>

      {isAllTeams && <DashboardEmptyState reason="select_team" />}

      {!isAllTeams && loading && <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>}
      {!isAllTeams && !loading && activeRows && activeRows.length === 0 && <DashboardEmptyState />}
      {!isAllTeams && !loading && activeRows && activeRows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">
                  {view === 'activity_type'
                    ? t('leader.team_activity_deep_dive.col_activity_type', 'Activity Type')
                    : t('leader.team_activity_deep_dive.col_subteam', 'Subteam')}
                </th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_total_count', 'Total Count')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_total_hours', 'Total Hours')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_avg_duration', 'AVG Duration (Hours)')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_total_acv', 'Total ACV Connected To')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_avg_count_per_oppty', 'AVG Count Per Oppty')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_avg_per_week', 'AVG Per Week')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_avg_per_month', 'AVG Per Month')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_avg_per_quarter', 'AVG Per Quarter')}</th>
                <th className="px-3 py-2 text-center">{t('leader.team_activity_deep_dive.col_avg_per_year', 'AVG Per Year')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const hasChildren = parentIds.has(r.id)
                const open = expanded.has(r.id)
                const m = r.metrics
                return (
                  <tr key={r.id} className="border-b border-gray-100 last:border-b-0 dark:border-gray-900">
                    <td className={cn('px-3 py-2', r.depth === 0 && 'font-semibold')} style={{ paddingLeft: 12 + r.depth * 20 }}>
                      <div className="flex items-center gap-1">
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={() => toggleRow(r.id)}
                            aria-label={open ? t('leader.team_activity_deep_dive.collapse_row', 'Collapse') : t('leader.team_activity_deep_dive.expand_row', 'Expand')}
                            aria-expanded={open}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                          >
                            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        ) : (
                          <span className="inline-block h-4 w-4 shrink-0" />
                        )}
                        <span className="truncate">{displayName(r)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center tabular-nums">{m.totalCount}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtNum(m.totalHours)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtNum(m.avgDurationHours)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{m.totalAcv > 0 ? fmtCurrency(m.totalAcv) : '—'}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtNum(m.avgCountPerOppty)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtNum(m.avgPerWeek)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtNum(m.avgPerMonth)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtNum(m.avgPerQuarter)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtNum(m.avgPerYear)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {!isAllTeams && !loading && activeRows && activeRows.length > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('leader.team_activity_deep_dive.footnote', 'Every active Activity Type and current team member is shown, even at zero. Non-Opportunity-linked activities count toward Total Count, Total Hours, AVG Duration, and every per-period average, but never toward ACV or AVG Count Per Oppty.')}
          {hasContentFilter && (
            <span className="ml-1 text-amber-700 dark:text-amber-400">
              {t('leader.team_activity_deep_dive.content_filter_note', 'A Stage / Forecast / ACV filter is active — it narrows which Opportunities qualify for ACV and AVG Count Per Oppty, but activities with no Opportunity link are unaffected by it.')}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
