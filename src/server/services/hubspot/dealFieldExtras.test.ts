// Activity Type Opp field extras on a HubSpot Deal: reading a property into
// the shapes the activity form expects, which properties an extra makes
// editable, and the guarded write. pglite for extras; HubSpot's API and
// property metadata mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'
import type { PropertyInfo } from './metadata.js'

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

let dealProps = new Map<string, PropertyInfo>()
vi.mock('./metadata.js', async () => {
  const actual = await vi.importActual<typeof import('./metadata.js')>('./metadata.js')
  return { ...actual, getObjectPropertiesSafe: async () => dealProps, getObjectProperties: async () => dealProps }
})

function prop(name: string, extra: Partial<PropertyInfo> = {}): PropertyInfo {
  return { name, label: name, type: 'string', fieldType: 'text', readOnly: false, calculated: false, hubspotDefined: false, referencedObjectType: null, options: new Map(), ...extra }
}

let df: typeof import('./dealFields.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  df = await import('./dealFields.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  request.mockReset()
  request.mockResolvedValue({ status: 200, body: {} })
  dealProps = new Map()
  await testDb.delete(schema.activitySyncAudit)
})

async function typeWithExtra(config: Record<string, unknown>, opts: { viaJunction?: boolean } = {}) {
  const [t] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: opts.viaJunction ? null : t!.id, name: `Type ${crypto.randomUUID()}`, sortOrder: 1 }).returning()
  if (opts.viaJunction) await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: type!.id, teamId: t!.id })
  await testDb.insert(schema.teamActivityTypeCrmExtras).values({ teamActivityTypeId: type!.id, kind: 'opp_field_display', config })
  return t!.id
}

describe('dealFieldFromHubspot / dealFieldToHubspot', () => {
  it('reads checkboxes as booleans and numbers as numbers', () => {
    expect(df.dealFieldFromHubspot(prop('x', { type: 'bool' }), 'true')).toBe(true)
    expect(df.dealFieldFromHubspot(prop('x', { type: 'bool' }), 'false')).toBe(false)
    expect(df.dealFieldFromHubspot(prop('x', { type: 'number' }), '1500.5')).toBe(1500.5)
    expect(df.dealFieldFromHubspot(prop('x'), 'hello')).toBe('hello')
    expect(df.dealFieldFromHubspot(prop('x'), '')).toBeNull()
  })

  it('writes every value as text, null clearing it', () => {
    expect(df.dealFieldToHubspot(true)).toBe('true')
    expect(df.dealFieldToHubspot(42)).toBe('42')
    expect(df.dealFieldToHubspot(null)).toBe('')
  })
})

describe('readHubspotDealField', () => {
  it('returns the value, its option label and the options', async () => {
    dealProps = new Map([['rfp_stage', prop('rfp_stage', { type: 'enumeration', options: new Map([['a', 'Alpha'], ['b', 'Beta']]) })]])
    request.mockResolvedValue({ status: 200, body: { properties: { rfp_stage: 'b' } } })
    const out = await df.readHubspotDealField('123', 'rfp_stage')
    expect(out).toEqual({ value: 'b', label: 'Beta', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], writable: true })
    expect(request.mock.calls[0]![0]).toBe('/crm/v3/objects/deals/123')
  })

  it('reads nothing for a deleted Deal or a non-HubSpot id', async () => {
    request.mockResolvedValue({ status: 404, body: null })
    expect((await df.readHubspotDealField('123', 'x')).value).toBeNull()
    request.mockReset()
    expect((await df.readHubspotDealField('006000000000001AAA', 'x')).value).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('isEditableDealFieldExtra', () => {
  it('needs a read / write Deal extra on one of the teams', async () => {
    const teamId = await typeWithExtra({ sobject: 'deals', apiName: 'rfp_request', mode: 'read_write' })
    expect(await df.isEditableDealFieldExtra([teamId], 'rfp_request')).toBe(true)
    expect(await df.isEditableDealFieldExtra([teamId], 'amount')).toBe(false)
    expect(await df.isEditableDealFieldExtra([], 'rfp_request')).toBe(false)
    const other = await typeWithExtra({ sobject: 'deals', apiName: 'other_prop', mode: 'read_write' })
    expect(await df.isEditableDealFieldExtra([teamId], 'other_prop')).toBe(false)
    expect(await df.isEditableDealFieldExtra([other], 'other_prop')).toBe(true)
  })

  it('ignores read-only and Salesforce extras, and follows junction-assigned types', async () => {
    const ro = await typeWithExtra({ sobject: 'deals', apiName: 'ro_prop', mode: 'read' })
    expect(await df.isEditableDealFieldExtra([ro], 'ro_prop')).toBe(false)
    const sf = await typeWithExtra({ sobject: 'Opportunity', apiName: 'sf_prop', mode: 'read_write' })
    expect(await df.isEditableDealFieldExtra([sf], 'sf_prop')).toBe(false)
    const shared = await typeWithExtra({ sobject: 'deals', apiName: 'shared_prop', mode: 'read_write' }, { viaJunction: true })
    expect(await df.isEditableDealFieldExtra([shared], 'shared_prop')).toBe(true)
  })
})

describe('writeHubspotDealField', () => {
  it('writes the property as text and logs it to CRM Sync History', async () => {
    dealProps = new Map([['rfp_request', prop('rfp_request', { type: 'bool' })]])
    const userId = crypto.randomUUID()
    expect(await df.writeHubspotDealField({ dealId: '123', property: 'rfp_request', value: true, userId: null as unknown as string })).toEqual({ ok: true })
    expect(request).toHaveBeenCalledWith('/crm/v3/objects/deals/123', { method: 'PATCH', body: { properties: { rfp_request: 'true' } } })
    await new Promise((r) => setTimeout(r, 50))
    const rows = await testDb.select().from(schema.activitySyncAudit)
    expect(rows.map((r) => [r.source, r.crmObject, r.status])).toEqual([['opportunity_field_update', 'deals', 'success']])
    void userId
  })

  it('refuses read-only, calculated and unknown properties, wrong options and non-numbers before calling HubSpot', async () => {
    dealProps = new Map([
      ['ro', prop('ro', { readOnly: true })],
      ['calc', prop('calc', { calculated: true })],
      ['n', prop('n', { type: 'number' })],
      ['e', prop('e', { type: 'enumeration', options: new Map([['a', 'A']]) })],
    ])
    const w = (property: string, value: unknown) => df.writeHubspotDealField({ dealId: '123', property, value, userId: null as unknown as string })
    expect(await w('ro', 'x')).toMatchObject({ ok: false, status: 400, error: 'errors.hubspot.deal_field_read_only' })
    expect(await w('calc', 'x')).toMatchObject({ ok: false, error: 'errors.hubspot.deal_field_read_only' })
    expect(await w('missing', 'x')).toMatchObject({ ok: false, error: 'errors.hubspot.deal_field_read_only' })
    expect(await w('n', 'abc')).toMatchObject({ ok: false, error: 'errors.hubspot.deal_field_invalid' })
    expect(await w('e', 'z')).toMatchObject({ ok: false, error: 'errors.hubspot.deal_field_invalid' })
    expect(request).not.toHaveBeenCalled()
    expect(await w('e', null)).toEqual({ ok: true })
  })

  it('returns HubSpot\'s refusal', async () => {
    dealProps = new Map([['p', prop('p')]])
    request.mockResolvedValue({ status: 400, body: { message: 'Property values were not valid' } })
    expect(await df.writeHubspotDealField({ dealId: '123', property: 'p', value: 'x', userId: null as unknown as string })).toEqual({ ok: false, status: 502, error: 'HubSpot 400: Property values were not valid' })
  })
})
