import { Router } from 'express'
import { db, runMigrations } from '../../db/index.js'
import { getMigrationStatus } from '../../services/health/migrations.js'
import { users } from '../../../../drizzle/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { desc } from 'drizzle-orm'
import { z } from 'zod'

export const systemRoutes = Router()

// App Admin only — re-runs the exact same runMigrations() the server calls
// at boot, so admins can apply a newly-added migration without waiting for
// (or triggering) a full process restart. Safe to call anytime: drizzle-orm
// only applies files it hasn't recorded yet, so a click with nothing pending
// is a no-op.
systemRoutes.post('/run-migrations', requireAppAdmin, async (_req, res) => {
  try {
    await runMigrations()
    const status = await getMigrationStatus()
    res.json({ data: status, error: null, meta: {} })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ data: null, error: msg, meta: {} })
  }
})

// ─── App / DB Health monitor ────────────────────────────────────────────
// Read-only Postgres introspection so admins can watch table sizes, row
// counts, scan patterns, slowest queries and connection headroom as the
// data grows. All numbers come straight from the catalog / stats views — no
// app tables involved. pg_stat_statements is optional; we degrade gracefully
// when it isn't installed.
systemRoutes.get('/db-health', requireAppAdmin, async (_req, res) => {
  const [{ bytes: dbSizeBytes } = { bytes: null }] = (await db.execute(sql`
    SELECT pg_database_size(current_database()) AS bytes
  `)) as unknown as Array<{ bytes: string | null }>

  const tables = (await db.execute(sql`
    SELECT relname AS name,
           n_live_tup AS rows,
           seq_scan AS seq_scan,
           COALESCE(idx_scan, 0) AS idx_scan,
           pg_total_relation_size(relid) AS total_bytes,
           pg_relation_size(relid) AS table_bytes,
           pg_indexes_size(relid) AS index_bytes
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(relid) DESC
    LIMIT 40
  `)) as unknown as Array<Record<string, string | number | null>>

  const [conns = { used: null, max: null }] = (await db.execute(sql`
    SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS used,
           current_setting('max_connections')::int AS max
  `)) as unknown as Array<{ used: string | null; max: number | null }>

  // pg_stat_statements is optional — querying it throws if the extension
  // isn't installed. Surface that as a hint rather than a 500.
  let slowQueries: Array<Record<string, unknown>> = []
  let statStatementsAvailable = true
  try {
    slowQueries = (await db.execute(sql`
      SELECT left(query, 200) AS query,
             calls,
             round(mean_exec_time::numeric, 1) AS mean_ms,
             round(total_exec_time::numeric, 1) AS total_ms,
             rows
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND query NOT LIKE '%pg_stat_statements%'
      ORDER BY total_exec_time DESC
      LIMIT 20
    `)) as unknown as Array<Record<string, unknown>>
  } catch {
    statStatementsAvailable = false
  }

  const mem = process.memoryUsage()
  const migrations = await getMigrationStatus()
  res.json({
    data: {
      db: { sizeBytes: dbSizeBytes, connectionsUsed: conns.used, connectionsMax: conns.max },
      tables,
      slowQueries: { available: statStatementsAvailable, rows: slowQueries },
      app: { uptimeSec: Math.round(process.uptime()), nodeVersion: process.version, rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      migrations,
    },
    error: null,
  })
})

// v1.440.0: System Health Overview tiles at the top of App Health. Each tile
// is computed independently (services/health/overview.ts), so one failed
// check shows on its own tile instead of failing the request.
systemRoutes.get('/health-overview', requireAppAdmin, async (_req, res) => {
  const { getHealthOverview } = await import('../../services/health/overview.js')
  res.json({ data: await getHealthOverview(), error: null, meta: {} })
})

// v1.227.0: must mirror the GET /scheduling registry's cadenceEditable
// flags — the two clock-gated jobs and the manually-triggered backfill
// don't have an admin-meaningful interval.
const SCHEDULING_NON_CADENCE_EDITABLE_JOBS = new Set(['digest_worker', 'weekly_recap_worker', 'historical_backfill'])
const SCHEDULING_MIN_INTERVAL_MS = 10_000
// v1.230.0: the only jobs whose local send-time (not tick interval) is
// admin-editable — see GET /scheduling's scheduleEditable flag.
const SCHEDULING_SCHEDULE_EDITABLE_JOBS = new Set(['digest_worker', 'weekly_recap_worker'])

// v1.141.0 / v1.227.0 / v1.230.0: PATCH /admin/scheduling/:jobKey —
// { notifyOnError?, enabled?, intervalMs?, scheduleHour?, scheduleMinute?,
// scheduleDayOfWeek? }. All optional; only the fields sent are upserted.
systemRoutes.patch('/scheduling/:jobKey', requireAppAdmin, async (req, res) => {
  const { jobKey } = req.params as { jobKey: string }
  const { jobConfig } = await import('../../../../drizzle/schema.js')
  const schema = z.object({
    notifyOnError: z.boolean().optional(),
    enabled: z.boolean().optional(),
    intervalMs: z.number().positive().optional(),
    scheduleHour: z.number().int().min(0).max(23).optional(),
    scheduleMinute: z.number().int().min(0).max(59).optional(),
    scheduleDayOfWeek: z.number().int().min(0).max(6).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { notifyOnError, enabled, intervalMs, scheduleHour, scheduleMinute, scheduleDayOfWeek } = parsed.data

  if (intervalMs !== undefined) {
    if (SCHEDULING_NON_CADENCE_EDITABLE_JOBS.has(jobKey)) {
      res.status(400).json({ data: null, error: 'errors.scheduling.cadence_not_editable', meta: {} }); return
    }
    if (intervalMs < SCHEDULING_MIN_INTERVAL_MS) {
      res.status(400).json({ data: null, error: 'errors.scheduling.interval_too_low', meta: {} }); return
    }
  }

  if ((scheduleHour !== undefined || scheduleMinute !== undefined || scheduleDayOfWeek !== undefined)
    && !SCHEDULING_SCHEDULE_EDITABLE_JOBS.has(jobKey)) {
    res.status(400).json({ data: null, error: 'errors.scheduling.schedule_not_editable', meta: {} }); return
  }
  // scheduleDayOfWeek only means anything for weekly_recap_worker —
  // digest_worker fires daily, so a day-of-week override there would be
  // silently ignored by the worker anyway. Reject it explicitly instead of
  // accepting a value that does nothing.
  if (scheduleDayOfWeek !== undefined && jobKey !== 'weekly_recap_worker') {
    res.status(400).json({ data: null, error: 'errors.scheduling.day_of_week_not_applicable', meta: {} }); return
  }

  const updateData: {
    notifyOnError?: boolean; enabled?: boolean; intervalMs?: number
    scheduleHour?: number; scheduleMinute?: number; scheduleDayOfWeek?: number
  } = {}
  if (notifyOnError !== undefined) updateData.notifyOnError = notifyOnError
  if (enabled !== undefined) updateData.enabled = enabled
  if (intervalMs !== undefined) updateData.intervalMs = intervalMs
  if (scheduleHour !== undefined) updateData.scheduleHour = scheduleHour
  if (scheduleMinute !== undefined) updateData.scheduleMinute = scheduleMinute
  if (scheduleDayOfWeek !== undefined) updateData.scheduleDayOfWeek = scheduleDayOfWeek
  if (Object.keys(updateData).length === 0) { res.status(400).json({ data: null, error: 'errors.validation.no_fields', meta: {} }); return }

  await db.insert(jobConfig).values({ jobKey, ...updateData })
    .onConflictDoUpdate({ target: jobConfig.jobKey, set: updateData })
  res.json({ data: { ok: true }, error: null })
})

// ─── v1.145.0: MCP admin surfaces ───────────────────────────────────────
systemRoutes.get('/mcp-activity', requireAppAdmin, async (req, res) => {
  const { mcpToolCalls, apiKeys } = await import('../../../../drizzle/schema.js')
  const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 200)))
  const statusF = String(req.query['status'] ?? '')
  const toolF = String(req.query['tool'] ?? '')
  const clauses = [] as ReturnType<typeof eq>[]
  if (statusF === 'ok' || statusF === 'error' || statusF === 'throttled') clauses.push(eq(mcpToolCalls.status, statusF))
  if (toolF) clauses.push(eq(mcpToolCalls.tool, toolF))
  const rows = await db
    .select({
      id: mcpToolCalls.id,
      calledAt: mcpToolCalls.calledAt,
      tool: mcpToolCalls.tool,
      status: mcpToolCalls.status,
      latencyMs: mcpToolCalls.latencyMs,
      error: mcpToolCalls.error,
      userId: mcpToolCalls.userId,
      userEmail: users.email,
      userName: users.displayName,
      apiKeyId: mcpToolCalls.apiKeyId,
      apiKeyName: apiKeys.name,
      apiKeyPrefix: apiKeys.keyPrefix,
    })
    .from(mcpToolCalls)
    .leftJoin(users, eq(users.id, mcpToolCalls.userId))
    .leftJoin(apiKeys, eq(apiKeys.id, mcpToolCalls.apiKeyId))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(mcpToolCalls.calledAt))
    .limit(limit)
  res.json({ data: rows, error: null, meta: { count: rows.length } })
})

// GET/PATCH /admin/mcp-config — tenant on/off toggle.
systemRoutes.get('/mcp-config', requireAppAdmin, async (_req, res) => {
  const { systemSettings } = await import('../../../../drizzle/schema.js')
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'mcp_enabled')).limit(1)
  const enabled = (row?.value as { enabled?: boolean } | null)?.enabled
  res.json({ data: { enabled: enabled !== false }, error: null })
})
systemRoutes.patch('/mcp-config', requireAppAdmin, async (req, res) => {
  const { systemSettings } = await import('../../../../drizzle/schema.js')
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message }); return }
  await db.insert(systemSettings).values({ key: 'mcp_enabled', value: { enabled: parsed.data.enabled } })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: { enabled: parsed.data.enabled } } })
  res.json({ data: { enabled: parsed.data.enabled }, error: null })
})
