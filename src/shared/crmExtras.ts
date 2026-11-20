import type { CrmProviderId } from './crmProvider.js'
import { CRITERIAIQ_RELATED_TYPE } from './evaluationSource.js'
import { isHubspotProjectObject } from './hubspot.js'

// Activity Type extras (team_activity_type_crm_extras) per CRM. An Opp field
// or a related picker reads one CRM's records, so it only shows on the
// Activity form while that CRM is the install's CRM; a Salesforce Opp field
// on a HubSpot install would read a Salesforce field name off a Deal. The
// Ticket picker and the CriteriaIQ Project picker work on either CRM.

export type ActivityTypeExtraKind = 'opp_field_display' | 'related_object_picker' | 'ticket_picker'

// The HubSpot object an Opp field reads: a Deal property.
export const HUBSPOT_OPP_FIELD_OBJECT = 'deals'

// HubSpot property names are letters, digits and underscores.
export const HUBSPOT_PROPERTY_RX = /^[A-Za-z0-9_]{1,100}$/

function sobjectOf(config: unknown): string | null {
  const v = config && typeof config === 'object' ? (config as Record<string, unknown>)['sobject'] : null
  return typeof v === 'string' && v.length > 0 ? v : null
}

// The CRM an extra belongs to, or null when it works on any CRM.
export function activityTypeExtraCrm(kind: string, config: unknown): Exclude<CrmProviderId, 'none'> | null {
  const sobject = sobjectOf(config)
  if (kind === 'opp_field_display') return sobject === HUBSPOT_OPP_FIELD_OBJECT ? 'hubspot' : 'salesforce'
  if (kind === 'related_object_picker') {
    if (sobject === CRITERIAIQ_RELATED_TYPE) return null
    return isHubspotProjectObject(sobject) ? 'hubspot' : 'salesforce'
  }
  return null
}

export function isActivityTypeExtraShownOn(kind: string, config: unknown, provider: CrmProviderId): boolean {
  const crm = activityTypeExtraCrm(kind, config)
  return crm === null || crm === provider
}
