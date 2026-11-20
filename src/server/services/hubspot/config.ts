import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { decryptToken, encryptToken } from '../config/crypto.js'
import type { HubspotCapabilityReport } from '../../../shared/hubspot.js'

// The install's one HubSpot connection (HubSpot plan, phase 2a): a private
// app access token the customer's HubSpot admin creates and pastes into
// Admin → Integrations. HubSpot tokens see the whole portal, so there are no
// per-user HubSpot logins; ImpactIQ users are matched to HubSpot owners by
// email (owners.ts). The token is stored AES-256-GCM encrypted, same cipher
// as the Salesforce/Outlook refresh tokens and the CriteriaIQ key, and never
// leaves the server.
const KEY = 'hubspot_config'

export interface HubspotPortalInfo {
  portalId: number | null
  portalName: string | null
  accountType: string | null
  uiDomain: string | null
}

interface StoredConfig extends HubspotPortalInfo {
  accessTokenEncrypted: string
  lastCheck: HubspotCapabilityReport | null
}

export interface HubspotConfig extends HubspotPortalInfo {
  accessToken: string
  lastCheck: HubspotCapabilityReport | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

async function loadStored(): Promise<StoredConfig | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1)
  const v = row?.value as Record<string, unknown> | undefined
  if (!v || typeof v['accessTokenEncrypted'] !== 'string' || v['accessTokenEncrypted'] === '') return null
  return {
    accessTokenEncrypted: v['accessTokenEncrypted'],
    portalId: num(v['portalId']),
    portalName: str(v['portalName']),
    accountType: str(v['accountType']),
    uiDomain: str(v['uiDomain']),
    lastCheck: (v['lastCheck'] && typeof v['lastCheck'] === 'object') ? v['lastCheck'] as HubspotCapabilityReport : null,
  }
}

async function writeStored(value: StoredConfig): Promise<void> {
  await db.insert(systemSettings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } })
}

// Null when not configured, or when the stored token can't be decrypted (a
// restore onto an install with a different TOKEN_ENCRYPTION_KEY): the admin
// pastes the token again in that case.
export async function getHubspotConfig(): Promise<HubspotConfig | null> {
  const stored = await loadStored()
  if (!stored) return null
  try {
    const { accessTokenEncrypted, ...rest } = stored
    return { ...rest, accessToken: decryptToken(accessTokenEncrypted) }
  } catch {
    return null
  }
}

export async function isHubspotConfigured(): Promise<boolean> {
  return (await getHubspotConfig()) !== null
}

export async function setHubspotConfig(accessToken: string, portal: HubspotPortalInfo): Promise<void> {
  await writeStored({ accessTokenEncrypted: encryptToken(accessToken), ...portal, lastCheck: null })
}

// Keeps the latest capability check, so the card shows it without probing
// HubSpot again on every page load.
export async function saveHubspotCheck(report: HubspotCapabilityReport): Promise<void> {
  const stored = await loadStored()
  if (!stored) return
  await writeStored({ ...stored, lastCheck: report })
}

export async function clearHubspotConfig(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, KEY))
}
