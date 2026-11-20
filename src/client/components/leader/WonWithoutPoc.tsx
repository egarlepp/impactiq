import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, AlertCircle, Plug } from 'lucide-react'
import { api } from '../../lib/api.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { cn } from '../../lib/utils.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'

// Must match subteamAttribution.ts's UNASSIGNED_SUBTEAM_ID on the server.
const UNASSIGNED_KEY = '__unassigned__'

interface OppLeaf { oppId: string; oppName: string; acv: number; activityCount: number; countByType: Record<string, number> }
interface UserNode { userId: string; displayName: string; totalAcv: number; totalActivityCount: number; countByType: Record<string, number>; opps: OppLeaf[] }
interface SubteamNode { subteamKey: string; subteamName: string; totalAcv: number; totalActivityCount: number; countByType: Record<string, number>; users: UserNode[] }
interface ActivityTypeMeta { id: string; name: string; color: string | null; icon: string | null }

interface Props {
  teamId: string
  weeksBack: number
  productIds?: string[]
  memberIds?: string[]
  stages?: string[]
  forecast?: string[]
  acv?: string[]
}

// v1.268.0 — Batch 7: Closed-Won Opportunities with ImpactIQ activity but no
// linked Evaluation (POC) record in Salesforce. See dashboards.ts's
// /won-without-poc for the full data-flow writeup (live SF check, "the POC
// object" resolved from team config rather than hardcoded).
export function WonWithoutPoc({ teamId, weeksBack, productIds = [], memberIds, stages = [], forecast = [], acv = [] }: Props) {
  const { t } = useTranslation()
  const { fmt: fmtCurrency, currency } = useDisplayCurrency()
  const [subteams, setSubteams] = useState<SubteamNode[] | null>(null)
  const [activityTypes, setActivityTypes] = useState<ActivityTypeMeta[]>([])
  const [configured, setConfigured] = useState(true)
  const [sfConnected, setSfConnected] = useState(true)
  const [sfError, setSfError] = useState<string | null>(null)
  // v1.388.0: where the POC check reads from: the CRM's Evaluation object, or
  // CriteriaIQ when it's the primary Project source.
  const [pocSource, setPocSource] = useState<'crm' | 'criteriaiq'>('crm')
  const [criteriaiqError, setCriteriaiqError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedSubteams, setExpandedSubteams] = useState<Set<string>>(new Set())
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set())

  const isAllTeams = !teamId || teamId === 'all'

  useEffect(() => {
    if (isAllTeams) { setSubteams(null); setLoading(false); return }
    setLoading(true)
    const url = buildDashboardUrl('won-without-poc', {
      teamId,
      weeksBack,
      productIds,
      memberIds,
      extra: {
        stages: stages.join(','),
        forecast: forecast.join(','),
        acv: acv.join(','),
        displayCurrency: currency !== 'USD' ? currency : undefined,
      },
    })
    void api.get<SubteamNode[]>(url).then((res) => {
      const meta = res.meta as { configured?: boolean; sfConnected?: boolean; sfError?: string; pocSource?: 'crm' | 'criteriaiq'; criteriaiqError?: string; activityTypes?: ActivityTypeMeta[] } | undefined
      setSubteams(res.data ?? [])
      setConfigured(meta?.configured ?? true)
      setSfConnected(meta?.sfConnected ?? true)
      setSfError(meta?.sfError ?? null)
      setPocSource(meta?.pocSource ?? 'crm')
      setCriteriaiqError(meta?.criteriaiqError ?? null)
      setActivityTypes(meta?.activityTypes ?? [])
      setExpandedSubteams(new Set())
      setExpandedUsers(new Set())
    }).finally(() => setLoading(false))
  }, [teamId, weeksBack, productIds.join(','), memberIds?.join(','), stages.join(','), forecast.join(','), acv.join(','), currency, isAllTeams])

  function toggleSubteam(key: string) {
    setExpandedSubteams((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }
  function toggleUser(key: string) {
    setExpandedUsers((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const displayName = (subteamKey: string, name: string): string =>
    subteamKey === UNASSIGNED_KEY ? t('leader.team_activity_deep_dive.unassigned', 'Unassigned') : name

  const fmtNum = (n: number) => n.toFixed(0)

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {pocSource === 'criteriaiq'
          ? t('leader.won_without_poc.description_criteriaiq')
          : t('leader.won_without_poc.description', 'Closed-Won Opportunities with ImpactIQ activity logged, but no linked Evaluation (POC) record found in Salesforce.')}
      </p>

      {isAllTeams && <DashboardEmptyState reason="select_team" />}

      {!isAllTeams && loading && <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>}

      {!isAllTeams && !loading && !configured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{pocSource === 'criteriaiq'
            ? t('leader.won_without_poc.not_configured_criteriaiq')
            : t('leader.won_without_poc.not_configured', 'This team has no Activity Type configured with a Salesforce related-object picker for the Evaluation (POC) object yet. Set one up under Admin → Activity Types to use this report.')}</span>
        </div>
      )}

      {!isAllTeams && !loading && configured && !sfConnected && (
        <div className="flex items-start gap-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          <Plug className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('leader.won_without_poc.not_connected', 'Connect your Salesforce account to see this report — it needs a live read of the Evaluation object to know for certain whether an Opportunity has one.')}</span>
        </div>
      )}

      {!isAllTeams && !loading && configured && sfConnected && sfError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('leader.won_without_poc.query_failed', 'The Salesforce query failed: {{error}}', { error: sfError })}</span>
        </div>
      )}

      {!isAllTeams && !loading && configured && criteriaiqError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('leader.won_without_poc.criteriaiq_failed', { error: t(criteriaiqError) })}</span>
        </div>
      )}

      {!isAllTeams && !loading && configured && sfConnected && !sfError && !criteriaiqError && subteams && subteams.length === 0 && (
        <DashboardEmptyState />
      )}

      {!isAllTeams && !loading && configured && sfConnected && !sfError && !criteriaiqError && subteams && subteams.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">{t('leader.won_without_poc.col_name', 'Subteam / User / Opportunity')}</th>
                <th className="px-3 py-2 text-center">{t('leader.won_without_poc.col_acv', 'ACV')}</th>
                <th className="px-3 py-2 text-center">{t('leader.won_without_poc.col_activity_count', 'Activity Count')}</th>
                {activityTypes.map((at) => (
                  <th key={at.id} className="px-3 py-2 text-center">
                    <span className="inline-flex items-center gap-1">
                      {at.icon && <DynamicIcon name={at.icon} className="h-3.5 w-3.5" style={{ color: at.color ?? undefined }} />}
                      {at.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subteams.map((sub) => {
                const subOpen = expandedSubteams.has(sub.subteamKey)
                return (
                  <Fragment key={sub.subteamKey}>
                    <tr className="border-b border-gray-100 dark:border-gray-900">
                      <td className="px-3 py-2 font-semibold" style={{ paddingLeft: 12 }}>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => toggleSubteam(sub.subteamKey)}
                            aria-label={subOpen ? t('leader.team_activity_deep_dive.collapse_row', 'Collapse') : t('leader.team_activity_deep_dive.expand_row', 'Expand')}
                            aria-expanded={subOpen}
                            className="flex h-4 w-4 shrink-0 items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                          >
                            {subOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                          <span className="truncate">{displayName(sub.subteamKey, sub.subteamName)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">{sub.totalAcv > 0 ? fmtCurrency(sub.totalAcv) : '—'}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{fmtNum(sub.totalActivityCount)}</td>
                      {activityTypes.map((at) => (
                        <td key={at.id} className="px-3 py-2 text-center tabular-nums">{sub.countByType[at.name] ?? 0}</td>
                      ))}
                    </tr>
                    {subOpen && sub.users.map((u) => {
                      const userKey = `${sub.subteamKey}::${u.userId}`
                      const userOpen = expandedUsers.has(userKey)
                      return (
                        <Fragment key={userKey}>
                          <tr className="border-b border-gray-100 dark:border-gray-900">
                            <td className="px-3 py-2" style={{ paddingLeft: 32 }}>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => toggleUser(userKey)}
                                  aria-label={userOpen ? t('leader.team_activity_deep_dive.collapse_row', 'Collapse') : t('leader.team_activity_deep_dive.expand_row', 'Expand')}
                                  aria-expanded={userOpen}
                                  className="flex h-4 w-4 shrink-0 items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                                >
                                  {userOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                </button>
                                <span className="truncate">{u.displayName}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-center tabular-nums">{u.totalAcv > 0 ? fmtCurrency(u.totalAcv) : '—'}</td>
                            <td className="px-3 py-2 text-center tabular-nums">{fmtNum(u.totalActivityCount)}</td>
                            {activityTypes.map((at) => (
                              <td key={at.id} className="px-3 py-2 text-center tabular-nums">{u.countByType[at.name] ?? 0}</td>
                            ))}
                          </tr>
                          {userOpen && u.opps.map((o) => (
                            <tr key={`${userKey}::${o.oppId}`} className="border-b border-gray-100 last:border-b-0 dark:border-gray-900">
                              <td className={cn('px-3 py-2 text-gray-600 dark:text-gray-400')} style={{ paddingLeft: 52 }}>
                                <span className="truncate">{o.oppName}</span>
                              </td>
                              <td className="px-3 py-2 text-center tabular-nums text-gray-600 dark:text-gray-400">{o.acv > 0 ? fmtCurrency(o.acv) : '—'}</td>
                              <td className="px-3 py-2 text-center tabular-nums text-gray-600 dark:text-gray-400">{fmtNum(o.activityCount)}</td>
                              {activityTypes.map((at) => (
                                <td key={at.id} className="px-3 py-2 text-center tabular-nums text-gray-600 dark:text-gray-400">{o.countByType[at.name] ?? 0}</td>
                              ))}
                            </tr>
                          ))}
                        </Fragment>
                      )
                    })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
