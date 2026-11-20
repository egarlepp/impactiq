import { GONG_OAUTH_SCOPES } from '../../../shared/gong.js'

// Gong's OAuth endpoints (help.gong.io, "Create an app for Gong"). Gong has
// no per-user OAuth: a Gong tech admin authorizes the customer's app once,
// and the tokens read the whole tenant. Both endpoints live on app.gong.io;
// API calls then go to the tenant host Gong returns as
// api_base_url_for_customer. The token endpoint takes its parameters in the
// query string and the client credentials as HTTP Basic.
const AUTHORIZE_URL = 'https://app.gong.io/oauth2/authorize'
const TOKEN_URL = 'https://app.gong.io/oauth2/generate-customer-token'
const TIMEOUT_MS = 15_000

export function buildGongAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GONG_OAUTH_SCOPES.join(' '))
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  return url.toString()
}

export interface GongTokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresInSeconds: number | null
  apiBaseUrl: string | null
}

export class GongOAuthError extends Error {
  constructor(public readonly code: 'errors.gong.oauth_failed' | 'errors.gong.unreachable') {
    super(code)
    this.name = 'GongOAuthError'
  }
}

// Reads Gong's token answer; null when it isn't one.
export function parseGongTokenResponse(body: unknown): GongTokenResponse | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const accessToken = typeof b['access_token'] === 'string' && b['access_token'] !== '' ? b['access_token'] : null
  if (!accessToken) return null
  const expires = Number(b['expires_in'])
  return {
    accessToken,
    refreshToken: typeof b['refresh_token'] === 'string' && b['refresh_token'] !== '' ? b['refresh_token'] : null,
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : null,
    apiBaseUrl: typeof b['api_base_url_for_customer'] === 'string' ? b['api_base_url_for_customer'] : null,
  }
}

async function tokenRequest(params: Record<string, string>, clientId: string, clientSecret: string): Promise<GongTokenResponse> {
  const url = new URL(TOKEN_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new GongOAuthError('errors.gong.unreachable')
  }
  let body: unknown = null
  try { body = await res.json() } catch { body = null }
  const parsed = res.ok ? parseGongTokenResponse(body) : null
  if (!parsed) throw new GongOAuthError('errors.gong.oauth_failed')
  return parsed
}

export function exchangeGongAuthorizationCode(input: { code: string; redirectUri: string; clientId: string; clientSecret: string }): Promise<GongTokenResponse> {
  return tokenRequest(
    { grant_type: 'authorization_code', code: input.code, client_id: input.clientId, redirect_uri: input.redirectUri },
    input.clientId,
    input.clientSecret,
  )
}

export function refreshGongAccessToken(input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<GongTokenResponse> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: input.refreshToken }, input.clientId, input.clientSecret)
}
