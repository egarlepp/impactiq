// pglite-backed: the crm_provider setting, provider selection, the route
// guard, and proof that the Salesforce provider sends Salesforce exactly the
// queries the routes sent before phase 1b.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { TestDb } from '../../db/testDb.js'
import { eq } from 'drizzle-orm'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

// A fake jsforce connection that records every SOQL string it is sent.
const soqlSent: string[] = []
const fakeConn = {
  instanceUrl: 'https://example.my.salesforce.com',
  query: vi.fn(async (soql: string) => { soqlSent.push(soql); return { records: [] } }),
  sobject: () => ({
    describe: async () => ({
      fields: [
        { name: 'Id', type: 'id' }, { name: 'OwnerId', type: 'reference' },
        { name: 'Lead_Engineer__c', type: 'reference' }, { name: 'Engineers__c', type: 'multipicklist' },
        { name: 'SE_Name__c', type: 'picklist' }, { name: 'Amount', type: 'currency' },
      ],
    }),
  }),
}
const connectedUsers = new Set<string>()
vi.mock('../salesforce/client.js', async () => {
  const actual = await vi.importActual<typeof import('../salesforce/client.js')>('../salesforce/client.js')
  return { ...actual, getSfConnection: vi.fn(async (userId: string) => (connectedUsers.has(userId) ? fakeConn : null)) }
})

const kickSync = vi.fn()
vi.mock('../salesforce/writeback.js', async () => {
  const actual = await vi.importActual<typeof import('../salesforce/writeback.js')>('../salesforce/writeback.js')
  return { ...actual, kickSync }
})

let crm: typeof import('./index.js')
let search: typeof import('../salesforce/search.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  crm = await import('./index.js')
  search = await import('../salesforce/search.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  crm.clearCrmProviderCache()
  await crm.setCrmProviderId('salesforce')
  soqlSent.length = 0
  kickSync.mockClear()
})

async function makeUser(crmUserId: string | null) {
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Test User',
    crmUserId,
  }).returning()
  return user!
}

function fakeRes() {
  const out: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) { out.status = code; return res },
    json(body: unknown) { out.body = body; return res },
  }
  return { res: res as unknown as Response, out }
}

describe('crm_provider setting', () => {
  it('is Salesforce when nothing is stored', async () => {
    await testDb.delete(schema.systemSettings)
    crm.clearCrmProviderCache()
    expect(await crm.getCrmProviderId()).toBe('salesforce')
    expect((await crm.getActiveCrmProvider())?.id).toBe('salesforce')
  })

  it('stores a change and reads it back', async () => {
    await crm.setCrmProviderId('none')
    crm.clearCrmProviderCache()
    expect(await crm.getCrmProviderId()).toBe('none')
    expect(await crm.isCrmProviderActive('salesforce')).toBe(false)
  })

  it('has no active provider for none, and the HubSpot provider for hubspot', async () => {
    await crm.setCrmProviderId('none')
    expect(await crm.getActiveCrmProvider()).toBeNull()
    await crm.setCrmProviderId('hubspot')
    expect((await crm.getActiveCrmProvider())?.id).toBe('hubspot')
    expect(crm.availableCrmProviderIds()).toEqual(['salesforce', 'hubspot', 'none'])
  })
})

describe('requireCrmProvider route guard', () => {
  it('lets requests through when the install runs that CRM', async () => {
    const next = vi.fn()
    const { res, out } = fakeRes()
    await crm.requireCrmProvider('salesforce')({} as Request, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(out.status).toBeUndefined()
  })

  it('answers 409 provider_mismatch when the install runs another CRM', async () => {
    await crm.setCrmProviderId('hubspot')
    const next = vi.fn()
    const { res, out } = fakeRes()
    await crm.requireCrmProvider('salesforce')({} as Request, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'errors.crm.provider_mismatch' })
  })
})

describe('queueCrmActivitySync', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('hands the activity to the Salesforce write-back when Salesforce is active', async () => {
    crm.queueCrmActivitySync('act-1')
    await flush()
    expect(kickSync).toHaveBeenCalledWith('act-1')
  })

  it('does nothing when no CRM is active', async () => {
    await crm.setCrmProviderId('none')
    crm.queueCrmActivitySync('act-2')
    await flush()
    expect(kickSync).not.toHaveBeenCalled()
  })
})

describe('Salesforce provider sends the same queries as before', () => {
  it('returns no session for a user who has not connected Salesforce', async () => {
    const user = await makeUser('005000000000001AAA')
    expect(await crm.getActiveCrmProvider().then((p) => p!.connectForUser(user.id))).toBeNull()
  })

  it('matches every search the routes used to run directly', async () => {
    const user = await makeUser('005000000000002AAA')
    connectedUsers.add(user.id)
    const session = (await (await crm.getActiveCrmProvider())!.connectForUser(user.id))!
    const conn = fakeConn as never

    const cases: Array<[() => Promise<unknown>, () => Promise<unknown>]> = [
      [() => session.searchOpportunities('acme', { openSearch: false, showClosed: false }),
        () => search.searchOpportunities(conn, 'acme', { crmUserId: '005000000000002AAA', userName: 'Test User', seFields: [] }, false, false)],
      [() => session.searchOpportunities("o'brien", { openSearch: true, showClosed: true }),
        () => search.searchOpportunities(conn, "o'brien", { crmUserId: '005000000000002AAA', userName: 'Test User', seFields: [] }, true, true)],
      [() => session.searchAccounts('acme'), () => search.searchAccounts(conn, 'acme')],
      [() => session.searchContacts('jo'), () => search.searchContacts(conn, 'jo')],
      [() => session.searchLeads('jo'), () => search.searchLeads(conn, 'jo')],
      [() => session.searchCampaigns('q1', ['a@example.com']), () => search.searchCampaigns(conn, 'q1', ['a@example.com'])],
    ]
    for (const [viaProvider, direct] of cases) {
      soqlSent.length = 0
      await viaProvider()
      const sentViaProvider = [...soqlSent]
      soqlSent.length = 0
      await direct()
      expect(sentViaProvider.length).toBeGreaterThan(0)
      expect(sentViaProvider).toEqual(soqlSent)
    }
  })

  it('filters the default Opportunity search by the user\'s own Salesforce User Id', async () => {
    const user = await makeUser('005000000000003AAA')
    connectedUsers.add(user.id)
    const session = (await (await crm.getActiveCrmProvider())!.connectForUser(user.id))!
    soqlSent.length = 0
    await session.searchOpportunities('acme', { openSearch: false, showClosed: false })
    // No SE filter fields mapped: the Opportunity owner only, no custom field.
    expect(soqlSent[0]).toContain("WHERE (OwnerId = '005000000000003AAA')")
    expect(soqlSent[0]).not.toContain('__c')
  })

  it('adds the team\'s mapped SE filter fields, by field type, and skips fields the org lacks', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'SE filter team', slug: `se-filter-${crypto.randomUUID()}` }).returning()
    const user = await makeUser('005000000000004AAA')
    await testDb.update(schema.users).set({ defaultTeamId: team!.id, displayName: "Pat O'Neil" }).where(eq(schema.users.id, user.id))
    for (const api of ['Lead_Engineer__c', 'Engineers__c', 'SE_Name__c', 'Missing_Field__c', 'Amount']) {
      const [m] = await testDb.insert(schema.crmFieldMappings).values({ teamId: team!.id, appField: 'opp_se_filter', crmFieldApi: api, crmObject: 'Opportunity', direction: 'read' }).returning()
      await testDb.insert(schema.crmFieldMappingTeams).values({ crmFieldMappingId: m!.id, teamId: team!.id })
    }
    connectedUsers.add(user.id)
    const session = (await (await crm.getActiveCrmProvider())!.connectForUser(user.id))!
    soqlSent.length = 0
    await session.searchOpportunities('acme', { openSearch: false, showClosed: false })
    expect(soqlSent[0]).toContain(
      "WHERE (OwnerId = '005000000000004AAA' OR Lead_Engineer__c = '005000000000004AAA'"
      + " OR Engineers__c INCLUDES ('005000000000004AAA', 'Pat O\\'Neil')"
      + " OR SE_Name__c IN ('005000000000004AAA', 'Pat O\\'Neil'))",
    )
    expect(soqlSent[0]).not.toContain('Missing_Field__c')
    expect(soqlSent[0]).not.toContain('Amount =')
  })

  it('returns nothing without a linked Salesforce user or a picklist to match the name', async () => {
    const user = await makeUser(null)
    await testDb.update(schema.users).set({ displayName: '' }).where(eq(schema.users.id, user.id))
    connectedUsers.add(user.id)
    const session = (await (await crm.getActiveCrmProvider())!.connectForUser(user.id))!
    soqlSent.length = 0
    expect(await session.searchOpportunities('acme', { openSearch: false, showClosed: false })).toEqual([])
    expect(soqlSent).toHaveLength(0)
  })
})
