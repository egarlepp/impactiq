import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

interface Row { userId: string; displayName: string; avgLagDays: number; activityCount: number }

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; compareMode?: CompareMode }

export function LoggingLag({ teamId, weeksBack, productIds = [], userId, memberIds, compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorAvg, setPriorAvg] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Row[]>(buildDashboardUrl('logging-lag', { teamId, weeksBack, productIds, userId, memberIds }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorAvg(null); return }
    api.get<Row[]>(buildDashboardUrl('logging-lag', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode) }))
      .then((res) => {
        const rows = res.data ?? []
        setPriorAvg(rows.length === 0 ? 0 : rows.reduce((s, r) => s + r.avgLagDays, 0) / rows.length)
      })
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />
  if (data.length === 0) return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>

  const max = Math.max(...data.map((r) => r.avgLagDays), 1)

  function color(days: number) {
    if (days < 1) return 'bg-green-500'
    if (days < 3) return 'bg-yellow-500'
    if (days < 7) return 'bg-orange-500'
    return 'bg-red-500'
  }

  const currentAvg = data.length === 0 ? 0 : data.reduce((s, r) => s + r.avgLagDays, 0) / data.length

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.lag.hint')}</p>
        {compareMode !== 'off' && priorAvg !== null && (
          <span className="ml-auto flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"><span>avg {currentAvg.toFixed(1)}d</span><TrendChip current={currentAvg} prior={priorAvg} mode={compareMode} invertColors /></span>
        )}
      </div>
      <div className="grid grid-cols-[180px_1fr_120px] items-center gap-2">
        {data.map((r) => {
          const pct = (r.avgLagDays / max) * 100
          return (
            <div key={r.userId} className="contents">
              <span className="truncate text-xs text-gray-700 dark:text-gray-300">{r.displayName}</span>
              <div className="h-4 rounded bg-gray-100 dark:bg-gray-800">
                <div className={`h-full rounded ${color(r.avgLagDays)}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                {r.avgLagDays.toFixed(1)} {t('leader.lag.days')} <span className="text-gray-400">({r.activityCount})</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
