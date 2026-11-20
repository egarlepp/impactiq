import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { decryptToken, encryptToken } from '../config/crypto.js'
import {
  DEFAULT_GONG_API_BASE_URL,
  GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT,
  clampTranscriptCacheDays,
  normalizeGongApiBaseUrl,
  type GongAuthMethod,
  type GongCapabilityReport,
} from '../../../shared/gong.js'

// The install's one Gong connection (Gong plan, phase 1), in system_settings.
// Every secret (access key, access key secret, OAuth client secret, OAuth
// tokens) is AES-256-GCM encrypted with the same cipher as the CRM and
// Outlook tokens and never leaves the server. The admin picks the method;
// both sets of credentials can sit on file, and only the chosen one is used.
const KEY = 'gong_config'

interface StoredOAuth {
  clientId: string | null
  clientSecretEncrypted: string | null
  accessTokenEncrypted: string | null
  refreshTokenEncrypted: string | null
  // Epoch ms the access token stops working.
  expiresAt: number | null
  connectedAt: string | null
}

interface StoredConfig {
  authMethod: GongAuthMethod
  apiBaseUrl: string
  accessKeyEncrypted: string | null
  accessKeySecretEncrypted: string | null
  oauth: StoredOAuth
  workspaceIds: string[]
  transcriptCacheDays: number
  lastCheck: GongCapabilityReport | null
  // v1.456.0 (phase 3): link calls to activities on their own, and the
  // public key that verifies Gong's signed webhooks (PEM; not a secret).
  autoLink: boolean
  webhookPublicKeyPem: string | null
}

const EMPTY_OAUTH: StoredOAuth = {
  clientId: null,
  clientSecretEncrypted: null,
  accessTokenEncrypted: null,
  refreshTokenEncrypted: null,
  expiresAt: null,
  connectedAt: null,
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function decryptOrNull(v: string | null): string | null {
  if (!v) return null
  try { return decryptToken(v) } catch { return null }
}

function parseStored(v: Record<string, unknown> | undefined): StoredConfig | null {
  if (!v) return null
  const o = (v['oauth'] && typeof v['oauth'] === 'object') ? v['oauth'] as Record<string, unknown> : {}
  return {
    authMethod: v['authMethod'] === 'oauth' ? 'oauth' : 'access_key',
    apiBaseUrl: normalizeGongApiBaseUrl(String(v['apiBaseUrl'] ?? '')) ?? DEFAULT_GONG_API_BASE_URL,
    accessKeyEncrypted: str(v['accessKeyEncrypted']),
    accessKeySecretEncrypted: str(v['accessKeySecretEncrypted']),
    oauth: {
      clientId: str(o['clientId']),
      clientSecretEncrypted: str(o['clientSecretEncrypted']),
      accessTokenEncrypted: str(o['accessTokenEncrypted']),
      refreshTokenEncrypted: str(o['refreshTokenEncrypted']),
      expiresAt: typeof o['expiresAt'] === 'number' ? o['expiresAt'] : null,
      connectedAt: str(o['connectedAt']),
    },
    workspaceIds: Array.isArray(v['workspaceIds']) ? v['workspaceIds'].filter((w): w is string => typeof w === 'string' && w !== '') : [],
    transcriptCacheDays: clampTranscriptCacheDays(v['transcriptCacheDays'] ?? GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT),
    lastCheck: (v['lastCheck'] && typeof v['lastCheck'] === 'object') ? v['lastCheck'] as GongCapabilityReport : null,
    autoLink: v['autoLink'] !== false,
    webhookPublicKeyPem: str(v['webhookPublicKeyPem']),
  }
}

async function loadStored(): Promise<StoredConfig | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1)
  return parseStored(row?.value as Record<string, unknown> | undefined)
}

async function writeStored(value: StoredConfig): Promise<void> {
  await db.insert(systemSettings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } })
}

function blank(): StoredConfig {
  return {
    authMethod: 'access_key',
    apiBaseUrl: DEFAULT_GONG_API_BASE_URL,
    accessKeyEncrypted: null,
    accessKeySecretEncrypted: null,
    oauth: { ...EMPTY_OAUTH },
    workspaceIds: [],
    transcriptCacheDays: GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT,
    lastCheck: null,
    autoLink: true,
    webhookPublicKeyPem: null,
  }
}

// What the client needs to call Gong. Exactly one credential kind is set.
export type GongCredentials =
  | { method: 'access_key'; accessKey: string; accessKeySecret: string }
  | { method: 'oauth'; accessToken: string; refreshToken: string | null; expiresAt: number | null; clientId: string; clientSecret: string }

export interface GongConfig {
  authMethod: GongAuthMethod
  apiBaseUrl: string
  credentials: GongCredentials
  workspaceIds: string[]
  transcriptCacheDays: number
  lastCheck: GongCapabilityReport | null
  autoLink: boolean
  webhookPublicKeyPem: string | null
}

// Everything on file, decrypted where it can be, whether or not it is a
// working connection. For the card and for the save flows.
export interface GongStoredView {
  authMethod: GongAuthMethod
  apiBaseUrl: string
  accessKey: string | null
  hasAccessKeySecret: boolean
  oauthClientId: string | null
  hasOAuthClientSecret: boolean
  oauthConnected: boolean
  oauthConnectedAt: string | null
  workspaceIds: string[]
  transcriptCacheDays: number
  lastCheck: GongCapabilityReport | null
  autoLink: boolean
  webhookPublicKeyOnFile: boolean
}

export async function getGongStoredView(): Promise<GongStoredView | null> {
  const s = await loadStored()
  if (!s) return null
  return {
    authMethod: s.authMethod,
    apiBaseUrl: s.apiBaseUrl,
    accessKey: decryptOrNull(s.accessKeyEncrypted),
    hasAccessKeySecret: decryptOrNull(s.accessKeySecretEncrypted) !== null,
    oauthClientId: s.oauth.clientId,
    hasOAuthClientSecret: decryptOrNull(s.oauth.clientSecretEncrypted) !== null,
    oauthConnected: decryptOrNull(s.oauth.accessTokenEncrypted) !== null,
    oauthConnectedAt: s.oauth.connectedAt,
    workspaceIds: s.workspaceIds,
    transcriptCacheDays: s.transcriptCacheDays,
    lastCheck: s.lastCheck,
    autoLink: s.autoLink,
    webhookPublicKeyOnFile: s.webhookPublicKeyPem !== null,
  }
}

// Null unless the chosen method has every credential it needs and they
// decrypt (a restore onto an install with another TOKEN_ENCRYPTION_KEY
// can't decrypt them; the admin enters them again).
export async function getGongConfig(): Promise<GongConfig | null> {
  const s = await loadStored()
  if (!s) return null
  let credentials: GongCredentials
  if (s.authMethod === 'access_key') {
    const accessKey = decryptOrNull(s.accessKeyEncrypted)
    const accessKeySecret = decryptOrNull(s.accessKeySecretEncrypted)
    if (!accessKey || !accessKeySecret) return null
    credentials = { method: 'access_key', accessKey, accessKeySecret }
  } else {
    const accessToken = decryptOrNull(s.oauth.accessTokenEncrypted)
    const clientSecret = decryptOrNull(s.oauth.clientSecretEncrypted)
    if (!accessToken || !clientSecret || !s.oauth.clientId) return null
    credentials = {
      method: 'oauth',
      accessToken,
      refreshToken: decryptOrNull(s.oauth.refreshTokenEncrypted),
      expiresAt: s.oauth.expiresAt,
      clientId: s.oauth.clientId,
      clientSecret,
    }
  }
  return {
    authMethod: s.authMethod,
    apiBaseUrl: s.apiBaseUrl,
    credentials,
    workspaceIds: s.workspaceIds,
    transcriptCacheDays: s.transcriptCacheDays,
    lastCheck: s.lastCheck,
    autoLink: s.autoLink,
    webhookPublicKeyPem: s.webhookPublicKeyPem,
  }
}

// The OAuth app's client secret, for the code exchange.
export async function getGongClientSecret(): Promise<string | null> {
  return decryptOrNull((await loadStored())?.oauth.clientSecretEncrypted ?? null)
}

export async function isGongConfigured(): Promise<boolean> {
  return (await getGongConfig()) !== null
}

// The transcript cache period, for the cull and App Health. The default when
// Gong was never set up.
export async function getGongTranscriptCacheDays(): Promise<number> {
  return (await loadStored())?.transcriptCacheDays ?? GONG_TRANSCRIPT_CACHE_DAYS_DEFAULT
}

export interface GongSettingsPatch {
  authMethod?: GongAuthMethod | undefined
  apiBaseUrl?: string | undefined
  // null or absent keeps the value on file.
  accessKey?: string | null | undefined
  accessKeySecret?: string | null | undefined
  oauthClientId?: string | null | undefined
  oauthClientSecret?: string | null | undefined
  workspaceIds?: string[] | undefined
  transcriptCacheDays?: number | undefined
  autoLink?: boolean | undefined
  // A PEM public key to set, or null to remove it; absent keeps it.
  webhookPublicKeyPem?: string | null | undefined
}

// Writes the settings that don't need Gong's answer. A changed OAuth client
// id drops the OAuth tokens, since they belong to the old app. Any change to
// the method, host or credentials clears the last check, which described the
// old connection.
export async function updateGongSettings(patch: GongSettingsPatch): Promise<void> {
  const cur = (await loadStored()) ?? blank()
  const next: StoredConfig = { ...cur, oauth: { ...cur.oauth } }
  let connectionChanged = false
  if (patch.authMethod && patch.authMethod !== cur.authMethod) { next.authMethod = patch.authMethod; connectionChanged = true }
  if (patch.apiBaseUrl !== undefined) {
    const url = normalizeGongApiBaseUrl(patch.apiBaseUrl)
    if (!url) throw new Error('errors.gong.base_url_invalid')
    if (url !== cur.apiBaseUrl) { next.apiBaseUrl = url; connectionChanged = true }
  }
  if (patch.accessKey) { next.accessKeyEncrypted = encryptToken(patch.accessKey); connectionChanged = true }
  if (patch.accessKeySecret) { next.accessKeySecretEncrypted = encryptToken(patch.accessKeySecret); connectionChanged = true }
  if (patch.oauthClientId && patch.oauthClientId !== cur.oauth.clientId) {
    next.oauth = { ...EMPTY_OAUTH, clientId: patch.oauthClientId, clientSecretEncrypted: cur.oauth.clientSecretEncrypted }
    connectionChanged = true
  }
  if (patch.oauthClientSecret) { next.oauth.clientSecretEncrypted = encryptToken(patch.oauthClientSecret); connectionChanged = true }
  if (patch.workspaceIds) next.workspaceIds = [...new Set(patch.workspaceIds.filter((w) => w !== ''))]
  if (patch.transcriptCacheDays !== undefined) next.transcriptCacheDays = clampTranscriptCacheDays(patch.transcriptCacheDays)
  if (patch.autoLink !== undefined) next.autoLink = patch.autoLink
  if (patch.webhookPublicKeyPem !== undefined) next.webhookPublicKeyPem = patch.webhookPublicKeyPem
  if (connectionChanged) next.lastCheck = null
  await writeStored(next)
}

// Saves the tokens from a completed authorization (or a refresh). The API
// host Gong names for this tenant replaces the saved one.
export async function saveGongOAuthTokens(input: {
  accessToken: string
  refreshToken: string | null
  expiresInSeconds: number | null
  apiBaseUrl: string | null
  connected?: boolean
}, now: number = Date.now()): Promise<void> {
  const cur = await loadStored()
  if (!cur) throw new Error('errors.gong.not_configured')
  const next: StoredConfig = {
    ...cur,
    oauth: {
      ...cur.oauth,
      accessTokenEncrypted: encryptToken(input.accessToken),
      // Gong may not send a new refresh token on refresh; keep the old one.
      refreshTokenEncrypted: input.refreshToken ? encryptToken(input.refreshToken) : cur.oauth.refreshTokenEncrypted,
      expiresAt: input.expiresInSeconds ? now + input.expiresInSeconds * 1000 : null,
      connectedAt: input.connected ? new Date(now).toISOString() : cur.oauth.connectedAt,
    },
  }
  const host = input.apiBaseUrl ? normalizeGongApiBaseUrl(input.apiBaseUrl) : null
  if (host) next.apiBaseUrl = host
  if (input.connected) next.lastCheck = null
  await writeStored(next)
}

export async function saveGongCheck(report: GongCapabilityReport): Promise<void> {
  const cur = await loadStored()
  if (!cur) return
  await writeStored({ ...cur, lastCheck: report })
}

export async function clearGongConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY))
}
