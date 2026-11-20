import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Briefcase, Megaphone, UserPlus } from 'lucide-react'
import { api } from '../../lib/api.js'
import { dashDateParams } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { cn } from '../../lib/utils.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'
import { useCrmFeatures } from '../../store/crmFeatures.js'

type Scope = 'account' | 'opp' | 'campaign' | 'lead'

interface Row { id: string; name: string | null; cost: number; activityCount: number; uniqueContributors: number }

interface Props { weeksBack: number; stages?: string[]; forecast?: string[]; acv?: string[]; productIds?: string[]; memberIds?: string[] }

export function MostExpensive({ weeksBack, stages = [], forecast = [], acv = [], productIds = [], memberIds = [] }: Props) {
  const { t } = useTranslation()
  const { fmt: fmtCurrency, currency } = useDisplayCurrency()
  const { campaignsEnabled, leadsEnabled } = useCrmFeatures()
  const [scope, setScope] = useState<Scope>('account')
  useEffect(() => {
    if ((!campaignsEnabled && scope === 'campaign') || (!leadsEnabled && scope === 'lead')) setScope('account')
  }, [campaignsEnabled, leadsEnabled, scope])
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setRows(null)
    const qs = new URLSearchParams({ scope, weeks: String(weeksBack) })
    if (stages.length > 0) qs.set('stages', stages.join(','))
    if (forecast.length > 0) qs.set('forecast', forecast.join(','))
    if (acv.length > 0) qs.set('acv', acv.join(','))
    if (productIds.length > 0) qs.set('productIds', productIds.join(','))
    if (memberIds.length > 0) qs.set('userIds', memberIds.join(','))
    if (currency !== 'USD') qs.set('displayCurrency', currency)
    for (const [k, v] of Object.entries(dashDateParams())) qs.set(k, v)
    api.get<Row[]>(`/api/dashboards/most-expensive?${qs.toString()}`)
      .then((res) => setRows(res.data ?? null))
      .finally(() => setLoading(false))
  }, [scope, weeksBack, stages.join(','), forecast.join(','), acv.join(','), productIds.join(','), memberIds.join(','), currency])

  const options: Array<{ key: Scope; icon: typeof Building2; label: string }> = [
    { key: 'account', icon: Building2, label: t('leader.most_expensive.scope_account', 'Accounts') },
    { key: 'opp', icon: Briefcase, label: t('leader.most_expensive.scope_opp', 'Opportunities') },
    // Campaigns / Leads are hidden when switched off app-wide.
    ...(campaignsEnabled ? [{ key: 'campaign' as const, icon: Megaphone, label: t('leader.most_expensive.scope_campaign', 'Campaigns') }] : []),
    ...(leadsEnabled ? [{ key: 'lead' as const, icon: UserPlus, label: t('leader.most_expensive.scope_lead', 'Leads') }] : []),
  ]

  const maxCost = rows && rows.length > 0 ? Math.max(...rows.map((r) => r.cost), 1) : 1

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('leader.most_expensive.description', 'Top 25 by cost of effort. Account view rolls up child Opp + converted-Lead activity cost.')}
        </p>
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
                scope === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>}
      {!loading && rows === null && <DashboardEmptyState />}
      {rows && rows.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
          {t('leader.empty', 'No data in this period.')}
        </p>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t('leader.most_expensive.chart_title', 'Top 10 by cost')}
            </p>
            <div className="space-y-1.5">
              {rows.slice(0, 10).map((r) => {
                const pct = (r.cost / maxCost) * 100
                return (
                  <div key={r.id} className="flex items-center gap-2 text-xs">
                    <span className="w-40 truncate text-gray-700 dark:text-gray-200" title={r.name ?? r.id}>
                      {r.name ?? r.id}
                    </span>
                    <div className="relative h-3 flex-1 rounded bg-gray-100 dark:bg-gray-800">
                      <div className="absolute inset-y-0 left-0 rounded bg-rose-500" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-20 text-right tabular-nums text-gray-700 dark:text-gray-200">{fmtCurrency(r.cost)}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">{t('leader.most_expensive.col_name', 'Name')}</th>
                  <th className="px-3 py-2 text-center">{t('leader.most_expensive.col_cost', 'Cost')}</th>
                  <th className="px-3 py-2 text-center">{t('leader.most_expensive.col_activities', 'Activities')}</th>
                  <th className="px-3 py-2 text-center">{t('leader.most_expensive.col_contributors', 'Contributors')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
                    <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{r.name ?? r.id}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmtCurrency(r.cost)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{r.activityCount}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{r.uniqueContributors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
