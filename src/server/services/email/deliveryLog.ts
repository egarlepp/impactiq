import { and, eq, gte, lt, sql, desc } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { emailDeliveries } from '../../../../drizzle/schema.js'

// v1.440.0: outcome log for every email sent through the admin-configured
// transport (sendEmailViaConfigured). Feeds App Health's Email tile; the body
// is never stored. Recording must never fail or slow a send, so a write error
// is only logged.

export type EmailTransport = 'smtp' | 'graph_app'

const ERROR_MAX = 500
const SUBJECT_MAX = 200

export async function recordEmailDelivery(entry: {
  category: string
  recipient: string
  subject: string
  transport: EmailTransport
  error: unknown | null
}): Promise<void> {
  const error = entry.error === null ? null
    : (entry.error instanceof Error ? entry.error.message : String(entry.error)).slice(0, ERROR_MAX)
  try {
    await db.insert(emailDeliveries).values({
      category: entry.category,
      recipient: entry.recipient,
      subject: entry.subject.slice(0, SUBJECT_MAX),
      transport: entry.transport,
      status: error === null ? 'sent' : 'failed',
      error,
    })
  } catch (err) {
    console.warn('[email] could not record delivery:', err instanceof Error ? err.message : String(err))
  }
}

export interface EmailDeliverySummary {
  sent: number
  failed: number
  lastFailure: { at: string; category: string; error: string | null } | null
  lastSentAt: string | null
}

export async function emailDeliverySummary(since: Date): Promise<EmailDeliverySummary> {
  const [counts] = await db
    .select({
      sent: sql<string>`count(*) FILTER (WHERE ${emailDeliveries.status} = 'sent')`,
      failed: sql<string>`count(*) FILTER (WHERE ${emailDeliveries.status} = 'failed')`,
    })
    .from(emailDeliveries)
    .where(gte(emailDeliveries.createdAt, since))
  const [lastFailure] = await db
    .select({ at: emailDeliveries.createdAt, category: emailDeliveries.category, error: emailDeliveries.error })
    .from(emailDeliveries)
    .where(and(eq(emailDeliveries.status, 'failed'), gte(emailDeliveries.createdAt, since)))
    .orderBy(desc(emailDeliveries.createdAt))
    .limit(1)
  const [lastSent] = await db
    .select({ at: emailDeliveries.createdAt })
    .from(emailDeliveries)
    .where(eq(emailDeliveries.status, 'sent'))
    .orderBy(desc(emailDeliveries.createdAt))
    .limit(1)
  return {
    sent: Number(counts?.sent ?? 0),
    failed: Number(counts?.failed ?? 0),
    lastFailure: lastFailure ? { at: lastFailure.at.toISOString(), category: lastFailure.category, error: lastFailure.error } : null,
    lastSentAt: lastSent ? lastSent.at.toISOString() : null,
  }
}

export async function cullEmailDeliveries(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const rows = await db.delete(emailDeliveries).where(lt(emailDeliveries.createdAt, cutoff)).returning({ id: emailDeliveries.id })
  return rows.length
}
