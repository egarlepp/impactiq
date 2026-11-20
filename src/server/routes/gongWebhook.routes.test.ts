// POST /api/webhooks/gong (v1.456.0, Gong plan phase 3): Gong's signed
// webhook. Real route and real auto-linking against pglite; reading the call
// from Gong is mocked (it writes the call into the index directly).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const fetched: string[][] = []
let callRow: Record<string, unknown> | null = null
vi.mock('../services/gong/calls.js', () => ({
  indexGongCallsById: async (ids: string[]) => {
    fetched.push(ids)
    if (!callRow) return []
    const { db } = await import('../db/index.js')
    const schema = await import('../../../drizzle/schema.js')
    await db.insert(schema.gongCalls).values(callRow as typeof schema.gongCalls.$inferInsert).onConflictDoNothing()
    return [callRow['id'] as string]
  },
}))

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let config: typeof import('../services/gong/config.js')
let base = ''
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function auth(body: string, extra: Record<string, unknown> = {}): Record<string, string> {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'RS256', typ: 'JWT' })
  const p = b64({
    webhook_url: 'https://impactiq.example.com/api/webhooks/gong',
    body_sha256: createHash('sha256').update(body).digest('hex'),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
    ...extra,
  })
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')
  return { 'Content-Type': 'application/json', Authorization: `${h}.${p}.${s}` }
}

async function post(body: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/webhooks/gong`, { method: 'POST', headers, body })
  return { status: res.status, json: await res.json() as { data: Record<string, unknown> | null; error: string | null } }
}

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  config = await import('../services/gong/config.js')
  const { gongWebhookRouter } = await import('./gongWebhook.js')
  const app = express()
  app.use('/api/webhooks/gong', gongWebhookRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(async () => {
  await testDb.delete(schema.systemSettings)
  await testDb.delete(schema.gongWebhookReceipts)
  await testDb.delete(schema.activityGongCalls)
  await testDb.delete(schema.gongLinkDismissals)
  await testDb.delete(schema.gongCalls)
  fetched.length = 0
  callRow = null
})

async function connect(withKey = true) {
  await config.updateGongSettings({ accessKey: 'gong-access-key-0001', accessKeySecret: 'gong-access-secret-0001', webhookPublicKeyPem: withKey ? PEM : null })
}

async function seedActivity(start: Date, outlookEventId: string | null) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const email = `${crypto.randomUUID()}@example.com`
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  const [act] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'Acme demo', activityTypeId: type!.id, status: 'submitted',
    startDatetime: start, endDatetime: new Date(start.getTime() + 60 * 60 * 1000), effortHours: '1.00', outlookEventId,
  }).returning()
  return { act: act!, email }
}

const body = JSON.stringify({ callData: { metaData: { id: '555' } }, isTest: false })

describe('POST /api/webhooks/gong', () => {
  it('answers 404 until Gong is connected with a public key', async () => {
    expect((await post(body, auth(body))).status).toBe(404)
    await connect(false)
    expect((await post(body, auth(body))).status).toBe(404)
  })

  it('refuses a bad signature and a replay', async () => {
    await connect()
    const bad = { ...auth(body), Authorization: auth('{}').Authorization! }
    expect((await post(body, bad)).status).toBe(401)
    const headers = auth(body)
    expect((await post(body, headers)).status).toBe(202)
    const again = await post(body, headers)
    expect(again.status).toBe(200)
    expect(again.json.data).toMatchObject({ duplicate: true })
  })

  it('does nothing for a test delivery', async () => {
    await connect()
    const test = JSON.stringify({ isTest: true })
    const r = await post(test, auth(test))
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ test: true })
    expect(fetched).toEqual([])
  })

  it('reads the call from Gong and links it to the same calendar meeting', async () => {
    await connect()
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const { act } = await seedActivity(start, 'evt-gong-1')
    callRow = { id: '555', title: 'Acme demo', startedAt: start, durationS: 1800, calendarEventId: 'evt-gong-1' }
    expect((await post(body, auth(body))).status).toBe(202)
    await vi.waitFor(async () => {
      const links = await testDb.select().from(schema.activityGongCalls)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ activityId: act.id, gongCallId: '555', linkMethod: 'calendar_event', linkedBy: null })
    })
    expect(fetched).toEqual([['555']])
  })

  it('never puts back a call someone unlinked', async () => {
    await connect()
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const { act } = await seedActivity(start, 'evt-gong-2')
    await testDb.insert(schema.gongLinkDismissals).values({ activityId: act.id, gongCallId: '555' })
    callRow = { id: '555', title: 'Acme demo', startedAt: start, durationS: 1800, calendarEventId: 'evt-gong-2' }
    expect((await post(body, auth(body))).status).toBe(202)
    await vi.waitFor(() => expect(fetched).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 200))
    expect(await testDb.select().from(schema.activityGongCalls)).toHaveLength(0)
  })

  it('links by score only when the owner was on the call', async () => {
    await connect()
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const { act, email } = await seedActivity(start, null)
    await testDb.update(schema.activities).set({ crmWhatId: '006X' }).where((await import('drizzle-orm')).eq(schema.activities.id, act.id))
    callRow = { id: '555', title: 'Acme demo', startedAt: new Date(start.getTime() + 3 * 60 * 1000), durationS: 1800, partyEmails: [email], crmObjectIds: ['006X'] }
    expect((await post(body, auth(body))).status).toBe(202)
    await vi.waitFor(async () => {
      const links = await testDb.select().from(schema.activityGongCalls)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ activityId: act.id, linkMethod: 'auto' })
      expect(links[0]!.matchScore).toBeGreaterThanOrEqual(85)
    })
  })
})

describe('runGongAutoLink', () => {
  it('only runs when Gong is connected and auto-link is on', async () => {
    const { runGongAutoLink } = await import('../services/gong/autoLink.js')
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await seedActivity(start, 'evt-gong-off')
    await testDb.insert(schema.gongCalls).values({ id: '556', title: 'Acme demo', startedAt: start, durationS: 1800, calendarEventId: 'evt-gong-off' })
    expect(await runGongAutoLink()).toBeNull()
    await connect()
    await config.updateGongSettings({ autoLink: false })
    expect(await runGongAutoLink()).toBeNull()
    expect(await testDb.select().from(schema.activityGongCalls)).toHaveLength(0)
    await config.updateGongSettings({ autoLink: true })
    expect((await runGongAutoLink())?.linked).toBeGreaterThanOrEqual(1)
  })
})
