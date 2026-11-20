// Which CRM this install talks to. One install-wide choice,
// never both: HubSpot is an alternative to Salesforce, not an add-on.
//
// 'salesforce' is the default so every install that predates the setting
// keeps exactly today's behavior. 'hubspot' runs the HubSpot provider
// (services/crm/hubspotProvider.ts). 'none' turns every CRM path off. An id
// with no registered provider behaves like 'none'.
export const CRM_PROVIDER_IDS = ['salesforce', 'hubspot', 'none'] as const
export type CrmProviderId = typeof CRM_PROVIDER_IDS[number]

export const DEFAULT_CRM_PROVIDER: CrmProviderId = 'salesforce'

export function isCrmProviderId(v: unknown): v is CrmProviderId {
  return typeof v === 'string' && (CRM_PROVIDER_IDS as readonly string[]).includes(v)
}

// Stored as { provider } in system_settings. Anything unreadable falls back to
// the default rather than switching the CRM off by accident.
export function normalizeCrmProvider(raw: unknown): CrmProviderId {
  const v = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>)['provider'] : raw
  return isCrmProviderId(v) ? v : DEFAULT_CRM_PROVIDER
}

// The stored setting also remembers which CRM the install's linked records
// came from (`dataProvider`). Record ids aren't portable between CRMs, so once
// CRM-linked data exists the install may only switch between that CRM and
// 'none' (see services/crm/providerLock.ts). Installs that predate the field
// have only ever written Salesforce links, so it defaults to Salesforce.
export interface CrmProviderSetting {
  provider: CrmProviderId
  dataProvider: Exclude<CrmProviderId, 'none'>
}

export function normalizeCrmProviderSetting(raw: unknown): CrmProviderSetting {
  const provider = normalizeCrmProvider(raw)
  const d = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>)['dataProvider'] : undefined
  const dataProvider = isCrmProviderId(d) && d !== 'none'
    ? d
    : provider === 'none' ? 'salesforce' : provider
  return { provider, dataProvider }
}

// Whether a change from `from` to `to` is allowed. With no CRM-linked data
// every change is allowed; with data, only the data's own CRM or 'none'.
export function crmProviderChangeAllowed(setting: CrmProviderSetting, to: CrmProviderId, hasLinkedData: boolean): boolean {
  if (to === setting.provider || !hasLinkedData) return true
  return to === 'none' || to === setting.dataProvider
}

// The CRM's name on screen. Every UI string that names the CRM uses the
// i18next variables {{crm}} / {{crmShort}} (set from these by the client), so
// adding a CRM means adding it here, not editing translations. Proper nouns,
// the same in every language. 'none' reads as the generic "CRM".
export const CRM_DISPLAY_NAMES: Record<CrmProviderId, { name: string; short: string }> = {
  salesforce: { name: 'Salesforce', short: 'SF' },
  hubspot: { name: 'HubSpot', short: 'HubSpot' },
  none: { name: 'CRM', short: 'CRM' },
}

export function crmWordingVariables(provider: CrmProviderId): { crm: string; crmShort: string } {
  const n = CRM_DISPLAY_NAMES[provider]
  return { crm: n.name, crmShort: n.short }
}
