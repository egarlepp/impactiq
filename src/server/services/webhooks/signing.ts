import { createHmac, timingSafeEqual } from 'node:crypto'

// How ImpactIQ signs every request it sends to an admin-configured webhook
// (the AI Assistant's webhook provider, docs/ai-webhook.md). The receiver
// recomputes HMAC-SHA256 over "<timestamp>.<raw body>" with the shared secret
// and compares it with the signature header; the timestamp lets it refuse a
// replayed request.

export const WEBHOOK_SIGNATURE_HEADER = 'X-ImpactIQ-Signature'
export const WEBHOOK_TIMESTAMP_HEADER = 'X-ImpactIQ-Timestamp'

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookBody(secret, timestamp, body))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// Headers for one signed request. With no secret the request is sent unsigned
// and without a bearer token.
export function webhookHeaders(secret: string | null, body: string, now: Date = new Date()): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'ImpactIQ-Webhook/1',
  }
  if (!secret) return headers
  const timestamp = String(Math.floor(now.getTime() / 1000))
  headers['Authorization'] = `Bearer ${secret}`
  headers[WEBHOOK_TIMESTAMP_HEADER] = timestamp
  headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, timestamp, body)
  return headers
}

// Reads a response body as text, refusing one larger than maxBytes so a
// misbehaving endpoint can't exhaust memory.
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`The response is larger than ${maxBytes} bytes`)
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`The response is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
