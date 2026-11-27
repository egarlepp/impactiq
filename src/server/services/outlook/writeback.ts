import { db } from '../../db/index.js'
import { activities, users, outlookEvents } from '../../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import { createCalendarEvent, updateCalendarEvent, OutlookScopeError, type WritebackEventInput } from './client.js'
import { getOutlookSyncSettings } from '../config/integrations.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { logSafe } from '../../lib/logSafe.js'

const BATCH_SIZE = 25
const POLL_INTERVAL_MS = 30 * 1000
const JOB_KEY = 'outlook_writeback_worker'

// Guard against the fire-and-forget kick and the poll tick both processing the
// same activity (which would create two calendar events). Mirrors the SF
// write-back inFlight set.
const inFlight = new Set<string>()

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// An attendee is "internal" (safe to add as a real Required attendee, which
// sends a Graph invite) when its email domain is in the configured internal
// list. The configured list is authoritative — the admin decides exactly
// which domains count as internal, including test/demo domains like
// "example.com.invalid" — so we never blanket-exclude by TLD here. Everyone
// else (external/customer addresses) is captured in the body only, so logging
// an activity never emails a customer.
function isInternalEmail(email: string, internalDomains: string[]): boolean {
  const e = email.trim().toLowerCase()
  if (!e.includes('@')) return false
  const domain = e.split('@')[1]
  return !!domain && internalDomains.includes(domain)
}

function buildEventInput(row: typeof activities.$inferSelect, timeZone: string, internalDomains: string[]): WritebackEventInput {
  const attendees = Array.isArray(row.attendees) ? (row.attendees as Array<{ name?: string; email?: string }>) : []

  // Split: internal → real Required attendees (invited); the rest → body text.
  const internal: Array<{ name?: string; email: string }> = []
  const externalLabels: string[] = []
  for (const a of attendees) {
    const email = (a?.email ?? '').trim()
    const label = a?.name && email ? `${a.name} <${email}>` : a?.name || email || ''
    if (email && isInternalEmail(email, internalDomains)) {
      internal.push({ email, ...(a?.name ? { name: a.name } : {}) })
    } else if (label) {
      externalLabels.push(label)
    }
  }

  // Body captures the Event description, meeting owner (can't be set as the
  // Graph organizer on a /me/events create), and any EXTERNAL attendees.
  const parts: string[] = []
  const description = (row.descriptionBody ?? '').trim()
  if (description) parts.push(`<div>${esc(description).replace(/\n/g, '<br>')}</div>`)
  if (row.meetingOwner) parts.push(`<p><strong>Meeting owner:</strong> ${esc(row.meetingOwner)}</p>`)
  if (externalLabels.length) parts.push(`<p><strong>External attendees:</strong> ${esc(externalLabels.join(', '))}</p>`)
  parts.push('<p style="color:#888;font-size:12px">Logged in ImpactIQ.</p>')

  return {
    subject: row.title,
    bodyHtml: parts.join(''),
    startIso: row.startDatetime.toISOString(),
    endIso: row.endDatetime.toISOString(),
    timeZone,
    ...(internal.length ? { attendees: internal } : {}),
  }
}

// Write (create or update) one activity to the owner's Outlook calendar.
// No-ops (clearing pending) when the activity is no longer eligible.
export async function processOutlookWriteback(activityId: string): Promise<void> {
  if (inFlight.has(activityId)) return
  inFlight.add(activityId)
  try {
    const [row] = await db.select().from(activities).where(eq(activities.id, activityId)).limit(1)
    if (!row) return
    const [user] = await db
      .select({ enabled: users.outlookWritebackEnabled, timezone: users.timezone, email: users.email })
      .from(users).where(eq(users.id, row.userId)).limit(1)

    // Eligibility: opted in, submitted, not archived, and NOT sourced from an
    // existing Outlook meeting (never duplicate a real meeting).
    const eligible = !!user?.enabled && row.status === 'submitted' && !row.isArchived && !row.outlookEventId
    if (!eligible) {
      // Drop it out of the poll without marking failed.
      if (row.outlookSyncStatus === 'pending') {
        await db.update(activities).set({ outlookSyncStatus: null, outlookSyncError: null, updatedAt: new Date() }).where(eq(activities.id, activityId))
      }
      return
    }

    try {
      // Internal = configured domains, or (when unset) the organizer's own
      // login-email domain so it still works without admin config.
      const { internalEmailDomains } = await getOutlookSyncSettings()
      const fallback = user?.email && user.email.includes('@') ? [user.email.split('@')[1]!.toLowerCase()] : []
      const internalDomains = internalEmailDomains.length ? internalEmailDomains : fallback
      const input = buildEventInput(row, user?.timezone ?? 'UTC', internalDomains)
      const eventId = row.outlookWritebackEventId
        ? await updateCalendarEvent(row.userId, row.outlookWritebackEventId, input)
        : await createCalendarEvent(row.userId, input)

      if (eventId === null) {
        // Not connected — surface it so the user can connect + resync.
        await db.update(activities).set({ outlookSyncStatus: 'failed', outlookSyncError: 'errors.outlook.not_connected', updatedAt: new Date() }).where(eq(activities.id, activityId))
        return
      }
      await db.update(activities).set({
        outlookWritebackEventId: eventId,
        outlookSyncStatus: 'synced',
        outlookSyncError: null,
        outlookSyncedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(activities.id, activityId))

      // v1.164.0: upsert the created/updated event straight into the local
      // outlook_events cache so it shows on the ImpactIQ calendar immediately.
      // Without this, the event only appears on the next (throttled) calendar
      // sync — up to a minute later — so a just-written event looks missing.
      await db.insert(outlookEvents).values({
        id: eventId,
        userId: row.userId,
        subject: row.title,
        isAllDay: false,
        startDatetime: row.startDatetime,
        endDatetime: row.endDatetime,
        fetchedAt: new Date(),
      }).onConflictDoUpdate({
        target: outlookEvents.id,
        set: { subject: row.title, startDatetime: row.startDatetime, endDatetime: row.endDatetime, fetchedAt: new Date() },
      })
    } catch (err) {
      const message = err instanceof OutlookScopeError ? err.message : (err instanceof Error ? err.message : String(err))
      await db.update(activities).set({ outlookSyncStatus: 'failed', outlookSyncError: message, updatedAt: new Date() }).where(eq(activities.id, activityId))
    }
  } finally {
    inFlight.delete(activityId)
  }
}

// Fire-and-forget kick right after an activity is submitted/edited.
export function kickOutlookWriteback(activityId: string): void {
  void processOutlookWriteback(activityId).catch((err) => {
    console.error('[outlook-writeback] inline kick failed for', logSafe(activityId), err)
  })
}

export async function processPendingOutlookWriteback(): Promise<{ processed: number }> {
  const pending = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.outlookSyncStatus, 'pending'), eq(activities.status, 'submitted')))
    .limit(BATCH_SIZE)
  let processed = 0
  for (const row of pending) {
    try { await processOutlookWriteback(row.id); processed++ }
    catch (err) { console.error('[outlook-writeback] error syncing', row.id, err) }
  }
  return { processed }
}

let stopFn: (() => void) | null = null

export function startOutlookWriteBackWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, POLL_INTERVAL_MS, async () => {
    const startedAt = new Date()
    try {
      const { processed } = await processPendingOutlookWriteback()
      // v1.229.0: only record a run when something actually happened. A
      // quiet 30s tick carries the same "alive, nothing to do"
      // non-information as digest_worker/weekly_recap_worker's quiet
      // ticks — and at 2,880 ticks/day this poller produces far more
      // potential no-op rows than either of those (1,440/288/day), which
      // is exactly what filled up job_runs after v1.227.0 made every job
      // log unconditionally. See CLAUDE.md §14.
      if (processed > 0) {
        await writeRun(JOB_KEY, startedAt, 'ok', `Processed ${processed} pending event${processed === 1 ? '' : 's'}`, { processed })
      }
    } catch (err) {
      await writeRun(JOB_KEY, startedAt, 'error', err instanceof Error ? err.message : String(err), null)
      console.error('[outlook-writeback] worker tick failed:', err)
    }
  })
  console.log(`[outlook-writeback] worker started, polling every ${POLL_INTERVAL_MS / 1000}s`)
}

export function stopOutlookWriteBackWorker(): void {
  stopFn?.()
  stopFn = null
}
