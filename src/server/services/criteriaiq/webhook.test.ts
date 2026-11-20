// CriteriaIQ live refresh signature (X-CriteriaIQ-Signature-V2) and body
// parsing. The signature format matches CriteriaIQ's buildSignatureHeaders.
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { MAX_SKEW_SECONDS, parseCriteriaIqWebhookBody, verifyCriteriaIqSignature } from './webhook.js'

const SECRET = 'ciqwh_test-secret'
const NOW = Date.parse('2026-10-29T12:00:00Z')

function sign(body: string, t: number, secret = SECRET): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}

describe('verifyCriteriaIqSignature', () => {
  const body = JSON.stringify({ event: 'project.updated', projectId: 42 })
  const t = Math.floor(NOW / 1000)

  it('accepts a fresh signature over the raw body', () => {
    expect(verifyCriteriaIqSignature(sign(body, t), Buffer.from(body), SECRET, NOW)).toEqual({ ok: true, signature: `${t}.${sign(body, t).split('v1=')[1]}` })
  })

  it('refuses a missing, malformed, stale, wrong-secret or altered delivery', () => {
    expect(verifyCriteriaIqSignature(undefined, Buffer.from(body), SECRET, NOW)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyCriteriaIqSignature('sha256=abc', Buffer.from(body), SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyCriteriaIqSignature(sign(body, t - MAX_SKEW_SECONDS - 1), Buffer.from(body), SECRET, NOW)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyCriteriaIqSignature(sign(body, t + MAX_SKEW_SECONDS + 1), Buffer.from(body), SECRET, NOW)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyCriteriaIqSignature(sign(body, t, 'other'), Buffer.from(body), SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyCriteriaIqSignature(sign(body, t), Buffer.from(`${body} `), SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses a signature moved to another time', () => {
    const moved = sign(body, t).replace(`t=${t}`, `t=${t + 1}`)
    expect(verifyCriteriaIqSignature(moved, Buffer.from(body), SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' })
  })
})

describe('parseCriteriaIqWebhookBody', () => {
  it('reads the n8n and generic template shapes', () => {
    expect(parseCriteriaIqWebhookBody(Buffer.from('{"event":"criteria.updated","projectId":12}'))).toEqual({ event: 'criteria.updated', projectId: 12 })
    expect(parseCriteriaIqWebhookBody(Buffer.from('{"event":"project.updated","project":{"id":"12"}}'))).toEqual({ event: 'project.updated', projectId: 12 })
  })

  it('leaves the project id out when it is missing or not a positive integer', () => {
    expect(parseCriteriaIqWebhookBody(Buffer.from('{"event":"x","projectId":"12; drop"}'))).toEqual({ event: 'x', projectId: null })
    expect(parseCriteriaIqWebhookBody(Buffer.from('{"projectId":-3}'))).toEqual({ event: null, projectId: null })
  })

  it('refuses a body that is not a JSON object', () => {
    expect(parseCriteriaIqWebhookBody(Buffer.from('not json'))).toBeNull()
    expect(parseCriteriaIqWebhookBody(Buffer.from('[1]'))).toBeNull()
  })
})
