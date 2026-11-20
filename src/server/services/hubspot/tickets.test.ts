// Support Tickets on HubSpot: closed stages from the pipelines, the property
// plan (defaults vs mappings), the search filters, row labels, and the
// drawer-open refresh persisting onto activity_crm_tickets (pglite, HubSpot's
// API mocked).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'
import type { HubspotMappingRow } from './mappings.js'
import type { HubspotObject } from './search.js'
import type { PropertyInfo } from './metadata.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const PIPELINES = [{
  id: '0',
  stages: [
    { id: '1', label: 'New', metadata: { ticketState: 'OPEN' } },
    { id: '2', label: 'Waiting on us', metadata: { ticketState: 'OPEN' } },
    { id: '4', label: 'Closed', metadata: { ticketState: 'CLOSED' } },
  ],
}]
const json = vi.fn(async (_path: string): Promise<unknown> => ({ results: PIPELINES }))
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotJson: (path: string) => json(path) }
})

type SearchBody = { query?: string; filterGroups?: Array<{ filters: Array<Record<string, unknown>> }>; properties: string[] }
const search = vi.fn(async (_type: string, _body: SearchBody): Promise<HubspotObject[]> => [])
const batch = vi.fn(async (_type: string, _ids: string[], _props: string[]): Promise<Map<string, HubspotObject>> => new Map())
const assoc = vi.fn(async (_from: string, _to: string, _ids: string[]): Promise<Map<string, string>> => new Map())
vi.mock('./search.js', async () => {
  const actual = await vi.importActual<typeof import('./search.js')>('./search.js')
  return {
    ...actual,
    hubspotSearch: (t: string, b: SearchBody) => search(t, b),
    batchRead: (t: string, ids: string[], p: string[]) => batch(t, ids, p),
    primaryAssociations: (f: string, to: string, ids: string[]) => assoc(f, to, ids),
  }
})

function prop(name: string, extra: Partial<PropertyInfo> = {}): PropertyInfo {
  return { name, label: name, type: 'string', fieldType: 'text', readOnly: false, calculated: false, hubspotDefined: false, referencedObjectType: null, options: new Map(), ...extra }
}
const PROPS = new Map<string, PropertyInfo>([
  ['platform', prop('platform', { type: 'enumeration', options: new Map([['win', 'Windows'], ['mac', 'macOS']]) })],
  ['tier_owner', prop('tier_owner', { referencedObjectType: 'OWNER' })],
])
vi.mock('./metadata.js', async () => {
  const actual = await vi.importActual<typeof import('./metadata.js')>('./metadata.js')
  return { ...actual, getObjectPropertiesSafe: async () => PROPS }
})

let mappingRows: HubspotMappingRow[] = []
vi.mock('./mappings.js', async () => {
  const actual = await vi.importActual<typeof import('./mappings.js')>('./mappings.js')
  return { ...actual, loadHubspotMappings: async () => mappingRows }
})

function mapping(appField: string, property: string): HubspotMappingRow {
  return { appField, property, crmObject: 'tickets', direction: 'read', isActive: true, constantValue: null, refreshOnlyForReports: false }
}

let tk: typeof import('./tickets.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  tk = await import('./tickets.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  await testDb.insert(schema.hubspotOwners).values({ id: '77', firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com' })
})

beforeEach(() => {
  tk.clearTicketStageCache()
  json.mockClear()
  search.mockReset(); search.mockResolvedValue([])
  batch.mockReset(); batch.mockResolvedValue(new Map())
  assoc.mockReset(); assoc.mockResolvedValue(new Map())
  mappingRows = []
})

describe('ticketStagesFromPipelines', () => {
  it('labels every stage and marks the closed ones', () => {
    const stages = tk.ticketStagesFromPipelines([...PIPELINES, { id: '9', stages: [{ id: '90', label: 'Done', metadata: { isClosed: 'true' } }, { id: '' }] }])
    expect([...stages]).toEqual([
      ['1', { label: 'New', isClosed: false }],
      ['2', { label: 'Waiting on us', isClosed: false }],
      ['4', { label: 'Closed', isClosed: true }],
      ['90', { label: 'Done', isClosed: true }],
    ])
  })
})

describe('ticketPropertyPlan', () => {
  it('uses HubSpot\'s standard properties when nothing is mapped', () => {
    expect(Object.fromEntries(tk.ticketPropertyPlan([]))).toEqual({
      ticket_subject: 'subject', ticket_date_opened: 'createdate', ticket_status: 'hs_pipeline_stage',
      ticket_description: 'content', ticket_owner: 'hubspot_owner_id',
    })
  })

  it('lets a mapping replace a default or add a field, ignoring other objects', () => {
    const plan = tk.ticketPropertyPlan([
      mapping('ticket_subject', 'custom_subject'),
      mapping('ticket_platform', 'platform'),
      mapping('ticket_number', 'ticket_ref'),
      { ...mapping('ticket_owner', 'deal_owner'), crmObject: 'deals' },
    ])
    expect(plan.get('ticket_subject')).toBe('custom_subject')
    expect(plan.get('ticket_platform')).toBe('platform')
    expect(plan.get('ticket_number')).toBe('ticket_ref')
    expect(plan.get('ticket_owner')).toBe('hubspot_owner_id')
  })
})

describe('searchHubspotTickets', () => {
  it('needs a Company or a 2-character query', async () => {
    expect(await tk.searchHubspotTickets({ teamId: null, companyId: null, query: 'a' })).toEqual([])
    expect(await tk.searchHubspotTickets({ teamId: null, companyId: 'not-an-id', query: '' })).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it('scopes to the Company and leaves out closed stages by default', async () => {
    await tk.searchHubspotTickets({ teamId: null, companyId: '12', query: 'ignored with a company' })
    const body = search.mock.calls[0]![1]
    expect(search.mock.calls[0]![0]).toBe('tickets')
    expect(body.query).toBeUndefined()
    expect(body.filterGroups).toEqual([{ filters: [
      { propertyName: 'associations.company', operator: 'EQ', value: '12' },
      { propertyName: 'hs_pipeline_stage', operator: 'NOT_IN', values: ['4'] },
    ] }])
  })

  it('Open Search with Show Closed searches every ticket by text', async () => {
    await tk.searchHubspotTickets({ teamId: null, companyId: null, query: 'login', includeClosed: true })
    const body = search.mock.calls[0]![1]
    expect(body.query).toBe('login')
    expect(body.filterGroups).toBeUndefined()
  })

  it('turns stages, options and owners into labels, and the primary contact into a name', async () => {
    mappingRows = [mapping('ticket_platform', 'platform')]
    search.mockResolvedValue([
      { id: '501', properties: { subject: 'Login fails', hs_pipeline_stage: '2', createdate: '2026-10-01T10:00:00Z', content: 'Cannot sign in', hubspot_owner_id: '77', platform: 'win;mac' } },
      { id: '502', properties: { subject: 'Slow', hs_pipeline_stage: '99', hubspot_owner_id: '404' } },
    ])
    assoc.mockResolvedValue(new Map([['501', '900']]))
    batch.mockResolvedValue(new Map([['900', { id: '900', properties: { firstname: 'Bo', lastname: 'Lee', email: 'bo@acme.example' } }]]))

    const rows = await tk.searchHubspotTickets({ teamId: 't', companyId: '12' })
    expect(rows[0]).toEqual({
      id: '501', ticketNumber: '501', subject: 'Login fails', dateOpened: '2026-10-01T10:00:00Z', status: 'Waiting on us',
      contact: 'Bo Lee', description: 'Cannot sign in', platform: 'Windows, macOS', owner: 'Ana Silva',
    })
    expect(rows[1]).toMatchObject({ status: '99', owner: '404', contact: null, platform: null })
  })

  it('a mapped Contact property replaces the association lookup', async () => {
    mappingRows = [mapping('ticket_contact', 'reporter')]
    search.mockResolvedValue([{ id: '501', properties: { reporter: 'Pat' } }])
    const rows = await tk.searchHubspotTickets({ teamId: 't', companyId: '12' })
    expect(rows[0]!.contact).toBe('Pat')
    expect(assoc).not.toHaveBeenCalled()
  })
})

describe('refreshHubspotTickets', () => {
  async function seed(ticketIds: string[]) {
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Support', sortOrder: 1 }).returning()
    const [activity] = await testDb.insert(schema.activities).values({
      userId: user!.id, teamId: team!.id, title: 'Support call', activityTypeId: type!.id, status: 'submitted',
      startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    }).returning()
    for (const id of ticketIds) {
      await testDb.insert(schema.activityCrmTickets).values({ activityId: activity!.id, crmTicketId: id, crmTicketNumber: id, crmSubject: 'Old subject', crmOwner: '77' })
    }
    return activity!
  }

  it('saves fresh values onto the attached tickets with one batch read', async () => {
    const activity = await seed(['501', '502'])
    batch.mockImplementation(async (type) => (type === 'tickets'
      ? new Map([['501', { id: '501', properties: { subject: 'New subject', hs_pipeline_stage: '4', hubspot_owner_id: '77' } }]])
      : new Map()))

    const { rows, refreshFailed } = await tk.refreshHubspotTickets(activity.id)
    expect(refreshFailed).toBe(false)
    expect(batch.mock.calls.filter(([t]) => t === 'tickets')).toHaveLength(1)
    expect(batch.mock.calls[0]![1]).toEqual(['501', '502'])
    const fresh = rows.find((r) => r.crmTicketId === '501')!
    expect(fresh).toMatchObject({ crmSubject: 'New subject', crmStatus: 'Closed', crmOwner: 'Ana Silva' })
    // HubSpot didn't return 502, so it keeps its snapshot.
    expect(rows.find((r) => r.crmTicketId === '502')).toMatchObject({ crmSubject: 'Old subject' })
    const [stored] = await testDb.select().from(schema.activityCrmTickets).where(eq(schema.activityCrmTickets.crmTicketId, '501'))
    expect(stored).toMatchObject({ crmSubject: 'New subject', crmStatus: 'Closed' })
  })

  it('keeps the stored rows when HubSpot fails, and never sends a Salesforce id', async () => {
    const failing = await seed(['601'])
    batch.mockRejectedValue(new Error('boom'))
    const res = await tk.refreshHubspotTickets(failing.id)
    expect(res.refreshFailed).toBe(true)
    expect(res.rows[0]).toMatchObject({ crmSubject: 'Old subject' })

    batch.mockReset()
    const sfOnly = await seed(['500000000000001AAA'])
    const res2 = await tk.refreshHubspotTickets(sfOnly.id)
    expect(res2.refreshFailed).toBe(false)
    expect(batch).not.toHaveBeenCalled()
  })
})
