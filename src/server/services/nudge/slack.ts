import { db } from '../../db/index.js'
import { teams, users } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { safeFetch } from '../net/safeFetch.js'

// Best-effort Slack Incoming Webhook delivery. Called from the notifications
// sync path AFTER the in-app row is written. Failures are logged and
// swallowed — Slack outage must not block in-app delivery.
export async function deliverSlackNudge(opts: {
  teamId: string
  userId: string
  message: string
  severity: string
  icon: string | null
}): Promise<{ ok: boolean; url: string | null }> {
  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, opts.teamId)).limit(1)
  if (!team) return { ok: false, url: null }
  const [user] = await db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, opts.userId)).limit(1)
  return postToTeamSlackChannel(opts.teamId, {
    title: `ImpactIQ nudge — ${team.name}`,
    text: opts.message,
    severity: opts.severity,
    footer: user ? `For ${user.name} <${user.email}>` : undefined,
  })
}

// v1.433.0: the team-channel post on its own, shared by nudges and team-wide
// announcements (services/slack/announcements.ts).
export async function postToTeamSlackChannel(teamId: string, card: {
  title: string
  text: string
  severity: string
  footer?: string | undefined
}): Promise<{ ok: boolean; url: string | null }> {
  const [team] = await db.select({ webhook: teams.slackWebhookUrl }).from(teams).where(eq(teams.id, teamId)).limit(1)
  if (!team?.webhook) return { ok: false, url: null }
  // Severity → Slack attachment color. Slack's short color hints render as a
  // vertical stripe next to the card, so this is the cheapest way to mirror
  // the in-app severity chrome.
  const body = {
    attachments: [
      {
        color: slackSeverityColor(card.severity),
        title: card.title,
        text: card.text,
        footer: card.footer,
      },
    ],
  }
  try {
    // Security fix (same class as F-01/F-02, pentest 2026-09): this
    // per-team, admin-editable webhook URL had no validation before being
    // fetched — same unguarded-outbound-request shape as loginUrl/endpoint,
    // just not individually tested by the report. Generic public-HTTPS-only
    // guard (no host allowlist — Slack Enterprise setups can front webhooks
    // behind a custom domain).
    // v1.477.0: safeFetch also re-checks the address at connect time and
    // doesn't follow redirects.
    const res = await safeFetch(team.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn('[nudge-slack] webhook returned', res.status, await res.text().catch(() => ''))
      return { ok: false, url: team.webhook }
    }
    return { ok: true, url: team.webhook }
  } catch (err) {
    console.warn('[nudge-slack] fetch failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, url: team.webhook }
  }
}

export function slackSeverityColor(severity: string): string {
  return severity === 'critical' ? '#dc2626' : severity === 'warning' ? '#d97706' : '#2563eb'
}
