import { db } from '../../db/index.js'
import { users, userNotificationPrefs } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { getSlackConfigSummary, sendSlackDm } from './client.js'
import { slackSeverityColor } from '../nudge/slack.js'
import { getPublicBaseUrl } from '../config/integrations.js'

// v1.433.0: one Slack DM to one ImpactIQ user, through the workspace bot
// (Admin → Integrations → Slack). Used by nudge rules with "Also send as a
// Slack DM" on and by announcements with "Also send to Slack" on.
//
// A DM is skipped, never an error, when Slack isn't connected, the user has
// no linked Slack id (Integrations → Slack → Sync users), turned Slack DMs off
// in My Settings, or is disabled. Callers record a delivery only on ok.

export type SlackDmResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'not_linked' | 'opted_out' | 'disabled' | 'error'; error?: string }

// Slack mrkdwn treats &, < and > as control characters.
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function deliverSlackDmToUser(userId: string, msg: { heading: string; text: string; severity: string }): Promise<SlackDmResult> {
  const { configured } = await getSlackConfigSummary()
  if (!configured) return { ok: false, reason: 'not_configured' }
  const [user] = await db
    .select({ slackUserId: users.slackUserId, disabledAt: users.disabledAt, slackDmEnabled: userNotificationPrefs.slackDmEnabled })
    .from(users)
    .leftJoin(userNotificationPrefs, eq(userNotificationPrefs.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) return { ok: false, reason: 'not_linked' }
  if (user.disabledAt) return { ok: false, reason: 'disabled' }
  if (!user.slackUserId) return { ok: false, reason: 'not_linked' }
  // No prefs row yet means the default, which is on.
  if (user.slackDmEnabled === false) return { ok: false, reason: 'opted_out' }

  const baseUrl = await getPublicBaseUrl().catch(() => null)
  const body = escapeSlackText(msg.text)
  const link = baseUrl ? `\n<${baseUrl}|Open ImpactIQ>` : ''
  try {
    await sendSlackDm(user.slackUserId, `${msg.heading}: ${msg.text}`, {
      attachments: [{ color: slackSeverityColor(msg.severity), title: msg.heading, text: `${body}${link}`, mrkdwn_in: ['text'] }],
    })
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn('[slack-dm] send failed:', error)
    return { ok: false, reason: 'error', error }
  }
}
