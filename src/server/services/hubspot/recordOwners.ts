import { HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import { HubspotError } from './client.js'
import { batchRead, primaryAssociations } from './search.js'
import { ownerNames } from './metadata.js'

// Owner and Company for the Deals and Companies activities link to, read
// live from HubSpot. The Sales Team Breakdown dashboard groups activity by
// record owner; on Salesforce it reads the same thing with one SOQL query per
// object (phase 7b).

export interface HubspotRecordOwner {
  ownerId: string | null
  ownerName: string | null
  accountId: string
  accountName: string | null
  oppName?: string | null
}

function prop(o: { properties?: Record<string, unknown> } | undefined, name: string): string | null {
  const v = o?.properties?.[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

async function primaryCompanies(dealIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < dealIds.length; i += 100) {
    for (const [k, v] of await primaryAssociations('deals', 'companies', dealIds.slice(i, i + 100))) out.set(k, v)
  }
  return out
}

// A Deal with no Company is left out, the same as a Salesforce Opportunity
// with no Account. Ids that aren't HubSpot record ids are skipped, so a
// leftover Salesforce id is never sent to HubSpot.
export async function hubspotRecordOwners(dealIds: string[], companyIds: string[]): Promise<{
  deals: Map<string, HubspotRecordOwner>
  companies: Map<string, HubspotRecordOwner>
}> {
  const deals = new Map<string, HubspotRecordOwner>()
  const companies = new Map<string, HubspotRecordOwner>()
  const dIds = [...new Set(dealIds.filter((id) => HUBSPOT_ID_RX.test(id)))]
  const cIds = new Set(companyIds.filter((id) => HUBSPOT_ID_RX.test(id)))

  const dealRows = dIds.length > 0 ? await batchRead('deals', dIds, ['dealname', 'hubspot_owner_id']) : new Map()
  let dealCompany = new Map<string, string>()
  if (dealRows.size > 0) {
    try {
      dealCompany = await primaryCompanies([...dealRows.keys()])
    } catch (err) {
      if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
    }
  }
  const allCompanyIds = new Set([...cIds, ...dealCompany.values()])
  const companyRows = allCompanyIds.size > 0 ? await batchRead('companies', [...allCompanyIds], ['name', 'hubspot_owner_id']) : new Map()

  const owners = await ownerNames([
    ...[...dealRows.values()].map((d) => prop(d, 'hubspot_owner_id')),
    ...[...companyRows.values()].map((c) => prop(c, 'hubspot_owner_id')),
  ])

  for (const [id, d] of dealRows) {
    const companyId = dealCompany.get(id)
    if (!companyId) continue
    const ownerId = prop(d, 'hubspot_owner_id')
    deals.set(id, {
      ownerId,
      ownerName: ownerId ? owners.get(ownerId) ?? null : null,
      accountId: companyId,
      accountName: prop(companyRows.get(companyId), 'name'),
      oppName: prop(d, 'dealname'),
    })
  }
  for (const id of cIds) {
    const c = companyRows.get(id)
    if (!c) continue
    const ownerId = prop(c, 'hubspot_owner_id')
    companies.set(id, {
      ownerId,
      ownerName: ownerId ? owners.get(ownerId) ?? null : null,
      accountId: id,
      accountName: prop(c, 'name'),
    })
  }
  return { deals, companies }
}
