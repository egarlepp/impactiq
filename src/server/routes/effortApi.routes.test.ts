// GET /api/v1/effort (v1.448.0): hour totals per CRM Opportunity for
// CriteriaIQ. Only effort:read keys get in, the owner must still lead a team,
// and only submitted activities on the owner's teams count. Real route
// against pglite.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let app: express.Express
let apiKeysLib: typeof import('../services/auth/apiKeys.js')

const SF_OPP_18 = '006Ab00000XyZ12AAB'
const SF_OPP_15 = SF_OPP_18.slice(0, 15)

let leaderKey = ''
let leaderRestKey = ''
let contributorKey = ''

async function makeUser(name: string) {
  const [u] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@Example.com`,
    displayName: name,
  }).returning()
  return u!
}

async function makeKey(userId: string, scopes: string[]): Promise<string> {
  const raw = apiKeysLib.newRawApiKey()
  const { salt, hash } = apiKeysLib.hashRawKey(raw)
  await testDb.insert(schema.apiKeys).values({ userId, name: 'k', keyHash: hash, keySalt: salt, keyPrefix: apiKeysLib.keyPrefix(raw), scopes })
  return raw
}

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  apiKeysLib = await import('../services/auth/apiKeys.js')
  const { effortApiRouter } = await import('./effortApi.js')
  app = express()
  app.use('/api/v1', effortApiRouter)

  const [team] = await testDb.insert(schema.teams).values({ name: 'SE', slug: `se-${crypto.randomUUID()}` }).returning()
  const [other] = await testDb.insert(schema.teams).values({ name: 'Other', slug: `o-${crypto.randomUUID()}` }).returning()
  const [demo] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  const [pox] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'POx Work', sortOrder: 2 }).returning()
  const [otherDemo] = await testDb.insert(schema.teamActivityTypes).values({ teamId: other!.id, name: 'Demo', sortOrder: 1 }).returning()

  const [group] = await testDb.insert(schema.costGroups).values({ name: 'SE', hourlyCostRate: '100.00', currency: 'USD' }).returning()
  await testDb.insert(schema.costGroupTeams).values({ groupId: group!.id, teamId: team!.id })

  const leader = await makeUser('Lee Leader')
  const ana = await makeUser('Ana SE')
  const bo = await makeUser('Bo SE')
  const outsider = await makeUser('Out Sider')
  await testDb.insert(schema.teamMembers).values([
    { teamId: team!.id, userId: leader.id, role: 'leader' },
    { teamId: team!.id, userId: ana.id, role: 'contributor' },
    { teamId: team!.id, userId: bo.id, role: 'contributor' },
    { teamId: other!.id, userId: outsider.id, role: 'contributor' },
  ])
  leaderKey = await makeKey(leader.id, ['effort:read'])
  leaderRestKey = await makeKey(leader.id, ['rest:full'])
  contributorKey = await makeKey(ana.id, ['effort:read'])

  const base = {
    teamId: team!.id, status: 'submitted' as const, crmWhatType: 'Opportunity' as const, crmWhatId: SF_OPP_18,
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'),
  }
  await testDb.insert(schema.activities).values([
    { ...base, userId: ana.id, activityTypeId: demo!.id, title: 'Private: secret', effortHours: '2.00' },
    { ...base, userId: ana.id, activityTypeId: pox!.id, title: 'x', effortHours: '3.50', costTransportation: '50.00', incidentalCurrency: 'USD', startDatetime: new Date('2026-10-22T15:00:00Z') },
    // Saved with the 15-char form of the same id.
    { ...base, userId: bo.id, activityTypeId: demo!.id, title: 'x', effortHours: '1.25', crmWhatId: SF_OPP_15, startDatetime: new Date('2026-10-18T15:00:00Z') },
    // Not counted: a draft, an archived row, an Account link, another team.
    { ...base, userId: bo.id, activityTypeId: demo!.id, title: 'x', effortHours: '9.00', status: 'draft' as const },
    { ...base, userId: bo.id, activityTypeId: demo!.id, title: 'x', effortHours: '9.00', isArchived: true },
    { ...base, userId: bo.id, activityTypeId: demo!.id, title: 'x', effortHours: '9.00', crmWhatType: 'Account' as const },
    { ...base, userId: outsider.id, teamId: other!.id, activityTypeId: otherDemo!.id, title: 'x', effortHours: '9.00' },
  ])
})

async function get(path: string, key?: string) {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const headers: Record<string, string> = {}
    if (key) headers['authorization'] = `Bearer ${key}`
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> | null; error: string | null } }
  } finally {
    server.close()
  }
}

describe('GET /api/v1/effort', () => {
  it('refuses a request with no key', async () => {
    expect((await get(`/api/v1/effort?crmOpportunityId=${SF_OPP_18}`)).status).toBe(401)
  })

  it('refuses a full REST key', async () => {
    const res = await get(`/api/v1/effort?crmOpportunityId=${SF_OPP_18}`, leaderRestKey)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('errors.apikey.wrong_scope')
  })

  it('refuses a key whose owner leads no team', async () => {
    expect((await get(`/api/v1/effort?crmOpportunityId=${SF_OPP_18}`, contributorKey)).status).toBe(403)
  })

  it('refuses a malformed id', async () => {
    expect((await get('/api/v1/effort?crmOpportunityId=006%27%20OR%201', leaderKey)).status).toBe(400)
    expect((await get('/api/v1/effort', leaderKey)).status).toBe(400)
  })

  it('totals submitted activities on the owner\'s teams, matching 15- and 18-char ids', async () => {
    const res = await get(`/api/v1/effort?crmOpportunityId=${SF_OPP_18}`, leaderKey)
    expect(res.status).toBe(200)
    const data = res.body.data!
    expect(data).toMatchObject({ version: 1, crmOpportunityId: SF_OPP_18, totalHours: 6.75, activityCount: 3 })
    expect(data['firstActivityAt']).toBe('2026-10-18T15:00:00.000Z')
    expect(data['lastActivityAt']).toBe('2026-10-22T15:00:00.000Z')
    expect(data['byPerson']).toEqual([
      expect.objectContaining({ name: 'Ana SE', hours: 5.5, activityCount: 2 }),
      expect.objectContaining({ name: 'Bo SE', hours: 1.25, activityCount: 1 }),
    ])
    expect((data['byPerson'] as Array<{ email: string }>)[0]!.email).toMatch(/@example\.com$/)
    expect(data['byType']).toEqual([
      { name: 'POx Work', hours: 3.5, activityCount: 1 },
      { name: 'Demo', hours: 3.25, activityCount: 2 },
    ])
    expect(JSON.stringify(data)).not.toContain('secret')
  })

  it('gives one cost total, never cost per person', async () => {
    const data = (await get(`/api/v1/effort?crmOpportunityId=${SF_OPP_18}`, leaderKey)).body.data!
    expect(data['cost']).toEqual({ currency: 'USD', totalCost: 725, laborCost: 675, directCost: 50, activitiesWithoutRate: 0 })
    for (const p of data['byPerson'] as Array<Record<string, unknown>>) expect(Object.keys(p)).not.toContain('cost')
  })

  it('answers zeros for an Opportunity with nothing logged', async () => {
    const res = await get('/api/v1/effort?crmOpportunityId=356553095874', leaderKey)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ totalHours: 0, activityCount: 0, byPerson: [], byType: [], cost: { totalCost: 0 } })
  })
})
