// Sales Team Alignment on HubSpot (phase 7b): the people picker lists only the
// active CRM's rows of crm_users, and the refresh button syncs HubSpot owners
// when HubSpot is the CRM. Auth and the HubSpot API are mocked.
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
const syncSf = vi.fn()
vi.mock('../services/salesforce/users.js', async () => ({ runSfUserSync: () => syncSf() }))
vi.mock('../services/audit/log.js', async () => {
  const actual = await vi.importActual<typeof import('../services/audit/log.js')>('../services/audit/log.js')
  return { ...actual, logAudit: async () => {} }
})

let adminRouter: typeof import('./admin.js')['adminRouter']
let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  adminRouter = (await import('./admin.js')).adminRouter
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  await testDb.delete(schema.crmUserAlignments)
  await testDb.delete(schema.crmUsers)
  await testDb.insert(schema.crmUsers).values([
    { id: '005000000000001AAA', name: 'Alex Salesforce', email: 'alex@example.com' },
    { id: '501', name: 'Avery HubSpot', email: 'avery@example.com' },
    { id: '502', name: 'Archived Owner', isActive: false },
  ])
})

beforeEach(() => {
  provider = 'hubspot'
  runSync.mockReset()
  syncSf.mockReset()
})

async function call(method: 'GET' | 'POST', path: string) {
  const app = express()
  app.use('/api/admin', adminRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/admin${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : null })
    return { status: res.status, body: await res.json() as { data: unknown; error: string | null } }
  } finally {
    server.close()
  }
}

describe('GET /api/admin/sf-users', () => {
  it("lists only the active CRM's people", async () => {
    const hs = await call('GET', '/sf-users?q=a')
    expect((hs.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['501'])
    provider = 'salesforce'
    const sf = await call('GET', '/sf-users')
    expect((sf.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['005000000000001AAA'])
  })
})

describe('POST /api/admin/salesforce/sync-users', () => {
  it('syncs HubSpot owners on HubSpot', async () => {
    runSync.mockResolvedValue({ active: 4, archived: 1, removed: 0 })
    const res = await call('POST', '/salesforce/sync-users')
    expect(res.body.data).toEqual({ upserted: 4 })
    expect(runSync).toHaveBeenCalledWith({ source: 'manual' })
    expect(syncSf).not.toHaveBeenCalled()
  })

  it('answers 409 without a HubSpot connection', async () => {
    runSync.mockResolvedValue(null)
    expect(await call('POST', '/salesforce/sync-users')).toMatchObject({ status: 409, body: { error: 'errors.hubspot.not_configured' } })
  })

  it('syncs Salesforce users on Salesforce', async () => {
    provider = 'salesforce'
    syncSf.mockResolvedValue({ upserted: 7 })
    expect((await call('POST', '/salesforce/sync-users')).body.data).toEqual({ upserted: 7 })
    expect(runSync).not.toHaveBeenCalled()
  })
})
