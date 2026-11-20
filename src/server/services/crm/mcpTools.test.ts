import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CrmProvider, CrmUserSession } from './types.js'

const getActiveCrmProvider = vi.fn<() => Promise<CrmProvider | null>>()
vi.mock('./index.js', () => ({ getActiveCrmProvider: () => getActiveCrmProvider() }))

const { mcpSearchOpportunities, mcpSearchAccounts, mcpGetRecord } = await import('./mcpTools.js')

function opp(i: number) {
  return { Id: `id${i}`, Name: `Deal ${i}`, StageName: 'Open', AccountId: null, AccountName: '', CloseDate: '2026-12-01', Amount: null, ForecastCategoryName: null, OwnerName: null }
}

function makeSession(over: Partial<CrmUserSession> = {}): CrmUserSession {
  return {
    searchOpportunities: vi.fn(async () => [opp(1), opp(2), opp(3)]),
    searchAccounts: vi.fn(async () => [{ Id: 'a1', Name: 'Acme' }, { Id: 'a2', Name: 'Acme 2' }] as never),
    searchContacts: vi.fn(async () => []),
    searchLeads: vi.fn(async () => []),
    searchCampaigns: vi.fn(async () => []),
    readPreview: vi.fn(async () => ({ id: '123', type: 'Opportunity' }) as never),
    suggestFromAttendees: vi.fn(async () => ({ accounts: [], opportunities: [] })),
    ...over,
  }
}

function makeProvider(session: CrmUserSession | null, id: 'salesforce' | 'hubspot' = 'hubspot'): CrmProvider {
  return {
    id,
    isRecordId: (rid: string) => /^[0-9]{1,20}$/.test(rid),
    connectForUser: vi.fn(async () => session),
    queueActivitySync: vi.fn(),
    queueNotePush: vi.fn(),
    refreshSnapshots: vi.fn(),
  } as unknown as CrmProvider
}

beforeEach(() => getActiveCrmProvider.mockReset())

describe('MCP CRM tools', () => {
  it('reports crm_not_configured when no CRM is active', async () => {
    getActiveCrmProvider.mockResolvedValue(null)
    expect(await mcpSearchOpportunities('u1', { q: 'acme', limit: 5 })).toEqual({ crm: null, data: null, error: 'crm_not_configured' })
    expect(await mcpSearchAccounts('u1', { q: 'acme', limit: 5 })).toMatchObject({ error: 'crm_not_configured' })
    expect(await mcpGetRecord('u1', { type: 'Account', id: '1' })).toMatchObject({ error: 'crm_not_configured' })
  })

  it('reports crm_not_connected when the user has no session', async () => {
    getActiveCrmProvider.mockResolvedValue(makeProvider(null))
    expect(await mcpSearchOpportunities('u1', { q: 'acme', limit: 5 })).toEqual({ crm: 'hubspot', data: null, error: 'crm_not_connected' })
  })

  it('searches only the caller\'s own records, passes the closed toggle and team, and applies the limit', async () => {
    const s = makeSession()
    getActiveCrmProvider.mockResolvedValue(makeProvider(s))
    const res = await mcpSearchOpportunities('u1', { q: 'deal', limit: 2, includeClosed: true, teamId: 't1' })
    expect(s.searchOpportunities).toHaveBeenCalledWith('deal', { openSearch: false, showClosed: true, teamId: 't1' })
    expect(res).toMatchObject({ crm: 'hubspot', count: 2 })
    expect(res.data).toHaveLength(2)
  })

  it('defaults to open records only', async () => {
    const s = makeSession()
    getActiveCrmProvider.mockResolvedValue(makeProvider(s, 'salesforce'))
    await mcpSearchOpportunities('u1', { q: 'deal', limit: 20 })
    expect(s.searchOpportunities).toHaveBeenCalledWith('deal', { openSearch: false, showClosed: false })
  })

  it('limits account results', async () => {
    getActiveCrmProvider.mockResolvedValue(makeProvider(makeSession()))
    const res = await mcpSearchAccounts('u1', { q: 'acme', limit: 1 })
    expect(res).toMatchObject({ crm: 'hubspot', count: 1 })
  })

  it('refuses an id that is not this CRM\'s record id before connecting', async () => {
    const p = makeProvider(makeSession())
    getActiveCrmProvider.mockResolvedValue(p)
    expect(await mcpGetRecord('u1', { type: 'Opportunity', id: '006xx0000001' })).toEqual({ crm: 'hubspot', data: null, error: 'invalid_record_id' })
    expect(p.connectForUser).not.toHaveBeenCalled()
  })

  it('returns the record, or not_found when the CRM has nothing', async () => {
    const s = makeSession()
    getActiveCrmProvider.mockResolvedValue(makeProvider(s))
    expect(await mcpGetRecord('u1', { type: 'Opportunity', id: '123' })).toMatchObject({ crm: 'hubspot', data: { id: '123' } })
    vi.mocked(s.readPreview).mockResolvedValueOnce(null)
    expect(await mcpGetRecord('u1', { type: 'Opportunity', id: '123' })).toEqual({ crm: 'hubspot', data: null, error: 'not_found' })
  })

  it('passes a CRM error code through, or the message', async () => {
    const coded = Object.assign(new Error('boom'), { code: 'errors.hubspot.rate_limited' })
    getActiveCrmProvider.mockResolvedValue(makeProvider(makeSession({ searchOpportunities: vi.fn(async () => { throw coded }) })))
    expect(await mcpSearchOpportunities('u1', { q: 'deal', limit: 5 })).toEqual({ crm: 'hubspot', data: null, error: 'errors.hubspot.rate_limited' })
    getActiveCrmProvider.mockResolvedValue(makeProvider(makeSession({ searchAccounts: vi.fn(async () => { throw new Error('INVALID_SESSION_ID') }) }), 'salesforce'))
    expect(await mcpSearchAccounts('u1', { q: 'acme', limit: 5 })).toEqual({ crm: 'salesforce', data: null, error: 'INVALID_SESSION_ID' })
  })
})
