// HubSpot phase 7 routes: Relink on a HubSpot install (target Deal read live
// with the portal key, a merged target links its survivor, write-back
// re-queued only for rows already in HubSpot) and the drawer's live link
// check (team access, flags, merged links followed). HubSpot's API is mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let currentUserId = ''
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js')
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { user: { id: string } }).user = { id: currentUserId }
      next()
    },
  }
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

// Write-back is the existing queue; only whether a row was handed to it matters here.
const queued: string[] = []
vi.mock('../services/crm/index.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/index.js')>('../services/crm/index.js')
  return { ...actual, queueCrmActivitySync: (id: string) => { queued.push(id) } }
})

type Req = { method?: string; body?: unknown }
const request = vi.fn(async (_path: string, _opts?: Req): Promise<{ status: number; body: unknown }> => ({ status: 404, body: {} }))
vi.mock('../services/hubspot/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/client.js')>('../services/hubspot/client.js')
  const hubspotJson = async (path: string, opts?: Req) => {
    const { status, body } = await request(path, opts)
    if (status < 200 || status >= 300) throw new actual.HubspotError('errors.hubspot.bad_response', status)
    return body
  }
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts), hubspotJson }
})

let schema: typeof import('../../../drizzle/schema.js')
let orm: typeof import('drizzle-orm')
let testDb: TestDb
let activitiesRouter: typeof import('./activities.js')['activitiesRouter']
let crmRouter: typeof import('./crm.js')['crmRouter']

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  orm = await import('drizzle-orm')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  activitiesRouter = (await import('./activities.js')).activitiesRouter
  crmRouter = (await import('./crm.js')).crmRouter
})

beforeEach(async () => {
  provider = 'hubspot'
  queued.length = 0
  request.mockReset()
  request.mockImplementation(async () => ({ status: 404, body: {} }))
  await testDb.delete(schema.activities)
})

let teamId = ''
let typeId = ''
async function seed(role: 'leader' | 'contributor' = 'leader') {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: user!.id, role })
  currentUserId = user!.id; teamId = team!.id; typeId = type!.id
}

async function activity(fields: Partial<typeof schema.activities.$inferInsert>) {
  const [row] = await testDb.insert(schema.activities).values({
    userId: currentUserId, teamId, title: 'A', activityTypeId: typeId, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    ...fields,
  }).returning()
  return row!
}

async function reload(id: string) {
  const [row] = await testDb.select().from(schema.activities).where(orm.eq(schema.activities.id, id))
  return row!
}

// Deal batch reads answer with `deals`; every other HubSpot call (pipelines,
// properties, associations) answers empty.
function hubspot(byObject: Record<string, { results?: unknown[]; notFound?: string[] }>) {
  request.mockImplementation(async (path) => {
    const m = /^\/crm\/v3\/objects\/([^/]+)\/batch\/read$/.exec(path)
    if (m) {
      const a = byObject[m[1]!] ?? {}
      const errors = a.notFound?.length ? [{ category: 'OBJECT_NOT_FOUND', context: { ids: a.notFound } }] : []
      return { status: errors.length ? 207 : 200, body: { results: a.results ?? [], errors } }
    }
    return { status: 200, body: { results: [] } }
  })
}

async function call(router: express.Router, base: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const app = express()
  app.use(express.json())
  if (base === '/api/crm') app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use(base, router)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}${base}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : null,
    })
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> | null; error: string | null; meta: Record<string, unknown> } }
  } finally {
    server.close()
  }
}

const relink = (body: unknown) => call(activitiesRouter, '/api/activities', 'POST', '/relink-opportunity', body)

describe('POST /api/activities/relink-opportunity on HubSpot', () => {
  it('moves the activities to the live-read Deal and re-queues only rows already in HubSpot', async () => {
    await seed()
    const synced = await activity({ crmWhatType: 'Opportunity', crmWhatId: '101', crmWhatName: 'Lost deal', crmRecordId: '9001', crmSyncStatus: 'synced' })
    const draft = await activity({ crmWhatType: 'Opportunity', crmWhatId: '101', status: 'draft' })
    hubspot({ deals: { results: [{ id: '202', properties: { dealname: 'Renewal deal', dealstage: 'x', amount: '5000' } }] } })

    const res = await relink({ teamId, fromOppId: '101', toOppId: '202' })
    expect(res.body).toMatchObject({ data: { activitiesUpdated: 2, requeuedForSync: 1, toOpp: { id: '202', name: 'Renewal deal' } }, error: null })
    expect(await reload(synced.id)).toMatchObject({ crmWhatId: '202', crmWhatName: 'Renewal deal', oppAmount: '5000.00', crmSyncStatus: 'pending' })
    expect(await reload(draft.id)).toMatchObject({ crmWhatId: '202' })
    expect(queued).toEqual([synced.id])
  })

  it('links the surviving Deal when the target was merged, and refuses relinking a Deal into itself', async () => {
    await seed()
    const a = await activity({ crmWhatType: 'Opportunity', crmWhatId: '101' })
    hubspot({ deals: { results: [{ id: '303', properties: { dealname: 'Survivor', hs_merged_object_ids: '202' } }] } })
    expect((await relink({ teamId, fromOppId: '101', toOppId: '202' })).body.data).toMatchObject({ toOpp: { id: '303' } })
    expect(await reload(a.id)).toMatchObject({ crmWhatId: '303' })

    // '101' was merged into '303' too: relinking 303 → its own merged id resolves back to 303.
    hubspot({ deals: { results: [{ id: '303', properties: { dealname: 'Survivor', hs_merged_object_ids: '404' } }] } })
    expect((await relink({ teamId, fromOppId: '303', toOppId: '404' })).body.error).toBe('errors.activities.relink_same_opp_hubspot')
  })

  it('answers in HubSpot words when the target is missing, malformed or nothing moves', async () => {
    await seed()
    await activity({ crmWhatType: 'Opportunity', crmWhatId: '101' })
    hubspot({ deals: { notFound: ['202'] } })
    expect((await relink({ teamId, fromOppId: '101', toOppId: '202' })).body.error).toBe('errors.activities.relink_target_not_found_hubspot')
    expect((await relink({ teamId, fromOppId: '101', toOppId: '006000000000001AAA' })).body.error).toBe('errors.activities.relink_target_not_found_hubspot')
    expect((await relink({ teamId, fromOppId: '101', toOppId: '101' })).body.error).toBe('errors.activities.relink_same_opp_hubspot')
    hubspot({ deals: { results: [{ id: '202', properties: {} }] } })
    expect((await relink({ teamId, fromOppId: '555', toOppId: '202' })).body.error).toBe('errors.activities.relink_nothing_to_move_hubspot')
  })

  it('is refused for a Contributor and without a CRM', async () => {
    await seed('contributor')
    expect((await relink({ teamId, fromOppId: '101', toOppId: '202' })).status).toBe(403)
    await seed()
    provider = 'none'
    expect((await relink({ teamId, fromOppId: '101', toOppId: '202' })).status).toBe(409)
  })
})

const linkStatus = (activityId: string) => call(crmRouter, '/api/crm', 'GET', `/activity-link-status?activityId=${activityId}`)

describe('GET /api/crm/activity-link-status', () => {
  it('flags a deleted Deal, clears a found Contact and leaves Salesforce links alone', async () => {
    await seed()
    const a = await activity({ crmWhatType: 'Opportunity', crmWhatId: '101', crmWhoType: 'Contact', crmWhoId: '7', crmWhoDeleted: true, crmRelatedType: 'Evaluations__c', crmRelatedId: 'a0B000000000001' })
    hubspot({ deals: { notFound: ['101'] }, contacts: { results: [{ id: '7', properties: {} }] } })
    const res = await linkStatus(a.id)
    expect(res.body).toMatchObject({ data: { crmWhatDeleted: true, crmWhoDeleted: false, crmRelatedDeleted: false }, meta: {} })
    expect(request.mock.calls.map(([p]) => p).sort()).toEqual(['/crm/v3/objects/contacts/batch/read', '/crm/v3/objects/deals/batch/read'])
  })

  it('follows a merged Project link and reports the move', async () => {
    await seed()
    const a = await activity({ crmRelatedType: '0-970', crmRelatedId: '40' })
    hubspot({ '0-970': { results: [{ id: '41', properties: { hs_merged_object_ids: '40' } }] } })
    const res = await linkStatus(a.id)
    expect(res.body.meta).toEqual({ moved: { related: { from: '40', to: '41' } } })
    expect(await reload(a.id)).toMatchObject({ crmRelatedId: '41', crmRelatedDeleted: false })
  })

  it('keeps the stored flag when HubSpot fails, skips activities with nothing to check, and checks team access', async () => {
    await seed()
    const a = await activity({ crmWhatType: 'Opportunity', crmWhatId: '101', crmWhatDeleted: true })
    request.mockImplementation(async () => ({ status: 500, body: {} }))
    expect((await linkStatus(a.id)).body.data).toMatchObject({ crmWhatDeleted: true })

    const none = await activity({ crmWhatType: 'Campaign', crmWhatId: '3f2a7c1e-0000-4000-8000-000000000000' })
    expect((await linkStatus(none.id)).body.meta).toEqual({ skipped: true })

    const [stranger] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'S' }).returning()
    currentUserId = stranger!.id
    expect((await linkStatus(a.id)).status).toBe(403)
  })
})
