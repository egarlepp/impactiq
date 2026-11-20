import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { teamMembers, teams, users } from '../../../../drizzle/schema.js'
import { canViewActivity } from '../activities/access.js'
import { getGongIdentities, isOnCall } from './identity.js'

// Who may read a Gong transcript linked to an activity (Gong plan, decided
// question 1). Gong's own per-call permissions don't apply to an org-wide
// key, so this is the gate. Every transcript route goes through it.
//
// Allowed, once the caller can see the activity at all:
// - an App Admin;
// - the activity's owner;
// - anyone who was on the call (by email or Gong user);
// - a leader, team admin or admin of the activity's team, only when an App
//   Admin turned on "Leaders can read transcripts" for that team.

export interface TranscriptActivity { id: string; userId: string; teamId: string; status: string }
export interface TranscriptCall { partyEmails: string[]; partyUserIds: string[] }

export interface TranscriptAccessContext {
  isAppAdmin: boolean
  isOwner: boolean
  onCall: boolean
  leaderSwitchOn: boolean
  isTeamLeader: boolean
}

export function decideTranscriptAccess(c: TranscriptAccessContext): boolean {
  if (c.isAppAdmin || c.isOwner || c.onCall) return true
  return c.leaderSwitchOn && c.isTeamLeader
}

export async function canReadTranscript(callerId: string, activity: TranscriptActivity, call: TranscriptCall | null): Promise<boolean> {
  if (!(await canViewActivity(callerId, activity))) return false
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  const isOwner = activity.userId === callerId
  if (caller?.isAppAdmin || isOwner) return true
  const identity = (await getGongIdentities([callerId])).get(callerId)
  const onCall = !!(call && identity && isOnCall(identity, call))
  if (onCall) return true
  const [team] = await db.select({ on: teams.transcriptsLeaderAccess }).from(teams).where(eq(teams.id, activity.teamId)).limit(1)
  if (!team?.on) return false
  const [membership] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, callerId), eq(teamMembers.teamId, activity.teamId), inArray(teamMembers.role, ['leader', 'team_admin', 'admin'])))
    .limit(1)
  return decideTranscriptAccess({ isAppAdmin: false, isOwner: false, onCall: false, leaderSwitchOn: true, isTeamLeader: !!membership })
}

// Linking and unlinking: the activity's owner or an App Admin.
export async function canLinkGongCalls(callerId: string, activity: { userId: string }): Promise<boolean> {
  if (activity.userId === callerId) return true
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  return !!caller?.isAppAdmin
}
