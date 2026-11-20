// POST /api/webhooks/criteriaiq (v1.450.0): CriteriaIQ's live refresh. When a
// project changes, CriteriaIQ posts a signed webhook here; ImpactIQ then drops
// its cached CriteriaIQ reads on every replica and, with CriteriaIQ as the
// primary Project source, re-reads that one project's snapshot. Setup and the
// signature format are in docs/crm-providers.md (CriteriaIQ → Live refresh).
//
// No session: the signature is the only credential. The body is read raw (the
// default JSON parser skips this path, json-body.ts) because the signature
// covers the exact bytes CriteriaIQ sent; CSRF skips it too (csrf.ts). The
// global per-IP rate limit applies. Answers 404 while live refresh is off, so
// the endpoint doesn't announce itself.
import express, { Router } from 'express'
import { lt } from 'drizzle-orm'
import { db } from '../db/index.js'
import { criteriaiqWebhookReceipts } from '../../../drizzle/schema.js'
import { bumpCriteriaIqCacheEpoch, getCriteriaIqConfig, getCriteriaIqWebhookSecret } from '../services/criteriaiq/config.js'
import { parseCriteriaIqWebhookBody, SIGNATURE_HEADER, verifyCriteriaIqSignature } from '../services/criteriaiq/webhook.js'
import { refreshCriteriaIqProject } from '../services/criteriaiq/primaryProjects.js'
import { CriteriaIqError } from '../services/criteriaiq/client.js'

export const CRITERIAIQ_WEBHOOK_PATH = '/api/webhooks/criteriaiq'
const RECEIPT_KEEP_MS = 60 * 60 * 1000

export const criteriaIqWebhookRouter = Router()

criteriaIqWebhookRouter.post('/', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
  try {
    const secret = await getCriteriaIqWebhookSecret()
    if (!secret || !(await getCriteriaIqConfig())) {
      res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
      return
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const check = verifyCriteriaIqSignature(req.headers[SIGNATURE_HEADER], raw, secret)
    if (!check.ok) {
      res.status(401).json({ data: null, error: 'errors.criteriaiq.webhook_signature', meta: { reason: check.reason } })
      return
    }
    const event = parseCriteriaIqWebhookBody(raw)
    if (!event) {
      res.status(400).json({ data: null, error: 'errors.criteriaiq.webhook_body', meta: {} })
      return
    }

    const now = new Date()
    await db.delete(criteriaiqWebhookReceipts).where(lt(criteriaiqWebhookReceipts.receivedAt, new Date(now.getTime() - RECEIPT_KEEP_MS)))
    const inserted = await db.insert(criteriaiqWebhookReceipts).values({ signature: check.signature, receivedAt: now })
      .onConflictDoNothing().returning({ signature: criteriaiqWebhookReceipts.signature })
    if (inserted.length === 0) {
      // Already accepted: answer 200 so CriteriaIQ doesn't retry it.
      res.json({ data: { accepted: false, duplicate: true }, error: null, meta: {} })
      return
    }

    await bumpCriteriaIqCacheEpoch(now)
    res.status(202).json({ data: { accepted: true, duplicate: false }, error: null, meta: {} })

    if (event.projectId !== null) {
      void refreshCriteriaIqProject(event.projectId).catch((err: unknown) => {
        const msg = err instanceof CriteriaIqError ? err.code : err instanceof Error ? err.message : String(err)
        console.warn(`[criteriaiq-webhook] Could not refresh project ${event.projectId}: ${msg}`)
      })
    }
  } catch (err) {
    console.error('[criteriaiq-webhook] Failed:', err instanceof Error ? err.message : err)
    if (!res.headersSent) res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})

