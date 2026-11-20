// Account drill "Include All" on HubSpot: Leads come from the local
// crm_lead_account_link cache (filled by the nightly HubSpot snapshot
// refresh), Salesforce is never called, and the Campaign bucket stays empty
// since HubSpot has no Deal → Campaign link.
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

vi.mock('../services/crm/providerSetting.js', async () => {
  const actual = await vi.importActual<typeof import('../services/crm/providerSetting.js')>('../services/crm/providerSetting.js')
  return { ...actual, getCrmProviderId: async () => 'hubspot' }
})

let leadsMissing = false
vi.mock('../services/hubspot/config.js', async () => {
  const actual = await vi.importActual<typeof import('../services/hubspot/config.js')>('../services/hubspot/config.js')
  return { ...actual, getHubspotConfig: async () => ({ lastCheck: { capabilities: [{ key: 'leads_read', status: leadsMissing ? 'missing' : 'ok' }] } }) }
})

const getSfConnection = vi.fn(async () => null)
vi.mock('../services/salesforce/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/salesforce/client.js')>('../services/salesforce/client.js')
  return { ...actual, getSfConnection: () => getSfConnection() }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let activitiesRouter: typeof import('./activities.js')['activitiesRouter']

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  activitiesRouter = (await import('./activities.js')).activitiesRouter
})

beforeEach(() => {
  leadsMissing = false
  getSfConnection.mockClear()
})

async function seed(): Promise<{ teamId: string }> {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: user!.id, role: 'contributor' })
  currentUserId = user!.id
  const base = {
    userId: user!.id, teamId: team!.id, activityTypeId: type!.id, status: 'submitted' as const,
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
  }
  await testDb.insert(schema.activities).values([
    { ...base, title: 'On the Company', crmWhatType: 'Account', crmWhatId: '500' },
    { ...base, title: 'On a Deal', crmWhatType: 'Opportunity', crmWhatId: '600', crmAccountId: '500' },
    { ...base, title: 'With the Lead', crmWhoType: 'Lead', crmWhoId: '700' },
    { ...base, title: 'Other Lead', crmWhoType: 'Lead', crmWhoId: '701' },
  ])
  await testDb.insert(schema.crmLeadAccountLink).values([
    { leadId: '700', accountId: '500' },
    { leadId: '701', accountId: '999' },
  ]).onConflictDoNothing()
  return { teamId: team!.id }
}

async function get(teamId: string): Promise<{ status: number; titles: string[]; meta: { leadIds: string[]; campaignIds: string[]; breakdown: Array<{ type: string; count: number }> } }> {
  const app = express()
  app.use('/api/activities', activitiesRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/activities/account-drill?teamId=${teamId}&accountId=500&mode=include_all`)
    const body = await res.json() as { data: Array<{ title: string }> | null; meta: never }
    return { status: res.status, titles: (body.data ?? []).map((r) => r.title).sort(), meta: body.meta }
  } finally {
    server.close()
  }
}

describe('GET /api/activities/account-drill on HubSpot', () => {
  it('rolls in the Company\'s Deals and its linked Leads without calling Salesforce', async () => {
    const { teamId } = await seed()
    const res = await get(teamId)
    expect(res.titles).toEqual(['On a Deal', 'On the Company', 'With the Lead'])
    expect(res.meta.leadIds).toEqual(['700'])
    expect(res.meta.campaignIds).toEqual([])
    expect(res.meta.breakdown.map((b) => b.type).sort()).toEqual(['Account', 'Lead', 'Opportunity'])
    expect(getSfConnection).not.toHaveBeenCalled()
  })

  it('leaves Leads out when the portal has none', async () => {
    leadsMissing = true
    const { teamId } = await seed()
    const res = await get(teamId)
    expect(res.titles).toEqual(['On a Deal', 'On the Company'])
    expect(res.meta.leadIds).toEqual([])
  })

  it('refuses a team the caller isn\'t on', async () => {
    const { teamId } = await seed()
    const [other] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'Other' }).returning()
    currentUserId = other!.id
    expect((await get(teamId)).status).toBe(403)
  })
})
