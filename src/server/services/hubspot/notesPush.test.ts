// Note push to HubSpot: the note body, then the push worker against pglite
// with HubSpot's API mocked: create + associate, an association HubSpot
// refuses (the orphan note is deleted), a Salesforce target id, and no
// HubSpot connection.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

type Req = { method?: string; body?: unknown }
const request = vi.fn(async (_path: string, _opts?: Req): Promise<{ status: number; body: unknown }> => ({ status: 200, body: {} }))
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts) }
})

let configured = true
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return { ...actual, getHubspotConfig: async () => (configured ? { portalId: 1 } : null) }
})

vi.mock('./owners.js', async () => {
  const actual = await vi.importActual<typeof import('./owners.js')>('./owners.js')
  return { ...actual, getHubspotOwnerIdForUser: async () => '77' }
})

import { buildHubspotNoteBody } from './notesPush.js'

describe('buildHubspotNoteBody', () => {
  it('puts the escaped title first, then the note rendered from Markdown', () => {
    const html = buildHubspotNoteBody('ImpactIQ: Demo - A & B <x>', '**Bold** note')
    expect(html.startsWith('<p><strong>ImpactIQ: Demo - A &amp; B &lt;x&gt;</strong></p>')).toBe(true)
    expect(html).toContain('<b>Bold</b> note')
  })
})

let np: typeof import('./notesPush.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  np = await import('./notesPush.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  request.mockReset()
  configured = true
  await testDb.delete(schema.activitySyncAudit)
  await testDb.delete(schema.activityNotePushes)
})

async function seed(target: { type: string; id: string }) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  const [activity] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'Acme demo', activityTypeId: type!.id, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
  }).returning()
  const [note] = await testDb.insert(schema.activityNotes).values({ activityId: activity!.id, body: 'Customer liked it', createdBy: user!.id }).returning()
  const [push] = await testDb.insert(schema.activityNotePushes).values({
    activityNoteId: note!.id, pushedBy: user!.id, crmTargetType: target.type, crmTargetId: target.id, crmTargetName: 'Acme',
  }).returning()
  return push!
}

async function reload(id: string) {
  const [row] = await testDb.select().from(schema.activityNotePushes).where(eq(schema.activityNotePushes.id, id))
  return row!
}

function paths(): string[] {
  return request.mock.calls.map(([p, o]) => `${o?.method ?? 'GET'} ${p}`)
}

describe('pushHubspotNote', () => {
  it('creates the note, links it to the Deal and marks the push synced', async () => {
    const push = await seed({ type: 'Opportunity', id: '356553095874' })
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '8001' } } : { status: 200, body: {} }))

    await np.pushHubspotNote(push.id)

    expect(paths()).toEqual(['POST /crm/v3/objects/notes', 'PUT /crm/v4/objects/notes/8001/associations/default/deals/356553095874'])
    const sent = request.mock.calls[0]![1]!.body as { properties: Record<string, string> }
    expect(sent.properties['hubspot_owner_id']).toBe('77')
    expect(sent.properties['hs_note_body']).toContain('ImpactIQ: Demo - Acme demo')
    expect(sent.properties['hs_note_body']).toContain('Customer liked it')
    expect(await reload(push.id)).toMatchObject({ status: 'synced', crmContentNoteId: '8001', error: null })
    const audit = await testDb.select().from(schema.activitySyncAudit)
    expect(audit[0]).toMatchObject({ source: 'note_push', status: 'success', crmObject: 'notes', crmRecordId: '8001' })
  })

  it('links an Account target to the Company', async () => {
    const push = await seed({ type: 'Account', id: '12' })
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '8002' } } : { status: 200, body: {} }))
    await np.pushHubspotNote(push.id)
    expect(paths()[1]).toBe('PUT /crm/v4/objects/notes/8002/associations/default/companies/12')
  })

  it('deletes the note again when HubSpot refuses the association', async () => {
    const push = await seed({ type: 'Opportunity', id: '356553095874' })
    request.mockImplementation(async (_p, opts) => {
      if (opts?.method === 'POST') return { status: 201, body: { id: '8003' } }
      if (opts?.method === 'PUT') return { status: 404, body: { message: 'deal not found' } }
      return { status: 204, body: null }
    })
    await np.pushHubspotNote(push.id)
    expect(paths()).toContain('DELETE /crm/v3/objects/notes/8003')
    const row = await reload(push.id)
    expect(row.status).toBe('failed')
    expect(row.error).toContain('HubSpot 404: deal not found')
    const audit = await testDb.select().from(schema.activitySyncAudit)
    expect(audit[0]).toMatchObject({ source: 'note_push', status: 'failed' })
  })

  it('never sends a Salesforce id to HubSpot', async () => {
    const push = await seed({ type: 'Opportunity', id: '006000000000001AAA' })
    await np.pushHubspotNote(push.id)
    expect(request).not.toHaveBeenCalled()
    expect((await reload(push.id)).error).toContain('Not a HubSpot record')
  })

  it('fails without calling HubSpot when it isn\'t connected', async () => {
    configured = false
    const push = await seed({ type: 'Opportunity', id: '356553095874' })
    await np.pushHubspotNote(push.id)
    expect(request).not.toHaveBeenCalled()
    expect(await reload(push.id)).toMatchObject({ status: 'failed', error: 'HubSpot is not connected' })
  })

  it('skips a push that isn\'t pending', async () => {
    const push = await seed({ type: 'Opportunity', id: '356553095874' })
    await testDb.update(schema.activityNotePushes).set({ status: 'synced' }).where(eq(schema.activityNotePushes.id, push.id))
    await np.pushHubspotNote(push.id)
    expect(request).not.toHaveBeenCalled()
  })
})
