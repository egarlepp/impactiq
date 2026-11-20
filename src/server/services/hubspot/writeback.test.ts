// HubSpot activity write-back: the payload builder and association targets
// (plain unit tests), then the sync worker against pglite with HubSpot's API
// mocked: create, update after a relink, a deleted engagement, failed
// associations, and team-scoped field mappings.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'
import type { HubspotMappingRow } from './mappings.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

type Req = { method?: string; body?: unknown; query?: Record<string, unknown> }
const request = vi.fn(async (_path: string, _opts?: Req): Promise<{ status: number; body: unknown }> => ({ status: 200, body: {} }))
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts) }
})

const attendeeContacts = vi.fn(async () => [] as Array<{ id: string; properties: Record<string, string> }>)
// Meetings already in HubSpot (logged by HubSpot's calendar sync).
const meetingSearch = vi.fn(async (_body: unknown) => [] as Array<{ id: string; properties: Record<string, string> }>)
vi.mock('./search.js', async () => {
  const actual = await vi.importActual<typeof import('./search.js')>('./search.js')
  return { ...actual, hubspotSearch: (type: string, body: unknown) => (type === 'meetings' ? meetingSearch(body) : attendeeContacts()) }
})

vi.mock('./owners.js', async () => {
  const actual = await vi.importActual<typeof import('./owners.js')>('./owners.js')
  return { ...actual, getHubspotOwnerIdForUser: async () => '77' }
})

import { associationTargets, buildHubspotEngagement } from './writeback.js'
import { pickMatchingMeeting, toMeetingCandidate, type MeetingCandidate } from './meetingMatch.js'

const ACTIVITY = {
  title: 'Acme demo',
  notes: 'Went well',
  descriptionBody: 'Agenda: demo',
  meetingOwner: 'Ana Silva',
  startDatetime: new Date('2026-10-20T15:00:00Z'),
  endDatetime: new Date('2026-10-20T16:00:00Z'),
  effortHours: '1.50',
}

function mapping(appField: string, property: string, extra: Partial<HubspotMappingRow> = {}): HubspotMappingRow {
  return { appField, property, crmObject: 'meetings', direction: 'write', isActive: true, constantValue: null, refreshOnlyForReports: false, ...extra }
}

describe('buildHubspotEngagement', () => {
  it('writes HubSpot\'s standard meeting properties with no mappings', () => {
    expect(buildHubspotEngagement({ activity: ACTIVITY, activityTypeName: 'Demo', picklistValueOverride: null, objectType: 'meetings', mappings: [], ownerId: '77' })).toEqual({
      hs_timestamp: '2026-10-20T15:00:00.000Z',
      hs_meeting_title: 'Acme demo',
      hs_meeting_start_time: '2026-10-20T15:00:00.000Z',
      hs_meeting_end_time: '2026-10-20T16:00:00.000Z',
      hs_meeting_body: 'Went well',
      hubspot_owner_id: '77',
    })
  })

  it('writes a task as completed, with no start/end properties', () => {
    const props = buildHubspotEngagement({ activity: ACTIVITY, activityTypeName: 'Demo', picklistValueOverride: null, objectType: 'tasks', mappings: [], ownerId: null })
    expect(props).toEqual({ hs_timestamp: '2026-10-20T15:00:00.000Z', hs_task_subject: 'Acme demo', hs_task_body: 'Went well', hs_task_status: 'COMPLETED' })
  })

  it('follows mappings: redirects, skips read-only fields, sends mapped-only fields, constants last', () => {
    const props = buildHubspotEngagement({
      activity: ACTIVITY, activityTypeName: 'Demo', picklistValueOverride: 'DEMO_CALL', objectType: 'meetings', ownerId: '77',
      mappings: [
        mapping('title', 'custom_title'),
        mapping('notes', 'hs_meeting_body', { direction: 'read' }),
        mapping('activity_type', 'hs_activity_type'),
        mapping('effort_hours', 'effort_hours_logged'),
        mapping('description', 'meeting_description'),
        mapping('_constant', 'hs_meeting_outcome', { constantValue: 'COMPLETED' }),
        mapping('title', 'ignored_other_object', { crmObject: 'tasks' }),
      ],
    })
    expect(props['custom_title']).toBe('Acme demo')
    expect(props).not.toHaveProperty('hs_meeting_title')
    expect(props).not.toHaveProperty('hs_meeting_body')
    expect(props['hs_activity_type']).toBe('DEMO_CALL')
    expect(props['effort_hours_logged']).toBe('1.5')
    expect(props['meeting_description']).toBe('Meeting Owner = Ana Silva\n\nAgenda: demo')
    expect(props['hs_meeting_outcome']).toBe('COMPLETED')
    expect(props).not.toHaveProperty('ignored_other_object')
  })

  it('leaves the owner out when the user matches no HubSpot owner', () => {
    expect(buildHubspotEngagement({ activity: ACTIVITY, activityTypeName: 'Demo', picklistValueOverride: null, objectType: 'meetings', mappings: [], ownerId: null })).not.toHaveProperty('hubspot_owner_id')
  })

  it('an adopted meeting keeps HubSpot\'s title, times, owner and body, and takes notes as internal notes', () => {
    expect(buildHubspotEngagement({ activity: ACTIVITY, activityTypeName: 'Demo', picklistValueOverride: null, objectType: 'meetings', mappings: [], ownerId: '77', adopted: true }))
      .toEqual({ hs_internal_meeting_notes: 'Went well' })
    const props = buildHubspotEngagement({
      activity: ACTIVITY, activityTypeName: 'Demo', picklistValueOverride: null, objectType: 'meetings', ownerId: '77', adopted: true,
      mappings: [
        mapping('notes', 'hs_meeting_body'),
        mapping('activity_type', 'hs_activity_type'),
        mapping('description', 'meeting_description'),
        mapping('_constant', 'hs_meeting_title', { constantValue: 'Overwrite' }),
        mapping('_constant', 'hs_meeting_outcome', { constantValue: 'COMPLETED' }),
      ],
    })
    expect(props).toEqual({ hs_internal_meeting_notes: 'Went well', hs_activity_type: 'Demo', hs_meeting_outcome: 'COMPLETED' })
  })
})

describe('pickMatchingMeeting', () => {
  const target = { ownerId: '77', title: 'Acme demo', start: new Date('2026-10-20T15:00:00Z'), end: new Date('2026-10-20T16:00:00Z') }
  const at = (iso: string) => Date.parse(iso)
  const c = (id: string, extra: Partial<MeetingCandidate> = {}): MeetingCandidate => ({
    id, ownerId: '77', title: 'Acme demo', start: at('2026-10-20T15:00:00Z'), end: at('2026-10-20T16:00:00Z'), ...extra,
  })

  it('takes the same owner\'s meeting at the same times, within a minute either way', () => {
    expect(pickMatchingMeeting([c('1', { start: at('2026-10-20T15:00:45Z'), end: at('2026-10-20T15:59:30Z') })], target, new Set())).toBe('1')
  })
  it('ignores another owner, a different end, no end time, or an id another activity holds', () => {
    expect(pickMatchingMeeting([
      c('1', { ownerId: '78' }),
      c('2', { end: at('2026-10-20T15:30:00Z') }),
      c('3', { end: null }),
      c('4', { start: at('2026-10-20T15:02:00Z') }),
      c('5'),
    ], target, new Set(['5']))).toBeNull()
  })
  it('prefers the one with the same title, then the oldest', () => {
    expect(pickMatchingMeeting([c('30', { title: 'Other' }), c('20', { title: ' ACME DEMO ' }), c('10', { title: 'Another' })], target, new Set())).toBe('20')
    expect(pickMatchingMeeting([c('30', { title: 'X' }), c('10', { title: 'Y' })], target, new Set())).toBe('10')
  })
  it('reads HubSpot\'s epoch-millisecond and ISO times', () => {
    const fromHubspot = toMeetingCandidate({ id: '9', properties: { hubspot_owner_id: '77', hs_meeting_title: 'Acme demo', hs_timestamp: String(at('2026-10-20T15:00:00Z')), hs_meeting_end_time: '2026-10-20T16:00:00Z' } })
    expect(fromHubspot).toEqual(c('9'))
  })
})

describe('associationTargets', () => {
  it('links a Deal and its Company, plus the contact in the Who slot', () => {
    expect(associationTargets({ crmWhatId: '356553095874', crmWhatType: 'Opportunity', crmAccountId: '12', crmWhoId: '1', crmWhoType: 'Contact' }))
      .toEqual({ deals: ['356553095874'], companies: ['12'], contacts: ['1'], leads: [], campaign: null })
  })

  it('links a Company directly and a Lead as a lead', () => {
    expect(associationTargets({ crmWhatId: '12', crmWhatType: 'Account', crmAccountId: null, crmWhoId: '40', crmWhoType: 'Lead' }))
      .toEqual({ deals: [], companies: ['12'], contacts: [], leads: ['40'], campaign: null })
  })

  it('never sends a Salesforce id to HubSpot', () => {
    expect(associationTargets({ crmWhatId: '006000000000001AAA', crmWhatType: 'Opportunity', crmAccountId: '001000000000001AAA', crmWhoId: '003000000000001AAA', crmWhoType: 'Contact' }))
      .toEqual({ deals: [], companies: [], contacts: [], leads: [], campaign: null })
  })

  it('takes a Marketing Hub campaign by its UUID, never a Salesforce Campaign id', () => {
    expect(associationTargets({ crmWhatId: 'A1B2C3D4-0000-4000-8000-00000000AAAA', crmWhatType: 'Campaign', crmAccountId: null, crmWhoId: null, crmWhoType: null }).campaign)
      .toBe('a1b2c3d4-0000-4000-8000-00000000aaaa')
    expect(associationTargets({ crmWhatId: '701000000000001AAA', crmWhatType: 'Campaign', crmAccountId: null, crmWhoId: null, crmWhoType: null }).campaign).toBeNull()
  })
})

// ── Sync worker (pglite) ─────────────────────────────────────────────────

let wb: typeof import('./writeback.js')
let mappings: typeof import('./mappings.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  wb = await import('./writeback.js')
  mappings = await import('./mappings.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  request.mockReset()
  attendeeContacts.mockReset()
  attendeeContacts.mockResolvedValue([])
  meetingSearch.mockReset()
  meetingSearch.mockResolvedValue([])
  await (await import('../crm/features.js')).setCrmFeatures({ hubspotCreateMeetings: true })
  await testDb.delete(schema.activitySyncAudit)
  await testDb.delete(schema.activities)
  await testDb.delete(schema.crmFieldMappingTeams)
  await testDb.delete(schema.crmFieldMappings)
})

async function seed(fields: Partial<typeof schema.activities.$inferInsert> = {}, crmObjectType: 'Event' | 'Task' = 'Event') {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1, crmObjectType }).returning()
  const [activity] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'Acme demo', activityTypeId: type!.id, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    crmWhatId: '356553095874', crmWhatType: 'Opportunity', crmAccountId: '12', crmSyncStatus: 'pending', ...fields,
  }).returning()
  return { team: team!, activity: activity! }
}

async function reload(id: string) {
  const [row] = await testDb.select().from(schema.activities).where((await import('drizzle-orm')).eq(schema.activities.id, id))
  return row!
}

function paths(): string[] {
  return request.mock.calls.map(([p, o]) => `${o?.method ?? 'GET'} ${p}`)
}

describe('processHubspotActivitySync', () => {
  it('creates a meeting, links the Deal, Company and attendee contacts, and marks the row synced', async () => {
    const { activity } = await seed({ attendees: [{ name: 'Ana', email: 'Ana@Acme.example' }, { name: 'No email' }] })
    attendeeContacts.mockResolvedValue([{ id: '501', properties: { email: 'ana@acme.example' } }])
    request.mockImplementation(async (path, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9001' } } : { status: 200, body: {} }))

    await wb.processHubspotActivitySync(activity.id)

    expect(paths()).toEqual([
      'POST /crm/v3/objects/meetings',
      'PUT /crm/v4/objects/meetings/9001/associations/default/deals/356553095874',
      'PUT /crm/v4/objects/meetings/9001/associations/default/companies/12',
      'PUT /crm/v4/objects/meetings/9001/associations/default/contacts/501',
    ])
    const sent = request.mock.calls[0]![1]!.body as { properties: Record<string, string> }
    expect(sent.properties).toMatchObject({ hs_meeting_title: 'Acme demo', hubspot_owner_id: '77' })
    const row = await reload(activity.id)
    expect(row).toMatchObject({ crmRecordId: '9001', crmSyncStatus: 'synced', crmSyncError: null, crmSyncAttempts: 0 })
    const audit = await testDb.select().from(schema.activitySyncAudit)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ status: 'success', operation: 'create', crmObject: 'meetings', crmRecordId: '9001' })
  })

  it('writes a Task-type activity as a HubSpot task', async () => {
    const { activity } = await seed({}, 'Task')
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9002' } } : { status: 200, body: {} }))
    await wb.processHubspotActivitySync(activity.id)
    expect(paths()[0]).toBe('POST /crm/v3/objects/tasks')
  })

  it('updates an existing meeting and unlinks a Deal it was relinked away from', async () => {
    const { activity } = await seed({ crmRecordId: '9001', crmAccountId: null })
    request.mockImplementation(async (path, opts) => {
      if (opts?.method === undefined && path.endsWith('/associations/deals')) return { status: 200, body: { results: [{ toObjectId: 111 }, { toObjectId: 356553095874 }] } }
      return { status: 200, body: {} }
    })
    await wb.processHubspotActivitySync(activity.id)
    expect(paths()).toEqual([
      'PATCH /crm/v3/objects/meetings/9001',
      'GET /crm/v4/objects/meetings/9001/associations/deals',
      'DELETE /crm/v4/objects/meetings/9001/associations/deals/111',
      'PUT /crm/v4/objects/meetings/9001/associations/default/deals/356553095874',
    ])
    expect(await reload(activity.id)).toMatchObject({ crmRecordId: '9001', crmSyncStatus: 'synced' })
  })

  it('a meeting deleted in HubSpot fails without retry and clears the id, so Retry creates it again', async () => {
    const { activity } = await seed({ crmRecordId: '9001' })
    request.mockResolvedValue({ status: 404, body: { message: 'Not found' } })
    await wb.processHubspotActivitySync(activity.id)
    const row = await reload(activity.id)
    expect(row).toMatchObject({ crmRecordId: null, crmSyncStatus: 'failed', crmSyncAttempts: 1, crmNextRetryAt: null })
    expect(row.crmSyncError).toContain('404')
  })

  it('a HubSpot server error is retried on the backoff', async () => {
    const { activity } = await seed()
    request.mockResolvedValue({ status: 502, body: { message: 'Bad gateway' } })
    await wb.processHubspotActivitySync(activity.id)
    const row = await reload(activity.id)
    expect(row.crmSyncStatus).toBe('failed')
    expect(row.crmNextRetryAt).not.toBeNull()
    expect(row.crmSyncError).toBe('HubSpot 502: Bad gateway')
  })

  it('keeps the meeting but parks the row as failed when an association is refused', async () => {
    const { activity } = await seed()
    request.mockImplementation(async (path, opts) => {
      if (opts?.method === 'POST') return { status: 201, body: { id: '9003' } }
      if (path.includes('/companies/')) return { status: 400, body: { message: 'bad company' } }
      return { status: 200, body: {} }
    })
    await wb.processHubspotActivitySync(activity.id)
    const row = await reload(activity.id)
    expect(row).toMatchObject({ crmRecordId: '9003', crmSyncStatus: 'failed', crmNextRetryAt: null })
    expect(row.crmSyncError).toContain('companies 12: HubSpot 400: bad company')
  })

  it('skips an activity with nothing in HubSpot to link to', async () => {
    const { activity } = await seed({ crmWhatId: '006000000000001AAA', crmAccountId: null })
    await wb.processHubspotActivitySync(activity.id)
    expect(request).not.toHaveBeenCalled()
    expect(await reload(activity.id)).toMatchObject({ crmSyncStatus: 'failed', crmNextRetryAt: null })
  })

  it('adds a campaign-linked meeting to the campaign as a MEETING_EVENT asset', async () => {
    const campaign = 'a1b2c3d4-0000-4000-8000-00000000aaaa'
    const { activity } = await seed({ crmWhatId: campaign, crmWhatType: 'Campaign', crmAccountId: null, crmWhoId: '1', crmWhoType: 'Contact' })
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9005' } } : { status: 200, body: {} }))
    await wb.processHubspotActivitySync(activity.id)
    expect(paths()).toEqual([
      'POST /crm/v3/objects/meetings',
      'PUT /crm/v4/objects/meetings/9005/associations/default/contacts/1',
      `PUT /marketing/v3/campaigns/${campaign}/assets/MEETING_EVENT/9005`,
    ])
    expect(await reload(activity.id)).toMatchObject({ crmRecordId: '9005', crmSyncStatus: 'synced' })
  })

  it('syncs a meeting linked only to a campaign, and treats an asset already there as done', async () => {
    const campaign = 'a1b2c3d4-0000-4000-8000-00000000aaaa'
    const { activity } = await seed({ crmWhatId: campaign, crmWhatType: 'Campaign', crmAccountId: null })
    request.mockImplementation(async (path, opts) => {
      if (opts?.method === 'POST') return { status: 201, body: { id: '9006' } }
      if (path.startsWith('/marketing/')) return { status: 409, body: { message: 'already an asset' } }
      return { status: 200, body: {} }
    })
    await wb.processHubspotActivitySync(activity.id)
    expect(await reload(activity.id)).toMatchObject({ crmRecordId: '9006', crmSyncStatus: 'synced', crmSyncError: null })
  })

  it('keeps the meeting but reports a campaign HubSpot refuses', async () => {
    const campaign = 'a1b2c3d4-0000-4000-8000-00000000aaaa'
    const { activity } = await seed({ crmWhatId: campaign, crmWhatType: 'Campaign', crmAccountId: null })
    request.mockImplementation(async (path, opts) => {
      if (opts?.method === 'POST') return { status: 201, body: { id: '9007' } }
      if (path.startsWith('/marketing/')) return { status: 403, body: { message: 'missing scope' } }
      return { status: 200, body: {} }
    })
    await wb.processHubspotActivitySync(activity.id)
    const row = await reload(activity.id)
    expect(row).toMatchObject({ crmRecordId: '9007', crmSyncStatus: 'failed' })
    expect(row.crmSyncError).toContain(`campaign ${campaign}: HubSpot 403: missing scope`)
  })

  it('skips a task linked only to a campaign, since campaigns take meetings, not tasks', async () => {
    const { activity } = await seed({ crmWhatId: 'a1b2c3d4-0000-4000-8000-00000000aaaa', crmWhatType: 'Campaign', crmAccountId: null }, 'Task')
    await wb.processHubspotActivitySync(activity.id)
    expect(request).not.toHaveBeenCalled()
    const row = await reload(activity.id)
    expect(row).toMatchObject({ crmSyncStatus: 'failed', crmNextRetryAt: null })
    expect(row.crmSyncError).toContain('campaigns take meetings, not tasks')
  })

  it('uses only the field mappings assigned to the activity\'s team', async () => {
    const { team, activity } = await seed()
    const other = (await testDb.insert(schema.teams).values({ name: 'O', slug: `o-${crypto.randomUUID()}` }).returning())[0]!
    const [mine] = await testDb.insert(schema.crmFieldMappings).values({ teamId: other.id, appField: 'activity_type', crmFieldApi: 'hs_activity_type', crmObject: 'meetings', direction: 'write' }).returning()
    const [theirs] = await testDb.insert(schema.crmFieldMappings).values({ teamId: team.id, appField: 'effort_hours', crmFieldApi: 'effort_logged', crmObject: 'meetings', direction: 'write' }).returning()
    // Assignment lives in the junction: the first row's home team is the
    // other team, but it is assigned to this one; the second is not.
    await testDb.insert(schema.crmFieldMappingTeams).values([{ crmFieldMappingId: mine!.id, teamId: team.id }, { crmFieldMappingId: theirs!.id, teamId: other.id }])

    expect((await mappings.loadHubspotMappings(team.id, ['meetings'])).map((m) => m.appField)).toEqual(['activity_type'])

    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9004' } } : { status: 200, body: {} }))
    await wb.processHubspotActivitySync(activity.id)
    const sent = request.mock.calls[0]![1]!.body as { properties: Record<string, string> }
    expect(sent.properties['hs_activity_type']).toBe('Demo')
    expect(sent.properties).not.toHaveProperty('effort_logged')
  })

  async function mapAcv(teamId: string, direction: 'write' | 'read') {
    const [row] = await testDb.insert(schema.crmFieldMappings).values({ teamId, appField: 'acv', crmFieldApi: 'impactiq_acv', crmObject: 'deals', direction }).returning()
    await testDb.insert(schema.crmFieldMappingTeams).values({ crmFieldMappingId: row!.id, teamId })
  }

  it('writes the activity\'s ACV onto the linked Deal through a writable acv mapping', async () => {
    const { team, activity } = await seed({ acv: '125000.00' })
    await mapAcv(team.id, 'write')
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9005' } } : { status: 200, body: {} }))

    await wb.processHubspotActivitySync(activity.id)

    const acvCall = request.mock.calls.find(([p, o]) => o?.method === 'PATCH' && p === '/crm/v3/objects/deals/356553095874')
    expect(acvCall?.[1]?.body).toEqual({ properties: { impactiq_acv: '125000' } })
    expect((await reload(activity.id)).crmSyncStatus).toBe('synced')
  })

  it('never writes ACV without a writable acv mapping', async () => {
    const { team, activity } = await seed({ acv: '125000.00' })
    await mapAcv(team.id, 'read')
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9006' } } : { status: 200, body: {} }))

    await wb.processHubspotActivitySync(activity.id)

    expect(paths().some((p) => p.startsWith('PATCH /crm/v3/objects/deals/'))).toBe(false)
  })

  it('keeps the activity synced when HubSpot refuses the ACV, and records why', async () => {
    const { team, activity } = await seed({ acv: '50000' })
    await mapAcv(team.id, 'write')
    request.mockImplementation(async (p, opts) => {
      if (opts?.method === 'POST') return { status: 201, body: { id: '9007' } }
      if (opts?.method === 'PATCH' && p.startsWith('/crm/v3/objects/deals/')) return { status: 400, body: { message: 'Property values were not valid' } }
      return { status: 200, body: {} }
    })

    await wb.processHubspotActivitySync(activity.id)

    expect((await reload(activity.id))).toMatchObject({ crmSyncStatus: 'synced', crmSyncError: null })
    const [row] = await testDb.select().from(schema.activitySyncAudit)
    expect((row!.payload as Record<string, unknown>)['acvError']).toBe('HubSpot 400: Property values were not valid')
  })
})

describe('meetings already in HubSpot', () => {
  const synced = (id: string, extra: Record<string, string> = {}) => ({
    id,
    properties: { hubspot_owner_id: '77', hs_meeting_title: 'Acme demo', hs_meeting_start_time: '2026-10-20T15:00:00Z', hs_meeting_end_time: '2026-10-20T16:00:00Z', ...extra },
  })

  it('adopts the meeting HubSpot\'s calendar sync logged instead of creating a second one', async () => {
    const { activity } = await seed({ notes: 'Went well' })
    meetingSearch.mockResolvedValue([synced('7001')])
    request.mockResolvedValue({ status: 200, body: {} })
    await wb.processHubspotActivitySync(activity.id)

    // Searched by owner around the start time.
    const body = meetingSearch.mock.calls[0]![0] as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> }
    expect(body.filterGroups[0]!.filters).toEqual([
      { propertyName: 'hubspot_owner_id', operator: 'EQ', value: '77' },
      { propertyName: 'hs_timestamp', operator: 'GTE', value: String(Date.parse('2026-10-20T14:59:00Z')) },
      { propertyName: 'hs_timestamp', operator: 'LTE', value: String(Date.parse('2026-10-20T15:01:00Z')) },
    ])
    // No POST, no removing links HubSpot made: fill in, then add links.
    expect(paths()).toEqual([
      'PATCH /crm/v3/objects/meetings/7001',
      'PUT /crm/v4/objects/meetings/7001/associations/default/deals/356553095874',
      'PUT /crm/v4/objects/meetings/7001/associations/default/companies/12',
    ])
    const sent = request.mock.calls[0]![1]!.body as { properties: Record<string, string> }
    expect(sent.properties).toEqual({ hs_internal_meeting_notes: 'Went well' })
    expect(await reload(activity.id)).toMatchObject({ crmRecordId: '7001', crmRecordAdopted: true, crmSyncStatus: 'synced' })
    const [audit] = await testDb.select().from(schema.activitySyncAudit)
    expect(audit).toMatchObject({ status: 'success', operation: 'update', crmRecordId: '7001' })
    expect((audit!.payload as Record<string, unknown>)['adopted']).toBe(true)
  })

  it('creates a meeting when the only match belongs to another activity', async () => {
    const { activity } = await seed()
    await seed({ crmRecordId: '7001', crmSyncStatus: 'synced' })
    meetingSearch.mockResolvedValue([synced('7001')])
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9010' } } : { status: 200, body: {} }))
    await wb.processHubspotActivitySync(activity.id)
    expect(paths()[0]).toBe('POST /crm/v3/objects/meetings')
    expect(await reload(activity.id)).toMatchObject({ crmRecordId: '9010', crmRecordAdopted: false })
  })

  it('keeps an adopted meeting add-only on later syncs', async () => {
    const { activity } = await seed({ crmRecordId: '7001', crmRecordAdopted: true, crmAccountId: null })
    request.mockResolvedValue({ status: 200, body: {} })
    await wb.processHubspotActivitySync(activity.id)
    expect(meetingSearch).not.toHaveBeenCalled()
    expect(paths()).toEqual([
      'PATCH /crm/v3/objects/meetings/7001',
      'PUT /crm/v4/objects/meetings/7001/associations/default/deals/356553095874',
    ])
    const sent = request.mock.calls[0]![1]!.body as { properties: Record<string, string> }
    expect(sent.properties).not.toHaveProperty('hs_meeting_title')
    expect(await reload(activity.id)).toMatchObject({ crmRecordAdopted: true, crmSyncStatus: 'synced' })
  })

  it('an adopted meeting deleted in HubSpot clears both the id and the adopted flag', async () => {
    const { activity } = await seed({ crmRecordId: '7001', crmRecordAdopted: true })
    request.mockResolvedValue({ status: 404, body: { message: 'Not found' } })
    await wb.processHubspotActivitySync(activity.id)
    expect(await reload(activity.id)).toMatchObject({ crmRecordId: null, crmRecordAdopted: false, crmSyncStatus: 'failed' })
  })

  it('with meeting creation off, waits for HubSpot to log it and checks again later', async () => {
    await (await import('../crm/features.js')).setCrmFeatures({ hubspotCreateMeetings: false })
    const { activity } = await seed()
    await wb.processHubspotActivitySync(activity.id)
    expect(request).not.toHaveBeenCalled()
    const row = await reload(activity.id)
    expect(row).toMatchObject({ crmRecordId: null, crmSyncStatus: 'failed', crmSyncAttempts: 1 })
    expect(row.crmNextRetryAt).not.toBeNull()
    expect(row.crmSyncError).toContain('turned off')

    // Once HubSpot's sync has logged it, the retry adopts it.
    meetingSearch.mockResolvedValue([synced('7002')])
    request.mockResolvedValue({ status: 200, body: {} })
    await wb.processHubspotActivitySync(activity.id)
    expect(await reload(activity.id)).toMatchObject({ crmRecordId: '7002', crmRecordAdopted: true, crmSyncStatus: 'synced' })
  })

  it('with meeting creation off, tasks are still created', async () => {
    await (await import('../crm/features.js')).setCrmFeatures({ hubspotCreateMeetings: false })
    const { activity } = await seed({}, 'Task')
    request.mockImplementation(async (_p, opts) => (opts?.method === 'POST' ? { status: 201, body: { id: '9011' } } : { status: 200, body: {} }))
    await wb.processHubspotActivitySync(activity.id)
    expect(meetingSearch).not.toHaveBeenCalled()
    expect(paths()[0]).toBe('POST /crm/v3/objects/tasks')
  })

  it('retries rather than creating when the search itself fails', async () => {
    const { activity } = await seed()
    meetingSearch.mockRejectedValue(new Error('search down'))
    await wb.processHubspotActivitySync(activity.id)
    expect(request).not.toHaveBeenCalled()
    const row = await reload(activity.id)
    expect(row).toMatchObject({ crmRecordId: null, crmSyncStatus: 'failed', crmSyncAttempts: 1 })
    expect(row.crmNextRetryAt).not.toBeNull()
  })
})

describe('deleteHubspotEngagement', () => {
  beforeEach(() => request.mockReset())

  it('deletes a meeting, or a task for a Task-type activity', async () => {
    request.mockResolvedValue({ status: 204, body: null })
    expect(await wb.deleteHubspotEngagement('9001', 'Event')).toBeNull()
    expect(await wb.deleteHubspotEngagement('9002', 'Task')).toBeNull()
    expect(paths()).toEqual(['DELETE /crm/v3/objects/meetings/9001', 'DELETE /crm/v3/objects/tasks/9002'])
  })

  it('treats an engagement already gone from HubSpot as deleted', async () => {
    request.mockResolvedValue({ status: 404, body: { message: 'Not found' } })
    expect(await wb.deleteHubspotEngagement('9001', 'Event')).toBeNull()
  })

  it('returns the reason on any other failure, and never sends a Salesforce id', async () => {
    request.mockResolvedValue({ status: 403, body: { message: 'Missing scope' } })
    expect(await wb.deleteHubspotEngagement('9001', 'Event')).toBe('HubSpot 403: Missing scope')
    request.mockReset()
    expect(await wb.deleteHubspotEngagement('00U000000000001AAA', 'Event')).toContain('Not a HubSpot record')
    expect(request).not.toHaveBeenCalled()
  })
})
