import { describe, it, expect, vi, beforeEach } from 'vitest'

// The client's own logic, with the saved connection and the network mocked.
const config = vi.fn()
const saveTokens = vi.fn()
const refresh = vi.fn()
vi.mock('./config.js', () => ({
  getGongConfig: () => config(),
  saveGongOAuthTokens: (...a: unknown[]) => saveTokens(...a),
}))
vi.mock('./oauth.js', () => ({ refreshGongAccessToken: (...a: unknown[]) => refresh(...a) }))
vi.mock('../health/integrationStatus.js', () => ({ recordIntegrationCall: vi.fn() }))

import { GongError, gongAuthHeader, gongLimiter, gongListAll, gongRequest, nextCursor } from './client.js'

const fetchMock = vi.fn()

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const accessKeyConfig = {
  authMethod: 'access_key',
  apiBaseUrl: 'https://us-1.api.gong.io',
  credentials: { method: 'access_key', accessKey: 'KEY', accessKeySecret: 'SECRET' },
  workspaceIds: [],
  transcriptCacheDays: 30,
  lastCheck: null,
}

function oauthConfig(accessToken: string, expiresAt: number | null = null) {
  return {
    ...accessKeyConfig,
    authMethod: 'oauth',
    credentials: { method: 'oauth', accessToken, refreshToken: 'R1', expiresAt, clientId: 'cid', clientSecret: 'csec' },
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  config.mockReset()
  saveTokens.mockReset()
  refresh.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  config.mockResolvedValue(accessKeyConfig)
  gongLimiter.setLimits({ max: 1000, intervalMs: 1000 })
})

describe('gongAuthHeader', () => {
  it('sends an access key pair as HTTP Basic and an OAuth token as Bearer', () => {
    expect(gongAuthHeader({ method: 'access_key', accessKey: 'a', accessKeySecret: 'b' })).toBe(`Basic ${Buffer.from('a:b').toString('base64')}`)
    expect(gongAuthHeader({ method: 'oauth', accessToken: 'tok', refreshToken: null, expiresAt: null, clientId: 'c', clientSecret: 's' })).toBe('Bearer tok')
  })
})

describe('gongRequest', () => {
  it('calls the tenant host with the saved key and never follows redirects', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { users: [] }))
    const res = await gongRequest('/v2/users', { query: { cursor: undefined } })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://us-1.api.gong.io/v2/users')
    expect((init as RequestInit).redirect).toBe('manual')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Basic ${Buffer.from('KEY:SECRET').toString('base64')}` })
    expect(res).toEqual({ status: 200, body: { users: [] } })
  })

  it('throws not_configured without a connection', async () => {
    config.mockResolvedValue(null)
    await expect(gongRequest('/v2/users')).rejects.toMatchObject({ code: 'errors.gong.not_configured' })
  })

  it('maps 401, 403 and 5xx to i18n error keys', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}))
    await expect(gongRequest('/v2/users')).rejects.toMatchObject({ code: 'errors.gong.unauthorized' })
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}))
    await expect(gongRequest('/v2/users')).rejects.toMatchObject({ code: 'errors.gong.forbidden' })
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}))
    await expect(gongRequest('/v2/users')).rejects.toMatchObject({ code: 'errors.gong.unreachable' })
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(gongRequest('/v2/users')).rejects.toBeInstanceOf(GongError)
  })

  it('answers an allowed status instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { errors: ['nope'] }))
    const res = await gongRequest('/v2/workspaces', { allowStatuses: [403] })
    expect(res.status).toBe(403)
  })

  it('waits out a 429 and retries', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await expect(gongRequest('/v2/users')).resolves.toEqual({ status: 200, body: { ok: true } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes a refused OAuth token once and retries with the new one', async () => {
    config.mockResolvedValueOnce(oauthConfig('OLD')).mockResolvedValueOnce(oauthConfig('NEW'))
    refresh.mockResolvedValueOnce({ accessToken: 'NEW', refreshToken: null, expiresInSeconds: 3600, apiBaseUrl: null })
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {})).mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await gongRequest('/v2/users')
    expect(refresh).toHaveBeenCalledWith({ refreshToken: 'R1', clientId: 'cid', clientSecret: 'csec' })
    expect(saveTokens).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer NEW' })
  })

  it('refreshes an OAuth token that is about to expire before calling', async () => {
    config.mockResolvedValueOnce(oauthConfig('OLD', Date.now() + 30_000)).mockResolvedValueOnce(oauthConfig('NEW'))
    refresh.mockResolvedValueOnce({ accessToken: 'NEW', refreshToken: 'R2', expiresInSeconds: 3600, apiBaseUrl: null })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await gongRequest('/v2/users')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer NEW' })
  })
})

describe('gongListAll', () => {
  it('follows records.cursor until Gong stops sending one', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { users: [1, 2], records: { cursor: 'c1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { users: [3], records: {} }))
    const out = await gongListAll('/v2/users', (b) => (b as { users: number[] }).users)
    expect(out).toEqual([1, 2, 3])
    expect(String(fetchMock.mock.calls[1]![0])).toContain('cursor=c1')
  })

  it('puts the cursor in the body for POST listings and stops at maxPages', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { calls: [1], records: { cursor: 'again' } }))
    const out = await gongListAll('/v2/calls/extensive', (b) => (b as { calls: number[] }).calls, { method: 'POST', body: { filter: {} }, maxPages: 2 })
    expect(out).toEqual([1, 1])
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ filter: {}, cursor: 'again' })
  })
})

describe('nextCursor', () => {
  it('reads a non-empty records.cursor only', () => {
    expect(nextCursor({ records: { cursor: 'x' } })).toBe('x')
    expect(nextCursor({ records: { cursor: '' } })).toBeUndefined()
    expect(nextCursor({})).toBeUndefined()
    expect(nextCursor(null)).toBeUndefined()
  })
})
