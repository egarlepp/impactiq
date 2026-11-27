import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { decryptToken, encryptToken } from '../config/crypto.js'
import { stripTrailing } from '../../lib/strings.js'

// Connection to the install's CriteriaIQ: its base URL and a CriteriaIQ API
// key (Bearer, created in CriteriaIQ under Admin › Integrations › n8n › API Keys with the
// projects:read scope). The key is stored AES-256-GCM encrypted, same cipher
// as the Salesforce/Outlook refresh tokens and the Slack bot token, and never
// leaves the server.
const KEY = 'criteriaiq_config'

// Live refresh (v1.450.0): CriteriaIQ signs a webhook with
// webhookSecretEncrypted when a project changes (routes/criteriaiqWebhook.ts).
// Each accepted one moves cacheEpoch, which is part of every cache key in
// client.ts, so every replica drops its cached CriteriaIQ reads on its next
// call without any extra query.
interface StoredConfig {
  baseUrl: string
  apiKeyEncrypted: string
  allowPrivateNetwork: boolean
  webhookSecretEncrypted?: string | null
  cacheEpoch?: number
  lastWebhookAt?: string | null
}

export interface CriteriaIqConfig {
  baseUrl: string
  apiKey: string
  allowPrivateNetwork: boolean
  cacheEpoch: number
}

export interface CriteriaIqConfigSummary {
  configured: boolean
  baseUrl: string | null
  allowPrivateNetwork: boolean
  // Last 4 characters only, so an admin can tell which key is on file.
  apiKeyHint: string | null
  liveRefresh: { enabled: boolean; secretHint: string | null; lastWebhookAt: string | null }
}

// Trailing slashes off, so paths join cleanly.
export function normalizeBaseUrl(raw: string): string {
  return stripTrailing(raw.trim(), '/')
}

async function loadStored(): Promise<StoredConfig | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1)
  const v = row?.value as Partial<StoredConfig> | undefined
  if (!v?.baseUrl || !v.apiKeyEncrypted) return null
  return {
    baseUrl: v.baseUrl,
    apiKeyEncrypted: v.apiKeyEncrypted,
    allowPrivateNetwork: v.allowPrivateNetwork === true,
    webhookSecretEncrypted: typeof v.webhookSecretEncrypted === 'string' ? v.webhookSecretEncrypted : null,
    cacheEpoch: typeof v.cacheEpoch === 'number' ? v.cacheEpoch : 0,
    lastWebhookAt: typeof v.lastWebhookAt === 'string' ? v.lastWebhookAt : null,
  }
}

function decryptOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  try { return decryptToken(value) } catch { return null }
}

// Null when not configured, or when the stored key can't be decrypted (a
// restore onto an install with a different TOKEN_ENCRYPTION_KEY): the admin
// re-enters the key in that case.
export async function getCriteriaIqConfig(): Promise<CriteriaIqConfig | null> {
  const stored = await loadStored()
  if (!stored) return null
  try {
    return { baseUrl: stored.baseUrl, apiKey: decryptToken(stored.apiKeyEncrypted), allowPrivateNetwork: stored.allowPrivateNetwork, cacheEpoch: stored.cacheEpoch ?? 0 }
  } catch {
    return null
  }
}

export async function isCriteriaIqConfigured(): Promise<boolean> {
  return (await getCriteriaIqConfig()) !== null
}

export async function getCriteriaIqConfigSummary(): Promise<CriteriaIqConfigSummary> {
  const stored = await loadStored()
  const cfg = await getCriteriaIqConfig()
  const secret = decryptOrNull(stored?.webhookSecretEncrypted)
  const liveRefresh = { enabled: !!cfg && !!secret, secretHint: secret ? secret.slice(-4) : null, lastWebhookAt: stored?.lastWebhookAt ?? null }
  if (!cfg) {
    return { configured: false, baseUrl: stored?.baseUrl ?? null, allowPrivateNetwork: stored?.allowPrivateNetwork ?? false, apiKeyHint: null, liveRefresh }
  }
  return { configured: true, baseUrl: cfg.baseUrl, allowPrivateNetwork: cfg.allowPrivateNetwork, apiKeyHint: cfg.apiKey.slice(-4), liveRefresh }
}

// apiKey null keeps the key already on file (changing only the URL or the
// private-network flag shouldn't make the admin paste the key again).
export async function setCriteriaIqConfig(input: { baseUrl: string; apiKey: string | null; allowPrivateNetwork: boolean }): Promise<void> {
  const existing = await loadStored()
  const apiKeyEncrypted = input.apiKey ? encryptToken(input.apiKey) : existing?.apiKeyEncrypted
  if (!apiKeyEncrypted) throw new Error('errors.criteriaiq.api_key_required')
  // Keeps the live refresh secret and cache epoch already on file.
  const value: StoredConfig = { ...existing, baseUrl: normalizeBaseUrl(input.baseUrl), apiKeyEncrypted, allowPrivateNetwork: input.allowPrivateNetwork }
  await writeStored(value)
}

async function writeStored(value: StoredConfig): Promise<void> {
  await db.insert(systemSettings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } })
}

// The secret CriteriaIQ signs live refresh webhooks with. Null when live
// refresh is off, or when the stored secret can't be decrypted.
export async function getCriteriaIqWebhookSecret(): Promise<string | null> {
  return decryptOrNull((await loadStored())?.webhookSecretEncrypted)
}

// Pass null to turn live refresh off. Needs a saved connection, since a
// webhook only says which project changed and the project is read back
// through it.
export async function setCriteriaIqWebhookSecret(secret: string | null): Promise<void> {
  const existing = await loadStored()
  if (!existing) throw new Error('errors.criteriaiq.not_configured')
  await writeStored({ ...existing, webhookSecretEncrypted: secret ? encryptToken(secret) : null })
}

// Moves the cache epoch (milliseconds, never backwards) and stamps the last
// accepted webhook, in one statement so concurrent webhooks can't lose either.
export async function bumpCriteriaIqCacheEpoch(at: Date = new Date()): Promise<void> {
  const ms = at.getTime()
  await db.update(systemSettings).set({
    value: sql`${systemSettings.value} || jsonb_build_object(
      'cacheEpoch', greatest(coalesce((${systemSettings.value}->>'cacheEpoch')::bigint, 0) + 1, ${ms}::bigint),
      'lastWebhookAt', ${at.toISOString()}::text)`,
    updatedAt: at,
  }).where(eq(systemSettings.key, KEY))
}

export async function clearCriteriaIqConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY))
}
