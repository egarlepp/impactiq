// pglite-backed: the CRM switch lock. Once anything links to a CRM record,
// the install can only move between that CRM and "none".
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

// Pretend HubSpot is already built, so the lock (not availability) is what
// decides a Salesforce → HubSpot move.
const available = vi.fn((): string[] => ['salesforce', 'none'])
vi.mock('./index.js', async () => {
  const actual = await vi.importActual<typeof import('./index.js')>('./index.js')
  return { ...actual, availableCrmProviderIds: () => available() }
})

// Whether a HubSpot connection is saved. Since v1.407.0 it never blocks the
// switch; the admin state only reports it.
const hubspotConfigured = vi.fn(async () => true)
vi.mock('../hubspot/config.js', async () => {
  const actual = await vi.importActual<typeof import('../hubspot/config.js')>('../hubspot/config.js')
  return { ...actual, isHubspotConfigured: () => hubspotConfigured() }
})

let lock: typeof import('./providerLock.js')
let setting: typeof import('./providerSetting.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  lock = await import('./providerLock.js')
  setting = await import('./providerSetting.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.activityCrmTickets)
  await testDb.delete(schema.activities)
  await testDb.delete(schema.systemSettings)
  setting.clearCrmProviderCache()
  available.mockImplementation(() => ['salesforce', 'hubspot', 'none'])
  hubspotConfigured.mockImplementation(async () => true)
})

async function linkOneActivity(fields: Partial<typeof schema.activities.$inferInsert>) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U',
  }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'A', activityTypeId: type!.id, status: 'submitted',
    startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00', ...fields,
  })
}

describe('countCrmLinkedData', () => {
  it('ignores activities with no CRM ids', async () => {
    await linkOneActivity({})
    const counts = await lock.countCrmLinkedData()
    expect(counts).toEqual({ activities: 0, tickets: 0, historicalEvents: 0 })
    expect(lock.hasCrmLinkedData(counts)).toBe(false)
  })

  it.each([
    ['What link', { crmWhatId: 'opp-1', crmWhatType: 'Opportunity' as const }],
    ['Who link', { crmWhoId: '003xx' }],
    ['Related link', { crmRelatedId: 'a0Fxx' }],
    ['write-back record', { crmRecordId: '00Uxx' }],
  ])('counts an activity with a %s', async (_label, fields) => {
    await linkOneActivity(fields)
    expect((await lock.countCrmLinkedData()).activities).toBe(1)
  })
})

describe('changeCrmProvider', () => {
  it('allows any CRM while nothing is linked, and the data CRM follows the choice', async () => {
    const r = await lock.changeCrmProvider('hubspot')
    expect(r).toMatchObject({ ok: true, after: { provider: 'hubspot', dataProvider: 'hubspot' } })
  })

  it('refuses a different CRM once records are linked', async () => {
    await linkOneActivity({ crmWhatId: 'opp-1', crmWhatType: 'Opportunity' })
    const r = await lock.changeCrmProvider('hubspot')
    expect(r).toEqual({ ok: false, status: 409, error: 'errors.crm.provider_locked' })
    expect(await setting.getCrmProviderId()).toBe('salesforce')
  })

  it('still allows moving to none and back to the data CRM when locked', async () => {
    await linkOneActivity({ crmWhatId: 'opp-1', crmWhatType: 'Opportunity' })
    expect(await lock.changeCrmProvider('none')).toMatchObject({ ok: true, after: { provider: 'none', dataProvider: 'salesforce' } })
    // From none, the lock still remembers the data is Salesforce's.
    expect(await lock.changeCrmProvider('hubspot')).toMatchObject({ ok: false, error: 'errors.crm.provider_locked' })
    expect(await lock.changeCrmProvider('salesforce')).toMatchObject({ ok: true, after: { provider: 'salesforce' } })
  })

  it('allows a CRM whose connection is not saved yet, and reports it as not configured', async () => {
    hubspotConfigured.mockImplementation(async () => false)
    expect(await lock.changeCrmProvider('hubspot')).toMatchObject({ ok: true, after: { provider: 'hubspot' } })
    const state = await lock.getCrmProviderState()
    expect(state).toMatchObject({ provider: 'hubspot', configured: { hubspot: false, salesforce: false } })
  })

  it('refuses a CRM that is not built yet', async () => {
    available.mockImplementation(() => ['salesforce', 'none'])
    expect(await lock.changeCrmProvider('hubspot')).toEqual({ ok: false, status: 400, error: 'errors.crm.provider_not_available' })
  })

  it('reports the lock and counts in the admin state', async () => {
    await linkOneActivity({ crmRecordId: '00Uxx' })
    const state = await lock.getCrmProviderState()
    expect(state).toMatchObject({ provider: 'salesforce', dataProvider: 'salesforce', locked: true, linkedData: { activities: 1 } })
  })
})
