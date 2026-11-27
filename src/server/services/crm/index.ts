import type { RequestHandler } from 'express'
import type { CrmProviderId } from '../../../shared/crmProvider.js'
import { getCrmProviderId } from './providerSetting.js'
import { salesforceProvider } from './salesforceProvider.js'
import { hubspotProvider } from './hubspotProvider.js'
import type { CrmProvider } from './types.js'
import { logSafe } from '../../lib/logSafe.js'

export type { CrmProvider, CrmUserSession } from './types.js'
export { getCrmProviderId, getCrmProviderSetting, setCrmProviderId, isCrmProviderActive, clearCrmProviderCache } from './providerSetting.js'

// Implemented providers. HubSpot joined in phase 2b (v1.390.0).
const PROVIDERS: Partial<Record<CrmProviderId, CrmProvider>> = {
  salesforce: salesforceProvider,
  hubspot: hubspotProvider,
}

// CRMs an admin can choose: every built provider, plus 'none'.
export function availableCrmProviderIds(): CrmProviderId[] {
  return [...(Object.keys(PROVIDERS) as CrmProviderId[]), 'none']
}

// The CRM this install talks to, or null when there is none (crm_provider is
// 'none', or names a provider that isn't built yet).
export async function getActiveCrmProvider(): Promise<CrmProvider | null> {
  return PROVIDERS[await getCrmProviderId()] ?? null
}

// Fire-and-forget CRM write for one activity. A no-op when no CRM is active.
export function queueCrmActivitySync(activityId: string): void {
  void getActiveCrmProvider()
    .then((provider) => provider?.queueActivitySync(activityId))
    .catch((err) => { console.error('[crm] queue sync failed for %s:', logSafe(activityId), err) })
}

// Fire-and-forget note push for one queued activity_note_pushes row. A no-op
// when no CRM is active (the row stays pending until one is).
export function queueCrmNotePush(pushId: string): void {
  void getActiveCrmProvider()
    .then((provider) => provider?.queueNotePush(pushId))
    .catch((err) => { console.error('[crm] queue note push failed for %s:', pushId, err) })
}

// Guards a provider's own routes (e.g. /api/salesforce/*). "One CRM or the
// other" is enforced on the server, not just by hiding screens: when the
// install runs a different CRM, these routes answer 409.
export function requireCrmProvider(provider: CrmProviderId): RequestHandler {
  return async (_req, res, next) => {
    if ((await getCrmProviderId()) === provider) { next(); return }
    res.status(409).json({ data: null, error: 'errors.crm.provider_mismatch', meta: { required: provider } })
  }
}
