import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase, ExternalLink, EyeOff, Eye, X, Undo2 } from 'lucide-react'
import { api } from '../../lib/api.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { useDisplayCurrency } from '../../lib/displayCurrency.js'
import { SfActivitiesModal } from '../salesforce/SfActivitiesModal.js'
import { format } from 'date-fns'
import { useCrmLabelContext } from '../../store/crmProvider.js'

interface Row {
  oppId: string
  oppName: string
  accountName: string | null
  salesStage: string | null
  closeDate: string | null
  amount: string | null
  ownerName: string | null
  activityCount: number
  lastActivityAt: string
  dismissed: { by: string; at: string } | null
}

interface Props {
  teamId: string
  weeksBack: number
  productIds?: string[]
  memberIds?: string[]
  stages?: string[]
  forecast?: string[]
  acv?: string[]
}

// vNext — "Closed Lost — Needs Review" (Manager group). See CLAUDE.md §7/§13.
// Opportunities closed Lost/Duplicate that still have ImpactIQ activity
// linked — most likely because the real work moved to a different,
// replacement Opportunity. Local-Postgres-only, no live SF call, so it loads
// fast for every viewer regardless of their own SF connection.
export function ClosedLostReview({ teamId, weeksBack, productIds = [], memberIds, stages = [], forecast = [], acv = [] }: Props) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const { fmt: fmtCurrency } = useDisplayCurrency()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDismissed, setShowDismissed] = useState(false)
  const [drillOpp, setDrillOpp] = useState<{ id: string; name: string } | null>(null)

  const isAllTeams = !teamId || teamId === 'all'

  function load() {
    if (isAllTeams) { setRows(null); setLoading(false); return }
    setLoading(true)
    const url = buildDashboardUrl('closed-lost-review', {
      teamId,
      weeksBack,
      productIds,
      memberIds,
      extra: {
        stages: stages.join(','),
        forecast: forecast.join(','),
        acv: acv.join(','),
        includeDismissed: showDismissed ? 'true' : undefined,
      },
    })
    api.get<Row[]>(url).then((res) => {
      setRows(res.data ?? null)
      setLoading(false)
    })
  }

  useEffect(load, [teamId, weeksBack, productIds.join(','), memberIds?.join(','), stages.join(','), forecast.join(','), acv.join(','), showDismissed])

  async function dismiss(row: Row) {
    await api.post('/api/dashboards/closed-lost-review/dismiss', { teamId, crmOppId: row.oppId, crmOppName: row.oppName })
    setRows((prev) => (prev ? (showDismissed ? prev : prev.filter((r) => r.oppId !== row.oppId)) : prev))
    if (showDismissed) load()
  }

  async function undismiss(row: Row) {
    await api.delete('/api/dashboards/closed-lost-review/dismiss', { teamId, crmOppId: row.oppId })
    load()
  }

  if (isAllTeams) {
    return <DashboardEmptyState reason="select_team" />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('leader.closed_lost_review.description', { defaultValue: 'Opportunities closed Lost or Duplicate that still have ImpactIQ activity linked — most likely because the real work moved to a different Opportunity. Click a row to relink it.', context: crmCtx })}
        </p>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300" />
          {showDismissed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {t('leader.closed_lost_review.show_dismissed_toggle', 'Show Dismissed')}
        </label>
      </div>

      {loading && <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>}
      {!loading && rows === null && <DashboardEmptyState />}
      {rows && rows.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
          {t('leader.closed_lost_review.empty_state', { defaultValue: 'Nothing needs review — no linked Opportunity is closed Lost/Duplicate right now.', context: crmCtx })}
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">{t('leader.closed_lost_review.col_opp_name', { defaultValue: 'Opportunity', context: crmCtx })}</th>
                <th className="px-3 py-2 text-left">{t('leader.closed_lost_review.col_account', { defaultValue: 'Account', context: crmCtx })}</th>
                <th className="px-3 py-2 text-left">{t('leader.closed_lost_review.col_stage', 'Stage')}</th>
                <th className="px-3 py-2 text-left">{t('leader.closed_lost_review.col_close_date', 'Close Date')}</th>
                <th className="px-3 py-2 text-right">{t('leader.closed_lost_review.col_amount', 'Amount')}</th>
                <th className="px-3 py-2 text-left">{t('leader.closed_lost_review.col_owner', 'Owner')}</th>
                <th className="px-3 py-2 text-center">{t('leader.closed_lost_review.col_activity_count', 'Activities')}</th>
                <th className="px-3 py-2 text-left">{t('leader.closed_lost_review.col_last_activity', 'Last Activity')}</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.oppId} className={`border-b border-gray-100 dark:border-gray-900 last:border-b-0 ${r.dismissed ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setDrillOpp({ id: r.oppId, name: r.oppName })}
                      className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      <Briefcase className="h-3.5 w-3.5 shrink-0" />
                      {r.oppName}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </button>
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.accountName ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.salesStage ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{r.closeDate ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-200">{r.amount != null ? fmtCurrency(Number(r.amount)) : '—'}</td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.ownerName ?? '—'}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.activityCount}</td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{format(new Date(r.lastActivityAt), 'MMM d, yyyy')}</td>
                  <td className="px-3 py-2 text-right">
                    {r.dismissed ? (
                      <button
                        type="button"
                        onClick={() => void undismiss(r)}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                        title={t('leader.closed_lost_review.dismissed_by', { defaultValue: 'Dismissed by {{name}} on {{date}}', name: r.dismissed.by, date: format(new Date(r.dismissed.at), 'MMM d, yyyy') })}
                      >
                        <Undo2 className="h-3 w-3" />
                        {t('leader.closed_lost_review.undismiss_button', 'Undismiss')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void dismiss(r)}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                        title={t('leader.closed_lost_review.dismiss_confirm', 'Mark as reviewed — nothing to relink here')}
                      >
                        <X className="h-3 w-3" />
                        {t('leader.closed_lost_review.dismiss_button', 'Dismiss')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The Relink action lives inside this same, unmodified modal — see
          CLAUDE.md §7 — so there is exactly one Relink UI in the app. */}
      {drillOpp && (
        <SfActivitiesModal
          open={!!drillOpp}
          onClose={() => setDrillOpp(null)}
          teamId={teamId}
          whatId={drillOpp.id}
          whatType="Opportunity"
          whatName={drillOpp.name}
          onRelinked={() => { setDrillOpp(null); load() }}
        />
      )}
    </div>
  )
}
