// HubSpot Deal snapshot refresh (phase 3): the Deal → snapshot mapping as a
// unit test, then the whole refresh against pglite with HubSpot's API
// mocked: stage/forecast labels, owner and SE names, the Deal's Company,
// Salesforce ids left alone, a missing Deal keeping its snapshot, Lead →
// Company links, and the stage/forecast filter options.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

type Req = { method?: string; body?: unknown; query?: Record<string, unknown> }
const request = vi.fn(async (_path: string, _opts?: Req): Promise<{ status: number; body: unknown }> => ({ status: 200, body: {} }))
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  // hubspotJson calls the module's own hubspotRequest, so it's rebuilt here
  // over the mock with the same status handling.
  const hubspotJson = async (path: string, opts?: Req) => {
    const { status, body } = await request(path, opts)
    if (status === 403) throw new actual.HubspotError('errors.hubspot.forbidden', 403)
    if (status < 200 || status >= 300 || body === null) throw new actual.HubspotError('errors.hubspot.bad_response', status)
    return body
  }
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts), hubspotJson }
})

let leadsStatus: 'ok' | 'missing' = 'ok'
let configured = true
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return {
    ...actual,
    getHubspotConfig: async () => configured
      ? { accessToken: 'x', portalId: '1', portalName: null, accountType: null, uiDomain: null, lastCheck: { checkedAt: '', ok: true, capabilities: [{ key: 'leads_read', status: leadsStatus }] } }
      : null,
  }
})

import { dealToPatch } from './refreshSnapshots.js'

const STAGES = new Map([
  ['appt', { label: 'Appointment scheduled', pipelineId: 'default', pipelineLabel: 'Sales Pipeline', isClosed: false, isWon: false }],
  ['won', { label: 'Closed won', pipelineId: 'default', pipelineLabel: 'Sales Pipeline', isClosed: true, isWon: true }],
])

function propInfo(name: string, options: Array<[string, string]> = [], extra: Record<string, unknown> = {}) {
  return { name, label: name, type: options.length ? 'enumeration' : 'string', fieldType: 'select', readOnly: false, calculated: false, hubspotDefined: true, referencedObjectType: null, options: new Map(options), ...extra }
}

const PROPS = new Map([
  ['hs_manual_forecast_category', propInfo('hs_manual_forecast_category', [['COMMIT', 'Commit'], ['BEST_CASE', 'Best case']])],
  ['se_owner', propInfo('se_owner', [], { type: 'enumeration', referencedObjectType: 'OWNER' })],
])

describe('dealToPatch', () => {
  it('stores labels people read: stage label, forecast label, owner and SE names, the Company', async () => {
    const patch = await dealToPatch(
      { id: '101', properties: { dealstage: 'appt', amount: '25000.5', closedate: '2026-12-01T00:00:00Z', hubspot_owner_id: '77', hs_manual_forecast_category: 'COMMIT', hs_is_closed: 'false', hs_is_closed_won: 'false', se_owner: null } },
      { stages: STAGES, props: PROPS, owners: new Map([['77', 'Ana Silva']]), assignedSeProperty: 'se_owner', primaryEngineerProperty: null, company: { id: '12', name: 'Acme' } },
    )
    expect(patch).toEqual({
      id: '101', salesStage: 'Appointment scheduled', forecastCategory: 'Commit', oppAmount: '25000.5',
      crmIsClosed: false, crmIsWon: false, crmOppOwnerId: '77', crmOppOwnerName: 'Ana Silva', crmOppCloseDate: '2026-12-01',
      crmAssignedSeName: null, crmPrimaryEngineerName: null, crmAccountId: '12', crmAccountName: 'Acme',
    })
  })

  it('falls back to the stage metadata when HubSpot hides the closed/won flags, and keeps an unknown stage id', async () => {
    const won = await dealToPatch({ id: '1', properties: { dealstage: 'won' } }, { stages: STAGES, props: PROPS, owners: new Map(), assignedSeProperty: null, primaryEngineerProperty: null, company: null })
    expect(won).toMatchObject({ salesStage: 'Closed won', crmIsClosed: true, crmIsWon: true, oppAmount: null, crmAccountId: null })
    const unknown = await dealToPatch({ id: '2', properties: { dealstage: '998877' } }, { stages: STAGES, props: PROPS, owners: new Map(), assignedSeProperty: null, primaryEngineerProperty: null, company: null })
    expect(unknown).toMatchObject({ salesStage: '998877', crmIsClosed: false, crmIsWon: false })
  })
})

// ── Full refresh (pglite) ────────────────────────────────────────────────

let refresh: typeof import('./refreshSnapshots.js')
let metadata: typeof import('./metadata.js')
let schema: typeof import('../../../../drizzle/schema.js')
let orm: typeof import('drizzle-orm')
let testDb: TestDb

beforeAll(async () => {
  refresh = await import('./refreshSnapshots.js')
  metadata = await import('./metadata.js')
  schema = await import('../../../../drizzle/schema.js')
  orm = await import('drizzle-orm')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  request.mockReset()
  leadsStatus = 'ok'
  configured = true
  metadata.clearHubspotMetadataCache()
  await testDb.delete(schema.activities)
  await testDb.delete(schema.crmLeadAccountLink)
  await testDb.delete(schema.crmFieldMappingTeams)
  await testDb.delete(schema.crmFieldMappings)
  await testDb.delete(schema.hubspotOwners)
  await testDb.delete(schema.jobRuns)
})

let teamId = ''
let userId = ''
let typeId = ''
async function base() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  teamId = team!.id; userId = user!.id; typeId = type!.id
}

async function activity(fields: Partial<typeof schema.activities.$inferInsert>) {
  const [row] = await testDb.insert(schema.activities).values({
    userId, teamId, title: 'A', activityTypeId: typeId, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    ...fields,
  }).returning()
  return row!
}

async function reload(id: string) {
  const [row] = await testDb.select().from(schema.activities).where(orm.eq(schema.activities.id, id))
  return row!
}

const PIPELINES = { results: [
  { id: 'default', label: 'Sales Pipeline', stages: [{ id: 'appt', label: 'Appointment scheduled', metadata: { isClosed: 'false', probability: '0.2' } }, { id: 'won', label: 'Closed won', metadata: { isClosed: 'true', probability: '1.0' } }] },
  { id: 'renewals', label: 'Renewals', stages: [{ id: 'r1', label: 'Renewal due', metadata: { isClosed: 'false', probability: '0.5' } }, { id: 'rwon', label: 'Closed won', metadata: { isClosed: 'true', probability: '1.0' } }] },
] }
const DEAL_PROPS = { results: [
  { name: 'hs_manual_forecast_category', label: 'Forecast category', type: 'enumeration', fieldType: 'select', options: [{ value: 'COMMIT', label: 'Commit' }, { value: 'BEST_CASE', label: 'Best case' }] },
  { name: 'se_owner', label: 'SE', type: 'enumeration', fieldType: 'select', referencedObjectType: 'OWNER', options: [] },
] }

function hubspot(opts: { deals?: unknown[]; dealCompanies?: unknown[]; leadCompanies?: unknown[] | 'fail'; companies?: unknown[] } = {}) {
  request.mockImplementation(async (path, o) => {
    if (path === '/crm/v3/pipelines/deals') return { status: 200, body: PIPELINES }
    if (path === '/crm/v3/properties/deals') return { status: 200, body: DEAL_PROPS }
    if (path === '/crm/v3/objects/deals/batch/read') return { status: 207, body: { results: opts.deals ?? [], errors: [] } }
    if (path === '/crm/v4/associations/deals/companies/batch/read') return { status: 200, body: { results: opts.dealCompanies ?? [] } }
    if (path === '/crm/v3/objects/companies/batch/read') return { status: 200, body: { results: opts.companies ?? [] } }
    if (path === '/crm/v4/associations/leads/companies/batch/read') {
      if (opts.leadCompanies === 'fail') return { status: 500, body: {} }
      return { status: 200, body: { results: opts.leadCompanies ?? [] } }
    }
    return { status: 404, body: { path, method: o?.method } }
  })
}

describe('refreshHubspotSnapshots', () => {
  it('refreshes Deal snapshots and the Deal\'s Company, leaving Salesforce ids and missing Deals alone', async () => {
    await base()
    await testDb.insert(schema.hubspotOwners).values([{ id: '77', firstName: 'Ana', lastName: 'Silva' }, { id: '88', firstName: 'Sam', lastName: 'Lee' }])
    const [mapping] = await testDb.insert(schema.crmFieldMappings).values({ teamId, appField: 'assigned_se_name', crmFieldApi: 'se_owner', crmObject: 'deals', direction: 'read' }).returning()
    await testDb.insert(schema.crmFieldMappingTeams).values({ crmFieldMappingId: mapping!.id, teamId })
    const a1 = await activity({ crmWhatId: '101', crmWhatType: 'Opportunity', crmWhatName: 'Acme deal', crmAccountId: '11', crmAccountName: 'Old Co', salesStage: 'Appointment scheduled' })
    const a2 = await activity({ crmWhatId: '101', crmWhatType: 'Opportunity' })
    const missing = await activity({ crmWhatId: '202', crmWhatType: 'Opportunity', salesStage: 'Renewal due', crmAccountId: '13', crmAccountName: 'Keep Co' })
    const sf = await activity({ crmWhatId: '006000000000001AAA', crmWhatType: 'Opportunity', salesStage: 'Prospecting' })
    hubspot({
      deals: [{ id: '101', properties: { dealstage: 'won', amount: '5000', closedate: '2026-11-30T00:00:00Z', hubspot_owner_id: '77', hs_manual_forecast_category: 'COMMIT', hs_is_closed: 'true', hs_is_closed_won: 'true', se_owner: '88' } }],
      dealCompanies: [{ from: { id: '101' }, to: [{ toObjectId: 12, associationTypes: [{ label: 'Primary' }] }] }],
      companies: [{ id: '12', properties: { name: 'Acme Inc' } }],
    })

    const result = await refresh.refreshHubspotSnapshots({ source: 'manual' })

    expect(result).toMatchObject({ oppsScanned: 2, oppsUpdated: 1, errors: [], source: 'manual' })
    const batch = request.mock.calls.find(([p]) => p === '/crm/v3/objects/deals/batch/read')![1]!.body as { inputs: Array<{ id: string }>; properties: string[] }
    expect(batch.inputs.map((i) => i.id).sort()).toEqual(['101', '202'])
    expect(batch.properties).toContain('se_owner')
    for (const id of [a1.id, a2.id]) {
      expect(await reload(id)).toMatchObject({
        salesStage: 'Closed won', forecastCategory: 'Commit', oppAmount: '5000.00', crmIsClosed: true, crmIsWon: true,
        crmOppOwnerId: '77', crmOppOwnerName: 'Ana Silva', crmOppCloseDate: '2026-11-30', crmAssignedSeName: 'Sam Lee',
        crmAccountId: '12', crmAccountName: 'Acme Inc',
      })
    }
    expect(await reload(missing.id)).toMatchObject({ salesStage: 'Renewal due', crmAccountId: '13', crmAccountName: 'Keep Co' })
    expect(await reload(sf.id)).toMatchObject({ salesStage: 'Prospecting' })
    const runs = await testDb.select().from(schema.jobRuns)
    expect(runs.map((r) => [r.jobKey, r.status])).toEqual([['refresh_hubspot_snapshots', 'ok']])
  })

  it('follows a merged Deal: the link moves to the surviving Deal and gets its snapshot', async () => {
    await base()
    const a = await activity({ crmWhatId: '101', crmWhatType: 'Opportunity', crmWhatName: 'Old deal', salesStage: 'Appointment scheduled' })
    hubspot({ deals: [{ id: '150', properties: { dealstage: 'won', amount: '900', hs_merged_object_ids: '101' } }] })
    const result = await refresh.refreshHubspotSnapshots()
    expect(result).toMatchObject({ oppsScanned: 1, oppsUpdated: 1, errors: [] })
    expect(await reload(a.id)).toMatchObject({ crmWhatId: '150', salesStage: 'Closed won', oppAmount: '900.00', crmWhatDeleted: false })
    const batch = request.mock.calls.find(([p]) => p === '/crm/v3/objects/deals/batch/read')![1]!.body as { properties: string[] }
    expect(batch.properties).toContain('hs_merged_object_ids')
  })

  it('keeps the stored Company when a Deal has no Company association', async () => {
    await base()
    const a = await activity({ crmWhatId: '101', crmWhatType: 'Opportunity', crmAccountId: '11', crmAccountName: 'Old Co' })
    hubspot({ deals: [{ id: '101', properties: { dealstage: 'appt' } }] })
    await refresh.refreshHubspotSnapshots()
    expect(await reload(a.id)).toMatchObject({ salesStage: 'Appointment scheduled', crmAccountId: '11', crmAccountName: 'Old Co' })
  })

  it('links Leads to their Company, and writes nothing when the association read fails', async () => {
    await base()
    await activity({ crmWhoId: '40', crmWhoType: 'Lead' })
    await activity({ crmWhoId: '41', crmWhoType: 'Lead' })
    await testDb.insert(schema.crmLeadAccountLink).values({ leadId: '41', accountId: '99' })
    hubspot({ leadCompanies: [{ from: { id: '40' }, to: [{ toObjectId: 12, associationTypes: [] }] }] })
    const ok = await refresh.refreshHubspotSnapshots()
    expect(ok).toMatchObject({ leadsScanned: 2, leadsLinked: 1, errors: [] })
    const links = new Map((await testDb.select().from(schema.crmLeadAccountLink)).map((l) => [l.leadId, l.accountId]))
    expect(links.get('40')).toBe('12')
    expect(links.get('41')).toBeNull()

    await testDb.update(schema.crmLeadAccountLink).set({ accountId: '55' })
    hubspot({ leadCompanies: 'fail' })
    const failed = await refresh.refreshHubspotSnapshots()
    expect(failed.errors[0]).toMatch(/^lead_batch_0/)
    expect((await testDb.select().from(schema.crmLeadAccountLink)).every((l) => l.accountId === '55')).toBe(true)
  })

  it('skips Leads when the access check found the portal has none', async () => {
    await base()
    await activity({ crmWhoId: '40', crmWhoType: 'Lead' })
    leadsStatus = 'missing'
    hubspot()
    const result = await refresh.refreshHubspotSnapshots()
    expect(result.leadsScanned).toBe(0)
    expect(request.mock.calls.some(([p]) => p.includes('/leads/'))).toBe(false)
  })

  it('reports not configured without calling HubSpot', async () => {
    configured = false
    const result = await refresh.refreshHubspotSnapshots()
    expect(result.errors).toEqual(['errors.hubspot.not_configured'])
    expect(request).not.toHaveBeenCalled()
  })
})

describe('readHubspotDealForRelink', () => {
  it('reads the target Deal live into the same snapshot the nightly refresh writes', async () => {
    await base()
    await testDb.insert(schema.hubspotOwners).values({ id: '77', firstName: 'Ana', lastName: 'Silva' })
    hubspot({
      deals: [{ id: '101', properties: { dealname: 'Acme renewal', dealstage: 'appt', amount: '1200', hubspot_owner_id: '77' } }],
      dealCompanies: [{ from: { id: '101' }, to: [{ toObjectId: 12, associationTypes: [{ label: 'Primary' }] }] }],
      companies: [{ id: '12', properties: { name: 'Acme Inc' } }],
    })
    expect(await refresh.readHubspotDealForRelink('101')).toMatchObject({
      crmWhatId: '101', crmWhatName: 'Acme renewal', salesStage: 'Appointment scheduled', oppAmount: '1200',
      crmOppOwnerName: 'Ana Silva', crmAccountId: '12', crmAccountName: 'Acme Inc', crmIsClosed: false,
    })
  })

  it('answers with the surviving Deal for a merged id, and null for one HubSpot doesn\'t have', async () => {
    await base()
    hubspot({ deals: [{ id: '150', properties: { dealname: 'Survivor', dealstage: 'appt', hs_merged_object_ids: '101' } }] })
    expect(await refresh.readHubspotDealForRelink('101')).toMatchObject({ crmWhatId: '150', crmWhatName: 'Survivor' })
    hubspot({ deals: [] })
    expect(await refresh.readHubspotDealForRelink('999')).toBeNull()
  })
})

describe('getDealFilterOptions', () => {
  it('lists stage labels once, grouped by pipeline, plus forecast labels', async () => {
    hubspot()
    expect(await metadata.getDealFilterOptions()).toEqual({
      stages: ['Appointment scheduled', 'Closed won', 'Renewal due'],
      forecast: ['Commit', 'Best case'],
      stageGroups: { 'Appointment scheduled': 'Sales Pipeline', 'Closed won': 'Sales Pipeline', 'Renewal due': 'Renewals' },
    })
  })
})
