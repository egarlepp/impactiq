import { db } from '../../db/index.js'
import { subteams, subteamUsers, teamMembers } from '../../../../drizzle/schema.js'
import { inArray, eq } from 'drizzle-orm'

// v1.245.0: extracted from the ManagerRollup / ProjectCosting subteam-tree
// code (dashboards.ts), which had this exact algorithm duplicated
// character-for-character in two places. A third caller (Team Activity
// Deep-Dive) is what forced the extraction — better to have one copy three
// call sites trust than a third hand-copy that can quietly drift from the
// other two.
//
// The attribution rule, unchanged from the original: a user may belong to
// zero, one, or many subteams (subteam_users has no uniqueness constraint
// beyond the composite PK, so multiple memberships are legal). An activity is
// attributed ONCE, to the user's DEEPEST matching subteam in that team — ties
// break alphabetically by name — never split or double-counted across
// subteams. Zero matches falls into a synthetic "Unassigned" bucket.

export interface SubteamMeta {
  id: string
  teamId: string
  name: string
  parentSubteamId: string | null
}

export const UNASSIGNED_SUBTEAM_ID = '__unassigned__'

export interface SubteamAttribution {
  /** Active subteams for the loaded team scope, in no particular order. */
  activeSubteams: SubteamMeta[]
  /** Depth of a subteam (1 = top-level), walking only ACTIVE ancestors. */
  depthOf(subteamId: string): number
  /**
   * The user's deepest-matching active subteam within `teamId`, or `null` for
   * Unassigned. Pass the SAME `teamId` the subteam was loaded for — a user's
   * subteam memberships are looked up across every team in the loaded scope,
   * but a subteam only ever "counts" for the team it belongs to.
   */
  bestSubteamOf(userId: string, teamId: string): SubteamMeta | null
}

/**
 * Loads active subteams + membership for the given team scope and returns an
 * attribution helper. One DB round trip for subteams, one for memberships,
 * regardless of how many users/activities the caller later resolves.
 */
export async function loadSubteamAttribution(teamIds: string[]): Promise<SubteamAttribution> {
  const subteamRows = teamIds.length > 0
    ? await db
        .select({ id: subteams.id, teamId: subteams.teamId, name: subteams.name, isActive: subteams.isActive, parentSubteamId: subteams.parentSubteamId })
        .from(subteams)
        .where(inArray(subteams.teamId, teamIds))
    : []
  const activeSubteams: SubteamMeta[] = subteamRows.filter((s) => s.isActive).map((s) => ({ id: s.id, teamId: s.teamId, name: s.name, parentSubteamId: s.parentSubteamId }))
  const subById = new Map(activeSubteams.map((s) => [s.id, s]))

  function depthOf(subteamId: string): number {
    let d = 1
    const guard = new Set<string>([subteamId])
    let cur = subById.get(subteamId)?.parentSubteamId ?? null
    while (cur && subById.has(cur) && !guard.has(cur)) {
      d += 1
      guard.add(cur)
      cur = subById.get(cur)!.parentSubteamId ?? null
    }
    return d
  }

  const subteamIds = activeSubteams.map((s) => s.id)
  const membershipRows = subteamIds.length > 0
    ? await db.select({ userId: subteamUsers.userId, subteamId: subteamUsers.subteamId }).from(subteamUsers).where(inArray(subteamUsers.subteamId, subteamIds))
    : []
  const subteamsByUser = new Map<string, Set<string>>()
  for (const r of membershipRows) {
    const s = subteamsByUser.get(r.userId) ?? new Set<string>()
    s.add(r.subteamId)
    subteamsByUser.set(r.userId, s)
  }

  function bestSubteamOf(userId: string, teamId: string): SubteamMeta | null {
    const memberOf = subteamsByUser.get(userId)
    if (!memberOf) return null
    const hits = activeSubteams.filter((s) => s.teamId === teamId && memberOf.has(s.id))
    if (hits.length === 0) return null
    return hits
      .map((s) => ({ s, d: depthOf(s.id) }))
      .sort((a, b) => b.d - a.d || a.s.name.localeCompare(b.s.name))[0]!.s
  }

  return { activeSubteams, depthOf, bestSubteamOf }
}

/**
 * The team's current member roster (active `team_members` rows), for
 * dashboards that need to enumerate "every user who could appear as a row"
 * rather than only users who happen to have matching activity in the
 * selected window.
 */
export async function loadTeamRoster(teamId: string): Promise<Array<{ userId: string }>> {
  return db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, teamId))
}
