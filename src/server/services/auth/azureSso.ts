import crypto from 'crypto'
import { getAzureSsoIntegrationConfig } from '../config/integrations.js'
import { SESSION_SECRET } from '../config/env.js'

// Azure AD / Entra ID OIDC login provider. Mirrors services/auth/okta.ts:
// standard OpenID Connect authorization-code flow with PKCE, an HMAC-signed
// state token, id_token verification against the tenant JWKS, and a userinfo
// fetch. Endpoints come from the tenant discovery document, so this works for
// GUID tenant ids as well as *.onmicrosoft.com domains.

const ENCRYPTION_KEY = SESSION_SECRET

export interface AzureSsoConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  redirectUri: string
  allowJit: boolean
}

export function getAzureSsoConfig(): AzureSsoConfig | null {
  return getAzureSsoIntegrationConfig()
}

export function isAzureSsoConfigured(): boolean {
  return getAzureSsoConfig() !== null
}

const STATE_TTL_MS = 10 * 60 * 1000
// Azure v2.0 supports the standard OIDC scopes. `offline_access` is omitted —
// ImpactIQ only needs the id_token identity, not a refresh token.
const BASE_SCOPES = ['openid', 'profile', 'email']

interface OidcEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  issuer: string
  jwks_uri: string
}

const endpointCache = new Map<string, { endpoints: OidcEndpoints; expiresAt: number }>()
const CACHE_TTL_MS = 60 * 60 * 1000

async function discoverEndpoints(tenantId: string): Promise<OidcEndpoints> {
  const tenant = encodeURIComponent(tenantId.trim())
  const cached = endpointCache.get(tenant)
  if (cached && cached.expiresAt > Date.now()) return cached.endpoints
  const url = `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Azure OIDC discovery failed for ${tenant}: ${url} → ${res.status}`)
  const j = (await res.json()) as OidcEndpoints
  if (!j.authorization_endpoint || !j.token_endpoint || !j.jwks_uri) {
    throw new Error(`Azure OIDC discovery returned incomplete config for ${tenant}`)
  }
  // Azure omits userinfo_endpoint from some discovery docs — fall back to the
  // Microsoft Graph OIDC userinfo endpoint.
  if (!j.userinfo_endpoint) j.userinfo_endpoint = 'https://graph.microsoft.com/oidc/userinfo'
  endpointCache.set(tenant, { endpoints: j, expiresAt: Date.now() + CACHE_TTL_MS })
  return j
}

export function signOAuthState(nonce: string): string {
  const expires = String(Date.now() + STATE_TTL_MS)
  const payload = `${nonce}.${expires}`
  const sig = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex')).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function verifyOAuthState(state: string): { nonce: string } | null {
  const parts = state.split('.')
  if (parts.length !== 3) return null
  const [nonce, expiresStr, sig] = parts
  if (!nonce || !expiresStr || !sig) return null
  const expires = Number(expiresStr)
  if (!Number.isFinite(expires) || Date.now() > expires) return null
  const expected = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex')).update(`${nonce}.${expiresStr}`).digest('hex')
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
  } catch {
    return null
  }
  return { nonce }
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function generateNonce(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export async function getAzureAuthUrl(state: string, opts: { nonce: string; codeChallenge: string }): Promise<string | null> {
  const cfg = getAzureSsoConfig()
  if (!cfg) return null
  let endpoints: OidcEndpoints
  try {
    endpoints = await discoverEndpoints(cfg.tenantId)
  } catch (err) {
    console.warn('[azure-sso] discovery failed:', err)
    return null
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: BASE_SCOPES.join(' '),
    state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
  })
  return `${endpoints.authorization_endpoint}?${params.toString()}`
}

interface AzureTokenResponse {
  access_token: string
  id_token: string
  token_type: string
  expires_in: number
  scope: string
  refresh_token?: string
}

export async function exchangeAuthorizationCode(code: string, codeVerifier?: string): Promise<AzureTokenResponse> {
  const cfg = getAzureSsoConfig()
  if (!cfg) throw new Error('Azure SSO is not configured')
  const endpoints = await discoverEndpoints(cfg.tenantId)
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  }
  if (codeVerifier) params['code_verifier'] = codeVerifier
  const res = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Azure token exchange failed (${res.status}): ${text}`)
  return JSON.parse(text) as AzureTokenResponse
}

export interface AzureUserInfo {
  sub: string
  email?: string
  name?: string
  given_name?: string
  family_name?: string
  preferred_username?: string
  [key: string]: unknown
}

export async function verifyAzureIdToken(idToken: string, nonce: string): Promise<import('./idToken.js').IdTokenClaims> {
  const cfg = getAzureSsoConfig()
  if (!cfg) throw new Error('Azure SSO is not configured')
  const endpoints = await discoverEndpoints(cfg.tenantId)
  const { verifyIdToken } = await import('./idToken.js')
  return verifyIdToken(idToken, {
    issuer: endpoints.issuer,
    audience: cfg.clientId,
    nonce,
    jwksUri: endpoints.jwks_uri,
  })
}

export async function fetchUserInfo(accessToken: string): Promise<AzureUserInfo> {
  const cfg = getAzureSsoConfig()
  if (!cfg) throw new Error('Azure SSO is not configured')
  const endpoints = await discoverEndpoints(cfg.tenantId)
  const res = await fetch(endpoints.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` } })
  const text = await res.text()
  if (!res.ok) throw new Error(`Azure userinfo failed (${res.status}): ${text}`)
  return JSON.parse(text) as AzureUserInfo
}
