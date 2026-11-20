import { useEffect, useState, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Briefcase, Building2, Flame, ThermometerSun } from 'lucide-react'
import { Chip } from '../ui/chip.js'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { cn } from '../../lib/utils.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'

interface UserBreakdown {
  userId: string
  userName: string
  hours: number
  currency: string | null
  ratePerHour: number | null
  localCost: number
  costUsd: number
  directCostsUsd: number
  fxRatePerUsd: number | null
  fxAsOf: string | null
  fxMissing: boolean
}

interface Row {
  id: string
  name: string | null
  hours: string
  costDollars: string      // labor only, always USD from the server
  directCostsUsd: string   // direct/travel costs, always USD
  acv: string | null       // opp mode only
  activityCount: number
  numOpportunities: number | null   // account mode only
  avgCostPerOpp: number | null      // account mode only, USD
  costPerAcvPct: number | null      // opp mode only
  breakdown: UserBreakdown[]
}

type GroupBy = 'opp' | 'account'

interface Props { teamId: string; weeksBack: number; userId?: string | null; memberIds?: string[]; acv?: string[]; stages?: string[]; forecast?: string[]; productIds?: string[] }

const HIGH_COST_PCT = 10

// Symbol lookup for the most common currencies; unknown ones fall back
// to the ISO code prefixed to the number so the header still shows what
// currency the values are in.
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', AUD: 'A$', CAD: 'C$',
  CHF: 'Fr.', HKD: 'HK$', SGD: 'S$', KRW: '₩', INR: '₹', MXN: 'Mex$',
  BRL: 'R$', TWD: 'NT$', ZAR: 'R', AED: 'د.إ', SAR: '﷼',
}

function fmtCurrency(n: number, currency: string): string {
  try {
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'JPY' || currency === 'KRW' ? 0 : 0,
    })
  } catch {
    const sym = CURRENCY_SYMBOL[currency] ?? currency + ' '
    return `${sym}${Math.round(n).toLocaleString('en-US')}`
  }
}

// TODO(table-controls): sort/search would need to interleave with the
// Fragment-based expandable FX breakdown rows AND the heat-rank precompute
// that iterates the full dataset — both are load-bearing and would push
// this component >50 LOC of shim code. Deferred.
export function CostPerAcv({ teamId, weeksBack, userId, memberIds, acv = [], stages = [], forecast = [], productIds = [] }: Props) {
  const { t } = useTranslation()
  const [groupBy, setGroupBy] = useState<GroupBy>('opp')
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  // Display currency comes from the shared page-level "Show Costs In"
  // selector in the dashboard header (seeded from My Settings).
  const { currency: displayCurrency, toDisplay, missing } = useDisplayCurrency()
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setData(null)
      const res = await api.get<Row[]>(buildDashboardUrl('revenue/cost-per-acv', { teamId, weeksBack, userId, memberIds, productIds, extra: { groupBy, acv: acv.length ? acv.join(',') : undefined, stages: stages.length ? stages.join(',') : undefined, forecast: forecast.length ? forecast.join(',') : undefined, displayCurrency: displayCurrency !== 'USD' ? displayCurrency : undefined } }))
      setData(res.data ?? null)
      setLoading(false)
    })()
  }, [teamId, weeksBack, userId, memberIds?.join(','), groupBy, acv.join(','), stages.join(','), forecast.join(','), productIds.join(','), displayCurrency])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-gray-600 dark:text-gray-400">{t('leader.cost_per_acv.description')}</p>

        {groupBy === 'opp' && (
          <div className="inline-flex items-center gap-1.5">
            <span className="text-xs text-gray-500 dark:text-gray-400">{t('leader.cost_per_acv.heat_legend_label', 'Legend:')}</span>
            <Chip
              size="xs"
              variant="danger"
              icon={Flame}
              title={t('leader.cost_per_acv.heat_hot_hint', 'Top 10% by cost — highest-burn opportunities')}
            >
              {t('leader.cost_per_acv.heat_hot', 'Hot')}
            </Chip>
            <Chip
              size="xs"
              variant="warning"
              icon={ThermometerSun}
              title={t('leader.cost_per_acv.heat_warm_hint', 'Next 20% by cost — moderate-burn opportunities')}
            >
              {t('leader.cost_per_acv.heat_warm', 'Warm')}
            </Chip>
          </div>
        )}

        <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-xs">
          {(['opp', 'account'] as GroupBy[]).map((g) => {
            const Icon = g === 'opp' ? Briefcase : Building2
            return (
              <button
                key={g}
                type="button"
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1',
                  groupBy === g ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' : 'text-gray-600 dark:text-gray-400',
                )}
                onClick={() => setGroupBy(g)}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(`leader.cost_per_acv.group_${g}`)}
              </button>
            )
          })}
        </div>
      </div>

      {missing && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {t('leader.cost_per_acv.fx_missing', 'No FX rate cached for {{cur}}. Displaying USD. Refresh in Admin → Cost Groups → FX rates.', { cur: displayCurrency })}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
      ) : !data ? (
        <DashboardEmptyState />
      ) : data.length === 0 ? (
        <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">
                  {groupBy === 'opp'
                    ? t('leader.cost_per_acv.col_opp_name', 'Opportunity Name')
                    : t('leader.cost_per_acv.col_account_name', 'Account Name')}
                </th>
                {groupBy === 'opp' ? (
                  <th className="px-3 py-2 text-right">{t('leader.cost_per_acv.col_acv')}</th>
                ) : (
                  <th className="px-3 py-2 text-right">{t('leader.cost_per_acv.col_num_opps', '# of Opportunities')}</th>
                )}
                <th className="px-3 py-2 text-right">{t('leader.cost_per_acv.col_hours')}</th>
                <th className="px-3 py-2 text-right">
                  {t('leader.cost_per_acv.col_direct_costs', 'Direct Costs')}
                  <span className="ml-1 font-normal normal-case text-gray-400">({displayCurrency})</span>
                </th>
                <th className="px-3 py-2 text-right">
                  {t('leader.cost_per_acv.col_cost')}
                  <span className="ml-1 font-normal normal-case text-gray-400">({displayCurrency})</span>
                </th>
                {groupBy === 'opp' ? (
                  <th className="px-3 py-2 text-right">{t('leader.cost_per_acv.col_pct')}</th>
                ) : (
                  <th className="px-3 py-2 text-right">
                    {t('leader.cost_per_acv.col_avg_cost_per_opp', 'Avg Cost / Opp')}
                    <span className="ml-1 font-normal normal-case text-gray-400">({displayCurrency})</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Precompute cost percentile ranks (opp mode only) so the top
                // 10% get a "hot" chip and the next 20% get "warm". Sorted
                // descending by USD cost. Cutoffs use ceil so short lists
                // still get at least one hot and one warm — otherwise a
                // 6-row table's top opportunity never clears 10%.
                const rankByRowId = new Map<string, 'hot' | 'warm' | null>()
                if (groupBy === 'opp') {
                  const sorted = [...data].sort((a, b) => (Number(b.costDollars) + Number(b.directCostsUsd)) - (Number(a.costDollars) + Number(a.directCostsUsd)))
                  const total = sorted.length
                  const hotCutoff = total > 0 ? Math.max(1, Math.ceil(total * 0.1)) : 0
                  const warmCutoff = total > 0 ? Math.max(hotCutoff + 1, Math.ceil(total * 0.3)) : 0
                  sorted.forEach((row, idx) => {
                    const rank = idx + 1
                    if (rank <= hotCutoff) rankByRowId.set(row.id, 'hot')
                    else if (rank <= warmCutoff) rankByRowId.set(row.id, 'warm')
                    else rankByRowId.set(row.id, null)
                  })
                }
                return data.map((r) => {
                const pct = r.costPerAcvPct
                const flag = pct !== null && pct > HIGH_COST_PCT
                const directUsd = Number(r.directCostsUsd)
                // TCE = labor (costDollars) + direct/travel costs.
                const usdCost = Number(r.costDollars) + directUsd
                const displayCost = toDisplay(usdCost)
                const heat = groupBy === 'opp' ? rankByRowId.get(r.id) ?? null : null
                return (
                  <Fragment key={r.id}>
                    <tr
                      className={cn(
                        'border-b border-gray-100 dark:border-gray-900 last:border-b-0',
                        flag && 'bg-amber-50 dark:bg-amber-950/30',
                      )}
                    >
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-2">
                          {r.name ?? '—'}
                          {heat === 'hot' && (
                            <Chip
                              size="xs"
                              variant="danger"
                              icon={Flame}
                              title={t('leader.cost_per_acv.heat_hot_hint', 'Top 10% by cost — highest-burn opportunities')}
                            >
                              {t('leader.cost_per_acv.heat_hot', 'Hot')}
                            </Chip>
                          )}
                          {heat === 'warm' && (
                            <Chip
                              size="xs"
                              variant="warning"
                              icon={ThermometerSun}
                              title={t('leader.cost_per_acv.heat_warm_hint', 'Next 20% by cost — moderate-burn opportunities')}
                            >
                              {t('leader.cost_per_acv.heat_warm', 'Warm')}
                            </Chip>
                          )}
                        </span>
                      </td>
                      {groupBy === 'opp' ? (
                        <td className="px-3 py-2 text-right tabular-nums">{r.acv ? fmtCurrency(toDisplay(Number(r.acv)), displayCurrency) : '—'}</td>
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">{r.numOpportunities ?? 0}</td>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.hours).toFixed(1)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {directUsd > 0 ? fmtCurrency(toDisplay(directUsd), displayCurrency) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          {fmtCurrency(displayCost, displayCurrency)}
                          <button
                            type="button"
                            title={t('leader.cost_per_acv.breakdown_hint', 'Show per-user FX breakdown')}
                            onClick={() => setExpandedRow(expandedRow === r.id ? null : r.id)}
                            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </td>
                      {groupBy === 'opp' ? (
                        <td className={cn('px-3 py-2 text-right tabular-nums', flag && 'font-semibold text-amber-700 dark:text-amber-400')}>
                          {pct === null ? '—' : `${pct.toFixed(1)}%`}
                        </td>
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.avgCostPerOpp != null && r.avgCostPerOpp > 0 ? fmtCurrency(toDisplay(r.avgCostPerOpp), displayCurrency) : '—'}
                        </td>
                      )}
                    </tr>
                    {expandedRow === r.id && (
                      <tr className="bg-gray-50/60 dark:bg-gray-900/40">
                        <td colSpan={6} className="px-3 py-2">
                          <p className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
                            {t('leader.cost_per_acv.breakdown_title', 'FX + rate breakdown by contributor')}
                          </p>
                          <table className="w-full text-xs">
                            <thead className="text-gray-500 dark:text-gray-400">
                              <tr>
                                <th className="px-2 py-1 text-left">{t('leader.cost_per_acv.b_user', 'User')}</th>
                                <th className="px-2 py-1 text-right">{t('leader.cost_per_acv.b_hours', 'Hours')}</th>
                                <th className="px-2 py-1 text-right">{t('leader.cost_per_acv.b_currency', 'Currency')}</th>
                                <th className="px-2 py-1 text-right">{t('leader.cost_per_acv.b_rate', 'Rate / hr')}</th>
                                <th className="px-2 py-1 text-right">{t('leader.cost_per_acv.b_local', 'Local cost')}</th>
                                <th className="px-2 py-1 text-right">{t('leader.cost_per_acv.b_fx', 'FX (per USD)')}</th>
                                <th className="px-2 py-1 text-right">{t('leader.cost_per_acv.b_direct', 'Direct')}</th>
                                <th className="px-2 py-1 text-right">USD</th>
                                <th className="px-2 py-1 text-right">{displayCurrency}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.breakdown.map((b) => (
                                <tr key={b.userId} className="border-t border-gray-100 dark:border-gray-800">
                                  <td className="px-2 py-1">{b.userName}</td>
                                  <td className="px-2 py-1 text-right tabular-nums">{b.hours.toFixed(1)}</td>
                                  <td className="px-2 py-1 text-right font-mono">{b.currency ?? '—'}</td>
                                  <td className="px-2 py-1 text-right tabular-nums">{b.ratePerHour != null && b.currency ? fmtCurrency(b.ratePerHour, b.currency) : '—'}</td>
                                  <td className="px-2 py-1 text-right tabular-nums">{b.currency ? fmtCurrency(b.localCost, b.currency) : '—'}</td>
                                  <td className="px-2 py-1 text-right tabular-nums" title={b.fxAsOf ? t('leader.cost_per_acv.fx_as_of', 'Rate as of {{d}}', { d: b.fxAsOf }) : undefined}>
                                    {b.currency === 'USD'
                                      ? '1.0000'
                                      : (b.fxRatePerUsd != null
                                          ? b.fxRatePerUsd.toFixed(4)
                                          : (b.fxMissing ? t('leader.cost_per_acv.fx_missing_short', 'missing') : '—'))}
                                  </td>
                                  <td className="px-2 py-1 text-right tabular-nums">{b.directCostsUsd > 0 ? fmtCurrency(toDisplay(b.directCostsUsd), displayCurrency) : '—'}</td>
                                  <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(b.costUsd + b.directCostsUsd, 'USD')}</td>
                                  <td className="px-2 py-1 text-right tabular-nums font-medium">{fmtCurrency(toDisplay(b.costUsd + b.directCostsUsd), displayCurrency)}</td>
                                </tr>
                              ))}
                              <tr className="border-t border-gray-200 dark:border-gray-700 font-semibold">
                                <td className="px-2 py-1" colSpan={7}>{t('leader.cost_per_acv.b_total', 'Total')}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(usdCost, 'USD')}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(displayCost, displayCurrency)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
                })
              })()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
