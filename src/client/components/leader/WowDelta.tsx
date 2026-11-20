import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'

interface PerType { activityTypeName: string; current: number; prior: number; delta: number }
interface Resp { currentTotal: number; priorTotal: number; delta: number; pctDelta: number | null; perType: PerType[] }

function trendIcon(delta: number) {
  if (Math.abs(delta) < 0.5) return Minus
  return delta > 0 ? ArrowUp : ArrowDown
}
function trendColor(delta: number) {
  if (Math.abs(delta) < 0.5) return 'text-gray-500 dark:text-gray-400'
  return delta > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
}

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; compareMode?: CompareMode }

export function WowDelta({ teamId, weeksBack, productIds = [], userId, memberIds, compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<Resp | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorPeriodTotal, setPriorPeriodTotal] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Resp>(buildDashboardUrl('wow-delta', { teamId, weeksBack, productIds, userId, memberIds }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorPeriodTotal(null); return }
    api.get<Resp>(buildDashboardUrl('wow-delta', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode) }))
      .then((res) => setPriorPeriodTotal(res.data?.currentTotal ?? null))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />

  const TotalIcon = trendIcon(data.delta)

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.wow.headline', { weeks: weeksBack })}</p>
        <div className="mt-2 flex items-baseline gap-4">
          <span className="text-3xl font-semibold text-gray-900 dark:text-gray-100">{data.currentTotal.toFixed(1)}h</span>
          <span className={`flex items-center gap-1 text-lg font-medium ${trendColor(data.delta)}`}>
            <TotalIcon className="h-5 w-5" />
            {data.delta > 0 ? '+' : ''}{data.delta.toFixed(1)}h
            {data.pctDelta != null && <span className="text-sm">({data.pctDelta > 0 ? '+' : ''}{data.pctDelta.toFixed(0)}%)</span>}
          </span>
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('leader.wow.vs_prior', { hours: data.priorTotal.toFixed(1) })}</p>
        {compareMode !== 'off' && priorPeriodTotal !== null && (
          <div className="mt-2">
            <TrendChip current={data.currentTotal} prior={priorPeriodTotal} mode={compareMode} />
          </div>
        )}
      </div>

      {data.perType.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">{t('leader.wow.by_type')}</p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr><th className="pb-1">{t('leader.wow.type')}</th><th className="pb-1 text-right">{t('leader.wow.current')}</th><th className="pb-1 text-right">{t('leader.wow.prior')}</th><th className="pb-1 text-right">{t('leader.wow.delta')}</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {data.perType.map((r) => {
                const Icon = trendIcon(r.delta)
                return (
                  <tr key={r.activityTypeName}>
                    <td className="py-1.5 text-gray-700 dark:text-gray-300">{r.activityTypeName}</td>
                    <td className="py-1.5 text-right text-gray-700 dark:text-gray-300">{r.current.toFixed(1)}h</td>
                    <td className="py-1.5 text-right text-gray-500 dark:text-gray-400">{r.prior.toFixed(1)}h</td>
                    <td className={`py-1.5 text-right font-medium ${trendColor(r.delta)}`}>
                      <span className="inline-flex items-center gap-1"><Icon className="h-3 w-3" />{r.delta > 0 ? '+' : ''}{r.delta.toFixed(1)}h</span>
                    </td>
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
