import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import {
  DEFAULT_CRM_FEATURES, FULL_CRM_FEATURE_AVAILABILITY, blockedCrmLinkError, crmFeatureErrorKey,
  effectiveCrmFeatures, normalizeCrmFeatures,
  type CrmFeatureAvailability, type CrmFeatures,
} from '../../../shared/crmFeatures.js'
import { getHubspotConfig } from '../hubspot/config.js'
import { getCrmProviderId } from './providerSetting.js'

// Stored in system_settings like the other app-wide integration settings.
// Read on hot paths (activity save, SF search), so cached briefly; a write
// from this process clears the cache, and a restore or another instance's
// write is picked up within the TTL.
const KEY_CRM_FEATURES = 'crm_features'
const CACHE_TTL_MS = 30_000
let cache: { value: CrmFeatures; at: number } | null = null

export async function getCrmFeatures(): Promise<CrmFeatures> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_CRM_FEATURES)).limit(1)
    const value = normalizeCrmFeatures(row?.value)
    cache = { value, at: Date.now() }
    return value
  } catch {
    return DEFAULT_CRM_FEATURES
  }
}

export async function setCrmFeatures(patch: Partial<CrmFeatures>): Promise<CrmFeatures> {
  const current = await getCrmFeatures()
  const next = normalizeCrmFeatures({ ...current, ...patch })
  await db.insert(systemSettings).values({ key: KEY_CRM_FEATURES, value: next })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: next, updatedAt: new Date() } })
  cache = { value: next, at: Date.now() }
  return next
}

export function clearCrmFeaturesCache(): void {
  cache = null
}

// Which features the active CRM can offer (CrmFeatureAvailability). Only a
// HubSpot portal can lack one, and only when the last access check marked the
// capability missing (HubSpot answered 403); a portal never checked, or a
// probe that failed some other way, counts as available.
export async function getCrmFeatureAvailability(): Promise<CrmFeatureAvailability> {
  try {
    if ((await getCrmProviderId()) !== 'hubspot') return FULL_CRM_FEATURE_AVAILABILITY
    const caps = (await getHubspotConfig())?.lastCheck?.capabilities ?? []
    const missing = (key: string) => caps.some((c) => c.key === key && c.status === 'missing')
    return { campaigns: !missing('campaigns_read'), leads: !missing('leads_read') }
  } catch {
    return FULL_CRM_FEATURE_AVAILABILITY
  }
}

// The switches as they apply right now: the admin's choice, narrowed by what
// the CRM offers. Every screen and route that hides or refuses a Campaign or
// Lead uses this; only the admin card reads the raw switches.
export async function getEffectiveCrmFeatures(): Promise<CrmFeatures> {
  const [features, availability] = await Promise.all([getCrmFeatures(), getCrmFeatureAvailability()])
  return effectiveCrmFeatures(features, availability)
}

// The error key when a Campaign or Lead feature can't be used right now, or
// null when it can. Used by the search routes.
export async function crmFeatureBlock(kind: 'campaigns' | 'leads'): Promise<string | null> {
  const [features, availability] = await Promise.all([getCrmFeatures(), getCrmFeatureAvailability()])
  const effective = effectiveCrmFeatures(features, availability)
  const on = kind === 'campaigns' ? effective.campaignsEnabled : effective.leadsEnabled
  return on ? null : crmFeatureErrorKey(kind, features)
}

// blockedCrmLinkError() against the switches as they apply, with the error
// key saying whether the admin turned the feature off or the CRM lacks it.
export async function crmLinkBlockError(
  incoming: Parameters<typeof blockedCrmLinkError>[1],
  existing?: Parameters<typeof blockedCrmLinkError>[2],
): Promise<string | null> {
  const [features, availability] = await Promise.all([getCrmFeatures(), getCrmFeatureAvailability()])
  const key = blockedCrmLinkError(effectiveCrmFeatures(features, availability), incoming, existing)
  if (!key) return null
  return crmFeatureErrorKey(key === 'errors.crm.campaigns_disabled' ? 'campaigns' : 'leads', features)
}
