import crypto from 'crypto'
import type { Request } from 'express'
import { getMsIntegrationConfig } from '../config/integrations.js'

const ENCRYPTION_KEY = process.env['TOKEN_ENCRYPTION_KEY'] ?? '0'.repeat(64)

export function isMicrosoftConfigured(): boolean {
  return getMsIntegrationConfig() !== null
}

function tokenEndpoint(): string {
  const tenantId = getMsIntegrationConfig()?.tenantId ?? process.env['MS_TENANT_ID'] ?? 'common'
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
}

function authorizeEndpoint(): string {
  const tenantId = getMsIntegrationConfig()?.tenantId ?? process.env['MS_TENANT_ID'] ?? 'common'
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`
}

// v1.84.0: derive the redirect_uri from the incoming request whenever we
// have one. Behind a TLS-terminating proxy (Dokploy / nginx / Cloudflare)
// APP_URL is often `http://…` while the app registration lists `https://…`,
// triggering AADSTS50011. Trusting the forwarded scheme + host from the
// request keeps the value in lockstep with whatever the user's browser
// actually hit. Falls back to APP_URL for cases with no request context
// (unit tests, background refresh, etc.).
//
// Requires `app.set('trust proxy', ...)` in the Express bootstrap so
// req.protocol respects X-Forwarded-Proto — already set in server bootstrap.
function redirectUri(req?: Request): string {
  if (req) {
    const proto = req.protocol
    const host = req.get('host')
    if (proto && host) return `${proto}://${host}/auth/microsoft/callback`
  }
  const appUrl = process.env['APP_URL'] ?? 'http://localhost:3000'
  return `${appUrl.replace(/\/$/, '')}/auth/microsoft/callback`
}

// v1.156.0: Calendars.ReadWrite (was Calendars.Read) so opted-in users can
// have logged activities written back to their calendar. ReadWrite implies
// read, so the existing calendar-read flows are unaffected. Already-connected
// users keep a read-only token until they reconnect (writes 403 until then —
// handled with a reconnect prompt).
const SCOPES = ['openid', 'profile', 'offline_access', 'Calendars.ReadWrite', 'User.Read']

const STATE_TTL_MS = 10 * 60 * 1000

// v1.423.0: the state also signs a nonce that must match the encrypted
// binding cookie set when the flow started (routes/auth/oauthBinding.ts).
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

export function getMicrosoftAuthUrl(state: string, opts?: { silent?: boolean; loginHint?: string; req?: Request }): string | null {
  const cfg = getMsIntegrationConfig()
  if (!cfg) return null
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(opts?.req),
    scope: SCOPES.join(' '),
    state,
    response_mode: 'query',
    prompt: opts?.silent ? 'none' : 'select_account',
  })
  if (opts?.loginHint) params.set('login_hint', opts.loginHint)
  return `${authorizeEndpoint()}?${params.toString()}`
}

export interface MsTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  token_type: string
  id_token?: string
}

export async function exchangeAuthorizationCode(code: string, req?: Request): Promise<MsTokenResponse> {
  const cfg = getMsIntegrationConfig()
  if (!cfg) throw new Error('Microsoft client credentials are not configured')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(req),
    scope: SCOPES.join(' '),
  })

  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Microsoft token exchange failed (${res.status}): ${text}`)
  return JSON.parse(text) as MsTokenResponse
}

export async function refreshAccessToken(refreshToken: string): Promise<MsTokenResponse> {
  const cfg = getMsIntegrationConfig()
  if (!cfg) throw new Error('Microsoft client credentials are not configured')

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: SCOPES.join(' '),
  })

  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Microsoft token refresh failed (${res.status}): ${text}`)
  return JSON.parse(text) as MsTokenResponse
}
