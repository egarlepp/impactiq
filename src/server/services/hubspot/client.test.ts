import { describe, it, expect, vi, beforeEach } from 'vitest'

// The client's own logic, with the stored token and the network mocked.
const config = vi.fn()
vi.mock('./config.js', () => ({ getHubspotConfig: () => config() }))

import { HubspotError, buildHubspotUrl, hubspotJson, hubspotListAll, hubspotRequest } from './client.js'
import { generalLimiter } from './rateLimiter.js'

const fetchMock = vi.fn()

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  config.mockResolvedValue({ accessToken: 'pat-na2-saved-token', portalId: 1 })
  generalLimiter.setLimits({ max: 90, intervalMs: 10_000 })
})

describe('buildHubspotUrl', () => {
  it('only ever builds api.hubapi.com URLs', () => {
    expect(buildHubspotUrl('/crm/v3/owners', { limit: 1, after: undefined }).toString()).toBe('https://api.hubapi.com/crm/v3/owners?limit=1')
    expect(() => buildHubspotUrl('//evil.example.com/x')).toThrow()
    expect(() => buildHubspotUrl('https://evil.example.com/x')).toThrow()
  })
})

describe('hubspotRequest', () => {
  it('sends the saved token as a bearer token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await hubspotRequest('/crm/v3/owners')
    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-na2-saved-token' })
    expect((init as RequestInit).redirect).toBe('manual')
  })

  it('uses a token passed in instead of the saved one', async () => {
    config.mockResolvedValue(null)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await hubspotRequest('/crm/v3/owners', { token: 'pat-new' })
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-new' })
  })

  it('throws not_configured without a token', async () => {
    config.mockResolvedValue(null)
    await expect(hubspotRequest('/crm/v3/owners')).rejects.toMatchObject({ code: 'errors.hubspot.not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws unauthorized on a 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { category: 'INVALID_AUTHENTICATION' }))
    await expect(hubspotRequest('/crm/v3/owners')).rejects.toMatchObject({ code: 'errors.hubspot.unauthorized', status: 401 })
  })

  it('retries a per-second 429 after the suggested wait', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { policyName: 'TEN_SECONDLY_ROLLING' }, { 'x-hubspot-ratelimit-interval-milliseconds': '5' }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
    const res = await hubspotRequest('/crm/v3/owners')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up on the daily limit straight away', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { policyName: 'DAILY' }))
    await expect(hubspotRequest('/crm/v3/owners')).rejects.toMatchObject({ code: 'errors.hubspot.rate_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after three rate-limited attempts', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(429, {}, { 'x-hubspot-ratelimit-interval-milliseconds': '5' }))
    await expect(hubspotRequest('/crm/v3/owners')).rejects.toMatchObject({ code: 'errors.hubspot.rate_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports a network failure as unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(hubspotRequest('/crm/v3/owners')).rejects.toMatchObject({ code: 'errors.hubspot.unreachable' })
  })

  it("returns other statuses to the caller, with HubSpot's message left out of any error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { category: 'MISSING_SCOPES', message: 'raw text' }))
    const res = await hubspotRequest('/crm/v3/owners')
    expect(res.status).toBe(403)
  })
})

describe('hubspotJson', () => {
  it('maps 403 to forbidden and other failures to bad_response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}))
    await expect(hubspotJson('/crm/v3/owners')).rejects.toBeInstanceOf(HubspotError)
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}))
    await expect(hubspotJson('/crm/v3/owners')).rejects.toMatchObject({ code: 'errors.hubspot.forbidden' })
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}))
    await expect(hubspotJson('/crm/v3/owners')).rejects.toMatchObject({ code: 'errors.hubspot.bad_response', status: 500 })
  })
})

describe('hubspotListAll', () => {
  it('follows paging.next.after until the last page', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: '1' }], paging: { next: { after: 'abc' } } }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: '2' }] }))
    const all = await hubspotListAll<{ id: string }>('/crm/v3/owners', { limit: 100 })
    expect(all.map((o) => o.id)).toEqual(['1', '2'])
    expect(String(fetchMock.mock.calls[1]![0])).toContain('after=abc')
  })
})
