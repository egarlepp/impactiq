import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { rolePermissions, teamMembers, users } from '../../../../drizzle/schema.js'
import { canViewActivity } from '../activities/access.js'

// Who sees, and runs, AI Assessment scores on an activity (v1.462.0, the owner:
// "scores are for Leaders only"). Never the activity's owner, even when the
// owner is a Leader too: nobody grades their own call. Otherwise, once the
// caller can see the activity at all:
// - an App Admin;
// - a leader, team admin or admin of the activity's team;
// - a leader, team admin or admin anywhere who can see all teams.
// Role Management's activities.ai_assessments key must also be granted
// (team "admin" members and App Admins always have it).

export const AI_ASSESSMENTS_PAGE_KEY = 'activities.ai_assessments'
const LEADER_ROLES = ['leader', 'team_admin', 'admin'] as const

export interface AssessmentAccessContext {
  isOwner: boolean
  canView: boolean
  isAppAdmin: boolean
  leadsTeam: boolean
  leadsAllTeams: boolean
  hasGrant: boolean
}

export function decideAssessmentAccess(c: AssessmentAccessContext): boolean {
  if (c.isOwner || !c.canView) return false
  if (c.isAppAdmin) return true
  return c.hasGrant && (c.leadsTeam || c.leadsAllTeams)
}

interface CallerGrant { isAppAdmin: boolean; allTeams: boolean; leaderTeamIds: string[]; hasGrant: boolean }

async function callerGrant(callerId: string): Promise<CallerGrant> {
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin, allTeams: users.canSeeAllTeams }).from(users).where(eq(users.id, callerId)).limit(1)
  if (caller?.isAppAdmin) return { isAppAdmin: true, allTeams: true, leaderTeamIds: [], hasGrant: true }
  const memberships = await db.select({ teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, callerId), inArray(teamMembers.role, [...LEADER_ROLES])))
  const roles = [...new Set(memberships.map((m) => m.role))]
  let hasGrant = roles.includes('admin')
  if (!hasGrant && roles.length > 0) {
    const [grant] = await db.select({ role: rolePermissions.role }).from(rolePermissions)
      .where(and(inArray(rolePermissions.role, roles), eq(rolePermissions.pageKey, AI_ASSESSMENTS_PAGE_KEY), eq(rolePermissions.hasAccess, true)))
      .limit(1)
    hasGrant = !!grant
  }
  return { isAppAdmin: false, allTeams: !!caller?.allTeams, leaderTeamIds: memberships.map((m) => m.teamId), hasGrant }
}

export async function canSeeAssessmentScores(
  callerId: string,
  activity: { userId: string; teamId: string; status: string },
): Promise<boolean> {
  if (activity.userId === callerId) return false
  if (!(await canViewActivity(callerId, activity))) return false
  const g = await callerGrant(callerId)
  return decideAssessmentAccess({
    isOwner: false,
    canView: true,
    isAppAdmin: g.isAppAdmin,
    leadsTeam: g.leaderTeamIds.includes(activity.teamId),
    leadsAllTeams: g.allTeams && g.leaderTeamIds.length > 0,
    hasGrant: g.hasGrant,
  })
}

/**
 * The teams whose scores this caller may see on the AI Assessment Scores
 * dashboard, out of `teamIds` (already narrowed to what the caller can open).
 * Same rule as the drawer tab: App Admins; else the activities.ai_assessments
 * grant plus a leader role on that team, or on any team with can-see-all-teams.
 * The caller's own activities are left out by the route.
 */
export async function assessmentScoreTeamIds(callerId: string, teamIds: readonly string[]): Promise<string[]> {
  const g = await callerGrant(callerId)
  if (g.isAppAdmin) return [...teamIds]
  if (!g.hasGrant || g.leaderTeamIds.length === 0) return []
  if (g.allTeams) return [...teamIds]
  return teamIds.filter((id) => g.leaderTeamIds.includes(id))
}
