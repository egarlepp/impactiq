// Who may change a HubSpot Deal from ImpactIQ (v1.424.0, security audit M4):
// anyone matched to an active HubSpot user by default, or under the "Only
// people named on the Deal" setting, someone a chosen Deal property names by
// owner id, email or name. pglite for owners and users; HubSpot's API and
// property metadata mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'
import type { PropertyInfo } from './metadata.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

type Req = { query?: Record<string, unknown> }
const request = vi.fn(async (_path: string, _opts?: Req): Promise<{ status: number; body: unknown }> => ({ status: 200, body: {} }))
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts) }
})

let dealProps = new Map<string, PropertyInfo>()
vi.mock('./metadata.js', async () => {
  const actual = await vi.importActual<typeof import('./metadata.js')>('./metadata.js')
  return { ...actual, getObjectPropertiesSafe: async () => dealProps }
})

let pol: typeof import('./dealEditPolicy.js')
let shared: typeof import('../../../shared/hubspotDealEdit.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  pol = await import('./dealEditPolicy.js')
  shared = await import('../../../shared/hubspotDealEdit.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  request.mockReset()
  request.mockResolvedValue({ status: 200, body: { properties: {} } })
  dealProps = new Map()
  await testDb.delete(schema.hubspotOwners)
  await pol.setHubspotDealEditPolicy(shared.DEFAULT_HUBSPOT_DEAL_EDIT_POLICY)
})

async function matchedUser(email: string, displayName: string, ownerId: string) {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email, displayName }).returning()
  await testDb.insert(schema.hubspotOwners).values({ id: ownerId, email: email.toLowerCase() })
  return u!
}

function dealWith(properties: Record<string, string | null>) {
  request.mockResolvedValue({ status: 200, body: { id: '42', properties } })
}

describe('normalizeHubspotDealEditPolicy', () => {
  it('defaults to any matched user, and drops bad or duplicate property names', () => {
    expect(shared.normalizeHubspotDealEditPolicy(null)).toEqual({ mode: 'any_matched_user', properties: [] })
    expect(shared.normalizeHubspotDealEditPolicy({ mode: 'named_on_deal', properties: ['hubspot_owner_id', 'bad name', 'hubspot_owner_id', 7] }))
      .toEqual({ mode: 'named_on_deal', properties: ['hubspot_owner_id'] })
    expect(shared.normalizeHubspotDealEditPolicy({ mode: 'everyone' }).mode).toBe('any_matched_user')
  })
})

describe('valueNamesUser', () => {
  const person = { ownerId: '501', email: 'ana@acme.example', displayName: 'Ana Silva' }
  it('matches the owner id, the email or the name, in any entry of a multi-value', () => {
    expect(pol.valueNamesUser('501', person)).toBe(true)
    expect(pol.valueNamesUser('77;501', person)).toBe(true)
    expect(pol.valueNamesUser('ANA@acme.example', person)).toBe(true)
    expect(pol.valueNamesUser(' ana silva ', person)).toBe(true)
    expect(pol.valueNamesUser('77;Bo Lee', person)).toBe(false)
    expect(pol.valueNamesUser('5010', person)).toBe(false)
  })
  it('compares a dropdown option\'s label too', () => {
    expect(pol.valueNamesUser('opt_3', person, new Map([['opt_3', 'Ana Silva']]))).toBe(true)
    expect(pol.valueNamesUser('opt_4', person, new Map([['opt_4', 'Bo Lee']]))).toBe(false)
  })
})

describe('canEditHubspotDeal', () => {
  it('always needs a match to an active HubSpot user', async () => {
    const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: 'none@acme.example', displayName: 'No One' }).returning()
    expect(await pol.canEditHubspotDeal(u!.id, '42')).toBe(false)
    const m = await matchedUser('m@acme.example', 'Em', '600')
    expect(await pol.canEditHubspotDeal(m.id, '42')).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('under named_on_deal, allows only someone a chosen property names', async () => {
    const ana = await matchedUser('ana@acme.example', 'Ana Silva', '501')
    const bo = await matchedUser('bo@acme.example', 'Bo Lee', '502')
    await pol.setHubspotDealEditPolicy({ mode: 'named_on_deal', properties: ['hubspot_owner_id', 'assigned_se'] })
    dealWith({ hubspot_owner_id: '777', assigned_se: 'Ana Silva', dealname: 'Bo Lee' })
    expect(await pol.canEditHubspotDeal(ana.id, '42')).toBe(true)
    // Bo is only in a property that isn't chosen.
    expect(await pol.canEditHubspotDeal(bo.id, '42')).toBe(false)
    expect(request.mock.calls[0]![0]).toBe('/crm/v3/objects/deals/42')
    expect(request.mock.calls[0]![1]).toEqual({ query: { properties: 'hubspot_owner_id,assigned_se' } })
    dealWith({ hubspot_owner_id: '502', assigned_se: null })
    expect(await pol.canEditHubspotDeal(bo.id, '42')).toBe(true)
  })

  it('fails closed with no properties chosen, a missing Deal or a bad id, and throws when HubSpot fails', async () => {
    const ana = await matchedUser('ana2@acme.example', 'Ana', '511')
    await pol.setHubspotDealEditPolicy({ mode: 'named_on_deal', properties: [] })
    expect(await pol.canEditHubspotDeal(ana.id, '42')).toBe(false)
    await pol.setHubspotDealEditPolicy({ mode: 'named_on_deal', properties: ['hubspot_owner_id'] })
    expect(await pol.canEditHubspotDeal(ana.id, 'not-an-id')).toBe(false)
    request.mockResolvedValue({ status: 404, body: null })
    expect(await pol.canEditHubspotDeal(ana.id, '42')).toBe(false)
    request.mockResolvedValue({ status: 500, body: null })
    await expect(pol.canEditHubspotDeal(ana.id, '42')).rejects.toThrow()
  })
})
