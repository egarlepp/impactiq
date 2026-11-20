import crypto from 'crypto'
import { safeFetch } from '../net/safeFetch.js'
import { getOktaIntegrationConfig } from '../config/integrations.js'
import { getOktaGroupSettings } from '../config/auth-policy.js'
import { SESSION_SECRET } from '../config/env.js'

// State-token HMAC uses the session secret — this is not a token-encryption
// key; it's just proof the state came from us. Fails loud when unset in prod.
const ENCRYPTION_KEY = SESSION_SECRET

export interface OktaConfig {
  domain: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function getOktaConfig(): OktaConfig | null {
  return getOktaIntegrationConfig()
}

export function isOktaConfigured(): boolean {
  return getOktaConfig() !== null
}

const STATE_TTL_MS = 10 * 60 * 1000
// Baseline OIDC scopes every Okta org supports out of the box. The
// `groups` scope is appended conditionally inside getOktaAuthUrl when an
// admin has explicitly enabled it AND defined a matching scope on their
// Okta authorization server — Okta returns 400 invalid_scope if we
// request a scope the auth server doesn't expose.
const BASE_SCOPES = ['openid', 'profile', 'email']

function hostFromDomain(domain: string): string {
  return /^https?:\/\//.test(domain) ? domain.replace(/\/$/, '') : `https://${domain}`
}

// ── OIDC endpoint discovery ─────────────────────────────────────────────────
// Different Okta orgs expose endpoints in different places:
//   - Org-level auth server:   {domain}/oauth2/v1/authorize
//   - Default custom server:   {domain}/oauth2/default/v1/authorize
// Most dev/free orgs only have the latter, so calling /oauth2/v1/... returns
// 404. We fetch the discovery doc and trust whichever authorization_endpoint
// it returns. Cached per domain.

interface OidcEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  issuer: string
  jwks_uri: string
}

const endpointCache = new Map<string, { endpoints: OidcEndpoints; expiresAt: number }>()
const CACHE_TTL_MS = 60 * 60 * 1000

async function discoverEndpoints(domain: string): Promise<OidcEndpoints> {
  const host = hostFromDomain(domain)
  const cached = endpointCache.get(host)
  if (cached && cached.expiresAt > Date.now()) return cached.endpoints

  // Try the default custom auth server first (most common for dev orgs);
  // fall back to org-level if that 404s.
  const candidates = [
    `${host}/oauth2/default/.well-known/openid-configuration`,
    `${host}/.well-known/openid-configuration`,
  ]
  let lastErr: unknown = null
  for (const url of candidates) {
    try {
      const res = await safeFetch(url)
      if (!res.ok) { lastErr = new Error(`${url} → ${res.status}`); continue }
      const j = (await res.json()) as OidcEndpoints
      if (j.authorization_endpoint && j.token_endpoint && j.userinfo_endpoint && j.jwks_uri) {
        endpointCache.set(host, { endpoints: j, expiresAt: Date.now() + CACHE_TTL_MS })
        return j
      }
      lastErr = new Error(`${url} returned incomplete OIDC config`)
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`Okta OIDC discovery failed for ${host}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

export function signOAuthState(nonce: string): string {
  const expires = String(Date.now() + STATE_TTL_MS)
  const payload = `${nonce}.${expires}`
  const sig = crypto
    .createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
    .update(payload)
    .digest('hex')
  return `${payload}.${sig}`
}

export function verifyOAuthState(state: string): { nonce: string } | null {
  const parts = state.split('.')
  if (parts.length !== 3) return null
  const [nonce, expiresStr, sig] = parts
  if (!nonce || !expiresStr || !sig) return null
  const expires = Number(expiresStr)
  if (!Number.isFinite(expires) || Date.now() > expires) return null
  const expected = crypto
    .createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
    .update(`${nonce}.${expiresStr}`)
    .digest('hex')
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
  } catch {
    return null
  }
  return { nonce }
}

// Fresh PKCE material for a new authorization request. Server keeps the
// verifier in an HttpOnly cookie tied to state; the challenge (SHA-256, url-safe
// base64) is sent to Okta on the auth-redirect and verified by Okta at token
// exchange time. Blocks code-interception attacks even if the client_secret
// leaks.
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function generateNonce(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export async function getOktaAuthUrl(state: string, opts: { nonce: string; codeChallenge: string }): Promise<string | null> {
  const cfg = getOktaConfig()
  if (!cfg) return null
  let endpoints: OidcEndpoints
  try {
    endpoints = await discoverEndpoints(cfg.domain)
  } catch (err) {
    console.warn('[okta] discovery failed:', err)
    return null
  }
  const groupSettings = getOktaGroupSettings()
  const scopes = groupSettings.requestGroupsScope ? [...BASE_SCOPES, 'groups'] : BASE_SCOPES
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: scopes.join(' '),
    state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${endpoints.authorization_endpoint}?${params.toString()}`
}

interface OktaTokenResponse {
  access_token: string
  id_token: string
  token_type: string
  expires_in: number
  scope: string
  refresh_token?: string
}

export async function exchangeAuthorizationCode(code: string, codeVerifier?: string): Promise<OktaTokenResponse> {
  const cfg = getOktaConfig()
  if (!cfg) throw new Error('Okta is not configured')
  const endpoints = await discoverEndpoints(cfg.domain)

  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  }
  if (codeVerifier) params['code_verifier'] = codeVerifier
  const body = new URLSearchParams(params)

  const res = await safeFetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Okta token exchange failed (${res.status}): ${text}`)
  return JSON.parse(text) as OktaTokenResponse
}

export interface OktaUserInfo {
  sub: string
  email: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  preferred_username?: string
  // Group memberships — only populated when the Okta authorization server is
  // configured with a custom 'groups' claim on the OIDC app. Field name can
  // be customized via admin settings (group_claim_name); we accept both the
  // standard 'groups' and a generic record so callers can read either.
  groups?: string[]
  [key: string]: unknown
}

// Verify the id_token returned by the token endpoint against Okta's JWKS.
// Returns the parsed claims (including email_verified) so the caller can gate
// JIT provisioning on a real cryptographic identity — not the unverified
// userinfo response.
export async function verifyOktaIdToken(idToken: string, nonce: string): Promise<import('./idToken.js').IdTokenClaims> {
  const cfg = getOktaConfig()
  if (!cfg) throw new Error('Okta is not configured')
  const endpoints = await discoverEndpoints(cfg.domain)
  const { verifyIdToken } = await import('./idToken.js')
  return verifyIdToken(idToken, {
    issuer: endpoints.issuer,
    audience: cfg.clientId,
    nonce,
    jwksUri: endpoints.jwks_uri,
  })
}

export async function fetchUserInfo(accessToken: string): Promise<OktaUserInfo> {
  const cfg = getOktaConfig()
  if (!cfg) throw new Error('Okta is not configured')
  const endpoints = await discoverEndpoints(cfg.domain)

  const res = await safeFetch(endpoints.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Okta userinfo failed (${res.status}): ${text}`)
  return JSON.parse(text) as OktaUserInfo
}
