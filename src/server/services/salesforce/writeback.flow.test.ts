// The Salesforce write-back flow end to end against pglite, with a fake
// jsforce connection: a pending activity gets created as the right object
// (Event or Task per the activity type), a re-sync updates instead of
// creating a duplicate, failures schedule a retry with backoff and park at
// the cap, and the worker only picks up rows that are due.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

interface FakeCall { object: string; op: 'create' | 'update'; record: Record<string, unknown> }
let calls: FakeCall[] = []
let nextResult: { success: boolean; id?: string; errors?: string[] } | Error = { success: true, id: '00U000000000001' }
let connected = true

const fakeConn = {
  sobject(object: string) {
    const run = async (op: 'create' | 'update', record: Record<string, unknown>) => {
      calls.push({ object, op, record })
      if (nextResult instanceof Error) throw nextResult
      return nextResult
    }
    return {
      create: (record: Record<string, unknown>) => run('create', record),
      update: (record: Record<string, unknown>) => run('update', record),
    }
  },
}

vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, getSfConnection: async () => (connected ? fakeConn : null) }
})

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let wb: typeof import('./writeback.js')

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  wb = await import('./writeback.js')
})

beforeEach(() => {
  calls = []
  nextResult = { success: true, id: '00U000000000001' }
  connected = true
})

type Row = typeof import('../../../../drizzle/schema.js')['activities']['$inferSelect']

async function seed(objectType: 'Event' | 'Task' = 'Event', overrides: Partial<Row> = {}): Promise<Row> {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U', crmUserId: '005000000000001' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1, crmObjectType: objectType }).returning()
  const mappings = [
    { appField: 'title', crmFieldApi: 'Subject' },
    { appField: 'crm_what_id', crmFieldApi: 'WhatId' },
    { appField: 'user_id', crmFieldApi: 'OwnerId' },
  ]
  for (const m of mappings) {
    const [row] = await testDb.insert(schema.crmFieldMappings).values({ teamId: team!.id, appField: m.appField, crmFieldApi: m.crmFieldApi, crmObject: objectType, isActive: true, direction: 'write' }).returning()
    await testDb.insert(schema.crmFieldMappingTeams).values({ crmFieldMappingId: row!.id, teamId: team!.id })
  }
  const [activity] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, activityTypeId: type!.id, title: 'Demo with Acme', status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    crmWhatId: '006000000000001', crmWhatType: 'Opportunity', crmSyncStatus: 'pending',
    ...overrides,
  }).returning()
  return activity!
}

async function reload(id: string): Promise<Row> {
  const [row] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, id))
  return row!
}

describe('processActivitySync', () => {
  it('creates an Event with the mapped fields and marks the activity synced', async () => {
    const a = await seed('Event')
    await wb.processActivitySync(a.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.object).toBe('Event')
    expect(calls[0]!.op).toBe('create')
    expect(calls[0]!.record).toMatchObject({ Subject: 'Demo with Acme', WhatId: '006000000000001', OwnerId: '005000000000001' })
    const after = await reload(a.id)
    expect(after.crmSyncStatus).toBe('synced')
    expect(after.crmRecordId).toBe('00U000000000001')
    expect(after.crmSyncAttempts).toBe(0)
    const audit = await testDb.select().from(schema.activitySyncAudit).where(eq(schema.activitySyncAudit.activityId, a.id))
    expect(audit.some((r) => r.status === 'success' && r.operation === 'create')).toBe(true)
  })

  it('writes a Task when the activity type says Task', async () => {
    const a = await seed('Task')
    await wb.processActivitySync(a.id)
    expect(calls[0]!.object).toBe('Task')
  })

  it('updates the existing record on a re-sync instead of creating a duplicate', async () => {
    const a = await seed('Event', { crmRecordId: '00U000000000999' })
    nextResult = { success: true }
    await wb.processActivitySync(a.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('update')
    expect(calls[0]!.record['Id']).toBe('00U000000000999')
    expect((await reload(a.id)).crmRecordId).toBe('00U000000000999')
  })

  it('a Salesforce error marks it failed and schedules a retry', async () => {
    const a = await seed('Event')
    nextResult = { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: nope'] }
    const before = Date.now()
    await wb.processActivitySync(a.id)
    const after = await reload(a.id)
    expect(after.crmSyncStatus).toBe('failed')
    expect(after.crmSyncError).toContain('nope')
    expect(after.crmSyncAttempts).toBe(1)
    expect(after.crmRecordId).toBeNull()
    expect(after.crmNextRetryAt!.getTime()).toBeGreaterThanOrEqual(before + wb.retryBackoffMs(1) - 1000)
  })

  it('a thrown error is handled the same way', async () => {
    const a = await seed('Event')
    nextResult = new Error('socket hang up')
    await wb.processActivitySync(a.id)
    const after = await reload(a.id)
    expect(after.crmSyncStatus).toBe('failed')
    expect(after.crmSyncError).toBe('socket hang up')
  })

  it('parks the activity for manual retry once the attempt cap is reached', async () => {
    const a = await seed('Event', { crmSyncAttempts: wb.MAX_SYNC_RETRIES - 1 })
    nextResult = { success: false, errors: ['still broken'] }
    await wb.processActivitySync(a.id)
    const after = await reload(a.id)
    expect(after.crmSyncAttempts).toBe(wb.MAX_SYNC_RETRIES)
    expect(after.crmNextRetryAt).toBeNull()
  })

  it('fails without calling Salesforce when the owner has no connection', async () => {
    const a = await seed('Event')
    connected = false
    await wb.processActivitySync(a.id)
    expect(calls).toHaveLength(0)
    const after = await reload(a.id)
    expect(after.crmSyncStatus).toBe('failed')
    expect(after.crmSyncError).toBe('Salesforce not connected')
  })
})

describe('processPendingActivities', () => {
  it('picks up pending rows and failed rows that are due, and nothing else', async () => {
    const pending = await seed('Event')
    const due = await seed('Event', { crmSyncStatus: 'failed', crmSyncAttempts: 1, crmNextRetryAt: new Date(Date.now() - 1000) })
    const notYet = await seed('Event', { crmSyncStatus: 'failed', crmSyncAttempts: 1, crmNextRetryAt: new Date(Date.now() + 60 * 60 * 1000) })
    const parked = await seed('Event', { crmSyncStatus: 'failed', crmSyncAttempts: wb.MAX_SYNC_RETRIES, crmNextRetryAt: null })
    const draft = await seed('Event', { status: 'draft' })

    const seen: string[] = []
    await wb.processPendingActivities(async (id) => { seen.push(id) })
    expect(seen).toContain(pending.id)
    expect(seen).toContain(due.id)
    expect(seen).not.toContain(notYet.id)
    expect(seen).not.toContain(parked.id)
    expect(seen).not.toContain(draft.id)
  })
})
