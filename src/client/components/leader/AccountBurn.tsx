import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase, Building2, Layers, Boxes, ChevronRight, ChevronDown } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { TrendChip } from '../ui/trend-chip.js'
import { SfActivitiesModal } from '../salesforce/SfActivitiesModal.js'
import { cn } from '../../lib/utils.js'
import type { CompareMode } from '../../lib/period.js'
import { weekShiftFor, buildDashboardUrl } from '../../lib/dashboard-fetch.js'

interface OppBreakdown {
  oppId: string
  oppName: string | null
  totalHours: string
  activityCount: number
}

interface BurnRow {
  crmWhatId: string | null
  crmWhatName: string | null
  crmWhatType: 'Opportunity' | 'Account' | null
  totalHours: string
  activityCount: number
  rollupOppIds?: string[]
  // v1.117.0: per-Opp burn under this Account, only present on
  // rollup rows. Powers the expandable "Includes Opps" detail.
  oppBreakdown?: OppBreakdown[]
}

interface AccountBurnProps {
  teamId: string
  weeksBack?: number
  productIds?: string[]
  userId?: string | null
  memberIds?: string[]
  acv?: string[]
  stages?: string[]
  forecast?: string[]
  compareMode?: CompareMode
}

type BurnFilter = 'all' | 'Opportunity' | 'Account' | 'account_rollup'

export function AccountBurn({ teamId, weeksBack = 4, productIds = [], userId, memberIds, acv = [], stages = [], forecast = [], compareMode = 'off' }: AccountBurnProps) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<BurnRow[]>([])
  const [rollupRows, setRollupRows] = useState<BurnRow[]>([])
  const [priorTotal, setPriorTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [drillRow, setDrillRow] = useState<BurnRow | null>(null)
  const [filter, setFilter] = useState<BurnFilter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    setLoading(true)
    api.get<BurnRow[]>(buildDashboardUrl('burn', { teamId, weeksBack, productIds, userId, memberIds, extra: { acv: acv.length ? acv.join(',') : undefined, stages: stages.length ? stages.join(',') : undefined, forecast: forecast.length ? forecast.join(',') : undefined } }))
      .then((res) => { if (res.data) setRows(res.data) })
      .finally(() => setLoading(false))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), acv.join(','), stages.join(','), forecast.join(',')])

  // Lazy-fetch the rollup variant only when the toggle is active — it's
  // an extra query with a join against sf_object_owner_cache, so no point
  // running it unless the user asks for it.
  useEffect(() => {
    if (filter !== 'account_rollup') return
    api.get<BurnRow[]>(buildDashboardUrl('burn', { teamId, weeksBack, productIds, userId, memberIds, extra: { scope: 'account_rollup', acv: acv.length ? acv.join(',') : undefined, stages: stages.length ? stages.join(',') : undefined, forecast: forecast.length ? forecast.join(',') : undefined } }))
      .then((res) => { if (res.data) setRollupRows(res.data) })
  }, [filter, teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), acv.join(','), stages.join(','), forecast.join(',')])

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotal(null); return }
    api.get<BurnRow[]>(buildDashboardUrl('burn', { teamId, weeksBack, productIds, userId, memberIds, weekShift: weekShiftFor(compareMode), extra: { acv: acv.length ? acv.join(',') : undefined, stages: stages.length ? stages.join(',') : undefined, forecast: forecast.length ? forecast.join(',') : undefined } }))
      .then((res) => setPriorTotal((res.data ?? []).reduce((s, r) => s + Number(r.totalHours), 0)))
  }, [teamId, weeksBack, productIds.join(','), userId, memberIds?.join(','), compareMode, acv.join(','), stages.join(','), forecast.join(',')])

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('leader.empty')}</p>

  const filteredRows =
    filter === 'all' ? rows
    : filter === 'account_rollup' ? rollupRows
    : rows.filter((r) => r.crmWhatType === filter)
  const maxHours = Math.max(...filteredRows.map((r) => Number(r.totalHours)), 1)
  const totalHours = filteredRows.reduce((s, r) => s + Number(r.totalHours), 0)

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex overflow-hidden rounded border border-gray-200 dark:border-gray-600">
          {([
            { key: 'all' as const, icon: Layers, label: t('leader.burn_filter.all') },
            { key: 'Opportunity' as const, icon: Briefcase, label: t('leader.burn_filter.opportunity') },
            { key: 'Account' as const, icon: Building2, label: t('leader.burn_filter.account') },
            { key: 'account_rollup' as const, icon: Boxes, label: t('leader.burn_filter.account_rollup', 'Accounts (includes Opps)') },
          ]).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              title={label}
              aria-label={label}
              className={cn(
                'flex h-7 w-8 items-center justify-center transition-colors',
                filter === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
        {compareMode !== 'off' && priorTotal !== null && (
          <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <span>Total: {totalHours.toFixed(1)}h</span>
            <TrendChip current={totalHours} prior={priorTotal} mode={compareMode} />
          </div>
        )}
      </div>
      {filteredRows.map((row, i) => {
        const hrs = Number(row.totalHours)
        const pct = (hrs / totalHours) * 100
        const isConcentrated = pct > 30

        const clickable = !!(row.crmWhatId && row.crmWhatType)
        const hasBreakdown = filter === 'account_rollup' && (row.oppBreakdown?.length ?? 0) > 0
        const isExpanded = hasBreakdown && row.crmWhatId ? expanded.has(row.crmWhatId) : false
        const toggleExpand = (e: React.MouseEvent) => {
          e.stopPropagation()
          if (!row.crmWhatId) return
          setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(row.crmWhatId!)) next.delete(row.crmWhatId!); else next.add(row.crmWhatId!)
            return next
          })
        }
        return (
          <div key={row.crmWhatId ?? i} className={cn(
            'flex flex-col gap-1 rounded-lg border p-3 transition-colors',
            isConcentrated ? 'border-orange-200 bg-orange-50/50 dark:border-orange-800 dark:bg-orange-950/20' : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900',
          )}>
          <button
            type="button"
            onClick={() => clickable && setDrillRow(row)}
            disabled={!clickable}
            className={cn(
              'flex flex-col gap-1 text-left',
              clickable && 'cursor-pointer',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {hasBreakdown ? (
                  <span
                    role="button"
                    aria-label={isExpanded ? t('leader.burn.collapse', 'Collapse') : t('leader.burn.expand', 'Expand')}
                    title={isExpanded ? t('leader.burn.collapse', 'Collapse') : t('leader.burn.expand', 'Expand')}
                    onClick={toggleExpand}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                  >
                    {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </span>
                ) : (
                  <span className="h-5 w-5 shrink-0" />
                )}
                <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">
                  #{i + 1}
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {row.crmWhatName ?? 'Unknown'}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {row.crmWhatType && (
                  <Badge variant={row.crmWhatType === 'Opportunity' ? 'default' : 'secondary'}>
                    {t(`sf.${row.crmWhatType.toLowerCase()}` as const, row.crmWhatType)}
                  </Badge>
                )}
                {row.crmWhatType === 'Account' && filter !== 'account_rollup' && (
                  <Badge
                    variant="secondary"
                    title={t('leader.burn.scope_direct_hint', 'Only activities logged directly against this Account. Activities on Opportunities under it appear as their own rows.')}
                  >
                    {t('leader.burn.scope_direct', 'Direct only')}
                  </Badge>
                )}
                {row.crmWhatType === 'Account' && filter === 'account_rollup' && (
                  <Badge
                    variant="default"
                    title={t('leader.burn.scope_rollup_hint', 'Includes activities logged against this Account and every Opportunity under it.')}
                  >
                    {t('leader.burn.scope_rollup', 'Includes Opps')}
                  </Badge>
                )}
                {isConcentrated && (
                  <Badge variant="warning">High</Badge>
                )}
                <span className="text-sm font-semibold font-mono text-gray-900 dark:text-gray-100">
                  {hrs.toFixed(1)}h
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-full bg-gray-100 dark:bg-gray-800 h-1.5 overflow-hidden">
                <div
                  className={cn('h-full rounded-full', isConcentrated ? 'bg-orange-400 dark:bg-orange-500' : 'bg-blue-400 dark:bg-blue-500')}
                  style={{ width: `${(hrs / maxHours) * 100}%` }}
                />
              </div>
              <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                {t('leader.burn.activity_count', { count: row.activityCount, defaultValue: '{{count}} activities' })}
              </span>
            </div>
          </button>
          {isExpanded && row.oppBreakdown && row.oppBreakdown.length > 0 && (
            <div className="mt-2 flex flex-col gap-1 border-t border-gray-200 pt-2 dark:border-gray-700">
              {row.oppBreakdown.map((opp) => {
                const oppHrs = Number(opp.totalHours)
                return (
                  <button
                    key={opp.oppId}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setDrillRow({ crmWhatId: opp.oppId, crmWhatName: opp.oppName, crmWhatType: 'Opportunity', totalHours: opp.totalHours, activityCount: opp.activityCount }) }}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 pl-8 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Briefcase className="h-3 w-3 shrink-0 text-gray-400" />
                      <span className="truncate text-xs text-gray-700 dark:text-gray-300">{opp.oppName ?? '—'}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {t('leader.burn.activity_count_short', { count: opp.activityCount, defaultValue: '{{count}} acts' })}
                      </span>
                      <span className="font-mono text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {oppHrs.toFixed(1)}h
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          </div>
        )
      })}

      {drillRow && drillRow.crmWhatId && drillRow.crmWhatType && drillRow.crmWhatName && (() => {
        // Derive the current report window so the drawer defaults to
        // the filtered subset that matches the burn row's numbers.
        const end = new Date()
        const start = new Date()
        start.setDate(start.getDate() - weeksBack * 7)
        return (
          <SfActivitiesModal
            open={!!drillRow}
            onClose={() => setDrillRow(null)}
            teamId={teamId}
            whatId={drillRow.crmWhatId}
            whatType={drillRow.crmWhatType}
            whatName={drillRow.crmWhatName}
            rangeStart={start.toISOString()}
            rangeEnd={end.toISOString()}
            extraWhatIds={drillRow.rollupOppIds}
          />
        )
      })()}
    </div>
  )
}
