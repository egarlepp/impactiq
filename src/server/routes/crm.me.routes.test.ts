// GET /api/crm/me (v1.408.0): the signed-in user's own link to the active CRM
// for My Settings → My Connections. On HubSpot it reports the portal and the
// HubSpot owner the user is matched to; other CRMs only report the provider.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let provider = 'hubspot'
vi.mock('../services/crm/providerSetting.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/providerSetting.js')>('../services/crm/providerSetting.js')
  return { ...actual, getCrmProviderId: async () => provider, isCrmProviderActive: async (p: string) => p === provider }
})

let configured = true
vi.mock('../services/hubspot/config.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/config.js')>('../services/hubspot/config.js')
  return {
    ...actual,
    getHubspotConfig: async () => (configured
      ? { accessToken: 'x', portalId: 1, portalName: null, accountType: null, uiDomain: 'app.hubspot.com', lastCheck: null }
      : null),
  }
})

let crmRouter: typeof import('./crm.js')['crmRouter']
let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let userId = ''

beforeAll(async () => {
  crmRouter = (await import('./crm.js')).crmRouter
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  provider = 'hubspot'
  configured = true
  await testDb.delete(schema.hubspotOwners)
  await testDb.delete(schema.users)
  const [u] = await testDb.insert(schema.users)
    .values({ oktaId: `okta-${crypto.randomUUID()}`, email: 'Jane@Acme.com', displayName: 'Jane Doe' }).returning()
  userId = u!.id
})

async function getMe() {
  const app = express()
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: userId }; next() })
  app.use('/api/crm', crmRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/crm/me`)
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> } }
  } finally {
    server.close()
  }
}

describe('GET /api/crm/me', () => {
  it('reports the matched HubSpot owner by email', async () => {
    await testDb.insert(schema.hubspotOwners).values({ id: '501', email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe' })
    const { status, body } = await getMe()
    expect(status).toBe(200)
    expect(body.data).toEqual({
      provider: 'hubspot',
      configured: true,
      portalName: 'app.hubspot.com',
      owner: { id: '501', name: 'Jane Doe', email: 'jane@acme.com' },
    })
  })

  it('reports no owner when none matches, and ignores archived owners', async () => {
    await testDb.insert(schema.hubspotOwners).values({ id: '502', email: 'jane@acme.com', archived: true })
    const { body } = await getMe()
    expect(body.data).toMatchObject({ configured: true, owner: null })
  })

  it('reports not configured without a HubSpot connection', async () => {
    configured = false
    await testDb.insert(schema.hubspotOwners).values({ id: '501', email: 'jane@acme.com' })
    const { body } = await getMe()
    expect(body.data).toEqual({ provider: 'hubspot', configured: false, portalName: null, owner: null })
  })

  it('only reports the provider on other CRMs', async () => {
    provider = 'salesforce'
    expect((await getMe()).body.data).toEqual({ provider: 'salesforce' })
    provider = 'none'
    expect((await getMe()).body.data).toEqual({ provider: 'none' })
  })
})
