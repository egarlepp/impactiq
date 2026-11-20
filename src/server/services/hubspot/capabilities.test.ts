import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HubspotRequestOptions, HubspotResponse } from './client.js'

// The probes themselves, with HubSpot's answers mocked per path.
const answers = new Map<string, number | Error>()
const calls: Array<{ path: string; opts: HubspotRequestOptions | undefined }> = []
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return {
    ...actual,
    hubspotRequest: async (path: string, opts?: HubspotRequestOptions): Promise<HubspotResponse> => {
      calls.push({ path, opts })
      const a = answers.get(path) ?? 200
      if (a instanceof Error) throw a
      return { status: a, body: a === 200 ? { portalId: 247756533, portalName: 'Test portal', accountType: 'DEVELOPER_TEST', uiDomain: 'app-na2.hubspot.com' } : {} }
    },
  }
})

import { HubspotError } from './client.js'
import { HUBSPOT_PROBES, checkHubspotCapabilities, classifyProbe, inspectHubspotToken } from './capabilities.js'
import { HUBSPOT_CAPABILITY_KEYS } from '../../../shared/hubspot.js'

beforeEach(() => {
  answers.clear()
  calls.length = 0
})

describe('classifyProbe', () => {
  it('reads: 2xx ok, 403 missing, anything else unknown', () => {
    expect(classifyProbe('GET', 200)).toBe('ok')
    expect(classifyProbe('GET', 403)).toBe('missing')
    expect(classifyProbe('GET', 404)).toBe('unknown')
    expect(classifyProbe('GET', 500)).toBe('unknown')
  })
  it('writes against a record that cannot exist: 404/400 mean allowed', () => {
    expect(classifyProbe('PATCH', 404)).toBe('ok')
    expect(classifyProbe('PATCH', 400)).toBe('ok')
    expect(classifyProbe('PATCH', 403)).toBe('missing')
    expect(classifyProbe('PATCH', 502)).toBe('unknown')
  })
})

describe('checkHubspotCapabilities', () => {
  it('probes every capability once, in order', async () => {
    expect(HUBSPOT_PROBES.map((p) => p.key)).toEqual([...HUBSPOT_CAPABILITY_KEYS])
    await checkHubspotCapabilities({ token: 't' })
    expect(calls).toHaveLength(HUBSPOT_PROBES.length)
  })

  it('never writes real data: write probes only PATCH id 0 (or the nil UUID) with no properties', async () => {
    await checkHubspotCapabilities({ token: 't' })
    for (const c of calls.filter((c) => c.opts?.method === 'PATCH')) {
      expect(c.path).toMatch(/\/(0|00000000-0000-0000-0000-000000000000)$/)
      expect(c.opts?.body).toEqual({ properties: {} })
    }
  })

  it('is ready when every required capability is ok, whatever the optional ones say', async () => {
    answers.set('/crm/v3/objects/meetings/0', 404)
    answers.set('/crm/v3/objects/deals/0', 403)
    answers.set('/crm/v3/objects/leads', 403)
    answers.set('/marketing/v3/campaigns', new HubspotError('errors.hubspot.unreachable'))
    const report = await checkHubspotCapabilities({ token: 't', portalId: 5 })
    expect(report.ready).toBe(true)
    expect(report.portalId).toBe(5)
    const by = Object.fromEntries(report.capabilities.map((c) => [c.key, c.status]))
    expect(by).toMatchObject({ meetings_write: 'ok', deals_write: 'missing', leads_read: 'missing', campaigns_read: 'unknown' })
  })

  it('is not ready when a required capability is missing', async () => {
    answers.set('/crm/v3/owners', 403)
    const report = await checkHubspotCapabilities({ token: 't' })
    expect(report.ready).toBe(false)
    expect(report.capabilities.find((c) => c.key === 'owners_read')).toMatchObject({ status: 'missing', scope: 'crm.objects.owners.read', required: true })
  })

  it('stops on a rejected token', async () => {
    answers.set('/crm/v3/objects/deals', new HubspotError('errors.hubspot.unauthorized', 401))
    await expect(checkHubspotCapabilities({ token: 't' })).rejects.toMatchObject({ code: 'errors.hubspot.unauthorized' })
    expect(calls).toHaveLength(1)
  })
})

describe('inspectHubspotToken', () => {
  it('names the portal from account-info', async () => {
    expect(await inspectHubspotToken('t')).toEqual({ portalId: 247756533, portalName: 'Test portal', accountType: 'DEVELOPER_TEST', uiDomain: 'app-na2.hubspot.com' })
  })

  it('falls back to the owners list when account-info is off limits', async () => {
    answers.set('/account-info/v3/details', 403)
    expect(await inspectHubspotToken('t')).toEqual({ portalId: null, portalName: null, accountType: null, uiDomain: null })
    expect(calls.map((c) => c.path)).toEqual(['/account-info/v3/details', '/crm/v3/owners'])
  })

  it('rejects a token HubSpot refuses', async () => {
    answers.set('/account-info/v3/details', new HubspotError('errors.hubspot.unauthorized', 401))
    await expect(inspectHubspotToken('t')).rejects.toMatchObject({ code: 'errors.hubspot.unauthorized' })
  })
})
