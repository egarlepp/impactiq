import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { TrendChip } from '../ui/trend-chip.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

interface Row {
  activityTypeName: string
  actualHours: number
  activityCount: number
  typicalMinutes: number | null
  estimatedHours: number | null
}

interface Props { teamId: string; weeksBack: number; productIds?: string[]; userId?: string | null; memberIds?: string[]; compareMode?: CompareMode }

export function PlanVsActual({ teamId, weeksBack, productIds = [], userId, memberIds, compareMode = 'off' }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [priorTotal, setPriorTotal] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Row[]>(buildDashboardUrl('plan-vs-actual', { teamId, weeksBack, productIds, userId, memberIds }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotal(null); return }
    api.get<Row[]>(buildDashboardUrl('plan-vs-actual', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode) }))
      .then((res) => setPriorTotal((res.data ?? []).reduce((s, r) => s + Number(r.actualHours), 0)))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <DashboardEmptyState />
  if (data.length === 0) return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>

  const max = Math.max(...data.flatMap((r) => [r.actualHours, r.estimatedHours ?? 0]), 1)

  const currentTotal = data.reduce((s, r) => s + r.actualHours, 0)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('leader.plan_vs_actual.hint')}</p>
        {compareMode !== 'off' && priorTotal !== null && (
          <span className="ml-auto flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"><span>{t('leader.plan_vs_actual.total', { hours: currentTotal.toFixed(1), defaultValue: 'Total: {{hours}}h' })}</span><TrendChip current={currentTotal} prior={priorTotal} mode={compareMode} /></span>
        )}
      </div>
      <div className="grid grid-cols-[140px_1fr_140px] items-center gap-2">
        {data.map((r) => {
          const actualPct = (r.actualHours / max) * 100
          const estPct = r.estimatedHours != null ? (r.estimatedHours / max) * 100 : 0
          const variance = r.estimatedHours != null && r.estimatedHours > 0 ? ((r.actualHours - r.estimatedHours) / r.estimatedHours) * 100 : null
          const varianceColor = variance == null ? 'text-gray-400' : Math.abs(variance) < 15 ? 'text-gray-500 dark:text-gray-400' : variance > 0 ? 'text-orange-600 dark:text-orange-400' : 'text-blue-600 dark:text-blue-400'
          return (
            <div key={r.activityTypeName} className="contents">
              <span className="truncate text-xs text-gray-700 dark:text-gray-300">{r.activityTypeName}</span>
              <div className="flex flex-col gap-0.5">
                <div className="relative h-3 rounded bg-gray-100 dark:bg-gray-800" title={t('leader.plan_vs_actual.actual_tooltip', { hours: r.actualHours.toFixed(1), defaultValue: 'Actual: {{hours}}h' })}>
                  <div className="h-full rounded bg-blue-500" style={{ width: `${actualPct}%` }} />
                </div>
                <div className="relative h-3 rounded bg-gray-100 dark:bg-gray-800" title={r.estimatedHours != null ? t('leader.plan_vs_actual.estimated_tooltip', { hours: r.estimatedHours.toFixed(1), defaultValue: 'Estimated: {{hours}}h' }) : t('leader.plan_vs_actual.no_duration_tooltip', 'No typical duration set')}>
                  {r.estimatedHours != null && <div className="h-full rounded bg-orange-400" style={{ width: `${estPct}%` }} />}
                </div>
              </div>
              <span className={`text-right text-xs font-medium ${varianceColor}`}>
                {variance == null ? <span className="text-gray-400">—</span> : `${variance > 0 ? '+' : ''}${variance.toFixed(0)}%`}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-gray-600 dark:text-gray-300">
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-blue-500" />{t('leader.plan_vs_actual.actual')}</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-orange-400" />{t('leader.plan_vs_actual.estimated')}</span>
      </div>
    </div>
  )
}
