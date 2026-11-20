// HubSpot connection shapes shared by the server routes and the Admin →
// Integrations card (HubSpot plan, phase 2a).

// What the capability check probes. `required` checks must pass before
// HubSpot can be the install's CRM; the rest describe features later phases
// use, so a portal without them still connects and the card says what's off.
export const HUBSPOT_CAPABILITY_KEYS = [
  'deals_read',
  'companies_read',
  'contacts_read',
  'owners_read',
  'deal_properties_read',
  'company_properties_read',
  'contact_properties_read',
  'meetings_write',
  'deals_write',
  'tickets_read',
  'leads_read',
  'campaigns_read',
  'campaigns_write',
  'custom_objects_read',
  'projects_read',
  'projects_write',
] as const
export type HubspotCapabilityKey = (typeof HUBSPOT_CAPABILITY_KEYS)[number]

export const REQUIRED_HUBSPOT_CAPABILITIES: ReadonlySet<HubspotCapabilityKey> = new Set([
  'deals_read',
  'companies_read',
  'contacts_read',
  'owners_read',
  'deal_properties_read',
  'company_properties_read',
  'contact_properties_read',
  'meetings_write',
])

// The scope that grants each capability. The access check reports it, and the
// connection card lists them before a key is saved so the admin knows what to
// grant. HubSpot grants meeting writes through the contacts write scope.
export const HUBSPOT_CAPABILITY_SCOPES: Readonly<Record<HubspotCapabilityKey, string>> = {
  deals_read: 'crm.objects.deals.read',
  companies_read: 'crm.objects.companies.read',
  contacts_read: 'crm.objects.contacts.read',
  owners_read: 'crm.objects.owners.read',
  deal_properties_read: 'crm.schemas.deals.read',
  company_properties_read: 'crm.schemas.companies.read',
  contact_properties_read: 'crm.schemas.contacts.read',
  meetings_write: 'crm.objects.contacts.write',
  deals_write: 'crm.objects.deals.write',
  tickets_read: 'crm.objects.tickets.read',
  leads_read: 'crm.objects.leads.read',
  campaigns_read: 'marketing.campaigns.read',
  campaigns_write: 'marketing.campaigns.write',
  custom_objects_read: 'crm.schemas.custom.read',
  projects_read: 'crm.objects.projects.read',
  projects_write: 'crm.objects.projects.write',
}

// ok: the portal and token allow it. missing: HubSpot answered 403 (a scope
// the private app lacks, or a feature the portal's tier doesn't include).
// unknown: the probe failed some other way, so nothing can be concluded.
export type HubspotCapabilityStatus = 'ok' | 'missing' | 'unknown'

export interface HubspotCapability {
  key: HubspotCapabilityKey
  // The private app scope that grants it, shown to the admin.
  scope: string
  required: boolean
  status: HubspotCapabilityStatus
}

export interface HubspotCapabilityReport {
  checkedAt: string
  portalId: number | null
  // Every required capability is ok.
  ready: boolean
  capabilities: HubspotCapability[]
}

export interface HubspotOwnerMatchSummary {
  owners: number
  lastSyncedAt: string | null
  // ImpactIQ users whose email matches an active HubSpot owner.
  matchedUsers: number
  unmatchedUsers: Array<{ id: string; displayName: string; email: string }>
}

export interface HubspotConnectionSummary {
  configured: boolean
  // Last 4 characters only, so an admin can tell which token is on file.
  tokenHint: string | null
  portalId: number | null
  portalName: string | null
  accountType: string | null
  uiDomain: string | null
  lastCheck: HubspotCapabilityReport | null
  owners: HubspotOwnerMatchSummary
}

// HubSpot record ids are numeric strings (phase 2b). Anything else never
// reaches a HubSpot URL.
export const HUBSPOT_ID_RX = /^[0-9]{1,20}$/

// Who an exclusion rule on the HubSpot historical import names (v1.401.0): a
// HubSpot owner id, `user:<HubSpot user id>` for a creator with no owner
// record, or `source:<id>` for the app or integration that created a meeting.
export const HUBSPOT_HISTORICAL_ACTOR_RX = /^(?:[0-9]{1,20}|(?:user|source):[A-Za-z0-9_.:-]{1,100})$/

// Marketing Hub campaigns are the exception: the Campaigns API names them by
// a UUID (campaignGuid), not a numeric id (phase 5).
export const HUBSPOT_CAMPAIGN_ID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// HubSpot object names used as `crm_object` on field mapping rows (the column
// is free text). HubSpot's own API names, so they never collide with
// Salesforce's (Opportunity, Event, ...).
export const HUBSPOT_MAPPING_OBJECTS = ['meetings', 'tasks', 'deals', 'tickets', 'companies', 'contacts'] as const
export type HubspotMappingObject = (typeof HUBSPOT_MAPPING_OBJECTS)[number]

// App field for the default ("my deals") Deal search: a deal property whose
// value is a HubSpot owner id (a "HubSpot user" property, single or multiple
// checkbox), e.g. an Assigned SE property. Every active row is OR'd with the
// deal owner. HubSpot portals name these properties themselves, so nothing
// here assumes one.
export const HUBSPOT_SE_FILTER_APP_FIELD = 'deal_se_owner'

export function isHubspotMappingObject(v: string): v is HubspotMappingObject {
  return (HUBSPOT_MAPPING_OBJECTS as readonly string[]).includes(v)
}

// The app fields each HubSpot object's mappings feed (phase 2b part 2). The
// mappings screen offers only these, and Validate & dry run flags any other
// app field as having no effect. Meetings and tasks are written by the
// activity write-back (hubspot/writeback.ts); deal fields are read by the
// Deal search and hover preview; ticket fields by the Support Tickets
// picker (phase 4), which uses HubSpot's standard ticket properties for any
// field left unmapped. Two deal fields are also written (see
// HUBSPOT_DEAL_WRITE_APP_FIELDS). Companies and contacts have no mapped fields yet, so
// they aren't offered.
export const HUBSPOT_ENGAGEMENT_APP_FIELDS = [
  'title', 'activity_type', 'start_datetime', 'end_datetime', 'effort_hours', 'notes', 'description', 'user_id',
] as const
export const HUBSPOT_DEAL_APP_FIELDS = [
  HUBSPOT_SE_FILTER_APP_FIELD, 'acv', 'assigned_se_name', 'assigned_se_write', 'primary_engineer_name',
  'opp_new_business_acv', 'opp_new_business_tcv', 'opp_renewal_acv', 'opp_renewal_tcv',
] as const
// Deal app fields ImpactIQ writes (phase 6), when the mapping allows it:
// the activity's ACV after a sync, and the Assigned SE picker. Every other
// deal field is only read.
export const HUBSPOT_DEAL_WRITE_APP_FIELDS: ReadonlySet<string> = new Set(['acv', 'assigned_se_write'])
// No ticket_account: a ticket's Company comes from its association.
export const HUBSPOT_TICKET_APP_FIELDS = [
  'ticket_number', 'ticket_subject', 'ticket_date_opened', 'ticket_status', 'ticket_contact',
  'ticket_description', 'ticket_platform', 'ticket_owner',
] as const
export const HUBSPOT_APP_FIELDS: Readonly<Record<HubspotMappingObject, readonly string[]>> = {
  meetings: HUBSPOT_ENGAGEMENT_APP_FIELDS,
  tasks: HUBSPOT_ENGAGEMENT_APP_FIELDS,
  deals: HUBSPOT_DEAL_APP_FIELDS,
  tickets: HUBSPOT_TICKET_APP_FIELDS,
  companies: [],
  contacts: [],
}

// ── Projects (Evaluations) on HubSpot (phase 6b) ─────────────────────────
// A team's Project picker points at one HubSpot object, named by its object
// type id: HubSpot's standard Projects object (0-970) or an Enterprise custom
// object (2-…). The id is what activities.crm_related_type stores and what the
// eval_* mappings carry in crm_object, so it never collides with a Salesforce
// object name or the fixed HubSpot names above.
export const HUBSPOT_PROJECTS_OBJECT_TYPE_ID = '0-970'
export const HUBSPOT_PROJECT_OBJECT_RX = /^[02]-[0-9]{1,15}$/

export function isHubspotProjectObject(v: string | null | undefined): v is string {
  return typeof v === 'string' && HUBSPOT_PROJECT_OBJECT_RX.test(v)
}

// The Project fields ImpactIQ reads, edits and posts to (the same app fields
// as the Salesforce Evaluation object).
export const HUBSPOT_PROJECT_APP_FIELDS = [
  'eval_name', 'eval_status', 'eval_stage', 'eval_type', 'eval_start_date', 'eval_end_date',
  'eval_primary_engineer', 'eval_engineer_notes', 'eval_next_steps',
] as const
// Fields the Project panel edits in place.
export const HUBSPOT_PROJECT_EDITABLE_APP_FIELDS: ReadonlySet<string> = new Set([
  'eval_status', 'eval_stage', 'eval_type', 'eval_start_date', 'eval_end_date',
])
// Fields that take a dated, prepended entry (Engineer Notes, Next Steps).
export const HUBSPOT_PROJECT_PREPEND_APP_FIELDS: ReadonlySet<string> = new Set(['eval_engineer_notes', 'eval_next_steps'])

// Any object a HubSpot field mapping can name: a fixed object or a Project object.
export function isHubspotMappingTarget(v: string): boolean {
  return isHubspotMappingObject(v) || isHubspotProjectObject(v)
}

export function hubspotAppFieldsFor(object: string): readonly string[] {
  if (isHubspotMappingObject(object)) return HUBSPOT_APP_FIELDS[object]
  if (isHubspotProjectObject(object)) return HUBSPOT_PROJECT_APP_FIELDS
  return []
}

// A Project object the portal offers, for the admin pickers.
export interface HubspotProjectObject {
  objectTypeId: string
  // HubSpot's standard Projects object, as opposed to a custom object.
  standard: boolean
  // The portal's own labels; null for the standard object (the UI names it).
  label: string | null
  primaryDisplayProperty: string
}

// Objects the mappings screen offers: those with at least one app field.
export const HUBSPOT_MAPPABLE_OBJECTS: readonly HubspotMappingObject[] =
  HUBSPOT_MAPPING_OBJECTS.filter((o) => HUBSPOT_APP_FIELDS[o].length > 0)

// Only the write-back reads constants, so only engagement objects take one.
export function hubspotObjectTakesConstants(object: string): boolean {
  return object === 'meetings' || object === 'tasks'
}

// A HubSpot property as the mappings screen sees it, shaped like the
// Salesforce describe rows (/api/admin/sf/fields) so the same pickers work.
// `type` uses the Salesforce-style names the constant input understands.
export interface HubspotPropertyField {
  apiName: string
  label: string
  type: 'string' | 'textarea' | 'double' | 'date' | 'datetime' | 'boolean' | 'picklist' | 'multipicklist' | 'owner'
  // HubSpot's own type and field type, for display and validation.
  hubspotType: string
  fieldType: string
  isCustom: boolean
  readOnly: boolean
  referenceTo: string[]
  picklistValues: Array<{ value: string; label: string }>
}

// A HubSpot record's page in the portal: https://{uiDomain}/contacts/{portalId}/record/{objectTypeId}/{id}.
// app.hubspot.com redirects to the portal's own data center when the
// connection check didn't report a uiDomain.
export const HUBSPOT_OBJECT_TYPE_IDS = { contacts: '0-1', companies: '0-2', deals: '0-3', tickets: '0-5' } as const
export function hubspotRecordLinkBase(portalId: number | null, uiDomain: string | null): string | null {
  if (portalId == null) return null
  const host = uiDomain && /^[a-z0-9.-]+\.hubspot\.com$/i.test(uiDomain) ? uiDomain : 'app.hubspot.com'
  return `https://${host}/contacts/${portalId}/record`
}
