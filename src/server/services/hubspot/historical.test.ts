// HubSpot historical import (phase 8a): the pure helpers as unit tests, then
// a slice ingest and the nightly Deal refresh against pglite with HubSpot's
// API mocked: paging by record id past the search cap, the meetings kept and
// skipped (no CRM link, already in ImpactIQ, excluded), the rows written,
// the Deal/Company detail pass, and Salesforce ids never sent to HubSpot.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
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
  const hubspotJson = async (path: string, opts?: Req) => {
    const { status, body } = await request(path, opts)
    if (status === 401) throw new actual.HubspotError('errors.hubspot.unauthorized', 401)
    if (status < 200 || status >= 300 || body === null) throw new actual.HubspotError('errors.hubspot.bad_response', status)
    return body
  }
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts), hubspotJson }
})

import { createdByKey, dealToHistoricalRow, htmlToText, meetingTypeValue, type HubspotHistoricalContext } from './historical.js'
import { HUBSPOT_HISTORICAL_ACTOR_RX } from '../../../shared/hubspot.js'

const STAGES = new Map([
  ['appt', { label: 'Appointment scheduled', pipelineId: 'default', pipelineLabel: 'Sales Pipeline', isClosed: false, isWon: false }],
  ['won', { label: 'Closed won', pipelineId: 'default', pipelineLabel: 'Sales Pipeline', isClosed: true, isWon: true }],
])

function propInfo(name: string, options: Array<[string, string]>) {
  return { name, label: name, type: 'enumeration', fieldType: 'select', readOnly: false, calculated: false, hubspotDefined: true, referencedObjectType: null, options: new Map(options) }
}
const DEAL_PROPS = new Map([['hs_manual_forecast_category', propInfo('hs_manual_forecast_category', [['COMMIT', 'Commit']])]])
const COMPANY_PROPS = new Map([['industry', propInfo('industry', [['COMPUTER_SOFTWARE', 'Computer Software']])]])

function ctx(over: Partial<HubspotHistoricalContext> = {}): HubspotHistoricalContext {
  return { typeProperties: ['meeting_kind'], projectTargets: [], acvProperty: 'acv_amount', stages: STAGES, dealProps: DEAL_PROPS, companyProps: COMPANY_PROPS, ...over }
}

describe('helpers', () => {
  it('turns meeting notes HTML into plain text', () => {
    expect(htmlToText('<p>Agenda &amp; goals</p><p>Next:<br/>demo&nbsp;day</p>')).toBe('Agenda & goals\nNext:\ndemo day')
    expect(htmlToText('<p></p>')).toBeNull()
    expect(htmlToText('a<<b>script>alert(1)</script>b')).not.toMatch(/</)
    expect(htmlToText(null)).toBeNull()
  })

  it('keys Created By as the owner, else user:<id>, else source:<id>', () => {
    const owners = new Map([['555', '88']])
    expect(createdByKey({ id: '1', properties: { hs_created_by_user_id: '555' } }, owners)).toBe('88')
    expect(createdByKey({ id: '1', properties: { hs_created_by_user_id: '999' } }, owners)).toBe('user:999')
    expect(createdByKey({ id: '1', properties: { hs_object_source_id: 'outreach app/1' } }, owners)).toBe('source:outreachapp1')
    expect(createdByKey({ id: '1', properties: { hs_object_source: 'INTEGRATION' } }, owners)).toBe('source:INTEGRATION')
    expect(createdByKey({ id: '1', properties: {} }, owners)).toBeNull()
  })

  it('accepts exactly the exclusion ids createdByKey can produce', () => {
    for (const ok of ['88', 'user:999', 'source:outreachapp1', 'source:sample-contact', 'source:a.b:c_d']) expect(HUBSPOT_HISTORICAL_ACTOR_RX.test(ok)).toBe(true)
    for (const bad of ['', '005xx000001AbCdAAA', 'user:', 'owner:12', 'source:has space', 'user:1/2', '../x']) expect(HUBSPOT_HISTORICAL_ACTOR_RX.test(bad)).toBe(false)
  })

  it('reads the type from the first mapped property with a value, else hs_activity_type', () => {
    expect(meetingTypeValue({ id: '1', properties: { a: '', b: 'Demo', hs_activity_type: 'Call' } }, ['a', 'b'])).toBe('Demo')
    expect(meetingTypeValue({ id: '1', properties: { hs_activity_type: 'Discovery' } }, ['a'])).toBe('Discovery')
  })

  it('maps a Deal to its history row with labels, and freezes a closed Deal', () => {
    const open = dealToHistoricalRow(
      { id: '101', properties: { dealname: 'Acme expansion', dealstage: 'appt', amount: '1000', acv_amount: '800', hs_manual_forecast_category: 'COMMIT', hubspot_owner_id: '77', closedate: '2027-01-15T00:00:00Z', hs_is_closed: 'false', hs_is_closed_won: 'false' } },
      ctx(), { id: '12', name: 'Acme' }, new Map([['77', 'Ana Silva']]),
    )
    expect(open).toMatchObject({
      oppId: '101', oppName: 'Acme expansion', accountId: '12', accountName: 'Acme', stageName: 'Appointment scheduled',
      forecastCategory: 'Commit', isClosed: false, isWon: false, amount: '1000', totalAcv: '800', closeDate: '2027-01-15',
      ownerId: '77', ownerName: 'Ana Silva', frozenAt: null,
    })
    const won = dealToHistoricalRow({ id: '102', properties: { dealstage: 'won' } }, ctx({ acvProperty: null }), null, new Map())
    expect(won).toMatchObject({ stageName: 'Closed won', isClosed: true, isWon: true, totalAcv: null, accountId: null })
    expect(won.frozenAt).toBeInstanceOf(Date)
  })
})

// ── pglite ───────────────────────────────────────────────────────────────

let hist: typeof import('./historical.js')
let exclusionsMod: typeof import('../salesforce/historical/exclusions.js')
let schema: typeof import('../../../../drizzle/schema.js')
let orm: typeof import('drizzle-orm')
let testDb: TestDb

beforeAll(async () => {
  hist = await import('./historical.js')
  exclusionsMod = await import('../salesforce/historical/exclusions.js')
  schema = await import('../../../../drizzle/schema.js')
  orm = await import('drizzle-orm')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

let teamId = ''
let userId = ''
let typeId = ''
beforeEach(async () => {
  request.mockReset()
  await testDb.delete(schema.crmHistoricalEvents)
  await testDb.delete(schema.crmHistoricalOpportunities)
  await testDb.delete(schema.crmHistoricalAccounts)
  await testDb.delete(schema.crmHistoricalImportRuns)
  await testDb.delete(schema.activities)
  await testDb.delete(schema.hubspotOwners)
  await testDb.delete(schema.jobRuns)
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  teamId = team!.id; userId = user!.id; typeId = type!.id
  await testDb.insert(schema.hubspotOwners).values([
    { id: '77', hubspotUserId: '444', email: 'ana@example.com', firstName: 'Ana', lastName: 'Silva' },
    { id: '88', hubspotUserId: '555', email: 'bot@example.com', firstName: 'Sync', lastName: 'Bot' },
  ])
})

function maps() {
  return {
    userBySfId: new Map([['77', { userId, teamId }]]),
    userByEmail: new Map(),
    emailBySfUserId: new Map(),
    typeByTeamAndValue: new Map([[`${teamId}::demo`, typeId]]),
    adminTypeMap: new Map(),
    allDayCapHours: 8,
  }
}

function meeting(id: string, props: Record<string, string>) {
  return { id, properties: { hs_timestamp: '2025-03-10T15:00:00Z', hs_meeting_start_time: '2025-03-10T15:00:00Z', hs_meeting_end_time: '2025-03-10T16:00:00Z', hubspot_owner_id: '77', ...props } }
}

function assocResults(map: Record<string, string[]>, body: unknown) {
  const ids = ((body as { inputs?: Array<{ id: string }> }).inputs ?? []).map((i) => i.id)
  return { results: ids.filter((id) => map[id]).map((id) => ({ from: { id }, to: map[id]!.map((t) => ({ toObjectId: Number(t), associationTypes: [{ label: 'Primary' }] })) })) }
}

function readResults(records: Record<string, Record<string, string>>, body: unknown) {
  const ids = ((body as { inputs?: Array<{ id: string }> }).inputs ?? []).map((i) => i.id)
  return { results: ids.filter((id) => records[id]).map((id) => ({ id, properties: records[id] })) }
}

function route(pages: unknown[][], links: {
  deals?: Record<string, string[]>; companies?: Record<string, string[]>; contacts?: Record<string, string[]>; dealCompany?: Record<string, string[]>
  dealRecords?: Record<string, Record<string, string>>; companyRecords?: Record<string, Record<string, string>>
}) {
  let page = 0
  request.mockImplementation(async (path: string, opts?: Req) => {
    if (path === '/crm/v3/objects/meetings/search') return { status: 200, body: { results: pages[page++] ?? [] } }
    const assoc = path.match(/^\/crm\/v4\/associations\/(\w+)\/(\w+)\/batch\/read$/)
    if (assoc) {
      const key = assoc[1] === 'deals' ? 'dealCompany' : assoc[2] as 'deals' | 'companies' | 'contacts'
      return { status: 200, body: assocResults(links[key] ?? {}, opts?.body) }
    }
    if (path === '/crm/v3/objects/deals/batch/read') return { status: 200, body: readResults(links.dealRecords ?? {}, opts?.body) }
    if (path === '/crm/v3/objects/companies/batch/read') return { status: 200, body: readResults(links.companyRecords ?? {}, opts?.body) }
    return { status: 404, body: null }
  })
}

describe('ingestHubspotSlice', () => {
  const from = new Date('2025-03-01T00:00:00Z')
  const to = new Date('2025-06-01T00:00:00Z')

  it('keeps Deal/Company meetings, skips unlinked, already-logged and excluded ones, and writes the rows', async () => {
    await testDb.insert(schema.activities).values({
      userId, teamId, title: 'Logged', activityTypeId: typeId, status: 'submitted', crmRecordId: '904',
      startDatetime: new Date('2025-03-10T15:00:00Z'), endDatetime: new Date('2025-03-10T16:00:00Z'), effortHours: '1.00',
    })
    route([[
      meeting('901', { hs_meeting_title: 'Acme demo', meeting_kind: 'Demo', hs_meeting_body: '<p>Showed <b>v2</b></p>', hs_created_by_user_id: '444' }),
      meeting('902', { hs_meeting_title: 'Globex sync', hs_activity_type: 'Check-in', hs_meeting_start_time: '2025-03-11T00:00:00Z', hs_meeting_end_time: '2025-03-12T00:00:00Z' }),
      meeting('903', { hs_meeting_title: 'Unlinked' }),
      meeting('904', { hs_meeting_title: 'Already in ImpactIQ' }),
      meeting('905', { hs_meeting_title: 'Bot meeting', hs_created_by_user_id: '555' }),
    ]], {
      deals: { '901': ['301'], '905': ['301'] },
      companies: { '902': ['402'] },
      contacts: { '901': ['501'] },
      dealCompany: { '301': ['401'] },
      dealRecords: { '301': { dealname: 'Acme expansion', dealstage: 'won', amount: '5000', hubspot_owner_id: '77' } },
      companyRecords: { '401': { name: 'Acme', industry: 'COMPUTER_SOFTWARE', hubspot_owner_id: '77' }, '402': { name: 'Globex' } },
    })
    const exclusions = exclusionsMod.emptyExclusionSet()
    exclusions.createdBy.add('88')

    const stats = await hist.ingestHubspotSlice(ctx(), maps(), exclusions, from, to, null, false)
    expect(stats).toMatchObject({ eventsFetched: 5, eventsInserted: 2, eventsSkipped: 2, eventsExcluded: 1, oppsUpserted: 1, accountsUpserted: 2, usersMatched: 2, typesMatched: 1, typesUnmatched: 1 })
    expect(stats.unmatchedTypeSamples).toEqual({ 'Check-in': 1 })

    const rows = await testDb.select().from(schema.crmHistoricalEvents).orderBy(schema.crmHistoricalEvents.crmEventId)
    expect(rows.map((r) => r.crmEventId)).toEqual(['901', '902'])
    expect(rows[0]).toMatchObject({
      subject: 'Acme demo', crmType: 'Demo', whatId: '301', whatType: 'Opportunity', whatName: 'Acme expansion', whoId: '501',
      accountId: '401', ownerCrmUserId: '77', ownerCrmUserName: 'Ana Silva', createdByCrmUserId: '77', createdByCrmUserName: 'Ana Silva',
      description: 'Showed v2', durationMinutes: 60, isAllDayEvent: false, activityDate: '2025-03-10',
      userId, teamId, activityTypeId: typeId, userMatchMethod: 'sf_user_id', typeMatchMethod: 'name_exact',
    })
    expect(Number(rows[0]!.estimatedHours)).toBe(1)
    expect(rows[1]).toMatchObject({ whatId: '402', whatType: 'Account', whatName: 'Globex', accountId: '402', durationMinutes: 1440, isAllDayEvent: true, activityTypeId: null })
    expect(Number(rows[1]!.estimatedHours)).toBe(8)

    const [opp] = await testDb.select().from(schema.crmHistoricalOpportunities)
    expect(opp).toMatchObject({ oppId: '301', oppName: 'Acme expansion', accountId: '401', accountName: 'Acme', stageName: 'Closed won', isClosed: true, isWon: true })
    expect(opp!.frozenAt).not.toBeNull()
    const accounts = await testDb.select().from(schema.crmHistoricalAccounts).orderBy(schema.crmHistoricalAccounts.accountId)
    expect(accounts.map((a) => [a.accountId, a.name, a.industry])).toEqual([['401', 'Acme', 'Computer Software'], ['402', 'Globex', null]])
  })

  it('writes nothing on a dry run', async () => {
    route([[meeting('901', { meeting_kind: 'Demo' })]], { deals: { '901': ['301'] }, dealRecords: { '301': { dealname: 'D' } } })
    const stats = await hist.ingestHubspotSlice(ctx(), maps(), exclusionsMod.emptyExclusionSet(), from, to, null, true)
    expect(stats.eventsFetched).toBe(1)
    expect(stats.eventsInserted).toBe(0)
    expect(await testDb.select().from(schema.crmHistoricalEvents)).toHaveLength(0)
  })

  it('pages by record id, so a slice past the search cap still reads completely', async () => {
    const full = Array.from({ length: 200 }, (_, i) => meeting(String(1000 + i), {}))
    route([full, [meeting('1300', {})]], { companies: { '1300': ['402'] }, companyRecords: { '402': { name: 'Globex' } } })
    const stats = await hist.ingestHubspotSlice(ctx(), maps(), exclusionsMod.emptyExclusionSet(), from, to, null, false)
    expect(stats.eventsFetched).toBe(201)
    expect(stats.eventsInserted).toBe(1)

    const searches = request.mock.calls.filter(([path]) => path === '/crm/v3/objects/meetings/search')
    expect(searches).toHaveLength(2)
    const filters = (n: number) => (searches[n]![1]!.body as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> }).filterGroups[0]!.filters
    expect(filters(0)).toEqual([
      { propertyName: 'hs_timestamp', operator: 'GTE', value: String(from.getTime()) },
      { propertyName: 'hs_timestamp', operator: 'LT', value: String(to.getTime()) },
      { propertyName: 'hs_object_id', operator: 'GT', value: '0' },
    ])
    expect(filters(1)[2]).toEqual({ propertyName: 'hs_object_id', operator: 'GT', value: '1199' })
    expect((searches[0]![1]!.body as { sorts: unknown }).sorts).toEqual([{ propertyName: 'hs_object_id', direction: 'ASCENDING' }])
  })
})

describe('refreshHubspotHistoricalDeals', () => {
  it('refreshes open Deals, freezes closed ones, and never sends a Salesforce id', async () => {
    await testDb.insert(schema.crmHistoricalOpportunities).values([
      { oppId: '301', oppName: 'Old name', isClosed: false },
      { oppId: '302', oppName: 'Still open', isClosed: false },
      { oppId: '006000000000001AAA', oppName: 'From Salesforce', isClosed: false },
      { oppId: '303', oppName: 'Frozen', isClosed: true, frozenAt: new Date('2024-01-01T00:00:00Z') },
    ])
    request.mockImplementation(async (path: string, opts?: Req) => {
      if (path === '/crm/v3/objects/deals/batch/read') {
        expect(((opts!.body as { inputs: Array<{ id: string }> }).inputs).map((i) => i.id).sort()).toEqual(['301', '302'])
        return { status: 200, body: readResults({ '301': { dealname: 'Acme expansion', dealstage: 'won', hs_is_closed: 'true', hs_is_closed_won: 'true' } }, opts?.body) }
      }
      if (path.startsWith('/crm/v4/associations/')) return { status: 200, body: { results: [] } }
      if (path.startsWith('/crm/v3/pipelines/') || path.startsWith('/crm/v3/properties/')) return { status: 200, body: { results: [] } }
      return { status: 200, body: { results: [] } }
    })

    const result = await hist.refreshHubspotHistoricalDeals('refresh_historical_opps')
    expect(result).toMatchObject({ candidates: 2, refreshed: 1, frozen: 1, errors: [] })
    const rows = new Map((await testDb.select().from(schema.crmHistoricalOpportunities)).map((r) => [r.oppId, r]))
    expect(rows.get('301')).toMatchObject({ oppName: 'Acme expansion', isClosed: true, isWon: true })
    expect(rows.get('301')!.frozenAt).not.toBeNull()
    expect(rows.get('302')).toMatchObject({ oppName: 'Still open', frozenAt: null })
    expect(rows.get('006000000000001AAA')).toMatchObject({ oppName: 'From Salesforce' })
    expect(rows.get('303')).toMatchObject({ oppName: 'Frozen' })

    const runs = await testDb.select().from(schema.crmHistoricalImportRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ kind: 'opp_refresh', status: 'ok', oppsUpserted: 1 })
    expect(await testDb.select().from(schema.jobRuns).where(orm.eq(schema.jobRuns.jobKey, 'refresh_historical_opps'))).toHaveLength(1)
  })

  it('returns null and writes no run when there is nothing to refresh', async () => {
    await testDb.insert(schema.crmHistoricalOpportunities).values({ oppId: '006000000000001AAA', isClosed: false })
    expect(await hist.refreshHubspotHistoricalDeals('refresh_historical_opps')).toBeNull()
    expect(request).not.toHaveBeenCalled()
    expect(await testDb.select().from(schema.jobRuns)).toHaveLength(0)
  })
})
