import { useEffect, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { Link2, PlugZap, Settings2, RefreshCw, Users, CalendarClock, CalendarPlus, CalendarCheck2, CircleDot, SearchX, DollarSign, UserCheck, Building2, Star, GitBranch, AlertTriangle, Hash, X, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { SingleSelect } from '../ui/single-select.js'
import { TrendChip } from '../ui/trend-chip.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, dashDateParams } from '../../lib/dashboard-fetch.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

type DateBasis = 'created' | 'close' | 'open'
interface BreakdownUser { userId: string; displayName: string; oppsAttached: number; acv: number; matched: boolean }
interface WeekRow { weekStart: string; total: number; attached: number; pct: number }
interface RoleRow { role: string; opps: number; acv: number }
interface Callout { oppId: string; name: string; acv: number; ownerName: string | null; suggestedSe: string | null }
interface Resp {
  total: number
  attached: number
  pct: number
  totalAcv: number
  attachedAcv: number
  pctAcv: number
  primaryCount: number
  secondaryCount: number
  primaryAcv: number
  secondaryAcv: number
  callouts: Callout[]
  calloutCount: number
  instanceUrl: string | null
  weekly: WeekRow[]
  breakdown: BreakdownUser[]
  roles: RoleRow[]
  dateBasis: DateBasis
  notConfigured: boolean
  stale: boolean
  snapshotAt: string | null
  hasHistory: boolean
  noMatch: boolean
}
interface SeCreditRow { key: string; level: 0 | 1 | 2; name: string; opps: number; acv: number; oppsPct: number; acvPct: number }
interface RepRow { key: string; level: 0 | 1 | 2; name: string; owned: number; primary: number; secondary: number; primaryPct: number; secondaryPct: number; ownedAcv: number; primaryAcv: number; secondaryAcv: number }
interface BreakdownResp { seCredit: SeCreditRow[]; repOwned: RepRow[] }

const fmtAcv = (n: number) => '$' + Math.round(n).toLocaleString()
const rateColor = (p: number) => p >= 80 ? 'bg-green-500' : p >= 50 ? 'bg-yellow-500' : 'bg-red-500'

type StatColor = 'indigo' | 'emerald' | 'sky' | 'amber' | 'violet' | 'rose'
const STAT_STYLES: Record<StatColor, string> = {
  indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  sky: 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
}
function StatTile({ label, value, sub, Icon, color, children }: { label: string; value: string; sub?: string; Icon: ComponentType<{ className?: string }>; color: StatColor; children?: React.ReactNode }) {
  return (
    <div className={`relative overflow-hidden rounded-lg px-4 py-3 ${STAT_STYLES[color]}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide opacity-80">
        <Icon className="h-4 w-4" /> {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</span>
        {children}
      </div>
      {sub && <div className="mt-0.5 text-xs opacity-70">{sub}</div>}
      <Icon className="pointer-events-none absolute -bottom-3 -right-3 h-16 w-16 opacity-10" />
    </div>
  )
}

// Left slide-in drawer listing every opportunity missing an Assigned SE
// (attached only via an activity or evaluation field), each linking out to
// Salesforce so the owner can set the Assigned SE.
function MissingSeDrawer({ callouts, total, instanceUrl, onClose }: { callouts: Callout[]; total: number; instanceUrl: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[80] flex">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col border-r border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              {t('leader.attach_rate.callout_title', { count: total })}
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t('leader.attach_rate.callout_sub')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="flex-1 divide-y divide-gray-100 overflow-auto dark:divide-gray-800">
          {callouts.map((c) => {
            const href = instanceUrl ? `${instanceUrl}/${c.oppId}` : null
            return (
              <li key={c.oppId} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate font-medium text-blue-600 hover:underline dark:text-blue-400"
                        title={t('leader.attach_rate.callout_open_sf', 'Open in Salesforce')}
                      >
                        {c.name}
                      </a>
                    ) : (
                      <span className="truncate font-medium text-gray-900 dark:text-gray-100">{c.name}</span>
                    )}
                    {href && <ExternalLink className="h-3 w-3 shrink-0 text-blue-500" />}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">
                    {c.ownerName && <>{t('leader.attach_rate.callout_owner', { owner: c.ownerName })}</>}
                    {c.suggestedSe && <> · {t('leader.attach_rate.callout_suggested', { se: c.suggestedSe })}</>}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-gray-700 dark:text-gray-300">{fmtAcv(c.acv)}</span>
              </li>
            )
          })}
        </ul>
        {total > callouts.length && (
          <p className="border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {t('leader.attach_rate.callout_more', { count: total - callouts.length })}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}

interface Props {
  teamId: string
  weeksBack: number
  userId?: string | null
  memberIds?: string[]
  stages?: string[]
  forecast?: string[]
  acv?: string[]
  productIds?: string[]
  compareMode?: CompareMode
}

function buildUrl(basis: DateBasis, p: Props, weekShift?: number): string {
  const qs = new URLSearchParams({ teamId: p.teamId, weeks: String(p.weeksBack), dateBasis: basis })
  if (p.userId) qs.set('userId', p.userId)
  if (p.memberIds !== undefined) qs.set('userIds', p.memberIds.length > 0 ? p.memberIds.join(',') : '00000000-0000-0000-0000-000000000000')
  if ((p.stages ?? []).length > 0) qs.set('stages', (p.stages ?? []).join(','))
  if ((p.forecast ?? []).length > 0) qs.set('forecast', (p.forecast ?? []).join(','))
  if ((p.acv ?? []).length > 0) qs.set('acv', (p.acv ?? []).join(','))
  if ((p.productIds ?? []).length > 0) qs.set('productIds', (p.productIds ?? []).join(','))
  if (weekShift !== undefined && weekShift !== 0) qs.set('weekShift', String(weekShift))
  // Shared FY/FQ or custom start/end window from the dashboard filter bar.
  // The prior-period Compare fetch (weekShift) keeps its own weeksBack window,
  // so don't pin it to the explicit dates.
  if (weekShift === undefined || weekShift === 0) {
    for (const [k, v] of Object.entries(dashDateParams())) qs.set(k, v)
  }
  return `/api/dashboards/attach-rate?${qs.toString()}`
}

export function AttachRate(props: Props) {
  const { teamId, weeksBack, userId, memberIds, stages = [], forecast = [], acv = [], productIds = [], compareMode = 'off' } = props
  const { t, i18n } = useTranslation()
  const [dateBasis, setDateBasis] = useState<DateBasis>('created')
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [priorPct, setPriorPct] = useState<number | null>(null)
  const [breakdown, setBreakdown] = useState<BreakdownResp | null>(null)
  // Left slide-in drawer listing every missing-Assigned-SE opportunity.
  const [drawerOpen, setDrawerOpen] = useState(false)

  const memberKey = memberIds?.join(',') ?? null

  useEffect(() => {
    setLoading(true)
    setRefreshMsg(null)
    api.get<Resp>(buildUrl(dateBasis, props))
      .then((res) => setData(res.data ?? null))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, weeksBack, userId, memberKey, stages.join(','), forecast.join(','), acv.join(','), productIds.join(','), dateBasis])

  useEffect(() => {
    const qs = new URLSearchParams({ teamId, weeks: String(weeksBack), dateBasis })
    if (userId) qs.set('userId', userId)
    if (memberIds !== undefined) qs.set('userIds', memberIds.length > 0 ? memberIds.join(',') : '00000000-0000-0000-0000-000000000000')
    if (stages.length > 0) qs.set('stages', stages.join(','))
    if (forecast.length > 0) qs.set('forecast', forecast.join(','))
    if (acv.length > 0) qs.set('acv', acv.join(','))
    if (productIds.length > 0) qs.set('productIds', productIds.join(','))
    for (const [k, v] of Object.entries(dashDateParams())) qs.set(k, v)
    api.get<BreakdownResp>(`/api/dashboards/attach-rate-breakdown?${qs.toString()}`)
      .then((res) => setBreakdown(res.data ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, weeksBack, userId, memberKey, stages.join(','), forecast.join(','), acv.join(','), productIds.join(','), dateBasis])

  useEffect(() => {
    if (compareMode === 'off') { setPriorPct(null); return }
    api.get<Resp>(buildUrl(dateBasis, props, weekShiftFor(compareMode)))
      .then((res) => setPriorPct(res.data?.pct ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, weeksBack, userId, memberKey, stages.join(','), forecast.join(','), acv.join(','), dateBasis, compareMode])

  const refresh = async () => {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const res = await api.post<unknown>('/api/dashboards/refresh-opp-snapshots', {})
      const meta = res.meta as { retryAfterSec?: number; retryAfter?: number } | undefined
      const retrySec = meta?.retryAfterSec ?? meta?.retryAfter
      if (res.error && retrySec != null) {
        setRefreshMsg({ kind: 'warn', text: t('leader.attach_rate.refresh_wait', { min: Math.max(1, Math.ceil(retrySec / 60)) }) })
        return
      }
      if (res.error) { setRefreshMsg({ kind: 'err', text: t('leader.attach_rate.refresh_failed') }); return }
      const r = await api.get<Resp>(buildUrl(dateBasis, props))
      setData(r.data ?? null)
      setRefreshMsg({ kind: 'ok', text: t('leader.attach_rate.refresh_done') })
    } finally {
      setRefreshing(false)
    }
  }

  const basisOptions = [
    { value: 'created', label: t('leader.attach_rate.basis_created'), icon: CalendarPlus, description: t('leader.attach_rate.cohort_note_created') },
    { value: 'close', label: t('leader.attach_rate.basis_close'), icon: CalendarCheck2, description: t('leader.attach_rate.cohort_note_close') },
    { value: 'open', label: t('leader.attach_rate.basis_open'), icon: CircleDot, description: t('leader.attach_rate.cohort_note_open') },
  ]

  const basisRow = (snapWhen: string | null, stale: boolean) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SingleSelect
        label={t('leader.attach_rate.date_basis')}
        labelIcon={CalendarClock}
        options={basisOptions}
        value={dateBasis}
        onChange={(v) => setDateBasis(v as DateBasis)}
      />
      <div className="flex items-center gap-3">
        {refreshMsg && (
          <span className={
            refreshMsg.kind === 'ok' ? 'text-xs text-green-600 dark:text-green-400'
              : refreshMsg.kind === 'warn' ? 'text-xs text-amber-600 dark:text-amber-400'
                : 'text-xs text-red-600 dark:text-red-400'
          }>{refreshMsg.text}</span>
        )}
        {snapWhen && (
          <span className={stale ? 'text-xs text-amber-600 dark:text-amber-400' : 'text-xs text-gray-400 dark:text-gray-500'}>
            {t('leader.attach_rate.snapshot_as_of', { when: snapWhen })}
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          title={t('leader.attach_rate.refresh')}
        >
          {refreshing ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />} {t('leader.attach_rate.refresh')}
        </button>
      </div>
    </div>
  )

  const cohortNote = <p className="-mt-3 text-xs text-gray-500 dark:text-gray-400">{t(`leader.attach_rate.cohort_note_${dateBasis}`)}</p>

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />
  const d = data

  if (d.notConfigured) {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-6 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
        <p className="flex items-center gap-2 font-semibold"><Settings2 className="h-4 w-4" /> {t('leader.attach_rate.not_configured_title')}</p>
        <p className="mt-1 text-blue-700 dark:text-blue-400">{t('leader.attach_rate.not_configured_body')}</p>
      </div>
    )
  }

  if (d.total === 0 && !d.snapshotAt) {
    return (
      <div className="flex flex-col gap-4">
        {basisRow(null, false)}
        {cohortNote}
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-6 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="flex items-center gap-2 font-semibold"><PlugZap className="h-4 w-4" /> {t('leader.attach_rate.no_snapshot_title')}</p>
          <p className="mt-1 text-amber-700 dark:text-amber-400">{t('leader.attach_rate.no_snapshot_body')}</p>
        </div>
      </div>
    )
  }

  const snapWhen = d.snapshotAt ? new Date(d.snapshotAt).toLocaleString(i18n.language) : null

  if (d.noMatch) {
    return (
      <div className="flex flex-col gap-4">
        {basisRow(snapWhen, d.stale)}
        {cohortNote}
        <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
          <p className="flex items-center gap-2 font-semibold"><SearchX className="h-4 w-4" /> {t('leader.attach_rate.no_match_title')}</p>
          <p className="mt-1 text-gray-500 dark:text-gray-400">{t('leader.attach_rate.no_match_body')}</p>
        </div>
      </div>
    )
  }

  const showCompare = compareMode !== 'off' && priorPct !== null && (dateBasis !== 'open' || d.hasHistory)
  const pctOf = (n: number, dn: number) => dn > 0 ? Math.round((n / dn) * 1000) / 10 : 0
  // Top-5 SE lists (by opp count, and by ACV) with % share of attached.
  const byCount = [...d.breakdown].sort((a, b) => b.oppsAttached - a.oppsAttached).slice(0, 5)
  const byAcv = [...d.breakdown].sort((a, b) => b.acv - a.acv).slice(0, 5)

  return (
    <div className="flex flex-col gap-6">
      {basisRow(snapWhen, d.stale)}
      {cohortNote}

      {/* Decorative KPI tiles. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label={t('leader.attach_rate.headline')} value={`${d.pct.toFixed(1)}%`} sub={t('leader.attach_rate.attached_of_total', { attached: d.attached, total: d.total })} Icon={Link2} color="indigo">
          {showCompare && <TrendChip current={d.pct} prior={priorPct!} mode={compareMode} />}
        </StatTile>
        <StatTile label={t('leader.attach_rate.headline_acv')} value={`${d.pctAcv.toFixed(1)}%`} sub={t('leader.attach_rate.acv_of_total', { attached: fmtAcv(d.attachedAcv), total: fmtAcv(d.totalAcv) })} Icon={DollarSign} color="emerald" />
        <StatTile label={t('leader.attach_rate.kpi_attached')} value={String(d.attached)} sub={t('leader.attach_rate.of_n_opps', { total: d.total })} Icon={Hash} color="sky" />
        <StatTile label={t('leader.attach_rate.kpi_attached_acv')} value={fmtAcv(d.attachedAcv)} Icon={DollarSign} color="violet" />
        <StatTile label={t('leader.attach_rate.kpi_primary')} value={String(d.primaryCount)} sub={`${pctOf(d.primaryCount, d.total)}% · ${fmtAcv(d.primaryAcv)}`} Icon={Star} color="amber" />
        <StatTile label={t('leader.attach_rate.kpi_secondary')} value={String(d.secondaryCount)} sub={`${pctOf(d.secondaryCount, d.total)}% · ${fmtAcv(d.secondaryAcv)}`} Icon={GitBranch} color="rose" />
      </div>

      {/* Attached-by-SE (top 5s) and Attached-by-role. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <p className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
            <Users className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('leader.attach_rate.by_se')}
          </p>
          {d.breakdown.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('leader.attach_rate.no_se_matched')}</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">{t('leader.attach_rate.top_by_count')}</p>
                <ul className="flex flex-col gap-1">
                  {byCount.map((b) => (
                    <li key={b.userId} className="flex items-center justify-between gap-2 text-sm">
                      <span
                        className={b.matched ? 'truncate text-gray-700 dark:text-gray-300' : 'truncate text-red-600 dark:text-red-400'}
                        title={b.matched ? undefined : t('leader.attach_rate.not_in_impactiq', 'Not an ImpactIQ user')}
                      >
                        {b.displayName}
                      </span>
                      <span className="shrink-0 font-medium text-gray-900 dark:text-gray-100">{b.oppsAttached} <span className="text-gray-400">({pctOf(b.oppsAttached, d.attached)}%)</span></span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">{t('leader.attach_rate.top_by_acv')}</p>
                <ul className="flex flex-col gap-1">
                  {byAcv.map((b) => (
                    <li key={b.userId} className="flex items-center justify-between gap-2 text-sm">
                      <span
                        className={b.matched ? 'truncate text-gray-700 dark:text-gray-300' : 'truncate text-red-600 dark:text-red-400'}
                        title={b.matched ? undefined : t('leader.attach_rate.not_in_impactiq', 'Not an ImpactIQ user')}
                      >
                        {b.displayName}
                      </span>
                      <span className="shrink-0 font-medium text-gray-900 dark:text-gray-100">{fmtAcv(b.acv)} <span className="text-gray-400">({pctOf(b.acv, d.attachedAcv)}%)</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <p className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
            <UserCheck className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('leader.attach_rate.by_role')}
          </p>
          {d.roles.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('leader.attach_rate.no_se_matched')}</p>
          ) : (
            <ul className="mt-3 flex max-h-56 flex-col gap-1.5 overflow-auto">
              {d.roles.map((r) => (
                <li key={r.role} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-gray-700 dark:text-gray-300">{r.role}</span>
                  <span className="shrink-0 font-medium text-gray-900 dark:text-gray-100">
                    {t('leader.attach_rate.opps_count', { count: r.opps })}
                    {r.acv > 0 && <span className="ml-2 text-gray-400">{fmtAcv(r.acv)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Missing-Assigned-SE worklist (attached only via secondary signals).
          Card shows the top 5 by ACV; "View all" opens a left drawer with
          every missing-SE opportunity + a link to open it in Salesforce. */}
      {d.callouts.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                {t('leader.attach_rate.callout_title', { count: d.calloutCount })}
              </p>
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{t('leader.attach_rate.callout_sub')}</p>
            </div>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
            >
              {t('leader.attach_rate.callout_view_all', { count: d.calloutCount })}
            </button>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {d.callouts.slice(0, 5).map((c) => (
              <li key={c.oppId} className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-amber-900 dark:text-amber-200">{c.name}</span>
                  <span className="block truncate text-xs text-amber-700 dark:text-amber-400">
                    {c.ownerName && <>{t('leader.attach_rate.callout_owner', { owner: c.ownerName })}</>}
                    {c.suggestedSe && <> · {t('leader.attach_rate.callout_suggested', { se: c.suggestedSe })}</>}
                  </span>
                </span>
                <span className="shrink-0 text-amber-700 dark:text-amber-400">{fmtAcv(c.acv)}</span>
              </li>
            ))}
          </ul>
          {d.calloutCount > 5 && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t('leader.attach_rate.callout_more', { count: d.calloutCount - 5 })}</p>
          )}
        </div>
      )}

      {drawerOpen && (
        <MissingSeDrawer
          callouts={d.callouts}
          total={d.calloutCount}
          instanceUrl={d.instanceUrl}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {d.weekly.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <p className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">{t('leader.attach_rate.trend')}</p>
          <div className="grid grid-cols-[110px_1fr_90px] items-center gap-2">
            {d.weekly.map((w) => (
              <div key={w.weekStart} className="contents">
                <span className="text-xs text-gray-600 dark:text-gray-400">{w.weekStart}</span>
                <div className="relative h-4 rounded bg-gray-100 dark:bg-gray-800">
                  <div className={`h-full rounded ${rateColor(w.pct)}`} style={{ width: `${Math.min(100, w.pct)}%` }} />
                </div>
                <span className="text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                  {w.pct}% <span className="text-gray-400">({w.attached}/{w.total})</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Breakdown tables — always shown (each with its own empty state). */}
      {breakdown && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <RepCoverageTable rows={breakdown.repOwned} />
          <SeCreditTable rows={breakdown.seCredit} />
        </div>
      )}
    </div>
  )
}

const indent = (lvl: number) => (lvl === 0 ? 'pl-0 font-semibold' : lvl === 1 ? 'pl-4' : 'pl-8 text-gray-600 dark:text-gray-400')

// Team -> Sub-team -> User breakdown rows arrive as a flat, pre-ordered list
// (each parent immediately followed by its children — see groupBreakdown()
// server-side). Collapsing a level-0/1 row hides every row after it whose
// level is deeper, until the next row at that same level (or shallower)
// reappears — a single "skip until we're back at level <= X" barrier is
// enough since we only ever hide one active subtree at a time.
function collapsibleRows<T extends { key: string; level: 0 | 1 | 2 }>(rows: T[], collapsed: Set<string>): T[] {
  const out: T[] = []
  let hideBelowLevel: number | null = null
  for (const r of rows) {
    if (hideBelowLevel !== null) {
      if (r.level > hideBelowLevel) continue
      hideBelowLevel = null
    }
    out.push(r)
    if (r.level < 2 && collapsed.has(r.key)) hideBelowLevel = r.level
  }
  return out
}

function CollapseToggle({ level, collapsedHere, onToggle }: { level: 0 | 1 | 2; collapsedHere: boolean; onToggle: () => void }) {
  if (level === 2) return <span className="inline-block h-3.5 w-3.5 shrink-0" />
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mr-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
    >
      {collapsedHere ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
    </button>
  )
}

function RepCoverageTable({ rows }: { rows: RepRow[] }) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const visible = collapsibleRows(rows, collapsed)
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
        <Building2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        {t('leader.attach_rate.breakdown_rep')}
      </p>
      <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{t('leader.attach_rate.breakdown_rep_sub')}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('leader.attach_rate.breakdown_rep_empty')}</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
              <th className="py-1 font-medium">{t('leader.attach_rate.col_group')}</th>
              <th className="py-1 text-right font-medium">{t('leader.attach_rate.col_owned')}</th>
              <th className="py-1 text-right font-medium">{t('leader.attach_rate.col_primary')}</th>
              <th className="py-1 text-right font-medium">{t('leader.attach_rate.col_secondary')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key} className="border-t border-gray-100 dark:border-gray-800">
                <td className={`py-1 ${indent(r.level)} text-gray-800 dark:text-gray-200`}>
                  <span className="flex items-center">
                    <CollapseToggle level={r.level} collapsedHere={collapsed.has(r.key)} onToggle={() => toggle(r.key)} />
                    {r.name}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums text-gray-700 dark:text-gray-300">{r.owned}</td>
                <td className="py-1 text-right tabular-nums text-gray-900 dark:text-gray-100">{r.primary} <span className="text-gray-400">({r.primaryPct}%)</span></td>
                <td className="py-1 text-right tabular-nums text-gray-900 dark:text-gray-100">{r.secondary} <span className="text-gray-400">({r.secondaryPct}%)</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function SeCreditTable({ rows }: { rows: SeCreditRow[] }) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const visible = collapsibleRows(rows, collapsed)
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
        <Building2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        {t('leader.attach_rate.breakdown_se')}
      </p>
      <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{t('leader.attach_rate.breakdown_se_sub')}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('leader.attach_rate.no_se_matched_impactiq', 'No opportunities are credited to an ImpactIQ user in this range — the credited people may not have ImpactIQ accounts. See "Attached by SE" above for everyone credited, including outside ImpactIQ.')}</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
              <th className="py-1 font-medium">{t('leader.attach_rate.col_group')}</th>
              <th className="py-1 text-right font-medium">{t('leader.attach_rate.col_opps')}</th>
              <th className="py-1 text-right font-medium">{t('leader.attach_rate.col_share')}</th>
              <th className="py-1 text-right font-medium">{t('leader.attach_rate.col_acv')}</th>
              <th className="py-1 text-right font-medium">{t('leader.attach_rate.col_acv_share')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key} className="border-t border-gray-100 dark:border-gray-800">
                <td className={`py-1 ${indent(r.level)} text-gray-800 dark:text-gray-200`}>
                  <span className="flex items-center">
                    <CollapseToggle level={r.level} collapsedHere={collapsed.has(r.key)} onToggle={() => toggle(r.key)} />
                    {r.name}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums text-gray-700 dark:text-gray-300">{r.opps}</td>
                <td className="py-1 text-right tabular-nums font-medium text-gray-900 dark:text-gray-100">{r.oppsPct}%</td>
                <td className="py-1 text-right tabular-nums text-gray-500 dark:text-gray-400">{fmtAcv(r.acv)}</td>
                <td className="py-1 text-right tabular-nums font-medium text-gray-900 dark:text-gray-100">{r.acvPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
