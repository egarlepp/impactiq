import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { GONG_WEBHOOK_PATH } from '../../../shared/gong.js'

// Gong's signed webhook (Gong plan, phase 3). A Gong automation rule with
// the "Fire webhook" action posts the call to /api/webhooks/gong with a JWT
// in the Authorization header, signed RS256 with the key pair Gong shows on
// the rule. The token's claims carry the URL it was sent to (webhook_url), a
// SHA-256 of the exact body (body_sha256) and an expiry (exp). The body
// itself is never trusted: the receiver only takes the call id from it and
// reads the call from the Gong API.

// Tokens that claim to stay valid longer than this are refused, since
// receipts (the replay guard) are kept this long.
export const GONG_WEBHOOK_MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 60 * 1000
const MAX_TOKEN_LENGTH = 8192

// Accepts a PEM public key or the bare base64 body Gong shows, and returns
// a normalized SPKI PEM, or null if it isn't an RSA public key.
export function normalizeGongPublicKey(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > 8192) return null
  let pem = trimmed
  if (!trimmed.includes('-----BEGIN')) {
    const b64 = trimmed.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return null
    pem = `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END PUBLIC KEY-----\n`
  }
  try {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'rsa') return null
    return key.export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    return null
  }
}

function b64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  return Buffer.from(s, 'base64url')
}

function jsonPart(s: string): Record<string, unknown> | null {
  const buf = b64urlDecode(s)
  if (!buf) return null
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

export type GongWebhookCheck =
  | { ok: true; tokenHash: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'algorithm' | 'signature' | 'expired' | 'lifetime' | 'body_hash' | 'url' }

// Verifies the Authorization header against the raw body.
export function verifyGongWebhook(
  authorization: string | string[] | undefined,
  rawBody: Buffer,
  publicKey: string | KeyObject,
  now: number = Date.now(),
): GongWebhookCheck {
  const header = Array.isArray(authorization) ? authorization[0] : authorization
  if (!header) return { ok: false, reason: 'missing' }
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, p, sig] = parts as [string, string, string]
  const head = jsonPart(h)
  const claims = jsonPart(p)
  const signature = b64urlDecode(sig)
  if (!head || !claims || !signature || signature.length === 0) return { ok: false, reason: 'malformed' }
  // Only RS256: never "none", never an HMAC that could be keyed with the
  // public key.
  if (head['alg'] !== 'RS256') return { ok: false, reason: 'algorithm' }
  let valid = false
  try {
    valid = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, signature)
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'signature' }

  const exp = claims['exp']
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'malformed' }
  if (exp * 1000 < now - CLOCK_SKEW_MS) return { ok: false, reason: 'expired' }
  if (exp * 1000 > now + GONG_WEBHOOK_MAX_TOKEN_LIFETIME_MS) return { ok: false, reason: 'lifetime' }

  const bodyHash = claims['body_sha256']
  if (typeof bodyHash !== 'string') return { ok: false, reason: 'body_hash' }
  const digest = createHash('sha256').update(rawBody).digest()
  const matches = bodyHash.toLowerCase() === digest.toString('hex')
    || bodyHash === digest.toString('base64')
    || bodyHash === digest.toString('base64url')
  if (!matches) return { ok: false, reason: 'body_hash' }

  const url = claims['webhook_url']
  if (url !== undefined) {
    let path: string | null = null
    try { path = typeof url === 'string' ? new URL(url).pathname.replace(/\/+$/, '') : null } catch { path = null }
    if (path !== GONG_WEBHOOK_PATH) return { ok: false, reason: 'url' }
  }

  return { ok: true, tokenHash: createHash('sha256').update(token).digest('hex') }
}

export interface GongWebhookEvent {
  callId: string | null
  isTest: boolean
}

// The call id and test flag from the body. Null when it isn't JSON.
export function parseGongWebhookBody(raw: Buffer): GongWebhookEvent | null {
  let v: unknown
  try { v = JSON.parse(raw.toString('utf8')) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const body = v as Record<string, unknown>
  const callData = body['callData'] && typeof body['callData'] === 'object' ? body['callData'] as Record<string, unknown> : null
  const meta = callData?.['metaData'] && typeof callData['metaData'] === 'object' ? callData['metaData'] as Record<string, unknown> : null
  const rawId = meta?.['id']
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : null
  return {
    callId: id && /^\d{1,30}$/.test(id) ? id : null,
    isTest: body['isTest'] === true,
  }
}
