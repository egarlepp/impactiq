// getCrmTimezoneForUser (v1.469.0): the timezone My Settings offers as the
// CRM's. Salesforce reads the user's own User.TimeZoneSidKey, HubSpot the
// portal's account timezone, and no CRM reports nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest'

let provider = 'salesforce'
vi.mock('./providerSetting.js', () => ({ getCrmProviderId: async () => provider }))

let sfConn: { identity: () => Promise<{ user_id: string }>; query: (q: string) => Promise<{ records: unknown[] }> } | null = null
vi.mock('../salesforce/client.js', () => ({ getSfConnection: async () => sfConn }))

let hsConfigured = true
vi.mock('../hubspot/config.js', () => ({ getHubspotConfig: async () => (hsConfigured ? { portalId: 7 } : null) }))

const hsRequest = vi.fn()
vi.mock('../hubspot/client.js', () => ({ hubspotRequest: (...args: unknown[]) => hsRequest(...args) }))

const { getCrmTimezoneForUser, clearHubspotTimezoneCache } = await import('./timezone.js')

beforeEach(() => {
  provider = 'salesforce'
  sfConn = null
  hsConfigured = true
  hsRequest.mockReset()
  clearHubspotTimezoneCache()
})

describe('getCrmTimezoneForUser', () => {
  it('reports nothing when the install has no CRM', async () => {
    provider = 'none'
    expect(await getCrmTimezoneForUser('u1')).toEqual({ provider: 'none', connected: false, timezone: null })
  })

  it('reads the Salesforce user timezone', async () => {
    const queries: string[] = []
    sfConn = {
      identity: async () => ({ user_id: '005ABC' }),
      query: async (q) => { queries.push(q); return { records: [{ TimeZoneSidKey: 'America/New_York' }] } },
    }
    expect(await getCrmTimezoneForUser('u1')).toEqual({ provider: 'salesforce', connected: true, timezone: 'America/New_York' })
    expect(queries[0]).toContain("Id = '005ABC'")
  })

  it('reports Salesforce as not connected without the user\'s connection', async () => {
    expect(await getCrmTimezoneForUser('u1')).toEqual({ provider: 'salesforce', connected: false, timezone: null })
  })

  it('reads the HubSpot portal timezone once per hour', async () => {
    provider = 'hubspot'
    hsRequest.mockResolvedValue({ status: 200, body: { portalId: 7, timeZone: 'US/Eastern' } })
    expect(await getCrmTimezoneForUser('u1')).toEqual({ provider: 'hubspot', connected: true, timezone: 'US/Eastern' })
    expect(await getCrmTimezoneForUser('u2')).toEqual({ provider: 'hubspot', connected: true, timezone: 'US/Eastern' })
    expect(hsRequest).toHaveBeenCalledTimes(1)
    expect(hsRequest).toHaveBeenCalledWith('/account-info/v3/details')
  })

  it('answers no HubSpot timezone when account-info is off limits', async () => {
    provider = 'hubspot'
    hsRequest.mockResolvedValue({ status: 403, body: {} })
    expect(await getCrmTimezoneForUser('u1')).toEqual({ provider: 'hubspot', connected: true, timezone: null })
  })

  it('reports HubSpot as not connected without a saved connection', async () => {
    provider = 'hubspot'
    hsConfigured = false
    expect(await getCrmTimezoneForUser('u1')).toEqual({ provider: 'hubspot', connected: false, timezone: null })
    expect(hsRequest).not.toHaveBeenCalled()
  })
})
