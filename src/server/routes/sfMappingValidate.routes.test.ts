// CRM Field Mappings' CRM toggle (v1.404): Validate & dry run checks the CRM
// named in the request body, or the active CRM when none is named. Both
// validators are mocked; this only checks which one runs.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

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

let provider = 'salesforce'
vi.mock('../services/crm/providerSetting.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/providerSetting.js')>('../services/crm/providerSetting.js')
  return { ...actual, getCrmProviderId: async () => provider, isCrmProviderActive: async (p: string) => p === provider }
})
const sfValidate = vi.fn(async () => ({ crm: 'salesforce' }))
vi.mock('../services/salesforce/mappingValidation.js', async () => {
  const actual = await vi.importActual<typeof import('../services/salesforce/mappingValidation.js')>('../services/salesforce/mappingValidation.js')
  return { ...actual, validateTeamMappings: () => sfValidate() }
})
const hsValidate = vi.fn(async () => ({ crm: 'hubspot' }))
vi.mock('../services/hubspot/mappingValidation.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/mappingValidation.js')>('../services/hubspot/mappingValidation.js')
  return { ...actual, validateHubspotTeamMappings: () => hsValidate() }
})

let adminRouter: typeof import('./admin.js')['adminRouter']
beforeAll(async () => { adminRouter = (await import('./admin.js')).adminRouter })
beforeEach(() => { provider = 'salesforce'; sfValidate.mockClear(); hsValidate.mockClear() })

async function validate(body: unknown) {
  const app = express()
  app.use('/api/admin', adminRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/teams/t1/sf-field-mappings/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return (await res.json() as { data: { crm: string } }).data.crm
  } finally {
    server.close()
  }
}

describe('POST /teams/:teamId/sf-field-mappings/validate', () => {
  it('checks the active CRM when the body names none', async () => {
    expect(await validate({})).toBe('salesforce')
    provider = 'hubspot'
    expect(await validate({})).toBe('hubspot')
  })

  it('checks the CRM the toggle names, whichever CRM is active', async () => {
    expect(await validate({ crm: 'hubspot' })).toBe('hubspot')
    provider = 'hubspot'
    expect(await validate({ crm: 'salesforce' })).toBe('salesforce')
  })

  it('ignores an unknown CRM name', async () => {
    provider = 'none'
    expect(await validate({ crm: 'pipedrive' })).toBe('salesforce')
    expect(sfValidate).toHaveBeenCalledTimes(1)
    expect(hsValidate).not.toHaveBeenCalled()
  })
})
