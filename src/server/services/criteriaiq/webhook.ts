import { createHmac, timingSafeEqual } from 'node:crypto'

// CriteriaIQ's live refresh webhook (v1.450.0). CriteriaIQ sends
//   X-CriteriaIQ-Signature-V2: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// The time is inside the signature, so a captured delivery can't be sent
// again once it is older than MAX_SKEW_SECONDS, and the receipts table
// refuses it inside that window. CriteriaIQ's older body-only
// X-CriteriaIQ-Signature header is never accepted here, since it can be
// replayed forever.
export const SIGNATURE_HEADER = 'x-criteriaiq-signature-v2'
export const MAX_SKEW_SECONDS = 5 * 60

export type SignatureCheck =
  | { ok: true; signature: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' }

export function verifyCriteriaIqSignature(header: unknown, rawBody: Buffer, secret: string, nowMs: number = Date.now()): SignatureCheck {
  if (typeof header !== 'string' || header.length === 0) return { ok: false, reason: 'missing' }
  const parts = new Map<string, string>()
  for (const piece of header.split(',')) {
    const i = piece.indexOf('=')
    if (i > 0) parts.set(piece.slice(0, i).trim(), piece.slice(i + 1).trim())
  }
  const t = parts.get('t')
  const v1 = parts.get('v1')
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' }
  if (Math.abs(nowMs / 1000 - Number(t)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' }
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest()
  const received = Buffer.from(v1, 'hex')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { ok: false, reason: 'mismatch' }
  return { ok: true, signature: `${t}.${v1}` }
}

export interface CriteriaIqWebhookEvent {
  event: string | null
  projectId: number | null
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v.trim()) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

// Only the event name and the project id are read, from wherever CriteriaIQ's
// built-in templates put them (n8n: top-level projectId; generic: project.id).
// Nothing else in the body is trusted: the project is read back from
// CriteriaIQ's API.
export function parseCriteriaIqWebhookBody(rawBody: Buffer): CriteriaIqWebhookEvent | null {
  let body: unknown
  try { body = JSON.parse(rawBody.toString('utf8')) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const project = b['project'] && typeof b['project'] === 'object' ? b['project'] as Record<string, unknown> : null
  const event = typeof b['event'] === 'string' ? b['event'].slice(0, 100) : null
  return { event, projectId: positiveInt(b['projectId']) ?? positiveInt(project?.['id']) }
}
