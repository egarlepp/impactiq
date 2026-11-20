import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { hubspotOwners, crmUsers, users, type HubspotOwnerTeam } from '../../../../drizzle/schema.js'
import type { HubspotOwnerMatchSummary } from '../../../shared/hubspot.js'
import { getHubspotConfig } from './config.js'
import { HubspotError, hubspotListAll } from './client.js'
import { writeRun } from '../jobs/writeRun.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'

// HubSpot owners and how ImpactIQ users map to them (HubSpot plan, phase 2a).
// The connection is one token for the whole portal, so there's no per-user
// HubSpot login to say who someone is in HubSpot. A user's HubSpot owner is
// the one an admin linked in User Management (users.crm_user_id holds the
// owner id, v1.406.0), else the owner with the same email (case-insensitive):
// the same rule HubSpot itself uses to tie a user to an owner. Write-back
// (phase 2b) uses it to set hubspot_owner_id; a user with no match logs work
// that syncs without an owner.

interface HubspotOwnerApi {
  id?: unknown
  userId?: unknown
  email?: unknown
  firstName?: unknown
  lastName?: unknown
  teams?: unknown
}

export interface OwnerSyncResult {
  active: number
  archived: number
  removed: number
}

// crm_users holds Salesforce users (15/18-character ids) and, on HubSpot,
// HubSpot owners (numeric ids). Owner ids are well under 15 digits, so this
// pattern never matches a Salesforce row.
export const HUBSPOT_OWNER_ROW_RX = '^[0-9]{1,14}$'

export function ownerDisplayName(firstName: string | null, lastName: string | null, email: string | null, id: string): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || email || id
}

function text(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

// The owners list carries `teams` only for an owner who is on one.
export function parseOwnerTeams(v: unknown): HubspotOwnerTeam[] {
  if (!Array.isArray(v)) return []
  const out: HubspotOwnerTeam[] = []
  for (const t of v) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    const id = text(r['id'])
    const name = text(r['name'])
    if (!id || !name) continue
    out.push({ id, name, primary: r['primary'] === true })
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
}

// Does this ImpactIQ user row stand for this HubSpot owner row? A manual link
// (users.crm_user_id = the owner id) wins. Otherwise the emails match, as long
// as the user isn't linked to some other owner and no other user is linked to
// this one, so one owner never resolves to two people.
export const userIsHubspotOwner = sql`(
  ${users.crmUserId} = ${hubspotOwners.id}
  OR (
    lower(${users.email}) = lower(${hubspotOwners.email})
    AND (${users.crmUserId} IS NULL OR ${users.crmUserId} !~ ${HUBSPOT_OWNER_ROW_RX})
    AND NOT EXISTS (SELECT 1 FROM users linked WHERE linked.crm_user_id = ${hubspotOwners.id})
  )
)`

// Replaces the local copy with HubSpot's current owner list, active and
// archived. An owner HubSpot no longer returns at all is removed.
export async function syncHubspotOwners(): Promise<OwnerSyncResult> {
  const [active, archived] = await Promise.all([
    hubspotListAll<HubspotOwnerApi>('/crm/v3/owners', { limit: 100, archived: false }),
    hubspotListAll<HubspotOwnerApi>('/crm/v3/owners', { limit: 100, archived: true }),
  ])
  const now = new Date()
  const rows = new Map<string, typeof hubspotOwners.$inferInsert>()
  for (const [list, isArchived] of [[archived, true], [active, false]] as const) {
    for (const o of list) {
      const id = text(o.id)
      if (!id) continue
      // Active wins if HubSpot ever lists an id in both.
      rows.set(id, {
        id,
        hubspotUserId: text(o.userId),
        email: text(o.email)?.toLowerCase() ?? null,
        firstName: text(o.firstName),
        lastName: text(o.lastName),
        teams: parseOwnerTeams(o.teams),
        archived: isArchived,
        lastSyncedAt: now,
      })
    }
  }
  const values = [...rows.values()]
  let removed = 0
  await db.transaction(async (tx) => {
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500)
      await tx.insert(hubspotOwners).values(chunk).onConflictDoUpdate({
        target: hubspotOwners.id,
        set: {
          hubspotUserId: sql`excluded.hubspot_user_id`,
          email: sql`excluded.email`,
          firstName: sql`excluded.first_name`,
          lastName: sql`excluded.last_name`,
          teams: sql`excluded.teams`,
          archived: sql`excluded.archived`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      })
    }
    // Every row this sync touched carries `now`; anything older is gone.
    const gone = await tx.delete(hubspotOwners).where(sql`${hubspotOwners.lastSyncedAt} < ${now}`).returning({ id: hubspotOwners.id })
    removed = gone.length

    // Sales Team Alignment (phase 7b) picks reps from crm_users, and its
    // alignments point there by id. HubSpot owners are copied in under their
    // owner id. An owner that's archived or gone is marked inactive, never
    // deleted: deleting would cascade away the alignments that name it.
    const mirror = values.map((v) => ({
      id: v.id,
      name: ownerDisplayName(v.firstName ?? null, v.lastName ?? null, v.email ?? null, v.id),
      email: v.email ?? null,
      managerId: null,
      title: null,
      isActive: !v.archived,
      lastSyncedAt: now,
    }))
    for (let i = 0; i < mirror.length; i += 500) {
      await tx.insert(crmUsers).values(mirror.slice(i, i + 500)).onConflictDoUpdate({
        target: crmUsers.id,
        set: {
          name: sql`excluded.name`,
          email: sql`excluded.email`,
          managerId: sql`excluded.manager_id`,
          isActive: sql`excluded.is_active`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      })
    }
    await tx.update(crmUsers).set({ isActive: false })
      .where(sql`${crmUsers.id} ~ ${HUBSPOT_OWNER_ROW_RX} AND ${crmUsers.lastSyncedAt} < ${now}`)
  })
  return {
    active: values.filter((v) => !v.archived).length,
    archived: values.filter((v) => v.archived).length,
    removed,
  }
}

// The HubSpot owner id for a user (manual link, else email). Active owners
// only: an archived owner can't own new records in HubSpot.
export async function getHubspotOwnerIdForUser(userId: string): Promise<string | null> {
  const rows = await db.select({ id: hubspotOwners.id, linked: sql<boolean>`${users.crmUserId} = ${hubspotOwners.id}` })
    .from(users)
    .innerJoin(hubspotOwners, userIsHubspotOwner)
    .where(sql`${users.id} = ${userId} AND ${hubspotOwners.archived} = false`)
  return (rows.find((r) => r.linked) ?? rows[0])?.id ?? null
}

// The ImpactIQ user a HubSpot owner stands for, if any.
export async function getUserForHubspotOwner(ownerId: string): Promise<{ id: string; displayName: string; email: string } | null> {
  const [row] = await db.select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(hubspotOwners)
    .innerJoin(users, userIsHubspotOwner)
    .where(eq(hubspotOwners.id, ownerId))
    .limit(1)
  return row ?? null
}

// The HubSpot owner a user is linked to, with its teams, for User Management.
export async function getHubspotOwnerDetailsForUser(userId: string): Promise<{ ownerId: string; teams: HubspotOwnerTeam[] } | null> {
  const ownerId = await getHubspotOwnerIdForUser(userId)
  if (!ownerId) return null
  const [row] = await db.select({ teams: hubspotOwners.teams }).from(hubspotOwners).where(eq(hubspotOwners.id, ownerId)).limit(1)
  return { ownerId, teams: row?.teams ?? [] }
}

// Every HubSpot team name active owners are on, for Team Management's
// department link. q filters by name (case-insensitive).
export async function listHubspotTeamNames(q = ''): Promise<string[]> {
  const rows = await db.select({ teams: hubspotOwners.teams }).from(hubspotOwners).where(eq(hubspotOwners.archived, false))
  const needle = q.trim().toLowerCase()
  const names = new Set<string>()
  for (const r of rows) for (const t of r.teams ?? []) if (!needle || t.name.toLowerCase().includes(needle)) names.add(t.name)
  return [...names].sort((a, b) => a.localeCompare(b)).slice(0, 200)
}

export async function getHubspotOwnerMatchSummary(): Promise<HubspotOwnerMatchSummary> {
  const [stats] = await db.select({
    owners: sql<string>`count(*) FILTER (WHERE ${hubspotOwners.archived} = false)`,
    lastSyncedAt: sql<Date | string | null>`max(${hubspotOwners.lastSyncedAt})`,
  }).from(hubspotOwners)
  const all = await db.select({
    id: users.id,
    displayName: users.displayName,
    email: users.email,
    // Spelled out with table names: in a one-table select drizzle leaves
    // columns unqualified, which would compare the owner's email to itself.
    // Same rule as userIsHubspotOwner.
    matched: sql<boolean>`EXISTS (SELECT 1 FROM hubspot_owners ho WHERE ho.archived = false AND (
      "users"."crm_user_id" = ho.id
      OR (lower(ho.email) = lower("users"."email")
        AND ("users"."crm_user_id" IS NULL OR "users"."crm_user_id" !~ ${HUBSPOT_OWNER_ROW_RX})
        AND NOT EXISTS (SELECT 1 FROM users linked WHERE linked.crm_user_id = ho.id))))`,
  }).from(users).orderBy(asc(users.displayName))
  const last = stats?.lastSyncedAt ?? null
  return {
    // count() comes back from the postgres driver as a string.
    owners: Number(stats?.owners ?? 0),
    lastSyncedAt: last === null ? null : new Date(last).toISOString(),
    matchedUsers: all.filter((u) => u.matched).length,
    unmatchedUsers: all.filter((u) => !u.matched).map(({ id, displayName, email }) => ({ id, displayName, email })),
  }
}

export async function clearHubspotOwners(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(hubspotOwners)
    await tx.update(crmUsers).set({ isActive: false }).where(sql`${crmUsers.id} ~ ${HUBSPOT_OWNER_ROW_RX}`)
  })
}

// The daily job. Runs only while a HubSpot connection is saved, so an install
// without HubSpot never writes a run row.
// v1.437.1: also a no-op unless HubSpot is the active CRM. The nightly job is
// already skipped by the scheduler (jobs/jobCrm.ts), but the HubSpot card's
// Sync owners button called this directly, so a saved key on a Salesforce or
// None install could still pull HubSpot owners. Checked here so every caller
// gets the same rule.
export async function runHubspotOwnerSync(opts: { source?: 'scheduled' | 'manual' } = {}): Promise<OwnerSyncResult | null> {
  if (!(await isCrmProviderActive('hubspot'))) return null
  if (!(await getHubspotConfig())) return null
  const startedAt = new Date()
  try {
    const result = await syncHubspotOwners()
    await writeRun('hubspot_owner_sync', startedAt, 'ok',
      `${result.active} active, ${result.archived} archived HubSpot owners`, { ...result, source: opts.source ?? 'scheduled' })
    return result
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)
    await writeRun('hubspot_owner_sync', startedAt, 'error', code, { source: opts.source ?? 'scheduled' })
    throw err
  }
}

let stopFn: (() => void) | null = null
export function startHubspotOwnerSyncWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob('hubspot_owner_sync', 24 * 60 * 60 * 1000, async () => {
    await runHubspotOwnerSync().catch(() => {})
  }, { firstRunDelayMs: 3 * 60 * 1000 })
}

// The local owner list, for tests and debugging.
export async function listHubspotOwners() {
  return db.select().from(hubspotOwners).orderBy(asc(hubspotOwners.email))
}
