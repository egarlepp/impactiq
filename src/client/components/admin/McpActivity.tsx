import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, Clock, Activity, Timer, Gauge } from 'lucide-react'
import type { ComponentType } from 'react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'

interface Row {
  id: string
  calledAt: string
  tool: string
  status: 'ok' | 'error' | 'throttled'
  latencyMs: number | null
  error: string | null
  userId: string | null
  userEmail: string | null
  userName: string | null
  apiKeyId: string | null
  apiKeyName: string | null
  apiKeyPrefix: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function StatusPill({ status, t }: { status: string; t: any }) {
  if (status === 'ok') return <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400"><CheckCircle2 className="h-3.5 w-3.5" /> {t('admin.mcp_activity.status_ok', 'OK')}</span>
  if (status === 'error') return <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400"><XCircle className="h-3.5 w-3.5" /> {t('admin.mcp_activity.status_error', 'Error')}</span>
  return <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><Clock className="h-3.5 w-3.5" /> {t('admin.mcp_activity.status_throttled', 'Throttled')}</span>
}

export function McpActivity() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [statusF, setStatusF] = useState<'' | 'ok' | 'error' | 'throttled'>('')
  const [q, setQ] = useState('')

  async function reload() {
    setRows(null)
    const params = new URLSearchParams({ limit: '500' })
    if (statusF) params.set('status', statusF)
    const res = await api.get<Row[]>(`/api/admin/mcp-activity?${params.toString()}`)
    setRows(res.data ?? [])
  }
  useEffect(() => { void reload() }, [statusF])

  const filtered = useMemo(() => {
    if (!rows) return null
    const n = q.trim().toLowerCase()
    if (!n) return rows
    return rows.filter((r) =>
      r.tool.toLowerCase().includes(n) ||
      (r.userEmail ?? '').toLowerCase().includes(n) ||
      (r.userName ?? '').toLowerCase().includes(n) ||
      (r.error ?? '').toLowerCase().includes(n),
    )
  }, [rows, q])

  const stats = useMemo(() => {
    if (!rows) return null
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayRows = rows.filter((r) => new Date(r.calledAt) >= today)
    const ok = todayRows.filter((r) => r.status === 'ok').length
    const errs = todayRows.filter((r) => r.status === 'error').length
    const throttled = todayRows.filter((r) => r.status === 'throttled').length
    const latencies = todayRows.map((r) => r.latencyMs ?? 0).filter((n) => n > 0)
    const avgMs = latencies.length > 0 ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : 0
    return { total: todayRows.length, ok, errs, throttled, avgMs }
  }, [rows])

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('admin.mcp_activity.description', 'Every MCP tool invocation across the tenant. Retained 30 days.')}
      </p>

      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label={t('admin.mcp_activity.stat_total_today', 'Calls today')} value={String(stats.total)} Icon={Activity} />
          <StatCard label={t('admin.mcp_activity.stat_ok', 'OK')} value={String(stats.ok)} tone="ok" Icon={CheckCircle2} />
          <StatCard label={t('admin.mcp_activity.stat_error', 'Errors')} value={String(stats.errs)} tone="error" Icon={XCircle} />
          <StatCard label={t('admin.mcp_activity.stat_throttled', 'Throttled')} value={String(stats.throttled)} tone="warn" Icon={Timer} />
          <StatCard label={t('admin.mcp_activity.stat_avg_latency', 'Avg latency')} value={stats.avgMs > 0 ? `${stats.avgMs}ms` : '—'} Icon={Gauge} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)} className="rounded border border-gray-200 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800">
          <option value="">{t('admin.mcp_activity.filter_all_status', 'All statuses')}</option>
          <option value="ok">OK</option>
          <option value="error">Error</option>
          <option value="throttled">Throttled</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('admin.mcp_activity.search_placeholder', 'Tool, user, or error…')}
          className="flex-1 rounded border border-gray-200 bg-white px-3 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
      </div>

      {filtered === null && <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>}
      {filtered && filtered.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-500">{t('admin.mcp_activity.empty', 'No MCP calls recorded yet.')}</p>
      )}
      {filtered && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">{t('admin.mcp_activity.col_when', 'Called at')}</th>
                <th className="px-3 py-2 text-left">{t('admin.mcp_activity.col_user', 'User')}</th>
                <th className="px-3 py-2 text-left">{t('admin.mcp_activity.col_token', 'Token')}</th>
                <th className="px-3 py-2 text-left">{t('admin.mcp_activity.col_tool', 'Tool')}</th>
                <th className="px-3 py-2 text-left">{t('admin.mcp_activity.col_status', 'Status')}</th>
                <th className="px-3 py-2 text-left">{t('admin.mcp_activity.col_latency', 'Latency')}</th>
                <th className="px-3 py-2 text-left">{t('admin.mcp_activity.col_error', 'Error')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
                  <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-200">{new Date(r.calledAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <div className="text-gray-800 dark:text-gray-100">{r.userName ?? '—'}</div>
                    <div className="text-xs text-gray-500">{r.userEmail ?? ''}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-xs">{r.apiKeyName ?? '—'}</div>
                    <div className="font-mono text-[10px] text-gray-500">{r.apiKeyPrefix ?? ''}…</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-800 dark:text-gray-100">{r.tool}</td>
                  <td className="px-3 py-2"><StatusPill status={r.status} t={t} /></td>
                  <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-200">{r.latencyMs != null ? `${r.latencyMs}ms` : '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{r.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, tone, Icon }: { label: string; value: string; tone?: 'ok' | 'error' | 'warn'; Icon: ComponentType<{ className?: string }> }) {
  const c =
    tone === 'ok' ? { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-900 dark:text-emerald-100', chip: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/60 dark:text-emerald-300', wm: 'text-emerald-200 dark:text-emerald-800/50' } :
    tone === 'error' ? { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-900 dark:text-rose-100', chip: 'bg-rose-100 text-rose-600 dark:bg-rose-900/60 dark:text-rose-300', wm: 'text-rose-200 dark:text-rose-800/50' } :
    tone === 'warn' ? { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-900 dark:text-amber-100', chip: 'bg-amber-100 text-amber-600 dark:bg-amber-900/60 dark:text-amber-300', wm: 'text-amber-200 dark:text-amber-800/50' } :
    { bg: 'bg-gray-50 dark:bg-gray-800', text: 'text-gray-900 dark:text-gray-100', chip: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300', wm: 'text-gray-200 dark:text-gray-700/50' }
  return (
    <div className={`relative flex items-start gap-3 overflow-hidden rounded-xl border border-transparent p-4 ${c.bg}`}>
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${c.chip}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-[10px] font-semibold uppercase tracking-wide ${c.text}`}>{label}</p>
        <p className={`mt-0.5 text-xl font-bold tabular-nums ${c.text}`}>{value}</p>
      </div>
      <Icon className={`pointer-events-none absolute -right-1.5 -top-1.5 h-12 w-12 opacity-25 ${c.wm}`} />
    </div>
  )
}
