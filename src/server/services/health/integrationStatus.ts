import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { integrationStatus, userIntegrations, users } from '../../../../drizzle/schema.js'

// v1.444.0: what App Health knows about each integration comes from the app's
// own calls, never from a probe the page makes. Each client reports its
// outcome here: a success means the service answered (any answer it can make
// sense of), a failure means it couldn't be reached or refused the
// credentials. Recording must never fail or slow the call it describes, so it
// is fire-and-forget and a write error is only logged.

export const INTEGRATION_KEYS = ['salesforce', 'hubspot', 'microsoft', 'slack', 'criteriaiq', 'gong'] as const
export type IntegrationKey = typeof INTEGRATION_KEYS[number]

const ERROR_MAX = 300
// A busy client (HubSpot search, say) would otherwise write a row per call.
// Successes are written at most once a minute per integration, and a
// failure at most every 10 seconds; the first of each always goes through.
const SUCCESS_WRITE_EVERY_MS = 60 * 1000
const FAILURE_WRITE_EVERY_MS = 10 * 1000
const lastWrite = new Map<string, number>()

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX)
}

export async function writeIntegrationCall(key: IntegrationKey, ok: boolean, error: unknown = null, now: Date = new Date()): Promise<void> {
  const values = ok
    ? { integration: key, lastSuccessAt: now, updatedAt: now }
    : { integration: key, lastFailureAt: now, lastError: errorText(error), updatedAt: now }
  await db.insert(integrationStatus).values(values).onConflictDoUpdate({
    target: integrationStatus.integration,
    set: ok
      ? { lastSuccessAt: now, updatedAt: now }
      : { lastFailureAt: now, lastError: errorText(error), updatedAt: now },
  })
}

export function recordIntegrationCall(key: IntegrationKey, ok: boolean, error: unknown = null): void {
  const throttleKey = `${key}:${ok ? 'ok' : 'fail'}`
  const now = Date.now()
  const last = lastWrite.get(throttleKey)
  if (last !== undefined && now - last < (ok ? SUCCESS_WRITE_EVERY_MS : FAILURE_WRITE_EVERY_MS)) return
  lastWrite.set(throttleKey, now)
  // A failure is news even inside the success window: let the next success
  // through so the tile can show the connection came back.
  if (!ok) lastWrite.delete(`${key}:ok`)
  writeIntegrationCall(key, ok, error).catch((err) => {
    console.warn(`[health] could not record ${key} call:`, err instanceof Error ? err.message : String(err))
  })
}

// Test hook: forget the write throttle.
export function resetIntegrationCallThrottle(): void {
  lastWrite.clear()
}

export interface IntegrationCallStatus {
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  lastError: string | null
}

export async function getIntegrationStatuses(): Promise<Map<string, IntegrationCallStatus>> {
  const rows = await db.select().from(integrationStatus)
  return new Map(rows.map((r) => [r.integration, { lastSuccessAt: r.lastSuccessAt, lastFailureAt: r.lastFailureAt, lastError: r.lastError }]))
}

// ─── A user's own connection ────────────────────────────────────────────

// Called when refreshing a user's Salesforce / Microsoft token fails: the
// connection keeps failing until they reconnect, so App Health counts it.
export async function markUserIntegrationFailed(integrationId: string, err: unknown): Promise<void> {
  try {
    await db.update(userIntegrations)
      .set({ lastError: errorText(err), lastErrorAt: new Date() })
      .where(eq(userIntegrations.id, integrationId))
  } catch (writeErr) {
    console.warn('[health] could not record a token refresh failure:', writeErr instanceof Error ? writeErr.message : String(writeErr))
  }
}

// The columns a successful refresh or a reconnect sets to clear the mark.
export const CLEARED_USER_INTEGRATION_ERROR = { lastError: null, lastErrorAt: null } as const

// Active users whose own connection failed its last token refresh.
export async function countUsersNeedingReconnect(): Promise<Map<'salesforce' | 'microsoft', number>> {
  const rows = await db.select({ provider: userIntegrations.provider, n: sql<string>`count(*)` })
    .from(userIntegrations)
    .innerJoin(users, eq(users.id, userIntegrations.userId))
    .where(and(isNotNull(userIntegrations.lastErrorAt), isNull(users.disabledAt)))
    .groupBy(userIntegrations.provider)
  return new Map(rows.map((r) => [r.provider, Number(r.n)]))
}
