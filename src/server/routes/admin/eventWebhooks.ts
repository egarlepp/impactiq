import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { eventWebhookDeliveries, eventWebhooks, teams, users } from '../../../../drizzle/schema.js'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { decryptToken, encryptToken } from '../../services/config/crypto.js'
import { assertServiceUrl } from '../../services/net/ssrfGuard.js'
import { buildEventPayload } from '../../services/webhooks/events.js'
import { closePendingDeliveries, retryDeliveries, sendEvent } from '../../services/webhooks/delivery.js'
import { EVENT_TYPES, TEST_EVENT_TYPE } from '../../../shared/eventWebhooks.js'

// Admin → Integrations → Event Webhooks (docs/event-webhooks.md). App Admin
// only: a webhook sends people's activity data to a URL outside the app.
export const eventWebhooksRoutes = Router()
eventWebhooksRoutes.use('/event-webhooks', requireAppAdmin)

const RECENT_DELIVERIES_LIMIT = 100

type WebhookRow = typeof eventWebhooks.$inferSelect

function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

// Everything but the secret.
function publicWebhook(row: WebhookRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    teamIds: row.teamIds,
    userIds: row.userIds,
    allowPrivateNetwork: row.allowPrivateNetwork,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const WebhookBody = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2000),
  events: z.array(z.enum(EVENT_TYPES)).min(1).max(EVENT_TYPES.length),
  teamIds: z.array(z.string().uuid()).max(500).default([]),
  userIds: z.array(z.string().uuid()).max(500).default([]),
  allowPrivateNetwork: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

async function validateBody(body: z.infer<typeof WebhookBody>): Promise<string | null> {
  try {
    await assertServiceUrl(body.url, body.allowPrivateNetwork)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  if (body.teamIds.length > 0) {
    const found = await db.select({ id: teams.id }).from(teams).where(inArray(teams.id, body.teamIds))
    if (found.length !== new Set(body.teamIds).size) return 'errors.event_webhooks.unknown_team'
  }
  if (body.userIds.length > 0) {
    const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, body.userIds))
    if (found.length !== new Set(body.userIds).size) return 'errors.event_webhooks.unknown_user'
  }
  return null
}

eventWebhooksRoutes.get('/event-webhooks', async (req, res) => {
  const webhookId = typeof req.query['webhookId'] === 'string' ? req.query['webhookId'] : undefined
  const hooks = await db.select().from(eventWebhooks).orderBy(eventWebhooks.createdAt)
  // An ISO string, not a Date: the postgres driver can't bind a Date inside a raw sql template.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const stats = await db
    .select({
      webhookId: eventWebhookDeliveries.webhookId,
      pending: sql<string>`count(*) filter (where ${eventWebhookDeliveries.status} = 'pending')`,
      delivered7d: sql<string>`count(*) filter (where ${eventWebhookDeliveries.status} = 'delivered' and ${eventWebhookDeliveries.createdAt} >= ${since}::timestamptz)`,
      failed7d: sql<string>`count(*) filter (where ${eventWebhookDeliveries.status} = 'failed' and ${eventWebhookDeliveries.createdAt} >= ${since}::timestamptz)`,
      lastDeliveredAt: sql<string | null>`max(${eventWebhookDeliveries.deliveredAt})`,
    })
    .from(eventWebhookDeliveries)
    .groupBy(eventWebhookDeliveries.webhookId)
  const byHook = new Map(stats.map((s) => [s.webhookId, s]))
  const recent = await db
    .select({
      id: eventWebhookDeliveries.id,
      webhookId: eventWebhookDeliveries.webhookId,
      eventId: eventWebhookDeliveries.eventId,
      eventType: eventWebhookDeliveries.eventType,
      status: eventWebhookDeliveries.status,
      attempts: eventWebhookDeliveries.attempts,
      nextAttemptAt: eventWebhookDeliveries.nextAttemptAt,
      lastStatusCode: eventWebhookDeliveries.lastStatusCode,
      lastError: eventWebhookDeliveries.lastError,
      deliveredAt: eventWebhookDeliveries.deliveredAt,
      createdAt: eventWebhookDeliveries.createdAt,
    })
    .from(eventWebhookDeliveries)
    .where(webhookId ? eq(eventWebhookDeliveries.webhookId, webhookId) : undefined)
    .orderBy(desc(eventWebhookDeliveries.createdAt))
    .limit(RECENT_DELIVERIES_LIMIT)
  res.json({
    data: {
      webhooks: hooks.map((h) => {
        const s = byHook.get(h.id)
        return {
          ...publicWebhook(h),
          pending: Number(s?.pending ?? 0),
          delivered7d: Number(s?.delivered7d ?? 0),
          failed7d: Number(s?.failed7d ?? 0),
          lastDeliveredAt: s?.lastDeliveredAt ? new Date(s.lastDeliveredAt).toISOString() : null,
        }
      }),
      deliveries: recent,
    },
    error: null,
    meta: {},
  })
})

eventWebhooksRoutes.get('/event-webhooks/deliveries/:id', async (req, res) => {
  const [row] = await db.select().from(eventWebhookDeliveries).where(eq(eventWebhookDeliveries.id, String(req.params['id']))).limit(1)
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: { id: row.id, payload: row.payload }, error: null, meta: {} })
})

eventWebhooksRoutes.post('/event-webhooks', async (req, res) => {
  const parsed = WebhookBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const problem = await validateBody(parsed.data)
  if (problem) { res.status(400).json({ data: null, error: problem, meta: {} }); return }
  const secret = newSecret()
  const [row] = await db.insert(eventWebhooks).values({
    ...parsed.data,
    secretEncrypted: encryptToken(secret),
    createdBy: req.user!.id,
  }).returning()
  await logAudit(req, { action: 'event_webhook.create', targetType: 'event_webhook', targetId: row!.id, meta: { after: publicWebhook(row!) } })
  // The secret is shown once, here and on rotation.
  res.status(201).json({ data: { webhook: publicWebhook(row!), secret }, error: null, meta: {} })
})

eventWebhooksRoutes.patch('/event-webhooks/:id', async (req, res) => {
  const id = String(req.params['id'])
  const [existing] = await db.select().from(eventWebhooks).where(eq(eventWebhooks.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const parsed = WebhookBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const problem = await validateBody(parsed.data)
  if (problem) { res.status(400).json({ data: null, error: problem, meta: {} }); return }
  const [row] = await db.update(eventWebhooks)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(eventWebhooks.id, id))
    .returning()
  if (existing.isActive && !row!.isActive) await closePendingDeliveries(id)
  await logAudit(req, { action: 'event_webhook.update', targetType: 'event_webhook', targetId: id, meta: { before: publicWebhook(existing), after: publicWebhook(row!) } })
  res.json({ data: publicWebhook(row!), error: null, meta: {} })
})

eventWebhooksRoutes.delete('/event-webhooks/:id', async (req, res) => {
  const id = String(req.params['id'])
  const [existing] = await db.select().from(eventWebhooks).where(eq(eventWebhooks.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await db.delete(eventWebhooks).where(eq(eventWebhooks.id, id))
  await logAudit(req, { action: 'event_webhook.delete', targetType: 'event_webhook', targetId: id, meta: { before: publicWebhook(existing) } })
  res.json({ data: { id }, error: null, meta: {} })
})

eventWebhooksRoutes.post('/event-webhooks/:id/rotate-secret', async (req, res) => {
  const id = String(req.params['id'])
  const [existing] = await db.select({ id: eventWebhooks.id }).from(eventWebhooks).where(eq(eventWebhooks.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const secret = newSecret()
  await db.update(eventWebhooks).set({ secretEncrypted: encryptToken(secret), updatedAt: new Date() }).where(eq(eventWebhooks.id, id))
  await logAudit(req, { action: 'event_webhook.rotate_secret', targetType: 'event_webhook', targetId: id })
  res.json({ data: { secret }, error: null, meta: {} })
})

// Sends a webhook.test event right away (not queued, no retries) and
// records it in the delivery log.
eventWebhooksRoutes.post('/event-webhooks/:id/test', async (req, res) => {
  const id = String(req.params['id'])
  const [hook] = await db.select().from(eventWebhooks).where(eq(eventWebhooks.id, id)).limit(1)
  if (!hook) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  let secret: string
  try {
    secret = decryptToken(hook.secretEncrypted)
  } catch {
    res.status(409).json({ data: null, error: 'errors.event_webhooks.secret_unreadable', meta: {} }); return
  }
  const payload = buildEventPayload(TEST_EVENT_TYPE, {
    webhook: { id: hook.id, name: hook.name },
    requestedBy: { id: req.user!.id, email: req.user!.email ?? null },
  })
  const [delivery] = await db.insert(eventWebhookDeliveries).values({
    webhookId: hook.id, eventId: payload.id, eventType: TEST_EVENT_TYPE, payload, status: 'pending',
    // Never picked up by the worker: the result is recorded below.
    nextAttemptAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  }).returning({ id: eventWebhookDeliveries.id })
  const result = await sendEvent({ url: hook.url, secret, allowPrivateNetwork: hook.allowPrivateNetwork }, payload, delivery!.id)
  await db.update(eventWebhookDeliveries).set({
    status: result.ok ? 'delivered' : 'failed',
    attempts: 1,
    lastStatusCode: result.statusCode,
    lastError: result.error,
    deliveredAt: result.ok ? new Date() : null,
  }).where(eq(eventWebhookDeliveries.id, delivery!.id))
  await logAudit(req, { action: 'event_webhook.test', targetType: 'event_webhook', targetId: id, meta: { ok: result.ok, statusCode: result.statusCode, error: result.error } })
  res.json({ data: result, error: null, meta: {} })
})

// Queues a failed delivery (or every failed one for a webhook from the last
// week) to be sent again, from a fresh retry schedule.
eventWebhooksRoutes.post('/event-webhooks/retry', async (req, res) => {
  const parsed = z.object({
    deliveryId: z.string().uuid().optional(),
    webhookId: z.string().uuid().optional(),
  }).refine((v) => !!v.deliveryId !== !!v.webhookId).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const rows = await db.select({ id: eventWebhookDeliveries.id, eventType: eventWebhookDeliveries.eventType })
    .from(eventWebhookDeliveries)
    .where(and(
      eq(eventWebhookDeliveries.status, 'failed'),
      parsed.data.deliveryId
        ? eq(eventWebhookDeliveries.id, parsed.data.deliveryId)
        : and(eq(eventWebhookDeliveries.webhookId, parsed.data.webhookId!), gte(eventWebhookDeliveries.createdAt, since)),
    ))
  // A test event is only ever sent from the Test button.
  const ids = rows.filter((r) => r.eventType !== TEST_EVENT_TYPE).map((r) => r.id)
  await retryDeliveries(ids)
  await logAudit(req, {
    action: 'event_webhook.retry',
    targetType: parsed.data.deliveryId ? 'event_webhook_delivery' : 'event_webhook',
    targetId: parsed.data.deliveryId ?? parsed.data.webhookId ?? null,
    meta: { count: ids.length },
  })
  res.json({ data: { queued: ids.length }, error: null, meta: {} })
})

