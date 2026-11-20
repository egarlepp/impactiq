import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activities, activityNotePushes, aiProviders, aiRequests, eventWebhookDeliveries, eventWebhooks, jobConfig,
} from '../../../../drizzle/schema.js'
import { worstStatus, type BackupReminderDays, type HealthLine, type HealthOverview, type HealthStatus, type HealthTile, type HealthTileId } from '../../../shared/healthOverview.js'
import type { CrmProviderId } from '../../../shared/crmProvider.js'
import { getCrmProviderId } from '../crm/providerSetting.js'
import { getEmailIntegrationConfig, getMsIntegrationConfig, getSfIntegrationConfig } from '../config/integrations.js'
import { getJobHeartbeats, type JobHeartbeat } from '../jobs/scheduler.js'
import { jobAppliesToCrm } from '../jobs/jobCrm.js'
import { JOB_NEEDS, jobWaitingFor, resolveSetupNeed } from '../jobs/jobReadiness.js'
import { getMigrationStatus } from './migrations.js'
import { countUsersNeedingReconnect, getIntegrationStatuses, type IntegrationCallStatus } from './integrationStatus.js'
import { getReadinessCalls } from './readiness.js'
import { checkRetention } from './retention.js'

// v1.440.0: App Health's System Health Overview. Each tile reads data the app
// already keeps (job_runs, the write-back columns, ai_requests, ...) plus the
// email delivery log, and turns it into a status. Two rules keep the panel
// worth looking at:
//   - Quiet by default: a tile goes amber or red only past a threshold, not on
//     any non-zero number, so a healthy install reads all green.
//   - Isolated: each tile is computed on its own and a failed check becomes a
//     warning on that tile only, never a blank page.
// No live calls to Salesforce, HubSpot, Graph or an AI provider are made here;
// the page refreshes every minute and those would cost API calls each time.

const MIN = 60 * 1000
const HOUR = 60 * MIN

// ─── Thresholds (pure, unit tested) ─────────────────────────────────────

export const QUEUE_WARN_AGE_MS = 15 * MIN
export const QUEUE_ERROR_AGE_MS = HOUR

// A queue: work waiting (and for how long) plus failures nobody has dealt with.
export function queueStatus(q: { pending: number; oldestPendingAgeMs: number | null; failed: number; blocked: boolean }): HealthStatus {
  const age = q.pending > 0 ? q.oldestPendingAgeMs ?? 0 : 0
  if (age >= QUEUE_ERROR_AGE_MS) return 'error'
  if (age >= QUEUE_WARN_AGE_MS || q.failed > 0 || (q.blocked && q.pending > 0)) return 'warning'
  return 'ok'
}

// A job's scheduler loop is overdue when its armed tick is well past due, or
// one tick has been running far longer than the job's own interval. Both mean
// the loop has stopped, which a job's own error handling can't report.
export function heartbeatOverdue(h: JobHeartbeat, now: number): boolean {
  if (h.runningSince !== null) return now - h.runningSince > Math.max(HOUR, 2 * h.intervalMs)
  if (h.nextDueAt !== null) return now - h.nextDueAt > Math.max(2 * MIN, h.intervalMs)
  return false
}

export function connectionsStatus(used: number, max: number): HealthStatus {
  if (max <= 0) return 'ok'
  const ratio = used / max
  if (ratio >= 0.9) return 'error'
  if (ratio >= 0.7) return 'warning'
  return 'ok'
}

export function memoryStatus(rssBytes: number): HealthStatus {
  if (rssBytes >= 1.5e9) return 'error'
  if (rssBytes >= 0.9e9) return 'warning'
  return 'ok'
}

// Failures with nothing getting through means email is down; some failures
// among successes is usually one bad address.
export function emailStatus(sent: number, failed: number): HealthStatus {
  if (failed > 0 && sent === 0) return 'error'
  if (failed > 0) return 'warning'
  return 'ok'
}

export function aiBudgetStatus(spentUsd: number, budgetUsd: number | null): HealthStatus {
  if (budgetUsd === null || budgetUsd <= 0) return 'ok'
  const ratio = spentUsd / budgetUsd
  if (ratio >= 1) return 'error'
  if (ratio >= 0.8) return 'warning'
  return 'ok'
}

// A handful of failed AI calls is normal (timeouts, refusals); a real share of
// a real volume is not.
export function aiErrorStatus(errors: number, total: number): HealthStatus {
  if (errors >= 5 && total > 0 && errors / total >= 0.25) return 'warning'
  return 'ok'
}

// v1.444.0: a few users with a broken connection is people who left or
// stopped using it; a real share of everyone connected is a problem.
export function shareStatus(count: number, of: number): HealthStatus {
  if (count >= 3 || (of > 0 && count / of >= 0.2)) return 'warning'
  return 'ok'
}

// A low cache hit ratio means Postgres reads from disk; only meaningful once
// it has done real work since its statistics were reset.
export function cacheHitStatus(hits: number, reads: number): HealthStatus {
  const total = hits + reads
  if (total < 10_000) return 'ok'
  return hits / total < 0.95 ? 'warning' : 'ok'
}

// A table with many dead rows relative to its live ones means autovacuum is
// falling behind (or blocked by a long transaction).
export function deadRowsHigh(dead: number, live: number): boolean {
  return dead >= 10_000 && dead > 0.2 * live
}

export function backupStatus(lastBackupAt: number | null, reminderDays: BackupReminderDays, now: number): HealthStatus {
  if (reminderDays === 0) return 'off'
  if (lastBackupAt === null) return 'warning'
  return now - lastBackupAt > reminderDays * 24 * HOUR ? 'warning' : 'ok'
}

// What the app's own calls say about one integration: failing when the most
// recent outcome in the last day is a failure.
export function integrationCallLine(integration: string, s: IntegrationCallStatus | undefined, now: number): HealthLine {
  const success = s?.lastSuccessAt?.getTime() ?? null
  const failure = s?.lastFailureAt?.getTime() ?? null
  if (failure !== null && now - failure <= 24 * HOUR && (success === null || failure > success)) {
    return line('integration_call_failed', 'warning', { integration, at: new Date(failure).toISOString(), error: s?.lastError ?? '' })
  }
  if (success !== null) return line('integration_ok_seen', 'ok', { integration, at: new Date(success).toISOString() })
  return line('integration_ok', 'ok', { integration })
}

// ─── Helpers ────────────────────────────────────────────────────────────

const line = (key: string, status: HealthStatus, params?: HealthLine['params']): HealthLine =>
  params ? { key, status, params } : { key, status }

function tileOf(id: HealthTileId, lines: HealthLine[]): HealthTile {
  return { id, status: worstStatus(lines.map((l) => l.status)), lines }
}

// postgres-js returns the row array directly; pglite (tests) returns { rows }.
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as T[]) : []
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const ageMs = (v: unknown, now: number): number | null => {
  if (v === null || v === undefined) return null
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime()
  return Number.isFinite(t) ? Math.max(0, now - t) : null
}

async function safeTile(id: HealthTileId, build: () => Promise<HealthTile>): Promise<HealthTile> {
  try {
    return await build()
  } catch (err) {
    console.warn(`[health] ${id} check failed:`, err instanceof Error ? err.message : String(err))
    return tileOf(id, [line('check_failed', 'warning', { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) })])
  }
}

// Latest job_runs row per job, shared by the Jobs and Integrations tiles.
interface LatestRun { status: string; startedAt: number }
async function latestRuns(jobKeys: string[]): Promise<Map<string, LatestRun>> {
  if (jobKeys.length === 0) return new Map()
  const rows = rowsOf<{ job_key: string; status: string; started_at: string | Date }>(await db.execute(sql`
    SELECT DISTINCT ON (job_key) job_key, status, started_at
    FROM job_runs
    WHERE job_key IN (${sql.join(jobKeys.map((k) => sql`${k}`), sql`, `)})
    ORDER BY job_key, started_at DESC
  `))
  return new Map(rows.map((r) => [r.job_key, { status: r.status, startedAt: new Date(r.started_at).getTime() }]))
}

interface JobContext {
  crm: CrmProviderId
  // Registered jobs that run on this install: right CRM, enabled, set up.
  liveKeys: string[]
  disabledKeys: Set<string>
  waitingKeys: Set<string>
  latest: Map<string, LatestRun>
}

async function jobContext(): Promise<JobContext> {
  const crm = await getCrmProviderId()
  const registered = [...getJobHeartbeats().keys()].filter((k) => jobAppliesToCrm(k, crm))
  const configRows = await db.select({ jobKey: jobConfig.jobKey, enabled: jobConfig.enabled }).from(jobConfig)
  const disabledKeys = new Set(configRows.filter((c) => c.enabled === false).map((c) => c.jobKey))
  const waitingKeys = new Set<string>()
  for (const k of registered) if (await jobWaitingFor(k, crm)) waitingKeys.add(k)
  const liveKeys = registered.filter((k) => !disabledKeys.has(k) && !waitingKeys.has(k))
  return { crm, liveKeys, disabledKeys, waitingKeys, latest: await latestRuns(liveKeys) }
}

// ─── Tiles ──────────────────────────────────────────────────────────────

async function databaseTile(): Promise<HealthTile> {
  const lines: HealthLine[] = []
  const [conns] = rowsOf<{ used: string; max: number | string; long_running: string; idle_tx: string }>(await db.execute(sql`
    SELECT count(*) AS used,
           current_setting('max_connections')::int AS max,
           count(*) FILTER (WHERE state = 'active' AND backend_type = 'client backend'
             AND pid <> pg_backend_pid() AND now() - query_start > interval '5 minutes') AS long_running,
           count(*) FILTER (WHERE state LIKE 'idle in transaction%' AND now() - state_change > interval '5 minutes') AS idle_tx
    FROM pg_stat_activity
    WHERE datname = current_database()
  `))
  const used = num(conns?.used)
  const max = num(conns?.max)
  lines.push(line('db_connections', connectionsStatus(used, max), { used, max }))

  const migrations = await getMigrationStatus()
  if (migrations.error) lines.push(line('db_migrations_error', 'error', { error: migrations.error.slice(0, 200) }))
  else if (migrations.pending > 0) lines.push(line('db_migrations_pending', 'warning', { count: migrations.pending }))
  else lines.push(line('db_migrations_ok', 'ok', { count: migrations.appliedCount }))

  const longRunning = num(conns?.long_running)
  if (longRunning > 0) lines.push(line('db_long_queries', 'warning', { count: longRunning }))
  const idleTx = num(conns?.idle_tx)
  if (idleTx > 0) lines.push(line('db_idle_tx', 'warning', { count: idleTx }))

  // v1.444.0: cache hit ratio and vacuum health, from Postgres' own statistics.
  const [cache] = rowsOf<{ hits: string | null; reads: string | null }>(await db.execute(sql`
    SELECT blks_hit AS hits, blks_read AS reads FROM pg_stat_database WHERE datname = current_database()
  `))
  const hits = num(cache?.hits)
  const reads = num(cache?.reads)
  if (hits + reads > 0) {
    lines.push(line('db_cache_hit', cacheHitStatus(hits, reads), { pct: Math.floor((hits / (hits + reads)) * 1000) / 10 }))
  }
  const tables = rowsOf<{ name: string; dead: string; live: string; last_vacuum: string | Date | null }>(await db.execute(sql`
    SELECT relname AS name, n_dead_tup AS dead, n_live_tup AS live,
           GREATEST(last_autovacuum, last_vacuum) AS last_vacuum
    FROM pg_stat_user_tables
  `))
  const bloated = tables.filter((t) => deadRowsHigh(num(t.dead), num(t.live)))
    .sort((a, b) => num(b.dead) - num(a.dead))
  if (bloated.length > 0) {
    lines.push(line('db_dead_rows', 'warning', { count: bloated.length, names: bloated.slice(0, 3).map((t) => t.name).join(', ') }))
  }
  const lastVacuum = tables.reduce<number | null>((latest, t) => {
    if (t.last_vacuum === null) return latest
    const at = new Date(t.last_vacuum).getTime()
    return Number.isFinite(at) && (latest === null || at > latest) ? at : latest
  }, null)
  if (lastVacuum !== null) lines.push(line('db_last_vacuum', 'ok', { at: new Date(lastVacuum).toISOString() }))
  return tileOf('database', lines)
}

async function jobsTile(ctx: JobContext, now: number): Promise<HealthTile> {
  const heartbeats = getJobHeartbeats()
  const overdue = ctx.liveKeys.filter((k) => {
    const h = heartbeats.get(k)
    return h ? heartbeatOverdue(h, now) : false
  })
  const failing = ctx.liveKeys.filter((k) => ctx.latest.get(k)?.status === 'error')
  const lines: HealthLine[] = []
  if (overdue.length > 0) lines.push(line('jobs_overdue', 'error', { count: overdue.length, names: overdue.join(', ') }))
  if (failing.length > 0) lines.push(line('jobs_failing', 'warning', { count: failing.length, names: failing.join(', ') }))
  if (overdue.length === 0 && failing.length === 0) lines.push(line('jobs_ok', 'ok', { count: ctx.liveKeys.length }))
  if (ctx.waitingKeys.size > 0) lines.push(line('jobs_waiting', 'off', { count: ctx.waitingKeys.size }))
  if (ctx.disabledKeys.size > 0) {
    const disabledHere = [...heartbeats.keys()].filter((k) => ctx.disabledKeys.has(k) && jobAppliesToCrm(k, ctx.crm)).length
    if (disabledHere > 0) lines.push(line('jobs_disabled', 'off', { count: disabledHere }))
  }
  return tileOf('jobs', lines)
}

interface QueueFacts { pending: number; oldestPendingAgeMs: number | null; failed: number; blocked: boolean }

function queueLines(queue: string, q: QueueFacts): HealthLine[] {
  const out: HealthLine[] = []
  if (q.pending > 0) {
    // The pending line carries the backlog's own status; failures get theirs.
    const pendingStatus = queueStatus({ ...q, failed: 0 })
    out.push(line(q.blocked ? 'queue_blocked' : 'queue_pending', pendingStatus,
      { queue, count: q.pending, ageSec: Math.round((q.oldestPendingAgeMs ?? 0) / 1000) }))
  }
  if (q.failed > 0) out.push(line('queue_failed', queueStatus({ ...q, pending: 0 }), { queue, count: q.failed }))
  if (out.length === 0) out.push(line('queue_clear', 'ok', { queue }))
  return out
}

// A queue whose worker can't run (disabled, or its integration isn't set up)
// still collects work; that's worth a warning even when it's young.
function workerBlocked(ctx: JobContext, jobKey: string): boolean {
  return ctx.disabledKeys.has(jobKey) || ctx.waitingKeys.has(jobKey)
}

async function crmWritebackFacts(ctx: JobContext, now: number): Promise<QueueFacts> {
  const [pending] = await db
    .select({ n: sql<string>`count(*)`, oldest: sql<string | null>`min(${activities.updatedAt})` })
    .from(activities)
    .where(and(eq(activities.status, 'submitted'), eq(activities.crmSyncStatus, 'pending'), eq(activities.isArchived, false)))
  // Same definition as CRM Sync → Issues: failed and not resolved since.
  const [failed] = rowsOf<{ n: string }>(await db.execute(sql`
    SELECT count(*) AS n FROM activities a
    WHERE a.crm_sync_status = 'failed' AND a.is_archived = false
      AND NOT EXISTS (
        SELECT 1 FROM sync_issue_resolutions r
        WHERE r.source = 'activity_writeback' AND r.issue_key = a.id::text AND r.resolved_at >= a.updated_at
      )
  `))
  const jobKey = ctx.crm === 'hubspot' ? 'hubspot_writeback_worker' : 'writeback_worker'
  return { pending: num(pending?.n), oldestPendingAgeMs: ageMs(pending?.oldest, now), failed: num(failed?.n), blocked: workerBlocked(ctx, jobKey) }
}

async function notesPushFacts(ctx: JobContext, now: number): Promise<QueueFacts> {
  const [pending] = await db
    .select({ n: sql<string>`count(*)`, oldest: sql<string | null>`min(${activityNotePushes.createdAt})` })
    .from(activityNotePushes)
    .where(eq(activityNotePushes.status, 'pending'))
  // Latest attempt per (note, target) still failed and not resolved since,
  // the same grouping CRM Sync → Issues uses.
  const [failed] = rowsOf<{ n: string }>(await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (activity_note_id, crm_target_type, crm_target_id)
             activity_note_id, crm_target_type, crm_target_id, status, created_at
      FROM activity_note_pushes
      WHERE status IN ('failed', 'synced')
      ORDER BY activity_note_id, crm_target_type, crm_target_id, created_at DESC
    )
    SELECT count(*) AS n FROM latest l
    WHERE l.status = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM sync_issue_resolutions r
        WHERE r.source = 'note_push'
          AND r.issue_key = l.activity_note_id::text || ':' || l.crm_target_type || ':' || l.crm_target_id
          AND r.resolved_at >= l.created_at
      )
  `))
  const jobKey = ctx.crm === 'hubspot' ? 'hubspot_notes_push_worker' : 'notes_push_worker'
  return { pending: num(pending?.n), oldestPendingAgeMs: ageMs(pending?.oldest, now), failed: num(failed?.n), blocked: workerBlocked(ctx, jobKey) }
}

async function outlookWritebackFacts(ctx: JobContext, now: number): Promise<QueueFacts> {
  const [pending] = await db
    .select({ n: sql<string>`count(*)`, oldest: sql<string | null>`min(${activities.updatedAt})` })
    .from(activities)
    .where(and(eq(activities.status, 'submitted'), eq(activities.outlookSyncStatus, 'pending')))
  // Outlook failures have no Resolve action and are usually one person's
  // expired calendar token, so only the last 7 days count.
  const [failed] = await db
    .select({ n: sql<string>`count(*)` })
    .from(activities)
    .where(and(eq(activities.outlookSyncStatus, 'failed'), gte(activities.updatedAt, new Date(now - 7 * 24 * HOUR))))
  return { pending: num(pending?.n), oldestPendingAgeMs: ageMs(pending?.oldest, now), failed: num(failed?.n), blocked: workerBlocked(ctx, 'outlook_writeback_worker') }
}

async function webhookFacts(ctx: JobContext, now: number): Promise<QueueFacts> {
  // Retries wait for next_attempt_at by design, so the age that matters is
  // how long the oldest delivery has been due, not how old it is.
  const [pending] = await db
    .select({ n: sql<string>`count(*)`, oldestDue: sql<string | null>`min(${eventWebhookDeliveries.nextAttemptAt})` })
    .from(eventWebhookDeliveries)
    .where(and(eq(eventWebhookDeliveries.status, 'pending'), sql`${eventWebhookDeliveries.nextAttemptAt} <= now()`))
  const [failed] = await db
    .select({ n: sql<string>`count(*)` })
    .from(eventWebhookDeliveries)
    .where(and(eq(eventWebhookDeliveries.status, 'failed'), gte(eventWebhookDeliveries.createdAt, new Date(now - 24 * HOUR))))
  return { pending: num(pending?.n), oldestPendingAgeMs: ageMs(pending?.oldestDue, now), failed: num(failed?.n), blocked: workerBlocked(ctx, 'event_webhook_worker') }
}

async function queuesTile(ctx: JobContext, now: number): Promise<HealthTile> {
  const lines: HealthLine[] = []
  if (ctx.crm !== 'none') {
    lines.push(...queueLines('crm_writeback', await crmWritebackFacts(ctx, now)))
    lines.push(...queueLines('notes_push', await notesPushFacts(ctx, now)))
  }
  if (getMsIntegrationConfig()) lines.push(...queueLines('outlook_writeback', await outlookWritebackFacts(ctx, now)))
  const [hook] = await db.select({ id: eventWebhooks.id }).from(eventWebhooks).where(eq(eventWebhooks.isActive, true)).limit(1)
  if (hook) lines.push(...queueLines('event_webhooks', await webhookFacts(ctx, now)))
  if (lines.length === 0) lines.push(line('queues_none', 'off'))
  return tileOf('queues', lines)
}

// The integration a job depends on, as named on this tile. 'crm_admin' and
// 'salesforce_admin' both mean the org-wide CRM connection.
function integrationForJob(jobKey: string, crm: CrmProviderId): string | null {
  const need = JOB_NEEDS[jobKey]
  if (!need) return null
  const resolved = resolveSetupNeed(need, crm)
  if (resolved === null) return null
  if (resolved === 'salesforce_app' || resolved === 'salesforce_admin') return 'salesforce'
  if (resolved === 'email_or_slack' || resolved === 'event_webhooks' || resolved === 'github_updates') return null
  return resolved
}

// v1.444.0: people's own connections. A token refresh that failed means
// they need to reconnect; a calendar that hasn't synced in 3 days although
// they've signed in since means Outlook sync is failing for them.
const STALE_CALENDAR_DAYS = 3
async function userConnectionLines(crm: CrmProviderId, msConfigured: boolean, now: number): Promise<HealthLine[]> {
  const out: HealthLine[] = []
  const reconnect = await countUsersNeedingReconnect()
  const connected = rowsOf<{ provider: string; n: string }>(await db.execute(sql`
    SELECT ui.provider, count(*) AS n FROM user_integrations ui
    JOIN users u ON u.id = ui.user_id
    WHERE u.disabled_at IS NULL AND ui.access_token_encrypted IS NOT NULL
    GROUP BY ui.provider
  `))
  const connectedOf = (p: string) => num(connected.find((r) => r.provider === p)?.n)
  const providers: Array<'salesforce' | 'microsoft'> = []
  if (crm === 'salesforce') providers.push('salesforce')
  if (msConfigured) providers.push('microsoft')
  for (const p of providers) {
    const count = reconnect.get(p) ?? 0
    if (count > 0) out.push(line('integration_users_reconnect', shareStatus(count, connectedOf(p)), { integration: p, count }))
  }
  if (msConfigured) {
    const since = new Date(now - STALE_CALENDAR_DAYS * 24 * HOUR).toISOString()
    const [stale] = rowsOf<{ n: string }>(await db.execute(sql`
      SELECT count(*) AS n FROM users u
      JOIN user_integrations ui ON ui.user_id = u.id AND ui.provider = 'microsoft' AND ui.access_token_encrypted IS NOT NULL
      WHERE u.disabled_at IS NULL
        AND (u.outlook_events_last_synced_at IS NULL OR u.outlook_events_last_synced_at < ${since}::timestamptz)
        AND EXISTS (
          SELECT 1 FROM login_events le
          WHERE le.user_id = u.id AND le.success = true AND le.created_at >= ${since}::timestamptz
        )
    `))
    const count = num(stale?.n)
    if (count > 0) out.push(line('integration_calendars_stale', shareStatus(count, connectedOf('microsoft')), { count, days: STALE_CALENDAR_DAYS }))
  }
  return out
}

async function integrationsTile(ctx: JobContext, now: number): Promise<HealthTile> {
  const lines: HealthLine[] = []

  // A job that uses an integration and failed on its latest run in the last
  // 48 hours is the cheapest real evidence that the connection is broken.
  const failingJobByIntegration = new Map<string, string>()
  for (const k of ctx.liveKeys) {
    const run = ctx.latest.get(k)
    if (!run || run.status !== 'error' || now - run.startedAt > 48 * HOUR) continue
    const integration = integrationForJob(k, ctx.crm)
    if (integration && !failingJobByIntegration.has(integration)) failingJobByIntegration.set(integration, k)
  }
  // v1.444.0: the last outcome of the app's own calls to each integration.
  const calls = await getIntegrationStatuses()
  const report = (integration: string, configured: boolean, missingStatus: HealthStatus) => {
    if (!configured) { lines.push(line('integration_missing', missingStatus, { integration })); return }
    const job = failingJobByIntegration.get(integration)
    if (job) lines.push(line('integration_job_failing', 'warning', { integration, job }))
    else if (integration === 'email') lines.push(line('integration_ok', 'ok', { integration }))
    else lines.push(integrationCallLine(integration, calls.get(integration), now))
  }

  if (ctx.crm === 'salesforce') {
    const { getAdminSfConnectionRecord } = await import('../salesforce/client.js')
    const admin = await getAdminSfConnectionRecord()
    report('salesforce', getSfIntegrationConfig() !== null && !!admin?.accessTokenEncrypted, 'error')
  } else if (ctx.crm === 'hubspot') {
    const { getHubspotConfig } = await import('../hubspot/config.js')
    const cfg = await getHubspotConfig()
    report('hubspot', cfg !== null, 'error')
    if (cfg?.lastCheck && !cfg.lastCheck.ready) lines.push(line('integration_hubspot_not_ready', 'warning', { at: cfg.lastCheck.checkedAt }))
  } else {
    lines.push(line('integration_no_crm', 'off'))
  }

  report('microsoft', getMsIntegrationConfig() !== null, 'off')
  lines.push(...await userConnectionLines(ctx.crm, getMsIntegrationConfig() !== null, now))
  report('email', getEmailIntegrationConfig() !== null, 'off')
  const { getSlackConfigSummary } = await import('../slack/client.js')
  report('slack', (await getSlackConfigSummary()).configured, 'off')
  const { isCriteriaIqConfigured } = await import('../criteriaiq/config.js')
  if (await isCriteriaIqConfigured()) report('criteriaiq', true, 'off')
  const { getGongConfig } = await import('../gong/config.js')
  const gong = await getGongConfig()
  if (gong) {
    report('gong', true, 'off')
    if (gong.lastCheck && !gong.lastCheck.ready) lines.push(line('integration_gong_not_ready', 'warning', { at: gong.lastCheck.checkedAt }))
  }
  return tileOf('integrations', lines)
}

async function emailTile(now: number): Promise<HealthTile> {
  if (!getEmailIntegrationConfig()) return tileOf('email', [line('email_off', 'off')])
  const { emailDeliverySummary } = await import('../email/deliveryLog.js')
  const s = await emailDeliverySummary(new Date(now - 24 * HOUR))
  const lines: HealthLine[] = [line('email_counts', emailStatus(s.sent, s.failed), { sent: s.sent, failed: s.failed })]
  if (s.lastFailure) {
    lines.push(line('email_last_failure', 'warning', { at: s.lastFailure.at, category: s.lastFailure.category, error: (s.lastFailure.error ?? '').slice(0, 160) }))
  }
  if (s.lastSentAt) lines.push(line('email_last_sent', 'ok', { at: s.lastSentAt }))
  return tileOf('email', lines)
}

async function aiTile(now: number): Promise<HealthTile> {
  const { getAiSettings } = await import('../ai/providers.js')
  const settings = await getAiSettings()
  if (!settings.enabled) return tileOf('ai', [line('ai_off', 'off')])
  const lines: HealthLine[] = []
  const [def] = await db.select({ id: aiProviders.id }).from(aiProviders)
    .where(and(eq(aiProviders.isActive, true), eq(aiProviders.isDefault, true))).limit(1)
  if (!def) lines.push(line('ai_no_provider', 'error'))

  const { spentThisMonthUsd } = await import('../ai/gateway.js')
  const spent = await spentThisMonthUsd(new Date(now))
  const budget = settings.monthlyBudgetUsd
  if (budget !== null && budget > 0) {
    lines.push(line('ai_budget', aiBudgetStatus(spent, budget), { spent: spent.toFixed(2), budget: budget.toFixed(2), pct: Math.round((spent / budget) * 100) }))
  } else {
    lines.push(line('ai_spent', 'ok', { spent: spent.toFixed(2) }))
  }

  const [calls] = await db
    .select({
      total: sql<string>`count(*)`,
      errors: sql<string>`count(*) FILTER (WHERE ${aiRequests.status} = 'error')`,
    })
    .from(aiRequests)
    .where(and(gte(aiRequests.createdAt, new Date(now - 24 * HOUR)), inArray(aiRequests.status, ['ok', 'error', 'refused'])))
  const total = num(calls?.total)
  const errors = num(calls?.errors)
  lines.push(line('ai_calls', aiErrorStatus(errors, total), { total, errors }))
  return tileOf('ai', lines)
}

// v1.444.0: housekeeping. Each log table's oldest row against its retention
// period (proves the 6-hourly cull runs) and the last full backup.
async function dataTile(now: number): Promise<HealthTile> {
  const lines: HealthLine[] = []
  const checks = await checkRetention(now)
  const overdue = checks.filter((c) => c.overdue)
  for (const c of overdue) lines.push(line('retention_overdue', 'warning', { table: c.key, days: c.days, oldest: c.oldestAgeDays ?? 0 }))
  if (overdue.length === 0) lines.push(line('retention_ok', 'ok', { count: checks.length }))

  const { getBackupStatus } = await import('../backup/lastBackup.js')
  const backup = await getBackupStatus()
  const last = backup.lastBackupAt ? new Date(backup.lastBackupAt).getTime() : null
  const status = backupStatus(last, backup.reminderDays, now)
  if (last === null) lines.push(line(backup.reminderDays === 0 ? 'backup_never_off' : 'backup_never', status))
  else lines.push(line(backup.reminderDays === 0 ? 'backup_last_off' : 'backup_last', status, { at: new Date(last).toISOString(), days: backup.reminderDays }))
  return tileOf('data', lines)
}

async function appTile(): Promise<HealthTile> {
  const mem = process.memoryUsage()
  const uptimeSec = Math.round(process.uptime())
  const { isErrorTrackingEnabled } = await import('../observability/errorTracking.js')
  return tileOf('app', [
    line('app_uptime', uptimeSec < 120 ? 'warning' : 'ok', { ageSec: uptimeSec, node: process.version }),
    line('app_memory', memoryStatus(mem.rss), { bytes: mem.rss, heapBytes: mem.heapUsed }),
    // Informational: Sentry is optional, so off is not a problem.
    line(isErrorTrackingEnabled() ? 'app_error_tracking_on' : 'app_error_tracking_off', isErrorTrackingEnabled() ? 'ok' : 'off'),
  ])
}

export async function getHealthOverview(now = Date.now()): Promise<HealthOverview> {
  let ctx: JobContext | null = null
  let ctxError: unknown = null
  try { ctx = await jobContext() } catch (err) { ctxError = err }
  const needCtx = (id: HealthTileId, build: (c: JobContext) => Promise<HealthTile>) =>
    safeTile(id, async () => {
      if (!ctx) throw ctxError instanceof Error ? ctxError : new Error(String(ctxError))
      return build(ctx)
    })

  const tiles = await Promise.all([
    safeTile('database', databaseTile),
    needCtx('jobs', (c) => jobsTile(c, now)),
    needCtx('queues', (c) => queuesTile(c, now)),
    needCtx('integrations', (c) => integrationsTile(c, now)),
    safeTile('email', () => emailTile(now)),
    safeTile('ai', () => aiTile(now)),
    safeTile('data', () => dataTile(now)),
    safeTile('app', appTile),
  ])
  return { checkedAt: new Date(now).toISOString(), tiles, readiness: getReadinessCalls(now) }
}
