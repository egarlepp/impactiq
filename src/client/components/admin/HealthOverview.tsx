import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  HeartPulse, CheckCircle2, AlertTriangle, XCircle, CircleSlash, RefreshCw, Timer, Database, CalendarClock, Layers,
  Plug, Mail, Sparkles, Server, ArrowRight, DatabaseBackup, Radar, Copy, Check, ChevronDown, ChevronRight,
} from 'lucide-react'
import { api } from '../../lib/api.js'
import { SingleSelect } from '../ui/single-select.js'
import type { HealthLine, HealthOverview as HealthOverviewData, HealthStatus, HealthTileId, ReadinessCalls } from '../../../shared/healthOverview.js'

// v1.440.0: System Health Overview at the top of App Health. One tile per
// area, computed server-side (services/health/overview.ts); this component
// only renders and refreshes it. Each tile links to the admin page that has
// the detail, so the overview never duplicates those pages.

type IconType = ComponentType<{ className?: string }>

const TILE_META: Record<HealthTileId, { Icon: IconType; section: string | null }> = {
  database: { Icon: Database, section: null },
  jobs: { Icon: CalendarClock, section: 'scheduling' },
  queues: { Icon: Layers, section: 'crm_sync' },
  integrations: { Icon: Plug, section: 'integrations' },
  email: { Icon: Mail, section: 'email_communications' },
  ai: { Icon: Sparkles, section: 'ai_assistant' },
  data: { Icon: DatabaseBackup, section: 'backup' },
  app: { Icon: Server, section: null },
}

const STATUS_STYLE: Record<HealthStatus, { card: string; icon: string; dot: string; text: string; watermark: string }> = {
  ok: {
    card: 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950',
    icon: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
    watermark: 'text-emerald-600/10 dark:text-emerald-400/10',
  },
  warning: {
    card: 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950',
    icon: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
    watermark: 'text-amber-600/10 dark:text-amber-400/10',
  },
  error: {
    card: 'border-rose-200 bg-rose-50 dark:border-rose-900/50 dark:bg-rose-950',
    icon: 'text-rose-600 dark:text-rose-400',
    dot: 'bg-rose-500',
    text: 'text-rose-700 dark:text-rose-300',
    watermark: 'text-rose-600/10 dark:text-rose-400/10',
  },
  off: {
    card: 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
    icon: 'text-gray-400 dark:text-gray-500',
    dot: 'bg-gray-300 dark:bg-gray-600',
    text: 'text-gray-500 dark:text-gray-400',
    watermark: 'text-gray-400/10 dark:text-gray-500/10',
  },
}

const STATUS_ICON: Record<HealthStatus, IconType> = { ok: CheckCircle2, warning: AlertTriangle, error: XCircle, off: CircleSlash }

const REFRESH_CHOICES = ['30', '60', '300', '0'] as const
const REFRESH_STORAGE_KEY = 'impactiq.healthOverview.refreshSec'

function readRefreshChoice(): string {
  try {
    const v = window.localStorage.getItem(REFRESH_STORAGE_KEY)
    return v && (REFRESH_CHOICES as readonly string[]).includes(v) ? v : '60'
  } catch {
    return '60'
  }
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`
  return `${(sec / 86400).toFixed(1)}d`
}

function fmtBytes(v: number): string {
  let b = v
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++ }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function useLineText() {
  const { t } = useTranslation()
  return (l: HealthLine): string => {
    const p: Record<string, string | number> = { ...(l.params ?? {}) }
    if (typeof p['queue'] === 'string') p['queue'] = t(`admin.health.queue.${p['queue']}`)
    if (typeof p['integration'] === 'string') p['integration'] = t(`admin.health.integration.${p['integration']}`)
    if (typeof p['table'] === 'string') p['table'] = t(`admin.health.retention_table.${p['table']}`)
    if (typeof p['ageSec'] === 'number') p['age'] = fmtDuration(p['ageSec'])
    if (typeof p['at'] === 'string') p['at'] = new Date(p['at']).toLocaleString()
    if (typeof p['bytes'] === 'number') p['size'] = fmtBytes(p['bytes'])
    if (typeof p['heapBytes'] === 'number') p['heap'] = fmtBytes(p['heapBytes'])
    return t(`admin.health.line.${l.key}`, p)
  }
}

// v1.444.0: a standing reminder to point a load balancer or uptime monitor at
// /ready, with what has called it on the server that answered. Collapsed once
// something has called it in the last day; never counted as a warning.
const READY_SEEN_WINDOW_MS = 24 * 60 * 60 * 1000

function ReadinessReminder({ readiness, now }: { readiness: ReadinessCalls; now: number }) {
  const { t } = useTranslation()
  const lastAt = readiness.lastCalledAt ? new Date(readiness.lastCalledAt).getTime() : null
  const seen = lastAt !== null && now - lastAt <= READY_SEEN_WINDOW_MS
  const [open, setOpen] = useState(!seen)
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/ready`
  const status: HealthStatus = seen ? 'ok' : 'warning'
  const s = STATUS_STYLE[status]
  const StatusIcon = STATUS_ICON[status]

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked: the URL is shown for manual copy */ }
  }

  const statusText = lastAt !== null
    ? t('admin.health.ready.last_called', { age: fmtDuration(Math.max(0, Math.round((now - lastAt) / 1000))), count: readiness.callsLast24h })
    : t('admin.health.ready.never_called', { age: fmtDuration(Math.max(0, Math.round((now - new Date(readiness.processStartedAt).getTime()) / 1000))) })
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
          <Chevron className="h-4 w-4 text-gray-400" />
          <Radar className="h-5 w-5 text-sky-600 dark:text-sky-400" />
          {t('admin.health.ready.title')}
        </span>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.card} ${s.text}`}>
          <StatusIcon className="h-3.5 w-3.5" /> {statusText}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <p>{t('admin.health.ready.intro')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">{url}</code>
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? t('admin.health.ready.copied') : t('admin.health.ready.copy')}
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400">{t('admin.health.ready.answers')}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/50 dark:bg-emerald-950">
              <p className="flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" /> {t('admin.health.ready.point_title')}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs">
                <li>{t('admin.health.ready.point_lb')}</li>
                <li>{t('admin.health.ready.point_proxy')}</li>
                <li>{t('admin.health.ready.point_uptime')}</li>
                <li>{t('admin.health.ready.point_k8s')}</li>
              </ul>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950">
              <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="h-4 w-4" /> {t('admin.health.ready.avoid_title')}</p>
              <p className="mt-1.5 text-xs">{t('admin.health.ready.avoid_body')}</p>
            </div>
          </div>
          {readiness.lastUserAgent && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(readiness.lastReady ? 'admin.health.ready.last_caller_ready' : 'admin.health.ready.last_caller_not_ready', { agent: readiness.lastUserAgent })}
            </p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.health.ready.per_server')}</p>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ status, count, title, sub }: { status: Exclude<HealthStatus, 'off'>; count: number; title: string; sub: string }) {
  const s = STATUS_STYLE[status]
  const Icon = STATUS_ICON[status]
  return (
    <div className={`relative overflow-hidden rounded-xl border p-5 ${s.card}`}>
      <Icon className={`pointer-events-none absolute -right-2 top-1/2 h-28 w-28 -translate-y-1/2 ${s.watermark}`} aria-hidden="true" />
      <p className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
        <Icon className={`h-5 w-5 ${s.icon}`} /> {title}
      </p>
      <p className={`mt-3 text-3xl font-bold leading-none ${s.text}`}>{count}</p>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{sub}</p>
    </div>
  )
}

export function HealthOverview() {
  const { t } = useTranslation()
  const lineText = useLineText()
  const [data, setData] = useState<HealthOverviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [refreshSec, setRefreshSec] = useState<string>(readRefreshChoice)
  const [now, setNow] = useState(() => Date.now())
  const requestId = useRef(0)

  const load = useCallback(() => {
    const id = ++requestId.current
    setLoading(true)
    api.get<HealthOverviewData>('/api/admin/health-overview')
      .then((res) => {
        if (id !== requestId.current) return
        setFailed(!res.data)
        if (res.data) setData(res.data)
        setLoadedAt(Date.now())
      })
      .finally(() => { if (id === requestId.current) setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  // One clock drives "updated Xs ago", the countdown and the refresh itself.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const intervalMs = Number(refreshSec) * 1000
  useEffect(() => {
    if (intervalMs > 0 && loadedAt !== null && !loading && now - loadedAt >= intervalMs) load()
  }, [now, intervalMs, loadedAt, loading, load])

  function chooseRefresh(next: string) {
    setRefreshSec(next)
    try { window.localStorage.setItem(REFRESH_STORAGE_KEY, next) } catch { /* per-viewer convenience only */ }
  }

  const tiles = data?.tiles ?? []
  const count = (s: HealthStatus) => tiles.filter((tile) => tile.status === s).length
  const overall: HealthStatus = count('error') > 0 ? 'error' : count('warning') > 0 ? 'warning' : 'ok'
  const OverallIcon = STATUS_ICON[overall]
  const sinceSec = loadedAt === null ? 0 : Math.max(0, Math.round((now - loadedAt) / 1000))
  const nextSec = intervalMs > 0 && loadedAt !== null ? Math.max(0, Math.ceil((loadedAt + intervalMs - now) / 1000)) : null

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300">
              <HeartPulse className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{t('admin.health.title')}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('admin.health.subtitle')}</p>
            </div>
          </div>
          {data && (
            <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[overall].card} ${STATUS_STYLE[overall].text}`}>
              <OverallIcon className="h-3.5 w-3.5" /> {t(`admin.health.overall.${overall}`)}
            </span>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
          <SummaryCard status="ok" count={count('ok')} title={t('admin.health.summary.healthy')} sub={t('admin.health.summary.healthy_sub')} />
          <SummaryCard status="warning" count={count('warning')} title={t('admin.health.summary.warnings')} sub={t('admin.health.summary.warnings_sub')} />
          <SummaryCard status="error" count={count('error')} title={t('admin.health.summary.errors')} sub={t('admin.health.summary.errors_sub')} />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-gray-500 dark:text-gray-400">
            {data
              ? t('admin.health.last_checked', { time: new Date(data.checkedAt).toLocaleString() })
              : t('admin.health.not_checked')}
            {failed && <span className="ml-2 text-rose-600 dark:text-rose-400">{t('admin.health.load_failed')}</span>}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {loadedAt !== null && <span className="text-gray-500 dark:text-gray-400">{t('admin.health.updated_ago', { age: fmtDuration(sinceSec) })}</span>}
            {nextSec !== null && <span className="text-xs text-gray-400 dark:text-gray-500">{t('admin.health.next_refresh', { age: fmtDuration(nextSec) })}</span>}
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> {t('admin.health.refresh_now')}
            </button>
            <SingleSelect
              label={t('admin.health.refresh_every')}
              labelIcon={Timer}
              value={refreshSec}
              onChange={chooseRefresh}
              options={REFRESH_CHOICES.map((v) => ({ value: v, label: t(`admin.health.refresh_choice.${v}`) }))}
            />
          </div>
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => {
            const meta = TILE_META[tile.id]
            const s = STATUS_STYLE[tile.status]
            return (
              <div key={tile.id} className={`relative flex flex-col overflow-hidden rounded-xl border p-4 ${s.card}`}>
                <meta.Icon className={`pointer-events-none absolute -right-3 top-1/2 h-24 w-24 -translate-y-1/2 ${s.watermark}`} aria-hidden="true" />
                <div className="flex items-start justify-between">
                  <meta.Icon className={`h-6 w-6 ${s.icon}`} />
                  <span className={`mt-1 h-2.5 w-2.5 rounded-full ${s.dot}`} title={t(`admin.health.status.${tile.status}`)} />
                </div>
                <p className="mt-3 font-semibold text-gray-900 dark:text-gray-100">{t(`admin.health.tile.${tile.id}`)}</p>
                <p className={`text-sm ${s.text}`}>{t(`admin.health.status.${tile.status}`)}</p>
                <ul className="mt-2 space-y-1">
                  {tile.lines.map((l, i) => (
                    <li key={`${l.key}-${i}`} className="flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLE[l.status].dot}`} aria-hidden="true" />
                      <span className="min-w-0 break-words">{lineText(l)}</span>
                    </li>
                  ))}
                </ul>
                {meta.section && (
                  <Link
                    to={`/admin?section=${meta.section}`}
                    className="relative mt-auto inline-flex items-center gap-1 pt-3 text-xs font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                  >
                    <ArrowRight className="h-3.5 w-3.5" /> {t(`admin.health.open.${tile.id}`)}
                  </Link>
                )}
              </div>
            )
          })}
        </div>
      )}

      {data?.readiness && <ReadinessReminder readiness={data.readiness} now={now} />}
    </section>
  )
}
