// Team Management and User Management on HubSpot (v1.406.0): the CRM user
// picker lists HubSpot owners, a picked owner resolves to its ImpactIQ user,
// a linked user shows its HubSpot teams, and the department link lists
// HubSpot team names. Auth and the HubSpot API are mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js')
  return { ...actual, requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: '00000000-0000-0000-0000-000000000001', isAppAdmin: true }; next() } }
})
vi.mock('../middleware/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/rbac.js')>('../middleware/rbac.js')
  const pass = (_req: unknown, _res: unknown, next: () => void) => next()
  return { ...actual, requireGlobalAdmin: pass, requireAppAdmin: pass }
})

let provider = 'hubspot'
vi.mock('../services/crm/providerSetting.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/providerSetting.js')>('../services/crm/providerSetting.js')
  return { ...actual, getCrmProviderId: async () => provider, isCrmProviderActive: async (p: string) => p === provider }
})

const runSync = vi.fn()
vi.mock('../services/hubspot/owners.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/owners.js')>('../services/hubspot/owners.js')
  return { ...actual, runHubspotOwnerSync: (...args: unknown[]) => runSync(...args) }
})
const adminSf = vi.fn(async () => null)
vi.mock('../services/salesforce/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/salesforce/client.js')>('../services/salesforce/client.js')
  return { ...actual, getAdminSfConnection: () => adminSf(), getSfConnection: async () => null }
})

let adminRouter: typeof import('./admin.js')['adminRouter']
let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let dana: { id: string }

beforeAll(async () => {
  adminRouter = (await import('./admin.js')).adminRouter
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  await testDb.insert(schema.crmUsers).values([
    { id: '005000000000001AAA', name: 'Alex Salesforce', email: 'alex@example.com' },
    { id: '501', name: 'Avery Owner', email: 'avery@example.com' },
    { id: '502', name: 'Archived Owner', email: 'old@example.com', isActive: false },
  ])
  await testDb.insert(schema.hubspotOwners).values([
    { id: '501', email: 'avery@example.com', firstName: 'Avery', lastName: 'Owner', teams: [{ id: '1', name: 'EMEA', primary: true }] },
    { id: '502', email: 'old@example.com', archived: true, teams: [{ id: '9', name: 'Old Team', primary: true }] },
  ])
  const [u] = await testDb.insert(schema.users).values({ oktaId: 'okta-dana', email: 'Avery@Example.com', displayName: 'Avery' }).returning()
  dana = u!
})

beforeEach(() => {
  provider = 'hubspot'
  runSync.mockReset()
  adminSf.mockClear()
})

async function get(path: string) {
  const app = express()
  app.use('/api/admin', adminRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/admin${path}`)
    return { status: res.status, body: await res.json() as { data: unknown; error: string | null; meta: Record<string, unknown> } }
  } finally {
    server.close()
  }
}

describe('GET /api/admin/sf/users', () => {
  it('lists active HubSpot owners on HubSpot, never Salesforce users', async () => {
    const res = await get('/sf/users?q=a')
    expect((res.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['501'])
    expect(res.body.meta['source']).toBe('hubspot_owners')
    expect(runSync).not.toHaveBeenCalled()
    expect(adminSf).not.toHaveBeenCalled()
  })

  it('re-syncs owners on refresh, and reports a HubSpot failure', async () => {
    await get('/sf/users?refresh=1')
    expect(runSync).toHaveBeenCalledWith({ source: 'manual' })
    const { HubspotError } = await import('../services/hubspot/client.js')
    runSync.mockRejectedValueOnce(new HubspotError('errors.hubspot.unauthorized', 401))
    const res = await get('/sf/users?refresh=1')
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('errors.hubspot.unauthorized')
  })

  it('leaves HubSpot owner rows out of the Salesforce cache', async () => {
    provider = 'salesforce'
    const res = await get('/sf/users')
    expect((res.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['005000000000001AAA'])
  })
})

describe('GET /api/admin/users/by-sf/:id', () => {
  it('resolves a HubSpot owner to its user by email', async () => {
    const res = await get('/users/by-sf/501')
    expect((res.body.data as { id: string }).id).toBe(dana.id)
    expect((await get('/users/by-sf/999')).body.data).toBeNull()
  })
})

describe('GET /api/admin/users/:userId/sf-details', () => {
  it("returns the matched owner's HubSpot teams instead of Title/Manager", async () => {
    const res = await get(`/users/${dana.id}/sf-details`)
    expect(res.body.data).toEqual({ title: null, managerName: null, managerId: null, teams: ['EMEA'] })
  })
})

describe('GET /api/admin/sf/departments', () => {
  it('lists team names of active HubSpot owners', async () => {
    expect((await get('/sf/departments')).body.data).toEqual(['EMEA'])
    expect((await get('/sf/departments?q=zzz')).body.data).toEqual([])
    expect(adminSf).not.toHaveBeenCalled()
  })
})
