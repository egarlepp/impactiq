import { db } from '../../db/index.js'
import { systemSettings, users } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { encryptToken, decryptToken } from '../config/crypto.js'
import { recordIntegrationCall } from '../health/integrationStatus.js'

const CONFIG_KEY = 'slack_config'

export interface SlackConfig {
  botTokenEncrypted: string
  workspaceUrl: string | null
}

// Set/replace the workspace's bot token. Stored encrypted at rest (AES-256-GCM
// via services/config/crypto.ts). The signing secret isn't stored here because
// this v1 doesn't accept inbound Slack events — outbound DM only.
export async function setSlackConfig(botToken: string, workspaceUrl: string | null): Promise<void> {
  const value: SlackConfig = { botTokenEncrypted: encryptToken(botToken), workspaceUrl }
  const [existing] = await db.select({ key: systemSettings.key }).from(systemSettings).where(eq(systemSettings.key, CONFIG_KEY)).limit(1)
  if (existing) {
    await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, CONFIG_KEY))
  } else {
    await db.insert(systemSettings).values({ key: CONFIG_KEY, value })
  }
}

export async function clearSlackConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, CONFIG_KEY))
}

export async function getSlackConfigSummary(): Promise<{ configured: boolean; workspaceUrl: string | null }> {
  const cfg = await loadSlackConfig()
  return { configured: !!cfg, workspaceUrl: cfg?.workspaceUrl ?? null }
}

async function loadSlackConfig(): Promise<SlackConfig | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, CONFIG_KEY)).limit(1)
  const val = row?.value as SlackConfig | undefined
  if (!val?.botTokenEncrypted) return null
  return val
}

async function botToken(): Promise<string | null> {
  const cfg = await loadSlackConfig()
  if (!cfg) return null
  return decryptToken(cfg.botTokenEncrypted)
}

const SLACK_BROKEN_ERRORS = new Set([
  'invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'missing_scope', 'team_access_not_granted',
])

interface SlackApiResponse { ok: boolean; error?: string; [key: string]: unknown }

async function slackApi<T extends SlackApiResponse = SlackApiResponse>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = await botToken()
  if (!token) throw new Error('Slack is not configured')
  let json: T
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    json = await res.json() as T
  } catch (err) {
    recordIntegrationCall('slack', false, err)
    throw err
  }
  if (!json.ok) {
    const err = new Error(`slack.${method} failed: ${json.error ?? 'unknown_error'}`)
    // Only a problem with the bot itself is a broken integration; an answer
    // like users_not_found or channel_not_found means Slack is working.
    if (SLACK_BROKEN_ERRORS.has(json.error ?? '')) recordIntegrationCall('slack', false, err)
    else recordIntegrationCall('slack', true)
    throw err
  }
  recordIntegrationCall('slack', true)
  return json
}

// Look up a Slack user id by email. Returns null when the workspace doesn't
// have a matching account. Fails loud on network / auth errors.
export async function lookupSlackUserByEmail(email: string): Promise<string | null> {
  try {
    const json = await slackApi<{ ok: true; user: { id: string } } | { ok: false; error: string }>(
      'users.lookupByEmail',
      { email },
    )
    if ('user' in json) return json.user.id
    return null
  } catch (err) {
    if (err instanceof Error && /users_not_found/.test(err.message)) return null
    throw err
  }
}

// DM a user via the bot. `text` is the plain-text body; opts.blocks lets
// callers pass Block Kit blocks for a richer layout when we want it later.
// opts.attachments carries the severity color stripe (v1.433.0).
export async function sendSlackDm(slackUserId: string, text: string, opts: { blocks?: unknown[]; attachments?: unknown[] } = {}): Promise<void> {
  await slackApi('chat.postMessage', {
    channel: slackUserId,
    text,
    ...(opts.blocks ? { blocks: opts.blocks } : {}),
    ...(opts.attachments ? { attachments: opts.attachments } : {}),
  })
}

// Sweep every ImpactIQ user and populate slack_user_id via lookupByEmail. Skips
// users who already have one set. Returns per-email outcome for the admin UI.
export async function syncSlackUsers(): Promise<Array<{ email: string; slackUserId: string | null; status: 'linked' | 'unlinked' | 'skipped' | 'error'; error?: string }>> {
  const rows = await db.select({ id: users.id, email: users.email, slackUserId: users.slackUserId }).from(users)
  const out: Array<{ email: string; slackUserId: string | null; status: 'linked' | 'unlinked' | 'skipped' | 'error'; error?: string }> = []
  for (const u of rows) {
    if (u.slackUserId) { out.push({ email: u.email, slackUserId: u.slackUserId, status: 'skipped' }); continue }
    try {
      const slackId = await lookupSlackUserByEmail(u.email)
      if (slackId) {
        await db.update(users).set({ slackUserId: slackId, updatedAt: new Date() }).where(eq(users.id, u.id))
        out.push({ email: u.email, slackUserId: slackId, status: 'linked' })
      } else {
        out.push({ email: u.email, slackUserId: null, status: 'unlinked' })
      }
    } catch (err) {
      out.push({ email: u.email, slackUserId: null, status: 'error', error: err instanceof Error ? err.message : 'unknown' })
    }
  }
  return out
}
