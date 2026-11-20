import { db } from '../../db/index.js'
import { users, teamMembers } from '../../../../drizzle/schema.js'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { syncNudgeNotifications } from './sync.js'
import { sendDueAnnouncementsToSlack } from '../slack/announcements.js'
import { DEMO_OKTA_PREFIX } from '../demo/generator.js'

// v1.433.0: notification_sweep. Before this, nudges were only evaluated by
// the bell's own poll (GET /api/notifications), so Slack, email and the
// nudge.sent webhook only ever fired for someone who had the app open. The
// people a "nothing logged in 5 days" nudge exists for are exactly the ones
// who don't. This job runs the same syncNudgeNotifications() for every
// active user, so delivery no longer waits on a login; the per-rule, per-day
// dedupe in that function keeps the poll and the sweep from sending twice.
//
// Only during the user's own working hours (Monday to Friday, 08:00 to
// 18:00 in users.timezone), so a DM or email never lands at 3am or on a
// Sunday. The bell's poll still evaluates whenever the user is in the app.
//
// It also sends due announcements to Slack (services/slack/announcements.ts).

export const NOTIFICATION_SWEEP_JOB_KEY = 'notification_sweep'
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
const WORK_START_HOUR = 8
const WORK_END_HOUR = 18

// Pure, exported for tests. An unknown timezone falls back to UTC.
export function isWithinLocalWorkHours(timezone: string, at: Date = new Date()): boolean {
  let weekday: string
  let hour: number
  try {
    const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', hour12: false, timeZone: timezone }).formatToParts(at)
    weekday = parts.find((p) => p.type === 'weekday')?.value ?? ''
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  } catch {
    weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getUTCDay()] ?? ''
    hour = at.getUTCHours()
  }
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR
}

export interface NotificationSweepResult {
  usersChecked: number
  nudgesDelivered: number
  failedTeams: number
  announcementsSent: number
}

export async function runNotificationSweep(now: Date = new Date()): Promise<NotificationSweepResult> {
  const announcementResult = await sendDueAnnouncementsToSlack(now)
  // Active users with at least one team. Disabled accounts get nothing, and
  // neither do Demo Data's generated people (their addresses aren't real).
  const rows = await db
    .selectDistinct({ id: users.id, timezone: users.timezone })
    .from(users)
    .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
    .where(and(isNull(users.disabledAt), sql`coalesce(${users.oktaId}, '') NOT LIKE ${DEMO_OKTA_PREFIX + '%'}`))
  let usersChecked = 0
  let nudgesDelivered = 0
  let failedTeams = 0
  for (const u of rows) {
    if (!isWithinLocalWorkHours(u.timezone ?? 'UTC', now)) continue
    usersChecked += 1
    try {
      const r = await syncNudgeNotifications(u.id, null)
      nudgesDelivered += r.delivered
      failedTeams += r.failed
    } catch (err) {
      failedTeams += 1
      console.warn('[notification-sweep] user failed:', err instanceof Error ? err.message : String(err))
    }
  }
  return { usersChecked, nudgesDelivered, failedTeams, announcementsSent: announcementResult.announcements }
}

let stopFn: (() => void) | null = null

export function startNotificationSweep(): void {
  if (stopFn) return
  stopFn = scheduleJob(NOTIFICATION_SWEEP_JOB_KEY, DEFAULT_INTERVAL_MS, async () => {
    const startedAt = new Date()
    try {
      const r = await runNotificationSweep(startedAt)
      // Quiet-tick rule (CLAUDE.md §14): a run row only when something was
      // sent or something failed.
      if (r.nudgesDelivered > 0 || r.announcementsSent > 0 || r.failedTeams > 0) {
        await writeRun(
          NOTIFICATION_SWEEP_JOB_KEY,
          startedAt,
          'ok',
          `Nudges delivered ${r.nudgesDelivered}, announcements sent to Slack ${r.announcementsSent}, users checked ${r.usersChecked}, failed teams ${r.failedTeams}`,
          { ...r },
        )
      }
    } catch (err) {
      await writeRun(NOTIFICATION_SWEEP_JOB_KEY, startedAt, 'error', err instanceof Error ? err.message : String(err), null)
    }
  }, { firstRunDelayMs: 5 * 60 * 1000 })
}

export function stopNotificationSweep(): void {
  stopFn?.()
  stopFn = null
}
