// Demo Gong data (v1.459.0) against pglite, with no Gong connection: the
// Transcripts tab shows for a demo-team activity only, reads its transcript
// from the cache without calling Gong, and never mixes demo and real calls.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../services/audit/log.js', () => ({ logAudit: async () => {} }))
const gongRequest = vi.fn(async () => { throw new Error('Gong must not be called for demo data') })
vi.mock('../services/gong/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/gong/client.js')>('../services/gong/client.js')
  return { ...actual, gongRequest }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let base = ''
let currentUserId = ''

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: unknown; error: string | null } }
}

const start = new Date('2026-10-28T15:00:00Z')
let demoActId = ''
let realActId = ''

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  const { gongRouter } = await import('./gong.js')
  const { aiNotesRouter } = await import('./aiNotes.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/gong', gongRouter)
  app.use('/api/ai-notes', aiNotesRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const { DEMO_TEAM_SLUG } = await import('../services/demo/ids.js')
  const [demoTeam] = await testDb.insert(schema.teams).values({ name: '[Demo] SE', slug: DEMO_TEAM_SLUG, aiNotesEnabled: true }).returning()
  const [realTeam] = await testDb.insert(schema.teams).values({ name: 'Real', slug: 'real', aiNotesEnabled: true }).returning()
  const email = 'owner@example.com'
  const [user] = await testDb.insert(schema.users).values({ oktaId: 'okta-owner', email, displayName: 'Owner' }).returning()
  currentUserId = user!.id
  for (const t of [demoTeam!, realTeam!]) await testDb.insert(schema.teamMembers).values({ teamId: t.id, userId: user!.id, role: 'contributor' })
  await testDb.insert(schema.rolePermissions).values([
    { role: 'contributor', pageKey: 'activities.transcripts', hasAccess: true },
    { role: 'contributor', pageKey: 'activities.ai_notes', hasAccess: true },
  ]).onConflictDoNothing()
  const mk = async (teamId: string, title: string) => {
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId, name: 'Demo', sortOrder: 1 }).returning()
    const [act] = await testDb.insert(schema.activities).values({
      userId: user!.id, teamId, title, activityTypeId: type!.id, status: 'submitted',
      startDatetime: start, endDatetime: new Date(start.getTime() + 3600_000), effortHours: '1.00',
    }).returning()
    return act!.id
  }
  demoActId = await mk(demoTeam!.id, 'Demo-team meeting')
  realActId = await mk(realTeam!.id, 'Real meeting')
  const near = new Date(start.getTime() + 120_000)
  await testDb.insert(schema.gongCalls).values([
    { id: 'demo-gong-000001', title: 'Demo-team meeting', startedAt: near, durationS: 1800, partyEmails: [email] },
    { id: '777', title: 'Real meeting', startedAt: near, durationS: 1800, partyEmails: [email] },
  ])
  await testDb.insert(schema.gongTranscriptCache).values({
    gongCallId: 'demo-gong-000001',
    monologues: [{ speakerId: '1', topic: null, sentences: [{ start: 0, text: 'Hello.' }] }],
  })
  await testDb.insert(schema.activityGongCalls).values({ activityId: demoActId, gongCallId: 'demo-gong-000001', linkMethod: 'auto' })
})

describe('demo Gong data without a Gong connection', () => {
  it('shows the Transcripts tab for a demo activity only', async () => {
    expect((await call('GET', `/api/gong/status?activityId=${demoActId}`)).json.data).toEqual({ enabled: true })
    expect((await call('GET', `/api/gong/status?activityId=${realActId}`)).json.data).toEqual({ enabled: false })
    expect((await call('GET', `/api/gong/activities/${realActId}/calls`)).status).toBe(404)
  })

  it('serves the demo transcript from the cache without calling Gong', async () => {
    const r = await call('GET', `/api/gong/activities/${demoActId}/calls/demo-gong-000001/transcript`)
    expect(r.status).toBe(200)
    expect(gongRequest).not.toHaveBeenCalled()
  })

  it('never offers or links a real call on a demo activity', async () => {
    const s = await call('GET', `/api/gong/activities/${demoActId}/search`)
    expect((s.json.data as Array<{ id: string }>).map((c) => c.id)).toEqual(['demo-gong-000001'])
    expect((await call('POST', `/api/gong/activities/${demoActId}/calls`, { gongCallId: '777' })).status).toBe(404)
  })

  it('shows AI Notes on the demo team without the AI Assistant, with Generate off', async () => {
    const v = await call('GET', `/api/ai-notes/activities/${demoActId}`)
    expect(v.json.data).toMatchObject({ enabled: true, canGenerate: false, blockedReason: 'demo_data' })
    expect((await call('GET', `/api/ai-notes/activities/${realActId}`)).json.data).toMatchObject({ enabled: false })
    const g = await call('POST', `/api/ai-notes/activities/${demoActId}/generate`)
    expect(g.status).toBe(409)
  })
})
