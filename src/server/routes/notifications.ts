import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { db } from '../db/index.js'
import { notifications, teamMembers, userNotificationPrefs, users, activities, nudgeRules } from '../../../drizzle/schema.js'
import { z } from 'zod'
import { and, eq, desc, sql, inArray, or } from 'drizzle-orm'
import { syncNudgeNotifications } from '../services/nudge/sync.js'
import { getSlackConfigSummary } from '../services/slack/client.js'
import { muteNudgeRuleUntilNextUtcMidnight, closeOutNudgeRuleForever } from '../services/nudge/dismissals.js'
import { getActiveAnnouncementsForUser, dismissAnnouncementForUser } from '../services/announcements/engine.js'

export const notificationsRouter = Router()

notificationsRouter.use(requireAuth)

// When a nudge bell-notification is read, mute the underlying rule until the
// next UTC midnight so the Weekly-view banner + bottom toast (which come from
// evaluateNudges + nudge_dismissals, not the notifications table) also clear
// for the rest of the day. Best-effort — never fails the read action.
// dedupeKey shape: `nudge:<ruleId>:<YYYY-MM-DD>`.
async function suppressNudgeForDay(userId: string, kind: string | null, dedupeKey: string | null): Promise<void> {
  if (kind !== 'nudge' || !dedupeKey) return
  const ruleId = dedupeKey.split(':')[1]
  if (!ruleId) return
  await muteNudgeRuleUntilNextUtcMidnight(userId, ruleId)
}

// v1.292.0: the bell's X permanently closes out a nudge rule for this user —
// the ONLY surface in the app that can do this (weekly-view card and the
// toast only offer Mark read + Snooze). No-op for non-nudge notification
// kinds, which are deleted with no rule to mute.
async function closeOutNudgeForDedupeKey(userId: string, kind: string | null, dedupeKey: string | null): Promise<void> {
  if (kind !== 'nudge' || !dedupeKey) return
  const ruleId = dedupeKey.split(':')[1]
  if (!ruleId) return
  await closeOutNudgeRuleForever(userId, ruleId)
}

// The bell's X on an announcement row always just records "dismissed as of
// today" — whether that suppresses it for the rest of today or forever is
// decided entirely by getActiveAnnouncementsForUser()'s own read-time
// filter (announcements.recurringDaily), not here. No-op for any other kind.
// dedupeKey shape: `announcement:<announcementId>:<YYYY-MM-DD>`.
async function dismissAnnouncementForDedupeKey(userId: string, kind: string | null, dedupeKey: string | null): Promise<void> {
  if (kind !== 'announcement' || !dedupeKey) return
  const announcementId = dedupeKey.split(':')[1]
  if (!announcementId) return
  await dismissAnnouncementForUser(userId, announcementId)
}

// Pulls the viewer's currently-active Announcements and upserts them as
// notifications with kind='announcement' — deliberately NOT teamId-scoped
// (unlike syncNudgeNotifications above), since an announcement addressed to
// your team/subteam/you personally should show regardless of which team tab
// happens to be selected in the header switcher right now.
// dedupeKey is per-(announcement, viewer-local-day), so a genuinely new
// viewer-local day always inserts a fresh (unread) row — same mechanism
// nudges already use, just keyed to the viewer's own timezone rather than
// UTC. No Slack/email delivery for v1 — in-app banner + bell only.
// Exported for pglite testability (same convention as buildSfRecord()/
// validateOne()) — see notifications.announcementSync.test.ts, which guards
// both the "deleted/deactivated/re-dated announcement's notification row
// never disappears" regression AND the "same announcement piles up one row
// per day it stays active" duplicate-banner regression this cleanup step
// exists to fix.
export async function syncAnnouncementNotifications(userId: string): Promise<void> {
  const { todayLocalKey, items } = await getActiveAnnouncementsForUser(userId)
  const currentDedupeKeys = new Set<string>()
  for (const a of items) {
    const dedupeKey = `announcement:${a.id}:${todayLocalKey}`
    currentDedupeKeys.add(dedupeKey)
    await db
      .insert(notifications)
      .values({
        userId,
        kind: 'announcement',
        message: a.message,
        dedupeKey,
        isRead: false,
        severity: a.severity,
        icon: a.icon,
        iconColorLight: a.iconColorLight,
        iconColorDark: a.iconColorDark,
      })
      .onConflictDoUpdate({
        target: [notifications.userId, notifications.dedupeKey],
        targetWhere: sql`dedupe_key IS NOT NULL`,
        set: { message: a.message, severity: a.severity, icon: a.icon, iconColorLight: a.iconColorLight, iconColorDark: a.iconColorDark },
      })
  }
  // Self-healing cleanup: every one of this user's 'announcement' rows whose
  // dedupeKey isn't one of TODAY's just-upserted keys is stale and removed.
  // This covers two distinct cases with one check: (1) the announcement is
  // no longer active at all (deleted/deactivated/retargeted/out of date
  // range) — the dismiss action was never responsible for that, it only
  // ever marks *today's* instance handled; and (2) — the bug found live,
  // reported as a duplicate banner — an announcement that's STILL active on
  // consecutive days. Each sync mints a fresh per-day dedupeKey so a
  // genuinely new day (or a reappearing recurring announcement) always gets
  // an unread row, but a row for a PREVIOUS day of the SAME still-active
  // announcement is not "gone," so the old id-only check (`is this
  // announcement id still active?`) never caught it — yesterday's row and
  // today's row both had an active announcementId and both survived,
  // rendering as two identical banners. Comparing against the exact set of
  // dedupeKeys just written this sync (not just the announcement id) closes
  // both gaps with the same, simpler check.
  const existing = await db
    .select({ id: notifications.id, dedupeKey: notifications.dedupeKey })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, 'announcement')))
  const staleIds = existing
    .filter((n) => !n.dedupeKey || !currentDedupeKeys.has(n.dedupeKey))
    .map((n) => n.id)
  if (staleIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.id, staleIds))
  }
}

// The rows a team-scoped bell shows: that team's nudges plus every
// announcement (announcement rows carry team_id = NULL, see the GET below).
// `teamId` null is the "All Teams" selection, which shows everything.
function bellScope(userId: string, teamId: string | null) {
  return teamId
    ? and(eq(notifications.userId, userId), or(eq(notifications.teamId, teamId), eq(notifications.kind, 'announcement')))
    : eq(notifications.userId, userId)
}

// v1.426.0: the bell's "Clear all". Deletes every row the bell is currently
// showing (same team scope as the GET and read-all), and stops the two
// self-re-syncing kinds from reappearing on the next 60s poll:
// - a nudge row for TODAY is muted until the next UTC midnight, the same
//   rule-level mute "Mark read" uses. Deliberately NOT the bell X's permanent
//   close-out: clearing the list must never silence a rule forever.
// - an announcement is dismissed for this user, exactly as its own X does.
// Older-day nudge rows are never re-synced, so deleting them is enough.
// Exported for pglite testability (notifications.clearAll.test.ts).
export async function clearNotificationsForUser(userId: string, teamId: string | null): Promise<number> {
  const scope = bellScope(userId, teamId)
  const rows = await db.select({ kind: notifications.kind, dedupeKey: notifications.dedupeKey }).from(notifications).where(scope)
  const todayKey = new Date().toISOString().slice(0, 10)
  const ruleIds = new Set<string>()
  const announcementIds = new Set<string>()
  for (const r of rows) {
    const [prefix, id, day] = (r.dedupeKey ?? '').split(':')
    if (!id) continue
    if (r.kind === 'nudge' && prefix === 'nudge' && day === todayKey) ruleIds.add(id)
    if (r.kind === 'announcement' && prefix === 'announcement') announcementIds.add(id)
  }
  for (const ruleId of ruleIds) await muteNudgeRuleUntilNextUtcMidnight(userId, ruleId)
  for (const announcementId of announcementIds) await dismissAnnouncementForUser(userId, announcementId)
  await db.delete(notifications).where(scope)
  return rows.length
}

// GET /api/notifications — list recent (50) for the current user.
// Also opportunistically syncs nudges from the user's current team if teamId provided.
notificationsRouter.get('/', async (req, res) => {
  const userId = req.user!.id
  const teamId = (req.query['teamId'] as string | undefined) ?? null
  let syncStatus: { ok: number; failed: number } = { ok: 0, failed: 0 }
  try {
    syncStatus = await syncNudgeNotifications(userId, teamId)
  } catch (err) {
    // Only the outer call itself (e.g. team-membership lookup) can throw
    // now — per-team errors are already caught inside. Log and mark all
    // teams as failed so the client sees a warning chip.
    // eslint-disable-next-line no-console
    console.warn('[nudge-sync] outer failure:', err instanceof Error ? err.message : err)
    syncStatus = { ok: 0, failed: 1 }
  }
  try {
    await syncAnnouncementNotifications(userId)
  } catch (err) {
    // Independent try/catch — an announcement-sync failure must never blank
    // the nudge rows already fetched above (same "one detector's failure
    // never blanks the others" principle as the anomaly panel).
    // eslint-disable-next-line no-console
    console.warn('[announcement-sync] failed:', err instanceof Error ? err.message : err)
  }
  // v1.234.0: the sync above (and the Weekly-view banner's own
  // /api/nudges?teamId=... call) is correctly team-scoped, but this read
  // query wasn't — it returned every notification the user ever
  // accumulated across every team, so the bell + bottom toast kept
  // showing a nudge from a team the sidebar had already switched away
  // from. `teamId` is null only for the "All Teams" selection, where
  // showing every team's notifications together is intentional (see the
  // sync function's comment above); a specific team scopes the read the
  // same way it already scopes the sync.
  // vNext: an announcement row always has team_id = NULL (its targeting is
  // resolved independently of the header's team switcher — see
  // syncAnnouncementNotifications above), so a plain team_id equality check
  // would silently exclude every announcement whenever a specific team is
  // selected. OR in kind='announcement' so those always survive the filter.
  const baseRows = await db
    .select()
    .from(notifications)
    .where(bellScope(userId, teamId))
    .orderBy(desc(notifications.createdAt))
    .limit(50)
  // v1.426.0: the bell's "By category" view groups nudges by the rule that
  // raised them, so each nudge row carries its rule's current admin-set name
  // (null for a deleted rule or a non-nudge row; the client falls back to a
  // generic label). The rule id is the middle segment of the dedupeKey.
  const ruleIds = [...new Set(baseRows
    .filter((r) => r.kind === 'nudge' && r.dedupeKey?.startsWith('nudge:'))
    .map((r) => r.dedupeKey!.split(':')[1])
    .filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))]
  const ruleNames = new Map<string, string>()
  if (ruleIds.length > 0) {
    try {
      const named = await db.select({ id: nudgeRules.id, name: nudgeRules.name }).from(nudgeRules).where(inArray(nudgeRules.id, ruleIds))
      for (const r of named) ruleNames.set(r.id, r.name)
    } catch {
      // Non-fatal: rows still render, just under the generic category label.
    }
  }
  const rows = baseRows.map((r) => ({
    ...r,
    categoryName: r.kind === 'nudge' && r.dedupeKey ? ruleNames.get(r.dedupeKey.split(':')[1] ?? '') ?? null : null,
  }))
  const unreadCount = rows.filter((r) => !r.isRead).length
  // v1.242.0: approved activities whose Outlook event was deleted, awaiting a
  // Keep/Delete decision. Deliberately NOT team-scoped like the rows above —
  // the user asked for an all-weeks, whole-account count, and this is a
  // per-user data-integrity signal rather than a team-configured nudge. Rides
  // on this response's meta the same way syncFailedCount already does, so the
  // bell doesn't need another poll.
  let outlookDeletedCount = 0
  try {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(activities)
      .where(and(
        eq(activities.userId, userId),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        eq(activities.outlookDeletedKept, false),
        sql`${activities.outlookDeletedAt} IS NOT NULL`,
      ))
    outlookDeletedCount = row?.c ?? 0
  } catch {
    // Non-fatal: a count failure must not take the whole bell down.
  }
  res.json({
    data: { items: rows, unreadCount },
    error: null,
    meta: { syncFailedCount: syncStatus.failed, syncOkCount: syncStatus.ok, outlookDeletedCount },
  })
})

// PATCH /api/notifications/:id/read — mark a single notification read.
notificationsRouter.patch('/:id/read', async (req, res) => {
  const { id } = req.params as { id: string }
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id)))
  // A nudge lives in two places: the bell notification (read state above) and
  // the Weekly-view banner / bottom toast, which derive from evaluateNudges +
  // nudge_dismissals. Reading the bell item should also clear those for the
  // rest of the day, so suppress the rule until the next UTC day boundary
  // (matching the per-day dedupeKey). It re-alerts tomorrow if still relevant.
  const [row] = await db.select({ kind: notifications.kind, dedupeKey: notifications.dedupeKey }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id))).limit(1)
  await suppressNudgeForDay(req.user!.id, row?.kind ?? null, row?.dedupeKey ?? null)
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// POST /api/notifications/read-all — mark unread notifications read for this
// user. v1.234.0: scoped to the currently-active team when one is provided
// (matching the GET / read fix above) — otherwise "Mark all read" from
// inside one team's bell would silently also clear a nudge sitting unread
// in a team the user isn't even looking at. `teamId` omitted/null (the "All
// Teams" selection) keeps the previous everything-at-once behavior.
notificationsRouter.post('/read-all', async (req, res) => {
  const teamId = (req.body as { teamId?: string } | undefined)?.teamId ?? null
  // vNext: same team_id=NULL-on-announcement-rows caveat as the GET / read
  // above — OR in kind='announcement' so a team-scoped "mark all read" still
  // clears announcements, which are never team_id-tagged.
  const scope = teamId
    ? and(eq(notifications.userId, req.user!.id), eq(notifications.isRead, false), or(eq(notifications.teamId, teamId), eq(notifications.kind, 'announcement')))
    : and(eq(notifications.userId, req.user!.id), eq(notifications.isRead, false))
  const unread = await db.select({ kind: notifications.kind, dedupeKey: notifications.dedupeKey }).from(notifications).where(scope)
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(scope)
  for (const r of unread) await suppressNudgeForDay(req.user!.id, r.kind, r.dedupeKey)
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// POST /api/notifications/clear-all — v1.426.0, the bell's "Clear all"
// (confirmed in the panel first). Same optional teamId scope as read-all.
// See clearNotificationsForUser above for why nudges are muted for the day
// rather than closed out.
notificationsRouter.post('/clear-all', async (req, res) => {
  const parsed = z.object({ teamId: z.string().uuid().nullish() }).safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const cleared = await clearNotificationsForUser(req.user!.id, parsed.data.teamId ?? null)
  res.json({ data: { ok: true, cleared }, error: null, meta: {} })
})

// DELETE /api/notifications/:id
// v1.290.0: for a kind='nudge' row this used to just delete the notification
// with no rule-level mute — since syncNudgeNotifications re-evaluates and
// re-upserts on every poll (every 60s, and on every page load), a dismissed
// nudge whose trigger still held simply reappeared moments later.
// v1.292.0: for a nudge, "Dismiss" (the bell's X) is the app's one permanent
// close-out surface — it now closes the rule out forever rather than just
// muting it for the rest of the day (that "mark read" semantic moved to a
// dedicated checkmark, matching the weekly-view card and the toast).
// closeOutNudgeForDedupeKey is a no-op for non-nudge kinds, so this is safe
// to call unconditionally.
notificationsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params as { id: string }
  const [row] = await db.select({ kind: notifications.kind, dedupeKey: notifications.dedupeKey }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id))).limit(1)
  await db
    .delete(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id)))
  await closeOutNudgeForDedupeKey(req.user!.id, row?.kind ?? null, row?.dedupeKey ?? null)
  await dismissAnnouncementForDedupeKey(req.user!.id, row?.kind ?? null, row?.dedupeKey ?? null)
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// GET /api/notifications/prefs — current user's email digest preferences
notificationsRouter.get('/prefs', async (req, res) => {
  const userId = req.user!.id
  const [row] = await db.select().from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, userId)).limit(1)
  // v1.433.0: whether a Slack DM could reach this user at all (workspace
  // bot connected, their Slack account linked), so My Settings only offers
  // the Slack DM switch when it would do something.
  const [{ configured: slackConfigured }, [me]] = await Promise.all([
    getSlackConfigSummary(),
    db.select({ slackUserId: users.slackUserId }).from(users).where(eq(users.id, userId)).limit(1),
  ])
  res.json({
    data: row ?? { userId, emailEnabled: true, emailTransport: 'graph', timezone: 'UTC', lastDigestAt: null, weeklyRecapEnabled: true, slackDmEnabled: true },
    error: null,
    meta: { slackConfigured, slackLinked: !!me?.slackUserId },
  })
})

// PUT /api/notifications/prefs — upsert the current user's email digest prefs
notificationsRouter.put('/prefs', async (req, res) => {
  const userId = req.user!.id
  const schema = z.object({
    emailEnabled: z.boolean(),
    emailTransport: z.enum(['graph', 'smtp']),
    timezone: z.string().min(1),
    weeklyRecapEnabled: z.boolean().optional(),
    slackDmEnabled: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const existing = await db.select({ userId: userNotificationPrefs.userId }).from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, userId)).limit(1)
  if (existing.length > 0) {
    await db.update(userNotificationPrefs).set({ ...parsed.data, updatedAt: new Date() }).where(eq(userNotificationPrefs.userId, userId))
  } else {
    await db.insert(userNotificationPrefs).values({ userId, ...parsed.data })
  }
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// Suppress unused import warnings without dropping the import (sql may be used later).
void sql
