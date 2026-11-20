// HubSpot link health (phase 7): which links are HubSpot records, sorting a
// batch read into found / merged / gone, moving links off merged records
// (plus a merged Company's stored Company and a merged Deal's Closed Lost
// dismissal), flagging deleted records, and the nightly job against pglite
// with HubSpot's API mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

type Req = { method?: string; body?: unknown; query?: Record<string, unknown> }
const request = vi.fn(async (_path: string, _opts?: Req): Promise<{ status: number; body: unknown }> => ({ status: 200, body: {} }))
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  const hubspotJson = async (path: string, opts?: Req) => {
    const { status, body } = await request(path, opts)
    if (status === 401) throw new actual.HubspotError('errors.hubspot.unauthorized', 401)
    if (status === 403) throw new actual.HubspotError('errors.hubspot.forbidden', 403)
    if (status < 200 || status >= 300 || body === null) throw new actual.HubspotError('errors.hubspot.bad_response', status)
    return body
  }
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts), hubspotJson }
})

let leadsStatus: 'ok' | 'missing' = 'ok'
let configured = true
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return {
    ...actual,
    getHubspotConfig: async () => configured
      ? { accessToken: 'x', portalId: '1', portalName: null, accountType: null, uiDomain: null, lastCheck: { checkedAt: '', ok: true, capabilities: [{ key: 'leads_read', status: leadsStatus }] } }
      : null,
  }
})

import { hubspotObjectForLink } from './linkHealth.js'

describe('hubspotObjectForLink', () => {
  it('maps each link type to its HubSpot object, and leaves the rest out', () => {
    expect(hubspotObjectForLink('what', 'Opportunity')).toBe('deals')
    expect(hubspotObjectForLink('what', 'Account')).toBe('companies')
    expect(hubspotObjectForLink('what', 'Campaign')).toBeNull()
    expect(hubspotObjectForLink('who', 'Contact')).toBe('contacts')
    expect(hubspotObjectForLink('who', 'Lead')).toBe('leads')
    expect(hubspotObjectForLink('related', '0-970')).toBe('0-970')
    expect(hubspotObjectForLink('related', '2-1234567')).toBe('2-1234567')
    expect(hubspotObjectForLink('related', 'Evaluations__c')).toBeNull()
    expect(hubspotObjectForLink('related', 'CriteriaIQ')).toBeNull()
    expect(hubspotObjectForLink('what', null)).toBeNull()
  })
})

// ── pglite ──────────────────────────────────────────────────────────────

let lh: typeof import('./linkHealth.js')
let schema: typeof import('../../../../drizzle/schema.js')
let orm: typeof import('drizzle-orm')
let testDb: TestDb

beforeAll(async () => {
  lh = await import('./linkHealth.js')
  schema = await import('../../../../drizzle/schema.js')
  orm = await import('drizzle-orm')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  request.mockReset()
  leadsStatus = 'ok'
  configured = true
  await testDb.delete(schema.oppReviewDismissals)
  await testDb.delete(schema.activities)
  await testDb.delete(schema.auditEvents)
  await testDb.delete(schema.jobRuns)
})

let teamId = ''
let userId = ''
let typeId = ''
async function base() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  teamId = team!.id; userId = user!.id; typeId = type!.id
}

async function activity(fields: Partial<typeof schema.activities.$inferInsert>) {
  const [row] = await testDb.insert(schema.activities).values({
    userId, teamId, title: 'A', activityTypeId: typeId, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    ...fields,
  }).returning()
  return row!
}

async function reload(id: string) {
  const [row] = await testDb.select().from(schema.activities).where(orm.eq(schema.activities.id, id))
  return row!
}

// One batch-read answer per object: found records (with any merged ids) and
// ids HubSpot reports as not found. Anything else 404s.
type ObjectAnswer = { results?: unknown[]; notFound?: string[] } | 'fail' | 'unauthorized'
function hubspot(objects: Record<string, ObjectAnswer>) {
  request.mockImplementation(async (path) => {
    const m = /^\/crm\/v3\/objects\/([^/]+)\/batch\/read$/.exec(path)
    const answer = m ? objects[m[1]!] : undefined
    if (!answer) return { status: 404, body: { path } }
    if (answer === 'fail') return { status: 500, body: {} }
    if (answer === 'unauthorized') return { status: 401, body: {} }
    const errors = answer.notFound?.length ? [{ status: 'error', category: 'OBJECT_NOT_FOUND', context: { ids: answer.notFound } }] : []
    return { status: errors.length ? 207 : 200, body: { status: 'COMPLETE', results: answer.results ?? [], errors } }
  })
}

describe('resolveHubspotRecords', () => {
  it('sorts ids into found, merged and gone, and asks for hs_merged_object_ids', async () => {
    hubspot({ deals: {
      results: [{ id: '1', properties: {} }, { id: '9', properties: { hs_merged_object_ids: '2;3' } }],
      notFound: ['4'],
    } })
    const res = await lh.resolveHubspotRecords('deals', ['1', '2', '4', '5', '1'], ['dealname'])
    expect([...res.records.keys()].sort()).toEqual(['1', '2'])
    expect(res.records.get('2')!.id).toBe('9')
    expect([...res.merged]).toEqual([['2', '9']])
    expect([...res.gone]).toEqual(['4'])
    const body = request.mock.calls[0]![1]!.body as { inputs: Array<{ id: string }>; properties: string[] }
    expect(body.inputs.map((i) => i.id)).toEqual(['1', '2', '4', '5'])
    expect(body.properties).toEqual(['dealname', 'hs_merged_object_ids'])
  })

  it('throws when the request fails, so nothing is written', async () => {
    hubspot({ deals: 'fail' })
    await expect(lh.resolveHubspotRecords('deals', ['1'], [])).rejects.toThrow()
  })
})

describe('checkLinkedRecords', () => {
  it('flags gone records, clears found ones and leaves unknown ones alone', async () => {
    await base()
    const found = await activity({ crmWhoId: '1', crmWhoType: 'Contact', crmWhoDeleted: true })
    const gone = await activity({ crmWhoId: '2', crmWhoType: 'Contact' })
    const unknown = await activity({ crmWhoId: '3', crmWhoType: 'Contact', crmWhoDeleted: true })
    const lead = await activity({ crmWhoId: '2', crmWhoType: 'Lead' })
    hubspot({ contacts: { results: [{ id: '1', properties: {} }], notFound: ['2'] } })

    expect(await lh.checkLinkedRecords('who', 'contacts', ['1', '2', '3'])).toEqual({ checked: 3, gone: 1, merged: 0, moved: 0 })
    expect(await reload(found.id)).toMatchObject({ crmWhoDeleted: false })
    expect((await reload(found.id)).crmDisconnectCheckedAt).not.toBeNull()
    expect(await reload(gone.id)).toMatchObject({ crmWhoDeleted: true })
    expect(await reload(unknown.id)).toMatchObject({ crmWhoDeleted: true, crmDisconnectCheckedAt: null })
    // Same id on a different link type: a Lead '2' isn't the Contact '2'.
    expect(await reload(lead.id)).toMatchObject({ crmWhoDeleted: false })
  })

  it('moves links off a merged Company, including the Company stored on Deal-linked activities', async () => {
    await base()
    const direct = await activity({ crmWhatId: '20', crmWhatType: 'Account', crmAccountId: '20', crmWhatDeleted: true })
    const viaDeal = await activity({ crmWhatId: '500', crmWhatType: 'Opportunity', crmAccountId: '20', crmAccountName: 'Acme' })
    hubspot({ companies: { results: [{ id: '21', properties: { hs_merged_object_ids: '20' } }] } })

    expect(await lh.checkLinkedRecords('what', 'companies', ['20'])).toEqual({ checked: 1, gone: 0, merged: 1, moved: 1 })
    expect(await reload(direct.id)).toMatchObject({ crmWhatId: '21', crmAccountId: '21', crmWhatDeleted: false })
    expect(await reload(viaDeal.id)).toMatchObject({ crmWhatId: '500', crmAccountId: '21' })
    const audit = await testDb.select().from(schema.auditEvents)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'activity.crm_merge_relink', targetType: 'hubspot_record', targetId: '20', actorUserId: null })
    expect(audit[0]!.meta).toEqual({ crm: 'hubspot', objectType: 'companies', fromId: '20', toId: '21', activitiesUpdated: 1 })
  })

  it('carries a merged Deal\'s Closed Lost dismissal over unless the survivor has one', async () => {
    await base()
    const [otherTeam] = await testDb.insert(schema.teams).values({ name: 'O', slug: `o-${crypto.randomUUID()}` }).returning()
    await activity({ crmWhatId: '30', crmWhatType: 'Opportunity' })
    await testDb.insert(schema.oppReviewDismissals).values([
      { teamId, crmOppId: '30', crmOppName: 'Old deal', dismissedBy: userId },
      { teamId: otherTeam!.id, crmOppId: '30', crmOppName: 'Old deal', dismissedBy: userId },
      { teamId: otherTeam!.id, crmOppId: '31', crmOppName: 'New deal', dismissedBy: userId },
    ])
    hubspot({ deals: { results: [{ id: '31', properties: { hs_merged_object_ids: '30' } }] } })

    await lh.checkLinkedRecords('what', 'deals', ['30'])
    const rows = (await testDb.select().from(schema.oppReviewDismissals)).map((r) => [r.teamId === teamId ? 'team' : 'other', r.crmOppId]).sort()
    expect(rows).toEqual([['other', '31'], ['team', '31']])
  })

  it('moves a merged Project link, matched on the Project object type', async () => {
    await base()
    const proj = await activity({ crmRelatedId: '40', crmRelatedType: '0-970' })
    const other = await activity({ crmRelatedId: '40', crmRelatedType: '2-555' })
    hubspot({ '0-970': { results: [{ id: '41', properties: { hs_merged_object_ids: '40' } }] } })
    await lh.checkLinkedRecords('related', '0-970', ['40'])
    expect(await reload(proj.id)).toMatchObject({ crmRelatedId: '41', crmRelatedDeleted: false })
    expect(await reload(other.id)).toMatchObject({ crmRelatedId: '40' })
  })
})

describe('detectHubspotDisconnectedLinks', () => {
  it('checks every HubSpot link, skips Salesforce ids and Campaigns, and records a run', async () => {
    await base()
    const deal = await activity({ crmWhatId: '101', crmWhatType: 'Opportunity' })
    const merged = await activity({ crmWhatId: '102', crmWhatType: 'Opportunity' })
    const contact = await activity({ crmWhoId: '7', crmWhoType: 'Contact' })
    const sf = await activity({ crmWhatId: '006000000000001AAA', crmWhatType: 'Opportunity' })
    const campaign = await activity({ crmWhatId: '3f2a7c1e-0000-4000-8000-000000000000', crmWhatType: 'Campaign' })
    hubspot({
      deals: { results: [{ id: '103', properties: { hs_merged_object_ids: '102' } }], notFound: ['101'] },
      contacts: { results: [{ id: '7', properties: {} }] },
    })

    const result = await lh.detectHubspotDisconnectedLinks({ source: 'manual' })
    expect(result).toMatchObject({ scanned: 3, goneFound: 1, mergedFound: 1, activitiesMoved: 1, errors: [], source: 'manual' })
    expect(await reload(deal.id)).toMatchObject({ crmWhatDeleted: true })
    expect(await reload(merged.id)).toMatchObject({ crmWhatId: '103', crmWhatDeleted: false })
    expect(await reload(contact.id)).toMatchObject({ crmWhoDeleted: false })
    expect(await reload(sf.id)).toMatchObject({ crmWhatDeleted: false, crmDisconnectCheckedAt: null })
    expect(await reload(campaign.id)).toMatchObject({ crmDisconnectCheckedAt: null })
    const sent = request.mock.calls.flatMap(([, o]) => ((o?.body as { inputs?: Array<{ id: string }> })?.inputs ?? []).map((i) => i.id))
    expect(sent).not.toContain('006000000000001AAA')
    const runs = await testDb.select().from(schema.jobRuns)
    expect(runs.map((r) => [r.jobKey, r.status, r.message])).toEqual([['hubspot_detect_disconnected_links', 'ok', '1/3 links flagged disconnected, 1 merged (1 activities moved)']])
  })

  it('writes nothing for a failed batch and keeps checking the others', async () => {
    await base()
    const deal = await activity({ crmWhatId: '101', crmWhatType: 'Opportunity', crmWhatDeleted: true })
    const contact = await activity({ crmWhoId: '7', crmWhoType: 'Contact' })
    hubspot({ deals: 'fail', contacts: { notFound: ['7'] } })
    const result = await lh.detectHubspotDisconnectedLinks()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^what_deals_batch_0/)
    expect(await reload(deal.id)).toMatchObject({ crmWhatDeleted: true, crmDisconnectCheckedAt: null })
    expect(await reload(contact.id)).toMatchObject({ crmWhoDeleted: true })
    expect((await testDb.select().from(schema.jobRuns))[0]).toMatchObject({ status: 'error' })
  })

  it('stops at a rejected key', async () => {
    await base()
    await activity({ crmWhatId: '101', crmWhatType: 'Opportunity' })
    await activity({ crmWhoId: '7', crmWhoType: 'Contact' })
    hubspot({ deals: 'unauthorized', contacts: { results: [] } })
    const result = await lh.detectHubspotDisconnectedLinks()
    expect(result.errors).toEqual(['what_deals_batch_0: errors.hubspot.unauthorized'])
    expect(request.mock.calls.map(([p]) => p)).toEqual(['/crm/v3/objects/deals/batch/read'])
  })

  it('skips Leads when the access check found the portal has none', async () => {
    await base()
    await activity({ crmWhoId: '7', crmWhoType: 'Contact' })
    const lead = await activity({ crmWhoId: '8', crmWhoType: 'Lead' })
    leadsStatus = 'missing'
    hubspot({ contacts: { results: [{ id: '7', properties: {} }] } })
    expect(await lh.detectHubspotDisconnectedLinks()).toMatchObject({ scanned: 1, errors: [] })
    expect(request.mock.calls.map(([p]) => p)).toEqual(['/crm/v3/objects/contacts/batch/read'])
    expect(await reload(lead.id)).toMatchObject({ crmDisconnectCheckedAt: null })
  })

  it('reports not configured without calling HubSpot', async () => {
    configured = false
    const result = await lh.detectHubspotDisconnectedLinks()
    expect(result.errors).toEqual(['errors.hubspot.not_configured'])
    expect(request).not.toHaveBeenCalled()
  })
})
