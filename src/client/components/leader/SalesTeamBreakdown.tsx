import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Users, UserRound, Contact } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { Chip } from '../ui/chip.js'
import { cn } from '../../lib/utils.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { useTableView } from '../../lib/tableView.js'
import { SortableTh, TablePagination } from '../ui/table-controls.js'
import { SfActivitiesModal } from '../salesforce/SfActivitiesModal.js'
import { useTeam } from '../../store/team.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

interface OppNode { id: string; name: string; hours: number; activityCount: number }
interface AccountNode { id: string; name: string; hours: number; oppCount: number; activityCount: number; opps: OppNode[] }
interface OwnerNode {
  id: string
  name: string
  hours: number
  accountCount: number
  oppCount: number
  activityCount: number
  memberCount?: number
  coverage: { covered: number; total: number; state: 'green' | 'amber' | 'red' | 'none' }
  accounts: AccountNode[]
}
interface ManagerNode {
  id: string
  name: string
  hours: number
  accountCount: number
  oppCount: number
  activityCount: number
  memberCount?: number
  owners: OwnerNode[]
}
interface MemberNode {
  id: string
  name: string
  hours: number
  accountCount: number
  oppCount: number
  activityCount: number
  managers?: ManagerNode[]
  owners?: OwnerNode[]
}

type Pivot = 'manager' | 'owner' | 'member'
type AnyRow = ManagerNode | OwnerNode | MemberNode

interface Props {
  teamId: string
  weeksBack: number
  productIds: string[]
  userId?: string
  acv?: string[]
  // v1.245.0: previously accepted but silently ignored — see CLAUDE.md §13.
  stages?: string[]
  forecast?: string[]
  memberIds?: string[]
}

export function SalesTeamBreakdown({ teamId, weeksBack, productIds, userId = '', acv = [], stages = [], forecast = [], memberIds }: Props) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [pivot, setPivot] = useState<Pivot>('manager')
  const [includeManager, setIncludeManager] = useState(false)
  const [rows, setRows] = useState<AnyRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerTarget, setDrawerTarget] = useState<{ whatId: string; whatType: 'Opportunity' | 'Account'; whatName: string; extraWhatIds?: string[] } | null>(null)
  const { activeTeam } = useTeam()
  const drawerTeamId = activeTeam?.id ?? teamId
  const [meta, setMeta] = useState<{ totalHours: number; rangeStart?: string; rangeEnd?: string } | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setLoading(true)
    setRows(null)
    const extra: Record<string, string> = { pivot }
    if (pivot === 'member' && includeManager) extra['includeManager'] = 'true'
    if (acv.length > 0) extra['acv'] = acv.join(',')
    if (stages.length > 0) extra['stages'] = stages.join(',')
    if (forecast.length > 0) extra['forecast'] = forecast.join(',')
    if (memberIds && memberIds.length > 0) extra['userIds'] = memberIds.join(',')
    const url = buildDashboardUrl('sales-team-breakdown', {
      teamId, weeksBack, productIds, userId: userId || null,
      extra,
    })
    void api.get<AnyRow[]>(url).then((res) => {
      setRows(res.data ?? null)
      const m = res.meta as { totalHours?: number; rangeStart?: string; rangeEnd?: string }
      setMeta({ totalHours: m?.totalHours ?? 0, rangeStart: m?.rangeStart, rangeEnd: m?.rangeEnd })
    }).finally(() => setLoading(false))
  }, [teamId, weeksBack, productIds.join(','), userId, pivot, includeManager, acv.join(','), stages.join(','), forecast.join(','), memberIds?.join(',')])

  function toggle(k: string) {
    setExpanded((prev) => ({ ...prev, [k]: !prev[k] }))
  }

  function drillDown(startIso: string | undefined, endIso: string | undefined) {
    const params = new URLSearchParams()
    if (userId) params.set('userId', userId)
    if (startIso) params.set('startDate', startIso.slice(0, 10))
    if (endIso) params.set('endDate', endIso.slice(0, 10))
    nav(`/activities?${params.toString()}`)
  }

  const startIso = meta?.rangeStart
  const endIso = meta?.rangeEnd

  // Sort/search only over the top-level rows. Expandable children stay
  // grouped under the parent because rendering iterates top-level rows in
  // sorted/filtered/paginated order and inlines each row's own children.
  const safeRows: AnyRow[] = rows ?? []
  const getters = useMemo(() => ({
    name: (r: AnyRow) => r.name ?? '',
    hours: (r: AnyRow) => String(r.hours),
    members: (r: AnyRow) => String((r as ManagerNode | OwnerNode).memberCount ?? 0),
    accounts: (r: AnyRow) => String(r.accountCount),
    opps: (r: AnyRow) => String(r.oppCount),
    activities: (r: AnyRow) => String(r.activityCount),
  }), [])
  const view = useTableView<AnyRow>(safeRows, getters, { resetKey: `${pivot}:${includeManager}` })

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!rows) return <DashboardEmptyState />

  const showMembersCol = pivot !== 'member'
  const nameColKey =
    pivot === 'manager' ? 'manager' : pivot === 'owner' ? 'owner' : 'member'

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('leader.sales_team_breakdown.description')}
        </p>
        <div className="flex items-center gap-2">
          {pivot === 'member' && (
            <label className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={includeManager}
                onChange={(e) => setIncludeManager(e.target.checked)}
                className="h-3 w-3 rounded border-gray-300"
              />
              {t('leader.sales_team_breakdown.show_manager', 'Show Manager')}
            </label>
          )}
          <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-white p-0.5 text-xs dark:border-gray-700 dark:bg-gray-900">
            {(['manager', 'owner', 'member'] as const).map((p) => {
              const Icon = p === 'manager' ? Users : p === 'owner' ? UserRound : Contact
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPivot(p)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-1 font-medium transition-colors',
                    pivot === p
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(`leader.sales_team_breakdown.pivot.${p}`)}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <SortableTh
                label={t(`leader.sales_team_breakdown.col.${nameColKey}`)}
                colKey="name"
                sortKey={view.sortKey}
                sortDir={view.sortDir}
                onToggle={view.toggleSort}
                filterValue={view.filters['name']}
                onFilter={(v) => view.setFilter('name', v)}
                filterPlaceholder={t('common.search_placeholder')}
              />
              <SortableTh label={t('leader.sales_team_breakdown.col.hours')} colKey="hours" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} className="text-center" align="center" />
              {showMembersCol && (
                <SortableTh label={t('leader.sales_team_breakdown.col.members', 'Members')} colKey="members" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} className="text-center" align="center" />
              )}
              <SortableTh label={t('leader.sales_team_breakdown.col.accounts')} colKey="accounts" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} className="text-center" align="center" />
              <SortableTh label={t('leader.sales_team_breakdown.col.opps')} colKey="opps" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} className="text-center" align="center" />
              <SortableTh label={t('leader.sales_team_breakdown.col.activities')} colKey="activities" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} className="text-center" align="center" />
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={showMembersCol ? 7 : 6} className="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</td></tr>
            )}
            {view.visible.map((row) => {
              if (pivot === 'manager') {
                return <ManagerRow key={`m:${row.id}`} manager={row as ManagerNode} expanded={expanded} toggle={toggle} depth={0} startIso={startIso} endIso={endIso} drillDown={drillDown} openDrawer={setDrawerTarget} showMembers />
              }
              if (pivot === 'owner') {
                return <OwnerRow key={`o:${(row as OwnerNode).id}`} keyPrefix={`o:${(row as OwnerNode).id}`} owner={row as OwnerNode} expanded={expanded} toggle={toggle} depth={0} startIso={startIso} endIso={endIso} drillDown={drillDown} openDrawer={setDrawerTarget} showMembers />
              }
              return <MemberRow key={`u:${row.id}`} member={row as MemberNode} expanded={expanded} toggle={toggle} depth={0} startIso={startIso} endIso={endIso} drillDown={drillDown} openDrawer={setDrawerTarget} />
            })}
          </tbody>
        </table>
        <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('leader.sales_team_breakdown.footnote', { total: (meta?.totalHours ?? 0).toFixed(1) })}
      </p>
      <SfActivitiesModal
        open={drawerTarget !== null}
        onClose={() => setDrawerTarget(null)}
        teamId={drawerTeamId ?? ''}
        whatId={drawerTarget?.whatId ?? ''}
        whatType={drawerTarget?.whatType ?? 'Opportunity'}
        whatName={drawerTarget?.whatName ?? ''}
        rangeStart={meta?.rangeStart}
        rangeEnd={meta?.rangeEnd}
        extraWhatIds={drawerTarget?.extraWhatIds}
      />
    </div>
  )
}

function ManagerRow({ manager, expanded, toggle, depth, startIso, endIso, drillDown, openDrawer, showMembers }: {
  manager: ManagerNode; expanded: Record<string, boolean>; toggle: (k: string) => void;
  depth: number;
  startIso: string | undefined; endIso: string | undefined;
  drillDown: (s: string | undefined, e: string | undefined) => void;
  openDrawer: (t: { whatId: string; whatType: 'Opportunity' | 'Account'; whatName: string; extraWhatIds?: string[] }) => void;
  showMembers: boolean
}) {
  const mKey = `m:${manager.id}`
  const openM = !!expanded[mKey]
  return (
    <>
      <tr className="border-b border-gray-100 dark:border-gray-900 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/50" onClick={() => toggle(mKey)}>
        <td className="px-3 py-2 font-semibold" style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
          <span className="inline-flex items-center gap-1">
            {openM ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {manager.name}
            <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">({(manager.owners ?? []).length})</span>
          </span>
        </td>
        <td className="px-3 py-2 text-center tabular-nums">{manager.hours.toFixed(1)}</td>
        {showMembers && <td className="px-3 py-2 text-center tabular-nums">{manager.memberCount ?? 0}</td>}
        <td className="px-3 py-2 text-center tabular-nums">{manager.accountCount}</td>
        <td className="px-3 py-2 text-center tabular-nums">{manager.oppCount}</td>
        <td className="px-3 py-2 text-center tabular-nums">{manager.activityCount}</td>
        <td className="px-3 py-2 text-right"></td>
      </tr>
      {openM && manager.owners.map((o) => (
        <OwnerRow key={`${mKey}:${o.id}`} keyPrefix={`${mKey}:${o.id}`} owner={o} expanded={expanded} toggle={toggle} depth={depth + 1} startIso={startIso} endIso={endIso} drillDown={drillDown} openDrawer={openDrawer} showMembers={showMembers} />
      ))}
    </>
  )
}

function MemberRow({ member, expanded, toggle, depth, startIso, endIso, drillDown, openDrawer }: {
  member: MemberNode; expanded: Record<string, boolean>; toggle: (k: string) => void;
  depth: number;
  startIso: string | undefined; endIso: string | undefined;
  drillDown: (s: string | undefined, e: string | undefined) => void;
  openDrawer: (t: { whatId: string; whatType: 'Opportunity' | 'Account'; whatName: string; extraWhatIds?: string[] }) => void;
}) {
  const key = `u:${member.id}`
  const open = !!expanded[key]
  return (
    <>
      <tr className="border-b border-gray-100 dark:border-gray-900 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/50" onClick={() => toggle(key)}>
        <td className="px-3 py-2 font-semibold" style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
          <span className="inline-flex items-center gap-1">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {member.name}
          </span>
        </td>
        <td className="px-3 py-2 text-center tabular-nums">{member.hours.toFixed(1)}</td>
        <td className="px-3 py-2 text-center tabular-nums">{member.accountCount}</td>
        <td className="px-3 py-2 text-center tabular-nums">{member.oppCount}</td>
        <td className="px-3 py-2 text-center tabular-nums">{member.activityCount}</td>
        <td className="px-3 py-2 text-right"></td>
      </tr>
      {open && member.managers && member.managers.map((mgr) => (
        <ManagerRow key={`${key}:${mgr.id}`} manager={mgr} expanded={expanded} toggle={toggle} depth={depth + 1} startIso={startIso} endIso={endIso} drillDown={drillDown} openDrawer={openDrawer} showMembers={false} />
      ))}
      {open && member.owners && member.owners.map((o) => (
        <OwnerRow key={`${key}:${o.id}`} keyPrefix={`${key}:${o.id}`} owner={o} expanded={expanded} toggle={toggle} depth={depth + 1} startIso={startIso} endIso={endIso} drillDown={drillDown} openDrawer={openDrawer} showMembers={false} />
      ))}
    </>
  )
}

interface OwnerRowProps {
  keyPrefix: string
  owner: OwnerNode
  expanded: Record<string, boolean>
  toggle: (k: string) => void
  depth: number
  startIso: string | undefined
  endIso: string | undefined
  drillDown: (s: string | undefined, e: string | undefined) => void
  openDrawer: (t: { whatId: string; whatType: 'Opportunity' | 'Account'; whatName: string; extraWhatIds?: string[] }) => void
  showMembers: boolean
}

function OwnerRow({ keyPrefix, owner, expanded, toggle, depth, startIso, endIso, drillDown, openDrawer, showMembers }: OwnerRowProps) {
  const { t } = useTranslation()
  const open = !!expanded[keyPrefix]
  const cov = owner.coverage
  const chip = useMemo(() => {
    if (!cov) return null
    if (cov.state === 'green') return { variant: 'success' as const, label: t('leader.sales_team_breakdown.coverage.full'), hint: t('leader.sales_team_breakdown.coverage.full_hint') }
    if (cov.state === 'amber') return { variant: 'warning' as const, label: t('leader.sales_team_breakdown.coverage.partial', { covered: cov.covered, total: cov.total }), hint: t('leader.sales_team_breakdown.coverage.partial_hint') }
    if (cov.state === 'red') return { variant: 'danger' as const, label: t('leader.sales_team_breakdown.coverage.none'), hint: t('leader.sales_team_breakdown.coverage.none_hint') }
    return null
  }, [cov, t])
  return (
    <>
      <tr className="border-b border-gray-100 dark:border-gray-900 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/50" onClick={() => toggle(keyPrefix)}>
        <td className="px-3 py-2" style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
          <span className="inline-flex items-center gap-1.5">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span>{owner.name}</span>
            {chip && <Chip variant={chip.variant} size="xs" title={chip.hint}>{chip.label}</Chip>}
          </span>
        </td>
        <td className="px-3 py-2 text-center tabular-nums">{owner.hours.toFixed(1)}</td>
        {showMembers && <td className="px-3 py-2 text-center tabular-nums">{owner.memberCount ?? 0}</td>}
        <td className="px-3 py-2 text-center tabular-nums">{owner.accountCount}</td>
        <td className="px-3 py-2 text-center tabular-nums">{owner.oppCount}</td>
        <td className="px-3 py-2 text-center tabular-nums">{owner.activityCount}</td>
        <td className="px-3 py-2"></td>
      </tr>
      {open && owner.accounts.map((a) => {
        const aKey = `${keyPrefix}:${a.id}`
        const openA = !!expanded[aKey]
        return (
          <>
            <tr key={aKey} className="border-b border-gray-100 dark:border-gray-900 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/50" onClick={() => toggle(aKey)}>
              <td className="px-3 py-2" style={{ paddingLeft: `${0.75 + (depth + 1) * 1.25}rem` }}>
                <span className="inline-flex items-center gap-1">
                  {openA ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <span className="text-gray-400 dark:text-gray-500">{t('leader.sales_team_breakdown.account_prefix', 'Account:')}</span>
                  <span>{a.name}</span>
                  <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">({a.oppCount})</span>
                  {a.opps.length > 0 && (
                    <Chip
                      size="xs"
                      variant="info"
                      title={t('leader.sales_team_breakdown.scope_rollup_hint', 'Includes activities logged against this account and every opportunity under it.')}
                    >
                      {t('leader.sales_team_breakdown.scope_rollup', 'Includes Opps')}
                    </Chip>
                  )}
                </span>
              </td>
              <td className="px-3 py-2 text-center tabular-nums">{a.hours.toFixed(1)}</td>
              {showMembers && <td className="px-3 py-2"></td>}
              <td className="px-3 py-2 text-center tabular-nums">1</td>
              <td className="px-3 py-2 text-center tabular-nums">{a.oppCount}</td>
              <td className="px-3 py-2 text-center tabular-nums">{a.activityCount}</td>
              <td className="px-3 py-2 text-right">
                <button type="button" onClick={(e) => { e.stopPropagation(); openDrawer({ whatId: a.id, whatType: 'Account', whatName: a.name, extraWhatIds: a.opps.map((o) => o.id) }) }} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
                  {t('leader.sales_team_breakdown.drill')}
                </button>
              </td>
            </tr>
            {openA && a.opps.map((o) => (
              <tr key={`${aKey}:${o.id}`} className="border-b border-gray-100 dark:border-gray-900">
                <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300" style={{ paddingLeft: `${0.75 + (depth + 2) * 1.25}rem` }}>
                  <span className="mr-1 text-gray-400 dark:text-gray-500">{t('leader.sales_team_breakdown.opp_prefix', 'Oppty:')}</span>
                  {o.name}
                </td>
                <td className="px-3 py-1.5 text-center tabular-nums">{o.hours.toFixed(1)}</td>
                {showMembers && <td className="px-3 py-1.5"></td>}
                <td className="px-3 py-1.5 text-center tabular-nums">—</td>
                <td className="px-3 py-1.5 text-center tabular-nums">1</td>
                <td className="px-3 py-1.5 text-center tabular-nums">{o.activityCount}</td>
                <td className="px-3 py-1.5 text-right">
                  <button type="button" onClick={(e) => { e.stopPropagation(); openDrawer({ whatId: o.id, whatType: 'Opportunity', whatName: o.name }) }} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
                    {t('leader.sales_team_breakdown.drill')}
                  </button>
                </td>
              </tr>
            ))}
          </>
        )
      })}
    </>
  )
}
