import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, FilterX, Layers, UserRound, Users } from 'lucide-react'
import { api } from '../../../lib/api.js'
import { formatDateTimeInTZ } from '../../../lib/tz.js'
import { Button } from '../../ui/button.js'
import { SingleSelect } from '../../ui/single-select.js'
import { Spinner } from '../../ui/spinner.js'
import {
  AI_USAGE_NONE,
  isAiProviderKind,
  type AiUsageGroupBy,
  type AiUsageGroupRow,
  type AiUsageView,
} from '../../../../shared/ai.js'
import { AiProviderLogo } from './AiProviderLogo.js'
import { StatusPill, featureIcon, usd } from './aiUsageShared.js'

// AI Assistant → Usage this month (v1.467.0). The month's requests grouped
// by feature, team or person (click a row to filter by it), and every
// request in a table of 20 per page, filterable by feature, team and person.

const ALL = ''

interface Filters { feature: string; teamId: string; userId: string }

const GROUP_ICONS: Record<AiUsageGroupBy, typeof Layers> = { feature: Layers, team: Users, user: UserRound }

export function AiUsagePanel({ providersVersion }: { providersVersion: number }) {
  const { t } = useTranslation()
  const [groupBy, setGroupBy] = useState<AiUsageGroupBy>('feature')
  const [filters, setFilters] = useState<Filters>({ feature: ALL, teamId: ALL, userId: ALL })
  const [page, setPage] = useState(1)
  const [view, setView] = useState<AiUsageView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = new URLSearchParams({ groupBy, page: String(page) })
    if (filters.feature) qs.set('feature', filters.feature)
    if (filters.teamId) qs.set('teamId', filters.teamId)
    if (filters.userId) qs.set('userId', filters.userId)
    void api.get<AiUsageView>(`/api/admin/ai/usage?${qs.toString()}`).then((res) => {
      // A newer request (filter, page) may have answered first.
      if (cancelled) return
      setLoading(false)
      if (res.data) { setView(res.data); setError(null) } else setError(res.error ?? 'errors.server')
    })
    return () => { cancelled = true }
  }, [groupBy, page, filters.feature, filters.teamId, filters.userId, providersVersion])

  function setFilter(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(1)
  }

  const featureLabel = (f: string) => t(`ai_assistant.features.${f}`, { defaultValue: f })
  const noTeam = t('ai_assistant.usage.no_team')
  const noUser = t('ai_assistant.usage.no_user')

  function groupName(g: AiUsageGroupRow): string {
    if (groupBy === 'feature') return g.key ? featureLabel(g.key) : '—'
    if (g.key === null) return groupBy === 'team' ? noTeam : noUser
    return g.label ?? '—'
  }

  function filterByGroup(g: AiUsageGroupRow) {
    const key = g.key ?? AI_USAGE_NONE
    if (groupBy === 'feature') setFilter({ feature: g.key ?? ALL })
    else if (groupBy === 'team') setFilter({ teamId: key })
    else setFilter({ userId: key })
  }

  const filtered = filters.feature !== ALL || filters.teamId !== ALL || filters.userId !== ALL
  const options = view?.options ?? { features: [], teams: [], users: [] }
  const totalCost = view?.totals.costUsd ?? 0
  const pages = view ? Math.max(1, Math.ceil(view.totalRows / view.pageSize)) : 1
  const first = view && view.totalRows > 0 ? (view.page - 1) * view.pageSize + 1 : 0
  const last = view ? Math.min(view.page * view.pageSize, view.totalRows) : 0

  const groupTabs: Array<{ key: AiUsageGroupBy; label: string }> = [
    { key: 'feature', label: t('ai_assistant.usage.by_feature') },
    { key: 'team', label: t('ai_assistant.usage.by_team') },
    { key: 'user', label: t('ai_assistant.usage.by_user') },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={t('ai_assistant.usage.group_by')} className="inline-flex rounded-md border border-gray-200 p-0.5 dark:border-gray-700">
          {groupTabs.map(({ key, label }) => {
            const Icon = GROUP_ICONS[key]
            const active = groupBy === key
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setGroupBy(key)}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium ${active
                  ? 'bg-indigo-600 text-white dark:bg-indigo-500'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SingleSelect
            label={t('ai_assistant.usage.feature')}
            labelIcon={Layers}
            value={filters.feature}
            onChange={(v) => setFilter({ feature: v })}
            options={[{ value: ALL, label: t('ai_assistant.usage.all') }, ...options.features.map((f) => ({ value: f, label: featureLabel(f), icon: featureIcon(f) }))]}
          />
          <SingleSelect
            label={t('ai_assistant.usage.team')}
            labelIcon={Users}
            value={filters.teamId}
            onChange={(v) => setFilter({ teamId: v })}
            options={[{ value: ALL, label: t('ai_assistant.usage.all') }, ...options.teams.map((tm) => ({ value: tm.id, label: tm.name })), { value: AI_USAGE_NONE, label: noTeam }]}
          />
          <SingleSelect
            label={t('ai_assistant.usage.user')}
            labelIcon={UserRound}
            value={filters.userId}
            onChange={(v) => setFilter({ userId: v })}
            options={[{ value: ALL, label: t('ai_assistant.usage.all') }, ...options.users.map((u) => ({ value: u.id, label: u.name })), { value: AI_USAGE_NONE, label: noUser }]}
          />
          {filtered ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setFilter({ feature: ALL, teamId: ALL, userId: ALL })}>
              <FilterX className="mr-1 h-3.5 w-3.5" />
              {t('ai_assistant.usage.clear_filters')}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{t(error)}</p> : null}
      {!view ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : view.totals.requests === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">{filtered ? t('ai_assistant.usage.no_matches') : t('ai_assistant.no_usage')}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 text-gray-500 dark:bg-gray-800/60 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{groupTabs.find((g) => g.key === groupBy)?.label}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('ai_assistant.usage.requests')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('ai_assistant.usage.failed')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('ai_assistant.usage.input_tokens')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('ai_assistant.usage.output_tokens')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('ai_assistant.usage.cost')}</th>
                  <th className="w-32 px-3 py-1.5 font-medium">{t('ai_assistant.usage.share')}</th>
                </tr>
              </thead>
              <tbody className="text-gray-800 dark:text-gray-200">
                {view.groups.map((g) => {
                  const Icon = groupBy === 'feature' && g.key ? featureIcon(g.key) : GROUP_ICONS[groupBy]
                  const share = totalCost > 0 ? (g.costUsd / totalCost) * 100 : view.totals.requests > 0 ? (g.requests / view.totals.requests) * 100 : 0
                  return (
                    <tr key={g.key ?? 'none'} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-3 py-1.5">
                        <button
                          type="button"
                          onClick={() => filterByGroup(g)}
                          className="flex items-center gap-1.5 text-left font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                          title={t('ai_assistant.usage.filter_hint')}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          {groupName(g)}
                        </button>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{g.requests.toLocaleString()}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${g.failed > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>{g.failed.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{g.inputTokens.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{g.outputTokens.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(g.costUsd)}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                            <div className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400" style={{ width: `${Math.max(share, 1)}%` }} />
                          </div>
                          <span className="w-9 text-right tabular-nums text-gray-500 dark:text-gray-400">{Math.round(share)}%</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{t('ai_assistant.usage.requests_title')}</p>
            {loading ? <Spinner className="h-3.5 w-3.5" /> : null}
          </div>
          <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 text-gray-500 dark:bg-gray-800/60 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{t('ai_assistant.usage.when')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('ai_assistant.usage.feature')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('ai_assistant.usage.team')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('ai_assistant.usage.user')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('ai_assistant.usage.provider')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('ai_assistant.usage.status')}</th>
                  <th className="px-3 py-1.5 text-right font-medium" title={t('ai_assistant.usage.items_hint')}>{t('ai_assistant.usage.items')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('ai_assistant.usage.tokens')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('ai_assistant.usage.cost')}</th>
                </tr>
              </thead>
              <tbody className="text-gray-800 dark:text-gray-200">
                {view.rows.map((r) => {
                  const Icon = featureIcon(r.feature)
                  return (
                    <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800" title={r.error ?? undefined}>
                      <td className="whitespace-nowrap px-3 py-1.5">{formatDateTimeInTZ(r.createdAt)}</td>
                      <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />{featureLabel(r.feature)}</span></td>
                      <td className="px-3 py-1.5">{r.teamName ?? <span className="text-gray-400 dark:text-gray-500">{noTeam}</span>}</td>
                      <td className="px-3 py-1.5">{r.userName ?? <span className="text-gray-400 dark:text-gray-500">{noUser}</span>}</td>
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5">{r.providerKind && isAiProviderKind(r.providerKind) && <AiProviderLogo kind={r.providerKind} className="h-3.5 w-3.5" />}{r.providerName ?? '—'}</span>
                        {r.model && <span className="ml-1 font-mono text-gray-500 dark:text-gray-400">{r.model}</span>}
                      </td>
                      <td className="px-3 py-1.5"><StatusPill status={r.status} /></td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{(r.itemCount ?? 1).toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{(r.inputTokens + r.outputTokens).toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.costUsd)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.usage.showing', { first, last, total: view.totalRows })}</p>
            <div className="flex items-center gap-1">
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={loading || view.page <= 1} onClick={() => setPage(view.page - 1)}>
                <ChevronLeft className="mr-0.5 h-3.5 w-3.5" />
                {t('ai_assistant.usage.previous')}
              </Button>
              <span className="px-2 text-xs tabular-nums text-gray-600 dark:text-gray-400">{t('ai_assistant.usage.page_of', { page: view.page, pages })}</span>
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={loading || view.page >= pages} onClick={() => setPage(view.page + 1)}>
                {t('ai_assistant.usage.next')}
                <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
