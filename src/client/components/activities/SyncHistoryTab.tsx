import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.416.0: the Sync History tab, moved unchanged out of ActivityForm.tsx.

export interface SyncAuditRow {
  id: string
  activityId: string
  attemptedAt: string
  status: 'success' | 'failed'
  operation: 'create' | 'update' | 'skipped'
  crmObject: string | null
  crmRecordId: string | null
  errorMessage: string | null
  payload: Record<string, unknown> | null
}

// Salesforce sync history for a single activity. Last 5 days, newest first —
// server enforces the retention on every write attempt.
export function SyncHistoryTab({ activityId, onCountChange }: { activityId: string; onCountChange?: (count: number) => void }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [rows, setRows] = useState<SyncAuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [resyncing, setResyncing] = useState(false)

  const reload = () => {
    setLoading(true)
    api.get<SyncAuditRow[]>(`/api/activities/${activityId}/sync-audit`).then((res) => {
      const data = res.data ?? []
      setRows(data)
      setLoading(false)
      onCountChange?.(data.length)
    })
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.get<SyncAuditRow[]>(`/api/activities/${activityId}/sync-audit`).then((res) => {
      if (cancelled) return
      const data = res.data ?? []
      setRows(data)
      setLoading(false)
      onCountChange?.(data.length)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId])

  async function forceResync() {
    if (!window.confirm(t('activity.form.resync_confirm', { context: crmCtx }))) return
    setResyncing(true)
    await api.post(`/api/activities/${activityId}/resync`, {})
    // Wait a moment for the worker to run before refetching
    window.setTimeout(() => { setResyncing(false); reload() }, 2000)
  }

  const header = (
    <div className="mb-2 flex items-center justify-between">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('activity.form.sync_history_hint', { context: crmCtx })}
      </p>
      <Button
        size="icon"
        variant="outline"
        onClick={() => void forceResync()}
        disabled={resyncing}
        title={t('activity.form.resync_tooltip', { context: crmCtx })}
        aria-label={t('activity.form.resync_button', 'Re-sync')}
      >
        {resyncing ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
  if (rows.length === 0) {
    return (
      <div>
        {header}
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('activity.form.sync_history_empty', { context: crmCtx })}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {header}
      {rows.map((r) => {
        const isOpen = expandedId === r.id
        return (
          <div key={r.id} className="rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <button
              type="button"
              onClick={() => setExpandedId(isOpen ? null : r.id)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left"
            >
              <span className={`mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full ${r.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold uppercase text-gray-700 dark:text-gray-200">
                    {r.status === 'success' ? t('activity.form.sync_success', 'Success') : t('activity.form.sync_failed', 'Failed')}
                  </span>
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">{r.operation}</span>
                  {r.crmObject && <span className="text-[11px] text-gray-500 dark:text-gray-400">· {r.crmObject}</span>}
                  <span className="ml-auto text-[11px] text-gray-500 dark:text-gray-400">{new Date(r.attemptedAt).toLocaleString()}</span>
                </div>
                {r.crmRecordId && (
                  <p className="mt-0.5 font-mono text-[11px] text-gray-600 dark:text-gray-300">SF Id: {r.crmRecordId}</p>
                )}
                {r.errorMessage && (
                  <p className="mt-0.5 text-xs text-red-700 dark:text-red-300">{r.errorMessage}</p>
                )}
              </div>
            </button>
            {isOpen && r.payload && (
              <pre className="max-h-64 overflow-auto border-t border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-800 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
                {JSON.stringify(r.payload, null, 2)}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}
