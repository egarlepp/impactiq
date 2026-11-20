import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activityTypeTeams, teamActivityTypes, teamMembers, users } from '../../../../drizzle/schema.js'
import { getAccessibleTeamIds } from '../../middleware/rbac.js'

// Who may read or act on a single activity, by id (security audit H2/M2,
// v1.422.0). Before this, GET /api/activities/:id and two Salesforce
// activity routes looked the row up by id alone.
//
// Allowed:
// - the owner;
// - an App Admin;
// - an admin/team_admin of a team the owner belongs to, the same people the
//   person switcher lets see that owner's whole week, drafts included;
// - anyone who can see the activity's team, but only once it's submitted
//   (CLAUDE.md §5: nobody else sees another person's drafts).
type ActivityAccessRow = { userId: string; teamId: string; status: string }

export async function canViewActivity(callerId: string, act: ActivityAccessRow): Promise<boolean> {
  if (act.userId === callerId) return true
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  if (caller?.isAppAdmin) return true
  if (await isTeamAdminOver(callerId, act.userId)) return true
  if (act.status !== 'submitted') return false
  return (await getAccessibleTeamIds(callerId)).includes(act.teamId)
}

// Loads an activity's access fields and checks them in one go. Returns false
// for a missing activity too, so callers answer 404 without telling the two
// cases apart.
export async function canViewActivityById(callerId: string, activityId: string): Promise<boolean> {
  const [act] = await db
    .select({ userId: activities.userId, teamId: activities.teamId, status: activities.status })
    .from(activities)
    .where(eq(activities.id, activityId))
    .limit(1)
  return !!act && canViewActivity(callerId, act)
}

async function isTeamAdminOver(callerId: string, ownerId: string): Promise<boolean> {
  const adminTeams = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, callerId), inArray(teamMembers.role, ['admin', 'team_admin'])))
  if (adminTeams.length === 0) return false
  const [match] = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, ownerId), inArray(teamMembers.teamId, adminTeams.map((t) => t.teamId))))
    .limit(1)
  return !!match
}

// An activity type belongs to a team when it's the type's home team or it's
// assigned there through activity_type_teams (the Activity Types list reads
// the junction). Used so an activity can't be filed under another team's
// type (audit M1) and a type's extras can't be read from outside it (L1).
export async function activityTypeVisibleToTeams(typeId: string, teamIds: string[]): Promise<boolean> {
  if (teamIds.length === 0) return false
  const [row] = await db
    .select({ id: teamActivityTypes.id })
    .from(teamActivityTypes)
    .leftJoin(activityTypeTeams, and(eq(activityTypeTeams.activityTypeId, teamActivityTypes.id), inArray(activityTypeTeams.teamId, teamIds)))
    .where(and(eq(teamActivityTypes.id, typeId), or(inArray(teamActivityTypes.teamId, teamIds), inArray(activityTypeTeams.teamId, teamIds))))
    .limit(1)
  return !!row
}
