// The timezone the active CRM holds for a user, for My Settings → Timezone
// (v1.469.0). Read only; picking it is a separate PATCH /auth/me/timezone.
//   salesforce  the user's own Salesforce User.TimeZoneSidKey (needs their own
//               Salesforce connection)
//   hubspot     the portal's account timezone (/account-info/v3/details);
//               HubSpot keeps no per-owner timezone the API can read
//   none        nothing; Settings hides the CRM row
// A failed read answers timezone: null rather than an error, so the page shows
// "Not available" instead of a broken section.
import { getCrmProviderId } from './providerSetting.js'
import type { CrmProviderId } from '../../../shared/crmProvider.js'
import { getSfConnection } from '../salesforce/client.js'
import { safeSoqlLiteral } from '../salesforce/soql.js'
import { getHubspotConfig } from '../hubspot/config.js'
import { hubspotRequest } from '../hubspot/client.js'

export interface CrmTimezone {
  provider: CrmProviderId
  connected: boolean
  timezone: string | null
}

const HUBSPOT_TZ_TTL_MS = 60 * 60 * 1000
let hubspotTzCache: { portalId: number | null; timezone: string | null; at: number } | null = null

export function clearHubspotTimezoneCache(): void {
  hubspotTzCache = null
}

async function salesforceTimezone(userId: string): Promise<Omit<CrmTimezone, 'provider'>> {
  const conn = await getSfConnection(userId)
  if (!conn) return { connected: false, timezone: null }
  try {
    const info = await conn.identity()
    const q = await conn.query(`SELECT TimeZoneSidKey FROM User WHERE Id = '${safeSoqlLiteral(info.user_id)}' LIMIT 1`)
    const first = q.records[0] as { TimeZoneSidKey?: string } | undefined
    return { connected: true, timezone: first?.TimeZoneSidKey ?? null }
  } catch {
    return { connected: true, timezone: null }
  }
}

async function hubspotTimezone(): Promise<Omit<CrmTimezone, 'provider'>> {
  const cfg = await getHubspotConfig().catch(() => null)
  if (!cfg) return { connected: false, timezone: null }
  const portalId = cfg.portalId ?? null
  if (hubspotTzCache && hubspotTzCache.portalId === portalId && Date.now() - hubspotTzCache.at < HUBSPOT_TZ_TTL_MS) {
    return { connected: true, timezone: hubspotTzCache.timezone }
  }
  let timezone: string | null = null
  try {
    const res = await hubspotRequest('/account-info/v3/details')
    const body = res.body && typeof res.body === 'object' && !Array.isArray(res.body) ? res.body as Record<string, unknown> : null
    if (res.status >= 200 && res.status < 300 && body && typeof body['timeZone'] === 'string' && body['timeZone']) {
      timezone = body['timeZone']
    }
  } catch {
    // A private app without account-info access, or HubSpot being down.
    return { connected: true, timezone: null }
  }
  hubspotTzCache = { portalId, timezone, at: Date.now() }
  return { connected: true, timezone }
}

export async function getCrmTimezoneForUser(userId: string): Promise<CrmTimezone> {
  const provider = await getCrmProviderId()
  if (provider === 'salesforce') return { provider, ...(await salesforceTimezone(userId)) }
  if (provider === 'hubspot') return { provider, ...(await hubspotTimezone()) }
  return { provider, connected: false, timezone: null }
}
