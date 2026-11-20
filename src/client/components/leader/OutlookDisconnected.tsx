import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MailX, ArrowUpRight } from 'lucide-react'
import { format } from 'date-fns'
import { api } from '../../lib/api.js'
import { buildDashboardUrl } from '../../lib/dashboard-fetch.js'
import { Spinner } from '../ui/spinner.js'
import { DashboardEmptyState } from './DashboardEmptyState.js'
import { Badge } from '../ui/badge.js'
import { DynamicIcon } from '../ui/icon-picker.js'

interface Row {
  id: string
  title: string
  startDatetime: string
  effortHours: string
  ownerId: string
  ownerName: string
  teamId: string
  teamName: string
  subtypeName: string | null
  activityTypeName: string | null
  activityTypeColor: string | null
  activityTypeIcon: string | null
  outlookDeletedAt: string | null
  createdAt: string
}

interface Props { teamId: string; memberIds?: string[] }

// v1.362.0: leader-dashboard counterpart to SfDisconnected.tsx (CLAUDE.md §7/§13),
// for the other side of the same "link went away" problem — an approved
// activity whose OUTLOOK meeting (not a Salesforce record) was deleted, still
// awaiting the owner's Keep/Delete decision (§10). Read-only, same as the SF
// dashboard: a leader/admin can see the queue and how long it's been sitting,
// but the actual Keep/Delete stays with the owning contributor (this table
// only deep-links to the activity's own week, it never acts on someone
// else's row directly — leaders cannot edit contributor activities, §5).
export function OutlookDisconnected({ teamId, memberIds = [] }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setRows(null)
    api.get<Row[]>(buildDashboardUrl('outlook-disconnected', { teamId, memberIds }))
      .then((res) => setRows(res.data ?? null))
      .finally(() => setLoading(false))
  }, [teamId, memberIds.join(',')])

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('leader.outlook_disconnected.description', 'Approved activities whose Outlook meeting has been deleted from the calendar — still awaiting the owner’s Keep or Delete decision (My Settings → Activities page banner). Checked whenever the calendar syncs.')}
      </p>

      {loading && <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>}
      {!loading && rows === null && <DashboardEmptyState />}
      {rows && rows.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
          {t('leader.outlook_disconnected.empty', 'No pending decisions found — every approved activity is still matched to a real Outlook meeting.')}
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">{t('leader.outlook_disconnected.col_activity', 'Activity')}</th>
                <th className="px-3 py-2 text-left">{t('leader.outlook_disconnected.col_type', 'Type')}</th>
                <th className="px-3 py-2 text-left">{t('leader.outlook_disconnected.col_owner', 'Owner')}</th>
                <th className="px-3 py-2 text-left">{t('leader.outlook_disconnected.col_team', 'Team')}</th>
                <th className="px-3 py-2 text-left">{t('leader.outlook_disconnected.col_date', 'Date')}</th>
                <th className="px-3 py-2 text-left">{t('leader.outlook_disconnected.col_hours', 'Hours')}</th>
                <th className="px-3 py-2 text-left">{t('leader.outlook_disconnected.col_deleted', 'Flagged')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const dayKey = format(new Date(r.startDatetime), 'yyyy-MM-dd')
                return (
                  <tr key={r.id} className="border-b border-gray-100 align-top dark:border-gray-900 last:border-b-0">
                    <td className="px-3 py-2">
                      <a
                        href={`/activities?openActivityId=${r.id}&startDate=${dayKey}`}
                        className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {r.title}
                        <ArrowUpRight className="h-3 w-3 shrink-0" />
                      </a>
                      {r.subtypeName && (
                        <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{r.subtypeName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.activityTypeName && (
                        <Badge
                          variant="secondary"
                          className="gap-1"
                          style={r.activityTypeColor ? { backgroundColor: r.activityTypeColor, color: '#fff', borderColor: r.activityTypeColor } : undefined}
                        >
                          {r.activityTypeIcon && <DynamicIcon name={r.activityTypeIcon} className="h-3 w-3" />}
                          {r.activityTypeName}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.ownerName}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.teamName}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">{dayKey}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">{Number(r.effortHours).toFixed(1)}h</td>
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300"
                        title={r.outlookDeletedAt ? new Date(r.outlookDeletedAt).toLocaleString() : undefined}
                      >
                        <MailX className="h-3 w-3 shrink-0" />
                        {r.outlookDeletedAt ? format(new Date(r.outlookDeletedAt), 'MMM d, yyyy') : '—'}
                      </span>
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
