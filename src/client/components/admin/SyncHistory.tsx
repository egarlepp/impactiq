import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ArrowUp, ArrowDown, ChevronRight, ChevronDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { api } from '../../lib/api.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

type SyncSource = 'activity_writeback' | 'note_push' | 'field_prepend' | 'evaluation_field_update' | 'opportunity_field_update' | 'assigned_se_update'

interface Row {
  id: string
  source: SyncSource
  activityId: string | null
  attemptedAt: string
  status: 'success' | 'failed'
  operation: string
  crmObject: string | null
  crmRecordId: string | null
  errorMessage: string | null
  payload: Record<string, unknown> | null
  activityTitle: string | null
  startDatetime: string | null
  userId: string | null
  userEmail: string | null
  userName: string | null
  teamName: string | null
}

const SOURCE_LABEL_KEYS: Record<SyncSource, string> = {
  activity_writeback: 'admin.sync_history.source.activity_writeback',
  note_push: 'admin.sync_history.source.note_push',
  field_prepend: 'admin.sync_history.source.field_prepend',
  evaluation_field_update: 'admin.sync_history.source.evaluation_field_update',
  opportunity_field_update: 'admin.sync_history.source.opportunity_field_update',
  assigned_se_update: 'admin.sync_history.source.assigned_se_update',
}

type SortKey = 'attemptedAt' | 'userName' | 'activityTitle' | 'status'
type SortDir = 'asc' | 'desc'

// Cross-tenant view of every Salesforce write attempt in the app — the
// activity Event/Task writeback (Event write + attendee EventRelation
// write), plus (v1.259.0) note pushes, the Engineer Notes prepend-update,
// Assigned SE writes, and ad-hoc Opportunity/Evaluation field writes. Not
// every row traces back to one specific activity (see `source`) — those
// rows show their Salesforce object/record instead of an activity link.
// Retention is enforced by a 6-hourly cull.
export function SyncHistory() {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'' | 'success' | 'failed'>('')
  const [sourceFilter, setSourceFilter] = useState<'' | SyncSource>('')
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('attemptedAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 20

  const reload = async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    if (sourceFilter) params.set('source', sourceFilter)
    params.set('limit', '500')
    const res = await api.get<Row[]>(`/api/admin/sync-history?${params.toString()}`)
    setRows(res.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter, sourceFilter])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const base = needle
      ? rows.filter((r) =>
          (r.activityTitle ?? '').toLowerCase().includes(needle) ||
          (r.userEmail ?? '').toLowerCase().includes(needle) ||
          (r.userName ?? '').toLowerCase().includes(needle) ||
          (r.crmRecordId ?? '').toLowerCase().includes(needle) ||
          (r.errorMessage ?? '').toLowerCase().includes(needle),
        )
      : rows
    const dir = sortDir === 'asc' ? 1 : -1
    return [...base].sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }, [rows, q, sortKey, sortDir])

  // Reset to first page whenever filter/search/sort changes so users
  // don't get stuck on an empty page after narrowing results.
  useEffect(() => { setPage(0) }, [q, statusFilter, sortKey, sortDir])
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'attemptedAt' ? 'desc' : 'asc') }
  }

  const SortHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <button type="button" onClick={() => toggleSort(k)} className="flex items-center gap-1 text-left uppercase tracking-wide">
      {label}
      {sortKey === k && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        {/* v1.142.0: page title removed — PageHeader/Admin section nav
            already shows it; this was a duplicate. Description kept. */}
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('admin.sync_history.description', { context: crmCtx })}
        </p>
        <Button size="sm" variant="outline" onClick={reload} disabled={loading}>
          {loading ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-[1fr_180px_220px] gap-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
        <div className="flex flex-col gap-1">
          <Label>{t('admin.sync_history.filter_search', 'Search')}</Label>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.sync_history.filter_search_placeholder', 'Activity, user, or error…')} />
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.sync_history.filter_status', 'Status')}</Label>
          <Select value={statusFilter} onChange={(e) => setStatusFilter((e.target.value as '' | 'success' | 'failed') ?? '')}>
            <option value="">{t('common.all', 'All')}</option>
            <option value="success">{t('admin.sync_history.status_success', 'Success')}</option>
            <option value="failed">{t('admin.sync_history.status_failed', 'Failed')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.sync_history.filter_source', 'Source')}</Label>
          <Select value={sourceFilter} onChange={(e) => setSourceFilter((e.target.value as '' | SyncSource) ?? '')}>
            <option value="">{t('common.all', 'All')}</option>
            {(Object.keys(SOURCE_LABEL_KEYS) as SyncSource[]).map((s) => (
              <option key={s} value={s}>{t(SOURCE_LABEL_KEYS[s])}</option>
            ))}
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('admin.sync_history.empty', 'No sync attempts recorded.')}
        </p>
      ) : (
        <>
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="w-6 px-2 py-2"></th>
                <th className="px-3 py-2 text-left"><SortHeader label={t('admin.sync_history.col_status', 'Status')} k="status" /></th>
                <th className="px-3 py-2 text-left uppercase tracking-wide">{t('admin.sync_history.col_source', 'Source')}</th>
                <th className="px-3 py-2 text-left"><SortHeader label={t('admin.sync_history.col_user', 'User / Team')} k="userName" /></th>
                <th className="px-3 py-2 text-left"><SortHeader label={t('admin.sync_history.col_activity', 'Activity')} k="activityTitle" /></th>
                <th className="px-3 py-2 text-left uppercase tracking-wide">{t('admin.sync_history.col_operation', 'Operation')}</th>
                <th className="px-3 py-2 text-left uppercase tracking-wide">{t('admin.sync_history.col_error', 'Error')}</th>
                <th className="px-3 py-2 text-left"><SortHeader label={t('admin.sync_history.col_when', 'Attempted')} k="attemptedAt" /></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const open = expandedId === r.id
                return (
                  <>
                  <tr key={r.id} className="cursor-pointer border-t border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/40" onClick={() => setExpandedId(open ? null : r.id)}>
                    <td className="px-2 py-2 align-top text-gray-400">
                      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${r.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                        <span className="text-xs uppercase text-gray-700 dark:text-gray-200">{r.status}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-gray-600 dark:text-gray-400">
                      {t(SOURCE_LABEL_KEYS[r.source])}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{r.userName ?? '—'}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{r.userEmail ?? ''}</p>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500">{r.teamName ?? '—'}</p>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {r.activityId ? (
                        <>
                          <Link
                            to={`/activities?openActivityId=${encodeURIComponent(r.activityId)}&start=${encodeURIComponent(r.startDatetime ?? '')}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {r.activityTitle}
                          </Link>
                          <p className="text-[10px] font-mono text-gray-400 dark:text-gray-500">{r.activityId.slice(0, 8)}…</p>
                        </>
                      ) : (
                        <p className="text-gray-400 dark:text-gray-500">{t('admin.sync_history.no_activity', 'Not linked to an activity')}</p>
                      )}
                      {r.crmRecordId && <p className="text-[10px] font-mono text-gray-400 dark:text-gray-500">SF: {r.crmRecordId}</p>}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-gray-600 dark:text-gray-400">
                      {r.operation}
                      {r.crmObject && <span className="ml-1 text-gray-400">· {r.crmObject}</span>}
                    </td>
                    <td className="max-w-[320px] px-3 py-2 align-top text-xs">
                      {r.errorMessage
                        ? <span className="text-red-700 dark:text-red-300">{r.errorMessage}</span>
                        : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-gray-500 dark:text-gray-400">
                      {new Date(r.attemptedAt).toLocaleString()}
                    </td>
                  </tr>
                  {open && r.payload && (
                    <tr key={`${r.id}-payload`} className="border-t border-gray-100 dark:border-gray-800">
                      <td colSpan={8} className="bg-gray-50 px-3 py-2 dark:bg-gray-900">
                        <pre className="max-h-80 overflow-auto text-[11px] text-gray-800 dark:text-gray-200">{JSON.stringify(r.payload, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>
            {t('admin.sync_history.pagination_summary', {
              from: filtered.length === 0 ? 0 : page * PAGE_SIZE + 1,
              to: Math.min((page + 1) * PAGE_SIZE, filtered.length),
              total: filtered.length,
              defaultValue: '{{from}}–{{to}} of {{total}}',
            })}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              {t('common.prev', 'Prev')}
            </Button>
            <span>{page + 1} / {totalPages}</span>
            <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
              {t('common.next', 'Next')}
            </Button>
          </div>
        </div>
        </>
      )}
    </div>
  )
}
