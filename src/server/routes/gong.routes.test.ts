// The Transcripts tab routes (routes/gong.ts) against pglite: suggestions,
// manual link/unlink (an Unlink is remembered, a manual link clears it) and
// the weekly view's /week marks. Gong itself is never called.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { and, eq } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../services/audit/log.js', () => ({ logAudit: async () => {} }))

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let base = ''
let currentUserId = ''

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/gong${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: unknown; error: string | null } }
}

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  const config = await import('../services/gong/config.js')
  await config.updateGongSettings({ accessKey: 'gong-access-key-0001', accessKeySecret: 'gong-access-secret-0001' })
  const { gongRouter } = await import('./gong.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/gong', gongRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

const start = new Date('2026-10-28T15:00:00Z')

beforeEach(async () => {
  await testDb.delete(schema.activityGongCalls)
  await testDb.delete(schema.gongLinkDismissals)
  await testDb.delete(schema.gongCalls)
})

async function seed() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const email = `${crypto.randomUUID()}@example.com`
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email, displayName: 'U' }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: user!.id, role: 'contributor' })
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  const [act] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'Acme demo', activityTypeId: type!.id, status: 'submitted',
    startDatetime: start, endDatetime: new Date(start.getTime() + 3600_000), effortHours: '1.00', outlookEventId: null,
  }).returning()
  const eventId = `evt-${crypto.randomUUID()}`
  await testDb.insert(schema.outlookEvents).values({ id: eventId, userId: user!.id, subject: 'Acme demo', startDatetime: start, endDatetime: new Date(start.getTime() + 3600_000) })
  await testDb.insert(schema.gongCalls).values({ id: '777', title: 'Acme demo', startedAt: new Date(start.getTime() + 120_000), durationS: 1800, partyEmails: [email] })
  currentUserId = user!.id
  return { act: act!, eventId, userId: user!.id }
}

describe('Transcripts routes', () => {
  it('suggests a call the owner was on', async () => {
    const { act } = await seed()
    const r = await call('GET', `/activities/${act.id}/suggestions`)
    expect(r.status).toBe(200)
    expect((r.json.data as Array<{ id: string }>).map((s) => s.id)).toEqual(['777'])
  })

  it('remembers an Unlink, and a manual link clears it', async () => {
    const { act } = await seed()
    expect((await call('POST', `/activities/${act.id}/calls`, { gongCallId: '777' })).status).toBe(200)
    expect((await call('DELETE', `/activities/${act.id}/calls/777`)).status).toBe(200)
    const dismissed = () => testDb.select().from(schema.gongLinkDismissals).where(and(eq(schema.gongLinkDismissals.activityId, act.id), eq(schema.gongLinkDismissals.gongCallId, '777')))
    expect(await dismissed()).toHaveLength(1)
    expect((await call('POST', `/activities/${act.id}/calls`, { gongCallId: '777' })).status).toBe(200)
    expect(await dismissed()).toHaveLength(0)
  })

  it('marks recorded meetings and linked activities for the week', async () => {
    const { act, eventId } = await seed()
    const q = `from=${encodeURIComponent('2026-10-26T00:00:00Z')}&to=${encodeURIComponent('2026-11-02T00:00:00Z')}`
    let r = await call('GET', `/week?${q}`)
    expect(r.status).toBe(200)
    expect(r.json.data).toEqual({ recordedEvents: [eventId], linkedActivities: [] })
    await call('POST', `/activities/${act.id}/calls`, { gongCallId: '777' })
    r = await call('GET', `/week?${q}`)
    expect(r.json.data).toEqual({ recordedEvents: [eventId], linkedActivities: [act.id] })
    expect((await call('GET', '/week?from=bad&to=2026-11-02T00:00:00Z')).status).toBe(400)
  })
})
