import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { gongCalls, rolePermissions, teamMembers, users } from '../../../../drizzle/schema.js'
import { canViewActivity } from '../activities/access.js'
import { canReadTranscript, type TranscriptActivity } from '../gong/access.js'

// Who sees an AI Note (Gong plan, decided question C): the same people who
// may read the transcript it came from (owner, people on the call, App
// Admins, and the team's leaders only when "Leaders can read transcripts" is
// on). An AI Note written from a private note is the owner's and App
// Admins' only. Only the owner generates, keeps, removes or copies items.

export const AI_NOTES_PAGE_KEY = 'activities.ai_notes'

// Role Management grant for the AI Notes tab (App Admins and team "admin"
// members always have it), same rule as the Transcripts tab's key.
export async function hasAiNotesPage(userId: string): Promise<boolean> {
  const [u] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, userId)).limit(1)
  if (u?.isAppAdmin) return true
  const roles = [...new Set((await db.select({ role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.userId, userId))).map((r) => r.role))]
  if (roles.includes('admin')) return true
  if (roles.length === 0) return false
  const [grant] = await db
    .select({ role: rolePermissions.role })
    .from(rolePermissions)
    .where(and(inArray(rolePermissions.role, roles), eq(rolePermissions.pageKey, AI_NOTES_PAGE_KEY), eq(rolePermissions.hasAccess, true)))
    .limit(1)
  return !!grant
}

export interface AiNoteReadContext {
  isAppAdmin: boolean
  isOwner: boolean
  usedPrivateNotes: boolean
  // canReadTranscript() for any of the linked calls, or the leader switch.
  transcriptRuleAllows: boolean
}

export function decideAiNoteRead(c: AiNoteReadContext): boolean {
  if (c.isAppAdmin || c.isOwner) return true
  if (c.usedPrivateNotes) return false
  return c.transcriptRuleAllows
}

export async function canReadAiNote(
  callerId: string,
  activity: TranscriptActivity,
  opts: { usedPrivateNotes: boolean; gongCallIds: string[] },
): Promise<boolean> {
  if (!(await canViewActivity(callerId, activity))) return false
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  const isAppAdmin = !!caller?.isAppAdmin
  const isOwner = activity.userId === callerId
  if (isAppAdmin || isOwner || opts.usedPrivateNotes) {
    return decideAiNoteRead({ isAppAdmin, isOwner, usedPrivateNotes: opts.usedPrivateNotes, transcriptRuleAllows: false })
  }
  // The leader switch (call = null), then each call the note was written from.
  let allowed = await canReadTranscript(callerId, activity, null)
  if (!allowed && opts.gongCallIds.length > 0) {
    const calls = await db.select({ partyEmails: gongCalls.partyEmails, partyUserIds: gongCalls.partyUserIds })
      .from(gongCalls).where(inArray(gongCalls.id, opts.gongCallIds))
    for (const call of calls) {
      if (await canReadTranscript(callerId, activity, call)) { allowed = true; break }
    }
  }
  return decideAiNoteRead({ isAppAdmin, isOwner, usedPrivateNotes: false, transcriptRuleAllows: allowed })
}
