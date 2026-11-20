// Which subteams a user can be a member of (v1.470.0).
//
// A subteam belongs to one team, so a user can only be a subteam member on a
// team they are part of: a team_members row, or their default team. User
// Management's Subteams picker used to list every subteam of every team, which
// let an admin put someone on another team's subteam.
//
// Only role='member' rows are governed here. Subteam leader rows are set from
// Team Management and may name someone who leads from outside the team.
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { subteams, subteamUsers, teamMembers, teams, users } from '../../../../drizzle/schema.js'

export interface UserSubteamOption {
  id: string
  name: string
  kind: string | null
  teamId: string
  teamName: string
}

export interface UserSubteamMembership extends UserSubteamOption {
  /** The user is not on this subteam's team any more (stale assignment). */
  outsideTeams: boolean
}

/** Teams the user is part of: every team_members row plus the default team. */
export async function userTeamIds(userId: string): Promise<string[]> {
  const [memberRows, [user]] = await Promise.all([
    db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)),
    db.select({ defaultTeamId: users.defaultTeamId }).from(users).where(eq(users.id, userId)).limit(1),
  ])
  const ids = new Set(memberRows.map((r) => r.teamId))
  if (user?.defaultTeamId) ids.add(user.defaultTeamId)
  return [...ids]
}

/** Active subteams on the user's own teams: what the picker may offer. */
export async function subteamOptionsForUser(userId: string): Promise<UserSubteamOption[]> {
  const teamIds = await userTeamIds(userId)
  if (teamIds.length === 0) return []
  return db
    .select({ id: subteams.id, name: subteams.name, kind: subteams.kind, teamId: subteams.teamId, teamName: teams.name })
    .from(subteams)
    .innerJoin(teams, eq(teams.id, subteams.teamId))
    .where(and(inArray(subteams.teamId, teamIds), eq(subteams.isActive, true)))
    .orderBy(asc(teams.name), asc(subteams.name))
}

/** The user's subteam memberships, each flagged when it sits outside their teams. */
export async function subteamMembershipsForUser(userId: string): Promise<UserSubteamMembership[]> {
  const [teamIds, rows] = await Promise.all([
    userTeamIds(userId),
    db
      .select({ id: subteams.id, name: subteams.name, kind: subteams.kind, teamId: subteams.teamId, teamName: teams.name })
      .from(subteamUsers)
      .innerJoin(subteams, eq(subteams.id, subteamUsers.subteamId))
      .innerJoin(teams, eq(teams.id, subteams.teamId))
      .where(and(eq(subteamUsers.userId, userId), eq(subteamUsers.role, 'member')))
      .orderBy(asc(teams.name), asc(subteams.name)),
  ])
  const own = new Set(teamIds)
  return rows.map((r) => ({ ...r, outsideTeams: !own.has(r.teamId) }))
}

/**
 * Ids in `requested` that may not be saved: on a team the user isn't part of
 * and not already assigned. Keeping an existing stale assignment is allowed so
 * an admin can change other subteams without being forced to drop it first.
 */
export async function disallowedSubteamIds(userId: string, requested: string[]): Promise<string[]> {
  if (requested.length === 0) return []
  const [teamIds, current, found] = await Promise.all([
    userTeamIds(userId),
    db.select({ subteamId: subteamUsers.subteamId }).from(subteamUsers)
      .where(and(eq(subteamUsers.userId, userId), eq(subteamUsers.role, 'member'))),
    db.select({ id: subteams.id, teamId: subteams.teamId }).from(subteams).where(inArray(subteams.id, requested)),
  ])
  const own = new Set(teamIds)
  const already = new Set(current.map((r) => r.subteamId))
  const teamOf = new Map(found.map((r) => [r.id, r.teamId]))
  return requested.filter((id) => {
    if (already.has(id)) return false
    const teamId = teamOf.get(id)
    return teamId === undefined || !own.has(teamId)
  })
}

/**
 * After the user leaves `leftTeamIds`, drop their subteam memberships on those
 * teams, unless they are still part of the team another way (default team or a
 * remaining membership). Only the teams just left are touched, so an older
 * stale assignment elsewhere stays visible in User Management for an admin to
 * decide on. Returns how many rows went.
 */
export async function pruneSubteamMembershipsForLeftTeams(userId: string, leftTeamIds: string[]): Promise<number> {
  if (leftTeamIds.length === 0) return 0
  const still = new Set(await userTeamIds(userId))
  const gone = leftTeamIds.filter((id) => !still.has(id))
  if (gone.length === 0) return 0
  const removed = await db
    .delete(subteamUsers)
    .where(and(
      eq(subteamUsers.userId, userId),
      eq(subteamUsers.role, 'member'),
      inArray(subteamUsers.subteamId, db.select({ id: subteams.id }).from(subteams).where(inArray(subteams.teamId, gone))),
    ))
    .returning({ subteamId: subteamUsers.subteamId })
  return removed.length
}
