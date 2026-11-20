import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase, UserPlus, ChevronRight, ChevronDown } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import { cn } from '../../lib/utils.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

interface BreakdownItem { type: 'Opportunity' | 'Lead' | 'Account'; id: string; name: string | null; hours: number }
interface Row { userId: string; displayName: string; accountId: string; accountName: string | null; totalHours: string; breakdown: BreakdownItem[] }

const TOP_N = 4
const PALETTE = ['bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-gray-400']

const BREAKDOWN_ICON = { Opportunity: Briefcase, Lead: UserPlus, Account: Briefcase } as const

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; acv?: string[]; stages?: string[]; forecast?: string[]; compareMode?: CompareMode }

export function AccountConcentration({ teamId, weeksBack, productIds = [], userId, memberIds, acv = [], stages = [], forecast = [], compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorTotal, setPriorTotal] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Row[]>(buildDashboardUrl('account-concentration', { teamId, weeksBack, productIds, userId, memberIds, extra: { acv: acv.length ? acv.join(',') : undefined, stages: stages.length ? stages.join(',') : undefined, forecast: forecast.length ? forecast.join(',') : undefined } }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), acv.join(','), stages.join(','), forecast.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotal(null); return }
    api.get<Row[]>(buildDashboardUrl('account-concentration', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode), extra: { acv: acv.length ? acv.join(',') : undefined, stages: stages.length ? stages.join(',') : undefined, forecast: forecast.length ? forecast.join(',') : undefined } }))
      .then((res) => setPriorTotal((res.data ?? []).reduce((s, r) => s + Number(r.totalHours), 0)))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode, acv.join(','), stages.join(','), forecast.join(',')])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />
  if (data.length === 0) return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>

  const byUser: Record<string, { displayName: string; accounts: { accountId: string; name: string; hours: number; breakdown: BreakdownItem[] }[] }> = {}
  for (const r of data) {
    const h = Number(r.totalHours)
    let bucket = byUser[r.userId]
    if (!bucket) {
      bucket = { displayName: r.displayName, accounts: [] }
      byUser[r.userId] = bucket
    }
    bucket.accounts.push({ accountId: r.accountId, name: r.accountName ?? t('leader.concentration.unnamed_account', 'Unnamed Account'), hours: h, breakdown: r.breakdown })
  }
  for (const u of Object.values(byUser)) {
    u.accounts.sort((a, b) => b.hours - a.hours)
  }

  const currentTotal = data.reduce((s, r) => s + Number(r.totalHours), 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.concentration.hint', 'Hours per Account — rolls up direct Account activity plus everything logged against its Opportunities and converted Leads. Click a bar to see what makes it up.')}</p>
        {compareMode !== 'off' && priorTotal !== null && (
          <span className="ml-auto flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"><span>Total: {currentTotal.toFixed(1)}h</span><TrendChip current={currentTotal} prior={priorTotal} mode={compareMode} /></span>
        )}
      </div>
      <div className="grid grid-cols-[180px_1fr] items-start gap-2">
        {Object.entries(byUser).map(([rowUserId, u]) => {
          const total = u.accounts.reduce((a, b) => a + b.hours, 0)
          const top = u.accounts.slice(0, TOP_N)
          const rest = u.accounts.slice(TOP_N).reduce((a, b) => a + b.hours, 0)
          const segments = [...top.map((a, i) => ({ accountId: a.accountId as string | null, label: a.name, hours: a.hours, color: PALETTE[i] ?? 'bg-gray-400', breakdown: a.breakdown }))]
          if (rest > 0) segments.push({ accountId: null, label: t('leader.concentration.rest', { count: u.accounts.length - TOP_N }), hours: rest, color: PALETTE[4] ?? 'bg-gray-400', breakdown: [] })
          const topPct = total > 0 ? (top[0]?.hours ?? 0) / total : 0
          const flag = topPct >= 0.5 ? '⚠' : ''
          return (
            <div key={rowUserId} className="contents">
              <span className="truncate text-xs text-gray-700 dark:text-gray-300">
                {flag} {u.displayName} <span className="text-gray-400">({u.accounts.length} {t('leader.concentration.accounts')})</span>
              </span>
              <div className="flex flex-col gap-1">
                <div className="flex h-4 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                  {segments.map((s, i) => (
                    <div
                      key={i}
                      className={s.color}
                      style={{ width: `${(s.hours / total) * 100}%` }}
                      title={`${s.label}: ${s.hours.toFixed(1)}h (${((s.hours / total) * 100).toFixed(0)}%)`}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                  {segments.map((s, i) => {
                    const key = `${rowUserId}::${s.accountId ?? i}`
                    const isExpanded = expanded.has(key)
                    const canExpand = !!s.accountId && s.breakdown.length > 0
                    return (
                      <button
                        key={i}
                        type="button"
                        disabled={!canExpand}
                        onClick={() => setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(key)) next.delete(key); else next.add(key)
                          return next
                        })}
                        className={cn(
                          'flex items-center gap-1 rounded px-1 -mx-1',
                          canExpand && 'hover:bg-gray-100 dark:hover:bg-gray-800',
                        )}
                      >
                        {canExpand && (isExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />)}
                        <span className={`h-1.5 w-2 rounded-sm ${s.color}`} />
                        {s.label}
                      </button>
                    )
                  })}
                </div>
                {segments.map((s, i) => {
                  const key = `${rowUserId}::${s.accountId ?? i}`
                  if (!expanded.has(key) || s.breakdown.length === 0) return null
                  return (
                    <div key={`bd-${i}`} className="mt-1 flex flex-col gap-1 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/50">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        {t('leader.concentration.breakdown_of', 'Makes up {{name}}', { name: s.label })}
                      </span>
                      {s.breakdown.map((b) => {
                        const Icon = BREAKDOWN_ICON[b.type]
                        return (
                          <div key={`${b.type}-${b.id}`} className="flex items-center justify-between gap-2 text-xs text-gray-700 dark:text-gray-300">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <Icon className="h-3 w-3 shrink-0 text-gray-400" />
                              <span className="truncate">{b.name ?? '—'}</span>
                              <span className="shrink-0 text-[10px] text-gray-400">{t(`sf.${b.type.toLowerCase()}` as const, b.type)}</span>
                            </span>
                            <span className="shrink-0 font-mono text-xs font-semibold">{b.hours.toFixed(1)}h</span>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
