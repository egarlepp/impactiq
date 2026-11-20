import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BellOff } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { SortableTh, TablePagination } from '../ui/table-controls.js'
import { useTableView } from '../../lib/tableView.js'
import { api } from '../../lib/api.js'

interface DismissalRow {
  userId: string
  userName: string | null
  userEmail: string | null
  nudgeRuleId: string
  triggerType: string
  ruleName: string
  messageTemplate: string
  dismissed: 'permanent' | 'snoozed'
  dismissedAt: string
  dismissedUntil: string | null
}

// v1.309.0: until now, the only place a dismissal was ever surfaced to an
// admin was the Nudge Rules Preview modal's per-member pill — sampled, one
// rule at a time, no clear action. This is the first standalone, team-wide
// "who has muted what" view, with a way to actually clear one.
export function NudgeDismissals({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<DismissalRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setError(null)
    const res = await api.get<DismissalRow[]>(`/api/admin/teams/${teamId}/nudge-dismissals`)
    if (res.error) { setError(res.error); setRows([]); return }
    setRows(res.data ?? [])
  }
  useEffect(() => { void reload() }, [teamId])

  async function clearDismissal(row: DismissalRow) {
    if (!window.confirm(t('admin.nudge_dismissals.clear_confirm', { name: row.userName ?? row.userEmail ?? '', defaultValue: 'Clear this dismissal for {{name}}? The rule will be eligible to fire for them again on the next check.' }))) return
    await api.delete(`/api/admin/teams/${teamId}/nudge-dismissals/${row.userId}/${row.nudgeRuleId}`)
    await reload()
  }

  const getters = useMemo(() => ({
    user: (r: DismissalRow) => `${r.userName ?? ''} ${r.userEmail ?? ''}`,
    rule: (r: DismissalRow) => r.ruleName,
    status: (r: DismissalRow) => r.dismissed,
    dismissedAt: (r: DismissalRow) => r.dismissedAt,
    until: (r: DismissalRow) => r.dismissedUntil ?? '',
  }), [t])
  const view = useTableView(rows ?? [], getters, { resetKey: teamId })
  const searchPh = t('common.search_placeholder')

  if (!rows) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (error) return <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{error}</div>

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('admin.nudge_dismissals.hint', 'Team members currently snoozing or permanently closed out of a nudge rule — useful for confirming why someone isn\'t getting a reminder that looks like it should be firing for them.')}
      </p>
      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-gray-900 dark:text-gray-100">
            <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <SortableTh label={t('admin.nudge_dismissals.col_user', 'Member')} colKey="user" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.user} onFilter={(v) => view.setFilter('user', v)} filterPlaceholder={searchPh} />
                <SortableTh label={t('admin.nudge_dismissals.col_rule', 'Rule')} colKey="rule" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} filterValue={view.filters.rule} onFilter={(v) => view.setFilter('rule', v)} filterPlaceholder={searchPh} />
                <SortableTh label={t('admin.nudge_dismissals.col_status', 'Status')} colKey="status" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
                <SortableTh label={t('admin.nudge_dismissals.col_dismissed_at', 'Dismissed')} colKey="dismissedAt" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
                <SortableTh label={t('admin.nudge_dismissals.col_until', 'Until')} colKey="until" sortKey={view.sortKey} sortDir={view.sortDir} onToggle={view.toggleSort} />
                <th />
              </tr>
            </thead>
            <tbody>
              {view.visible.map((r) => (
                <tr key={`${r.userId}:${r.nudgeRuleId}`} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
                  <td className="px-3 py-2">
                    <div>{r.userName ?? <span className="italic text-gray-400">{t('admin.nudge_dismissals.unknown_user', 'Unknown')}</span>}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{r.userEmail}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.ruleName}</div>
                    <div className="max-w-xs truncate text-xs text-gray-500 dark:text-gray-400" title={r.messageTemplate}>{r.messageTemplate}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                      title={r.dismissed === 'permanent'
                        ? t('admin.nudge_rules.preview_dismissed_permanent_tip')
                        : t('admin.nudge_rules.preview_dismissed_snoozed_tip', { until: r.dismissedUntil ? new Date(r.dismissedUntil).toLocaleString() : '' })}
                    >
                      <BellOff className="h-3 w-3" />
                      {r.dismissed === 'permanent' ? t('admin.nudge_rules.preview_dismissed_permanent') : t('admin.nudge_rules.preview_dismissed_snoozed')}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{new Date(r.dismissedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{r.dismissedUntil ? new Date(r.dismissedUntil).toLocaleString() : t('admin.nudge_dismissals.forever', 'Never (permanent)')}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => clearDismissal(r)}>
                      <BellOff className="mr-1 h-3 w-3" />
                      {t('admin.nudge_dismissals.clear', 'Clear')}
                    </Button>
                  </td>
                </tr>
              ))}
              {view.total === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-gray-400">{t('admin.nudge_dismissals.empty', 'No team members currently have a nudge rule snoozed or closed out.')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <TablePagination page={view.page} totalPages={view.totalPages} onPageChange={view.setPage} />
      </div>
    </div>
  )
}
