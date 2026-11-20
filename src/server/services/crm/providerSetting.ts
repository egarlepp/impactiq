import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { DEFAULT_CRM_PROVIDER, normalizeCrmProviderSetting, type CrmProviderId, type CrmProviderSetting } from '../../../shared/crmProvider.js'

// The install-wide crm_provider setting. Read on every CRM request and on
// every CRM job tick, so cached briefly, same as crm_features: a write from
// this process clears the cache, and a restore or another instance's write is
// picked up within the TTL.
//
// Deliberately imports nothing from a provider implementation, so the
// Salesforce code can check "am I the active CRM?" without an import cycle.
const KEY_CRM_PROVIDER = 'crm_provider'
const CACHE_TTL_MS = 30_000
let cache: { value: CrmProviderSetting; at: number } | null = null

export async function getCrmProviderSetting(): Promise<CrmProviderSetting> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_CRM_PROVIDER)).limit(1)
    const value = normalizeCrmProviderSetting(row?.value)
    cache = { value, at: Date.now() }
    return value
  } catch {
    // A settings read failure must never switch the CRM off.
    return normalizeCrmProviderSetting({ provider: DEFAULT_CRM_PROVIDER })
  }
}

export async function getCrmProviderId(): Promise<CrmProviderId> {
  return (await getCrmProviderSetting()).provider
}

// Writes the setting as-is. Callers that change the CRM after install go
// through changeCrmProvider() (providerLock.ts), which checks the lock and
// keeps dataProvider right; this low-level write doesn't.
export async function writeCrmProviderSetting(value: CrmProviderSetting): Promise<CrmProviderSetting> {
  await db.insert(systemSettings).values({ key: KEY_CRM_PROVIDER, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } })
  cache = { value, at: Date.now() }
  return value
}

export async function setCrmProviderId(provider: CrmProviderId): Promise<CrmProviderId> {
  const current = await getCrmProviderSetting()
  await writeCrmProviderSetting({ provider, dataProvider: provider === 'none' ? current.dataProvider : provider })
  return provider
}

export async function isCrmProviderActive(provider: CrmProviderId): Promise<boolean> {
  return (await getCrmProviderId()) === provider
}

export function clearCrmProviderCache(): void {
  cache = null
}
