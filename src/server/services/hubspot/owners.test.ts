// pglite-backed: copying HubSpot's owner list, matching ImpactIQ users to
// owners by email, and the connection rules (token save, portal lock,
// removal). HubSpot itself is mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'
import type { HubspotPortalInfo } from './config.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

type Owner = { id: string; email?: string; firstName?: string; lastName?: string; userId?: number; teams?: unknown }
const activeOwners = vi.fn((): Owner[] => [])
const archivedOwners = vi.fn((): Owner[] => [])
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return {
    ...actual,
    hubspotListAll: async (_path: string, query: Record<string, unknown>) => (query['archived'] ? archivedOwners() : activeOwners()),
  }
})

const portal = vi.fn(async (): Promise<HubspotPortalInfo> => ({ portalId: 1, portalName: 'P1', accountType: 'DEVELOPER_TEST', uiDomain: 'app.hubspot.com' }))
vi.mock('./capabilities.js', async () => {
  const actual = await vi.importActual<typeof import('./capabilities.js')>('./capabilities.js')
  return { ...actual, inspectHubspotToken: () => portal() }
})

let owners: typeof import('./owners.js')
let conn: typeof import('./connection.js')
let config: typeof import('./config.js')
let providerSetting: typeof import('../crm/providerSetting.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  owners = await import('./owners.js')
  conn = await import('./connection.js')
  config = await import('./config.js')
  providerSetting = await import('../crm/providerSetting.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.activities)
  await testDb.delete(schema.hubspotOwners)
  await testDb.delete(schema.jobRuns)
  await testDb.delete(schema.systemSettings)
  await testDb.delete(schema.teamMembers)
  await testDb.delete(schema.users)
  providerSetting.clearCrmProviderCache()
  activeOwners.mockImplementation(() => [])
  archivedOwners.mockImplementation(() => [])
  portal.mockImplementation(async () => ({ portalId: 1, portalName: 'P1', accountType: 'DEVELOPER_TEST', uiDomain: 'app.hubspot.com' }))
})

async function addUser(email: string, displayName = email) {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email, displayName }).returning()
  return u!
}

describe('syncHubspotOwners', () => {
  it('stores active and archived owners, emails lowercased', async () => {
    activeOwners.mockImplementation(() => [{ id: '10', email: 'Dana@Example.com', firstName: 'Dana', lastName: 'Lee', userId: 77 }])
    archivedOwners.mockImplementation(() => [{ id: '11', email: 'gone@example.com' }])
    expect(await owners.syncHubspotOwners()).toEqual({ active: 1, archived: 1, removed: 0 })
    const rows = await owners.listHubspotOwners()
    expect(rows.map((r) => [r.id, r.email, r.archived, r.hubspotUserId])).toEqual([
      ['10', 'dana@example.com', false, '77'],
      ['11', 'gone@example.com', true, null],
    ])
  })

  it('updates owners in place and removes the ones HubSpot no longer lists', async () => {
    activeOwners.mockImplementation(() => [{ id: '10', email: 'a@example.com' }, { id: '12', email: 'b@example.com' }])
    await owners.syncHubspotOwners()
    activeOwners.mockImplementation(() => [{ id: '10', email: 'a2@example.com' }])
    expect(await owners.syncHubspotOwners()).toMatchObject({ active: 1, removed: 1 })
    const rows = await owners.listHubspotOwners()
    expect(rows.map((r) => [r.id, r.email])).toEqual([['10', 'a2@example.com']])
  })
})

describe('Sales Team Alignment copy in crm_users', () => {
  it('copies owners under their id and deactivates, never deletes, the ones that go', async () => {
    await testDb.delete(schema.crmUserAlignments)
    await testDb.delete(schema.crmUsers)
    // A Salesforce user from before stays untouched.
    await testDb.insert(schema.crmUsers).values({ id: '005000000000001AAA', name: 'SF Person' })
    const dana = await addUser('dana@example.com', 'Dana')
    activeOwners.mockImplementation(() => [
      { id: '10', email: 'Dana@Example.com', firstName: 'Dana', lastName: 'Lee' },
      { id: '12', email: 'b@example.com' },
    ])
    archivedOwners.mockImplementation(() => [{ id: '11' }])
    await owners.syncHubspotOwners()
    await testDb.insert(schema.crmUserAlignments).values({ userId: dana.id, crmUserId: '12', role: 'owner' })

    const read = async () => (await testDb.select().from(schema.crmUsers).orderBy(schema.crmUsers.id))
      .map((r) => [r.id, r.name, r.email, r.isActive])
    expect(await read()).toEqual([
      ['005000000000001AAA', 'SF Person', null, true],
      ['10', 'Dana Lee', 'dana@example.com', true],
      ['11', '11', null, false],
      ['12', 'b@example.com', 'b@example.com', true],
    ])

    // Owner 12 leaves HubSpot: its row and the alignment naming it stay.
    activeOwners.mockImplementation(() => [{ id: '10', email: 'dana@example.com', firstName: 'Dana', lastName: 'Lee' }])
    archivedOwners.mockImplementation(() => [])
    await owners.syncHubspotOwners()
    expect((await read()).find((r) => r[0] === '12')?.[3]).toBe(false)
    expect((await read()).find((r) => r[0] === '005000000000001AAA')?.[3]).toBe(true)
    expect(await testDb.select().from(schema.crmUserAlignments)).toHaveLength(1)

    // Clearing the connection deactivates the copies only.
    await owners.clearHubspotOwners()
    expect((await read()).map((r) => r[3])).toEqual([true, false, false, false])
  })
})

describe('owner matching by email', () => {
  it('matches case-insensitively, to active owners only', async () => {
    const dana = await addUser('dana@example.com', 'Dana')
    const sam = await addUser('Sam@Example.com', 'Sam')
    const pat = await addUser('pat@example.com', 'Pat')
    activeOwners.mockImplementation(() => [{ id: '10', email: 'DANA@example.com' }, { id: '12', email: 'sam@example.com' }])
    archivedOwners.mockImplementation(() => [{ id: '11', email: 'pat@example.com' }])
    await owners.syncHubspotOwners()
    expect(await owners.getHubspotOwnerIdForUser(dana.id)).toBe('10')
    expect(await owners.getHubspotOwnerIdForUser(sam.id)).toBe('12')
    expect(await owners.getHubspotOwnerIdForUser(pat.id)).toBeNull()

    const summary = await owners.getHubspotOwnerMatchSummary()
    expect(summary).toMatchObject({ owners: 2, matchedUsers: 2 })
    expect(summary.unmatchedUsers).toEqual([{ id: pat.id, displayName: 'Pat', email: 'pat@example.com' }])
    expect(summary.lastSyncedAt).not.toBeNull()
  })
})

describe('runHubspotOwnerSync', () => {
  it('does nothing, and logs nothing, without a connection', async () => {
    expect(await owners.runHubspotOwnerSync()).toBeNull()
    expect(await testDb.select().from(schema.jobRuns)).toHaveLength(0)
  })

  it('does nothing while HubSpot is not the active CRM', async () => {
    await config.setHubspotConfig('pat-na2-0000000000000000', { portalId: 1, portalName: null, accountType: null, uiDomain: null })
    activeOwners.mockImplementation(() => [{ id: '10', email: 'a@example.com' }])
    for (const crm of ['salesforce', 'none'] as const) {
      await providerSetting.setCrmProviderId(crm)
      expect(await owners.runHubspotOwnerSync()).toBeNull()
    }
    expect(await testDb.select().from(schema.jobRuns)).toHaveLength(0)
    expect(await testDb.select().from(schema.hubspotOwners)).toHaveLength(0)
  })

  it('records a run once connected', async () => {
    await providerSetting.setCrmProviderId('hubspot')
    await config.setHubspotConfig('pat-na2-0000000000000000', { portalId: 1, portalName: null, accountType: null, uiDomain: null })
    activeOwners.mockImplementation(() => [{ id: '10', email: 'a@example.com' }])
    expect(await owners.runHubspotOwnerSync()).toMatchObject({ active: 1 })
    const runs = await testDb.select().from(schema.jobRuns)
    expect(runs.map((r) => [r.jobKey, r.status])).toEqual([['hubspot_owner_sync', 'ok']])
  })
})

describe('connection', () => {
  it('saves a checked token encrypted, and only ever shows its last 4 characters', async () => {
    const r = await conn.saveHubspotToken('pat-na2-abcdefghijklmnop1234')
    expect(r).toMatchObject({ ok: true, portal: { portalId: 1 } })
    const [row] = await testDb.select().from(schema.systemSettings)
    expect(JSON.stringify(row!.value)).not.toContain('abcdefghijklmnop')
    const summary = await conn.getHubspotConnectionSummary()
    expect(summary).toMatchObject({ configured: true, tokenHint: '1234', portalId: 1, portalName: 'P1' })
  })

  it('never saves a token HubSpot rejects', async () => {
    const { HubspotError } = await import('./client.js')
    portal.mockImplementation(async () => { throw new HubspotError('errors.hubspot.unauthorized', 401) })
    expect(await conn.saveHubspotToken('pat-na2-bad-token-000000')).toEqual({ ok: false, status: 400, error: 'errors.hubspot.unauthorized' })
    expect(await config.getHubspotConfig()).toBeNull()
  })

  it('a token for a new portal clears the old owner list', async () => {
    await conn.saveHubspotToken('pat-na2-first-token-0000000')
    activeOwners.mockImplementation(() => [{ id: '10', email: 'a@example.com' }])
    await owners.syncHubspotOwners()
    portal.mockImplementation(async () => ({ portalId: 2, portalName: 'P2', accountType: null, uiDomain: null }))
    expect(await conn.saveHubspotToken('pat-na2-second-token-000000')).toMatchObject({ ok: true, portalChanged: true })
    expect(await owners.listHubspotOwners()).toHaveLength(0)
  })

  it('locks the portal once the install holds HubSpot-linked data', async () => {
    await conn.saveHubspotToken('pat-na2-first-token-0000000')
    await providerSetting.writeCrmProviderSetting({ provider: 'hubspot', dataProvider: 'hubspot' })
    const user = await addUser('a@example.com')
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team!.id, title: 'A', activityTypeId: type!.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00', crmWhatId: '12345',
    })
    portal.mockImplementation(async () => ({ portalId: 2, portalName: 'P2', accountType: null, uiDomain: null }))
    expect(await conn.saveHubspotToken('pat-na2-second-token-000000')).toEqual({ ok: false, status: 409, error: 'errors.hubspot.portal_locked' })
    // A fresh token for the same portal is fine.
    portal.mockImplementation(async () => ({ portalId: 1, portalName: 'P1', accountType: null, uiDomain: null }))
    expect(await conn.saveHubspotToken('pat-na2-rotated-token-00000')).toMatchObject({ ok: true, portalChanged: false })
  })

  it("can't be removed while HubSpot is the install's CRM", async () => {
    await conn.saveHubspotToken('pat-na2-first-token-0000000')
    await providerSetting.writeCrmProviderSetting({ provider: 'hubspot', dataProvider: 'hubspot' })
    expect(await conn.removeHubspotConnection()).toEqual({ ok: false, status: 409, error: 'errors.hubspot.in_use' })
    await providerSetting.writeCrmProviderSetting({ provider: 'none', dataProvider: 'hubspot' })
    expect(await conn.removeHubspotConnection()).toEqual({ ok: true })
    expect(await config.getHubspotConfig()).toBeNull()
  })
})

describe('hubspotPortalChangeAllowed', () => {
  it('only blocks a known, different portal when HubSpot data exists', () => {
    expect(conn.hubspotPortalChangeAllowed(1, 2, false)).toBe(true)
    expect(conn.hubspotPortalChangeAllowed(1, 2, true)).toBe(false)
    expect(conn.hubspotPortalChangeAllowed(1, 1, true)).toBe(true)
    expect(conn.hubspotPortalChangeAllowed(null, 2, true)).toBe(true)
    expect(conn.hubspotPortalChangeAllowed(1, null, true)).toBe(true)
  })
})

describe('manual owner link (User Management)', () => {
  it('a manual link wins over the email match, and the owner no longer matches by email', async () => {
    activeOwners.mockImplementation(() => [{ id: '10', email: 'dana@example.com' }, { id: '12', email: 'dana.lee@example.com' }])
    await owners.syncHubspotOwners()
    const dana = await addUser('dana@example.com', 'Dana')
    const other = await addUser('dana.lee@example.com', 'Other Dana')
    // Dana is linked by hand to owner 12, whose email belongs to someone else.
    await testDb.update(schema.users).set({ crmUserId: '12' }).where(eq(schema.users.id, dana.id))
    expect(await owners.getHubspotOwnerIdForUser(dana.id)).toBe('12')
    // Owner 12 is taken, so the user with its email no longer matches it.
    expect(await owners.getHubspotOwnerIdForUser(other.id)).toBeNull()
    expect((await owners.getUserForHubspotOwner('12'))?.id).toBe(dana.id)
    // Owner 10 still has an email-only match: nobody, since Dana is linked elsewhere.
    expect(await owners.getUserForHubspotOwner('10')).toBeNull()
  })

  it('a leftover Salesforce id on the user still allows the email match', async () => {
    activeOwners.mockImplementation(() => [{ id: '10', email: 'dana@example.com' }])
    await owners.syncHubspotOwners()
    const dana = await addUser('dana@example.com', 'Dana')
    await testDb.update(schema.users).set({ crmUserId: '005000000000001AAA' }).where(eq(schema.users.id, dana.id))
    expect(await owners.getHubspotOwnerIdForUser(dana.id)).toBe('10')
    expect((await owners.getUserForHubspotOwner('10'))?.id).toBe(dana.id)
  })

  it('a link to an archived owner resolves to nobody for writes', async () => {
    activeOwners.mockImplementation(() => [])
    archivedOwners.mockImplementation(() => [{ id: '11', email: 'gone@example.com' }])
    await owners.syncHubspotOwners()
    const dana = await addUser('dana@example.com', 'Dana')
    await testDb.update(schema.users).set({ crmUserId: '11' }).where(eq(schema.users.id, dana.id))
    expect(await owners.getHubspotOwnerIdForUser(dana.id)).toBeNull()
  })
})

describe('HubSpot teams', () => {
  it('parseOwnerTeams keeps well-formed teams, primary first then by name', () => {
    expect(owners.parseOwnerTeams([
      { id: '2', name: 'West', primary: false },
      { id: 3, name: 'Federal', primary: true },
      { id: '4', name: 'East' },
      { name: 'no id' },
      null,
    ])).toEqual([
      { id: '3', name: 'Federal', primary: true },
      { id: '4', name: 'East', primary: false },
      { id: '2', name: 'West', primary: false },
    ])
    expect(owners.parseOwnerTeams(undefined)).toEqual([])
  })

  it('stores teams on sync and lists distinct names from active owners only', async () => {
    activeOwners.mockImplementation(() => [
      { id: '10', email: 'a@example.com', teams: [{ id: '1', name: 'EMEA', primary: true }] },
      { id: '12', email: 'b@example.com', teams: [{ id: '1', name: 'EMEA', primary: true }, { id: '2', name: 'Federal' }] },
    ])
    archivedOwners.mockImplementation(() => [{ id: '13', email: 'c@example.com', teams: [{ id: '3', name: 'Gone Team' }] }])
    await owners.syncHubspotOwners()
    expect(await owners.listHubspotTeamNames()).toEqual(['EMEA', 'Federal'])
    expect(await owners.listHubspotTeamNames('fed')).toEqual(['Federal'])
    const b = await addUser('b@example.com')
    expect(await owners.getHubspotOwnerDetailsForUser(b.id)).toEqual({
      ownerId: '12',
      teams: [{ id: '1', name: 'EMEA', primary: true }, { id: '2', name: 'Federal', primary: false }],
    })
    const nobody = await addUser('nobody@example.com')
    expect(await owners.getHubspotOwnerDetailsForUser(nobody.id)).toBeNull()
  })
})
