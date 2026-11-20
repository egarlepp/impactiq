// v1.292.0: shared helpers for the ways a user can stop a nudge rule from
// firing — extracted so the notification bell, the weekly-view nudge card,
// and the bottom toast all produce identical server-side state instead of
// three near-duplicate inline implementations.
import { db } from '../../db/index.js'
import { nudgeDismissals, notifications } from '../../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import { addDays } from 'date-fns'

// notifications.dedupeKey shape for a nudge row: `nudge:<ruleId>:<YYYY-MM-DD>`.
function todayDedupeKey(nudgeRuleId: string): string {
  return `nudge:${nudgeRuleId}:${new Date().toISOString().slice(0, 10)}`
}

// v1.294.0: every action below now also syncs today's notifications-table
// row for this rule, not just the nudge_dismissals row. Without this, an
// action taken from the weekly-view card or the toast (neither of which
// carries a notifications row id) only updated the CLIENT's optimistic
// cache — the bell's own row was untouched server-side, so it reappeared on
// the next poll/reload even though the rule was correctly muted. Keeping
// the underlying row in sync here means every surface agrees regardless of
// which one acted, and survives a refresh.

// "Mark read" — mutes a rule for this user until the next UTC day boundary.
// Shared by the notification bell's checkmark, the weekly-view card's
// checkmark, and the toast's checkmark; all three describe themselves
// identically ("won't remind you again today, but returns tomorrow if
// still relevant") because they now share this one implementation.
export async function muteNudgeRuleUntilNextUtcMidnight(userId: string, nudgeRuleId: string): Promise<void> {
  const endOfDay = new Date()
  endOfDay.setUTCHours(24, 0, 0, 0)
  try {
    await db.insert(nudgeDismissals).values({ userId, nudgeRuleId, dismissedAt: new Date(), expiresAt: endOfDay })
    await db.update(notifications).set({ isRead: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.dedupeKey, todayDedupeKey(nudgeRuleId))))
  } catch (err) {
    console.warn('[nudge-mark-read] failed:', err instanceof Error ? err.message : String(err))
  }
}

// "Snooze" — mutes a rule for this user for `days` days. Shared by the
// bell's snooze menu, the weekly-view card's snooze menu, and the toast's
// snooze menu.
export async function snoozeNudgeRuleForDays(userId: string, nudgeRuleId: string, days: number): Promise<void> {
  try {
    const now = new Date()
    await db.insert(nudgeDismissals).values({ userId, nudgeRuleId, dismissedAt: now, expiresAt: addDays(now, days) })
    await db.delete(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.dedupeKey, todayDedupeKey(nudgeRuleId))))
  } catch (err) {
    console.warn('[nudge-snooze] failed:', err instanceof Error ? err.message : String(err))
  }
}

// "Close out" — permanently stops a rule for this user (expiresAt = NULL,
// never re-fires until an admin clears the row). v1.292.0: the notification
// bell's X is the ONLY surface wired to this — the weekly-view card and the
// toast deliberately only offer Mark read + Snooze, so a contributor can't
// permanently silence a reminder from a quick-glance surface by mistake.
export async function closeOutNudgeRuleForever(userId: string, nudgeRuleId: string): Promise<void> {
  try {
    await db.insert(nudgeDismissals).values({ userId, nudgeRuleId, dismissedAt: new Date(), expiresAt: null })
    await db.delete(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.dedupeKey, todayDedupeKey(nudgeRuleId))))
  } catch (err) {
    console.warn('[nudge-close-out] failed:', err instanceof Error ? err.message : String(err))
  }
}
