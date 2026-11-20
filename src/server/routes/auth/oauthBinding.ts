import { randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'
import { encryptToken as encryptSecret, decryptToken as decryptSecret } from '../../services/config/crypto.js'
import { readSessionCookie, verifySession } from '../../services/auth/session.js'

// v1.423.0 (security audit H4): binds the Salesforce and Microsoft connect
// flows to the browser and the signed-in user that started them. Same shape
// as the Okta/Azure PKCE cookie in oidc.ts: a short-lived, HttpOnly,
// encrypted cookie named after the state. The callback needs all three to
// agree: the signed state, this cookie (same nonce), and the current session
// (same user). Without that, someone could send a victim a callback link
// carrying the attacker's state and code, or the reverse, and attach one
// person's CRM or calendar tokens to another person's ImpactIQ account.
// The PKCE verifier lives here too, so it never travels in the URL.

export const SF_BINDING_COOKIE_PREFIX = 'impactiq_sf_oauth_'
export const MS_BINDING_COOKIE_PREFIX = 'impactiq_ms_oauth_'

const BINDING_MAX_AGE_S = 600

export interface OAuthBinding {
  nonce: string
  userId: string
  verifier?: string
}

export function generateBindingNonce(): string {
  return randomBytes(16).toString('base64url')
}

function cookieName(prefix: string, state: string): string {
  // State is HMAC-signed and unique per attempt; its tail (the signature)
  // keeps parallel attempts from the same browser apart.
  return prefix + state.slice(-24)
}

function secureFlag(): string {
  return process.env['NODE_ENV'] === 'production' ? '; Secure' : ''
}

export function setOAuthBindingCookie(res: Response, prefix: string, state: string, binding: OAuthBinding): void {
  const value = encodeURIComponent(encryptSecret(JSON.stringify(binding)))
  res.append('Set-Cookie', `${cookieName(prefix, state)}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${BINDING_MAX_AGE_S}${secureFlag()}`)
}

export function clearOAuthBindingCookie(res: Response, prefix: string, state: string): void {
  res.append('Set-Cookie', `${cookieName(prefix, state)}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureFlag()}`)
}

export function readOAuthBindingCookie(req: Request, prefix: string, state: string): OAuthBinding | null {
  const name = cookieName(prefix, state)
  const header = req.headers['cookie'] ?? ''
  for (const part of header.split(';')) {
    const t = part.trim()
    if (!t.startsWith(name + '=')) continue
    try {
      const parsed: unknown = JSON.parse(decryptSecret(decodeURIComponent(t.slice(name.length + 1))))
      if (!parsed || typeof parsed !== 'object') return null
      const { nonce, userId, verifier } = parsed as Record<string, unknown>
      if (typeof nonce !== 'string' || typeof userId !== 'string') return null
      if (verifier !== undefined && typeof verifier !== 'string') return null
      return { nonce, userId, ...(verifier !== undefined && { verifier }) }
    } catch {
      return null
    }
  }
  return null
}

// The user id of the live session on this request, or null. The callbacks
// can't use requireAuth: they're browser redirects and must answer with a
// redirect, not a JSON 401.
export async function currentSessionUserId(req: Request): Promise<string | null> {
  const token = readSessionCookie(req)
  if (!token) return null
  const session = await verifySession(token)
  return session?.userId ?? null
}

// Checks the cookie and the session against what the signed state says.
// Returns the binding (with the PKCE verifier, when there is one) on success.
export async function checkOAuthBinding(
  req: Request,
  prefix: string,
  state: string,
  expected: { nonce: string; userId: string },
): Promise<OAuthBinding | null> {
  const binding = readOAuthBindingCookie(req, prefix, state)
  if (!binding) return null
  if (binding.nonce !== expected.nonce || binding.userId !== expected.userId) return null
  const sessionUserId = await currentSessionUserId(req)
  if (sessionUserId !== expected.userId) return null
  return binding
}
