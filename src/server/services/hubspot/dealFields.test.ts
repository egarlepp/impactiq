// HubSpot Deal writes (phase 6a): the Assigned SE property resolved from the
// team's mapping, read back as a name, the picker's options, who may write,
// and the write itself. pglite for owners, users and mappings; HubSpot's API
// and property metadata mocked.
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
  return { ...actual, getObjectPropertiesSafe: async () => dealProps }
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
  await testDb.delete(schema.crmFieldMappingTeams)
  await testDb.delete(schema.crmFieldMappings)
  await testDb.delete(schema.hubspotOwners)
})

async function team() {
  const [t] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  return t!
}

async function user(email: string, displayName = 'U') {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email, displayName }).returning()
  return u!
}

async function mapSe(teamId: string, property: string, direction: 'write' | 'read' = 'write') {
  const [row] = await testDb.insert(schema.crmFieldMappings).values({ teamId, appField: 'assigned_se_write', crmFieldApi: property, crmObject: 'deals', direction }).returning()
  await testDb.insert(schema.crmFieldMappingTeams).values({ crmFieldMappingId: row!.id, teamId })
}

describe('resolveAssignedSeField', () => {
  it('is null without a writable assigned_se_write mapping, with no fallback property', async () => {
    const t = await team()
    expect(await df.resolveAssignedSeField(t.id)).toBeNull()
    await mapSe(t.id, 'assigned_se', 'read')
    expect(await df.resolveAssignedSeField(t.id)).toBeNull()
    expect(await df.resolveAssignedSeField(null)).toBeNull()
  })

  it('reads the property type: HubSpot user, enumeration or free text', async () => {
    const t = await team()
    await mapSe(t.id, 'assigned_se')
    dealProps = new Map([['assigned_se', prop('assigned_se', { referencedObjectType: 'OWNER' })]])
    expect((await df.resolveAssignedSeField(t.id))?.fieldType).toBe('owner')
    dealProps = new Map([['assigned_se', prop('assigned_se', { options: new Map([['ana', 'Ana Silva']]) })]])
    expect((await df.resolveAssignedSeField(t.id))?.fieldType).toBe('picklist')
    dealProps = new Map()
    expect(await df.resolveAssignedSeField(t.id)).toMatchObject({ property: 'assigned_se', fieldType: 'string' })
  })
})

describe('readHubspotAssignedSe', () => {
  it('names an owner id and checks it against ImpactIQ users by email', async () => {
    await user('ana@acme.example', 'Ana Silva')
    await testDb.insert(schema.hubspotOwners).values([
      { id: '11', email: 'Ana@Acme.example', firstName: 'Ana', lastName: 'Silva' },
      { id: '12', email: 'bob@other.example', firstName: 'Bob', lastName: 'Ray' },
    ])
    const field = { property: 'assigned_se', fieldType: 'owner' as const, info: prop('assigned_se', { referencedObjectType: 'OWNER' }) }

    request.mockResolvedValueOnce({ status: 200, body: { properties: { assigned_se: '11' } } })
    expect(await df.readHubspotAssignedSe(field, '356553095874')).toEqual({ userId: '11', userName: 'Ana Silva', matched: true })
    expect(request.mock.calls[0]).toEqual(['/crm/v3/objects/deals/356553095874', { query: { properties: 'assigned_se' } }])

    request.mockResolvedValueOnce({ status: 200, body: { properties: { assigned_se: '12' } } })
    expect(await df.readHubspotAssignedSe(field, '356553095874')).toEqual({ userId: '12', userName: 'Bob Ray', matched: false })
  })

  it('shows an enumeration value by its label', async () => {
    const field = { property: 'se', fieldType: 'picklist' as const, info: prop('se', { options: new Map([['ana_s', 'Nobody Here']]) }) }
    request.mockResolvedValueOnce({ status: 200, body: { properties: { se: 'ana_s' } } })
    expect(await df.readHubspotAssignedSe(field, '1')).toEqual({ userId: 'ana_s', userName: 'Nobody Here', matched: false })
  })

  it('treats a missing Deal or empty value as unassigned, never calls HubSpot for a Salesforce id, and throws on a refusal', async () => {
    const field = { property: 'se', fieldType: 'string' as const, info: null }
    request.mockResolvedValueOnce({ status: 404, body: null })
    expect(await df.readHubspotAssignedSe(field, '1')).toEqual({ userId: null, userName: null, matched: null })
    request.mockResolvedValueOnce({ status: 200, body: { properties: { se: '' } } })
    expect(await df.readHubspotAssignedSe(field, '1')).toEqual({ userId: null, userName: null, matched: null })
    request.mockClear()
    expect(await df.readHubspotAssignedSe(field, '006000000000001AAA')).toEqual({ userId: null, userName: null, matched: null })
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce({ status: 403, body: {} })
    await expect(df.readHubspotAssignedSe(field, '1')).rejects.toMatchObject({ code: 'errors.hubspot.forbidden' })
  })
})

describe('hubspotAssignedSeOptions', () => {
  it('lists active owners by name, flagging ones not on ImpactIQ', async () => {
    await user('zed@acme.example')
    await testDb.insert(schema.hubspotOwners).values([
      { id: '1', email: 'zed@acme.example', firstName: 'Zed', lastName: 'Ng' },
      { id: '2', email: 'amy@other.example', firstName: 'Amy', lastName: null },
      { id: '3', email: 'gone@acme.example', firstName: 'Gone', lastName: 'User', archived: true },
    ])
    const opts = await df.hubspotAssignedSeOptions({ property: 'se', fieldType: 'owner', info: null })
    expect(opts).toEqual([
      { value: '2', label: 'Amy', matched: false },
      { value: '1', label: 'Zed Ng', matched: true },
    ])
  })

  it('lists enumeration options, and nothing for free text', async () => {
    await user('x@acme.example', 'Ana Silva')
    const info = prop('se', { options: new Map([['ana', 'Ana Silva'], ['tbd', 'TBD']]) })
    expect(await df.hubspotAssignedSeOptions({ property: 'se', fieldType: 'picklist', info })).toEqual([
      { value: 'ana', label: 'Ana Silva', matched: true },
      { value: 'tbd', label: 'TBD', matched: false },
    ])
    expect(await df.hubspotAssignedSeOptions({ property: 'se', fieldType: 'string', info: null })).toEqual([])
  })
})

describe('canWriteHubspotDeals', () => {
  it('needs an active HubSpot owner with the user\'s email', async () => {
    const matched = await user('Lee@Acme.example')
    const archived = await user('old@acme.example')
    const none = await user('nobody@acme.example')
    await testDb.insert(schema.hubspotOwners).values([
      { id: '5', email: 'lee@acme.example' },
      { id: '6', email: 'old@acme.example', archived: true },
    ])
    expect(await df.canWriteHubspotDeals(matched.id)).toBe(true)
    expect(await df.canWriteHubspotDeals(archived.id)).toBe(false)
    expect(await df.canWriteHubspotDeals(none.id)).toBe(false)
  })
})

describe('writeHubspotAssignedSe', () => {
  const field = { property: 'assigned_se', fieldType: 'owner' as const, info: null }

  it('patches the Deal and records the write in CRM Sync History', async () => {
    const u = await user('w@acme.example')
    expect(await df.writeHubspotAssignedSe({ field, dealId: '42', value: '11', valueName: 'Ana Silva', userId: u.id })).toBeNull()
    expect(request).toHaveBeenCalledWith('/crm/v3/objects/deals/42', { method: 'PATCH', body: { properties: { assigned_se: '11' } } })
    await vi.waitFor(async () => {
      const rows = await testDb.select().from(schema.activitySyncAudit)
      expect(rows[0]).toMatchObject({ source: 'assigned_se_update', status: 'success', crmObject: 'deals', crmRecordId: '42' })
    })
  })

  it('clears with an empty value and returns HubSpot\'s message on a refusal', async () => {
    const u = await user('w2@acme.example')
    request.mockResolvedValueOnce({ status: 400, body: { message: 'Property values were not valid' } })
    expect(await df.writeHubspotAssignedSe({ field, dealId: '42', value: null, valueName: null, userId: u.id })).toBe('HubSpot 400: Property values were not valid')
    expect(request.mock.calls[0]![1]).toEqual({ method: 'PATCH', body: { properties: { assigned_se: '' } } })
    await vi.waitFor(async () => {
      const rows = await testDb.select().from(schema.activitySyncAudit)
      expect(rows[0]).toMatchObject({ status: 'failed', errorMessage: 'HubSpot 400: Property values were not valid' })
    })
  })

  it('never writes to a Salesforce id', async () => {
    const u = await user('w3@acme.example')
    expect(await df.writeHubspotAssignedSe({ field, dealId: '006000000000001AAA', value: '1', valueName: null, userId: u.id })).toContain('Not a HubSpot record')
    expect(request).not.toHaveBeenCalled()
  })
})
