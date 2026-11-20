import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import {
  Play,
  Pause,
  RotateCcw,
  RefreshCcw,
  History,
  CheckCircle2,
  XCircle,
  Clock,
  FlaskConical,
  AlertTriangle,
  ListChecks,
} from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { HistoricalEstimateBanner } from '../ui/historical.js'
import { HistoricalExclusions, type ExclusionRule, type TopCreator } from './HistoricalExclusions.js'
import { HistoricalSettings } from './HistoricalSettings.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'

// v1.214.0: Admin control surface for the pre-ImpactIQ Salesforce Event
// backfill. App Admin only (the route guard enforces it server-side too).
//
// The backfill runs detached on the server, so this page polls /status while
// it's running rather than holding a request open.

interface State {
  key: string
  status: string
  cursorBefore: string
  floorAt: string
  sliceDays: number
  totalEventsImported: number
  totalSlicesDone: number
  lastError: string | null
  startedAt: string | null
  updatedAt: string
  percentComplete: number
}

interface Run {
  id: string
  status: string
  kind: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  sliceFrom: string | null
  sliceTo: string | null
  eventsFetched: number
  eventsInserted: number
  oppsUpserted: number
  usersMatched: number
  usersUnmatched: number
  typesMatched: number
  typesUnmatched: number
  error: string | null
}

interface UnmappedType {
  crmType: string | null
  teamId: string | null
  count: number
}

interface DryRun {
  stats: {
    eventsFetched: number
    usersMatched: number
    usersUnmatched: number
    typesMatched: number
    typesUnmatched: number
    unmatchedTypeSamples: Record<string, number>
  }
  sliceFrom: string
  sliceTo: string
}

function pct(a: number, b: number): string {
  const total = a + b
  return total > 0 ? `${Math.round((a / total) * 100)}%` : '—'
}

export function HistoricalImport() {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [state, setState] = useState<State | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [unmapped, setUnmapped] = useState<UnmappedType[]>([])
  const [exclusions, setExclusions] = useState<ExclusionRule[]>([])
  const [topCreators, setTopCreators] = useState<TopCreator[]>([])
  const [rowCount, setRowCount] = useState(0)
  const [unpurged, setUnpurged] = useState(0)
  const [allDayCapHours, setAllDayCapHours] = useState(8)
  const [lookbackDays, setLookbackDays] = useState(1095)
  const [earliestDate, setEarliestDate] = useState<string | null>(null)
  const [effectiveFloorAt, setEffectiveFloorAt] = useState<string | null>(null)
  const [earliestDateClamped, setEarliestDateClamped] = useState(false)
  const [recomputeNeeded, setRecomputeNeeded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dryRun, setDryRun] = useState<DryRun | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await api.get<{
      state: State
      runs: Run[]
      unmappedTypes: UnmappedType[]
      exclusions: ExclusionRule[]
      topCreators: TopCreator[]
      rowCount: number
      unpurgedMatches: number
      settings: {
        allDayCapHours: number
        lookbackDays: number
        earliestDate: string | null
        effectiveFloorAt: string | null
        earliestDateClamped: boolean
      }
      recomputeNeeded: boolean
    }>('/api/admin/historical-import/status')
    setState(res.data?.state ?? null)
    setRuns(res.data?.runs ?? [])
    setUnmapped(res.data?.unmappedTypes ?? [])
    setExclusions(res.data?.exclusions ?? [])
    setTopCreators(res.data?.topCreators ?? [])
    setRowCount(res.data?.rowCount ?? 0)
    setUnpurged(res.data?.unpurgedMatches ?? 0)
    setAllDayCapHours(res.data?.settings?.allDayCapHours ?? 8)
    setLookbackDays(res.data?.settings?.lookbackDays ?? 1095)
    setEarliestDate(res.data?.settings?.earliestDate ?? null)
    setEffectiveFloorAt(res.data?.settings?.effectiveFloorAt ?? null)
    setEarliestDateClamped(res.data?.settings?.earliestDateClamped ?? false)
    setRecomputeNeeded(res.data?.recomputeNeeded ?? false)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Poll while the walker is active so progress advances without a manual
  // refresh; stop as soon as it isn't.
  useEffect(() => {
    if (state?.status !== 'running') return
    const id = setInterval(() => void load(), 5000)
    return () => clearInterval(id)
  }, [state?.status, load])

  const act = async (path: string, opts?: { dry?: boolean }) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<unknown>(`/api/admin/historical-import/${path}`, {})
      if (opts?.dry) setDryRun((res.data as DryRun) ?? null)
      else setDryRun(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    )
  }

  const running = state?.status === 'running'
  const complete = state?.status === 'complete'
  // Only meaningful for a FIXED earliest date, where "configured" and "actual"
  // are both exact days and any difference is something the admin asked for.
  // A relative preset drifts by design — its floor is "now minus N days", so
  // it diverges from the stored floor a little more every day, and flagging
  // that would make the notice permanent wallpaper within a week.
  const windowPending =
    !!earliestDate && !!effectiveFloorAt && !!state?.floorAt &&
    effectiveFloorAt.slice(0, 10) !== state.floorAt.slice(0, 10)

  return (
    <div className="space-y-4">
      <HistoricalEstimateBanner variant="full" />

      {/* Control card */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <History className="h-4 w-4" />
              {t('admin.historical_import.title', { context: crmCtx })}
            </h3>
            <p className="mt-0.5 max-w-2xl text-xs text-gray-500 dark:text-gray-400">
              {t('admin.historical_import.description', { context: crmCtx })}
            </p>
          </div>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              running && 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
              complete && 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
              state?.status === 'error' && 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
              !running && !complete && state?.status !== 'error' && 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
            )}
          >
            {running ? <Spinner className="h-3 w-3" /> : complete ? <CheckCircle2 className="h-3 w-3" /> : state?.status === 'error' ? <XCircle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
            {t(`admin.historical_import.status.${state?.status ?? 'idle'}`)}
          </span>
        </div>

        {/* Progress */}
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>
              {t('admin.historical_import.progress', {
                imported: state?.totalEventsImported ?? 0,
                slices: state?.totalSlicesDone ?? 0,
              })}
              {' · '}
              {t('admin.historical_import.stat_row_count', { count: rowCount })}
            </span>
            <span className="tabular-nums">{state?.percentComplete ?? 0}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
            <div
              className="h-full rounded bg-blue-500 transition-all dark:bg-blue-600"
              style={{ width: `${state?.percentComplete ?? 0}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
            {t('admin.historical_import.cursor', {
              cursor: state?.cursorBefore?.slice(0, 10) ?? '—',
              floor: state?.floorAt?.slice(0, 10) ?? '—',
            })}
          </p>
          {/* The saved window only reaches this floor via Reset cursor (or
              automatically, when the backfill hasn't run yet). Without this
              line the earliest date above just looks like the save failed. */}
          {windowPending && (
            <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {t('admin.historical_import.window_pending', {
                date: effectiveFloorAt?.slice(0, 10) ?? '—',
              })}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || running} onClick={() => void act('start', { dry: true })}>
            <FlaskConical className="mr-1 h-3.5 w-3.5" />
            {t('admin.historical_import.dry_run')}
          </Button>
          <Button size="sm" disabled={busy || running || complete} onClick={() => void act('start')}>
            <Play className="mr-1 h-3.5 w-3.5" />
            {t('admin.historical_import.start')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !running} onClick={() => void act('pause')}>
            <Pause className="mr-1 h-3.5 w-3.5" />
            {t('admin.historical_import.pause')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || running} onClick={() => void act('relink')}>
            <RefreshCcw className="mr-1 h-3.5 w-3.5" />
            {t('admin.historical_import.relink')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || running} onClick={() => void act('reset')}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {t('admin.historical_import.reset')}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
          {t('admin.historical_import.relink_hint', { context: crmCtx })}
        </p>

        {(error || state?.lastError) && (
          <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error ?? (state?.lastError && /^[a-z_]+$/.test(state.lastError)
              ? t(`errors.historical.${state.lastError}`, { defaultValue: state.lastError })
              : state?.lastError)}
          </p>
        )}
      </div>

      {/* Dry-run result: the pre-flight match-rate check. */}
      {dryRun && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 text-xs dark:border-blue-900 dark:bg-blue-950/30">
          <h4 className="mb-2 flex items-center gap-1 text-sm font-semibold text-blue-900 dark:text-blue-200">
            <FlaskConical className="h-4 w-4" />
            {t('admin.historical_import.dry_run_title')}
          </h4>
          <p className="mb-2 text-blue-800 dark:text-blue-300">
            {t('admin.historical_import.dry_run_slice', {
              from: dryRun.sliceFrom.slice(0, 10),
              to: dryRun.sliceTo.slice(0, 10),
              count: dryRun.stats.eventsFetched,
            })}
          </p>
          <ul className="space-y-0.5 text-blue-900 dark:text-blue-200">
            <li>
              {t('admin.historical_import.dry_run_users', {
                pct: pct(dryRun.stats.usersMatched, dryRun.stats.usersUnmatched),
                matched: dryRun.stats.usersMatched,
                unmatched: dryRun.stats.usersUnmatched,
              })}
            </li>
            <li>
              {t('admin.historical_import.dry_run_types', {
                pct: pct(dryRun.stats.typesMatched, dryRun.stats.typesUnmatched),
                matched: dryRun.stats.typesMatched,
                unmatched: dryRun.stats.typesUnmatched,
              })}
            </li>
          </ul>
        </div>
      )}

      {/* Unmapped SF Types — the input an admin needs before adding overrides. */}
      {unmapped.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.historical_import.unmapped_title', { context: crmCtx })}
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('admin.historical_import.unmapped_hint', { context: crmCtx })}
            </p>
          </div>
          <ul className="divide-y divide-gray-100 text-xs dark:divide-gray-800">
            {unmapped.slice(0, 25).map((u, i) => (
              <li key={`${u.crmType}-${u.teamId}-${i}`} className="flex justify-between px-4 py-1.5">
                <span className="text-gray-700 dark:text-gray-200">{u.crmType ?? t('admin.historical_import.type_none')}</span>
                <span className="tabular-nums text-gray-500 dark:text-gray-400">{u.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Run history */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <ListChecks className="h-4 w-4" />
            {t('admin.historical_import.runs_title')}
          </h4>
        </div>
        {runs.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
            {t('admin.historical_import.runs_empty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left">{t('admin.historical_import.col_when')}</th>
                  <th className="px-3 py-2 text-left">{t('admin.historical_import.col_kind')}</th>
                  <th className="px-3 py-2 text-left">{t('admin.historical_import.col_slice')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.historical_import.col_events', { context: crmCtx })}</th>
                  <th className="px-3 py-2 text-right">{t('admin.historical_import.col_users')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.historical_import.col_types')}</th>
                  <th className="px-3 py-2 text-left">{t('admin.historical_import.col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                    <td className="whitespace-nowrap px-3 py-1.5 text-gray-600 dark:text-gray-300">
                      {r.startedAt.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">{r.kind}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-gray-500 dark:text-gray-400">
                      {r.sliceFrom && r.sliceTo ? `${r.sliceFrom.slice(0, 10)} → ${r.sliceTo.slice(0, 10)}` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700 dark:text-gray-200">{r.eventsInserted}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-300">{pct(r.usersMatched, r.usersUnmatched)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-300">{pct(r.typesMatched, r.typesUnmatched)}</td>
                    <td className="px-3 py-1.5">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1',
                          r.status === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400',
                        )}
                        title={r.error ?? undefined}
                      >
                        {r.status === 'ok' ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <HistoricalSettings
        allDayCapHours={allDayCapHours}
        lookbackDays={lookbackDays}
        earliestDate={earliestDate}
        effectiveFloorAt={effectiveFloorAt}
        earliestDateClamped={earliestDateClamped}
        recomputeNeeded={recomputeNeeded}
        hasProgress={(state?.totalSlicesDone ?? 0) > 0}
        onChanged={() => void load()}
      />

      <HistoricalExclusions
        exclusions={exclusions}
        topCreators={topCreators}
        unpurgedMatches={unpurged}
        onChanged={() => void load()}
      />
    </div>
  )
}
