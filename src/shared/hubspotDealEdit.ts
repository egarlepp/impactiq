// Who may change a HubSpot Deal from ImpactIQ (v1.424.0, security audit M4).
// ImpactIQ writes to HubSpot with one portal-wide key, so this setting is the
// only check standing in for a user's own HubSpot permissions.
//   any_matched_user: anyone matched to an active HubSpot user (the rule
//     before this setting existed, and the default).
//   named_on_deal: only someone a chosen Deal property names (Deal owner, an
//     Assigned SE property, ...); everyone else gets read-only access.
export type HubspotDealEditMode = 'any_matched_user' | 'named_on_deal'

export interface HubspotDealEditPolicy {
  mode: HubspotDealEditMode
  properties: string[]
}

export const MAX_DEAL_EDIT_PROPERTIES = 10
const PROPERTY_RX = /^[A-Za-z0-9_]{1,100}$/

export const DEFAULT_HUBSPOT_DEAL_EDIT_POLICY: HubspotDealEditPolicy = { mode: 'any_matched_user', properties: [] }

export function normalizeHubspotDealEditPolicy(v: unknown): HubspotDealEditPolicy {
  if (!v || typeof v !== 'object') return DEFAULT_HUBSPOT_DEAL_EDIT_POLICY
  const o = v as Record<string, unknown>
  const mode: HubspotDealEditMode = o['mode'] === 'named_on_deal' ? 'named_on_deal' : 'any_matched_user'
  const raw = Array.isArray(o['properties']) ? o['properties'] : []
  const properties = [...new Set(raw.filter((p): p is string => typeof p === 'string' && PROPERTY_RX.test(p)))].slice(0, MAX_DEAL_EDIT_PROPERTIES)
  return { mode, properties }
}
