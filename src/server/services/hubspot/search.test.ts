import { describe, it, expect, vi, beforeEach } from 'vitest'

// Deal / Company / Contact / Lead / Campaign search, with HubSpot's API and
// the portal metadata mocked. Leads and Campaigns can't be checked live on
// the developer portal, so these tests pin the request shapes taken from
// HubSpot's documentation.

const hubspotJson = vi.fn()
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotJson: (...args: unknown[]) => hubspotJson(...args) }
})

const mappings = vi.fn(async () => [] as Array<Record<string, unknown>>)
vi.mock('./mappings.js', async () => {
  const actual = await vi.importActual<typeof import('./mappings.js')>('./mappings.js')
  return { ...actual, loadHubspotMappings: () => mappings() }
})

vi.mock('./metadata.js', async () => {
  const actual = await vi.importActual<typeof import('./metadata.js')>('./metadata.js')
  const enumProp = (name: string, options: Record<string, string>, fieldType = 'select') => ({ name, label: name, type: 'enumeration', fieldType, readOnly: false, calculated: false, hubspotDefined: false, referencedObjectType: null, options: new Map(Object.entries(options)) })
  return {
    ...actual,
    getDealStagesSafe: async () => new Map([['appointmentscheduled', { label: 'Appointment Scheduled', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: false, isWon: false }]]),
    getObjectPropertiesSafe: async (type: string) => {
      if (type === 'deals') {
        return new Map([
          ['hs_manual_forecast_category', enumProp('hs_manual_forecast_category', { COMMIT: 'Commit' })],
          ['se_team', enumProp('se_team', {}, 'checkbox')],
        ])
      }
      if (type === 'leads') return new Map([['hs_pipeline_stage', enumProp('hs_pipeline_stage', { 'new-stage-id': 'New' })]])
      return new Map()
    },
    ownerNames: async (ids: Iterable<string | null | undefined>) => new Map([...ids].filter((v): v is string => !!v).map((id) => [id, `Owner ${id}`])),
  }
})

import { HubspotError } from './client.js'
import {
  buildDealFilterGroups, primaryAssociations, searchHubspotCampaigns, searchHubspotCompanies,
  searchHubspotContacts, searchHubspotDeals, searchHubspotLeads,
} from './search.js'

type Call = [string, { method?: string; body?: Record<string, unknown>; query?: Record<string, unknown> } | undefined]

function callsTo(path: string): Call[] {
  return (hubspotJson.mock.calls as Call[]).filter(([p]) => p === path)
}

function firstCallTo(path: string): Call {
  const call = callsTo(path)[0]
  if (!call) throw new Error(`no call to ${path}`)
  return call
}

// Answers by path; a function value is called with the request options.
function routes(table: Record<string, unknown>) {
  hubspotJson.mockImplementation(async (path: string, opts?: unknown) => {
    if (!(path in table)) throw new Error(`unexpected HubSpot call: ${path}`)
    const v = table[path]
    if (v instanceof Error) throw v
    return typeof v === 'function' ? (v as (o: unknown) => unknown)(opts) : v
  })
}

const DEAL = {
  id: '356553095874',
  properties: { dealname: 'Acme renewal', dealstage: 'appointmentscheduled', amount: '125000.5', closedate: '2026-12-31T17:00:00.000Z', hubspot_owner_id: '77', hs_manual_forecast_category: 'COMMIT' },
}

beforeEach(() => {
  hubspotJson.mockReset()
  mappings.mockReset()
  mappings.mockResolvedValue([])
})

describe('buildDealFilterGroups', () => {
  it('ORs the owner with each mapped SE property and keeps closed deals out', () => {
    const props = new Map([['se_team', { name: 'se_team', label: 'se_team', type: 'enumeration', fieldType: 'checkbox', readOnly: false, calculated: false, hubspotDefined: false, referencedObjectType: null, options: new Map() }]])
    const groups = buildDealFilterGroups('77', ['assigned_se', 'se_team'], props, false)
    expect(groups).toEqual([
      { filters: [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: '77' }, { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] },
      { filters: [{ propertyName: 'assigned_se', operator: 'EQ', value: '77' }, { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] },
      // A multi-owner checkbox property matches the id as one token among several.
      { filters: [{ propertyName: 'se_team', operator: 'CONTAINS_TOKEN', value: '77' }, { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] },
    ])
  })

  it('caps at HubSpot\'s five filter groups and drops the closed filter on Show Closed', () => {
    const groups = buildDealFilterGroups('1', ['a', 'b', 'c', 'd', 'e', 'hubspot_owner_id'], new Map(), true)
    expect(groups).toHaveLength(5)
    expect(groups.map((g) => g.filters[0]!.propertyName)).toEqual(['hubspot_owner_id', 'a', 'b', 'c', 'd'])
    expect(groups.every((g) => g.filters.length === 1)).toBe(true)
  })
})

describe('searchHubspotDeals', () => {
  const dealRoutes = {
    '/crm/v3/objects/deals/search': { results: [DEAL] },
    '/crm/v4/associations/deals/companies/batch/read': {
      results: [{ from: { id: DEAL.id }, to: [
        { toObjectId: 11, associationTypes: [{ label: null }] },
        { toObjectId: 12, associationTypes: [{ label: 'Primary' }] },
      ] }],
    },
    '/crm/v3/objects/companies/batch/read': { results: [{ id: '12', properties: { name: 'Acme Corp' } }] },
  }

  it('returns nothing for "my deals" when the user matches no HubSpot owner', async () => {
    expect(await searchHubspotDeals('acme', { openSearch: false, showClosed: false, ownerId: null, teamId: 't1' })).toEqual([])
    expect(hubspotJson).not.toHaveBeenCalled()
  })

  it('searches the user\'s deals and maps them to Opportunity rows', async () => {
    mappings.mockResolvedValue([{ appField: 'deal_se_owner', property: 'assigned_se', crmObject: 'deals', direction: 'read', isActive: true, constantValue: null, refreshOnlyForReports: false }])
    routes(dealRoutes)
    const rows = await searchHubspotDeals('acme', { openSearch: false, showClosed: false, ownerId: '77', teamId: 't1' })

    const [, req] = firstCallTo('/crm/v3/objects/deals/search')
    expect(req?.method).toBe('POST')
    expect(req?.body?.['query']).toBe('acme')
    expect((req?.body?.['filterGroups'] as unknown[]).length).toBe(2)
    expect(req?.body?.['sorts']).toEqual([{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }])

    expect(rows).toEqual([{
      Id: '356553095874',
      Name: 'Acme renewal',
      StageName: 'Appointment Scheduled',
      AccountId: '12',
      AccountName: 'Acme Corp',
      CloseDate: '2026-12-31',
      Amount: 125000.5,
      ForecastCategoryName: 'Commit',
      OwnerName: 'Owner 77',
    }])
  })

  it('Open Search drops the owner filter and keeps only the open-deal filter', async () => {
    routes({ ...dealRoutes, '/crm/v3/objects/deals/search': { results: [] } })
    await searchHubspotDeals('acme', { openSearch: true, showClosed: false, ownerId: null, teamId: null })
    const [, req] = firstCallTo('/crm/v3/objects/deals/search')
    expect(req?.body?.['filterGroups']).toEqual([{ filters: [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] }])
  })

  it('Open Search with Show Closed sends no filters at all', async () => {
    routes({ '/crm/v3/objects/deals/search': { results: [] } })
    await searchHubspotDeals('acme', { openSearch: true, showClosed: true, ownerId: null, teamId: null })
    const [, req] = firstCallTo('/crm/v3/objects/deals/search')
    expect(req?.body).not.toHaveProperty('filterGroups')
  })

  it('leaves the Account blank when associations can\'t be read', async () => {
    routes({ ...dealRoutes, '/crm/v4/associations/deals/companies/batch/read': new HubspotError('errors.hubspot.forbidden', 403) })
    const rows = await searchHubspotDeals('acme', { openSearch: true, showClosed: true, ownerId: null, teamId: null })
    expect(rows[0]).toMatchObject({ Name: 'Acme renewal', AccountId: null, AccountName: '' })
  })

  it('still fails the search on a rejected token', async () => {
    routes({ ...dealRoutes, '/crm/v4/associations/deals/companies/batch/read': new HubspotError('errors.hubspot.unauthorized', 401) })
    await expect(searchHubspotDeals('acme', { openSearch: true, showClosed: true, ownerId: null, teamId: null })).rejects.toMatchObject({ code: 'errors.hubspot.unauthorized' })
  })
})

describe('primaryAssociations', () => {
  it('falls back to the first associated record when none is labelled Primary', async () => {
    routes({ '/crm/v4/associations/leads/contacts/batch/read': { results: [{ from: { id: '5' }, to: [{ toObjectId: 9, associationTypes: [] }, { toObjectId: 10 }] }] } })
    expect(await primaryAssociations('leads', 'contacts', ['5'])).toEqual(new Map([['5', '9']]))
  })

  it('makes no call for an empty id list', async () => {
    expect(await primaryAssociations('deals', 'companies', [])).toEqual(new Map())
    expect(hubspotJson).not.toHaveBeenCalled()
  })
})

describe('searchHubspotCompanies / searchHubspotContacts', () => {
  it('maps companies to Account rows', async () => {
    routes({ '/crm/v3/objects/companies/search': { results: [{ id: '12', properties: { name: 'Acme Corp', industry: 'COMPUTER_SOFTWARE', hubspot_owner_id: '77' } }] } })
    expect(await searchHubspotCompanies('acme')).toEqual([{ Id: '12', Name: 'Acme Corp', Industry: 'COMPUTER_SOFTWARE', OwnerName: 'Owner 77' }])
  })

  it('maps contacts to Contact rows, naming a contact by email when it has no name', async () => {
    routes({ '/crm/v3/objects/contacts/search': { results: [
      { id: '1', properties: { firstname: 'Ana', lastname: 'Silva', email: 'ana@acme.example', jobtitle: 'CTO', company: 'Acme' } },
      { id: '2', properties: { email: 'nobody@acme.example' } },
    ] } })
    expect(await searchHubspotContacts('a')).toEqual([
      { Id: '1', Name: 'Ana Silva', Email: 'ana@acme.example', AccountName: 'Acme', Title: 'CTO' },
      { Id: '2', Name: 'nobody@acme.example', Email: 'nobody@acme.example', AccountName: null, Title: null },
    ])
  })
})

describe('searchHubspotLeads', () => {
  it('fills Email and Company from the lead\'s primary contact and company', async () => {
    routes({
      '/crm/v3/objects/leads/search': { results: [{ id: '40', properties: { hs_lead_name: 'Acme inbound', hs_pipeline_stage: 'new-stage-id' } }] },
      '/crm/v4/associations/leads/contacts/batch/read': { results: [{ from: { id: '40' }, to: [{ toObjectId: 1, associationTypes: [{ label: 'Primary' }] }] }] },
      '/crm/v3/objects/contacts/batch/read': { results: [{ id: '1', properties: { firstname: 'Ana', lastname: 'Silva', email: 'ana@acme.example' } }] },
      '/crm/v4/associations/leads/companies/batch/read': { results: [{ from: { id: '40' }, to: [{ toObjectId: 12 }] }] },
      '/crm/v3/objects/companies/batch/read': { results: [{ id: '12', properties: { name: 'Acme Corp' } }] },
    })
    expect(await searchHubspotLeads('acme')).toEqual([{ Id: '40', Name: 'Acme inbound', Email: 'ana@acme.example', Company: 'Acme Corp', Status: 'New' }])
  })
})

describe('searchHubspotCampaigns', () => {
  it('filters campaigns by name and marks ended ones inactive', async () => {
    routes({ '/marketing/v3/campaigns': { results: [
      { id: 'c-1', properties: { hs_name: 'Spring launch', hs_start_date: '2020-01-01', hs_end_date: '2020-02-01', hs_campaign_status: 'completed' } },
      { id: 'c-2', properties: { hs_name: 'Always on' } },
    ] } })
    const rows = await searchHubspotCampaigns('spring')
    const [, req] = firstCallTo('/marketing/v3/campaigns')
    expect(req?.query).toMatchObject({ name: 'spring' })
    expect(rows.map((r) => [r.Id, r.Name, r.IsActive])).toEqual([['c-1', 'Spring launch', false], ['c-2', 'Always on', true]])
  })

  it('needs at least two characters', async () => {
    expect(await searchHubspotCampaigns('s')).toEqual([])
    expect(hubspotJson).not.toHaveBeenCalled()
  })
})
