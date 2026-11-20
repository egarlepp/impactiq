// Security audit M4 (v1.424.0): HubSpot runs on one portal-wide key, so
// ImpactIQ is the only gate. A user not matched to an active HubSpot user gets
// no HubSpot session, and a note is only posted to the records its own
// activity is linked to.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

vi.mock('../services/hubspot/config.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/config.js')>('../services/hubspot/config.js')
  return { ...actual, getHubspotConfig: async () => ({ accessToken: 'x', portalId: 1, portalName: null, accountType: null, uiDomain: null, lastCheck: null }) }
})

const enqueue = vi.fn(async (_args: unknown) => ({ pushId: 'p1', status: 'pending' }))
vi.mock('../services/crm/notePush.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/notePush.js')>('../services/crm/notePush.js')
  return { ...actual, enqueuePush: (args: unknown) => enqueue(args) }
})

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

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let hubspotProvider: typeof import('../services/crm/hubspotProvider.js')['hubspotProvider']
let app: express.Express
let currentUserId = ''

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  hubspotProvider = (await import('../services/crm/hubspotProvider.js')).hubspotProvider
  const { setCrmProviderId } = await import('../services/crm/providerSetting.js')
  await setCrmProviderId('hubspot')
  const { notesRouter } = await import('./notes.js')
  app = express()
  app.use(express.json())
  app.use('/api/notes', notesRouter)
})

beforeEach(() => {
  enqueue.mockClear()
})

async function makeUser(email: string) {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email, displayName: email }).returning()
  return u!
}

async function post(path: string, body: unknown): Promise<{ status: number; body: { error: string | null } }> {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as never }
  } finally {
    server.close()
  }
}

describe('HubSpot session', () => {
  it('is only given to a user matched to an active HubSpot user', async () => {
    const matched = await makeUser('lee@acme.example')
    const archived = await makeUser('old@acme.example')
    const none = await makeUser('nobody@acme.example')
    await testDb.insert(schema.hubspotOwners).values([
      { id: '5', email: 'lee@acme.example' },
      { id: '6', email: 'old@acme.example', archived: true },
    ])
    expect(await hubspotProvider.connectForUser(matched.id)).not.toBeNull()
    expect(await hubspotProvider.connectForUser(archived.id)).toBeNull()
    expect(await hubspotProvider.connectForUser(none.id)).toBeNull()
  })
})

describe('POST /api/notes/:id/push', () => {
  async function noteOn(whatType: 'Opportunity' | 'Account', whatId: string, accountId: string | null) {
    const author = await makeUser(`a-${crypto.randomUUID()}@acme.example`)
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    const [act] = await testDb.insert(schema.activities).values({
      userId: author.id, teamId: team!.id, title: 'Demo', activityTypeId: type!.id,
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1',
      crmWhatId: whatId, crmWhatType: whatType, crmAccountId: accountId,
    }).returning()
    const [note] = await testDb.insert(schema.activityNotes).values({ activityId: act!.id, body: 'hi', createdBy: author.id }).returning()
    currentUserId = author.id
    return note!
  }

  it('posts to the activity\'s own Deal and its Company', async () => {
    const note = await noteOn('Opportunity', '1001', '2001')
    const res = await post(`/api/notes/${note.id}/push`, { targets: [
      { crmType: 'Opportunity', sfId: '1001' },
      { crmType: 'Account', sfId: '2001' },
    ] })
    expect(res.status).toBe(202)
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('refuses any other record', async () => {
    const note = await noteOn('Opportunity', '1002', '2002')
    for (const target of [
      { crmType: 'Opportunity', sfId: '9999' },
      { crmType: 'Account', sfId: '9999' },
      { crmType: 'Account', sfId: '1002' },
    ]) {
      const res = await post(`/api/notes/${note.id}/push`, { targets: [target] })
      expect(res).toMatchObject({ status: 400, body: { error: 'errors.notes.push_target_not_linked' } })
    }
    // One bad target refuses the whole request.
    const mixed = await post(`/api/notes/${note.id}/push`, { targets: [{ crmType: 'Opportunity', sfId: '1002' }, { crmType: 'Account', sfId: '9999' }] })
    expect(mixed.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('on an Account-linked activity, allows only that Company', async () => {
    const note = await noteOn('Account', '3001', null)
    expect((await post(`/api/notes/${note.id}/push`, { targets: [{ crmType: 'Account', sfId: '3001' }] })).status).toBe(202)
    expect((await post(`/api/notes/${note.id}/push`, { targets: [{ crmType: 'Opportunity', sfId: '3001' }] })).status).toBe(400)
  })
})
