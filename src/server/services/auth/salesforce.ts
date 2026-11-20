import crypto from 'crypto'
import { getSfIntegrationConfig } from '../config/integrations.js'
import { assertSalesforceLoginUrl } from '../net/ssrfGuard.js'
import { safeFetch } from '../net/safeFetch.js'

// Re-export so existing importers keep working
export { encryptToken, decryptToken } from '../config/crypto.js'

const ENCRYPTION_KEY = process.env['TOKEN_ENCRYPTION_KEY'] ?? '0'.repeat(64)

export function getSalesforceLoginUrl(): string {
  const raw = getSfIntegrationConfig()?.loginUrl ?? process.env['SF_LOGIN_URL'] ?? 'https://login.salesforce.com'
  return normalizeSfOauthHost(raw)
}

// Salesforce's `.lightning.force.com` domain is a Lightning UI host,
// not an OAuth API host. Hitting it for /services/oauth2/token returns
// HTTP 400 unsupported_grant_type. Admins routinely paste the UI URL
// into the Login URL field, so normalize it here for OAuth endpoints:
//   - `<org>.sandbox.lightning.force.com` → `test.salesforce.com`
//   - `<org>.lightning.force.com`         → `login.salesforce.com`
//   - `<org>.my.salesforce.com`           → unchanged (this IS the API host)
// Callers who need the raw UI URL still store it via config.
export function normalizeSfOauthHost(raw: string): string {
  try {
    const u = new URL(raw)
    const host = u.hostname
    if (host.endsWith('.lightning.force.com')) {
      if (host.endsWith('.sandbox.lightning.force.com')) return 'https://test.salesforce.com'
      return 'https://login.salesforce.com'
    }
    // Strip trailing slash so we don't produce `//services/oauth2/token`
    return `${u.protocol}//${u.host}`
  } catch {
    return raw
  }
}

export function isSalesforceConfigured(): boolean {
  return getSfIntegrationConfig() !== null
}

const STATE_TTL_MS = 10 * 60 * 1000

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// PKCE (RFC 7636). Salesforce Connected Apps now require this by
// default. The verifier is a random 32-byte URL-safe string; the
// challenge is the base64url-encoded SHA-256 of the verifier.
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// State carries (userId, expires, nonce, sig), HMAC-signed so neither the
// user id nor the nonce can be swapped. v1.423.0: the PKCE verifier no
// longer rides in the state (the state is visible in the URL, which defeated
// PKCE). It sits in the encrypted binding cookie next to the same nonce
// (routes/auth/oauthBinding.ts), and the callback checks all of them
// against the signed-in session.
export function signOAuthState(userId: string, nonce: string): string {
  const expires = String(Date.now() + STATE_TTL_MS)
  const payload = `${userId}.${expires}.${nonce}`
  const sig = crypto
    .createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
    .update(payload)
    .digest('hex')
  return `${payload}.${sig}`
}

export function verifyOAuthState(state: string): { userId: string; nonce: string } | null {
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [userId, expiresStr, nonce, sig] = parts
  if (!userId || !expiresStr || !nonce || !sig) return null
  const expires = Number(expiresStr)
  if (!Number.isFinite(expires) || Date.now() > expires) return null
  const expected = crypto
    .createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
    .update(`${userId}.${expiresStr}.${nonce}`)
    .digest('hex')
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
  } catch {
    return null
  }
  return { userId, nonce }
}

export function getSalesforceAuthUrl(state: string, codeChallenge: string, hostOverride?: string | null): string | null {
  const cfg = getSfIntegrationConfig()
  if (!cfg) return null
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state,
    scope: 'api refresh_token offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  // If the caller supplies a user-specific host (their previously
  // recorded instance URL), prefer it — a reconnect must land the user
  // on the same org they were connected to, not the tenant-wide fallback.
  const base = hostOverride ? normalizeSfOauthHost(hostOverride) : getSalesforceLoginUrl()
  return `${base}/services/oauth2/authorize?${params.toString()}`
}

export interface SfTokenResponse {
  access_token: string
  refresh_token?: string
  instance_url: string
  id: string
  issued_at: string
  signature: string
  scope?: string
  token_type: string
}

export async function exchangeAuthorizationCode(code: string, codeVerifier: string, hostOverride?: string | null): Promise<SfTokenResponse> {
  const cfg = getSfIntegrationConfig()
  if (!cfg) throw new Error('Salesforce client credentials are not configured')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  })

  // Token endpoint must live on the same host that issued the code —
  // otherwise Salesforce returns invalid_grant. Callers pass the same
  // hostOverride they used at authorize time (typically the user's
  // stored instance URL for a reconnect).
  const rawTokenHost = hostOverride ? normalizeSfOauthHost(hostOverride) : getSalesforceLoginUrl()
  // Security fix (F-01, pentest 2026-09): this is the exact call that leaks
  // client_secret (line below) — validated here as the last line of defense
  // even though loginUrl is now also validated at save time (services/net/
  // ssrfGuard.ts), in case a legacy value was stored before this fix, or an
  // env-var SF_LOGIN_URL override is misconfigured. hostOverride (a user's
  // own previously-connected instanceUrl) is checked too — it should always
  // already be a real Salesforce host since Salesforce itself returned it
  // from a prior successful exchange, so this never rejects a legitimate
  // value, only a poisoned or misconfigured one.
  const tokenHostUrl = await assertSalesforceLoginUrl(rawTokenHost)
  const res = await safeFetch(`${tokenHostUrl.origin}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Salesforce token exchange failed (${res.status}): ${text}`)
  return JSON.parse(text) as SfTokenResponse
}

export async function refreshAccessToken(
  refreshToken: string,
  instanceUrl: string,
): Promise<SfTokenResponse> {
  const cfg = getSfIntegrationConfig()
  if (!cfg) throw new Error('Salesforce client credentials are not configured')

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  })

  // Security fix (F-01, pentest 2026-09): same secret-exposure shape as
  // exchangeAuthorizationCode above (client_secret is posted below) — see
  // that function's comment for why this validates a value that should
  // already always be legitimate.
  const rawTokenHost = instanceUrl || getSalesforceLoginUrl()
  const tokenHostUrl = await assertSalesforceLoginUrl(rawTokenHost)
  const res = await safeFetch(`${tokenHostUrl.origin}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Salesforce token refresh failed (${res.status}): ${text}`)
  return JSON.parse(text) as SfTokenResponse
}
