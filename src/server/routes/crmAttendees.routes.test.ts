// HubSpot phase 7b routes: the CRM-neutral attendee suggestions
// (/api/crm/search/from-attendees, /api/crm/suggestions/by-attendees) and the
// Attendees section's contacts-on-record search (/api/crm/accounts/:id/contacts).
// The CRM provider session and the HubSpot lookups are mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let provider = 'hubspot'
vi.mock('../services/crm/providerSetting.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/providerSetting.js')>('../services/crm/providerSetting.js')
  return { ...actual, getCrmProviderId: async () => provider, isCrmProviderActive: async (p: string) => p === provider }
})
vi.mock('../services/hubspot/config.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/config.js')>('../services/hubspot/config.js')
  return { ...actual, getHubspotConfig: async () => ({ accessToken: 'x', portalId: 1, uiDomain: null, lastCheck: { capabilities: [] } }) }
})
vi.mock('../services/config/integrations.js', async () => {
  const actual = await vi.importActual<typeof import('../services/config/integrations.js')>('../services/config/integrations.js')
  return { ...actual, getSfInternalDomains: async () => ['ourco.com'] }
})

const suggest = vi.fn()
let connected = true
vi.mock('../services/crm/index.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/index.js')>('../services/crm/index.js')
  return {
    ...actual,
    getActiveCrmProvider: async () => (provider === 'none' ? null : {
      id: provider,
      connectForUser: async () => (connected ? { suggestFromAttendees: (emails: string[]) => suggest(emails) } : null),
    }),
  }
})

const listContacts = vi.fn()
vi.mock('../services/hubspot/attendees.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/attendees.js')>('../services/hubspot/attendees.js')
  return { ...actual, listHubspotContactsOnRecord: (...args: unknown[]) => listContacts(...args) }
})

let crmRouter: typeof import('./crm.js')['crmRouter']
let HubspotError: typeof import('../services/hubspot/client.js')['HubspotError']

beforeAll(async () => {
  crmRouter = (await import('./crm.js')).crmRouter
  HubspotError = (await import('../services/hubspot/client.js')).HubspotError
})

beforeEach(() => {
  provider = 'hubspot'
  connected = true
  suggest.mockReset()
  listContacts.mockReset()
})

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: 'u1' }; next() })
  app.use('/api/crm', crmRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/crm${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : null,
    })
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> | unknown[] | null; error: string | null; meta: Record<string, unknown> } }
  } finally {
    server.close()
  }
}

const OPP = { Id: '900', Name: 'Acme expansion', AccountId: '12', AccountName: 'Acme Corp', StageName: 'Discovery', Amount: 50000, CloseDate: '2026-12-01', ForecastCategoryName: null, OwnerName: 'Owner 77', contactName: 'Jane Doe', contactEmail: 'jane@acme.com' }
const ACC = { Id: '12', Name: 'Acme Corp', OwnerName: 'Owner 77', contactName: 'Jane Doe', contactEmail: 'jane@acme.com' }

describe('GET /api/crm/search/from-attendees', () => {
  it('cleans the email list and returns the picker shape with matchedEmail', async () => {
    suggest.mockResolvedValue({ accounts: [ACC], opportunities: [OPP] })
    const res = await call('GET', '/search/from-attendees?emails=Jane@Acme.com,,nope,jane@acme.com')
    expect(suggest).toHaveBeenCalledWith(['jane@acme.com'])
    expect(res.body.data).toEqual({
      accounts: [{ Id: '12', Name: 'Acme Corp', matchedEmail: 'jane@acme.com' }],
      opportunities: [expect.objectContaining({ Id: '900', AccountName: 'Acme Corp', matchedEmail: 'jane@acme.com' })],
    })
  })

  it('makes no CRM call without a usable email', async () => {
    const res = await call('GET', '/search/from-attendees?emails=nope')
    expect(res.body.data).toEqual({ accounts: [], opportunities: [] })
    expect(suggest).not.toHaveBeenCalled()
  })

  it('answers 403 (no HubSpot owner match) when the user has no session, 401 on Salesforce, 409 with no CRM', async () => {
    connected = false
    const res = await call('GET', '/search/from-attendees?emails=a@b.com')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('errors.hubspot.no_owner_match_search')
    provider = 'salesforce'
    expect((await call('GET', '/search/from-attendees?emails=a@b.com')).status).toBe(401)
    provider = 'none'
    expect((await call('GET', '/search/from-attendees?emails=a@b.com')).status).toBe(409)
  })

  it('reports a HubSpot failure as 502 with its code', async () => {
    suggest.mockRejectedValue(new HubspotError('errors.hubspot.unauthorized', 401))
    const res = await call('GET', '/search/from-attendees?emails=a@b.com')
    expect(res).toMatchObject({ status: 502, body: { error: 'errors.hubspot.unauthorized' } })
  })
})

describe('POST /api/crm/suggestions/by-attendees', () => {
  it('drops internal-domain addresses before matching', async () => {
    suggest.mockResolvedValue({ accounts: [ACC], opportunities: [] })
    const res = await call('POST', '/suggestions/by-attendees', { emails: ['me@ourco.com', 'Jane@Acme.com', 42] })
    expect(suggest).toHaveBeenCalledWith(['jane@acme.com'])
    expect(res.body).toMatchObject({ data: { accounts: [ACC], opportunities: [] }, meta: { emailsMatched: 1 } })
  })

  it('returns empty when only internal addresses remain', async () => {
    const res = await call('POST', '/suggestions/by-attendees', { emails: ['me@ourco.com'] })
    expect(res.body.data).toEqual({ accounts: [], opportunities: [] })
    expect(suggest).not.toHaveBeenCalled()
  })
})

describe('GET /api/crm/accounts/:id/contacts', () => {
  it('passes the record kind and query through', async () => {
    listContacts.mockResolvedValue([{ Id: '501', Name: 'Jane Doe', Email: 'jane@acme.com', Title: null, AccountName: 'Acme Corp' }])
    const res = await call('GET', '/accounts/900/contacts?kind=opportunity&q=jane')
    expect(listContacts).toHaveBeenCalledWith('900', 'opportunity', 'jane')
    expect(res.body.data).toHaveLength(1)
  })

  it('refuses a non-HubSpot id and a non-HubSpot install', async () => {
    expect((await call('GET', '/accounts/001ABC/contacts')).status).toBe(400)
    provider = 'salesforce'
    expect((await call('GET', '/accounts/12/contacts')).status).toBe(409)
    expect(listContacts).not.toHaveBeenCalled()
  })

  it('reports a HubSpot failure as 502', async () => {
    listContacts.mockRejectedValue(new HubspotError('errors.hubspot.forbidden', 403))
    const res = await call('GET', '/accounts/12/contacts')
    expect(res).toMatchObject({ status: 502, body: { error: 'errors.hubspot.forbidden' } })
  })
})
