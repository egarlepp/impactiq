import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { jobConfig } from '../../../../drizzle/schema.js'
import { withJobLock } from './jobLock.js'
import { reportError } from '../observability/errorTracking.js'
import { getCrmProviderId } from '../crm/providerSetting.js'
import { jobAppliesToCrm } from './jobCrm.js'
import { jobWaitingFor } from './jobReadiness.js'

// v1.227.0: single shared "run this on a schedule, admin-configurable"
// mechanism (CLAUDE.md §14). Every background worker used to manage its own
// setInterval with a hardcoded delay and zero DB awareness. This replaces
// that with one self-rescheduling loop so enable/disable and cadence
// overrides are written once, not per-worker.
//
// Deliberately setTimeout, not setInterval: the delay before the NEXT fire
// has to be re-read from job_config every cycle (an admin may have changed
// it since the last tick), which setInterval can't do without being torn
// down and recreated.
//
// A cadence change takes effect starting from the job's next natural fire,
// not by clearing an already-armed wait early — simpler, and there's no
// observable downside for jobs on second/minute/hour/day-scale intervals.

export interface ScheduleJobOptions {
  // Delay before the FIRST fire, independent of the recurring interval —
  // preserves each job's existing boot-time stagger (0 for jobs that used to
  // fire immediately at boot, a custom value for the snapshot-family jobs'
  // staggered first runs, or omitted to wait one full interval like most
  // pollers already did).
  firstRunDelayMs?: number
}

// v1.283.0: every scheduleJob() call registers its task here, keyed by
// jobKey — the Admin → Scheduling "Run now" button (CLAUDE.md §14) looks a
// job up by key and invokes the SAME task the scheduler would have called on
// its next natural tick, rather than a second reimplementation that could
// drift. A job that never called scheduleJob() (historical_backfill, which
// has its own dedicated trigger under CRM Historical Import) simply never
// appears here, so it's naturally excluded rather than special-cased.
//
// Note for a clock-gated job (digest_worker / weekly_recap_worker): the
// registered task checks whether "now" is the right send window before
// doing anything, exactly as it would on a real tick — Run Now does not
// bypass that check, since faking the clock would test a path production
// never takes.
//
// v1.414.0: Run Now takes the same per-job lock as a scheduled tick
// (jobLock.ts), so clicking it while the job is already running here or on
// another replica answers 'already_running' instead of starting a second copy.
const registry = new Map<string, () => Promise<void>>()

// v1.440.0: the scheduler loop's own heartbeat per job, for App Health's
// "overdue" check. A job's tick awaits its task before arming the next one,
// so a hung task stops the loop; job_runs can't show that, since quiet ticks
// write no row by design. This is per process: every replica runs every
// loop (the job lock only skips the task), so any replica's view is valid.
export interface JobHeartbeat {
  // When the next tick is armed to fire; null while a tick is running.
  nextDueAt: number | null
  // When the running tick started; null between ticks.
  runningSince: number | null
  intervalMs: number
}
const heartbeats = new Map<string, JobHeartbeat>()

export function getJobHeartbeats(): ReadonlyMap<string, JobHeartbeat> {
  return heartbeats
}

// v1.443.0: the server schedules its jobs before start() applies database
// migrations, and several jobs fire at boot (firstRunDelayMs: 0). On the first
// boot after an upgrade a job could then query a table its migration hadn't
// created yet (sync_audit_cull failed on email_deliveries after v1.440.0).
// The server passes its migration run here, and no tick starts until it has
// settled. A failed migration releases the gate too: the jobs then report the
// database error themselves, as they did before. Tests never call this, so
// their jobs run straight away.
let startGate: Promise<void> = Promise.resolve()

export function holdJobsUntil(ready: Promise<unknown>): void {
  startGate = ready.then(() => undefined, () => undefined)
}

// v1.437.0: a job that belongs to a CRM other than the active one (jobCrm.ts)
// neither ticks nor runs from Run Now. Each CRM job also checks this itself;
// doing it here means a job can't forget to. v1.438.0: the same goes for a
// job whose integration isn't connected yet (jobReadiness.ts).
async function jobBlockedReason(jobKey: string): Promise<'inactive_crm' | 'not_set_up' | null> {
  const crm = await getCrmProviderId()
  if (!jobAppliesToCrm(jobKey, crm)) return 'inactive_crm'
  if (await jobWaitingFor(jobKey, crm)) return 'not_set_up'
  return null
}

export async function runJobNow(jobKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const task = registry.get(jobKey)
  if (!task) return { ok: false, error: 'not_found' }
  const blocked = await jobBlockedReason(jobKey)
  if (blocked) return { ok: false, error: blocked }
  try {
    const result = await withJobLock(jobKey, task)
    if (!result.ran) return { ok: false, error: 'already_running' }
    return { ok: true }
  } catch (err) {
    reportError(err, { jobKey, source: 'run_now' })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function isJobRegistered(jobKey: string): boolean {
  return registry.has(jobKey)
}

async function readJobConfig(jobKey: string): Promise<{ enabled: boolean; intervalMs: number | null }> {
  try {
    const [cfg] = await db.select().from(jobConfig).where(eq(jobConfig.jobKey, jobKey)).limit(1)
    // No row yet (job never configured by an admin) → behave exactly as
    // every job did before this existed: always enabled.
    return { enabled: cfg?.enabled ?? true, intervalMs: cfg?.intervalMs ?? null }
  } catch {
    // Never let a config-read failure take a background job down.
    return { enabled: true, intervalMs: null }
  }
}

// Returns a stop() function — preserves the handful of exported
// stopXWorker() APIs some workers had (e.g. tests stopping the writeback
// poller), even though scheduleJob's loop is setTimeout-based rather than a
// single reusable interval handle.
export function scheduleJob(
  jobKey: string,
  defaultIntervalMs: number,
  task: () => Promise<void>,
  opts: ScheduleJobOptions = {},
): () => void {
  registry.set(jobKey, task)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const armNext = (delayMs: number, intervalMs: number) => {
    if (stopped) return
    heartbeats.set(jobKey, { nextDueAt: Date.now() + delayMs, runningSince: null, intervalMs })
    timer = setTimeout(() => { void tick() }, delayMs)
  }

  const tick = async () => {
    await startGate
    if (stopped) return
    const previous = heartbeats.get(jobKey)
    heartbeats.set(jobKey, { nextDueAt: null, runningSince: Date.now(), intervalMs: previous?.intervalMs ?? defaultIntervalMs })
    const cfg = await readJobConfig(jobKey)
    if (cfg.enabled && (await jobBlockedReason(jobKey)) === null) {
      try {
        // Another replica holding this job's lock means it's running there;
        // this process just waits for its next tick.
        await withJobLock(jobKey, task)
      } catch (err) {
        // Individual jobs are expected to record their own failures via
        // writeRun(); this is only a last-resort backstop so a thrown error
        // can't kill the reschedule loop itself.
        console.error(`[scheduler:${jobKey}] task threw:`, err)
        reportError(err, { jobKey, source: 'scheduler' })
      }
    }
    const interval = cfg.intervalMs && cfg.intervalMs > 0 ? cfg.intervalMs : defaultIntervalMs
    armNext(interval, interval)
  }

  const firstDelay = opts.firstRunDelayMs ?? defaultIntervalMs
  armNext(firstDelay, defaultIntervalMs)

  return () => {
    stopped = true
    heartbeats.delete(jobKey)
    if (timer) clearTimeout(timer)
  }
}
