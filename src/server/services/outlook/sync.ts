import { db } from '../../db/index.js'
import { activities, outlookEvents, users } from '../../../../drizzle/schema.js'
import { and, eq, gte, lte, lt, notInArray, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm'
import { fetchCalendarEvents } from './client.js'
import { getOutlookSyncSettings } from '../config/integrations.js'
import { emitActivityEvent } from '../webhooks/events.js'

const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 min throttle
const BACKFILL_DAYS = 7 // always re-pull the last week so edits show up

// Sync the user's Outlook events into the local outlook_events table.
// Fetches [now - 7d, now + forwardDays] from Graph, upserts every row, then
// prunes anything older than retentionDays. Throttled to once per 5 min per
// user; pass force=true to bypass the throttle (e.g. explicit refresh).
export async function syncUserCalendar(userId: string, opts: { force?: boolean; maxAgeMs?: number } = {}): Promise<{ synced: number } | null> {
  const [row] = await db.select({ last: users.outlookEventsLastSyncedAt }).from(users).where(eq(users.id, userId)).limit(1)
  if (!row) return null
  // The active calendar view passes a shorter maxAgeMs so a deletion made in
  // Outlook reconciles within ~a minute, without dropping the default 5-min
  // throttle for background/bulk callers.
  const throttleMs = opts.maxAgeMs ?? MIN_SYNC_INTERVAL_MS
  if (!opts.force && row.last && Date.now() - row.last.getTime() < throttleMs) return { synced: 0 }

  const { forwardDays, retentionDays } = await getOutlookSyncSettings()
  const start = new Date(Date.now() - BACKFILL_DAYS * 86400_000)
  const end = new Date(Date.now() + forwardDays * 86400_000)

  const events = await fetchCalendarEvents(userId, start.toISOString(), end.toISOString())
  if (events === null) return null // not connected

  if (events.length > 0) {
    const values = events.map((e) => ({
      id: e.id,
      userId,
      subject: e.subject,
      bodyPreview: e.bodyPreview,
      isAllDay: e.isAllDay,
      startDatetime: new Date(e.start),
      endDatetime: new Date(e.end),
      location: e.location ?? null,
      organizerName: e.organizer?.name ?? null,
      organizerEmail: e.organizer?.email ?? null,
      attendees: e.attendees ?? null,
      seriesMasterId: e.seriesMasterId ?? null,
      eventType: e.eventType ?? null,
      // v1.225.0: free/busy signal for calendar-derived capacity.
      showAs: e.showAs ?? null,
      isCancelled: e.isCancelled ?? null,
      responseStatus: e.responseStatus ?? null,
      // v1.262.0: same "must be in both halves" warning as showAs above.
      sensitivity: e.sensitivity ?? null,
      fetchedAt: new Date(),
    }))
    await db.insert(outlookEvents).values(values).onConflictDoUpdate({
      target: outlookEvents.id,
      set: {
        subject: sql`excluded.subject`,
        bodyPreview: sql`excluded.body_preview`,
        isAllDay: sql`excluded.is_all_day`,
        startDatetime: sql`excluded.start_datetime`,
        endDatetime: sql`excluded.end_datetime`,
        location: sql`excluded.location`,
        organizerName: sql`excluded.organizer_name`,
        organizerEmail: sql`excluded.organizer_email`,
        attendees: sql`excluded.attendees`,
        seriesMasterId: sql`excluded.series_master_id`,
        eventType: sql`excluded.event_type`,
        // v1.225.0: must be in BOTH the insert values above and this
        // update-set clause — this exact upsert has had a bug before where a
        // new column was added to one half and not the other, silently
        // going stale on every re-sync after the first.
        showAs: sql`excluded.show_as`,
        isCancelled: sql`excluded.is_cancelled`,
        responseStatus: sql`excluded.response_status`,
        sensitivity: sql`excluded.sensitivity`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    })
  }

  // v1.91.0: batch SF Contact + Opportunity match for events whose cache
  // is missing or older than the TTL. One SOQL round-trip per user per
  // sync, regardless of how many events. Non-fatal — sync stays green
  // even if SF is down or the user isn't connected.
  try {
    await computeSfSuggestionsBatch(userId, events.map((e) => e.id))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[sync] SF suggestion compute failed:', err instanceof Error ? err.message : err)
  }

  // Reconcile deletions: remove cached rows in the pulled window that Graph
  // no longer returns — otherwise an event deleted in Outlook (e.g. an
  // ImpactIQ-created write-back the user removed) lingers on the calendar
  // panel forever. Scoped to this user + this window. When the window came
  // back empty, every cached row in it is stale, so delete them all.
  const fetchedIds = events.map((e) => e.id)

  // v1.242.0: capture WHICH ids are about to be dropped, before dropping them,
  // so approved activities pointing at them can be flagged for review.
  //
  // This is the only place that flag is ever set, and it sits after the
  // `events === null` early-return above — so it can only run off a
  // SUCCESSFUL Graph fetch. That ordering is the whole safety property: a
  // failed fetch must never be mistaken for the user deleting meetings.
  const vanished = await db
    .select({ id: outlookEvents.id })
    .from(outlookEvents)
    .where(and(
      eq(outlookEvents.userId, userId),
      gte(outlookEvents.startDatetime, start),
      lte(outlookEvents.startDatetime, end),
      ...(fetchedIds.length ? [notInArray(outlookEvents.id, fetchedIds)] : []),
    ))

  await db.delete(outlookEvents).where(and(
    eq(outlookEvents.userId, userId),
    gte(outlookEvents.startDatetime, start),
    lte(outlookEvents.startDatetime, end),
    ...(fetchedIds.length ? [notInArray(outlookEvents.id, fetchedIds)] : []),
  ))

  await flagDeletedOutlookActivities(userId, vanished.map((v) => v.id), fetchedIds)

  // Retention prune (per-user; other users clean themselves up on their own sync)
  const cutoff = new Date(Date.now() - retentionDays * 86400_000)
  await db.delete(outlookEvents).where(and(eq(outlookEvents.userId, userId), lt(outlookEvents.startDatetime, cutoff)))

  await db.update(users).set({ outlookEventsLastSyncedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId))

  return { synced: events.length }
}

const SF_SUGGESTION_TTL_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * v1.242.0: maintain activities.outlook_deleted_at for one user, given the
 * event ids that just disappeared from Graph and the ids that are still there.
 *
 * Deliberately narrow:
 *  - APPROVED (submitted) activities only. A draft still being worked on isn't
 *    a review item, and the user explicitly scoped this to approved work.
 *  - Only activities that reference an Outlook event at all — either the
 *    inbound meeting (outlookEventId) or an event ImpactIQ wrote back
 *    (outlookWritebackEventId). A manually-created activity was never on the
 *    calendar, so its absence there means nothing and it must never be flagged.
 *  - `outlookDeletedKept` rows are skipped, so a Keep decision isn't undone by
 *    the next sync.
 *
 * Reappearance clears BOTH columns: a re-created (or restored) meeting should
 * behave like it never went missing, including making a previous Keep moot.
 */
async function flagDeletedOutlookActivities(
  userId: string,
  vanishedIds: string[],
  presentIds: string[],
): Promise<void> {
  if (vanishedIds.length > 0) {
    const flagged = await db
      .update(activities)
      .set({ outlookDeletedAt: new Date() })
      .where(and(
        eq(activities.userId, userId),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        eq(activities.outlookDeletedKept, false),
        isNull(activities.outlookDeletedAt),
        or(
          inArray(activities.outlookEventId, vanishedIds),
          inArray(activities.outlookWritebackEventId, vanishedIds),
        ),
      ))
      .returning({ id: activities.id })
    for (const row of flagged) await emitActivityEvent('activity.outlook_deleted', row.id)
  }

  if (presentIds.length > 0) {
    // The event is back (or never actually left). Clear the flag AND the Keep
    // suppression so the pair can't get stuck in a state where a future real
    // deletion goes unflagged.
    await db
      .update(activities)
      .set({ outlookDeletedAt: null, outlookDeletedKept: false })
      .where(and(
        eq(activities.userId, userId),
        or(
          isNotNull(activities.outlookDeletedAt),
          eq(activities.outlookDeletedKept, true),
        ),
        or(
          inArray(activities.outlookEventId, presentIds),
          inArray(activities.outlookWritebackEventId, presentIds),
        ),
      ))
  }
}


// Batch-compute Account + Opportunity suggestions for the given event ids.
// Skips events whose cache is < 24h old. Sends ONE Contact-by-email SOQL
// and ONE OpportunityContactRole SOQL for the whole batch, then splits
// the results back per event by attendee email. Zero SF calls when
// nothing needs computing.
export async function computeSfSuggestionsBatch(userId: string, eventIds: string[], opts: { force?: boolean } = {}): Promise<void> {
  if (eventIds.length === 0) return
  const rows = await db.select({
    id: outlookEvents.id,
    attendees: outlookEvents.attendees,
    organizerEmail: outlookEvents.organizerEmail,
    computedAt: outlookEvents.crmSuggestionComputedAt,
  }).from(outlookEvents).where(and(eq(outlookEvents.userId, userId)))
  // v1.98.0: manual per-event recompute (chip Refresh icon) passes
  // force=true so a previous null-candidates result doesn't get
  // permanently pinned by the 24h TTL — the user explicitly asked to
  // retry. Batch sync callers still honour the TTL so a busy user
  // doesn't burn SF quota on every 5-minute sync.
  const now = Date.now()
  const scoped = eventIds.length > 0 ? rows.filter((r) => eventIds.includes(r.id)) : rows
  const stale = opts.force
    ? scoped
    : scoped.filter((r) => !r.computedAt || (now - r.computedAt.getTime()) > SF_SUGGESTION_TTL_MS)
  if (stale.length === 0) return

  const emailToEventIds = new Map<string, string[]>()
  for (const r of stale) {
    const emails: string[] = []
    if (r.organizerEmail) emails.push(r.organizerEmail.toLowerCase())
    const raw = r.attendees as Array<{ email?: string }> | null
    for (const a of raw ?? []) if (a.email) emails.push(a.email.toLowerCase())
    for (const e of emails) {
      const arr = emailToEventIds.get(e) ?? []
      arr.push(r.id)
      emailToEventIds.set(e, arr)
    }
  }
  const uniqueEmails = Array.from(emailToEventIds.keys())
  if (uniqueEmails.length === 0) return

  // Whichever CRM the install uses (HubSpot plan, phase 7b): Salesforce runs
  // as the user's own connection, HubSpot on the portal connection. No
  // active CRM, or a user not connected to it, computes nothing.
  const { getActiveCrmProvider } = await import('../crm/index.js')
  const provider = await getActiveCrmProvider()
  if (!provider) return
  const session = await provider.connectForUser(userId)
  if (!session) return

  const { accounts, opportunities } = await session.suggestFromAttendees(uniqueEmails)

  // Split matches back per event
  // v1.180.0: `detail` is a short subtitle (Stage · Owner · Closes date for
  // Opps; Owner for Accounts) shown under each candidate in the card's
  // suggestion-pill dropdown.
  interface Cand { id: string; name: string; type: 'Account' | 'Opportunity'; detail?: string | null }
  const perEvent = new Map<string, Cand[]>()
  // v1.117.0: keep track of each Opp's parent Account so we can stamp
  // crmAccountId/Name onto the created activity at approve time.
  const oppParent = new Map<string, { accountId: string | null; accountName: string }>()
  for (const a of accounts) {
    const detail = a.OwnerName ? `Owner: ${a.OwnerName}` : null
    const eids = emailToEventIds.get(a.contactEmail.toLowerCase()) ?? []
    for (const eid of eids) {
      const arr = perEvent.get(eid) ?? []
      if (!arr.some((c) => c.id === a.Id)) arr.push({ id: a.Id, name: a.Name, type: 'Account', detail })
      perEvent.set(eid, arr)
    }
  }
  for (const o of opportunities) {
    oppParent.set(o.Id, { accountId: o.AccountId, accountName: o.AccountName })
    const detail = [o.StageName, o.OwnerName, o.CloseDate ? `Closes ${o.CloseDate}` : null].filter(Boolean).join(' · ') || null
    const eids = emailToEventIds.get(o.contactEmail.toLowerCase()) ?? []
    for (const eid of eids) {
      const arr = perEvent.get(eid) ?? []
      if (!arr.some((c) => c.id === o.Id)) arr.push({ id: o.Id, name: o.Name, type: 'Opportunity', detail })
      perEvent.set(eid, arr)
    }
  }

  const nowDate = new Date()
  for (const r of stale) {
    const cands = perEvent.get(r.id) ?? []
    const firstAcct = cands.find((c) => c.type === 'Account') ?? null
    const firstOpp = cands.find((c) => c.type === 'Opportunity') ?? null
    const oppAcct = firstOpp ? oppParent.get(firstOpp.id) ?? null : null
    await db.update(outlookEvents).set({
      suggestedCrmAccountId: firstAcct?.id ?? null,
      suggestedCrmAccountName: firstAcct?.name ?? null,
      suggestedCrmOpportunityId: firstOpp?.id ?? null,
      suggestedCrmOpportunityName: firstOpp?.name ?? null,
      suggestedCrmOpportunityAccountId: oppAcct?.accountId ?? null,
      suggestedCrmOpportunityAccountName: oppAcct?.accountName ?? null,
      crmSuggestionCandidates: cands,
      crmSuggestionComputedAt: nowDate,
    }).where(and(eq(outlookEvents.id, r.id), eq(outlookEvents.userId, userId)))
  }
}
