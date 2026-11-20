import { getActiveCrmProvider } from './index.js'
import type { CrmProviderId } from '../../../shared/crmProvider.js'

// The MCP server's CRM tools (HubSpot plan, phase 8b). Each one runs as the
// calling user's own CRM session on whichever CRM the install uses, the same
// boundary the in-app search has: Salesforce through the user's own
// connection, HubSpot through the portal connection with "my Deals" meaning
// the HubSpot owner matched to the user's email. Never the admin Salesforce
// connection.

export type McpCrmError = 'crm_not_configured' | 'crm_not_connected' | 'invalid_record_id' | 'not_found'

export interface McpCrmResult<T> {
  crm: Exclude<CrmProviderId, 'none'> | null
  data: T | null
  count?: number
  error?: McpCrmError | string
}

async function session(userId: string) {
  const provider = await getActiveCrmProvider()
  if (!provider) return { provider: null, session: null } as const
  return { provider, session: await provider.connectForUser(userId) } as const
}

function failure<T>(e: unknown, crm: McpCrmResult<T>['crm']): McpCrmResult<T> {
  // HubSpot failures carry an errors.hubspot.* key; Salesforce ones a message.
  const code = e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string'
    ? (e as { code: string }).code
    : e instanceof Error ? e.message : String(e)
  return { crm, data: null, error: code }
}

/**
 * Opportunities (Deals on HubSpot). By default only the caller's own: on
 * Salesforce the Assigned SE / Primary / Specialist / Supporting Engineer
 * filter, on HubSpot Deals they own or are the mapped SE on. Open records
 * unless includeClosed.
 */
export async function mcpSearchOpportunities(
  userId: string,
  args: { q: string; limit: number; includeClosed?: boolean; teamId?: string | null },
) {
  const { provider, session: s } = await session(userId)
  if (!provider) return { crm: null, data: null, error: 'crm_not_configured' } satisfies McpCrmResult<never>
  if (!s) return { crm: provider.id, data: null, error: 'crm_not_connected' } satisfies McpCrmResult<never>
  try {
    const rows = await s.searchOpportunities(args.q, { openSearch: false, showClosed: !!args.includeClosed, ...(args.teamId ? { teamId: args.teamId } : {}) })
    const data = rows.slice(0, args.limit)
    return { crm: provider.id, data, count: data.length }
  } catch (e) {
    return failure(e, provider.id)
  }
}

/** Accounts (Companies on HubSpot) by name, as the in-app Account tab searches them. */
export async function mcpSearchAccounts(userId: string, args: { q: string; limit: number }) {
  const { provider, session: s } = await session(userId)
  if (!provider) return { crm: null, data: null, error: 'crm_not_configured' } satisfies McpCrmResult<never>
  if (!s) return { crm: provider.id, data: null, error: 'crm_not_connected' } satisfies McpCrmResult<never>
  try {
    const data = (await s.searchAccounts(args.q)).slice(0, args.limit)
    return { crm: provider.id, data, count: data.length }
  } catch (e) {
    return failure(e, provider.id)
  }
}

/**
 * The live state of one Opportunity/Deal or Account/Company, the same read
 * the hover preview makes. An id that isn't this CRM's record id is refused
 * before anything is sent to the CRM.
 */
export async function mcpGetRecord(userId: string, args: { type: 'Opportunity' | 'Account'; id: string }) {
  const provider = await getActiveCrmProvider()
  if (!provider) return { crm: null, data: null, error: 'crm_not_configured' } satisfies McpCrmResult<never>
  if (!provider.isRecordId(args.id)) return { crm: provider.id, data: null, error: 'invalid_record_id' } satisfies McpCrmResult<never>
  const s = await provider.connectForUser(userId)
  if (!s) return { crm: provider.id, data: null, error: 'crm_not_connected' } satisfies McpCrmResult<never>
  try {
    const data = await s.readPreview(args.id, args.type)
    return data ? { crm: provider.id, data } : { crm: provider.id, data: null, error: 'not_found' }
  } catch (e) {
    return failure(e, provider.id)
  }
}
