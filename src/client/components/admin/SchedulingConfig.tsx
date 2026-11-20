import { Fragment, useEffect, useRef, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, Clock, Power, PowerOff, Pencil, Save, X, PlayCircle, HelpCircle, BellOff, AlertOctagon, Hourglass, Plug, PlugZap, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, ListFilter, Eraser } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { SingleSelect } from '../ui/single-select.js'
import { TablePagination } from '../ui/table-controls.js'
import { JOB_CATEGORIES, RECENT_RUN_LIMITS, jobCategory, type JobCategory, type RecentRunLimit } from '../../../shared/jobCategories.js'
import { cn } from '../../lib/utils.js'

interface JobRegistryEntry {
  jobKey: string
  cadence: string
  description: string
  cadenceEditable: boolean
  defaultIntervalMs: number | null
  // v1.230.0: independent of cadenceEditable — the two clock-gated jobs
  // (digest_worker, weekly_recap_worker) have a fixed tick interval but an
  // admin-editable local send time.
  scheduleEditable?: boolean
  scheduleKind?: 'daily' | 'weekly'
  defaultScheduleHour?: number
  defaultScheduleMinute?: number
  defaultScheduleDayOfWeek?: number
  // v1.231.0: the Communications rule this job's regular (non-error) email
  // actually sends through, when it sends one as part of its schedule.
  emailRuleKey?: string
  emailRuleName?: string
  // v1.438.0: the integration this job is still waiting for (null = ready).
  // A waiting job doesn't run until it's connected.
  waitingFor?: string | null
}
interface JobLatest { job_key: string; started_at: string; finished_at: string | null; duration_ms: number | null; status: string; message: string | null }
interface JobRun {
  id: string
  jobKey: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  status: string
  message: string | null
  // v1.273.0: refresh_opp_snapshots stamps { source: 'manual' | 'scheduled' }
  // here so a leader's "Refresh from Salesforce" click is distinguishable
  // from the job's own 24h cadence. Other jobs don't set this.
  detail?: { source?: 'manual' | 'scheduled' } | null
}
interface JobConfig {
  jobKey: string
  notifyOnError: boolean
  enabled: boolean
  intervalMs: number | null
  scheduleHour: number | null
  scheduleMinute: number | null
  scheduleDayOfWeek: number | null
}

interface Payload {
  registry: JobRegistryEntry[]
  latest: JobLatest[]
  recent: JobRun[]
  config: JobConfig[]
  // v1.231.0: the single Communications rule every job's error-toggle emails
  // through, regardless of which job tripped it.
  errorEmailRule?: { key: string; name: string }
  // v1.437.0: the registry lists only this CRM's jobs (none with 'none').
  activeCrm?: 'salesforce' | 'hubspot' | 'none'
  // v1.330.0: the `recent` list above is capped at 20 rows total across
  // every job, not enough to count reliably — this is a dedicated
  // count(*) from the server. Backs the KPI row's "Failed Runs (7d)" card.
  failedRuns7d?: number
  // v1.439.0: how many runs `recent` holds (20, 50 or 100).
  recentLimit?: number
  // v1.441.0: Recent runs is paged; recentTotal counts every listed run.
  recentPage?: number
  recentTotal?: number
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

// Whole-unit interval label for the "Default: …" caption — seconds up to a
// minute, minutes up to an hour, hours beyond that. Cadences in this app
// only ever land on one of those three scales (30s pollers, 24h refreshers).
function fmtIntervalMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / (60 * 60_000))}h`
}

// Sunday-indexed (0=Sun…6=Sat), matching Date#getDay() and job_config's
// schedule_day_of_week column.
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function fmtHm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// v1.329.0: format a minutes-from-now ETA for the Run Now countdown — caps
// at two units (e.g. "1d 4h", "2h 14m", "38m") since sub-minute precision
// isn't meaningful here (the digest/recap workers only tick every 60s/5min).
function fmtEtaMinutes(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes))
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const remMins = mins % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (parts.length < 2 && (remMins > 0 || parts.length === 0)) parts.push(`${remMins}m`)
  return parts.join(' ')
}

// v1.329.0: live-ticking "next possible send" countdown shown under the Run
// Now noop pill — targetAt is a fixed epoch ms computed once from the
// server's real per-user ETA (see getNextDigestEtaMinutes /
// getNextWeeklyRecapEtaMinutes), not re-derived client-side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function NextEtaCountdown({ targetAt, t }: { targetAt: number; t: any }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  const remainingMs = targetAt - Date.now()
  if (remainingMs <= 0) {
    return <span className="text-[11px] text-amber-700 dark:text-amber-400">{t('admin.scheduling.run_now_eta_due', 'due any moment')}</span>
  }
  return (
    <span className="text-[11px] text-amber-700 dark:text-amber-400">
      {t('admin.scheduling.run_now_eta', 'next possible send in {{time}}', { time: fmtEtaMinutes(remainingMs / 60_000) })}
    </span>
  )
}

// v1.330.0: same small bordered card used on CRM Sync / Nudge History /
// Login History / Audit Log. Duplicated locally rather than shared, matching
// this codebase's existing convention for this component.
function StatCard({
  icon: Icon,
  label,
  value,
  subLabel,
  subValue,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  subLabel?: string
  subValue?: string
  tone: 'good' | 'warn' | 'bad' | 'info'
}) {
  const TONE = {
    good: 'border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-100',
    warn: 'border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100',
    bad: 'border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/25 dark:text-rose-100',
    info: 'border-gray-200 bg-gray-50/60 text-gray-900 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-100',
  }[tone]
  const CHIP = {
    good: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300',
    bad: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300',
    info: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  }[tone]
  return (
    <div className={cn('relative overflow-hidden rounded-lg border p-3', TONE)}>
      <Icon className="pointer-events-none absolute -right-2 -top-2 h-16 w-16 opacity-10" />
      <div className="relative">
        <div className={cn('mb-1 inline-flex rounded-md p-1.5', CHIP)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <p className="text-[11px] uppercase tracking-wide opacity-75">{label}</p>
        <p className="truncate text-xl font-semibold" title={value}>{value}</p>
        {subLabel && (
          <p className="mt-0.5 text-[11px] opacity-75">{subLabel}: <span className="font-medium">{subValue}</span></p>
        )}
      </div>
    </div>
  )
}

// v1.141.0: shared status pill so the top table and the Recent-runs table
// render errors the same way — colored icon + label instead of the raw
// enum string.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function StatusPill({ status, t }: { status: string; t: any }) {
  if (status === 'ok') return <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400"><CheckCircle2 className="h-3.5 w-3.5" /> {t('admin.scheduling.status_ok', 'OK')}</span>
  if (status === 'error') return <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400"><XCircle className="h-3.5 w-3.5" /> {t('admin.scheduling.status_error', 'Error')}</span>
  return <span className="inline-flex items-center gap-1 text-gray-500"><Clock className="h-3.5 w-3.5" /> {t('admin.scheduling.status_never_run', 'Never run')}</span>
}

export function SchedulingConfig() {
  const { t } = useTranslation()
  const [data, setData] = useState<Payload | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  // v1.283.0: "Run now" — running/result state per job, so a click on one
  // row's button never disables another row's.
  const [runningJob, setRunningJob] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<Record<string, 'ok' | 'noop' | 'busy' | 'error'>>({})
  // v1.329.0: target epoch ms for the noop-case countdown, keyed by jobKey —
  // only ever set for the two clock-gated jobs, and only when the server's
  // real per-user ETA computation found an eligible user to measure from.
  const [runEta, setRunEta] = useState<Record<string, number>>({})
  // v1.439.0: jobs are grouped by category, all collapsed on load.
  const [expanded, setExpanded] = useState<Set<JobCategory>>(() => new Set())
  // v1.439.0: Recent runs shows the last 20, 50 or 100.
  const [recentLimit, setRecentLimit] = useState<RecentRunLimit>(20)
  const [recentPage, setRecentPage] = useState(1)
  const [clearingRuns, setClearingRuns] = useState(false)
  // Only the latest request may set data, so a slow reply for an older
  // Recent-runs limit can't overwrite a newer one.
  const requestSeq = useRef(0)

  async function reload() {
    const seq = ++requestSeq.current
    const res = await api.get<Payload>(`/api/admin/scheduling?recent=${recentLimit}&recentPage=${recentPage}`)
    if (res.data && seq === requestSeq.current) {
      setData(res.data)
      // A Clear or retention cull can leave this page past the end.
      if (res.data.recent.length === 0 && recentPage > 1) setRecentPage(1)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload() }, [recentLimit, recentPage])

  if (!data) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>

  const latestByKey = new Map(data.latest.map((l) => [l.job_key, l] as const))
  const configByKey = new Map(data.config.map((c) => [c.jobKey, c] as const))

  // v1.330.0: KPI row. Everything except failedRuns7d is derived from the
  // same registry/latest/config payload already on the page — no extra
  // fetch needed. historical_backfill is admin-triggered, never scheduled
  // (CLAUDE.md §14), so it's excluded from "Never Run" — it genuinely never
  // runs on its own and that's correct, not a gap.
  // v1.438.0: a job waiting for setup doesn't run, so an old error or a
  // missing run isn't counted against it.
  const waitingKeys = new Set(data.registry.filter((r) => r.waitingFor).map((r) => r.jobKey))
  const jobsInError = data.latest.filter((l) => l.status === 'error' && !waitingKeys.has(l.job_key)).length
  const jobsDisabled = data.registry.filter((r) => configByKey.get(r.jobKey)?.enabled === false).length
  const jobsNeverRun = data.registry.filter((r) => r.jobKey !== 'historical_backfill' && !r.waitingFor && !latestByKey.has(r.jobKey)).length
  const jobsNoAlert = data.registry.filter((r) => !(configByKey.get(r.jobKey)?.notifyOnError ?? false)).length
  const failedRuns7d = data.failedRuns7d ?? 0

  // v1.439.0: jobs grouped by category, in JOB_CATEGORIES order; empty
  // categories aren't shown. A category "has an issue" when any of its jobs'
  // latest run is an error (the same rule as the Jobs in Error card), so its
  // name turns red.
  const groups = JOB_CATEGORIES
    .map((category) => {
      const jobs = data.registry.filter((r) => jobCategory(r.jobKey) === category)
      const errorCount = jobs.filter((r) => !r.waitingFor && latestByKey.get(r.jobKey)?.status === 'error').length
      // v1.441.0: active = turned on and set up, so it runs; inactive = turned
      // off, or still waiting for its integration (Not set up).
      const activeCount = jobs.filter((r) => !r.waitingFor && configByKey.get(r.jobKey)?.enabled !== false).length
      return { category, jobs, errorCount, activeCount, inactiveCount: jobs.length - activeCount }
    })
    .filter((g) => g.jobs.length > 0)
  const allExpanded = groups.length > 0 && groups.every((g) => expanded.has(g.category))

  function toggleCategory(category: JobCategory) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  const recentTotal = data.recentTotal ?? data.recent.length
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / (data.recentLimit ?? recentLimit)))

  async function clearRecentRuns() {
    if (!window.confirm(t('admin.scheduling.recent_clear_confirm'))) return
    setClearingRuns(true)
    await api.post('/api/admin/scheduling/recent-runs/clear', {})
    setClearingRuns(false)
    if (recentPage === 1) void reload()
    else setRecentPage(1)
  }

  function toggleAll() {
    setExpanded(allExpanded ? new Set() : new Set(groups.map((g) => g.category)))
  }

  async function patchJob(jobKey: string, body: Record<string, unknown>) {
    setSaving(jobKey)
    await api.patch(`/api/admin/scheduling/${jobKey}`, body)
    setSaving(null)
    void reload()
  }

  async function runNow(jobKey: string) {
    setRunningJob(jobKey)
    setRunResult((r) => { const { [jobKey]: _drop, ...rest } = r; return rest })
    setRunEta((r) => { const { [jobKey]: _drop, ...rest } = r; return rest })
    const res = await api.post<{ ran: boolean; recordedNewRun: boolean; alreadyRunning?: boolean; nextEtaMinutes: number | null }>(`/api/admin/scheduling/${jobKey}/run-now`, {})
    setRunningJob(null)
    // v1.328.0: digest_worker/weekly_recap_worker only write a job_runs row
    // when their clock-gated check actually sends something — clicking Run
    // Now outside the scheduled window (or after everyone already got
    // today's/this week's send) genuinely does nothing, which used to look
    // identical to "ran successfully" (a plain checkmark either way). The
    // server now reports whether a new run was actually recorded so this
    // can be shown honestly instead of implying success either way.
    // v1.414.0: 'busy' = the job was already running, here or on another
    // replica, so this click didn't start a second copy.
    const result = res.error ? 'error' : res.data?.alreadyRunning ? 'busy' : res.data?.recordedNewRun === false ? 'noop' : 'ok'
    setRunResult((r) => ({ ...r, [jobKey]: result }))
    // v1.329.0: on a noop, the server also computes the real next-user ETA
    // (each enabled user's own local send time) — capture it as a fixed
    // target instant so the countdown ticks down from a stable point rather
    // than being recomputed (and drifting) on every render.
    if (result === 'noop' && res.data?.nextEtaMinutes != null) {
      setRunEta((r) => ({ ...r, [jobKey]: Date.now() + res.data!.nextEtaMinutes! * 60_000 }))
    }
    void reload()
  }

  return (
    <div className="space-y-6">
      {/* v1.142.0: page title removed — duplicated the Admin section nav
          header. Description kept. v1.227.0: no longer purely read-only. */}
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('admin.scheduling.description', 'Background jobs registered in this app. Turn a job off, or change how often it runs, where the cadence icon shows it’s editable.')}
      </p>
      {data.activeCrm && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Plug className="h-3.5 w-3.5 shrink-0" />
          {data.activeCrm === 'none'
            ? t('admin.scheduling.crm_jobs_none')
            : t('admin.scheduling.crm_jobs_active')}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          icon={XCircle}
          label={t('admin.scheduling.kpi_jobs_in_error', 'Jobs in Error')}
          value={String(jobsInError)}
          tone={jobsInError > 0 ? 'bad' : 'good'}
        />
        <StatCard
          icon={PowerOff}
          label={t('admin.scheduling.kpi_jobs_disabled', 'Jobs Disabled')}
          value={String(jobsDisabled)}
          tone={jobsDisabled > 0 ? 'warn' : 'good'}
        />
        <StatCard
          icon={HelpCircle}
          label={t('admin.scheduling.kpi_never_run', 'Never Run')}
          value={String(jobsNeverRun)}
          tone={jobsNeverRun > 0 ? 'warn' : 'good'}
        />
        <StatCard
          icon={BellOff}
          label={t('admin.scheduling.kpi_no_alert', 'No Error-Alert Configured')}
          value={String(jobsNoAlert)}
          tone={jobsNoAlert > 0 ? 'warn' : 'good'}
        />
        <StatCard
          icon={AlertOctagon}
          label={t('admin.scheduling.kpi_failed_runs', 'Failed Runs (7d)')}
          value={String(failedRuns7d)}
          tone={failedRuns7d > 0 ? 'bad' : 'good'}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center">
          <button
            type="button"
            onClick={toggleAll}
            disabled={groups.length === 0}
            title={allExpanded ? t('admin.scheduling.collapse_all') : t('admin.scheduling.expand_all')}
            aria-label={allExpanded ? t('admin.scheduling.collapse_all') : t('admin.scheduling.expand_all')}
            className="flex h-7 w-8 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_job', 'Job')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_active', 'Active')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_cadence', 'Cadence')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_send_window', 'Send Window')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_last_run', 'Last run')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_duration', 'Duration')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_status', 'Status')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_notify', 'Email admins on error')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_message', 'Message')}</th>
              <th className="px-3 py-2 text-left">{t('admin.scheduling.col_run_now', 'Run now')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = expanded.has(g.category)
              const name = t(`admin.scheduling.category.${g.category}`)
              return (
                <Fragment key={g.category}>
                  <tr className="border-b border-gray-100 bg-gray-50/60 dark:border-gray-900 dark:bg-gray-900/40">
                    <td colSpan={10} className="p-0">
                      <button
                        type="button"
                        onClick={() => toggleCategory(g.category)}
                        aria-expanded={open}
                        title={g.errorCount > 0 ? t('admin.scheduling.category_errors', { n: g.errorCount }) : undefined}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/60"
                      >
                        {open
                          ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                          : <ChevronRight className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />}
                        {g.errorCount > 0 && <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />}
                        <span className={cn('flex-1 font-semibold', g.errorCount > 0 ? 'text-rose-700 dark:text-rose-400' : 'text-gray-900 dark:text-gray-100')}>
                          {name}
                        </span>
                        <span
                          className="inline-flex items-center overflow-hidden rounded-full border border-gray-200 text-xs font-medium tabular-nums dark:border-gray-700"
                          title={t('admin.scheduling.category_active_title', { active: g.activeCount, inactive: g.inactiveCount })}
                        >
                          <span className={cn('inline-flex items-center gap-1 px-2 py-0.5', g.activeCount > 0 ? 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400' : 'bg-gray-50 text-gray-400 dark:bg-gray-800/60 dark:text-gray-500')}>
                            <Power className="h-3 w-3" />
                            {t('admin.scheduling.category_active', { n: g.activeCount })}
                          </span>
                          <span className={cn('inline-flex items-center gap-1 px-2 py-0.5', g.inactiveCount > 0 ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400' : 'bg-gray-50 text-gray-400 dark:bg-gray-800/60 dark:text-gray-500')}>
                            <PowerOff className="h-3 w-3" />
                            {t('admin.scheduling.category_inactive', { n: g.inactiveCount })}
                          </span>
                        </span>
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium tabular-nums text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                          {g.jobs.length}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {open && g.jobs.map((r) => (
                    <JobRow
                      key={r.jobKey}
                      entry={r}
                      latest={latestByKey.get(r.jobKey)}
                      config={configByKey.get(r.jobKey)}
                      saving={saving === r.jobKey}
                      onPatch={(body) => patchJob(r.jobKey, body)}
                      errorEmailRule={data.errorEmailRule}
                      running={runningJob === r.jobKey}
                      runResult={runResult[r.jobKey]}
                      runEtaAt={runEta[r.jobKey]}
                      onRunNow={() => runNow(r.jobKey)}
                      t={t}
                    />
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {t('admin.scheduling.recent_title_paged', { n: recentTotal })}
          </h3>
          <div className="flex items-center gap-2">
            <SingleSelect
              label={t('admin.scheduling.recent_show')}
              labelIcon={ListFilter}
              options={RECENT_RUN_LIMITS.map((n) => ({ value: String(n), label: t('admin.scheduling.recent_per_page', { n }) }))}
              value={String(recentLimit)}
              onChange={(v) => { setRecentLimit(Number(v) as RecentRunLimit); setRecentPage(1) }}
            />
            <button
              type="button"
              onClick={() => void clearRecentRuns()}
              disabled={clearingRuns || recentTotal === 0}
              title={t('admin.scheduling.recent_clear')}
              aria-label={t('admin.scheduling.recent_clear')}
              className="flex h-7 w-8 items-center justify-center rounded border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 hover:text-rose-600 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-rose-400"
            >
              {clearingRuns ? <Spinner className="h-3.5 w-3.5" /> : <Eraser className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">{t('admin.scheduling.col_job', 'Job')}</th>
                <th className="px-3 py-2 text-left">{t('admin.scheduling.col_category')}</th>
                <th className="px-3 py-2 text-left">{t('admin.scheduling.col_source', 'Source')}</th>
                <th className="px-3 py-2 text-left">{t('admin.scheduling.col_started', 'Started')}</th>
                <th className="px-3 py-2 text-left">{t('admin.scheduling.col_duration', 'Duration')}</th>
                <th className="px-3 py-2 text-left">{t('admin.scheduling.col_status', 'Status')}</th>
                <th className="px-3 py-2 text-left">{t('admin.scheduling.col_message', 'Message')}</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-400">
                  {t('admin.scheduling.no_runs', 'No job runs recorded yet.')}
                </td></tr>
              )}
              {data.recent.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 dark:border-gray-900 last:border-b-0">
                  <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{r.jobKey}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{t(`admin.scheduling.category.${jobCategory(r.jobKey)}`)}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                    {r.detail?.source === 'manual'
                      ? t('admin.scheduling.source_manual', 'Refresh Button')
                      : r.detail?.source === 'scheduled'
                        ? t('admin.scheduling.source_scheduled', 'Scheduled')
                        : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200 tabular-nums">{fmtWhen(r.startedAt)}</td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200 tabular-nums">{fmtDuration(r.durationMs)}</td>
                  <td className="px-3 py-2"><StatusPill status={r.status} t={t} /></td>
                  <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{r.message ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TablePagination page={Math.min(recentPage, recentTotalPages)} totalPages={recentTotalPages} onPageChange={setRecentPage} />
        </div>
      </div>
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function JobRow({ entry, latest, config, saving, onPatch, errorEmailRule, running, runResult, runEtaAt, onRunNow, t }: {
  entry: JobRegistryEntry
  latest: JobLatest | undefined
  config: JobConfig | undefined
  saving: boolean
  onPatch: (body: Record<string, unknown>) => void
  errorEmailRule: { key: string; name: string } | undefined
  running: boolean
  runResult: 'ok' | 'noop' | 'busy' | 'error' | undefined
  runEtaAt: number | undefined
  onRunNow: () => void
  t: any
}) {
  const status = latest?.status ?? 'never_run'
  const waitingText: string | null = entry.waitingFor ? t(`admin.scheduling.waiting_for.${entry.waitingFor}`) : null
  const notify = config?.notifyOnError ?? false
  const enabled = config?.enabled ?? true
  const effectiveIntervalMs = config?.intervalMs ?? entry.defaultIntervalMs
  const [editingCadence, setEditingCadence] = useState(false)
  const [minutesInput, setMinutesInput] = useState(() => effectiveIntervalMs != null ? String(effectiveIntervalMs / 60_000) : '')

  function startEdit() {
    setMinutesInput(effectiveIntervalMs != null ? String(effectiveIntervalMs / 60_000) : '')
    setEditingCadence(true)
  }

  function saveInterval() {
    const minutes = Number(minutesInput)
    if (!Number.isFinite(minutes) || minutes <= 0) return
    onPatch({ intervalMs: Math.round(minutes * 60_000) })
    setEditingCadence(false)
  }

  const isCustomized = entry.cadenceEditable && config?.intervalMs != null && config.intervalMs !== entry.defaultIntervalMs

  // v1.230.0: schedule (local send-time) editing for digest_worker /
  // weekly_recap_worker — independent of the interval-editing state above.
  const effectiveHour = config?.scheduleHour ?? entry.defaultScheduleHour ?? 0
  const effectiveMinute = config?.scheduleMinute ?? entry.defaultScheduleMinute ?? 0
  const effectiveDay = config?.scheduleDayOfWeek ?? entry.defaultScheduleDayOfWeek ?? 0
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [hourInput, setHourInput] = useState(() => String(effectiveHour))
  const [minuteInput, setMinuteInput] = useState(() => String(effectiveMinute))
  const [dayInput, setDayInput] = useState(() => String(effectiveDay))

  function startScheduleEdit() {
    setHourInput(String(effectiveHour))
    setMinuteInput(String(effectiveMinute))
    setDayInput(String(effectiveDay))
    setEditingSchedule(true)
  }

  function saveSchedule() {
    const hour = Number(hourInput)
    const minute = Number(minuteInput)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return
    const body: Record<string, unknown> = { scheduleHour: hour, scheduleMinute: minute }
    if (entry.scheduleKind === 'weekly') {
      const day = Number(dayInput)
      if (!Number.isInteger(day) || day < 0 || day > 6) return
      body.scheduleDayOfWeek = day
    }
    onPatch(body)
    setEditingSchedule(false)
  }

  const scheduleCustomized = entry.scheduleEditable && (
    (config?.scheduleHour != null && config.scheduleHour !== entry.defaultScheduleHour)
    || (config?.scheduleMinute != null && config.scheduleMinute !== entry.defaultScheduleMinute)
    || (entry.scheduleKind === 'weekly' && config?.scheduleDayOfWeek != null && config.scheduleDayOfWeek !== entry.defaultScheduleDayOfWeek)
  )

  return (
    <tr className="border-b border-gray-100 dark:border-gray-900 last:border-b-0 align-top">
      <td className="px-3 py-2">
        <div className="font-medium text-gray-800 dark:text-gray-100">{entry.jobKey}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{entry.description}</div>
        {entry.emailRuleName && (
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {t('admin.scheduling.sends_via', 'Sends via Communications rule: {{name}}', { name: entry.emailRuleName })}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {waitingText ? (
          <span title={waitingText} className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <PlugZap className="h-3.5 w-3.5" />
            {t('admin.scheduling.not_set_up')}
          </span>
        ) : (
        <button
          type="button"
          disabled={saving}
          onClick={() => onPatch({ enabled: !enabled })}
          title={enabled ? t('admin.scheduling.active_on', 'Active') : t('admin.scheduling.active_off', 'Inactive')}
          aria-label={enabled ? t('admin.scheduling.active_on', 'Active') : t('admin.scheduling.active_off', 'Inactive')}
          className={`inline-flex items-center gap-1 text-xs ${enabled ? 'text-green-700 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}`}
        >
          {enabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
          {enabled ? t('admin.scheduling.active_on', 'Active') : t('admin.scheduling.active_off', 'Inactive')}
        </button>
        )}
      </td>
      <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
        {entry.cadenceEditable ? (
          editingCadence ? (
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={10 / 60}
                step="0.5"
                value={minutesInput}
                onChange={(e) => setMinutesInput(e.target.value)}
                className="w-16 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
              />
              <span className="text-xs text-gray-500">{t('admin.scheduling.minutes_suffix', 'min')}</span>
              <button type="button" onClick={saveInterval} className="text-gray-500 hover:text-green-600"><Save className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setEditingCadence(false)} className="text-gray-500 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span>{effectiveIntervalMs != null ? fmtIntervalMs(effectiveIntervalMs) : entry.cadence}</span>
              <button type="button" onClick={startEdit} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil className="h-3 w-3" /></button>
              {isCustomized && entry.defaultIntervalMs != null && (
                <span className="text-[11px] text-gray-400" title={t('admin.scheduling.cadence_default_hint', 'Default: {{value}}', { value: fmtIntervalMs(entry.defaultIntervalMs) })}>
                  ({t('admin.scheduling.cadence_customized', 'customized')})
                </span>
              )}
            </div>
          )
        ) : (
          entry.cadence
        )}
      </td>
      {/* v1.329.0: the actual local send time now lives in its own column,
          separate from Cadence (how often the scheduler ticks) — the two
          were previously folded into one label for these two jobs, which is
          exactly the ambiguity that led to the "Run Now did nothing" report
          in the first place. */}
      <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
        {entry.scheduleEditable ? (
          editingSchedule ? (
            <div className="flex flex-wrap items-center gap-1">
              {entry.scheduleKind === 'weekly' && (
                <select
                  value={dayInput}
                  onChange={(e) => setDayInput(e.target.value)}
                  className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
                >
                  {WEEKDAY_KEYS.map((wk, i) => (
                    <option key={wk} value={i}>{t(`admin.scheduling.weekday_short.${wk}`)}</option>
                  ))}
                </select>
              )}
              <input
                type="number" min={0} max={23} value={hourInput}
                onChange={(e) => setHourInput(e.target.value)}
                className="w-12 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
              />
              <span>:</span>
              <input
                type="number" min={0} max={59} value={minuteInput}
                onChange={(e) => setMinuteInput(e.target.value)}
                className="w-12 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
              />
              <span className="text-xs text-gray-500">{t('admin.scheduling.local_suffix', 'local')}</span>
              <button type="button" onClick={saveSchedule} className="text-gray-500 hover:text-green-600"><Save className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setEditingSchedule(false)} className="text-gray-500 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span>
                {entry.scheduleKind === 'weekly' ? `${t(`admin.scheduling.weekday_short.${WEEKDAY_KEYS[effectiveDay]}`)} ` : ''}
                {fmtHm(effectiveHour, effectiveMinute)} {t('admin.scheduling.local_suffix', 'local')}
              </span>
              <button type="button" onClick={startScheduleEdit} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil className="h-3 w-3" /></button>
              {scheduleCustomized && (
                <span className="text-[11px] text-gray-400">({t('admin.scheduling.cadence_customized', 'customized')})</span>
              )}
            </div>
          )
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-gray-700 dark:text-gray-200 tabular-nums">{fmtWhen(latest?.started_at)}</td>
      <td className="px-3 py-2 text-gray-700 dark:text-gray-200 tabular-nums">{fmtDuration(latest?.duration_ms ?? null)}</td>
      <td className="px-3 py-2">{waitingText ? <span className="text-gray-400">—</span> : <StatusPill status={status} t={t} />}</td>
      <td className="px-3 py-2">
        <label className="inline-flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={notify}
            disabled={saving}
            onChange={() => onPatch({ notifyOnError: !notify })}
            className="h-4 w-4"
          />
          {notify ? t('admin.scheduling.notify_on', 'On') : t('admin.scheduling.notify_off', 'Off')}
        </label>
        {errorEmailRule && (
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {t('admin.scheduling.via_rule', 'via: {{name}}', { name: errorEmailRule.name })}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{waitingText ?? latest?.message ?? '—'}</td>
      <td className="px-3 py-2">
        {/* historical_backfill is never passed through scheduleJob() — it has
            its own dedicated trigger under Integrations → CRM Historical
            Import — so there's no task here to run. */}
        {entry.jobKey === 'historical_backfill' ? (
          <span className="text-xs text-gray-400" title={t('admin.scheduling.run_now_not_available', 'Triggered from CRM Historical Import instead')}>—</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={running || !!waitingText}
                title={waitingText ?? undefined}
                onClick={onRunNow}
                className="inline-flex items-center gap-1 text-xs text-blue-700 hover:text-blue-900 disabled:opacity-50 dark:text-blue-400 dark:hover:text-blue-300"
              >
                {running ? <Spinner className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                {t('admin.scheduling.run_now', 'Run now')}
              </button>
              {!running && runResult === 'ok' && (
                <span title={t('admin.scheduling.run_now_success', 'Ran')}><CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" /></span>
              )}
              {!running && runResult === 'noop' && (
                <span title={t('admin.scheduling.run_now_noop', 'Nothing to do — not the scheduled send window, or already sent')}><Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" /></span>
              )}
              {!running && runResult === 'busy' && (
                <span title={t('admin.scheduling.run_now_busy')}><Hourglass className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" /></span>
              )}
              {!running && runResult === 'error' && (
                <span title={t('admin.scheduling.run_now_error', 'Failed')}><XCircle className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" /></span>
              )}
            </div>
            {/* v1.329.0: the real per-user ETA, only ever present for a noop
                on digest_worker/weekly_recap_worker — see
                getNextDigestEtaMinutes/getNextWeeklyRecapEtaMinutes. */}
            {!running && runResult === 'noop' && runEtaAt != null && (
              <NextEtaCountdown targetAt={runEtaAt} t={t} />
            )}
          </div>
        )}
      </td>
    </tr>
  )
}
