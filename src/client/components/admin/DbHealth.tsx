import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Plug, Clock, Cpu, RefreshCw, AlertTriangle, GitBranch, PlayCircle, CheckCircle2 } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { SortableTh, TablePagination } from '../ui/table-controls.js'
import { useTableView } from '../../lib/tableView.js'
import { HealthOverview } from './HealthOverview.js'

interface TableRow {
  name: string
  rows: number | string | null
  seq_scan: number | string | null
  idx_scan: number | string | null
  total_bytes: number | string | null
  table_bytes: number | string | null
  index_bytes: number | string | null
}
interface SlowRow { query: string; calls: number | string; mean_ms: number | string; total_ms: number | string; rows: number | string }
interface MigrationStatus {
  appliedCount: number
  totalCount: number
  pending: number
  latestAppliedAt: string | null
  error: string | null
}
interface Payload {
  db: { sizeBytes: string | null; connectionsUsed: string | null; connectionsMax: number | null }
  tables: TableRow[]
  slowQueries: { available: boolean; rows: SlowRow[] }
  app: { uptimeSec: number; nodeVersion: string; rssBytes: number; heapUsedBytes: number }
  migrations: MigrationStatus
}

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

function fmtBytes(v: unknown): string {
  let b = n(v)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++ }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
function fmtNum(v: unknown): string { return n(v).toLocaleString() }
function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`
  return `${(sec / 86400).toFixed(1)}d`
}

// Health tone → card accent. Green = healthy, amber = watch, red = problem,
// slate = purely informational (no health judgement).
type Tone = 'good' | 'warn' | 'bad' | 'info'
const TONE: Record<Tone, { chip: string; val: string; ring: string; tint: string }> = {
  good: { chip: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/60 dark:text-emerald-300', val: 'text-emerald-700 dark:text-emerald-300', ring: 'border-emerald-200 dark:border-emerald-900/50', tint: 'bg-emerald-50 dark:bg-emerald-950' },
  warn: { chip: 'bg-amber-100 text-amber-600 dark:bg-amber-900/60 dark:text-amber-300', val: 'text-amber-700 dark:text-amber-300', ring: 'border-amber-200 dark:border-amber-900/50', tint: 'bg-amber-50 dark:bg-amber-950' },
  bad: { chip: 'bg-rose-100 text-rose-600 dark:bg-rose-900/60 dark:text-rose-300', val: 'text-rose-700 dark:text-rose-300', ring: 'border-rose-200 dark:border-rose-900/50', tint: 'bg-rose-50 dark:bg-rose-950' },
  info: { chip: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300', val: 'text-gray-900 dark:text-gray-100', ring: 'border-gray-200 dark:border-gray-700', tint: 'bg-white dark:bg-gray-800' },
}

function StatCard({ label, value, sub, Icon, tone = 'info' }: { label: string; value: string; sub?: string; Icon: React.ComponentType<{ className?: string }>; tone?: Tone }) {
  const c = TONE[tone]
  return (
    <div className={`relative flex items-start gap-3 overflow-hidden rounded-xl border p-4 ${c.ring} ${c.tint}`}>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${c.chip}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
        <p className={`mt-1 text-xl font-bold leading-tight ${c.val}`}>{value}</p>
        {sub && <p className="text-[11px] text-gray-400 dark:text-gray-500">{sub}</p>}
      </div>
    </div>
  )
}

// v1.440.0: the System Health Overview sits above the database detail and
// loads on its own, so it shows even while the table stats are loading.
export function DbHealth() {
  return (
    <div className="space-y-6">
      <HealthOverview />
      <DbStats />
    </div>
  )
}

function DbStats() {
  const { t } = useTranslation()
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [runningMigrations, setRunningMigrations] = useState(false)
  const [migrationsRanMessage, setMigrationsRanMessage] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.get<Payload>('/api/admin/db-health')
      .then((res) => setData(res.data ?? null))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  // v1.255.2: runMigrations() already runs on every server boot (see
  // src/server/index.ts), but a long-running dev process doesn't reboot on
  // its own just because a new migration file landed on disk — this button
  // triggers the exact same function without needing a restart.
  async function runPendingMigrations() {
    setRunningMigrations(true)
    setMigrationsRanMessage(null)
    const res = await api.post<MigrationStatus>('/api/admin/run-migrations', {})
    setRunningMigrations(false)
    if (res.data) {
      setMigrationsRanMessage(
        res.data.pending > 0
          ? t('admin.db_health.migrations_ran_still_pending', '{{count}} still pending — check the server logs for the error.', { count: res.data.pending })
          : t('admin.db_health.migrations_ran_ok', 'Up to date — {{count}} migration(s) applied.', { count: res.data.appliedCount }),
      )
    }
    load()
  }

  // Sortable/searchable Tables grid via the shared admin table helper. Numeric
  // getters return the raw number as a string so localeCompare(numeric) sorts
  // by value, not by the formatted label.
  const tableGetters = useMemo(() => ({
    name: (r: TableRow) => r.name,
    rows: (r: TableRow) => String(n(r.rows)),
    total: (r: TableRow) => String(n(r.total_bytes)),
    indexes: (r: TableRow) => String(n(r.index_bytes)),
    seq: (r: TableRow) => String(n(r.seq_scan)),
    idx: (r: TableRow) => String(n(r.idx_scan)),
  }), [])
  const tView = useTableView(data?.tables ?? [], tableGetters, { pageSize: 25 })

  if (loading && !data) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>
  if (!data) return <p className="py-12 text-center text-sm text-gray-400">{t('admin.db_health.empty', 'No data.')}</p>

  // A table read mostly via sequential scans is only a missing-index signal
  // once it's big enough that a scan is actually costly. Small tables (config,
  // lookups) are correctly seq-scanned by Postgres — don't flag them, or every
  // tiny table lights up. Requires meaningful row count AND scan traffic.
  const SEQ_MIN_ROWS = 2000
  const seqHeavy = (r: TableRow) => n(r.rows) >= SEQ_MIN_ROWS && n(r.seq_scan) > 50 && n(r.seq_scan) > n(r.idx_scan) * 4

  // Card health tones (green/amber/red). DB size is deploy-relative so it's
  // informational; connections/memory/uptime carry a real health judgement.
  const gb = (bytes: unknown) => n(bytes) / 1e9
  const dbTone: Tone = gb(data.db.sizeBytes) >= 20 ? 'bad' : gb(data.db.sizeBytes) >= 5 ? 'warn' : 'good'
  const connRatio = n(data.db.connectionsMax) > 0 ? n(data.db.connectionsUsed) / n(data.db.connectionsMax) : 0
  const connTone: Tone = connRatio >= 0.9 ? 'bad' : connRatio >= 0.7 ? 'warn' : 'good'
  const rssGb = data.app.rssBytes / 1e9
  const memTone: Tone = rssGb >= 1.5 ? 'bad' : rssGb >= 0.9 ? 'warn' : 'good'
  const uptimeTone: Tone = data.app.uptimeSec < 120 ? 'warn' : 'good' // just-restarted

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('admin.db_health.subtitle', 'Live Postgres size, traffic and query health.')}</p>
        <button
          type="button"
          onClick={load}
          className="flex shrink-0 items-center gap-1.5 rounded border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('admin.db_health.refresh', 'Refresh')}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard tone={dbTone} label={t('admin.db_health.db_size', 'Database Size')} value={fmtBytes(data.db.sizeBytes)} Icon={Database} />
        <StatCard tone={connTone} label={t('admin.db_health.connections', 'Connections')} value={`${fmtNum(data.db.connectionsUsed)} / ${fmtNum(data.db.connectionsMax)}`} Icon={Plug} />
        <StatCard tone={uptimeTone} label={t('admin.db_health.uptime', 'App Uptime')} value={fmtUptime(data.app.uptimeSec)} sub={data.app.nodeVersion} Icon={Clock} />
        <StatCard tone={memTone} label={t('admin.db_health.memory', 'App Memory (RSS)')} value={fmtBytes(data.app.rssBytes)} sub={`${t('admin.db_health.heap', 'Heap')} ${fmtBytes(data.app.heapUsedBytes)}`} Icon={Cpu} />
      </div>

      {/* v1.255.2: runMigrations() already runs on every server boot, but a
          long-running dev/preview process doesn't restart itself just
          because a new migration file landed on disk — this is the
          concrete "why isn't my new feature showing" answer, with a
          one-click fix right here instead of a guess. */}
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ${data.migrations.error ? 'border-rose-200 bg-rose-50 dark:border-rose-900/50 dark:bg-rose-950/30' : data.migrations.pending > 0 ? 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30' : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'}`}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            <GitBranch className="h-4.5 w-4.5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.db_health.migrations_title', 'Database Migrations')}</p>
            {data.migrations.error ? (
              <p className="text-xs text-rose-700 dark:text-rose-300">{t('admin.db_health.migrations_error', 'Could not read migration status: {{error}}', { error: data.migrations.error })}</p>
            ) : data.migrations.pending > 0 ? (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {t('admin.db_health.migrations_pending', '{{applied}} of {{total}} applied — {{pending}} pending. New features or seed data from those won\'t show until they run.', { applied: data.migrations.appliedCount, total: data.migrations.totalCount, pending: data.migrations.pending })}
              </p>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('admin.db_health.migrations_ok', 'Up to date — {{count}} applied.', { count: data.migrations.appliedCount })}
                {data.migrations.latestAppliedAt && ` ${t('admin.db_health.migrations_latest', 'Last applied {{time}}.', { time: new Date(data.migrations.latestAppliedAt).toLocaleString() })}`}
              </p>
            )}
            {migrationsRanMessage && <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />{migrationsRanMessage}</p>}
          </div>
        </div>
        <Button size="sm" variant={data.migrations.pending > 0 ? 'default' : 'outline'} onClick={() => void runPendingMigrations()} disabled={runningMigrations}>
          {runningMigrations ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <PlayCircle className="mr-1 h-3.5 w-3.5" />}
          {t('admin.db_health.run_migrations', 'Run Pending Migrations')}
        </Button>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('admin.db_health.tables', 'Tables by size')}</h3>
          <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {t('admin.db_health.legend', 'Amber = a sizeable table read mostly via sequential scans — likely benefits from an index. Small tables are scanned by design and are not flagged.')}
          </span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <SortableTh label={t('admin.db_health.col_table', 'Table')} colKey="name" sortKey={tView.sortKey} sortDir={tView.sortDir} onToggle={tView.toggleSort} filterValue={tView.filters.name} onFilter={(v) => tView.setFilter('name', v)} filterPlaceholder={t('common.search_placeholder')} />
                <SortableTh label={t('admin.db_health.col_rows', 'Rows')} colKey="rows" align="right" sortKey={tView.sortKey} sortDir={tView.sortDir} onToggle={tView.toggleSort} />
                <SortableTh label={t('admin.db_health.col_total', 'Total')} colKey="total" align="right" sortKey={tView.sortKey} sortDir={tView.sortDir} onToggle={tView.toggleSort} />
                <SortableTh label={t('admin.db_health.col_indexes', 'Indexes')} colKey="indexes" align="right" sortKey={tView.sortKey} sortDir={tView.sortDir} onToggle={tView.toggleSort} />
                <SortableTh label={t('admin.db_health.col_seq', 'Seq scans')} colKey="seq" align="right" sortKey={tView.sortKey} sortDir={tView.sortDir} onToggle={tView.toggleSort} />
                <SortableTh label={t('admin.db_health.col_idx', 'Index scans')} colKey="idx" align="right" sortKey={tView.sortKey} sortDir={tView.sortDir} onToggle={tView.toggleSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {tView.visible.map((r) => (
                <tr key={r.name} className={seqHeavy(r) ? 'bg-amber-50 dark:bg-amber-950/30' : ''}>
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-800 dark:text-gray-200">
                    {seqHeavy(r) && <AlertTriangle className="mr-1 inline h-3 w-3 text-amber-500" />}{r.name}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.rows)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtBytes(r.total_bytes)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fmtBytes(r.index_bytes)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.seq_scan)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.idx_scan)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TablePagination page={tView.page} totalPages={tView.totalPages} onPageChange={tView.setPage} />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">{t('admin.db_health.slow', 'Slowest queries')}</h3>
        {!data.slowQueries.available ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('admin.db_health.no_pgss', 'The pg_stat_statements extension is not enabled, so per-query timings are unavailable. Enable it in postgresql.conf (shared_preload_libraries) and run CREATE EXTENSION pg_stat_statements to see the slowest queries here.')}</span>
          </div>
        ) : data.slowQueries.rows.length === 0 ? (
          <p className="text-sm text-gray-400">{t('admin.db_health.no_slow', 'No query stats collected yet.')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2">{t('admin.db_health.col_query', 'Query')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.db_health.col_calls', 'Calls')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.db_health.col_mean', 'Mean ms')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.db_health.col_totalms', 'Total ms')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.slowQueries.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="max-w-md truncate px-3 py-1.5 font-mono text-[11px] text-gray-700 dark:text-gray-300" title={r.query}>{r.query}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.calls)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.mean_ms)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.total_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
