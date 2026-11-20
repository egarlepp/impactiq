import type { CrmAccount, CrmCampaign, CrmContact, CrmLead, CrmOpportunity } from '../crm/types.js'
import { HUBSPOT_SE_FILTER_APP_FIELD } from '../../../shared/hubspot.js'
import { HubspotError, hubspotJson } from './client.js'
import { getDealStagesSafe, getObjectPropertiesSafe, optionLabel, ownerNames, type PropertyInfo } from './metadata.js'
import { loadHubspotMappings, mappedProperties } from './mappings.js'

// Deal / Company / Contact / Lead / Campaign search for the CRM provider
// (HubSpot plan, phase 2b). Results come back in ImpactIQ's canonical shapes
// (Opportunity, Account, ...) with the Salesforce-era field names the client
// already reads, so the search UI works unchanged:
//   Deal → Opportunity, Company → Account, Contact → Contact,
//   Lead → Lead, Campaign → Campaign.
//
// Free text uses HubSpot's `query` (matches each object's default searchable
// properties by word prefix), so no property names are assumed beyond
// HubSpot's own standard ones, which exist on every portal.

const LIMIT = 20

export interface HubspotObject {
  id: string
  properties: Record<string, string | null | undefined>
  url?: string
}

interface SearchBody {
  query?: string
  limit: number
  properties: string[]
  filterGroups?: Array<{ filters: Array<{ propertyName: string; operator: string; value?: string; values?: string[] }> }>
  sorts?: Array<{ propertyName: string; direction: 'ASCENDING' | 'DESCENDING' }>
}

export async function hubspotSearch(objectType: string, body: SearchBody): Promise<HubspotObject[]> {
  const res = await hubspotJson<{ results?: HubspotObject[] }>(`/crm/v3/objects/${objectType}/search`, { method: 'POST', body, search: true })
  return Array.isArray(res.results) ? res.results : []
}

function p(o: HubspotObject, name: string): string | null {
  const v = o.properties?.[name]
  return v == null || v === '' ? null : String(v)
}

function numOrNull(v: string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// HubSpot date properties come back as ISO timestamps; ImpactIQ shows dates.
function dateOnly(v: string | null): string {
  return v ? v.slice(0, 10) : ''
}

// ── Associations ─────────────────────────────────────────────────────────

interface AssocBatch {
  results?: Array<{ from?: { id?: unknown }; to?: Array<{ toObjectId?: unknown; associationTypes?: Array<{ label?: unknown }> }> }>
}

// One associated record per source record, preferring HubSpot's "Primary"
// association (a deal's primary company, a lead's primary contact).
export async function primaryAssociations(fromType: string, toType: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const res = await hubspotJson<AssocBatch>(`/crm/v4/associations/${fromType}/${toType}/batch/read`, {
    method: 'POST', body: { inputs: ids.map((id) => ({ id })) },
  })
  for (const r of res.results ?? []) {
    const from = r.from?.id != null ? String(r.from.id) : null
    const to = r.to ?? []
    if (!from || to.length === 0) continue
    const primary = to.find((t) => (t.associationTypes ?? []).some((a) => typeof a.label === 'string' && a.label.toLowerCase() === 'primary')) ?? to[0]
    if (primary?.toObjectId != null) out.set(from, String(primary.toObjectId))
  }
  return out
}

// Every associated record per source record (a contact's deals), in
// HubSpot's order. A source with none is simply absent from the map.
export async function associationsFor(fromType: string, toType: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 100) {
    const res = await hubspotJson<AssocBatch>(`/crm/v4/associations/${fromType}/${toType}/batch/read`, {
      method: 'POST', body: { inputs: unique.slice(i, i + 100).map((id) => ({ id })) },
    })
    for (const r of res.results ?? []) {
      const from = r.from?.id != null ? String(r.from.id) : null
      if (!from) continue
      const to = (r.to ?? []).map((t) => (t.toObjectId != null ? String(t.toObjectId) : null)).filter((v): v is string => !!v)
      if (to.length > 0) out.set(from, [...new Set([...(out.get(from) ?? []), ...to])])
    }
  }
  return out
}

export async function batchRead(objectType: string, ids: string[], properties: string[]): Promise<Map<string, HubspotObject>> {
  const out = new Map<string, HubspotObject>()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 100) {
    const res = await hubspotJson<{ results?: HubspotObject[] }>(`/crm/v3/objects/${objectType}/batch/read`, {
      method: 'POST', body: { inputs: unique.slice(i, i + 100).map((id) => ({ id })), properties },
    })
    for (const o of res.results ?? []) out.set(String(o.id), o)
  }
  return out
}

// Associations are extras on a search result: failing to read them leaves
// the Account column blank instead of failing the whole search.
async function companyNamesFor(fromType: string, ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>()
  try {
    const assoc = await primaryAssociations(fromType, 'companies', ids)
    const companies = await batchRead('companies', [...assoc.values()], ['name'])
    for (const [from, companyId] of assoc) {
      out.set(from, { id: companyId, name: p(companies.get(companyId) ?? { id: companyId, properties: {} }, 'name') ?? '' })
    }
  } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
  }
  return out
}

// ── Deals ────────────────────────────────────────────────────────────────

export const DEAL_PROPERTIES = ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'hubspot_owner_id', 'hs_manual_forecast_category', 'hs_is_closed']

export interface DealSearchOptions {
  openSearch: boolean
  showClosed: boolean
  // The searching user's HubSpot owner id (matched by email), or null.
  ownerId: string | null
  teamId: string | null
}

// Filter groups for the default ("my deals") search: the user owns the deal,
// or holds any mapped SE property. HubSpot ORs filter groups (max 5) and ANDs
// the filters inside one.
export function buildDealFilterGroups(
  ownerId: string,
  seProperties: string[],
  props: Map<string, PropertyInfo>,
  showClosed: boolean,
): NonNullable<SearchBody['filterGroups']> {
  const closed = showClosed ? [] : [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }]
  const ownerProps = ['hubspot_owner_id', ...seProperties.filter((s) => s !== 'hubspot_owner_id')].slice(0, 5)
  return ownerProps.map((prop) => {
    // A multiple-checkbox owner property stores "id1;id2"; EQ would only
    // match a deal with exactly one SE, so match the token instead.
    const multi = props.get(prop)?.fieldType === 'checkbox'
    return { filters: [{ propertyName: prop, operator: multi ? 'CONTAINS_TOKEN' : 'EQ', value: ownerId }, ...closed] }
  })
}

export async function searchHubspotDeals(query: string, opts: DealSearchOptions): Promise<CrmOpportunity[]> {
  let filterGroups: SearchBody['filterGroups']
  if (!opts.openSearch) {
    // Not matched to a HubSpot owner: there are no "my deals" to show; the
    // Open Search toggle still searches every deal.
    if (!opts.ownerId) return []
    const mappings = await loadHubspotMappings(opts.teamId, ['deals'])
    const seProps = mappedProperties(mappings, 'deals', HUBSPOT_SE_FILTER_APP_FIELD)
    const props = seProps.length > 0 ? await getObjectPropertiesSafe('deals') : new Map<string, PropertyInfo>()
    filterGroups = buildDealFilterGroups(opts.ownerId, seProps, props, opts.showClosed)
  } else if (!opts.showClosed) {
    filterGroups = [{ filters: [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] }]
  }
  const deals = await hubspotSearch('deals', {
    query,
    limit: LIMIT,
    properties: DEAL_PROPERTIES,
    ...(filterGroups ? { filterGroups } : {}),
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
  })
  return toOpportunities(deals)
}

export async function toOpportunities(deals: HubspotObject[]): Promise<CrmOpportunity[]> {
  if (deals.length === 0) return []
  const ids = deals.map((d) => String(d.id))
  const [stages, companies, owners, props] = await Promise.all([
    getDealStagesSafe(),
    companyNamesFor('deals', ids),
    ownerNames(deals.map((d) => p(d, 'hubspot_owner_id'))),
    getObjectPropertiesSafe('deals'),
  ])
  return deals.map((d) => {
    const id = String(d.id)
    const stageId = p(d, 'dealstage')
    const company = companies.get(id)
    const ownerId = p(d, 'hubspot_owner_id')
    return {
      Id: id,
      Name: p(d, 'dealname') ?? '',
      StageName: stageId ? (stages.get(stageId)?.label ?? stageId) : '',
      AccountId: company?.id ?? null,
      AccountName: company?.name ?? '',
      CloseDate: dateOnly(p(d, 'closedate')),
      Amount: numOrNull(p(d, 'amount')),
      ForecastCategoryName: optionLabel(props, 'hs_manual_forecast_category', p(d, 'hs_manual_forecast_category')),
      OwnerName: ownerId ? (owners.get(ownerId) ?? null) : null,
    }
  })
}

// ── Companies, Contacts ──────────────────────────────────────────────────

export async function searchHubspotCompanies(query: string): Promise<CrmAccount[]> {
  const companies = await hubspotSearch('companies', {
    query, limit: LIMIT, properties: ['name', 'industry', 'hubspot_owner_id'],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
  })
  if (companies.length === 0) return []
  const [owners, props] = await Promise.all([
    ownerNames(companies.map((c) => p(c, 'hubspot_owner_id'))),
    getObjectPropertiesSafe('companies'),
  ])
  return companies.map((c) => {
    const ownerId = p(c, 'hubspot_owner_id')
    return {
      Id: String(c.id),
      Name: p(c, 'name') ?? '',
      Industry: optionLabel(props, 'industry', p(c, 'industry')),
      OwnerName: ownerId ? (owners.get(ownerId) ?? null) : null,
    }
  })
}

export function contactName(c: HubspotObject): string {
  const name = [p(c, 'firstname'), p(c, 'lastname')].filter(Boolean).join(' ').trim()
  return name || p(c, 'email') || String(c.id)
}

export async function searchHubspotContacts(query: string): Promise<CrmContact[]> {
  const contacts = await hubspotSearch('contacts', {
    query, limit: LIMIT, properties: ['firstname', 'lastname', 'email', 'jobtitle', 'company'],
    sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
  })
  return contacts.map((c) => ({
    Id: String(c.id),
    Name: contactName(c),
    Email: p(c, 'email'),
    AccountName: p(c, 'company'),
    Title: p(c, 'jobtitle'),
  }))
}

// ── Leads (Sales Hub Professional+) ──────────────────────────────────────
// Built from HubSpot's Leads API documentation; not yet checked against a
// portal that has Leads. A lead carries its primary contact and company as
// associations, which supply the Email and Company columns.

export async function searchHubspotLeads(query: string): Promise<CrmLead[]> {
  const leads = await hubspotSearch('leads', {
    query, limit: LIMIT, properties: ['hs_lead_name', 'hs_pipeline_stage'],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
  })
  if (leads.length === 0) return []
  const ids = leads.map((l) => String(l.id))
  let contacts = new Map<string, HubspotObject>()
  let contactFor = new Map<string, string>()
  try {
    contactFor = await primaryAssociations('leads', 'contacts', ids)
    contacts = await batchRead('contacts', [...contactFor.values()], ['firstname', 'lastname', 'email'])
  } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
  }
  const [companies, props] = await Promise.all([companyNamesFor('leads', ids), getObjectPropertiesSafe('leads')])
  return leads.map((l) => {
    const id = String(l.id)
    const contactId = contactFor.get(id)
    const contact = contactId ? contacts.get(contactId) : undefined
    return {
      Id: id,
      Name: p(l, 'hs_lead_name') ?? (contact ? contactName(contact) : id),
      Email: contact ? p(contact, 'email') : null,
      Company: companies.get(id)?.name || null,
      Status: optionLabel(props, 'hs_pipeline_stage', p(l, 'hs_pipeline_stage')),
    }
  })
}

// ── Campaigns (Marketing Hub) ────────────────────────────────────────────
// Built from HubSpot's Campaigns API (v3) documentation; not yet checked
// against a portal with Marketing Hub. HubSpot's campaign list filters by
// name; attendee-based suggestions (Salesforce's CampaignMember match) come
// in a later phase.

interface CampaignApi { id?: unknown; properties?: Record<string, unknown> }

export async function searchHubspotCampaigns(query: string): Promise<CrmCampaign[]> {
  if (query.length < 2) return []
  const res = await hubspotJson<{ results?: CampaignApi[] }>('/marketing/v3/campaigns', {
    query: { name: query, limit: LIMIT, properties: 'hs_name,hs_start_date,hs_end_date,hs_campaign_status' },
  })
  const today = new Date().toISOString().slice(0, 10)
  return (res.results ?? []).flatMap((c) => {
    if (c.id == null) return []
    const prop = (k: string) => {
      const v = c.properties?.[k]
      return typeof v === 'string' && v !== '' ? v : null
    }
    const end = prop('hs_end_date')
    return [{
      Id: String(c.id),
      Name: prop('hs_name') ?? String(c.id),
      Status: prop('hs_campaign_status'),
      Type: null,
      StartDate: prop('hs_start_date'),
      EndDate: end,
      CreatedByName: null,
      IsActive: !end || end.slice(0, 10) >= today,
    }]
  })
}
