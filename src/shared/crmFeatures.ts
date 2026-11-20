// App-wide CRM feature switches (Admin → Integrations → CRM features).
// CRM-neutral on purpose: the same switches apply whether the install runs
// Salesforce or (later) HubSpot. Every switch defaults to on, so an install
// that never opens the card keeps exactly today's behavior.
export interface CrmFeatures {
  // Campaign as a link target on activities, the Campaign search tab, the
  // attendee campaign hint, Campaign views/counts on dashboards and Campaign
  // suggestions in note tagging. Off hides all of it and the server refuses
  // NEW Campaign links; activities already linked to a Campaign keep it.
  campaignsEnabled: boolean
  // Lead as a link target on activities (the Who slot), the Lead search tab,
  // Lead views/counts on dashboards and the converted-Lead bucket in the
  // Account rollup. Same contract as Campaigns: off hides it and the server
  // refuses NEW Lead links; existing Lead links are kept.
  leadsEnabled: boolean
  // HubSpot only: whether write-back may CREATE a meeting in HubSpot. Write-
  // back always first looks for the same meeting already logged by HubSpot's
  // own calendar sync (same owner and times) and fills that in instead. Off
  // means it only ever fills in an existing meeting: with none found yet, the
  // activity waits and checks again on the retry schedule. Tasks and
  // Salesforce are unaffected.
  hubspotCreateMeetings: boolean
}

export const DEFAULT_CRM_FEATURES: CrmFeatures = { campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: true }

export function normalizeCrmFeatures(raw: unknown): CrmFeatures {
  const v = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    campaignsEnabled: typeof v['campaignsEnabled'] === 'boolean' ? v['campaignsEnabled'] : DEFAULT_CRM_FEATURES.campaignsEnabled,
    leadsEnabled: typeof v['leadsEnabled'] === 'boolean' ? v['leadsEnabled'] : DEFAULT_CRM_FEATURES.leadsEnabled,
    hubspotCreateMeetings: typeof v['hubspotCreateMeetings'] === 'boolean' ? v['hubspotCreateMeetings'] : DEFAULT_CRM_FEATURES.hubspotCreateMeetings,
  }
}

// Whether the install's CRM can offer each feature at all, independent of
// the admin's switch. Salesforce always can; a HubSpot portal can't when its
// last access check found the scope or tier missing (Campaigns need Marketing
// Hub, Leads the Sales Hub leads object), so its tab and links stay hidden
// even with the switch on. Unknown counts as available.
export interface CrmFeatureAvailability {
  campaigns: boolean
  leads: boolean
}

export const FULL_CRM_FEATURE_AVAILABILITY: CrmFeatureAvailability = { campaigns: true, leads: true }

// The switches as they actually apply: on only when the admin left them on
// AND the CRM offers the feature.
export function effectiveCrmFeatures(features: CrmFeatures, availability: CrmFeatureAvailability): CrmFeatures {
  return {
    campaignsEnabled: features.campaignsEnabled && availability.campaigns,
    leadsEnabled: features.leadsEnabled && availability.leads,
    hubspotCreateMeetings: features.hubspotCreateMeetings,
  }
}

interface WhatLink { crmWhatType?: string | null | undefined; crmWhatId?: string | null | undefined }

// True when a save would CREATE or CHANGE a Campaign link while Campaigns
// is off. Keeping an activity's existing Campaign link unchanged is always
// allowed, so turning the switch off never blocks editing an older activity.
export function isBlockedCampaignLink(features: CrmFeatures, incoming: WhatLink, existing?: WhatLink | null): boolean {
  if (features.campaignsEnabled) return false
  if (incoming.crmWhatType !== 'Campaign') return false
  if (existing && existing.crmWhatType === 'Campaign' && (incoming.crmWhatId ?? existing.crmWhatId) === existing.crmWhatId) return false
  return true
}

interface WhoLink { crmWhoType?: string | null | undefined; crmWhoId?: string | null | undefined }

// Lead counterpart of isBlockedCampaignLink (Leads live in the Who slot).
export function isBlockedLeadLink(features: CrmFeatures, incoming: WhoLink, existing?: WhoLink | null): boolean {
  if (features.leadsEnabled) return false
  if (incoming.crmWhoType !== 'Lead') return false
  if (existing && existing.crmWhoType === 'Lead' && (incoming.crmWhoId ?? existing.crmWhoId) === existing.crmWhoId) return false
  return true
}

// The error key a save gets when it would add a link the switches forbid,
// or null when the save is allowed.
export function blockedCrmLinkError(features: CrmFeatures, incoming: WhatLink & WhoLink, existing?: (WhatLink & WhoLink) | null): string | null {
  if (isBlockedCampaignLink(features, incoming, existing)) return 'errors.crm.campaigns_disabled'
  if (isBlockedLeadLink(features, incoming, existing)) return 'errors.crm.leads_disabled'
  return null
}

// The error key for a refused Campaign or Lead: "turned off" when the admin
// switched it off, "not available" when the switch is on but the CRM can't
// offer it (a HubSpot portal without the scope or tier), since only the
// first is something an App Admin can change in CRM features.
export function crmFeatureErrorKey(kind: 'campaigns' | 'leads', features: CrmFeatures): string {
  const on = kind === 'campaigns' ? features.campaignsEnabled : features.leadsEnabled
  return `errors.crm.${kind}_${on ? 'unavailable' : 'disabled'}`
}
