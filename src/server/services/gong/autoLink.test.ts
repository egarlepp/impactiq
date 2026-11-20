import { describe, it, expect, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

// Phase 3's pure parts: the auto-link decision, the webhook token check, the
// public key parser and the body parser. Nothing here touches the database.
vi.mock('../../db/index.js', () => ({ db: {} }))

import { decideAutoLinks, type AutoLinkCandidate } from './autoLink.js'
import { normalizeGongPublicKey, parseGongWebhookBody, verifyGongWebhook } from './webhook.js'

describe('decideAutoLinks', () => {
  const c = (activityId: string, callId: string, score: number, sameMeeting = false): AutoLinkCandidate => ({ activityId, callId, score, sameMeeting })

  it('links the same calendar meeting whatever else is near', () => {
    expect(decideAutoLinks([c('a', '1', 100, true), c('a', '2', 95)])).toEqual([{ activityId: 'a', callId: '1', method: 'calendar_event', score: 100 }])
  })

  it('links one strong match', () => {
    expect(decideAutoLinks([c('a', '1', 90), c('a', '2', 30)])).toEqual([{ activityId: 'a', callId: '1', method: 'auto', score: 90 }])
  })

  it('leaves a weak or contested match as a suggestion', () => {
    expect(decideAutoLinks([c('a', '1', 80)])).toEqual([])
    expect(decideAutoLinks([c('a', '1', 95), c('a', '2', 45)])).toEqual([])
  })

  it('skips a call that two activities both want, and one already linked', () => {
    expect(decideAutoLinks([c('a', '1', 90), c('b', '1', 88)])).toEqual([])
    expect(decideAutoLinks([c('a', '1', 90)], new Set(['1']))).toEqual([])
  })
})

describe('Gong webhook', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const now = Date.parse('2026-11-01T12:00:00Z')
  const body = Buffer.from(JSON.stringify({ callData: { metaData: { id: '7782342274025937895' } }, isTest: false }))
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

  function token(claims: Record<string, unknown>, alg = 'RS256'): string {
    const h = b64({ alg, typ: 'JWT' })
    const p = b64(claims)
    const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')
    return `${h}.${p}.${s}`
  }
  const good = {
    webhook_url: 'https://impactiq.example.com/api/webhooks/gong',
    body_sha256: createHash('sha256').update(body).digest('hex'),
    exp: now / 1000 + 300,
  }

  it('accepts a correctly signed token, with or without Bearer', () => {
    const t = token(good)
    const r = verifyGongWebhook(t, body, pem, now)
    expect(r.ok).toBe(true)
    expect(verifyGongWebhook(`Bearer ${t}`, body, pem, now)).toEqual(r)
  })

  it('refuses tampering, other algorithms, expiry and another URL', () => {
    expect(verifyGongWebhook(undefined, body, pem, now)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyGongWebhook(token(good), Buffer.from('{"x":1}'), pem, now)).toEqual({ ok: false, reason: 'body_hash' })
    expect(verifyGongWebhook(token(good, 'HS256'), body, pem, now)).toEqual({ ok: false, reason: 'algorithm' })
    const [h, , s] = token(good).split('.')
    expect(verifyGongWebhook(`${h}.${b64({ ...good, exp: good.exp + 60 })}.${s}`, body, pem, now)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyGongWebhook(token({ ...good, exp: now / 1000 - 3600 }), body, pem, now)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyGongWebhook(token({ ...good, exp: now / 1000 + 3 * 86400 }), body, pem, now)).toEqual({ ok: false, reason: 'lifetime' })
    expect(verifyGongWebhook(token({ ...good, webhook_url: 'https://x.example.com/other' }), body, pem, now)).toEqual({ ok: false, reason: 'url' })
    expect(verifyGongWebhook('a.b', body, pem, now)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses a token signed with another key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyGongWebhook(token(good), body, other, now)).toEqual({ ok: false, reason: 'signature' })
  })

  it('reads a PEM or the bare base64 key, and rejects anything else', () => {
    expect(normalizeGongPublicKey(pem)).toBe(pem)
    const bare = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
    expect(normalizeGongPublicKey(bare)).toBe(pem)
    expect(normalizeGongPublicKey('not a key')).toBeNull()
    expect(normalizeGongPublicKey('')).toBeNull()
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(normalizeGongPublicKey(ec)).toBeNull()
  })

  it('takes only the call id and test flag from the body', () => {
    expect(parseGongWebhookBody(body)).toEqual({ callId: '7782342274025937895', isTest: false })
    expect(parseGongWebhookBody(Buffer.from('{"isTest":true}'))).toEqual({ callId: null, isTest: true })
    expect(parseGongWebhookBody(Buffer.from('{"callData":{"metaData":{"id":"12; drop"}}}'))).toEqual({ callId: null, isTest: false })
    expect(parseGongWebhookBody(Buffer.from('nope'))).toBeNull()
  })
})
