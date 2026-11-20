// The HubSpot Project routes (phase 6b): team access, the Project-source and
// CRM gates, request checking, and the HubSpot-user requirement on writes.
// The Project service is mocked; these tests cover the routes themselves.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const TEAM = '11111111-1111-4111-8111-111111111111'
const OTHER_TEAM = '22222222-2222-4222-8222-222222222222'

vi.mock('../middleware/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/rbac.js')>('../middleware/rbac.js')
  return { ...actual, getAccessibleTeamIds: async () => [TEAM] }
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

let canWrite = true
vi.mock('../services/hubspot/dealFields.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/dealFields.js')>('../services/hubspot/dealFields.js')
  return { ...actual, canWriteHubspotDeals: async () => canWrite }
})

const listDealProjects = vi.fn(async (..._a: unknown[]) => [{ id: '7', name: 'Acme POC' }])
const readFields = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ values: { eval_status: 'done' }, labels: { eval_status: 'Done' }, dropped: [] }))
const writeFields = vi.fn(async (_a: unknown): Promise<unknown> => ({ ok: true, updated: ['proj_status'], skipped: [] }))
const prepend = vi.fn(async (_a: unknown): Promise<unknown> => ({ ok: true, target: { property: 'eng_notes', label: 'Notes' }, formattedEntry: '10/22/26 - EG: hi', charactersUsed: 17, maximumCharacters: 65536, charactersRemaining: 65519 }))
vi.mock('../services/hubspot/projects.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/projects.js')>('../services/hubspot/projects.js')
  return {
    ...actual,
    listDealProjects: (...a: unknown[]) => listDealProjects(...a),
    readHubspotProjectFields: (...a: unknown[]) => readFields(...a),
    writeHubspotProjectFields: (a: unknown) => writeFields(a),
    prependHubspotProjectField: (a: unknown) => prepend(a),
    resolvePrependTarget: async () => ({ property: 'eng_notes', label: 'Engineer Notes' }),
    readPrependCurrent: async () => ({ value: 'older', lastModifiedDate: '2026-10-01T00:00:00Z' }),
  }
})

let crmRouter: typeof import('./crm.js')['crmRouter']
let schema: typeof import('../../../drizzle/schema.js')
let evalSource: typeof import('../services/criteriaiq/evaluationSource.js')
let db: typeof import('../db/index.js')['db']
let userId = ''

beforeAll(async () => {
  crmRouter = (await import('./crm.js')).crmRouter
  schema = await import('../../../drizzle/schema.js')
  evalSource = await import('../services/criteriaiq/evaluationSource.js')
  db = (await import('../db/index.js')).db
  const [u] = await db.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: 'eg@example.com', displayName: 'E G', firstName: 'Eric', lastName: 'Garlepp' }).returning()
  userId = u!.id
})

// The real Project-source setting, so requireCrmProjects() runs as shipped.
async function setPrimary(primary: 'crm' | 'criteriaiq' | 'off') {
  const value = { primary, dataSource: primary === 'off' ? 'crm' : primary, criteriaiqSecondary: false }
  await db.insert(schema.systemSettings).values({ key: 'evaluation_source', value })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value } })
  evalSource.clearEvaluationSourceCache()
}

beforeEach(async () => {
  provider = 'hubspot'
  await setPrimary('crm')
  canWrite = true
  listDealProjects.mockClear()
  readFields.mockClear()
  writeFields.mockClear()
  prepend.mockClear()
})

async function call(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: { data: unknown; error: string | null; meta: Record<string, unknown> } }> {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: userId }; next() })
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

describe('GET /api/crm/opportunities/:id/related', () => {
  it('lists the Deal\'s Projects for a Project object only', async () => {
    const res = await call('GET', '/opportunities/42/related?sobject=0-970&labelField=hs_name')
    expect(res.body.data).toEqual([{ id: '7', name: 'Acme POC' }])
    expect(listDealProjects).toHaveBeenCalledWith('42', '0-970', 'hs_name')
    expect((await call('GET', '/opportunities/42/related?sobject=Evaluations__c')).body.error).toBe('errors.hubspot.invalid_object')
  })

  it('stands down unless the CRM object is the Project source and HubSpot the CRM', async () => {
    await setPrimary('off')
    expect((await call('GET', '/opportunities/42/related?sobject=0-970')).status).toBe(409)
    await setPrimary('criteriaiq')
    expect((await call('GET', '/opportunities/42/related?sobject=0-970')).status).toBe(409)
    await setPrimary('crm')
    provider = 'salesforce'
    expect((await call('GET', '/opportunities/42/related?sobject=0-970')).status).toBe(409)
    expect(listDealProjects).not.toHaveBeenCalled()
  })
})

describe('GET /api/crm/evaluations/:relatedId', () => {
  it('returns raw values with labels in meta, and says when nothing is mapped', async () => {
    const res = await call('GET', `/evaluations/77?teamId=${TEAM}&sobject=0-970`)
    expect(res.body).toMatchObject({ data: { eval_status: 'done' }, meta: { labels: { eval_status: 'Done' }, dropped: [] } })
    readFields.mockResolvedValueOnce('unmapped')
    expect((await call('GET', `/evaluations/77?teamId=${TEAM}&sobject=0-970`)).body.meta).toEqual({ unmapped: true })
  })

  it('refuses another team', async () => {
    expect((await call('GET', `/evaluations/77?teamId=${OTHER_TEAM}&sobject=0-970`)).status).toBe(403)
    expect(readFields).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/crm/evaluations/:relatedId', () => {
  const body = { teamId: TEAM, sobject: '0-970', fields: { eval_status: 'done' } }

  it('writes for a HubSpot user and passes HubSpot\'s refusal through', async () => {
    expect((await call('PATCH', '/evaluations/77', body)).body.data).toEqual({ ok: true, updated: ['proj_status'] })
    expect(writeFields).toHaveBeenCalledWith({ teamId: TEAM, objectTypeId: '0-970', recordId: '77', fields: { eval_status: 'done' }, userId })
    writeFields.mockResolvedValueOnce({ ok: false, status: 404, error: 'HubSpot 404', skipped: [] })
    expect(await call('PATCH', '/evaluations/77', body)).toMatchObject({ status: 404, body: { error: 'HubSpot 404' } })
  })

  it('refuses someone who isn\'t a HubSpot user, another team, or a bad body', async () => {
    canWrite = false
    expect((await call('PATCH', '/evaluations/77', body)).body.error).toBe('errors.hubspot.no_owner_match_record')
    canWrite = true
    expect((await call('PATCH', '/evaluations/77', { ...body, teamId: OTHER_TEAM })).status).toBe(403)
    expect((await call('PATCH', '/evaluations/77', { ...body, sobject: 'deals' })).status).toBe(400)
    expect(writeFields).not.toHaveBeenCalled()
  })
})

describe('Engineer Notes / Next Steps posting', () => {
  it('reads the field fresh before anything is typed', async () => {
    const res = await call('GET', `/field-prepend/meta?teamId=${TEAM}&sobject=0-970&appField=eval_engineer_notes&recordId=77`)
    expect(res.body.data).toEqual({ fieldLabel: 'Engineer Notes', maximumCharacters: 65536, currentValue: 'older', currentLength: 5, lastModifiedDate: '2026-10-01T00:00:00Z' })
  })

  it('posts for a HubSpot user, with the date and initials worked out on the server', async () => {
    const body = { teamId: TEAM, sobject: '0-970', appField: 'eval_engineer_notes', recordId: '77', text: ' hi ' }
    const res = await call('POST', '/field-prepend', body)
    expect(res.body.data).toMatchObject({ formattedEntry: '10/22/26 - EG: hi', maximumCharacters: 65536 })
    expect(prepend.mock.calls[0]![0]).toMatchObject({ teamId: TEAM, objectTypeId: '0-970', recordId: '77', text: 'hi', user: { id: userId, firstName: 'Eric', lastName: 'Garlepp' } })

    prepend.mockResolvedValueOnce({ ok: false, status: 409, error: 'errors.hubspot.field_changed', meta: { currentLength: 9 } })
    expect(await call('POST', '/field-prepend', body)).toMatchObject({ status: 409, body: { error: 'errors.hubspot.field_changed', meta: { currentLength: 9 } } })

    canWrite = false
    expect((await call('POST', '/field-prepend', body)).status).toBe(403)
    expect((await call('POST', '/field-prepend', { ...body, recordId: 'a0B000000000001' })).status).toBe(400)
  })
})
