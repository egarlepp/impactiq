import { db } from '../../../db/index.js'
import {
  users,
  teamMembers,
  teamActivityTypes,
  crmUsers,
  crmHistoricalTypeMap,
} from '../../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { getHistoricalAllDayCapHours, DEFAULT_ALL_DAY_CAP_HOURS } from '../../config/integrations.js'

// v1.213.0: resolves a raw historical Salesforce Event to ImpactIQ's local
// user / team / activity-type entities.
//
// Everything here is pure once the maps are loaded: `loadLinkageMaps()` runs
// a handful of queries ONCE per import run, and `resolveEventLinkage()` is a
// synchronous in-memory lookup per row. Never issue a per-row query from the
// ingest loop — at ~48k events that would be ~150k round-trips.
//
// Every resolution records HOW it was made (`userMatchMethod` /
// `typeMatchMethod`) so an admin can later audit a link, and so a relink pass
// can tell an admin-mapped row from an auto-matched one.

export type UserMatchMethod = 'sf_user_id' | 'email' | null
export type TypeMatchMethod = 'picklist_override' | 'name_exact' | 'admin_map' | null

export interface LinkageMaps {
  /** SF User Id (both 15- and 18-char forms) -> local user. */
  userBySfId: Map<string, { userId: string; teamId: string | null }>
  /** Lowercased email -> local user. */
  userByEmail: Map<string, { userId: string; teamId: string | null }>
  /** SF User Id -> lowercased email, from the crm_users directory cache. */
  emailBySfUserId: Map<string, string>
  /** `${teamId}::${lowercased sf type}` -> activityTypeId (or AMBIGUOUS). */
  typeByTeamAndValue: Map<string, string | typeof AMBIGUOUS>
  /** `${teamId}::${lowercased sf type}` -> admin-mapped activityTypeId. */
  adminTypeMap: Map<string, string>
  /**
   * Admin-configured cap for all-day event estimates. Loaded here so ingest
   * and the relink recompute read one value and can't drift.
   */
  allDayCapHours: number
}

/**
 * Marker for an SF Type value that two or more active activity types in the
 * same team both claim. We deliberately resolve these to NULL rather than
 * picking one: a wrong deterministic guess fabricates history that a leader
 * will read as fact, whereas NULL is visibly unmapped.
 */
export const AMBIGUOUS = Symbol('ambiguous')

/**
 * Salesforce Ids come in 15-char (case-sensitive) and 18-char (case-safe)
 * forms. SOQL returns 18; `users.crm_user_id` may have been populated from
 * either, and an admin pasting from a Salesforce URL gets 15. Index both so
 * the forms are interchangeable.
 *
 * Exported because EVERY Id match site in the historical feature must route
 * through this one function — linkage, exclusion matching, purge predicates,
 * and the admin discovery panel. A 15/18 mismatch is the easiest correctness
 * bug to introduce here, and it fails silently.
 */
export function sfIdKeys(id: string): string[] {
  const trimmed = id.trim()
  if (!trimmed) return []
  return trimmed.length === 18 ? [trimmed, trimmed.slice(0, 15)] : [trimmed]
}

export async function loadLinkageMaps(): Promise<LinkageMaps> {
  const userBySfId = new Map<string, { userId: string; teamId: string | null }>()
  const userByEmail = new Map<string, { userId: string; teamId: string | null }>()
  const emailBySfUserId = new Map<string, string>()
  const typeByTeamAndValue = new Map<string, string | typeof AMBIGUOUS>()
  const adminTypeMap = new Map<string, string>()
  const allDayCapHours = await getHistoricalAllDayCapHours()

  // --- users, and the team each one resolves to ---------------------------
  const userRows = await db
    .select({
      id: users.id,
      email: users.email,
      crmUserId: users.crmUserId,
      defaultTeamId: users.defaultTeamId,
    })
    .from(users)

  // Team membership, so a single-team user resolves without needing
  // defaultTeamId set. Multi-team users fall back to defaultTeamId, because
  // an Event carries nothing that could disambiguate.
  const membershipRows = await db
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers)
  const teamsByUser = new Map<string, string[]>()
  for (const m of membershipRows) {
    const list = teamsByUser.get(m.userId) ?? []
    if (!list.includes(m.teamId)) list.push(m.teamId)
    teamsByUser.set(m.userId, list)
  }

  for (const u of userRows) {
    const memberTeams = teamsByUser.get(u.id) ?? []
    const teamId = memberTeams.length === 1 ? memberTeams[0]! : (u.defaultTeamId ?? null)
    const entry = { userId: u.id, teamId }
    if (u.crmUserId) for (const k of sfIdKeys(u.crmUserId)) userBySfId.set(k, entry)
    if (u.email) userByEmail.set(u.email.toLowerCase(), entry)
  }

  // --- SF user directory, for the email fallback --------------------------
  const sfUserRows = await db.select({ id: crmUsers.id, email: crmUsers.email }).from(crmUsers)
  for (const s of sfUserRows) {
    if (!s.email) continue
    for (const k of sfIdKeys(s.id)) emailBySfUserId.set(k, s.email.toLowerCase())
  }

  // --- activity types, per team -------------------------------------------
  // Only ACTIVE types participate. A value claimed by 2+ active types in the
  // same team is marked AMBIGUOUS rather than arbitrarily resolved.
  const typeRows = await db
    .select({
      id: teamActivityTypes.id,
      teamId: teamActivityTypes.teamId,
      name: teamActivityTypes.name,
      crmPicklistValue: teamActivityTypes.crmPicklistValue,
      isActive: teamActivityTypes.isActive,
    })
    .from(teamActivityTypes)

  const claim = (teamId: string, value: string | null | undefined, typeId: string) => {
    const v = (value ?? '').trim().toLowerCase()
    if (!v) return
    const key = `${teamId}::${v}`
    const existing = typeByTeamAndValue.get(key)
    if (existing === undefined) typeByTeamAndValue.set(key, typeId)
    else if (existing !== typeId) typeByTeamAndValue.set(key, AMBIGUOUS)
  }
  // team_activity_types.team_id is nullable; a type with no team can't be
  // resolved against a team-scoped Event, so skip those rows entirely.
  const activeTyped = typeRows.filter((t) => t.isActive && !!t.teamId)
  // Explicit picklist overrides win over bare names, so seed them first and
  // only let a name claim a key that no picklist value already owns.
  for (const t of activeTyped) claim(t.teamId!, t.crmPicklistValue, t.id)
  for (const t of activeTyped) {
    const key = `${t.teamId!}::${t.name.trim().toLowerCase()}`
    if (!typeByTeamAndValue.has(key)) typeByTeamAndValue.set(key, t.id)
    else claim(t.teamId!, t.name, t.id)
  }

  // --- admin overrides ------------------------------------------------------
  const mapRows = await db
    .select({
      teamId: crmHistoricalTypeMap.teamId,
      crmTypeValue: crmHistoricalTypeMap.crmTypeValue,
      activityTypeId: crmHistoricalTypeMap.activityTypeId,
    })
    .from(crmHistoricalTypeMap)
  for (const m of mapRows) {
    if (!m.activityTypeId) continue
    adminTypeMap.set(`${m.teamId}::${m.crmTypeValue.trim().toLowerCase()}`, m.activityTypeId)
  }

  return { userBySfId, userByEmail, emailBySfUserId, typeByTeamAndValue, adminTypeMap, allDayCapHours }
}

export interface ResolvedLinkage {
  userId: string | null
  teamId: string | null
  activityTypeId: string | null
  userMatchMethod: UserMatchMethod
  typeMatchMethod: TypeMatchMethod
}

/**
 * Resolves one Event's owner and Type against the preloaded maps.
 *
 * An unmatched owner is NOT an error — over a 3-year window departed
 * employees are a large share of the history, and storing their events is the
 * whole point of the import. The caller keeps `ownerCrmUserId` /
 * `ownerCrmUserName` verbatim so the UI can still name them.
 */
export function resolveEventLinkage(
  maps: LinkageMaps,
  ownerCrmUserId: string | null | undefined,
  crmType: string | null | undefined,
): ResolvedLinkage {
  let userId: string | null = null
  let teamId: string | null = null
  let userMatchMethod: UserMatchMethod = null

  if (ownerCrmUserId) {
    for (const k of sfIdKeys(ownerCrmUserId)) {
      const hit = maps.userBySfId.get(k)
      if (hit) {
        userId = hit.userId
        teamId = hit.teamId
        userMatchMethod = 'sf_user_id'
        break
      }
    }
    if (!userId) {
      // Fall back to matching on email via the crm_users directory cache,
      // covering users whose crm_user_id was never backfilled.
      for (const k of sfIdKeys(ownerCrmUserId)) {
        const email = maps.emailBySfUserId.get(k)
        const hit = email ? maps.userByEmail.get(email) : undefined
        if (hit) {
          userId = hit.userId
          teamId = hit.teamId
          userMatchMethod = 'email'
          break
        }
      }
    }
  }

  // Type resolution is team-scoped, so an unmatched user means no type either.
  let activityTypeId: string | null = null
  let typeMatchMethod: TypeMatchMethod = null
  const value = (crmType ?? '').trim().toLowerCase()
  if (teamId && value) {
    const key = `${teamId}::${value}`
    const auto = maps.typeByTeamAndValue.get(key)
    const admin = maps.adminTypeMap.get(key)
    if (auto !== undefined && auto !== AMBIGUOUS) {
      activityTypeId = auto
      // Distinguishing picklist_override from name_exact after the fact would
      // need a second map; the practical value is low, so report the common
      // case and let the admin map be the one that stands out in an audit.
      typeMatchMethod = 'name_exact'
    } else if (admin) {
      // Admin mapping also breaks AMBIGUOUS ties — that's its main job.
      activityTypeId = admin
      typeMatchMethod = 'admin_map'
    }
  }

  return { userId, teamId, activityTypeId, userMatchMethod, typeMatchMethod }
}

/**
 * Converts a Salesforce Event duration into estimated hours.
 *
 * This is an ESTIMATE from the meeting length scheduled in Salesforce, never
 * logged effort — see the schema comment on crm_historical_events. All-day
 * events report 1440 minutes (or null), which would make any hours total
 * absurd, so they're capped at an admin-configured value (v1.215.0).
 *
 * Pure by design: callers pass the cap from LinkageMaps rather than this
 * reading config, so ingest and the relink recompute can't disagree.
 */
export function estimateHours(
  durationMinutes: number | null | undefined,
  isAllDayEvent: boolean,
  capHours: number = DEFAULT_ALL_DAY_CAP_HOURS,
): string | null {
  if (durationMinutes == null || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null
  const hours = durationMinutes / 60
  const capped = isAllDayEvent ? Math.min(hours, capHours) : hours
  // decimal(6,2) — clamp so a pathological SF value can't overflow the column.
  return Math.min(capped, 9999.99).toFixed(2)
}
