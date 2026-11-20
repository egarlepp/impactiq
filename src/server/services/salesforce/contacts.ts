import type jsforce from 'jsforce'
import { safeSoqlLiteral } from './soql.js'

export interface SuggestedAccount {
  Id: string
  Name: string
  OwnerName: string | null
  contactName: string
  contactEmail: string
}

export interface SuggestedOpportunity {
  Id: string
  Name: string
  AccountId: string | null
  AccountName: string
  StageName: string
  contactName: string
  contactEmail: string
  // v1.101.0: include Amount / CloseDate / ForecastCategoryName so the
  // Log Activity form seeds ACV + Opp Amount + snapshot fields when the
  // user picks the suggestion. Previously the "Suggested from
  // attendees" path returned only Id/Name/Stage and the ACV stayed 0.
  Amount: number | null
  CloseDate: string | null
  ForecastCategoryName: string | null
  OwnerName: string | null
}

// SOQL IN () can't be empty. Caller must gate.
function inList(values: string[]): string {
  return values.map((v) => `'${safeSoqlLiteral(v)}'`).join(',')
}

interface ContactRow { Id: string; Name: string; Email: string; AccountId: string | null }
interface OppContactRoleRow {
  ContactId: string
  Opportunity: {
    Id: string
    Name: string
    StageName: string
    AccountId: string | null
    Amount: number | null
    CloseDate: string | null
    ForecastCategoryName: string | null
    Account: { Name: string } | null
    Owner: { Name: string } | null
  } | null
}

// Given attendee emails, look up SF Contacts and return the Accounts +
// active Opportunities linked to those contacts.
export async function findSuggestionsForEmails(
  conn: jsforce.Connection,
  emails: string[],
): Promise<{ accounts: SuggestedAccount[]; opportunities: SuggestedOpportunity[] }> {
  if (emails.length === 0) return { accounts: [], opportunities: [] }

  const contactsSoql = `SELECT Id, Name, Email, AccountId
                        FROM Contact
                        WHERE Email IN (${inList(emails)})
                        LIMIT 200`
  const contactsRes = await conn.query<Record<string, unknown>>(contactsSoql)
  const contacts: ContactRow[] = (contactsRes.records ?? []).map((r) => ({
    Id: String(r['Id'] ?? ''),
    Name: String(r['Name'] ?? ''),
    Email: String(r['Email'] ?? ''),
    AccountId: r['AccountId'] ? String(r['AccountId']) : null,
  }))
  if (contacts.length === 0) return { accounts: [], opportunities: [] }

  const contactById = new Map(contacts.map((c) => [c.Id, c] as const))
  const accountIds = Array.from(new Set(contacts.map((c) => c.AccountId).filter((id): id is string => !!id)))

  // Accounts via Contact.AccountId
  let accounts: SuggestedAccount[] = []
  if (accountIds.length > 0) {
    const accSoql = `SELECT Id, Name, Owner.Name FROM Account WHERE Id IN (${inList(accountIds)}) LIMIT 200`
    const accRes = await conn.query<Record<string, unknown>>(accSoql)
    const nameById = new Map<string, string>()
    const ownerById = new Map<string, string | null>()
    for (const r of accRes.records ?? []) {
      nameById.set(String(r['Id']), String(r['Name']))
      const owner = r['Owner'] as { Name?: string } | null | undefined
      ownerById.set(String(r['Id']), owner?.Name ?? null)
    }
    // De-dupe: one row per Account, using the first matched contact for display.
    const seenAcct = new Set<string>()
    for (const c of contacts) {
      if (!c.AccountId || seenAcct.has(c.AccountId)) continue
      const name = nameById.get(c.AccountId)
      if (!name) continue
      seenAcct.add(c.AccountId)
      accounts.push({ Id: c.AccountId, Name: name, OwnerName: ownerById.get(c.AccountId) ?? null, contactName: c.Name, contactEmail: c.Email })
    }
  }

  // Opportunities via OpportunityContactRole
  const contactIds = contacts.map((c) => c.Id)
  const oppSoql = `SELECT ContactId, Opportunity.Id, Opportunity.Name, Opportunity.StageName, Opportunity.AccountId, Opportunity.Amount, Opportunity.CloseDate, Opportunity.ForecastCategoryName, Opportunity.Account.Name, Opportunity.Owner.Name
                   FROM OpportunityContactRole
                   WHERE ContactId IN (${inList(contactIds)})
                   AND Opportunity.IsClosed = false
                   LIMIT 200`
  const oppRes = await conn.query<Record<string, unknown>>(oppSoql)
  const opportunities: SuggestedOpportunity[] = []
  const seenOpp = new Set<string>()
  for (const raw of oppRes.records ?? []) {
    const r = raw as unknown as OppContactRoleRow
    const opp = r.Opportunity
    if (!opp?.Id || seenOpp.has(opp.Id)) continue
    const c = contactById.get(r.ContactId)
    if (!c) continue
    seenOpp.add(opp.Id)
    opportunities.push({
      Id: opp.Id,
      Name: opp.Name,
      AccountId: opp.AccountId ?? null,
      AccountName: opp.Account?.Name ?? '',
      StageName: opp.StageName ?? '',
      Amount: opp.Amount ?? null,
      CloseDate: opp.CloseDate ?? null,
      ForecastCategoryName: opp.ForecastCategoryName ?? null,
      OwnerName: opp.Owner?.Name ?? null,
      contactName: c.Name,
      contactEmail: c.Email,
    })
  }

  return { accounts, opportunities }
}
