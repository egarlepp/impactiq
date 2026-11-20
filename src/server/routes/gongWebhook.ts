// POST /api/webhooks/gong (v1.456.0, Gong plan phase 3): Gong's "Fire
// webhook" automation rule posts a call here as soon as Gong has processed
// it, so the call is indexed and auto-linked in seconds instead of waiting
// for the next 15-minute pass. Setup is on Admin → Integrations → Gong.
//
// No session: Gong's signed token (RS256, verified with the public key the
// admin pasted) is the only credential, and it covers the exact body bytes,
// so the body is read raw (json-body.ts skips this path; csrf.ts too). The
// body is never trusted beyond the call id: the call is re-read from the
// Gong API before anything is stored. Answers 404 while Gong isn't
// connected or no public key is set, so the endpoint doesn't announce itself.
import express, { Router } from 'express'
import { lt } from 'drizzle-orm'
import { db } from '../db/index.js'
import { gongWebhookReceipts } from '../../../drizzle/schema.js'
import { getGongConfig } from '../services/gong/config.js'
import { GONG_WEBHOOK_MAX_TOKEN_LIFETIME_MS, parseGongWebhookBody, verifyGongWebhook } from '../services/gong/webhook.js'
import { indexGongCallsById } from '../services/gong/calls.js'
import { runGongAutoLink } from '../services/gong/autoLink.js'
import { GongError } from '../services/gong/client.js'

export const gongWebhookRouter = Router()

gongWebhookRouter.post('/', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  try {
    const cfg = await getGongConfig()
    if (!cfg || !cfg.webhookPublicKeyPem) {
      res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
      return
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const check = verifyGongWebhook(req.headers['authorization'], raw, cfg.webhookPublicKeyPem)
    if (!check.ok) {
      res.status(401).json({ data: null, error: 'errors.gong.webhook_signature', meta: { reason: check.reason } })
      return
    }
    const event = parseGongWebhookBody(raw)
    if (!event) {
      res.status(400).json({ data: null, error: 'errors.gong.webhook_body', meta: {} })
      return
    }

    const now = new Date()
    await db.delete(gongWebhookReceipts).where(lt(gongWebhookReceipts.receivedAt, new Date(now.getTime() - GONG_WEBHOOK_MAX_TOKEN_LIFETIME_MS)))
    const inserted = await db.insert(gongWebhookReceipts).values({ tokenHash: check.tokenHash, receivedAt: now })
      .onConflictDoNothing().returning({ tokenHash: gongWebhookReceipts.tokenHash })
    if (inserted.length === 0) {
      // Already accepted: 200 so Gong doesn't retry it.
      res.json({ data: { accepted: false, duplicate: true }, error: null, meta: {} })
      return
    }
    // Gong's "Test" button: the signature checked out, nothing to do.
    if (event.isTest || !event.callId) {
      res.json({ data: { accepted: true, test: event.isTest }, error: null, meta: {} })
      return
    }

    res.status(202).json({ data: { accepted: true }, error: null, meta: {} })

    const callId = event.callId
    void (async () => {
      const indexed = await indexGongCallsById([callId])
      if (indexed.length > 0) await runGongAutoLink({ source: 'webhook', callIds: indexed })
    })().catch((err: unknown) => {
      const msg = err instanceof GongError ? err.code : err instanceof Error ? err.message : String(err)
      console.warn(`[gong-webhook] Could not index call ${callId}: ${msg}`)
    })
  } catch (err) {
    console.error('[gong-webhook] Failed:', err instanceof Error ? err.message : err)
    if (!res.headersSent) res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})
