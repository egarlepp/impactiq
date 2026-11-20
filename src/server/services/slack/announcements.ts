import { db } from '../../db/index.js'
import { announcements, teams, teamMembers, subteamUsers } from '../../../../drizzle/schema.js'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { getSlackConfigSummary } from './client.js'
import { deliverSlackDmToUser } from './dm.js'
import { postToTeamSlackChannel } from '../nudge/slack.js'

// v1.433.0: Announcements with "Also send to Slack" on go out once, the
// first notification_sweep after they become active (start date reached,
// not past the end date, Active). Where they go:
// - team-wide: the team's Slack channel (Team Management → Slack Incoming
//   Webhook) when one is set, otherwise a DM to every team member;
// - a subteam: a DM to each of its members;
// - one person: a DM to that person.
// A DM follows deliverSlackDmToUser()'s rules (linked Slack id, not opted
// out, not disabled). "Today" is the UTC date: the in-app banner uses each
// viewer's own local day, but a send-once Slack message has no single viewer.

export interface AnnouncementSlackResult {
  announcements: number
  dms: number
  channelPosts: number
}

export async function sendDueAnnouncementsToSlack(now: Date = new Date()): Promise<AnnouncementSlackResult> {
  const result: AnnouncementSlackResult = { announcements: 0, dms: 0, channelPosts: 0 }
  const today = now.toISOString().slice(0, 10)
  const due = await db
    .select({
      id: announcements.id,
      teamId: announcements.teamId,
      targetType: announcements.targetType,
      subteamId: announcements.subteamId,
      targetUserId: announcements.targetUserId,
      message: announcements.message,
      severity: announcements.severity,
      teamName: teams.name,
      teamWebhook: teams.slackWebhookUrl,
    })
    .from(announcements)
    .innerJoin(teams, eq(teams.id, announcements.teamId))
    .where(and(
      eq(announcements.sendSlack, true),
      isNull(announcements.slackSentAt),
      eq(announcements.isActive, true),
      sql`${announcements.startDate} <= ${today}::date`,
      or(isNull(announcements.endDate), sql`${announcements.endDate} >= ${today}::date`),
    ))
  if (due.length === 0) return result

  const { configured: botConfigured } = await getSlackConfigSummary()
  for (const a of due) {
    const useChannel = a.targetType === 'team' && !!a.teamWebhook
    // Nothing could deliver it yet: leave it unclaimed so it still goes out
    // once an admin connects Slack, instead of being marked sent unseen.
    if (!useChannel && !botConfigured) continue
    // The claim makes it send-once even if two sweeps overlap.
    const [claimed] = await db
      .update(announcements)
      .set({ slackSentAt: now })
      .where(and(eq(announcements.id, a.id), isNull(announcements.slackSentAt)))
      .returning({ id: announcements.id })
    if (!claimed) continue
    result.announcements += 1
    const heading = `ImpactIQ announcement — ${a.teamName}`

    if (useChannel) {
      const posted = await postToTeamSlackChannel(a.teamId, { title: heading, text: a.message, severity: a.severity })
      if (posted.ok) result.channelPosts += 1
      continue
    }
    for (const userId of await announcementRecipients(a)) {
      const dm = await deliverSlackDmToUser(userId, { heading, text: a.message, severity: a.severity })
      if (dm.ok) result.dms += 1
    }
  }
  return result
}

// Exported for tests. Same targeting as getActiveAnnouncementsForUser(), read
// from the other side: who does this announcement reach.
export async function announcementRecipients(a: {
  teamId: string
  targetType: 'team' | 'subteam' | 'user'
  subteamId: string | null
  targetUserId: string | null
}): Promise<string[]> {
  if (a.targetType === 'user') return a.targetUserId ? [a.targetUserId] : []
  if (a.targetType === 'subteam') {
    if (!a.subteamId) return []
    const rows = await db.select({ userId: subteamUsers.userId }).from(subteamUsers).where(eq(subteamUsers.subteamId, a.subteamId))
    return [...new Set(rows.map((r) => r.userId))]
  }
  const rows = await db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, a.teamId))
  return [...new Set(rows.map((r) => r.userId))]
}
