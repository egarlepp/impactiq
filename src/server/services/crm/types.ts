import type { CrmProviderId } from '../../../shared/crmProvider.js'
import type { SfOpportunity, SfAccount, SfContact, SfLead, SfCampaign } from '../salesforce/search.js'
import type { SfPreview, PreviewType } from '../salesforce/preview.js'
import type { RefreshResult } from '../salesforce/refreshOppSnapshots.js'
import type { SuggestedAccount, SuggestedOpportunity } from '../salesforce/contacts.js'

// The provider boundary (HubSpot plan, phase 1b). Everything above it (routes,
// MCP tools, the activity save path, the dashboard refresh button) asks the
// active provider for CRM work instead of calling Salesforce code directly.
// Below it, the Salesforce provider delegates to the existing services
// unchanged; HubSpot becomes a second implementation in phase 2.
//
// Record shapes stay ImpactIQ's canonical kinds (Opportunity, Account,
// Contact, Lead, Campaign) with today's field names, because the client and
// the API responses already use them. A provider translates its own objects
// (Deal → Opportunity, Company → Account) at this boundary.
export type CrmOpportunity = SfOpportunity
export type CrmAccount = SfAccount
export type CrmContact = SfContact
export type CrmLead = SfLead
export type CrmCampaign = SfCampaign
export type CrmPreview = SfPreview
export type CrmPreviewType = PreviewType
export type CrmRefreshResult = RefreshResult

// Accounts + open Opportunities linked to contacts whose email matches a
// meeting attendee; each row names the contact it came through.
export interface CrmAttendeeSuggestions {
  accounts: SuggestedAccount[]
  opportunities: SuggestedOpportunity[]
}

export interface OpportunitySearchOptions {
  // Search every opportunity instead of only the ones the user is engaged on.
  openSearch: boolean
  showClosed: boolean
  // The team the search runs for, when known: team-scoped field mappings
  // (HubSpot's SE properties) come from it.
  teamId?: string | null
}

// One signed-in user's live CRM access. Reads run as that user (their own
// connection and permissions), never as the admin connection.
export interface CrmUserSession {
  searchOpportunities(query: string, opts: OpportunitySearchOptions): Promise<CrmOpportunity[]>
  searchAccounts(query: string): Promise<CrmAccount[]>
  searchContacts(query: string): Promise<CrmContact[]>
  searchLeads(query: string): Promise<CrmLead[]>
  searchCampaigns(query: string, attendeeEmails: string[]): Promise<CrmCampaign[]>
  // Live read for the hover preview. Null on any failure, so the caller
  // falls back to the local snapshot.
  readPreview(id: string, type: CrmPreviewType): Promise<CrmPreview | null>
  // Attendee matching: contacts found by email, then their Accounts and open
  // Opportunities (Companies and open Deals on HubSpot).
  suggestFromAttendees(emails: string[]): Promise<CrmAttendeeSuggestions>
}

export interface CrmProvider {
  readonly id: Exclude<CrmProviderId, 'none'>
  // Whether a string is shaped like one of this CRM's record ids (checked
  // before an id from a request reaches the CRM).
  isRecordId(id: string): boolean
  // Null when the user hasn't connected this CRM (or their token is gone).
  connectForUser(userId: string): Promise<CrmUserSession | null>
  // Write an activity to the CRM in the background. Never blocks the caller.
  queueActivitySync(activityId: string): void
  // Push one queued activity_note_pushes row to the CRM as a note on its
  // Opportunity / Account (Deal / Company). Never blocks the caller.
  queueNotePush(pushId: string): void
  // Refresh the opportunity snapshot columns on activities from the CRM.
  refreshSnapshots(opts?: { source?: 'scheduled' | 'manual' }): Promise<CrmRefreshResult>
}
