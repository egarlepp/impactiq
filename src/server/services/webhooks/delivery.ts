import { and, asc, eq, inArray, lt, lte, ne } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { eventWebhookDeliveries, eventWebhooks } from '../../../../drizzle/schema.js'
import { decryptToken } from '../config/crypto.js'
import { assertServiceUrl } from '../net/ssrfGuard.js'
import { safeFetch } from '../net/safeFetch.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { webhookHeaders } from './signing.js'
import { retryDelayMinutes } from '../../../shared/eventWebhooks.js'
import type { EventPayload } from './events.js'

// Sends queued event deliveries (docs/event-webhooks.md). One signed POST per
// delivery; a 2xx answer is delivered, anything else retries on the
// DELIVERY_RETRY_MINUTES schedule and is marked failed after the last try.

export const EVENT_WEBHOOK_JOB_KEY = 'event_webhook_worker'
const POLL_INTERVAL_MS = 30 * 1000
const BATCH_SIZE = 50
const REQUEST_TIMEOUT_MS = 15 * 1000

export const EVENT_HEADER = 'X-ImpactIQ-Event'
export const EVENT_ID_HEADER = 'X-ImpactIQ-Event-Id'
export const DELIVERY_ID_HEADER = 'X-ImpactIQ-Delivery'

export interface SendResult { ok: boolean; statusCode: number | null; error: string | null }

export async function sendEvent(
  hook: { url: string; secret: string; allowPrivateNetwork: boolean },
  payload: EventPayload,
  deliveryId: string,
): Promise<SendResult> {
  try {
    await assertServiceUrl(hook.url, hook.allowPrivateNetwork)
  } catch (err) {
    return { ok: false, statusCode: null, error: err instanceof Error ? err.message : String(err) }
  }
  const body = JSON.stringify(payload)
  let res: Response
  try {
    res = await safeFetch(hook.url, {
      method: 'POST',
      headers: {
        ...webhookHeaders(hook.secret, body),
        [EVENT_HEADER]: payload.type,
        [EVENT_ID_HEADER]: payload.id,
        [DELIVERY_ID_HEADER]: deliveryId,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { allowPrivateNetwork: hook.allowPrivateNetwork })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, statusCode: null, error: timedOut ? 'No answer within 15 seconds' : "The URL couldn't be reached" }
  }
  // The body isn't needed; release the connection.
  await res.body?.cancel().catch(() => {})
  if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status, error: null }
  if (res.status >= 300 && res.status < 400) return { ok: false, statusCode: res.status, error: 'Answered with a redirect, which is not followed' }
  return { ok: false, statusCode: res.status, error: `Answered with HTTP ${res.status}` }
}

// Records one attempt's outcome on its delivery row.
export async function recordAttempt(deliveryId: string, attemptsBefore: number, result: SendResult, now: Date = new Date()): Promise<void> {
  const attempts = attemptsBefore + 1
  if (result.ok) {
    await db.update(eventWebhookDeliveries).set({
      status: 'delivered', attempts, lastStatusCode: result.statusCode, lastError: null, deliveredAt: now,
    }).where(eq(eventWebhookDeliveries.id, deliveryId))
    return
  }
  const delay = retryDelayMinutes(attempts)
  await db.update(eventWebhookDeliveries).set({
    status: delay === null ? 'failed' : 'pending',
    attempts,
    lastStatusCode: result.statusCode,
    lastError: result.error?.slice(0, 500) ?? null,
    nextAttemptAt: delay === null ? now : new Date(now.getTime() + delay * 60 * 1000),
  }).where(eq(eventWebhookDeliveries.id, deliveryId))
}

export async function processDueDeliveries(now: Date = new Date()): Promise<{ delivered: number; failed: number; processed: number }> {
  const due = await db
    .select({ d: eventWebhookDeliveries, hook: eventWebhooks })
    .from(eventWebhookDeliveries)
    .innerJoin(eventWebhooks, eq(eventWebhooks.id, eventWebhookDeliveries.webhookId))
    .where(and(
      eq(eventWebhookDeliveries.status, 'pending'),
      lte(eventWebhookDeliveries.nextAttemptAt, now),
      eq(eventWebhooks.isActive, true),
    ))
    .orderBy(asc(eventWebhookDeliveries.nextAttemptAt))
    .limit(BATCH_SIZE)
  let delivered = 0
  let failed = 0
  for (const { d, hook } of due) {
    let secret: string
    try {
      secret = decryptToken(hook.secretEncrypted)
    } catch {
      await recordAttempt(d.id, d.attempts, { ok: false, statusCode: null, error: "The webhook's secret can't be read; rotate it" })
      failed++
      continue
    }
    const result = await sendEvent({ url: hook.url, secret, allowPrivateNetwork: hook.allowPrivateNetwork }, d.payload as EventPayload, d.id)
    await recordAttempt(d.id, d.attempts, result)
    if (result.ok) delivered++
    else failed++
  }
  return { delivered, failed, processed: due.length }
}

// A turned-off webhook gets nothing: its queued deliveries are closed out so
// they aren't sent in a burst if it is turned back on days later.
export async function closePendingDeliveries(webhookId: string): Promise<void> {
  await db.update(eventWebhookDeliveries)
    .set({ status: 'failed', lastError: 'The webhook was turned off' })
    .where(and(eq(eventWebhookDeliveries.webhookId, webhookId), eq(eventWebhookDeliveries.status, 'pending')))
}

// Housekeeping: finished deliveries older than the retention window.
export async function cullDeliveries(retentionDays: number, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const removed = await db.delete(eventWebhookDeliveries)
    .where(and(ne(eventWebhookDeliveries.status, 'pending'), lt(eventWebhookDeliveries.createdAt, cutoff)))
    .returning({ id: eventWebhookDeliveries.id })
  return removed.length
}

export async function retryDeliveries(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.update(eventWebhookDeliveries)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
    .where(inArray(eventWebhookDeliveries.id, ids))
}

let stopFn: (() => void) | null = null

export function startEventWebhookWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(EVENT_WEBHOOK_JOB_KEY, POLL_INTERVAL_MS, async () => {
    const startedAt = new Date()
    try {
      const { delivered, failed, processed } = await processDueDeliveries()
      // Same quiet-tick rule as the other 30s pollers (CLAUDE.md §14).
      if (processed > 0) {
        await writeRun(EVENT_WEBHOOK_JOB_KEY, startedAt, 'ok', `Delivered ${delivered}, failed ${failed}`, { delivered, failed })
      }
    } catch (err) {
      await writeRun(EVENT_WEBHOOK_JOB_KEY, startedAt, 'error', err instanceof Error ? err.message : String(err), null)
    }
  })
}

export function stopEventWebhookWorker(): void {
  stopFn?.()
  stopFn = null
}
