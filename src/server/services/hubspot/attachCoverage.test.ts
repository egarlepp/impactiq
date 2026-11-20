import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'

// Attach Rate coverage on HubSpot (phase 7b), against pglite with HubSpot's
// API mocked: Deals paged by id, owner/option/related-object values stored as
// names, stale rows dropped only after a clean scan, history written.

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let configured = true
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return { ...actual, getHubspotConfig: async () => (configured ? { accessToken: 'x', portalId: 1, uiDomain: null, lastCheck: null } : null) }
})

const hubspotJson = vi.fn()
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotJson: (...args: unknown[]) => hubspotJson(...args) }
})

vi.mock('./metadata.js', async () => {
  const actual = await vi.importActual<typeof import('./metadata.js')>('./metadata.js')
  const info = (name: string, extra: Partial<import('./metadata.js').PropertyInfo> = {}) => ({
    name, label: name, type: 'string', fieldType: 'text', readOnly: false, calculated: false, hubspotDefined: false,
    referencedObjectType: null, options: new Map<string, string>(), ...extra,
  })
  return {
    ...actual,
    getDealStagesSafe: async () => new Map([
      ['s1', { label: 'Discovery', pipelineId: 'p', pipelineLabel: 'Sales', isClosed: false, isWon: false }],
      ['won', { label: 'Closed Won', pipelineId: 'p', pipelineLabel: 'Sales', isClosed: true, isWon: true }],
    ]),
    getObjectPropertiesSafe: async (object: string) => {
      if (object === 'deals') {
        return new Map([
          ['assigned_se', info('assigned_se', { type: 'enumeration', fieldType: 'select', referencedObjectType: 'OWNER' })],
          ['se_team', info('se_team', { type: 'enumeration', fieldType: 'checkbox', options: new Map([['a', 'Alpha'], ['b', 'Bravo']]) })],
          ['hs_manual_forecast_category', info('hs_manual_forecast_category', { type: 'enumeration', options: new Map([['COMMIT', 'Commit']]) })],
        ])
      }
      if (object === '2-55') return new Map([['engineer', info('engineer')]])
      return new Map()
    },
  }
})

let schema: typeof import('../../../../drizzle/schema.js')
let orm: typeof import('drizzle-orm')
let testDb: TestDb
let mod: typeof import('./attachCoverage.js')

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  orm = await import('drizzle-orm')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  mod = await import('./attachCoverage.js')
})

let teamId = ''
beforeEach(async () => {
  configured = true
  hubspotJson.mockReset()
  await testDb.delete(schema.crmOpportunityCoverage)
  await testDb.delete(schema.attachRateHistory)
  await testDb.delete(schema.attachRateFields)
  await testDb.delete(schema.hubspotOwners)
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  teamId = team!.id
})

type Opts = { body?: { filterGroups?: Array<{ filters: Array<{ propertyName: string; value?: string }> }> } } | undefined

function deal(id: string, props: Record<string, string>) {
  return { id, properties: { dealname: `Deal ${id}`, dealstage: 's1', hs_is_closed: 'false', createdate: '2026-09-01T10:00:00Z', closedate: '2026-12-01T00:00:00Z', ...props } }
}

function lastIdOf(opts: Opts): string {
  return opts?.body?.filterGroups?.[0]?.filters.find((f) => f.propertyName === 'hs_object_id')?.value ?? ''
}

async function fields(rows: Array<{ crmObject: string; fieldApi: string }>) {
  await testDb.insert(schema.attachRateFields).values(rows.map((r) => ({ teamId, ...r })))
}

describe('refreshHubspotOppCoverage', () => {
  it('does nothing without a connection or configured HubSpot fields', async () => {
    expect(await mod.refreshHubspotOppCoverage()).toBeNull()
    await fields([{ crmObject: 'Opportunity', fieldApi: 'Assigned_SE__c' }])
    expect(await mod.refreshHubspotOppCoverage()).toBeNull()
    configured = false
    await fields([{ crmObject: 'deals', fieldApi: 'assigned_se' }])
    expect(await mod.refreshHubspotOppCoverage()).toBeNull()
    expect(hubspotJson).not.toHaveBeenCalled()
  })

  it('stores owners as ImpactIQ names, options as labels, and related Project values', async () => {
    const email = `${crypto.randomUUID()}@example.com`
    await testDb.insert(schema.users).values({ oktaId: `o-${crypto.randomUUID()}`, email, displayName: 'Sam Engineer' })
    await testDb.insert(schema.hubspotOwners).values([
      { id: '501', email: email.toUpperCase(), firstName: 'Samuel', lastName: 'E' },
      { id: '502', email: 'outside@example.com', firstName: 'Pat', lastName: 'Rep' },
    ])
    await fields([
      { crmObject: 'deals', fieldApi: 'assigned_se' },
      { crmObject: 'deals', fieldApi: 'se_team' },
      { crmObject: 'deals', fieldApi: 'not_a_property' },
      { crmObject: '2-55', fieldApi: 'engineer' },
    ])
    // A leftover row from before (e.g. another CRM) is dropped by a clean full scan.
    await testDb.insert(schema.crmOpportunityCoverage).values({ oppId: '006AAAAAAAAAAAAAAA', isClosed: false, snapshotAt: new Date('2026-01-01') })

    hubspotJson.mockImplementation(async (path: string, opts: Opts) => {
      if (path === '/crm/v3/objects/deals/search') {
        return lastIdOf(opts) === '0'
          ? { results: [
            deal('10', { assigned_se: '501', se_team: 'a;b', hubspot_owner_id: '502', amount: '1000', hs_manual_forecast_category: 'COMMIT' }),
            deal('11', { dealstage: 'won', hs_is_closed: '', assigned_se: '', amount: '50' }),
          ] }
          : { results: [] }
      }
      if (path === '/crm/v4/associations/deals/2-55/batch/read') return { results: [{ from: { id: '11' }, to: [{ toObjectId: 900 }] }] }
      if (path === '/crm/v3/objects/2-55/batch/read') return { results: [{ id: '900', properties: { engineer: 'Jordan Lee' } }] }
      throw new Error(`unexpected ${path}`)
    })

    const result = await mod.refreshHubspotOppCoverage()
    expect(result).toMatchObject({ oppsScanned: 2, oppsStored: 2 })
    expect(result!.errors).toEqual(['deals: unknown property not_a_property'])

    const rows = await testDb.select().from(schema.crmOpportunityCoverage).orderBy(schema.crmOpportunityCoverage.oppId)
    expect(rows.map((r) => r.oppId)).toEqual(['10', '11'])
    expect(rows[0]).toMatchObject({
      stageName: 'Discovery', forecastCategory: 'Commit', isClosed: false, ownerId: '502', ownerName: 'Pat Rep',
      amount: '1000.00', oppName: 'Deal 10', createdDate: '2026-09-01', closeDate: '2026-12-01',
      fieldValues: { 'deals::assigned_se': ['Sam Engineer'], 'deals::se_team': ['Alpha', 'Bravo'] },
    })
    // hs_is_closed empty: the stage's metadata says closed.
    expect(rows[1]).toMatchObject({ stageName: 'Closed Won', isClosed: true, fieldValues: { '2-55::engineer': ['Jordan Lee'] } })

    const [hist] = await testDb.select().from(schema.attachRateHistory).where(orm.eq(schema.attachRateHistory.teamId, teamId))
    expect(hist).toMatchObject({ total: 1, attached: 1 })
  })

  it('pages by record id past the first 100 deals', async () => {
    await fields([{ crmObject: 'deals', fieldApi: 'assigned_se' }])
    const firstPage = Array.from({ length: 100 }, (_, i) => deal(String(1000 + i), {}))
    const seen: string[] = []
    hubspotJson.mockImplementation(async (_path: string, opts: Opts) => {
      const last = lastIdOf(opts)
      seen.push(last)
      return { results: last === '0' ? firstPage : last === '1099' ? [deal('2000', {})] : [] }
    })
    const result = await mod.refreshHubspotOppCoverage()
    expect(seen).toEqual(['0', '1099'])
    expect(result).toMatchObject({ oppsScanned: 101, errors: [] })
  })

  it('keeps existing rows when the scan fails part-way', async () => {
    await fields([{ crmObject: 'deals', fieldApi: 'assigned_se' }])
    await testDb.insert(schema.crmOpportunityCoverage).values({ oppId: '77', isClosed: false, snapshotAt: new Date('2026-01-01') })
    const { HubspotError } = await import('./client.js')
    hubspotJson.mockRejectedValue(new HubspotError('errors.hubspot.rate_limited', 429))
    const result = await mod.refreshHubspotOppCoverage()
    expect(result!.errors[0]).toBe('query: errors.hubspot.rate_limited')
    expect(await testDb.select().from(schema.crmOpportunityCoverage)).toHaveLength(1)
  })
})

describe('hubspotPrimaryAttachKey', () => {
  it('uses the Deal property the team maps as Assigned SE', async () => {
    const [m] = await testDb.insert(schema.crmFieldMappings).values({ teamId, appField: 'assigned_se_write', crmFieldApi: 'assigned_se', crmObject: 'deals', direction: 'read_write' }).returning()
    await testDb.insert(schema.crmFieldMappingTeams).values({ crmFieldMappingId: m!.id, teamId })
    expect(await mod.hubspotPrimaryAttachKey([teamId], ['deals::se_team', 'deals::assigned_se'])).toBe('deals::assigned_se')
    expect(await mod.hubspotPrimaryAttachKey([teamId], ['deals::se_team'])).toBeNull()
  })
})
