// The contributor's core write paths on /api/activities: create (and the
// team-membership check on it), the outlookEventId dedup on create, and PATCH (ownership, the 90-day edit
// window, the draft → submitted transition and when a CRM sync is queued).
// The CRM itself is never called: queueCrmActivitySync is replaced with a spy.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
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

const queueCrmActivitySync = vi.fn()
vi.mock('../services/crm/index.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/index.js')>('../services/crm/index.js')
  return { ...actual, queueCrmActivitySync: (id: string) => queueCrmActivitySync(id) }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let activitiesRouter: typeof import('./activities.js')['activitiesRouter']

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  activitiesRouter = (await import('./activities.js')).activitiesRouter
})

beforeEach(() => {
  queueCrmActivitySync.mockClear()
})

interface Seeded { teamId: string; userId: string; typeId: string }

async function seed(): Promise<Seeded> {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: user!.id, role: 'contributor' })
  currentUserId = user!.id
  return { teamId: team!.id, userId: user!.id, typeId: type!.id }
}

function baseBody(s: Seeded, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    teamId: s.teamId,
    title: 'Demo with Acme',
    activityTypeId: s.typeId,
    startDatetime: '2026-10-20T15:00:00.000Z',
    endDatetime: '2026-10-20T16:00:00.000Z',
    effortHours: 1,
    ...extra,
  }
}

type Row = typeof import('../../../drizzle/schema.js')['activities']['$inferSelect']

async function call(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<{ status: number; data: Row | null; error: string | null; meta: Record<string, unknown> }> {
  const app = express()
  app.use(express.json())
  app.use('/api/activities', activitiesRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/activities${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json() as { data: Row | null; error: string | null; meta: Record<string, unknown> }
    return { status: res.status, ...json }
  } finally {
    server.close()
  }
}

async function insertActivity(s: Seeded, overrides: Partial<Row> = {}): Promise<Row> {
  const [row] = await testDb.insert(schema.activities).values({
    userId: s.userId, teamId: s.teamId, activityTypeId: s.typeId, title: 'Existing',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    ...overrides,
  }).returning()
  return row!
}

describe('POST /api/activities', () => {
  it('creates a draft for the caller and does not queue a CRM sync', async () => {
    const s = await seed()
    const res = await call('POST', '/', baseBody(s, { crmWhatId: '006000000000001', crmWhatType: 'Opportunity', crmWhatName: 'Acme' }))
    expect(res.status).toBe(201)
    expect(res.data?.userId).toBe(s.userId)
    expect(res.data?.status).toBe('draft')
    expect(res.data?.effortHours).toBe('1.00')
    // Linked, so the row is pending, but a draft is never written to the CRM.
    expect(res.data?.crmSyncStatus).toBe('pending')
    expect(queueCrmActivitySync).not.toHaveBeenCalled()
  })

  it('leaves the sync status empty when nothing is linked', async () => {
    const s = await seed()
    const res = await call('POST', '/', baseBody(s))
    expect(res.status).toBe(201)
    expect(res.data?.crmSyncStatus).toBeNull()
  })

  it('rejects an invalid body', async () => {
    const s = await seed()
    const res = await call('POST', '/', baseBody(s, { title: '' }))
    expect(res.status).toBe(400)
    const missingTeam = await call('POST', '/', { ...baseBody(s), teamId: 'not-a-uuid' })
    expect(missingTeam.status).toBe(400)
  })

  it('refuses a team the caller is not on', async () => {
    const s = await seed()
    const [otherTeam] = await testDb.insert(schema.teams).values({ name: 'Other', slug: `o-${crypto.randomUUID()}` }).returning()
    const res = await call('POST', '/', baseBody(s, { teamId: otherTeam!.id }))
    expect(res.status).toBe(403)
    expect(res.error).toBe('errors.forbidden')
    const rows = await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, otherTeam!.id))
    expect(rows).toHaveLength(0)
  })

  it('lets an App Admin log on any active team', async () => {
    const s = await seed()
    await testDb.update(schema.users).set({ isAppAdmin: true }).where(eq(schema.users.id, s.userId))
    const [otherTeam] = await testDb.insert(schema.teams).values({ name: 'Other', slug: `o-${crypto.randomUUID()}` }).returning()
    const [otherType] = await testDb.insert(schema.teamActivityTypes).values({ teamId: otherTeam!.id, name: 'Demo', sortOrder: 1 }).returning()
    const res = await call('POST', '/', baseBody(s, { teamId: otherTeam!.id, activityTypeId: otherType!.id }))
    expect(res.status).toBe(201)
    // The activity type still has to belong to that team (audit M1).
    const wrongType = await call('POST', '/', baseBody(s, { teamId: otherTeam!.id }))
    expect(wrongType.status).toBe(400)
    expect(wrongType.error).toBe('errors.activities.type_not_on_team')
  })

  it('updates the existing row for the same Outlook meeting instead of adding a second one', async () => {
    const s = await seed()
    const first = await call('POST', '/', baseBody(s, { outlookEventId: 'evt-1', title: 'First' }))
    expect(first.status).toBe(201)
    const second = await call('POST', '/', baseBody(s, { outlookEventId: 'evt-1', title: 'Second' }))
    expect(second.status).toBe(200)
    expect(second.meta['deduped']).toBe(true)
    expect(second.data?.id).toBe(first.data?.id)
    const rows = await testDb.select().from(schema.activities).where(eq(schema.activities.outlookEventId, 'evt-1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('Second')
  })

  it('reactivates an archived row for the same Outlook meeting', async () => {
    const s = await seed()
    const archived = await insertActivity(s, { outlookEventId: 'evt-archived', isArchived: true })
    const res = await call('POST', '/', baseBody(s, { outlookEventId: 'evt-archived', title: 'Back again' }))
    expect(res.status).toBe(200)
    expect(res.data?.id).toBe(archived.id)
    expect(res.data?.isArchived).toBe(false)
  })

  it('does not dedup against another user\'s row for the same meeting id', async () => {
    const s = await seed()
    const [other] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'O' }).returning()
    await insertActivity({ ...s, userId: other!.id }, { outlookEventId: 'evt-shared' })
    const res = await call('POST', '/', baseBody(s, { outlookEventId: 'evt-shared' }))
    expect(res.status).toBe(201)
    expect(res.data?.userId).toBe(s.userId)
  })
})

describe('PATCH /api/activities/:id', () => {
  it('lets the owner edit and refuses everyone else', async () => {
    const s = await seed()
    const row = await insertActivity(s)
    const ok = await call('PATCH', `/${row.id}`, { title: 'Renamed' })
    expect(ok.status).toBe(200)
    expect(ok.data?.title).toBe('Renamed')

    const [other] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'O' }).returning()
    currentUserId = other!.id
    const denied = await call('PATCH', `/${row.id}`, { title: 'Hijacked' })
    expect(denied.status).toBe(403)
    const [after] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, row.id))
    expect(after!.title).toBe('Renamed')
  })

  it('answers 404 for an archived or unknown activity', async () => {
    const s = await seed()
    const row = await insertActivity(s, { isArchived: true })
    expect((await call('PATCH', `/${row.id}`, { title: 'x' })).status).toBe(404)
    expect((await call('PATCH', `/${crypto.randomUUID()}`, { title: 'x' })).status).toBe(404)
  })

  it('is read-only 90 days after creation', async () => {
    const s = await seed()
    const row = await insertActivity(s, { createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) })
    const res = await call('PATCH', `/${row.id}`, { title: 'Too late' })
    expect(res.status).toBe(403)
    expect(res.error).toBe('errors.activities.read_only_after_90_days')
  })

  it('submitting a linked draft stamps submittedAt once and queues one CRM sync', async () => {
    const s = await seed()
    const row = await insertActivity(s, { crmWhatId: '006000000000001', crmWhatType: 'Opportunity', crmSyncStatus: 'failed', crmSyncAttempts: 3, crmSyncError: 'old' })
    const res = await call('PATCH', `/${row.id}`, { status: 'submitted' })
    expect(res.status).toBe(200)
    expect(res.data?.status).toBe('submitted')
    expect(res.data?.crmSyncStatus).toBe('pending')
    expect(res.data?.crmSyncAttempts).toBe(0)
    expect(res.data?.crmSyncError).toBeNull()
    expect(res.data?.submittedAt).not.toBeNull()
    expect(queueCrmActivitySync).toHaveBeenCalledTimes(1)
    expect(queueCrmActivitySync).toHaveBeenCalledWith(row.id)

    // Saving again with status unchanged keeps the original approval date.
    const firstSubmittedAt = res.data?.submittedAt
    const again = await call('PATCH', `/${row.id}`, { status: 'submitted', title: 'Edited after approval' })
    expect(again.data?.submittedAt).toBe(firstSubmittedAt)
  })

  it('submitting an activity with no CRM link queues nothing', async () => {
    const s = await seed()
    const row = await insertActivity(s)
    const res = await call('PATCH', `/${row.id}`, { status: 'submitted' })
    expect(res.status).toBe(200)
    expect(res.data?.crmSyncStatus).toBeNull()
    expect(queueCrmActivitySync).not.toHaveBeenCalled()
  })

  it('a client retry on a linked activity re-queues the sync', async () => {
    const s = await seed()
    const row = await insertActivity(s, { status: 'submitted', crmWhatId: '006000000000001', crmWhatType: 'Opportunity', crmSyncStatus: 'failed', crmSyncAttempts: 6 })
    const res = await call('PATCH', `/${row.id}`, { crmSyncStatus: 'pending' })
    expect(res.status).toBe(200)
    expect(res.data?.crmSyncStatus).toBe('pending')
    expect(res.data?.crmSyncAttempts).toBe(0)
    expect(queueCrmActivitySync).toHaveBeenCalledWith(row.id)
  })
})
