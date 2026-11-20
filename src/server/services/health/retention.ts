import { sql } from 'drizzle-orm'
import { db } from '../../db/index.js'

// v1.444.0: the log tables the 6-hourly housekeeping cull (sync_audit_cull,
// services/salesforce/writeback.ts) trims, and how long each keeps rows. The
// cull reads its days from here and App Health compares each table's oldest
// row with the same number, so the two can't disagree.

export interface RetentionPolicy {
  key: string
  table: string
  column: string
  // Env var that overrides the default; null when the period is fixed.
  envKey: string | null
  defaultDays: number
  // Rows the cull never removes (still in flight), so they don't count.
  keepWhere?: string
  // Set when the period is an admin setting rather than an env var.
  setting?: 'gong_transcript_cache_days'
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  { key: 'audit_events', table: 'audit_events', column: 'created_at', envKey: 'AUDIT_EVENTS_RETENTION_DAYS', defaultDays: 1095 },
  { key: 'job_runs', table: 'job_runs', column: 'started_at', envKey: 'JOB_RUNS_RETENTION_DAYS', defaultDays: 90 },
  { key: 'login_events', table: 'login_events', column: 'created_at', envKey: 'LOGIN_EVENTS_RETENTION_DAYS', defaultDays: 60 },
  { key: 'ai_requests', table: 'ai_requests', column: 'created_at', envKey: 'AI_REQUESTS_RETENTION_DAYS', defaultDays: 395 },
  { key: 'event_webhook_deliveries', table: 'event_webhook_deliveries', column: 'created_at', envKey: 'EVENT_WEBHOOK_DELIVERIES_RETENTION_DAYS', defaultDays: 30, keepWhere: `status = 'pending'` },
  { key: 'email_deliveries', table: 'email_deliveries', column: 'created_at', envKey: 'EMAIL_DELIVERIES_RETENTION_DAYS', defaultDays: 30 },
  { key: 'activity_sync_audit', table: 'activity_sync_audit', column: 'attempted_at', envKey: null, defaultDays: 30 },
  { key: 'nudge_events', table: 'nudge_events', column: 'delivered_at', envKey: null, defaultDays: 30 },
  { key: 'mcp_tool_calls', table: 'mcp_tool_calls', column: 'called_at', envKey: null, defaultDays: 30 },
  // v1.453.0: the Gong transcript cache, kept for the days set on Admin → Integrations → Gong.
  { key: 'gong_transcript_cache', table: 'gong_transcript_cache', column: 'fetched_at', envKey: null, defaultDays: 30, setting: 'gong_transcript_cache_days' },
  // v1.457.0: AI Note items nobody reviewed go with the transcript they came from.
  { key: 'activity_ai_note_items', table: 'activity_ai_note_items', column: 'created_at', envKey: null, defaultDays: 30, keepWhere: `status <> 'to_review' OR from_transcript = false`, setting: 'gong_transcript_cache_days' },
]

export function retentionDays(key: string): number {
  const policy = RETENTION_POLICIES.find((p) => p.key === key)
  if (!policy) throw new Error(`Unknown retention policy: ${key}`)
  if (policy.envKey) {
    const n = Number(process.env[policy.envKey])
    if (Number.isFinite(n) && n > 0) return n
  }
  return policy.defaultDays
}

// retentionDays() for a policy whose period may be an admin setting.
export async function resolveRetentionDays(policy: RetentionPolicy): Promise<number> {
  if (policy.setting === 'gong_transcript_cache_days') {
    const { getGongTranscriptCacheDays } = await import('../gong/config.js')
    return getGongTranscriptCacheDays()
  }
  return retentionDays(policy.key)
}

// The cull runs every 6 hours; a row a day past its period is still normal.
export const RETENTION_GRACE_DAYS = 2

export interface RetentionCheck {
  key: string
  days: number
  oldestAgeDays: number | null
  overdue: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

// Oldest row per table, from the same indexes the cull deletes by. Table and
// column names come from the constant list above, never from input.
export async function checkRetention(now: number = Date.now()): Promise<RetentionCheck[]> {
  const out: RetentionCheck[] = []
  for (const p of RETENTION_POLICIES) {
    const where = p.keepWhere ? sql.raw(` WHERE NOT (${p.keepWhere})`) : sql.raw('')
    const result = await db.execute(sql`SELECT min(${sql.identifier(p.column)}) AS oldest FROM ${sql.identifier(p.table)}${where}`)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const oldest = (rows[0] as { oldest?: unknown } | undefined)?.oldest
    const t = oldest === null || oldest === undefined ? null : new Date(oldest instanceof Date ? oldest : String(oldest)).getTime()
    const days = await resolveRetentionDays(p)
    const oldestAgeDays = t === null || !Number.isFinite(t) ? null : Math.floor((now - t) / DAY_MS)
    out.push({ key: p.key, days, oldestAgeDays, overdue: oldestAgeDays !== null && oldestAgeDays > days + RETENTION_GRACE_DAYS })
  }
  return out
}
