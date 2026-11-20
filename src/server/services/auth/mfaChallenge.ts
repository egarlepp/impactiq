import { createHmac, timingSafeEqual } from 'node:crypto'
import { SESSION_SECRET } from '../config/env.js'

// Short-lived token minted after the password step succeeds but before MFA
// challenge/enrollment is complete. Carries just the user id + intent (enroll
// vs verify) + expiry, HMAC-signed with the same session secret so it can't
// be forged. Cannot be exchanged for a session on its own — the /auth/mfa/*
// routes verify the second factor first.
const TTL_MS = 5 * 60 * 1000
type Intent = 'enroll' | 'verify'

function sign(payload: string): string {
  return createHmac('sha256', SESSION_SECRET).update(payload).digest('hex')
}

export function mintMfaChallenge(userId: string, intent: Intent): string {
  const expires = Date.now() + TTL_MS
  const payload = `${userId}.${intent}.${expires}`
  return `${payload}.${sign(payload)}`
}

export function verifyMfaChallenge(token: string, expectedIntent?: Intent): { userId: string; intent: Intent } | null {
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [userId, intent, expiresStr, sig] = parts as [string, string, string, string]
  if (intent !== 'enroll' && intent !== 'verify') return null
  const expires = Number(expiresStr)
  if (!Number.isFinite(expires) || expires < Date.now()) return null
  const expected = sign(`${userId}.${intent}.${expiresStr}`)
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (expectedIntent && intent !== expectedIntent) return null
  return { userId, intent: intent as Intent }
}
