import { useEffect, useState, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api.js'
import { TrendChip } from '../ui/trend-chip.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'

interface TypeAgg { id: string; name: string; color: string | null; hours: number }
interface MemberAgg { userId: string; userName: string; hours: number; activityCount: number; byType: Record<string, number> }
interface Row {
  productId: string
  productName: string
  abbreviation: string | null
  totalHours: string
  activityCount: number
  byType?: TypeAgg[]
  members?: MemberAgg[]
  memberTotal?: number
  memberTruncated?: boolean
}
interface ApiPayload {
  products: Row[]
  unlinked: { totalHours: number; activityCount: number }
}

interface Props {
  teamId: string
  weeksBack: number
  productIds?: string[]
  userId?: string | null
  memberIds?: string[]
  compareMode?: CompareMode
}

const PALETTE = ['#6366F1', '#0EA5E9', '#10B981', '#8B5CF6', '#F59E0B', '#14B8A6', '#EC4899', '#F97316', '#EF4444', '#64748B']
const FALLBACK = '#94A3B8'

export function ProductsBreakdown({ teamId, weeksBack, productIds = [], userId, memberIds, compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<ApiPayload>({ products: [], unlinked: { totalHours: 0, activityCount: 0 } })
  const [priorTotal, setPriorTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    api.get<ApiPayload>(buildDashboardUrl('products-breakdown', { teamId, weeksBack, productIds, userId, memberIds })).then((res) => {
      setData(res.data ?? { products: [], unlinked: { totalHours: 0, activityCount: 0 } })
      setLoading(false)
    })
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotal(null); return }
    api.get<ApiPayload>(buildDashboardUrl('products-breakdown', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode) }))
      .then((res) => {
        const p = res.data?.products ?? []
        const u = res.data?.unlinked
        setPriorTotal(p.reduce((s, r) => s + Number(r.totalHours), 0) + Number(u?.totalHours ?? 0))
      })
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode])

  const linkedTotal = data.products.reduce((s, r) => s + Number(r.totalHours), 0)
  const total = linkedTotal + Number(data.unlinked.totalHours)

  // Build cross-product legend: union of activity types across all products,
  // sorted by total hours. Top 6 rendered; remainder collapse into "+N more".
  const legendMap = new Map<string, TypeAgg>()
  for (const p of data.products) {
    for (const ta of p.byType ?? []) {
      const cur = legendMap.get(ta.id) ?? { ...ta, hours: 0 }
      cur.hours += ta.hours
      legendMap.set(ta.id, cur)
    }
  }
  const legend = Array.from(legendMap.values()).sort((a, b) => b.hours - a.hours)
  const legendVisible = legend.slice(0, 6)
  const legendMore = legend.length - legendVisible.length

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t('leader.products_breakdown.title')}
        </h3>
        <span className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          {t('leader.products_breakdown.total', { hours: total.toFixed(1) })}
          {compareMode !== 'off' && priorTotal !== null && (
            <TrendChip current={total} prior={priorTotal} mode={compareMode} />
          )}
        </span>
      </div>

      {legendVisible.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-gray-600 dark:text-gray-400">
          {legendVisible.map((ta) => (
            <span key={ta.id} className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: ta.color ?? FALLBACK }} />
              {ta.name}
            </span>
          ))}
          {legendMore > 0 && (
            <span className="text-gray-500 dark:text-gray-500">
              {t('leader.products_breakdown.legend_more', { count: legendMore })}
            </span>
          )}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">…</p>
      ) : total === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('leader.products_breakdown.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.products.map((r, i) => {
            const hrs = Number(r.totalHours)
            const pct = total > 0 ? Math.round((hrs / total) * 100) : 0
            const color = PALETTE[i % PALETTE.length]
            const open = expanded === r.productId
            const hasDetail = (r.members?.length ?? 0) > 0
            return (
              <Fragment key={r.productId}>
                <li
                  className={`flex items-center gap-3 text-sm ${hasDetail ? 'cursor-pointer' : ''}`}
                  onClick={() => hasDetail && setExpanded(open ? null : r.productId)}
                >
                  <span className="inline-flex w-3 justify-center text-gray-400">
                    {hasDetail && (open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
                  </span>
                  <span className="w-72 truncate text-gray-800 dark:text-gray-200" title={r.productName}>
                    {r.productName}
                    {r.abbreviation && <span className="ml-1 text-[10px] text-gray-500 dark:text-gray-400">({r.abbreviation})</span>}
                  </span>
                  <SegmentedBar
                    total={total}
                    hours={hrs}
                    segments={r.byType ?? [{ id: r.productId, name: r.productName, color: color as string | null, hours: hrs }]}
                  />
                  <span className="w-24 shrink-0 text-right text-xs text-gray-700 dark:text-gray-300 tabular-nums">
                    {hrs.toFixed(1)}h · {pct}%
                  </span>
                  <span className="w-16 shrink-0 text-right text-[10px] text-gray-400 tabular-nums">
                    {r.activityCount} {t('leader.products_breakdown.acts_short')}
                  </span>
                </li>
                {open && r.members && r.members.length > 0 && (
                  <li className="ml-8 rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950">
                    <table className="w-full text-xs">
                      <thead className="text-left text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        <tr>
                          <th className="px-2 py-1">{t('leader.products_breakdown.col_member', 'Member')}</th>
                          <th className="px-2 py-1 text-right">{t('leader.products_breakdown.col_hours', 'Hours')}</th>
                          <th className="px-2 py-1 text-right">{t('leader.products_breakdown.col_activities', 'Activities')}</th>
                          <th className="px-2 py-1">{t('leader.products_breakdown.col_mix', 'Mix')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.members.map((m) => (
                          <tr key={m.userId} className="border-t border-gray-200 dark:border-gray-800">
                            <td className="px-2 py-1 text-gray-800 dark:text-gray-200">{m.userName}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{m.hours.toFixed(1)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{m.activityCount}</td>
                            <td className="px-2 py-1 w-40">
                              <SegmentedBar
                                total={m.hours}
                                hours={m.hours}
                                segments={(r.byType ?? []).map((ta) => ({
                                  id: ta.id, name: ta.name, color: ta.color, hours: m.byType[ta.id] ?? 0,
                                }))}
                                thin
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {r.memberTruncated && (
                      <p className="px-2 pt-1 text-[10px] text-gray-500 dark:text-gray-400">
                        {t('leader.products_breakdown.members_truncated', 'Showing top {{n}} of {{total}} members', { n: r.members.length, total: r.memberTotal })}
                      </p>
                    )}
                  </li>
                )}
              </Fragment>
            )
          })}
          {data.unlinked.totalHours > 0 && (
            <li className="flex items-center gap-3 text-sm">
              <span className="inline-block w-3" />
              <span className="w-72 truncate italic text-gray-500 dark:text-gray-400">
                {t('leader.products_breakdown.unlinked')}
              </span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div className="absolute inset-y-0 left-0 bg-gray-300 dark:bg-gray-600" style={{ width: `${(Number(data.unlinked.totalHours) / total) * 100}%` }} />
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                {Number(data.unlinked.totalHours).toFixed(1)}h · {Math.round((Number(data.unlinked.totalHours) / total) * 100)}%
              </span>
              <span className="w-16 shrink-0 text-right text-[10px] text-gray-400 tabular-nums">
                {data.unlinked.activityCount}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

// Segmented bar: total is the reference max (so bars are comparable across
// rows), hours is this row's actual total (bar length), segments are the
// per-activity-type slices summing to hours.
function SegmentedBar({ total, hours, segments, thin = false }: { total: number; hours: number; segments: { id: string; name: string; color: string | null; hours: number }[]; thin?: boolean }) {
  const barPct = total > 0 ? (hours / total) * 100 : 0
  const filtered = segments.filter((s) => s.hours > 0).sort((a, b) => b.hours - a.hours)
  const sum = filtered.reduce((s, x) => s + x.hours, 0) || 1
  return (
    <div className={`relative flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800 ${thin ? 'h-1.5' : 'h-2'}`}>
      <div className="absolute inset-y-0 left-0 flex" style={{ width: `${barPct}%` }}>
        {filtered.map((s) => (
          <div
            key={s.id}
            title={`${s.name}: ${s.hours.toFixed(1)}h`}
            style={{ width: `${(s.hours / sum) * 100}%`, backgroundColor: s.color ?? FALLBACK }}
          />
        ))}
      </div>
    </div>
  )
}
