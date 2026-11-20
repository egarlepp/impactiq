import { getHubspotConfig } from '../hubspot/config.js'
import { getHubspotOwnerIdForUser } from '../hubspot/owners.js'
import { searchHubspotDeals, searchHubspotCompanies, searchHubspotContacts, searchHubspotLeads, searchHubspotCampaigns } from '../hubspot/search.js'
import { readHubspotPreview } from '../hubspot/preview.js'
import { findHubspotSuggestionsForEmails } from '../hubspot/attendees.js'
import { kickHubspotSync } from '../hubspot/writeback.js'
import { kickHubspotNotePush } from '../hubspot/notesPush.js'
import { refreshHubspotSnapshots } from '../hubspot/refreshSnapshots.js'
import { HUBSPOT_ID_RX, type HubspotCapabilityKey } from '../../../shared/hubspot.js'
import { HubspotError } from '../hubspot/client.js'
import type { CrmProvider, CrmUserSession } from './types.js'

// HubSpot behind the CrmProvider interface (HubSpot plan, phase 2b). One
// portal-wide connection (Admin → Integrations → HubSpot), so every signed-in
// user gets a session once it's saved. Who someone is in HubSpot comes from
// owner matching by email; it drives the default "my deals" search and the
// owner on written meetings.

// Optional features follow the last access check: a capability it found
// missing (Leads without Sales Hub Pro, Campaigns without Marketing Hub)
// returns nothing instead of a HubSpot error. Before any check has run, the
// call is tried and a 403 reads as "not available".
async function optional<T>(key: HubspotCapabilityKey, run: () => Promise<T[]>): Promise<T[]> {
  const cfg = await getHubspotConfig()
  const status = cfg?.lastCheck?.capabilities.find((c) => c.key === key)?.status
  if (status === 'missing') return []
  try {
    return await run()
  } catch (err) {
    if (err instanceof HubspotError && (err.code === 'errors.hubspot.forbidden' || err.status === 404)) return []
    throw err
  }
}

export const hubspotProvider: CrmProvider = {
  id: 'hubspot',

  isRecordId: (id) => HUBSPOT_ID_RX.test(id),

  async connectForUser(userId: string): Promise<CrmUserSession | null> {
    if (!(await getHubspotConfig())) return null
    // v1.424.0 (security audit M4): the portal key reaches every record, so
    // ImpactIQ is the only gate. No session without a match to an active
    // HubSpot user, the way a Salesforce session needs the user's own login.
    if (!(await getHubspotOwnerIdForUser(userId))) return null
    return {
      async searchOpportunities(query, { openSearch, showClosed, teamId }) {
        const ownerId = openSearch ? null : await getHubspotOwnerIdForUser(userId)
        return searchHubspotDeals(query, { openSearch, showClosed, ownerId, teamId: teamId ?? null })
      },
      searchAccounts: (query) => searchHubspotCompanies(query),
      searchContacts: (query) => searchHubspotContacts(query),
      searchLeads: (query) => optional('leads_read', () => searchHubspotLeads(query)),
      searchCampaigns: (query) => optional('campaigns_read', () => searchHubspotCampaigns(query)),
      readPreview: (id, type) => readHubspotPreview(id, type),
      suggestFromAttendees: (emails) => findHubspotSuggestionsForEmails(emails),
    }
  },

  queueActivitySync(activityId: string): void {
    kickHubspotSync(activityId)
  },

  // Phase 4: a note on the Deal or Company.
  queueNotePush(pushId: string): void {
    kickHubspotNotePush(pushId)
  },

  // Nightly Deal snapshot refresh (phase 3); the dashboard's Refresh button
  // runs the same refresh on demand.
  refreshSnapshots: (opts) => refreshHubspotSnapshots(opts),
}
