import type { CrmPreview, CrmPreviewType } from '../crm/types.js'
import { HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import { hubspotRequest } from './client.js'
import { getDealStagesSafe, getObjectPropertiesSafe, optionLabel, ownerNames, resolveOwnerValue } from './metadata.js'
import { loadHubspotMappings, mappedProperty } from './mappings.js'
import { primaryAssociations, batchRead } from './search.js'

// Live read for the hover preview on a Deal / Company link (phase 2b). Same
// contract as Salesforce's readLive(): null on any failure, so the route
// falls back to the local snapshot on `activities`.
//
// Standard HubSpot properties are read by name. Everything a portal names
// itself (ACV, Assigned SE, Primary Engineer, the Total Bookings breakdown)
// comes from the deal field mappings (crm_object 'deals') under the same app
// field names Salesforce uses, and stays blank until an admin maps it.

const DEAL_CORE = ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id', 'hs_manual_forecast_category', 'hs_is_closed', 'hs_is_closed_won']
const COMPANY_CORE = ['name', 'industry', 'type', 'domain', 'website', 'city', 'country', 'hubspot_owner_id']

const DEAL_MAPPED_FIELDS = ['acv', 'assigned_se_name', 'primary_engineer_name', 'opp_new_business_acv', 'opp_new_business_tcv', 'opp_renewal_acv', 'opp_renewal_tcv'] as const

function emptyPreview(id: string, type: CrmPreviewType): CrmPreview {
  return {
    id, type, name: null,
    accountId: null, accountName: null, stageName: null, forecastCategory: null,
    amount: null, acv: null, closeDate: null, isClosed: null, isWon: null,
    ownerName: null, assignedSeName: null, primaryEngineerName: null,
    newBusinessAcv: null, newBusinessTcv: null, renewalAcv: null, renewalTcv: null,
    industry: null, accountType: null, website: null, city: null, country: null,
    source: 'live', asOf: null,
  }
}

function num(v: string | null): string | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : null
}

async function readObject(objectType: string, id: string, properties: string[]): Promise<Record<string, string | null> | null> {
  const { status, body } = await hubspotRequest(`/crm/v3/objects/${objectType}/${id}`, { query: { properties: properties.join(',') } })
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') return null
  const raw = (body as { properties?: Record<string, unknown> }).properties ?? {}
  const out: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = v == null || v === '' ? null : String(v)
  return out
}

export async function readHubspotPreview(id: string, type: CrmPreviewType): Promise<CrmPreview | null> {
  if (!HUBSPOT_ID_RX.test(id)) return null
  try {
    return type === 'Account' ? await readCompany(id) : await readDeal(id)
  } catch {
    return null
  }
}

async function readCompany(id: string): Promise<CrmPreview | null> {
  const rec = await readObject('companies', id, COMPANY_CORE)
  if (!rec) return null
  const props = await getObjectPropertiesSafe('companies')
  const out = emptyPreview(id, 'Account')
  out.name = rec['name'] ?? null
  out.accountId = id
  out.accountName = out.name
  out.industry = optionLabel(props, 'industry', rec['industry'] ?? null)
  out.accountType = optionLabel(props, 'type', rec['type'] ?? null)
  out.website = rec['website'] ?? rec['domain'] ?? null
  out.city = rec['city'] ?? null
  out.country = rec['country'] ?? null
  const ownerId = rec['hubspot_owner_id'] ?? null
  if (ownerId) out.ownerName = (await ownerNames([ownerId])).get(ownerId) ?? null
  return out
}

async function readDeal(id: string): Promise<CrmPreview | null> {
  const mappings = await loadHubspotMappings(null, ['deals'])
  const mapped = new Map<string, string>()
  for (const f of DEAL_MAPPED_FIELDS) {
    const prop = mappedProperty(mappings, 'deals', f)
    if (prop) mapped.set(f, prop)
  }
  const rec = await readObject('deals', id, [...new Set([...DEAL_CORE, ...mapped.values()])])
  if (!rec) return null
  const [stages, props, companyAssoc] = await Promise.all([
    getDealStagesSafe(),
    getObjectPropertiesSafe('deals'),
    primaryAssociations('deals', 'companies', [id]).catch(() => new Map<string, string>()),
  ])
  const out = emptyPreview(id, 'Opportunity')
  out.name = rec['dealname'] ?? null
  const stageId = rec['dealstage'] ?? null
  const stage = stageId ? stages.get(stageId) : undefined
  out.stageName = stage?.label ?? stageId
  out.forecastCategory = optionLabel(props, 'hs_manual_forecast_category', rec['hs_manual_forecast_category'] ?? null)
  out.amount = num(rec['amount'] ?? null)
  out.closeDate = rec['closedate'] ? rec['closedate'].slice(0, 10) : null
  // hs_is_closed / hs_is_closed_won are HubSpot's own calculated flags; the
  // stage metadata is the fallback on a portal that hides them.
  out.isClosed = rec['hs_is_closed'] != null ? rec['hs_is_closed'] === 'true' : (stage?.isClosed ?? null)
  out.isWon = rec['hs_is_closed_won'] != null ? rec['hs_is_closed_won'] === 'true' : (stage?.isWon ?? null)
  const ownerId = rec['hubspot_owner_id'] ?? null
  if (ownerId) out.ownerName = (await ownerNames([ownerId])).get(ownerId) ?? null
  const value = (f: string) => {
    const prop = mapped.get(f)
    return prop ? (rec[prop] ?? null) : null
  }
  out.acv = num(value('acv'))
  // An SE property is usually a "HubSpot user" property holding owner ids.
  out.assignedSeName = await resolveOwnerValue(optionLabelIfNotOwner(props, mapped.get('assigned_se_name'), value('assigned_se_name')))
  out.primaryEngineerName = await resolveOwnerValue(optionLabelIfNotOwner(props, mapped.get('primary_engineer_name'), value('primary_engineer_name')))
  out.newBusinessAcv = num(value('opp_new_business_acv'))
  out.newBusinessTcv = num(value('opp_new_business_tcv'))
  out.renewalAcv = num(value('opp_renewal_acv'))
  out.renewalTcv = num(value('opp_renewal_tcv'))
  const companyId = companyAssoc.get(id)
  if (companyId) {
    out.accountId = companyId
    const companies = await batchRead('companies', [companyId], ['name']).catch(() => new Map())
    out.accountName = companies.get(companyId)?.properties?.['name'] ?? null
  }
  return out
}

// "HubSpot user" properties carry owner ids and resolve through the owner
// list; any other enumeration shows its option label.
function optionLabelIfNotOwner(props: Awaited<ReturnType<typeof getObjectPropertiesSafe>>, prop: string | undefined, value: string | null): string | null {
  if (!prop || value == null) return value
  const info = props.get(prop)
  if (info && info.options.size > 0) return optionLabel(props, prop, value)
  return value
}
