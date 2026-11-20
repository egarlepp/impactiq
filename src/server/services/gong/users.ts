import { asc, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { gongUsers, users } from '../../../../drizzle/schema.js'
import type { GongUserMatchSummary, GongUserOption } from '../../../shared/gong.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { GongError, gongListAll } from './client.js'
import { getGongConfig } from './config.js'

// Gong users and how ImpactIQ users map to them (Gong plan, phase 1). A
// user's Gong identity is the Gong user with the same email
// (case-insensitive). Phase 2 uses it to tell which ImpactIQ people were on
// a call.

export interface GongUserRow {
  id: string
  email: string | null
  firstName: string | null
  lastName: string | null
  title: string | null
  active: boolean
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

// One user from GET /v2/users. Null when the row has no id.
export function toGongUserRow(raw: unknown): GongUserRow | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const id = typeof u['id'] === 'number' ? String(u['id']) : str(u['id'])
  if (!id) return null
  return {
    id,
    email: str(u['emailAddress'])?.toLowerCase() ?? null,
    firstName: str(u['firstName']),
    lastName: str(u['lastName']),
    title: str(u['title']),
    active: u['active'] !== false,
  }
}

export function pickGongUsers(body: unknown): GongUserRow[] {
  if (!body || typeof body !== 'object') return []
  const list = (body as Record<string, unknown>)['users']
  if (!Array.isArray(list)) return []
  return list.map(toGongUserRow).filter((u): u is GongUserRow => u !== null)
}

export interface GongUserSyncResult {
  active: number
  inactive: number
  removed: number
}

// Replaces the local list with Gong's. Users Gong no longer lists are
// removed; Gong keeps deactivated users listed, so removal is rare.
export async function syncGongUsers(): Promise<GongUserSyncResult> {
  const rows = await gongListAll('/v2/users', pickGongUsers, { maxPages: 200 })
  const now = new Date()
  let removed = 0
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, lastSyncedAt: now }))
      await tx.insert(gongUsers).values(chunk).onConflictDoUpdate({
        target: gongUsers.id,
        set: {
          email: sql`excluded.email`,
          firstName: sql`excluded.first_name`,
          lastName: sql`excluded.last_name`,
          title: sql`excluded.title`,
          active: sql`excluded.active`,
          lastSyncedAt: now,
        },
      })
    }
    const gone = await tx.delete(gongUsers).where(sql`${gongUsers.lastSyncedAt} < ${now.toISOString()}::timestamptz`).returning({ id: gongUsers.id })
    removed = gone.length
  })
  return {
    active: rows.filter((r) => r.active).length,
    inactive: rows.filter((r) => !r.active).length,
    removed,
  }
}

export async function getGongUserMatchSummary(): Promise<GongUserMatchSummary> {
  const [stats] = await db.select({
    n: sql<string>`count(*) FILTER (WHERE ${gongUsers.active} = true)`,
    lastSyncedAt: sql<Date | string | null>`max(${gongUsers.lastSyncedAt})`,
  }).from(gongUsers)
  const all = await db.select({
    id: users.id,
    displayName: users.displayName,
    email: users.email,
    gongUserId: users.gongUserId,
    gongUserName: sql<string | null>`(SELECT nullif(trim(concat_ws(' ', gu.first_name, gu.last_name)), '') FROM gong_users gu WHERE gu.id = "users"."gong_user_id")`,
    matched: sql<boolean>`EXISTS (SELECT 1 FROM gong_users gu WHERE gu.active = true AND lower(gu.email) = lower("users"."email"))`,
  }).from(users).where(sql`${users.disabledAt} IS NULL`).orderBy(asc(users.displayName))
  const last = stats?.lastSyncedAt ?? null
  return {
    // count() comes back from the postgres driver as a string.
    gongUsers: Number(stats?.n ?? 0),
    lastSyncedAt: last === null ? null : new Date(last).toISOString(),
    matchedUsers: all.filter((u) => u.matched || u.gongUserId).length,
    unmatchedUsers: all.filter((u) => !u.matched && !u.gongUserId).map(({ id, displayName, email }) => ({ id, displayName, email })),
    manualLinks: all
      .filter((u): u is typeof u & { gongUserId: string } => !!u.gongUserId)
      .map(({ id, displayName, email, gongUserId, gongUserName }) => ({ id, displayName, email, gongUserId, gongUserName })),
  }
}

// Active Gong users, for the manual link picker on the Gong card.
export async function listGongUserOptions(): Promise<GongUserOption[]> {
  const rows = await db.select().from(gongUsers).where(sql`${gongUsers.active} = true`).orderBy(asc(gongUsers.firstName), asc(gongUsers.lastName))
  return rows.map((r) => ({
    id: r.id,
    name: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || r.id,
    email: r.email,
  }))
}

export async function clearGongUsers(): Promise<void> {
  await db.delete(gongUsers)
}

// The daily job. A no-op without a Gong connection, so an install without
// Gong never writes a run row (the scheduler also holds it back, JOB_NEEDS).
export async function runGongUserSync(opts: { source?: 'scheduled' | 'manual' } = {}): Promise<GongUserSyncResult | null> {
  if (!(await getGongConfig())) return null
  const startedAt = new Date()
  try {
    const result = await syncGongUsers()
    await writeRun('gong_user_sync', startedAt, 'ok', `${result.active} active, ${result.inactive} inactive Gong users`, { ...result, source: opts.source ?? 'scheduled' })
    return result
  } catch (err) {
    const code = err instanceof GongError ? err.code : err instanceof Error ? err.message : String(err)
    await writeRun('gong_user_sync', startedAt, 'error', code, { source: opts.source ?? 'scheduled' })
    throw err
  }
}

let stopFn: (() => void) | null = null
export function startGongUserSyncWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob('gong_user_sync', 24 * 60 * 60 * 1000, async () => {
    await runGongUserSync().catch(() => {})
  }, { firstRunDelayMs: 4 * 60 * 1000 })
}
