import { useState, useEffect, useMemo, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, BellRing, BellOff, TrendingUp, User, Timer } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { NudgeDismissals } from './NudgeDismissals.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'

interface Row {
  id: string
  deliveredAt: string
  triggerType: string
  ruleName: string
  message: string
  channel: string
  nudgeRuleId: string | null
  userId: string
  userName: string
  userEmail: string
  teamName: string
}

// v1.310.0 shape, reused here for the KPI row — same fields NudgeDismissals
// itself renders, fetched separately (and with ?includeExpired=true) so the
// KPIs reflect every historical snooze, not just what's currently active.
interface DismissalRow {
  userId: string
  userName: string | null
  userEmail: string | null
  nudgeRuleId: string
  ruleName: string
  dismissed: 'permanent' | 'snoozed'
  dismissedAt: string
  dismissedUntil: string | null
}

type View = 'history' | 'dismissals'

function StatCard({
  icon: Icon,
  label,
  value,
  subLabel,
  subValue,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  subLabel?: string
  subValue?: string
  tone: 'good' | 'warn' | 'bad' | 'info'
}) {
  const TONE = {
    good: 'border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-100',
    warn: 'border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100',
    bad: 'border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/25 dark:text-rose-100',
    info: 'border-gray-200 bg-gray-50/60 text-gray-900 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-100',
  }[tone]
  const CHIP = {
    good: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300',
    bad: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300',
    info: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  }[tone]
  return (
    <div className={cn('relative overflow-hidden rounded-lg border p-3', TONE)}>
      <Icon className="pointer-events-none absolute -right-2 -top-2 h-16 w-16 opacity-10" />
      <div className="relative">
        <div className={cn('mb-1 inline-flex rounded-md p-1.5', CHIP)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <p className="text-[11px] uppercase tracking-wide opacity-75">{label}</p>
        <p className="truncate text-xl font-semibold" title={value}>{value}</p>
        {subLabel && (
          <p className="mt-0.5 text-[11px] opacity-75">{subLabel}: <span className="font-medium">{subValue}</span></p>
        )}
      </div>
    </div>
  )
}

// v1.324.0: Nudge History and Nudge Dismissals merged into one page (History
// default tab) so an admin has one place for "what fired, and what's been
// muted." Team-scoped like every other Nudge Rules screen — teamId="" +
// globalView renders a tenant-wide History view for App Admins (the old
// behavior), matching ActivityTypesConfig's established prop convention.
// Dismissals has no tenant-wide route (it's inherently per-team, resolved via
// team_members), so that tab only appears once a specific team is active.
export function NudgeHistory({ teamId, globalView }: { teamId: string; globalView?: boolean }) {
  const { t } = useTranslation()
  const [view, setView] = useState<View>('history')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [triggerFilter, setTriggerFilter] = useState('')
  const [nudgeFilter, setNudgeFilter] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [dismissals, setDismissals] = useState<DismissalRow[] | null>(null)
  const PAGE_SIZE = 20

  const reload = async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (triggerFilter) params.set('triggerType', triggerFilter)
    if (nudgeFilter) params.set('nudgeRuleId', nudgeFilter)
    if (!globalView && teamId) params.set('teamId', teamId)
    params.set('limit', '500')
    const res = await api.get<Row[]>(`/api/admin/nudge-history?${params.toString()}`)
    setRows(res.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [triggerFilter, nudgeFilter, teamId, globalView])

  // KPI data — a separate, unfiltered fetch decoupled from the History
  // pane's own filter state, same pattern as CrmSync's loadSummary(). Only
  // meaningful for a specific team (dismissals has no tenant-wide route).
  const loadDismissalsSummary = async () => {
    if (globalView || !teamId) { setDismissals([]); return }
    const res = await api.get<DismissalRow[]>(`/api/admin/teams/${teamId}/nudge-dismissals?includeExpired=true`)
    setDismissals(res.data ?? [])
  }
  useEffect(() => { void loadDismissalsSummary() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamId, globalView])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((r) =>
      r.message.toLowerCase().includes(needle) ||
      r.userEmail.toLowerCase().includes(needle) ||
      r.userName.toLowerCase().includes(needle) ||
      r.teamName.toLowerCase().includes(needle) ||
      r.ruleName.toLowerCase().includes(needle),
    )
  }, [rows, q])

  useEffect(() => { setPage(0) }, [q, triggerFilter, nudgeFilter])
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const triggerTypes = Array.from(new Set(rows.map((r) => r.triggerType))).sort()
  // "Nudge" options are keyed by nudgeRuleId (stable even if the rule is
  // later renamed) but labeled with the current ruleName — a null
  // nudgeRuleId (rule deleted) is excluded from the filter since there's
  // nothing stable left to filter on.
  const nudgeOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const r of rows) {
      if (r.nudgeRuleId && !byId.has(r.nudgeRuleId)) byId.set(r.nudgeRuleId, r.ruleName)
    }
    return Array.from(byId.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])

  // KPI #1/#2 — from the (unfiltered-by-panel-filters) history rows already
  // loaded for this scope.
  const topNudge = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.ruleName, (counts.get(r.ruleName) ?? 0) + 1)
    let best: [string, number] | null = null
    for (const entry of counts) if (!best || entry[1] > best[1]) best = entry
    return best
  }, [rows])
  const topUser = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>()
    for (const r of rows) {
      const existing = counts.get(r.userId)
      counts.set(r.userId, { name: r.userName, count: (existing?.count ?? 0) + 1 })
    }
    let best: { name: string; count: number } | null = null
    for (const v of counts.values()) if (!best || v.count > best.count) best = v
    return best
  }, [rows])

  // KPI #3/#4 — from the full historical dismissals set (includeExpired),
  // snoozes only (a permanent close-out isn't "snoozed N days", it's forever).
  const snoozedOnly = useMemo(() => (dismissals ?? []).filter((d) => d.dismissed === 'snoozed'), [dismissals])
  const mostSnoozedRule = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of snoozedOnly) counts.set(d.ruleName, (counts.get(d.ruleName) ?? 0) + 1)
    let best: [string, number] | null = null
    for (const entry of counts) if (!best || entry[1] > best[1]) best = entry
    return best
  }, [snoozedOnly])
  const topSnoozer = useMemo(() => {
    const byUser = new Map<string, { name: string; count: number; totalDays: number }>()
    for (const d of snoozedOnly) {
      if (!d.dismissedUntil) continue
      const days = (new Date(d.dismissedUntil).getTime() - new Date(d.dismissedAt).getTime()) / 86_400_000
      const existing = byUser.get(d.userId)
      byUser.set(d.userId, {
        name: d.userName ?? d.userEmail ?? '',
        count: (existing?.count ?? 0) + 1,
        totalDays: (existing?.totalDays ?? 0) + days,
      })
    }
    let best: { name: string; count: number; totalDays: number } | null = null
    for (const v of byUser.values()) if (!best || v.count > best.count) best = v
    return best
  }, [snoozedOnly])

  const TABS: Array<{ key: View; label: string; icon: ComponentType<{ className?: string }> }> = [
    { key: 'history', label: t('admin.nudge_history.tab_history', 'History'), icon: BellRing },
    ...(!globalView && teamId ? [{ key: 'dismissals' as const, label: t('admin.nudge_history.tab_dismissals', 'Dismissals'), icon: BellOff }] : []),
  ]

  const kpisLoading = view === 'history' && loading && rows.length === 0

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {globalView
          ? t('admin.nudge_history.description', 'Every nudge delivered to a user across the tenant. Retained 30 days.')
          : t('admin.nudge_history.description_team', 'Every nudge delivered to a user on this team. Retained 30 days.')}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={TrendingUp}
          label={t('admin.nudge_history.kpi_top_nudge', 'Top Nudge')}
          value={kpisLoading ? '—' : topNudge ? `${topNudge[0]} (${topNudge[1]})` : '—'}
          tone="info"
        />
        <StatCard
          icon={User}
          label={t('admin.nudge_history.kpi_top_user', 'Top User')}
          value={kpisLoading ? '—' : topUser ? `${topUser.name} (${topUser.count})` : '—'}
          tone="info"
        />
        <StatCard
          icon={BellOff}
          label={t('admin.nudge_history.kpi_most_snoozed', 'Most Snoozed Nudge')}
          value={dismissals == null ? '—' : mostSnoozedRule ? `${mostSnoozedRule[0]} (${mostSnoozedRule[1]})` : '—'}
          tone="warn"
        />
        <StatCard
          icon={Timer}
          label={t('admin.nudge_history.kpi_top_snoozer', 'Top Snoozing User')}
          value={dismissals == null ? '—' : topSnoozer ? `${topSnoozer.name} (${topSnoozer.count})` : '—'}
          subLabel={t('admin.nudge_history.kpi_avg_snooze_days', 'Avg days snoozed')}
          subValue={topSnoozer ? (topSnoozer.totalDays / topSnoozer.count).toFixed(1) : '—'}
          tone="warn"
        />
      </div>

      {TABS.length > 1 && (
        <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5 text-xs dark:border-gray-700 dark:bg-gray-900">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const active = view === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setView(tab.key)}
                className={cn(
                  'flex items-center gap-1 rounded px-3 py-1',
                  active
                    ? 'bg-blue-600 font-medium text-white'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800',
                )}
              >
                <Icon className="h-3 w-3" />
                {tab.label}
              </button>
            )
          })}
        </div>
      )}

      {view === 'dismissals' && !globalView && teamId ? (
        <NudgeDismissals teamId={teamId} />
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="grid flex-1 grid-cols-1 gap-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_history.filter_search', 'Search')}</Label>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.nudge_history.filter_search_placeholder', 'User, team, or message…')} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_history.filter_trigger', 'Trigger')}</Label>
                <Select value={triggerFilter} onChange={(e) => setTriggerFilter(e.target.value)}>
                  <option value="">{t('common.all', 'All')}</option>
                  {triggerTypes.map((tt) => <option key={tt} value={tt}>{tt}</option>)}
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.nudge_history.filter_nudge', 'Nudge')}</Label>
                <Select value={nudgeFilter} onChange={(e) => setNudgeFilter(e.target.value)}>
                  <option value="">{t('common.all', 'All')}</option>
                  {nudgeOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </Select>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={reload} disabled={loading} className="mt-6">
              {loading ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              {t('common.refresh', 'Refresh')}
            </Button>
          </div>

          {loading ? (
            <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('admin.nudge_history.empty', 'No nudges delivered in the last 30 days.')}
            </p>
          ) : (
            <>
            <div className="overflow-x-auto rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-2 text-left">{t('admin.nudge_history.col_user', 'User / Team')}</th>
                    <th className="px-3 py-2 text-left">{t('admin.nudge_history.col_trigger', 'Trigger')}</th>
                    <th className="px-3 py-2 text-left">{t('admin.nudge_history.col_nudge', 'Nudge')}</th>
                    <th className="px-3 py-2 text-left">{t('admin.nudge_history.col_message', 'Message')}</th>
                    <th className="px-3 py-2 text-left">{t('admin.nudge_history.col_channel', 'Channel')}</th>
                    <th className="px-3 py-2 text-left">{t('admin.nudge_history.col_delivered', 'Delivered')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-3 py-2 align-top">
                        <p className="font-medium text-gray-900 dark:text-gray-100">{r.userName}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{r.userEmail}</p>
                        <p className="text-[10px] text-gray-400 dark:text-gray-500">{r.teamName}</p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-mono text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">{r.triggerType}</span>
                      </td>
                      <td className="px-3 py-2 align-top text-xs font-medium text-gray-700 dark:text-gray-200">{r.ruleName}</td>
                      <td className="max-w-[420px] px-3 py-2 align-top text-xs text-gray-700 dark:text-gray-200">{r.message}</td>
                      <td className="px-3 py-2 align-top text-xs text-gray-500 dark:text-gray-400">{r.channel}</td>
                      <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-gray-500 dark:text-gray-400">{new Date(r.deliveredAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>
                {filtered.length === 0 ? 0 : page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>{t('common.prev', 'Prev')}</Button>
                <span>{page + 1} / {totalPages}</span>
                <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>{t('common.next', 'Next')}</Button>
              </div>
            </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
