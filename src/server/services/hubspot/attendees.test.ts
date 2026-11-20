import { describe, it, expect, vi, beforeEach } from 'vitest'

// Attendee matching on HubSpot (phase 7b), with HubSpot's API and the portal
// metadata mocked. Pins the request shapes (lowercased IN filter, contact →
// company / deal associations) and the Salesforce-compatible result shapes.

const hubspotJson = vi.fn()
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotJson: (...args: unknown[]) => hubspotJson(...args) }
})

vi.mock('./mappings.js', async () => {
  const actual = await vi.importActual<typeof import('./mappings.js')>('./mappings.js')
  return { ...actual, loadHubspotMappings: async () => [] }
})

vi.mock('./metadata.js', async () => {
  const actual = await vi.importActual<typeof import('./metadata.js')>('./metadata.js')
  return {
    ...actual,
    getDealStagesSafe: async () => new Map([
      ['open1', { label: 'Discovery', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: false, isWon: false }],
      ['closedwon', { label: 'Closed Won', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: true, isWon: true }],
    ]),
    getObjectPropertiesSafe: async () => new Map(),
    ownerNames: async (ids: Iterable<string | null | undefined>) => new Map([...ids].filter((v): v is string => !!v).map((id) => [id, `Owner ${id}`])),
  }
})

import { HubspotError } from './client.js'
import { findHubspotSuggestionsForEmails, listHubspotContactsOnRecord } from './attendees.js'

type Opts = { method?: string; body?: Record<string, unknown> } | undefined

function routes(table: Record<string, unknown>) {
  hubspotJson.mockImplementation(async (path: string, opts?: Opts) => {
    if (!(path in table)) throw new Error(`unexpected HubSpot call: ${path}`)
    const v = table[path]
    if (v instanceof Error) throw v
    return typeof v === 'function' ? (v as (o: Opts) => unknown)(opts) : v
  })
}

function bodyOf(path: string): Record<string, unknown> {
  const call = (hubspotJson.mock.calls as Array<[string, Opts]>).find(([p]) => p === path)
  if (!call?.[1]?.body) throw new Error(`no call to ${path}`)
  return call[1].body
}

const CONTACT = { id: '501', properties: { email: 'Jane@Acme.com', firstname: 'Jane', lastname: 'Doe' } }

const baseRoutes = {
  '/crm/v3/objects/contacts/search': { results: [CONTACT] },
  '/crm/v4/associations/contacts/companies/batch/read': { results: [{ from: { id: '501' }, to: [{ toObjectId: 12, associationTypes: [{ label: 'Primary' }] }] }] },
  '/crm/v3/objects/companies/batch/read': { results: [{ id: '12', properties: { name: 'Acme Corp', hubspot_owner_id: '77' } }] },
  '/crm/v4/associations/contacts/deals/batch/read': { results: [{ from: { id: '501' }, to: [{ toObjectId: 900 }, { toObjectId: 901 }, { toObjectId: 902 }] }] },
  '/crm/v3/objects/deals/batch/read': { results: [
    { id: '900', properties: { dealname: 'Acme expansion', dealstage: 'open1', hs_is_closed: 'false', amount: '50000', closedate: '2026-12-01T00:00:00.000Z', hubspot_owner_id: '77' } },
    { id: '901', properties: { dealname: 'Acme lost', dealstage: 'open1', hs_is_closed: 'true' } },
    // No hs_is_closed: falls back to the stage's metadata (closed).
    { id: '902', properties: { dealname: 'Acme won', dealstage: 'closedwon' } },
  ] },
  '/crm/v4/associations/deals/companies/batch/read': { results: [{ from: { id: '900' }, to: [{ toObjectId: 12, associationTypes: [{ label: 'Primary' }] }] }] },
}

beforeEach(() => {
  hubspotJson.mockReset()
})

describe('findHubspotSuggestionsForEmails', () => {
  it('makes no call when there are no usable emails', async () => {
    expect(await findHubspotSuggestionsForEmails(['', 'not-an-email'])).toEqual({ accounts: [], opportunities: [] })
    expect(hubspotJson).not.toHaveBeenCalled()
  })

  it('lowercases and dedupes the emails before the exact IN filter', async () => {
    routes({ '/crm/v3/objects/contacts/search': { results: [] } })
    await findHubspotSuggestionsForEmails(['Jane@Acme.com ', 'jane@acme.com', 'BOB@acme.com'])
    const body = bodyOf('/crm/v3/objects/contacts/search') as { filterGroups: Array<{ filters: Array<{ operator: string; values: string[] }> }> }
    expect(body.filterGroups[0]!.filters[0]).toMatchObject({ operator: 'IN', values: ['jane@acme.com', 'bob@acme.com'] })
  })

  it('suggests the primary Company and the open Deals, in the Salesforce shapes', async () => {
    routes(baseRoutes)
    const out = await findHubspotSuggestionsForEmails(['jane@acme.com'])
    expect(out.accounts).toEqual([{ Id: '12', Name: 'Acme Corp', OwnerName: 'Owner 77', contactName: 'Jane Doe', contactEmail: 'jane@acme.com' }])
    expect(out.opportunities).toHaveLength(1)
    expect(out.opportunities[0]).toMatchObject({ Id: '900', Name: 'Acme expansion', AccountId: '12', AccountName: 'Acme Corp', StageName: 'Discovery', Amount: 50000, contactName: 'Jane Doe', contactEmail: 'jane@acme.com' })
  })

  it('keeps the Company suggestions when the Deal lookup fails', async () => {
    routes({ ...baseRoutes, '/crm/v4/associations/contacts/deals/batch/read': new HubspotError('errors.hubspot.forbidden', 403) })
    const out = await findHubspotSuggestionsForEmails(['jane@acme.com'])
    expect(out.accounts).toHaveLength(1)
    expect(out.opportunities).toEqual([])
  })

  it('still fails on a rejected token', async () => {
    routes({ ...baseRoutes, '/crm/v4/associations/contacts/companies/batch/read': new HubspotError('errors.hubspot.unauthorized', 401) })
    await expect(findHubspotSuggestionsForEmails(['jane@acme.com'])).rejects.toMatchObject({ code: 'errors.hubspot.unauthorized' })
  })
})

describe('listHubspotContactsOnRecord', () => {
  const contactRoutes = {
    '/crm/v3/objects/contacts/search': { results: [{ id: '501', properties: { firstname: 'Jane', lastname: 'Doe', email: 'jane@acme.com', jobtitle: 'CTO' } }] },
    '/crm/v3/objects/companies/batch/read': { results: [{ id: '12', properties: { name: 'Acme Corp' } }] },
  }

  it('searches a Company\'s contacts by associatedcompanyid', async () => {
    routes(contactRoutes)
    const rows = await listHubspotContactsOnRecord('12', 'account', ' jane ')
    expect(rows).toEqual([{ Id: '501', Name: 'Jane Doe', Email: 'jane@acme.com', Title: 'CTO', AccountName: 'Acme Corp' }])
    const body = bodyOf('/crm/v3/objects/contacts/search') as { query?: string; filterGroups: Array<{ filters: Array<Record<string, unknown>> }> }
    expect(body.query).toBe('jane')
    expect(body.filterGroups[0]!.filters[0]).toEqual({ propertyName: 'associatedcompanyid', operator: 'EQ', value: '12' })
  })

  it('goes through a Deal\'s primary Company', async () => {
    routes({ ...contactRoutes, '/crm/v4/associations/deals/companies/batch/read': { results: [{ from: { id: '900' }, to: [{ toObjectId: 12, associationTypes: [{ label: 'Primary' }] }] }] } })
    const rows = await listHubspotContactsOnRecord('900', 'opportunity', '')
    expect(rows).toHaveLength(1)
    const body = bodyOf('/crm/v3/objects/contacts/search') as { query?: string }
    expect(body.query).toBeUndefined()
  })

  it('returns nothing for a Deal with no Company', async () => {
    routes({ '/crm/v4/associations/deals/companies/batch/read': { results: [] } })
    expect(await listHubspotContactsOnRecord('900', 'opportunity', '')).toEqual([])
  })
})
