import type { SuggestedAccount, SuggestedOpportunity } from '../salesforce/contacts.js'
import { HubspotError } from './client.js'
import { getDealStagesSafe, ownerNames } from './metadata.js'
import { associationsFor, batchRead, contactName, DEAL_PROPERTIES, hubspotSearch, primaryAssociations, toOpportunities, type HubspotObject } from './search.js'

// Attendee matching on HubSpot (HubSpot plan, phase 7b): the counterpart of
// Salesforce's findSuggestionsForEmails (services/salesforce/contacts.ts),
// returning the same shapes so the "Suggested from attendees" picker, the
// attendee quick-picks and the suggested-meeting card work unchanged.
//
//   Contact by email → its primary Company (the Account suggestion)
//                    → its associated open Deals (the Opportunity suggestion)
//
// Salesforce finds Opportunities through OpportunityContactRole; HubSpot's
// equivalent is a contact ↔ deal association. Matching is on the contact's
// primary `email` only: the search API's IN filter is exact and
// case-sensitive, and HubSpot stores that property lowercased, so emails are
// lowercased first. Secondary addresses (hs_additional_emails) aren't matched.

const EMAIL_CHUNK = 100   // values allowed in one IN filter
const MAX_CONTACTS = 200  // same ceiling as the Salesforce query's LIMIT 200

export interface AttendeeSuggestions {
  accounts: SuggestedAccount[]
  opportunities: SuggestedOpportunity[]
}

function p(o: HubspotObject | undefined, name: string): string | null {
  const v = o?.properties?.[name]
  return v == null || v === '' ? null : String(v)
}

async function contactsByEmail(emails: string[]): Promise<HubspotObject[]> {
  const out: HubspotObject[] = []
  for (let i = 0; i < emails.length && out.length < MAX_CONTACTS; i += EMAIL_CHUNK) {
    const found = await hubspotSearch('contacts', {
      limit: EMAIL_CHUNK,
      properties: ['email', 'firstname', 'lastname'],
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: emails.slice(i, i + EMAIL_CHUNK) }] }],
    })
    out.push(...found)
  }
  return out.slice(0, MAX_CONTACTS)
}

// A Company or Deal lookup failing leaves that half empty instead of failing
// the whole suggestion; a bad token still surfaces.
async function softly<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
    console.warn('[hubspot] attendee suggestion lookup failed:', err instanceof HubspotError ? err.code : err)
    return fallback
  }
}

export async function findHubspotSuggestionsForEmails(rawEmails: string[]): Promise<AttendeeSuggestions> {
  const emails = [...new Set(rawEmails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))]
  if (emails.length === 0) return { accounts: [], opportunities: [] }

  const contacts = (await contactsByEmail(emails)).map((c) => ({
    id: String(c.id), name: contactName(c), email: (p(c, 'email') ?? '').toLowerCase(),
  }))
  if (contacts.length === 0) return { accounts: [], opportunities: [] }
  const contactIds = contacts.map((c) => c.id)

  const [accounts, opportunities] = await Promise.all([
    softly(() => accountSuggestions(contacts, contactIds), [] as SuggestedAccount[]),
    softly(() => opportunitySuggestions(contacts, contactIds), [] as SuggestedOpportunity[]),
  ])
  return { accounts, opportunities }
}

type MatchedContact = { id: string; name: string; email: string }

async function accountSuggestions(contacts: MatchedContact[], contactIds: string[]): Promise<SuggestedAccount[]> {
  const primary = await primaryAssociations('contacts', 'companies', contactIds)
  if (primary.size === 0) return []
  const companies = await batchRead('companies', [...primary.values()], ['name', 'hubspot_owner_id'])
  const owners = await ownerNames([...companies.values()].map((c) => p(c, 'hubspot_owner_id')))
  const out: SuggestedAccount[] = []
  const seen = new Set<string>()
  for (const c of contacts) {
    const companyId = primary.get(c.id)
    if (!companyId || seen.has(companyId)) continue
    const company = companies.get(companyId)
    const name = p(company, 'name')
    if (!name) continue
    seen.add(companyId)
    const ownerId = p(company, 'hubspot_owner_id')
    out.push({ Id: companyId, Name: name, OwnerName: ownerId ? (owners.get(ownerId) ?? null) : null, contactName: c.name, contactEmail: c.email })
  }
  return out
}

async function opportunitySuggestions(contacts: MatchedContact[], contactIds: string[]): Promise<SuggestedOpportunity[]> {
  const byContact = await associationsFor('contacts', 'deals', contactIds)
  if (byContact.size === 0) return []
  const dealIds = [...new Set([...byContact.values()].flat())]
  const deals = await batchRead('deals', dealIds, DEAL_PROPERTIES)
  // Open deals only, like the Salesforce query's IsClosed = false. A portal
  // that leaves hs_is_closed empty falls back to the stage's own metadata.
  const stages = await getDealStagesSafe()
  const open = [...deals.values()].filter((d) => {
    const flag = p(d, 'hs_is_closed')
    if (flag != null) return flag !== 'true'
    const stage = p(d, 'dealstage')
    return !(stage && stages.get(stage)?.isClosed)
  })
  const mapped = new Map((await toOpportunities(open)).map((o) => [o.Id, o] as const))
  const out: SuggestedOpportunity[] = []
  const seen = new Set<string>()
  for (const c of contacts) {
    for (const dealId of byContact.get(c.id) ?? []) {
      const o = mapped.get(dealId)
      if (!o || seen.has(dealId)) continue
      seen.add(dealId)
      out.push({
        Id: o.Id,
        Name: o.Name,
        AccountId: o.AccountId ?? null,
        AccountName: o.AccountName ?? '',
        StageName: o.StageName ?? '',
        Amount: o.Amount ?? null,
        CloseDate: o.CloseDate || null,
        ForecastCategoryName: o.ForecastCategoryName ?? null,
        OwnerName: o.OwnerName ?? null,
        contactName: c.name,
        contactEmail: c.email,
      })
    }
  }
  return out
}

// ── Contacts on the linked record ────────────────────────────────────────
// The Attendees section's "contacts on the linked record" search, the
// counterpart of GET /api/salesforce/accounts/:id/contacts: a Company's
// contacts (or, for a Deal, its primary Company's), newest first, narrowed
// by name or email. Salesforce matches Contact.AccountId; HubSpot's
// equivalent is the contact's primary company, `associatedcompanyid`.

export interface RecordContact { Id: string; Name: string; Email: string | null; Title: string | null; AccountName: string | null }

export async function listHubspotContactsOnRecord(id: string, kind: 'opportunity' | 'account', query: string): Promise<RecordContact[]> {
  let companyId = id
  if (kind === 'opportunity') {
    const primary = await primaryAssociations('deals', 'companies', [id])
    const linked = primary.get(id)
    if (!linked) return []
    companyId = linked
  }
  const q = query.trim()
  const [contacts, companies] = await Promise.all([
    hubspotSearch('contacts', {
      ...(q ? { query: q } : {}),
      limit: 20,
      properties: ['firstname', 'lastname', 'email', 'jobtitle'],
      filterGroups: [{ filters: [{ propertyName: 'associatedcompanyid', operator: 'EQ', value: companyId }] }],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
    }),
    softly(() => batchRead('companies', [companyId], ['name']), new Map<string, HubspotObject>()),
  ])
  const accountName = p(companies.get(companyId), 'name')
  return contacts.map((c) => ({ Id: String(c.id), Name: contactName(c), Email: p(c, 'email'), Title: p(c, 'jobtitle'), AccountName: accountName }))
}
