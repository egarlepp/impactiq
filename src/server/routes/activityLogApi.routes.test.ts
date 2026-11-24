// POST /api/v1/activities/log (v1.481.0): DemoIQ logs a demo as a draft for a
// user it names by email. Only activities:log keys held by an App Admin get
// in, a retry with the same externalRef never logs twice, and nothing is
// submitted or sent to the CRM. Real route against pglite.
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
let drizzle: typeof import('drizzle-orm')

let adminKey = ''
let adminRestKey = ''
let leaderLogKey = ''
let anaId = ''
let seTeamId = ''
let otherTeamId = ''

async function makeUser(name: string, extra: Record<string, unknown> = {}) {
  const [u] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@Example.com`,
    displayName: name,
    ...extra,
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
  drizzle = await import('drizzle-orm')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  apiKeysLib = await import('../services/auth/apiKeys.js')
  const { activityLogApiRouter } = await import('./activityLogApi.js')
  app = express()
  app.use(express.json())
  app.use('/api/v1', activityLogApiRouter)

  const [team] = await testDb.insert(schema.teams).values({ name: 'Alpha SE', slug: `se-${crypto.randomUUID()}` }).returning()
  const [other] = await testDb.insert(schema.teams).values({ name: 'Zulu Channel', slug: `o-${crypto.randomUUID()}` }).returning()
  seTeamId = team!.id
  otherTeamId = other!.id
  await testDb.insert(schema.teamActivityTypes).values([
    { teamId: team!.id, name: 'Demo', sortOrder: 1 },
    { teamId: team!.id, name: 'Old Type', sortOrder: 2, isActive: false },
    { teamId: other!.id, name: 'Demo', sortOrder: 1 },
  ])
  // A type another team owns and shares with Alpha SE.
  const [shared] = await testDb.insert(schema.teamActivityTypes).values({ teamId: other!.id, name: 'Workshop', sortOrder: 3 }).returning()
  await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: shared!.id, teamId: team!.id })

  const admin = await makeUser('Ada Admin', { isAppAdmin: true })
  const leader = await makeUser('Lee Leader')
  const ana = await makeUser('Ana SE')
  const bo = await makeUser('Bo SE', { defaultTeamId: other!.id })
  await makeUser('Gone User', { disabledAt: new Date() })
  await makeUser('Loner')
  anaId = ana.id
  await testDb.insert(schema.teamMembers).values([
    { teamId: team!.id, userId: leader.id, role: 'leader' },
    { teamId: team!.id, userId: ana.id, role: 'contributor' },
    { teamId: team!.id, userId: bo.id, role: 'contributor' },
    { teamId: other!.id, userId: bo.id, role: 'contributor' },
  ])
  adminKey = await makeKey(admin.id, ['activities:log'])
  adminRestKey = await makeKey(admin.id, ['rest:full'])
  leaderLogKey = await makeKey(leader.id, ['activities:log'])
})

type Body = { data: Record<string, unknown> | null; error: string | null; meta: Record<string, unknown> }

async function post(body: unknown, key?: string) {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (key) headers['authorization'] = `Bearer ${key}`
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/activities/log`, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Body }
  } finally {
    server.close()
  }
}

const demo = (over: Record<string, unknown> = {}) => ({
  ownerEmail: 'ANA.SE@example.com',
  title: 'Demo: Threat Prevention for Acme',
  startDatetime: '2026-11-20T15:00:00Z',
  endDatetime: '2026-11-20T16:30:00Z',
  notes: 'Showed lockdown policies. Next step: POC scoping call.',
  attendees: [{ name: 'Pat Prospect', email: 'pat@acme.test' }],
  externalRef: `demoiq:run:${crypto.randomUUID()}`,
  ...over,
})

describe('POST /api/v1/activities/log', () => {
  it('refuses no key, a REST key and a key whose owner is not an App Admin', async () => {
    expect((await post(demo())).status).toBe(401)
    const rest = await post(demo(), adminRestKey)
    expect(rest.status).toBe(403)
    expect(rest.body.error).toBe('errors.apikey.wrong_scope')
    expect((await post(demo(), leaderLogKey)).status).toBe(403)
  })

  it('logs a draft Demo on the person\'s team, never queued for the CRM', async () => {
    const body = demo()
    const res = await post(body, adminKey)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ status: 'draft', deduped: false, ownerEmail: 'ana.se@example.com', teamId: seTeamId, activityType: 'Demo' })
    const [row] = await testDb.select().from(schema.activities).where(drizzle.eq(schema.activities.id, res.body.data!['activityId'] as string))
    expect(row).toMatchObject({ userId: anaId, status: 'draft', effortHours: '1.50', externalRef: body.externalRef, crmSyncStatus: null, crmWhatId: null })
    expect(row!.notes).toContain('POC scoping')
    const audits = await testDb.select().from(schema.auditEvents).where(drizzle.eq(schema.auditEvents.action, 'activity.log_via_api'))
    expect(audits.some((a) => a.targetId === row!.id)).toBe(true)
  })

  it('returns the same activity for a retried externalRef', async () => {
    const body = demo()
    const first = await post(body, adminKey)
    const again = await post({ ...body, title: 'changed' }, adminKey)
    expect(again.status).toBe(200)
    expect(again.body.data).toMatchObject({ activityId: first.body.data!['activityId'], deduped: true })
    const rows = await testDb.select().from(schema.activities).where(drizzle.eq(schema.activities.externalRef, body.externalRef))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe(body.title)
    // The same ref for someone else is a conflict, not a silent reuse.
    expect((await post({ ...body, ownerEmail: 'bo.se@example.com' }, adminKey)).status).toBe(409)
  })

  it('uses the default team, and shared types by name in any case', async () => {
    const bo = await post(demo({ ownerEmail: 'bo.se@example.com' }), adminKey)
    expect(bo.body.data).toMatchObject({ teamId: otherTeamId, teamName: 'Zulu Channel' })
    const shared = await post(demo({ activityType: 'workshop', effortHours: 2 }), adminKey)
    expect(shared.status).toBe(201)
    expect(shared.body.data).toMatchObject({ activityType: 'Workshop', teamId: seTeamId })
  })

  it('explains what it could not do', async () => {
    expect((await post(demo({ ownerEmail: 'nobody@example.com' }), adminKey)).body.error).toBe('errors.activity_log.user_not_found')
    expect((await post(demo({ ownerEmail: 'gone.user@example.com' }), adminKey)).body.error).toBe('errors.activity_log.user_disabled')
    expect((await post(demo({ ownerEmail: 'loner@example.com' }), adminKey)).body.error).toBe('errors.activity_log.no_team')
    expect((await post(demo({ activityType: 'Old Type' }), adminKey)).body.error).toBe('errors.activity_log.type_not_found')
    const bad = await post(demo({ endDatetime: '2026-11-20T14:00:00Z', externalRef: 'has spaces' }), adminKey)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('errors.activity_log.invalid_request')
    expect((bad.body.meta['issues'] as { path: string }[]).map((i) => i.path).sort()).toEqual(['endDatetime', 'externalRef'])
  })
})
