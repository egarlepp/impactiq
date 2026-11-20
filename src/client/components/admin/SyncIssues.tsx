import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { SingleSelect } from '../ui/single-select.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

type IssueSource = 'activity_writeback' | 'note_push'

interface Row {
  id: string
  source: IssueSource
  activityId: string
  title: string
  userId: string
  userEmail: string
  userName: string
  teamId: string
  teamName: string
  crmWhatId: string | null
  crmWhatName: string | null
  crmWhatType: string | null
  crmSyncError: string | null
  startDatetime: string
  updatedAt: string
  // v1.261.0
  resolved: boolean
  resolvedAt: string | null
  resolvedByName: string | null
}

// Categorise raw SF error strings into a stable "reason" + friendly
// admin-facing explanation. Falls back to the raw string so nothing is
// hidden. Add new patterns as new failure modes show up in production.
function classify(err: string | null): { reason: string; explanation: string; suggested: string } {
  const raw = (err ?? '').trim()
  if (!raw) return {
    reason: 'unknown',
    explanation: 'The writeback worker reported failed but recorded no error string.',
    suggested: 'Retry the sync. If it fails again, check server logs around the activity\'s updated_at.',
  }
  if (/INVALID_SESSION_ID|expired|authentication/i.test(raw)) return {
    reason: 'auth_expired',
    explanation: 'The user\'s Salesforce OAuth token expired or was revoked. Writeback can\'t authenticate on their behalf.',
    suggested: 'Ask the user to reconnect Salesforce from My Settings → Connections.',
  }
  if (/INVALID_FIELD|No such column|field integrity/i.test(raw)) return {
    reason: 'field_mapping',
    explanation: 'One of the mapped fields no longer exists on the SF Event/Task object, or the picklist value isn\'t allowed.',
    suggested: 'Check Admin → SF Field Mappings and Admin → SF Picklist Config for this team.',
  }
  if (/INVALID_TYPE|Type is not valid/i.test(raw)) return {
    reason: 'picklist_type',
    explanation: 'The activity type name isn\'t in the SF Event Type picklist for this org.',
    suggested: 'Ask the SF admin to add the missing picklist value, or map a fallback in Admin → SF Picklist Config.',
  }
  if (/REQUIRED_FIELD_MISSING|required/i.test(raw)) return {
    reason: 'required_field',
    explanation: 'SF is rejecting the record because a required field is empty or the mapping doesn\'t send it.',
    suggested: 'Check the SF Field Mappings — you may need to add a mapping or a constant value for the missing required field.',
  }
  if (/INVALID_ID|malformed|Id not valid/i.test(raw)) return {
    reason: 'invalid_whatid',
    explanation: 'The Opportunity/Account id on the activity no longer exists in SF (was deleted or belongs to a different org).',
    suggested: 'Edit the activity and re-select a valid Salesforce record.',
  }
  if (/duplicate|DUPLICATE_VALUE/i.test(raw)) return {
    reason: 'duplicate',
    explanation: 'SF found a duplicate record and refused the write.',
    suggested: 'Investigate the duplicate in SF; may need a merge before retrying.',
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Network/i.test(raw)) return {
    reason: 'network',
    explanation: 'Transient network error talking to Salesforce.',
    suggested: 'Retry the sync — should clear on its own.',
  }
  if (/not connected|not_connected/i.test(raw)) return {
    reason: 'not_connected',
    explanation: 'This user has never connected Salesforce.',
    suggested: 'Ask the user to connect in My Settings → Connections. Until then, activities won\'t sync.',
  }
  if (/stub|Stub Opp/i.test(raw)) return {
    reason: 'demo_data',
    explanation: 'This activity was created against demo/stub Salesforce records that don\'t exist in the real org.',
    suggested: 'Expected — demo data can\'t write to SF. Ignore or delete these activities.',
  }
  return {
    reason: 'other',
    explanation: 'Salesforce returned an error the app doesn\'t recognise.',
    suggested: 'Copy the raw error and check SF setup / API logs. Retry once the underlying issue is fixed.',
  }
}

// HubSpot errors (phase 4), translated. The write-back stores either a
// client error code (errors.hubspot.*), "HubSpot {status}: {message}", or a
// fixed English sentence from hubspot/writeback.ts and hubspot/notesPush.ts.
const HUBSPOT_PATTERNS: Array<[RegExp, string]> = [
  // Write-back waiting for HubSpot's calendar sync to log the meeting
  // (meeting creation off in CRM features), v1.410.0.
  [/creating HubSpot meetings is turned off/i, 'hs_meeting_wait'],
  [/errors\.hubspot\.unauthorized|HubSpot 401/i, 'hs_token'],
  [/errors\.hubspot\.forbidden|HubSpot 403/i, 'hs_scope'],
  [/errors\.hubspot\.rate_limited|HubSpot 429/i, 'hs_rate_limit'],
  [/errors\.hubspot\.not_configured|HubSpot is not connected/i, 'hs_not_configured'],
  [/errors\.hubspot\.unreachable|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i, 'network'],
  [/^Associations:/i, 'hs_association'],
  [/HubSpot 404/i, 'hs_deleted'],
  [/campaigns take meetings, not tasks/i, 'hs_campaign_task'],
  [/No HubSpot record to link/i, 'hs_no_link'],
  [/Not a HubSpot record/i, 'hs_wrong_crm'],
  [/HubSpot 400|PROPERTY_DOESNT_EXIST|INVALID_OPTION|not valid/i, 'field_mapping'],
]

function classifyHubspot(err: string | null, t: TFunction): { reason: string; explanation: string; suggested: string } {
  const raw = (err ?? '').trim()
  const reason = !raw ? 'unknown' : (HUBSPOT_PATTERNS.find(([rx]) => rx.test(raw))?.[1] ?? 'hs_other')
  return {
    reason,
    explanation: t(`admin.sync_issues.hubspot.${reason}.explanation`),
    suggested: t(`admin.sync_issues.hubspot.${reason}.suggested`),
  }
}

interface SyncIssuesProps {
  // v1.263.0: CrmSync.tsx's KPI cards and the Issues tab badge read their
  // own separate /api/admin/sync-issues summary — this component reloading
  // its OWN rows after Resolve/Retry never told that parent fetch to run
  // again, so the header kept showing the pre-action counts until the admin
  // switched tabs. Optional so this component still works standalone.
  onChanged?: () => void
}

export function SyncIssues({ onChanged }: SyncIssuesProps = {}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'open' | 'resolved' | 'all'>('open')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchResult, setBatchResult] = useState<{ retried: number; failed: number } | null>(null)

  async function reload() {
    const res = await api.get<Row[]>('/api/admin/sync-issues')
    setRows(res.data ?? [])
    setSelected(new Set())
  }
  useEffect(() => { void reload() }, [])

  // v1.260.0: two sources, two retry endpoints. Activity writeback flips
  // crmSyncStatus back to 'pending' for the writeback worker to pick up;
  // note pushes have no separate worker retry path, so /note-pushes/:id/retry
  // resets the SAME row to 'pending' and kicks it directly (see admin.ts —
  // deliberately not enqueuePush, which would create a new row instead).
  function retryEndpoint(r: Pick<Row, 'id' | 'source'>): string {
    return r.source === 'note_push'
      ? `/api/admin/note-pushes/${r.id}/retry`
      : `/api/admin/activities/${r.id}/retry-sync`
  }

  async function retry(r: Row) {
    setBusyId(r.id)
    await api.post(retryEndpoint(r), {})
    setBusyId(null)
    await reload()
    onChanged?.()
  }

  // v1.261.0: manual "I've handled this" annotation — does NOT change the
  // underlying activity/note-push row, so a genuinely new failure later
  // will naturally reopen the issue (see admin.ts's /sync-issues route).
  async function resolve(r: Row) {
    setBusyId(r.id)
    await api.post(`/api/admin/sync-issues/${r.source}/${r.id}/resolve`, {})
    setBusyId(null)
    await reload()
    onChanged?.()
  }

  async function retryAll() {
    if (shown.length === 0) return
    if (!window.confirm(t('admin.sync_issues.retry_all_confirm', { count: shown.length }))) return
    for (const r of shown) {
      // Sequential to avoid overwhelming SF; the worker picks them up as they flip to pending.
      await api.post(retryEndpoint(r), {})
    }
    await reload()
    onChanged?.()
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function retrySelected(ids: string[]) {
    setBatchBusy(true)
    setBatchResult(null)
    const selectedRows = (rows ?? []).filter((r) => ids.includes(r.id))
    const activityIds = selectedRows.filter((r) => r.source !== 'note_push').map((r) => r.id)
    const notePushRows = selectedRows.filter((r) => r.source === 'note_push')
    let retried = 0
    let failed = 0
    if (activityIds.length > 0) {
      const res = await api.post<{ retried: number; failed: number }>('/api/admin/activities/retry-sync-batch', { ids: activityIds })
      if (res.data) { retried += res.data.retried; failed += res.data.failed }
      else failed += activityIds.length
    }
    // No batch endpoint for note pushes (low volume) — sequential, same
    // reasoning as retryAll above.
    for (const r of notePushRows) {
      const res = await api.post(retryEndpoint(r), {})
      if (res.error) failed += 1
      else retried += 1
    }
    setBatchBusy(false)
    setBatchResult({ retried, failed })
    await reload()
    onChanged?.()
  }

  if (!rows) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>

  const openCount = rows.filter((r) => !r.resolved).length
  const resolvedCount = rows.filter((r) => r.resolved).length

  const statusFiltered = statusFilter === 'all' ? rows : rows.filter((r) => statusFilter === 'resolved' ? r.resolved : !r.resolved)
  const q = filter.trim().toLowerCase()
  const shown = q ? statusFiltered.filter((r) =>
    r.userEmail.toLowerCase().includes(q) ||
    r.userName.toLowerCase().includes(q) ||
    r.title.toLowerCase().includes(q) ||
    (r.crmSyncError ?? '').toLowerCase().includes(q) ||
    r.teamName.toLowerCase().includes(q),
  ) : statusFiltered

  const shownIds = shown.map((r) => r.id)
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id))
  const selectedIds = shownIds.filter((id) => selected.has(id))

  function toggleAllInView() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allShownSelected) shownIds.forEach((id) => next.delete(id))
      else shownIds.forEach((id) => next.add(id))
      return next
    })
  }

  if (rows.length === 0) {
    return <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.sync_issues.empty', { context: crmCtx })}</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Label>{t('admin.sync_issues.filter_label')}</Label>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('admin.sync_issues.filter_placeholder')} />
        </div>
        <SingleSelect
          label={t('admin.sync_issues.status_label', 'Status')}
          options={[
            { value: 'open', label: t('admin.sync_issues.status_open', 'Open ({{n}})', { n: openCount }) },
            { value: 'resolved', label: t('admin.sync_issues.status_resolved', 'Resolved ({{n}})', { n: resolvedCount }) },
            { value: 'all', label: t('common.all', 'All') },
          ]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as 'open' | 'resolved' | 'all')}
        />
        <Button size="sm" variant="outline" onClick={retryAll} disabled={shown.length === 0}><RefreshCw className="mr-1 h-3.5 w-3.5" />{t('admin.sync_issues.retry_all', { count: shown.length })}</Button>
      </div>
      {selectedIds.length > 0 && (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-800 dark:bg-blue-950/40">
          <span className="font-medium text-blue-900 dark:text-blue-200">
            {t('admin.sync_issues.batch.selected', { n: selectedIds.length })}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => retrySelected(selectedIds)} disabled={batchBusy}>
              {batchBusy ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3 w-3" />}
              {t('admin.sync_issues.batch.retry_selected')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={batchBusy}>
              {t('admin.sync_issues.batch.clear_selection')}
            </Button>
          </div>
        </div>
      )}
      {batchResult && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {t('admin.sync_issues.batch.result', { retried: batchResult.retried, failed: batchResult.failed })}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <table className="w-full text-sm text-gray-900 dark:text-gray-100">
          <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <th className="px-2 py-2 w-8">
                <input
                  type="checkbox"
                  aria-label={t('admin.sync_issues.batch.select_all_in_view')}
                  checked={allShownSelected}
                  onChange={toggleAllInView}
                />
              </th>
              <th className="px-3 py-2">{t('admin.sync_issues.col_user')}</th>
              <th className="px-3 py-2">{t('admin.sync_issues.col_activity')}</th>
              <th className="px-3 py-2">{t('admin.sync_issues.col_reason')}</th>
              <th className="px-3 py-2">{t('admin.sync_issues.col_last_tried')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const cls = crmCtx === 'hubspot' ? classifyHubspot(r.crmSyncError, t) : classify(r.crmSyncError)
              return (
                <tr key={r.id} className={cn('border-b border-gray-100 dark:border-gray-900 last:border-b-0 align-top', r.resolved && 'opacity-60')}>
                  <td className="px-2 py-2 align-top">
                    <input
                      type="checkbox"
                      aria-label={t('admin.sync_issues.batch.select_row')}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.userName}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{r.userEmail}</div>
                    <div className="text-[10px] text-gray-400">{r.teamName}</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.source === 'note_push' && (
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        {t('admin.sync_issues.source_note_push', 'Note Push')}
                      </div>
                    )}
                    <a href={`/activities?open=${r.activityId}`} className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">{r.title}</a>
                    {r.crmWhatName && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {r.crmWhatType}: {r.crmWhatName}
                      </div>
                    )}
                    <div className="text-[10px] text-gray-400">{new Date(r.startDatetime).toLocaleString()}</div>
                  </td>
                  <td className="px-3 py-2 max-w-xs">
                    <div className="flex items-center gap-1 text-xs font-semibold uppercase text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" />
                      {t(`admin.sync_issues.reason.${cls.reason}` as const, cls.reason)}
                    </div>
                    <div className="mt-1 text-xs text-gray-700 dark:text-gray-300">{cls.explanation}</div>
                    <div className="mt-1 text-[11px] text-blue-700 dark:text-blue-400">→ {cls.suggested}</div>
                    {r.crmSyncError && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[10px] text-gray-500">{t('admin.sync_issues.raw_error', { context: crmCtx })}</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-gray-50 dark:bg-gray-900 p-1.5 text-[10px] text-gray-700 dark:text-gray-300">{r.crmSyncError}</pre>
                      </details>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {new Date(r.updatedAt).toLocaleString()}
                    {r.resolved && (
                      <div className="mt-1 flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400" title={r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : undefined}>
                        <CheckCircle2 className="h-3 w-3" />
                        {r.resolvedByName
                          ? t('admin.sync_issues.resolved_by', 'Resolved by {{name}}', { name: r.resolvedByName })
                          : t('admin.sync_issues.resolved', 'Resolved')}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => retry(r)} disabled={busyId === r.id}>
                        {busyId === r.id ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                        {t('admin.sync_issues.retry')}
                      </Button>
                      {!r.resolved && (
                        <Button size="sm" variant="outline" onClick={() => resolve(r)} disabled={busyId === r.id} title={t('admin.sync_issues.resolve_tip', "Mark handled without retrying — reopens automatically if it fails again")}>
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          {t('admin.sync_issues.resolve', 'Resolve')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {shown.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-sm text-gray-400">{t('admin.sync_issues.no_matches')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
