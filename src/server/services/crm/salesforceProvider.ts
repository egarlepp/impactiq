import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users } from '../../../../drizzle/schema.js'
import { getSfConnection } from '../salesforce/client.js'
import { loadSeFilterFieldApis, resolveSeFilterFields } from '../salesforce/seFilter.js'
import { searchOpportunities, searchAccounts, searchContacts, searchLeads, searchCampaigns } from '../salesforce/search.js'
import { readLive, SF_ID_RX } from '../salesforce/preview.js'
import { kickSync } from '../salesforce/writeback.js'
import { kickNotePush } from '../salesforce/notesPush.js'
import { refreshOppSnapshots } from '../salesforce/refreshOppSnapshots.js'
import { findSuggestionsForEmails } from '../salesforce/contacts.js'
import type { CrmProvider, CrmUserSession } from './types.js'

// Salesforce behind the CrmProvider interface. A thin adapter: every method
// calls the same service function the routes called before phase 1b, with
// the same arguments, so Salesforce behavior is unchanged.
export const salesforceProvider: CrmProvider = {
  id: 'salesforce',

  isRecordId: (id) => SF_ID_RX.test(id),

  async connectForUser(userId: string): Promise<CrmUserSession | null> {
    const conn = await getSfConnection(userId)
    if (!conn) return null
    return {
      async searchOpportunities(query, { openSearch, showClosed, teamId }) {
        // The default (non-open) search matches the Opportunity owner plus
        // the team's mapped SE filter fields (v1.474.0). Without a team, the
        // user's default team's mappings.
        const [row] = await db.select({ crmUserId: users.crmUserId, name: users.displayName, defaultTeamId: users.defaultTeamId })
          .from(users).where(eq(users.id, userId)).limit(1)
        const seFields = openSearch ? [] : await resolveSeFilterFields(conn, await loadSeFilterFieldApis(teamId ?? row?.defaultTeamId ?? null))
        return searchOpportunities(conn, query, { crmUserId: row?.crmUserId ?? null, userName: row?.name ?? null, seFields }, openSearch, showClosed)
      },
      searchAccounts: (query) => searchAccounts(conn, query),
      searchContacts: (query) => searchContacts(conn, query),
      searchLeads: (query) => searchLeads(conn, query),
      searchCampaigns: (query, attendeeEmails) => searchCampaigns(conn, query, attendeeEmails),
      readPreview: (id, type) => readLive(conn, id, type),
      suggestFromAttendees: (emails) => findSuggestionsForEmails(conn, emails),
    }
  },

  queueActivitySync(activityId: string): void {
    kickSync(activityId)
  },

  queueNotePush(pushId: string): void {
    kickNotePush(pushId)
  },

  refreshSnapshots(opts) {
    return refreshOppSnapshots(opts)
  },
}
