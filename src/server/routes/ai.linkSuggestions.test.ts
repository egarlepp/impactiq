// AI link suggestions on HubSpot: the note's phrases are searched through
// the HubSpot provider session (Deals, Companies, Campaigns), Salesforce is
// never called, and a missing HubSpot connection answers 401.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let currentUserId = ''
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js')
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { user: { id: string } }).user = { id: currentUserId }
      next()
    },
  }
})

vi.mock('../services/ai/gateway.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai/gateway.js')>('../services/ai/gateway.js')
  return {
    ...actual,
    runAi: async () => ({ ok: true, text: JSON.stringify({ candidates: ['Acme Corp', 'Globex'] }) }),
  }
})

const getSfConnection = vi.fn(async () => null)
vi.mock('../services/salesforce/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/salesforce/client.js')>('../services/salesforce/client.js')
  return { ...actual, getSfConnection: () => getSfConnection() }
})

const searchOpportunities = vi.fn(async (q: string) => q === 'Acme Corp'
  ? [{ Id: '101', Name: 'Acme Corp renewal', StageName: 'Proposal', AccountId: '201', AccountName: 'Acme Corp', CloseDate: '2026-12-01', Amount: 1000, ForecastCategoryName: null, OwnerName: null }]
  : [])
const searchAccounts = vi.fn(async (q: string) => q === 'Acme Corp' || q === 'Globex'
  ? [{ Id: q === 'Globex' ? '202' : '201', Name: q, Industry: 'Software', OwnerName: null }]
  : [])
const searchCampaigns = vi.fn(async () => [])
let hubspotConnected = true
vi.mock('../services/crm/index.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/index.js')>('../services/crm/index.js')
  return {
    ...actual,
    getActiveCrmProvider: async () => ({
      id: 'hubspot',
      connectForUser: async () => hubspotConnected
        ? { searchOpportunities, searchAccounts, searchCampaigns, searchContacts: vi.fn(), searchLeads: vi.fn(), readPreview: vi.fn() }
        : null,
    }),
  }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let aiRouter: typeof import('./ai.js')['aiRouter']

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  aiRouter = (await import('./ai.js')).aiRouter
})

beforeEach(() => {
  hubspotConnected = true
  getSfConnection.mockClear()
  searchOpportunities.mockClear()
  searchAccounts.mockClear()
  searchCampaigns.mockClear()
})

async function seedNote(): Promise<string> {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  const [activity] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'Call', activityTypeId: type!.id, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
  }).returning()
  const [note] = await testDb.insert(schema.activityNotes).values({ activityId: activity!.id, body: 'Met Acme Corp and Globex', createdBy: user!.id }).returning()
  currentUserId = user!.id
  return note!.id
}

async function post(noteId: string): Promise<{ status: number; body: { data: { suggestions: Array<{ type: string; id: string; name: string; extra: string | null }> } | null; error: string | null } }> {
  const app = express()
  app.use(express.json())
  app.use('/api/ai', aiRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/link-suggestions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ noteId }),
    })
    return { status: res.status, body: await res.json() as never }
  } finally {
    server.close()
  }
}

describe('POST /api/ai/link-suggestions on HubSpot', () => {
  it('suggests Deals and Companies found through the HubSpot session', async () => {
    const noteId = await seedNote()
    const res = await post(noteId)
    expect(res.status).toBe(200)
    const sugg = res.body.data!.suggestions
    expect(sugg.map((s) => `${s.type}:${s.id}`).sort()).toEqual(['Account:201', 'Account:202', 'Opportunity:101'])
    expect(sugg.find((s) => s.id === '101')!.extra).toBe('Proposal')
    // Open search for open Deals only, the same scope as the Salesforce SOQL.
    expect(searchOpportunities).toHaveBeenCalledWith('Acme Corp', { openSearch: true, showClosed: false })
    expect(getSfConnection).not.toHaveBeenCalled()
  })

  it('answers 401 when the user has no HubSpot session', async () => {
    hubspotConnected = false
    const noteId = await seedNote()
    const res = await post(noteId)
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('errors.crm.not_connected')
    expect(searchAccounts).not.toHaveBeenCalled()
  })
})
