import type jsforce from 'jsforce'
import { safeSoqlLiteral } from './soql.js'
import { buildSeFilterCondition, type SeFilterField } from './seFilter.js'

export interface SfOpportunity {
  Id: string
  Name: string
  StageName: string
  AccountId: string | null
  AccountName: string
  CloseDate: string
  Amount: number | null
  ForecastCategoryName: string | null
  OwnerName: string | null
}

export interface SfAccount {
  Id: string
  Name: string
  Industry: string | null
  OwnerName: string | null
}

// v1.474.0: the default (non-open) search matches the Opportunity owner plus
// the team's mapped SE filter fields (CRM Field Mappings → opp_se_filter),
// never a hardcoded custom field: see services/salesforce/seFilter.ts.
export async function searchOpportunities(
  conn: jsforce.Connection,
  query: string,
  me: { crmUserId: string | null; userName: string | null; seFields: readonly SeFilterField[] },
  openSearch: boolean,
  showClosed = false,
): Promise<SfOpportunity[]> {
  const safeQuery = safeSoqlLiteral(query)
  // v1.270.0: closed Opportunities are hidden by default — a contributor
  // logging routine activity almost never means a closed deal, and closed
  // Opps used to dominate results with no way to reach them at all. The
  // "Show Closed" checkbox opts in per search; unchecked (the default)
  // keeps the original IsClosed = false behavior.
  const closedCond = showClosed ? '' : 'AND IsClosed = false\n            '

  let soql: string
  if (openSearch) {
    soql = `SELECT Id, Name, StageName, AccountId, Account.Name, CloseDate, Amount, ForecastCategoryName, Owner.Name
            FROM Opportunity
            WHERE Name LIKE '%${safeQuery}%'
            ${closedCond}ORDER BY LastModifiedDate DESC
            LIMIT 20`
  } else {
    const mine = buildSeFilterCondition(me.crmUserId, me.userName, me.seFields)
    if (!mine) return []
    soql = `SELECT Id, Name, StageName, AccountId, Account.Name, CloseDate, Amount, ForecastCategoryName, Owner.Name
            FROM Opportunity
            WHERE ${mine}
            AND Name LIKE '%${safeQuery}%'
            ${closedCond}ORDER BY LastModifiedDate DESC
            LIMIT 20`
  }

  const result = await conn.query<Record<string, unknown>>(soql)
  return (result.records ?? []).map((r) => ({
    Id: String(r['Id'] ?? ''),
    Name: String(r['Name'] ?? ''),
    StageName: String(r['StageName'] ?? ''),
    AccountId: r['AccountId'] != null ? String(r['AccountId']) : null,
    AccountName: String((r['Account'] as Record<string, unknown> | null)?.['Name'] ?? ''),
    CloseDate: String(r['CloseDate'] ?? ''),
    Amount: r['Amount'] != null ? Number(r['Amount']) : null,
    ForecastCategoryName: r['ForecastCategoryName'] != null ? String(r['ForecastCategoryName']) : null,
    OwnerName: (r['Owner'] as Record<string, unknown> | null)?.['Name'] != null ? String((r['Owner'] as Record<string, unknown>)['Name']) : null,
  }))
}

export async function searchAccounts(
  conn: jsforce.Connection,
  query: string,
): Promise<SfAccount[]> {
  const safeQuery = safeSoqlLiteral(query)
  const soql = `SELECT Id, Name, Industry, Owner.Name
                FROM Account
                WHERE Name LIKE '%${safeQuery}%'
                ORDER BY LastModifiedDate DESC
                LIMIT 20`
  const result = await conn.query<Record<string, unknown>>(soql)
  return (result.records ?? []).map((r) => ({
    Id: String(r['Id'] ?? ''),
    Name: String(r['Name'] ?? ''),
    Industry: r['Industry'] != null ? String(r['Industry']) : null,
    OwnerName: (r['Owner'] as Record<string, unknown> | null)?.['Name'] != null ? String((r['Owner'] as Record<string, unknown>)['Name']) : null,
  }))
}

export interface SfContact {
  Id: string
  Name: string
  Email: string | null
  AccountName: string | null
  Title: string | null
}

export interface SfLead {
  Id: string
  Name: string
  Email: string | null
  Company: string | null
  Status: string | null
}

export async function searchContacts(conn: jsforce.Connection, query: string): Promise<SfContact[]> {
  const safeQuery = safeSoqlLiteral(query)
  // Match against Name and Email so users can search either. Filter out
  // deleted rows with IsDeleted = false (default; kept explicit for clarity).
  const soql = `SELECT Id, Name, Email, Title, Account.Name
                FROM Contact
                WHERE (Name LIKE '%${safeQuery}%' OR Email LIKE '%${safeQuery}%')
                ORDER BY LastModifiedDate DESC
                LIMIT 20`
  const result = await conn.query<Record<string, unknown>>(soql)
  return (result.records ?? []).map((r) => ({
    Id: String(r['Id'] ?? ''),
    Name: String(r['Name'] ?? ''),
    Email: r['Email'] != null ? String(r['Email']) : null,
    AccountName: (r['Account'] as Record<string, unknown> | null)?.['Name'] != null ? String((r['Account'] as Record<string, unknown>)['Name']) : null,
    Title: r['Title'] != null ? String(r['Title']) : null,
  }))
}

export interface SfCampaign {
  Id: string
  Name: string
  Status: string | null
  Type: string | null
  StartDate: string | null
  EndDate: string | null
  CreatedByName: string | null
  IsActive: boolean
  attendeeMatchCount?: number
}

// Campaign search. Combines two signals:
//   1) Name / Type LIKE the free-text query.
//   2) Campaigns those attendee emails belong to (via CampaignMember →
//      Contact/Lead by Email). Attendee-linked campaigns are surfaced with
//      `attendeeMatchCount` so the UI can flag them.
export async function searchCampaigns(
  conn: jsforce.Connection,
  query: string,
  attendeeEmails: string[],
): Promise<SfCampaign[]> {
  const found = new Map<string, SfCampaign>()

  // Text-based hits — permissive: match Name OR Type. Active first so common
  // in-flight campaigns rise to the top.
  if (query.length >= 2) {
    const safeQuery = safeSoqlLiteral(query)
    const soql = `SELECT Id, Name, Status, Type, StartDate, EndDate, CreatedBy.Name, IsActive
                  FROM Campaign
                  WHERE (Name LIKE '%${safeQuery}%' OR Type LIKE '%${safeQuery}%')
                  ORDER BY IsActive DESC, LastModifiedDate DESC
                  LIMIT 20`
    const result = await conn.query<Record<string, unknown>>(soql)
    for (const r of result.records) {
      const id = String(r['Id'] ?? '')
      if (!id) continue
      const createdBy = r['CreatedBy'] as { Name?: string } | null | undefined
      found.set(id, {
        Id: id,
        Name: String(r['Name'] ?? ''),
        Status: r['Status'] != null ? String(r['Status']) : null,
        Type: r['Type'] != null ? String(r['Type']) : null,
        StartDate: r['StartDate'] != null ? String(r['StartDate']) : null,
        EndDate: r['EndDate'] != null ? String(r['EndDate']) : null,
        CreatedByName: createdBy?.Name ?? null,
        IsActive: r['IsActive'] === true,
      })
    }
  }

  // Attendee-linked hits — for each email, find matching Contact/Lead IDs,
  // then find their CampaignMember rows and the associated Campaigns. Cheap
  // because attendees per meeting are typically <10 and we chain one SOQL.
  // Linear, unambiguous email shape: local@label(.label)+. The domain labels
  // exclude '.' so the `+` quantifiers can't overlap the literal dots — the
  // previous /^[^@\s]+@[^@\s]+\.[^@\s]+$/ let both sides match dots, giving
  // polynomial backtracking (ReDoS) on attendee-supplied strings. Length is
  // also capped at the RFC max as a belt-and-suspenders bound.
  const cleanEmails = attendeeEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length <= 254 && /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(e))
  if (cleanEmails.length > 0) {
    const escapedEmails = cleanEmails.slice(0, 25).map((e) => `'${safeSoqlLiteral(e)}'`).join(',')
    const memberSoql = `SELECT CampaignId, Campaign.Name, Campaign.Status, Campaign.Type, Campaign.StartDate, Campaign.EndDate, Campaign.CreatedBy.Name, Campaign.IsActive
                        FROM CampaignMember
                        WHERE (Contact.Email IN (${escapedEmails}) OR Lead.Email IN (${escapedEmails}))
                        LIMIT 100`
    try {
      const memberQ = await conn.query<{ CampaignId: string; Campaign: { Name: string; Status: string | null; Type: string | null; StartDate: string | null; EndDate: string | null; CreatedBy: { Name?: string } | null; IsActive: boolean } | null }>(memberSoql)
      for (const r of memberQ.records) {
        if (!r.CampaignId || !r.Campaign) continue
        const prior = found.get(r.CampaignId)
        if (prior) {
          prior.attendeeMatchCount = (prior.attendeeMatchCount ?? 0) + 1
        } else {
          found.set(r.CampaignId, {
            Id: r.CampaignId,
            Name: r.Campaign.Name,
            Status: r.Campaign.Status,
            Type: r.Campaign.Type,
            StartDate: r.Campaign.StartDate,
            EndDate: r.Campaign.EndDate,
            CreatedByName: r.Campaign.CreatedBy?.Name ?? null,
            IsActive: r.Campaign.IsActive === true,
            attendeeMatchCount: 1,
          })
        }
      }
    } catch {
      // CampaignMember reads require Campaign read access; ignore failures
      // gracefully and just return name-matched campaigns.
    }
  }

  // Attendee-linked first (any positive count wins), then active, then name.
  return Array.from(found.values()).sort((a, b) => {
    const am = a.attendeeMatchCount ?? 0
    const bm = b.attendeeMatchCount ?? 0
    if (bm !== am) return bm - am
    if (a.IsActive !== b.IsActive) return a.IsActive ? -1 : 1
    return a.Name.localeCompare(b.Name)
  })
}

export async function searchLeads(conn: jsforce.Connection, query: string): Promise<SfLead[]> {
  const safeQuery = safeSoqlLiteral(query)
  // IsConverted = false so converted Leads don't clutter the picker — once a
  // Lead is converted, its counterparts (Account / Contact / Opportunity) are
  // the meaningful links.
  const soql = `SELECT Id, Name, Email, Company, Status
                FROM Lead
                WHERE (Name LIKE '%${safeQuery}%' OR Email LIKE '%${safeQuery}%' OR Company LIKE '%${safeQuery}%')
                AND IsConverted = false
                ORDER BY LastModifiedDate DESC
                LIMIT 20`
  const result = await conn.query<Record<string, unknown>>(soql)
  return (result.records ?? []).map((r) => ({
    Id: String(r['Id'] ?? ''),
    Name: String(r['Name'] ?? ''),
    Email: r['Email'] != null ? String(r['Email']) : null,
    Company: r['Company'] != null ? String(r['Company']) : null,
    Status: r['Status'] != null ? String(r['Status']) : null,
  }))
}
