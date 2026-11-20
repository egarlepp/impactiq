import { describe, it, expect, vi, beforeEach } from 'vitest'

// Owner + Company lookup for the Sales Team Breakdown dashboard on HubSpot
// (phase 7b), with HubSpot's API and the owner names mocked.

const hubspotJson = vi.fn()
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return { ...actual, hubspotJson: (...args: unknown[]) => hubspotJson(...args) }
})
vi.mock('./metadata.js', async () => {
  const actual = await vi.importActual<typeof import('./metadata.js')>('./metadata.js')
  return {
    ...actual,
    ownerNames: async (ids: Iterable<string | null | undefined>) => new Map([...ids].filter((v): v is string => !!v).map((id) => [id, `Owner ${id}`])),
  }
})

import { HubspotError } from './client.js'
import { hubspotRecordOwners } from './recordOwners.js'

type Opts = { body?: { inputs?: Array<{ id: string }> } } | undefined

beforeEach(() => {
  hubspotJson.mockReset()
  hubspotJson.mockImplementation(async (path: string, opts: Opts) => {
    if (path === '/crm/v3/objects/deals/batch/read') {
      return { results: [
        { id: '900', properties: { dealname: 'Acme expansion', hubspot_owner_id: '77' } },
        { id: '901', properties: { dealname: 'No company' } },
      ] }
    }
    if (path === '/crm/v4/associations/deals/companies/batch/read') {
      return { results: [{ from: { id: '900' }, to: [{ toObjectId: 12, associationTypes: [{ label: 'Primary' }] }] }] }
    }
    if (path === '/crm/v3/objects/companies/batch/read') {
      const ids = (opts?.body?.inputs ?? []).map((i) => i.id)
      return { results: ids.map((id) => ({ id, properties: { name: `Company ${id}`, hubspot_owner_id: id === '13' ? '88' : '' } })) }
    }
    throw new Error(`unexpected ${path}`)
  })
})

describe('hubspotRecordOwners', () => {
  it('reads Deal owners with their primary Company, and Company owners', async () => {
    const { deals, companies } = await hubspotRecordOwners(['900', '901', '006AAAAAAAAAAAAAAA'], ['13'])
    expect([...deals.entries()]).toEqual([
      ['900', { ownerId: '77', ownerName: 'Owner 77', accountId: '12', accountName: 'Company 12', oppName: 'Acme expansion' }],
    ])
    expect(companies.get('13')).toEqual({ ownerId: '88', ownerName: 'Owner 88', accountId: '13', accountName: 'Company 13' })
    // The Salesforce-shaped id is never sent to HubSpot.
    const dealCall = hubspotJson.mock.calls.find(([p]) => p === '/crm/v3/objects/deals/batch/read') as [string, Opts]
    expect(dealCall[1]?.body?.inputs?.map((i) => i.id)).toEqual(['900', '901'])
  })

  it('makes no call with nothing to look up', async () => {
    expect(await hubspotRecordOwners(['006AAAAAAAAAAAAAAA'], [])).toEqual({ deals: new Map(), companies: new Map() })
    expect(hubspotJson).not.toHaveBeenCalled()
  })

  it('keeps Company owners when the Deal association read is refused, but stops on a rejected token', async () => {
    const base = hubspotJson.getMockImplementation()!
    hubspotJson.mockImplementation(async (path: string, opts: Opts) => {
      if (path === '/crm/v4/associations/deals/companies/batch/read') throw new HubspotError('errors.hubspot.forbidden', 403)
      return base(path, opts)
    })
    const out = await hubspotRecordOwners(['900'], ['13'])
    expect(out.deals.size).toBe(0)
    expect(out.companies.size).toBe(1)

    hubspotJson.mockImplementation(async (path: string, opts: Opts) => {
      if (path === '/crm/v4/associations/deals/companies/batch/read') throw new HubspotError('errors.hubspot.unauthorized', 401)
      return base(path, opts)
    })
    await expect(hubspotRecordOwners(['900'], [])).rejects.toMatchObject({ code: 'errors.hubspot.unauthorized' })
  })
})
