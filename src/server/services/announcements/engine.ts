// Resolves which Announcements (Admin -> Workplace) are currently active for
// a given viewer, and records a viewer's dismissal. See CLAUDE.md §14 for
// the full write-up.
//
// No scheduled job here on purpose — like isMaintenanceWindowDue() and
// evaluateNudges()'s own dismissal filter, "is this within its date range,
// and not currently dismissed" is a pure read-time comparison, computed
// fresh on every /api/notifications poll. A background job is only
// warranted when something must proactively ACT at a moment nobody is
// polling (e.g. restartScheduler.ts killing the process) — not the case
// for a display/dismiss feature like this one.
import { db } from '../../db/index.js'
import { announcements, announcementDismissals, users, teamMembers, subteamUsers } from '../../../../drizzle/schema.js'
import { and, eq, or, inArray, sql } from 'drizzle-orm'
import { localDayKeyFor } from '../../lib/localDate.js'

export interface ActiveAnnouncement {
  id: string
  message: string
  severity: string
  // Custom header-banner-only icon + light/dark colors — null when unset,
  // in which case the banner falls back to the plain severity icon/color.
  // Never rendered by the bell or the bottom toast — see notifications.tsx.
  icon: string | null
  iconColorLight: string | null
  iconColorDark: string | null
}

export interface ActiveAnnouncementsResult {
  // The viewer's own local calendar day (YYYY-MM-DD) used to resolve the
  // items below — callers building a per-day dedupe key (see
  // routes/notifications.ts) reuse this instead of re-resolving the
  // viewer's timezone a second time.
  todayLocalKey: string
  items: ActiveAnnouncement[]
}

async function resolveUserContext(userId: string): Promise<{ timezone: string; teamIds: string[]; subteamIds: string[] }> {
  const [user, memberships, subteamRows] = await Promise.all([
    db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)),
    db.select({ subteamId: subteamUsers.subteamId }).from(subteamUsers).where(eq(subteamUsers.userId, userId)),
  ])
  return {
    timezone: user[0]?.timezone ?? 'UTC',
    teamIds: memberships.map((m) => m.teamId),
    subteamIds: subteamRows.map((s) => s.subteamId),
  }
}

// Every announcement targeted at this viewer (team/subteam/user match) whose
// [startDate, endDate] window covers the viewer's own local "today", minus
// whatever they've already dismissed — permanently for a non-recurring
// announcement, or just for today's local date for a recurring one. Mirrors
// evaluateNudges()'s own dismissal filter (nudge_dismissals, `expiresAt IS
// NULL OR expiresAt >= now()`), adapted to day-key equality since the reset
// unit here is a viewer-local calendar day, not an arbitrary instant.
export async function getActiveAnnouncementsForUser(userId: string): Promise<ActiveAnnouncementsResult> {
  const { timezone, teamIds, subteamIds } = await resolveUserContext(userId)
  const todayLocalKey = localDayKeyFor(timezone, new Date())

  // A user-targeted announcement is always a candidate regardless of team/
  // subteam membership, so there is no cheap early-return here — every
  // viewer needs at least the `targetType='user'` branch evaluated.
  const targetConds = []
  if (teamIds.length > 0) targetConds.push(and(eq(announcements.targetType, 'team'), inArray(announcements.teamId, teamIds)))
  if (subteamIds.length > 0) targetConds.push(and(eq(announcements.targetType, 'subteam'), inArray(announcements.subteamId, subteamIds)))
  targetConds.push(and(eq(announcements.targetType, 'user'), eq(announcements.targetUserId, userId)))

  const candidates = await db
    .select({
      id: announcements.id,
      message: announcements.message,
      severity: announcements.severity,
      icon: announcements.icon,
      iconColorLight: announcements.iconColorLight,
      iconColorDark: announcements.iconColorDark,
      recurringDaily: announcements.recurringDaily,
    })
    .from(announcements)
    .where(and(
      eq(announcements.isActive, true),
      sql`${announcements.startDate} <= ${todayLocalKey}::date`,
      or(sql`${announcements.endDate} IS NULL`, sql`${announcements.endDate} >= ${todayLocalKey}::date`),
      or(...targetConds),
    ))

  if (candidates.length === 0) return { todayLocalKey, items: [] }

  const dismissalRows = await db
    .select({ announcementId: announcementDismissals.announcementId, dismissedLocalDate: announcementDismissals.dismissedLocalDate })
    .from(announcementDismissals)
    .where(and(eq(announcementDismissals.userId, userId), inArray(announcementDismissals.announcementId, candidates.map((c) => c.id))))
  const dismissalByAnnouncementId = new Map(dismissalRows.map((d) => [d.announcementId, d.dismissedLocalDate]))

  const items = candidates
    .filter((c) => {
      const dismissedLocalDate = dismissalByAnnouncementId.get(c.id)
      if (!dismissedLocalDate) return true
      if (!c.recurringDaily) return false
      return dismissedLocalDate !== todayLocalKey
    })
    .map((c) => ({ id: c.id, message: c.message, severity: c.severity, icon: c.icon, iconColorLight: c.iconColorLight, iconColorDark: c.iconColorDark }))
  return { todayLocalKey, items }
}

// Always just records "today, in the viewer's own timezone" — no branching
// on recurringDaily here. That branching lives entirely in the read-side
// filter above, so an admin flipping recurringDaily after the fact
// immediately changes behavior for every existing dismissal, with no data
// migration needed.
export async function dismissAnnouncementForUser(userId: string, announcementId: string): Promise<void> {
  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1)
  const todayLocalKey = localDayKeyFor(user?.timezone ?? 'UTC', new Date())
  await db
    .insert(announcementDismissals)
    .values({ userId, announcementId, dismissedAt: new Date(), dismissedLocalDate: todayLocalKey })
    .onConflictDoUpdate({
      target: [announcementDismissals.userId, announcementDismissals.announcementId],
      set: { dismissedAt: new Date(), dismissedLocalDate: todayLocalKey },
    })
}
