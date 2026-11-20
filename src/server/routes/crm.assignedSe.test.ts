// The HubSpot Assigned SE routes (phase 6a): with no mapping the picker is
// reported as not configured; a write needs a matched HubSpot owner, a
// mapped property and, for an owner or option property, one of its values.
// The Deal-field service is mocked; these tests cover the route's gates.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

vi.mock('../middleware/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/rbac.js')>('../middleware/rbac.js')
  return { ...actual, getAccessibleTeamIds: async () => ['team-1'] }
})

let provider = 'hubspot'
vi.mock('../services/crm/providerSetting.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/providerSetting.js')>('../services/crm/providerSetting.js')
  return { ...actual, getCrmProviderId: async () => provider }
})
vi.mock('../services/hubspot/config.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/config.js')>('../services/hubspot/config.js')
  return { ...actual, getHubspotConfig: async () => ({ portalId: 1 }) }
})

type Field = { property: string; fieldType: 'owner' | 'picklist' | 'string'; info: null }
let field: Field | null = { property: 'assigned_se', fieldType: 'owner', info: null }
let canWrite = true
let hasOwner = true
vi.mock('../services/hubspot/dealEditPolicy.js', () => ({
  canEditHubspotDeal: async () => canWrite,
}))
vi.mock('../services/hubspot/owners.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/owners.js')>('../services/hubspot/owners.js')
  return { ...actual, getHubspotOwnerIdForUser: async () => (hasOwner ? '11' : null) }
})
const write = vi.fn(async (_args: unknown): Promise<string | null> => null)
vi.mock('../services/hubspot/dealFields.js', () => ({
  resolveAssignedSeField: async () => field,
  readHubspotAssignedSe: async () => ({ userId: '11', userName: 'Ana Silva', matched: true }),
  hubspotAssignedSeOptions: async () => [{ value: '11', label: 'Ana Silva', matched: true }],
  canWriteHubspotDeals: async () => canWrite,
  writeHubspotAssignedSe: (args: unknown) => write(args),
}))

let crmRouter: typeof import('./crm.js')['crmRouter']

beforeAll(async () => {
  crmRouter = (await import('./crm.js')).crmRouter
})

beforeEach(() => {
  provider = 'hubspot'
  field = { property: 'assigned_se', fieldType: 'owner', info: null }
  canWrite = true
  hasOwner = true
  write.mockReset()
  write.mockResolvedValue(null)
})

async function call(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; body: { data: unknown; error: string | null; meta: Record<string, unknown> } }> {
  const app = express()
  app.use(express.json())
  // requireAuth runs where the router is mounted (index.ts); stand in for it.
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: 'user-1' }; next() })
  app.use('/api/crm', crmRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/crm${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : null,
    })
    return { status: res.status, body: await res.json() as never }
  } finally {
    server.close()
  }
}

describe('GET /api/crm/opportunities/:id/assigned-se', () => {
  it('reports the property, its type and whether this user may write', async () => {
    canWrite = false
    hasOwner = false
    const res = await call('GET', '/opportunities/42/assigned-se?teamId=team-1')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ userId: '11', userName: 'Ana Silva', matched: true })
    expect(res.body.meta).toEqual({ configured: true, writeField: 'assigned_se', fieldType: 'owner', canWrite: false, readOnlyReason: 'errors.hubspot.no_owner_match' })
    // Matched, but the "named on the Deal" rule leaves them read-only here.
    hasOwner = true
    expect((await call('GET', '/opportunities/42/assigned-se?teamId=team-1')).body.meta).toMatchObject({ canWrite: false, readOnlyReason: 'errors.hubspot.deal_not_named' })
    canWrite = true
    expect((await call('GET', '/opportunities/42/assigned-se?teamId=team-1')).body.meta).toMatchObject({ canWrite: true, readOnlyReason: null })
  })

  it('says not configured with no mapping, and refuses another team or another CRM', async () => {
    field = null
    expect((await call('GET', '/opportunities/42/assigned-se?teamId=team-1')).body.meta).toEqual({ configured: false })
    expect((await call('GET', '/opportunities/42/assigned-se?teamId=team-2')).status).toBe(403)
    provider = 'salesforce'
    expect((await call('GET', '/opportunities/42/assigned-se?teamId=team-1')).status).toBe(409)
  })
})

describe('PATCH /api/crm/opportunities/:id/assigned-se', () => {
  it('writes an allowed value', async () => {
    const res = await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: '11', userName: 'Ana Silva' })
    expect(res.status).toBe(200)
    expect(write).toHaveBeenCalledWith({ field, dealId: '42', value: '11', valueName: 'Ana Silva', userId: 'user-1' })
  })

  it('refuses a user who is not a HubSpot owner, a missing mapping and a value outside the options', async () => {
    canWrite = false
    hasOwner = false
    expect((await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: '11' })).body.error).toBe('errors.hubspot.no_owner_match')
    hasOwner = true
    expect((await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: '11' })).body).toMatchObject({ error: 'errors.hubspot.deal_not_named' })
    canWrite = true
    field = null
    expect((await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: '11' })).body.error).toBe('errors.hubspot.assigned_se_unmapped')
    field = { property: 'assigned_se', fieldType: 'owner', info: null }
    const bad = await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: '999' })
    expect(bad).toMatchObject({ status: 400, body: { error: 'errors.hubspot.assigned_se_invalid' } })
    expect(write).not.toHaveBeenCalled()
  })

  it('accepts free text for a text property, clears with no value, and reports HubSpot\'s refusal', async () => {
    field = { property: 'se_name', fieldType: 'string', info: null }
    expect((await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: 'Anyone' })).status).toBe(200)
    expect((await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: '' })).status).toBe(200)
    expect(write.mock.calls[1]![0]).toMatchObject({ value: null })
    write.mockResolvedValueOnce('HubSpot 400: bad')
    const res = await call('PATCH', '/opportunities/42/assigned-se', { teamId: 'team-1', userId: 'X' })
    expect(res).toMatchObject({ status: 502, body: { error: 'HubSpot 400: bad' } })
  })
})

describe('GET /api/crm/picklists/opportunity/assigned-se', () => {
  it('lists options, folding an owner property into a fixed list', async () => {
    const res = await call('GET', '/picklists/opportunity/assigned-se?teamId=team-1')
    expect(res.body).toMatchObject({ data: [{ value: '11', label: 'Ana Silva', matched: true }], meta: { fieldType: 'picklist', field: 'assigned_se' } })
    field = null
    expect((await call('GET', '/picklists/opportunity/assigned-se?teamId=team-1')).body).toMatchObject({ data: [], meta: { fieldType: null } })
  })
})
