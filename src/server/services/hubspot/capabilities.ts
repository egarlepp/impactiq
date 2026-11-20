import {
  HUBSPOT_CAPABILITY_SCOPES,
  REQUIRED_HUBSPOT_CAPABILITIES,
  type HubspotCapability,
  type HubspotCapabilityKey,
  type HubspotCapabilityReport,
  type HubspotCapabilityStatus,
} from '../../../shared/hubspot.js'
import { HubspotError, hubspotRequest } from './client.js'
import type { HubspotPortalInfo } from './config.js'

// What a HubSpot token can do (HubSpot plan, phase 2a). A private app token
// can't be asked for its scopes (HubSpot's token introspection only covers
// OAuth tokens), and a scope is useless if the portal's tier lacks the
// feature anyway, so each capability is probed with one small request:
//
//   reads  — fetch one record or one known property. 2xx is ok.
//   writes — PATCH a record id that can't exist (0, or the nil UUID for a
//            campaign). HubSpot checks scopes
//            before looking the record up, so 404/400 means the write would
//            be allowed and 403 means it wouldn't. Nothing is ever created
//            or changed.
//
// 403 always means missing (a scope the private app lacks, or a feature the
// tier doesn't include). Anything else (a 5xx, a network error, a rate limit)
// says nothing either way and reads as unknown. A rejected token (401) stops
// the whole check: no capability can be judged without a working token.

interface Probe {
  key: HubspotCapabilityKey
  method: 'GET' | 'PATCH'
  path: string
  query?: Record<string, string | number>
}

export const HUBSPOT_PROBES: readonly Probe[] = [
  { key: 'deals_read', method: 'GET', path: '/crm/v3/objects/deals', query: { limit: 1 } },
  { key: 'companies_read', method: 'GET', path: '/crm/v3/objects/companies', query: { limit: 1 } },
  { key: 'contacts_read', method: 'GET', path: '/crm/v3/objects/contacts', query: { limit: 1 } },
  { key: 'owners_read', method: 'GET', path: '/crm/v3/owners', query: { limit: 1 } },
  { key: 'deal_properties_read', method: 'GET', path: '/crm/v3/properties/deals/dealname' },
  { key: 'company_properties_read', method: 'GET', path: '/crm/v3/properties/companies/name' },
  { key: 'contact_properties_read', method: 'GET', path: '/crm/v3/properties/contacts/email' },
  { key: 'meetings_write', method: 'PATCH', path: '/crm/v3/objects/meetings/0' },
  { key: 'deals_write', method: 'PATCH', path: '/crm/v3/objects/deals/0' },
  { key: 'tickets_read', method: 'GET', path: '/crm/v3/objects/tickets', query: { limit: 1 } },
  { key: 'leads_read', method: 'GET', path: '/crm/v3/objects/leads', query: { limit: 1 } },
  { key: 'campaigns_read', method: 'GET', path: '/marketing/v3/campaigns', query: { limit: 1 } },
  // Campaigns are named by UUID, so the "can't exist" record is the nil UUID.
  { key: 'campaigns_write', method: 'PATCH', path: '/marketing/v3/campaigns/00000000-0000-0000-0000-000000000000' },
  { key: 'custom_objects_read', method: 'GET', path: '/crm/v3/schemas' },
  { key: 'projects_read', method: 'GET', path: '/crm/v3/objects/0-970', query: { limit: 1 } },
  { key: 'projects_write', method: 'PATCH', path: '/crm/v3/objects/0-970/0' },
]

export function classifyProbe(method: Probe['method'], status: number): HubspotCapabilityStatus {
  if (status === 403) return 'missing'
  if (status >= 200 && status < 300) return 'ok'
  if (method === 'PATCH' && (status === 404 || status === 400)) return 'ok'
  return 'unknown'
}

export async function checkHubspotCapabilities(
  opts: { token?: string; portalId?: number | null } = {},
): Promise<HubspotCapabilityReport> {
  const capabilities: HubspotCapability[] = []
  // One at a time: sixteen small requests sit far inside the rate limit, and
  // a 401 on the first one ends the check before the rest are sent.
  for (const probe of HUBSPOT_PROBES) {
    let status: HubspotCapabilityStatus
    try {
      const res = await hubspotRequest(probe.path, {
        method: probe.method,
        query: probe.query,
        body: probe.method === 'PATCH' ? { properties: {} } : undefined,
        token: opts.token,
      })
      status = classifyProbe(probe.method, res.status)
    } catch (err) {
      if (err instanceof HubspotError && (err.code === 'errors.hubspot.unauthorized' || err.code === 'errors.hubspot.not_configured')) throw err
      status = 'unknown'
    }
    capabilities.push({ key: probe.key, scope: HUBSPOT_CAPABILITY_SCOPES[probe.key], required: REQUIRED_HUBSPOT_CAPABILITIES.has(probe.key), status })
  }
  return {
    checkedAt: new Date().toISOString(),
    portalId: opts.portalId ?? null,
    ready: capabilities.every((c) => !c.required || c.status === 'ok'),
    capabilities,
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

// Checks a token before it's saved and reads which portal it belongs to.
// /account-info/v3/details names the portal, but a private app may not be
// allowed to read it; then the owners list (a required scope anyway) proves
// the token works and the portal stays unnamed. Throws HubspotError
// unauthorized for a rejected token.
export async function inspectHubspotToken(token: string): Promise<HubspotPortalInfo> {
  const info = await hubspotRequest('/account-info/v3/details', { token })
  const body = asRecord(info.body)
  if (info.status >= 200 && info.status < 300 && body) {
    const portalId = typeof body['portalId'] === 'number' ? body['portalId'] : null
    return {
      portalId,
      portalName: typeof body['portalName'] === 'string' ? body['portalName'] : null,
      accountType: typeof body['accountType'] === 'string' ? body['accountType'] : null,
      uiDomain: typeof body['uiDomain'] === 'string' ? body['uiDomain'] : null,
    }
  }
  // Any answer other than 401 (which hubspotRequest throws) means HubSpot
  // accepted the token.
  await hubspotRequest('/crm/v3/owners', { token, query: { limit: 1 } })
  return { portalId: null, portalName: null, accountType: null, uiDomain: null }
}
