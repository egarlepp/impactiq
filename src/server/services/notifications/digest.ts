// Daily morning notification digest.
// Every minute the loop checks each user with email_enabled = true; when the
// user's local time has crossed 08:00 AND the last_digest_at is on a previous
// local day, it sends a digest summarizing the notifications since
// last_digest_at (or the last 24h if never sent).

import { db } from '../../db/index.js'
import { users, userNotificationPrefs, notifications, jobConfig } from '../../../../drizzle/schema.js'
import { and, eq, gt, isNull, or, desc } from 'drizzle-orm'
import { sendEmailViaConfigured, type EmailMessage } from '../email/index.js'
import { getEmailIntegrationConfig } from '../config/integrations.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { localDayKeyFor } from '../../lib/localDate.js'

const TICK_MS = 60_000
const DIGEST_HOUR = 8
const JOB_KEY = 'digest_worker'

// v1.230.0: local send-time minutes-since-midnight, so an admin-configured
// job_config.schedule_minute (Admin → Scheduling) has real effect — the
// original localHourFor() only had hour granularity.
// v1.329.0: `at` param added (defaults to now) so the next-send ETA
// estimator below can reuse this exact function against a fixed instant.
function localMinutesFor(tz: string, at: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hour12: false, timeZone: tz })
    const parts = fmt.formatToParts(at)
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    // Some locales report midnight as hour "24" with hour12: false.
    return (h % 24) * 60 + m
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes()
  }
}


// v1.329.0: pure minutes-from-now math for "when will this user's local
// clock next cross the target send time" — factored out so it's unit
// testable without a DB. `alreadyToday` means this user's last digest was
// already stamped for today (real send, or the zero-items skip-update in
// tickDigest), so today's window is spent even if the clock hasn't wrapped.
export function computeNextDigestDeltaMinutes(nowMinutes: number, targetMinutes: number, alreadyToday: boolean): number {
  const untilToday = targetMinutes - nowMinutes
  if (untilToday >= 0) return untilToday
  return alreadyToday ? untilToday + 24 * 60 : 0
}

// The real ETA, across every currently email-enabled user: the earliest
// moment any one of them will next qualify. Not a single global clock —
// see CLAUDE.md §14/§18 (v1.329) for why the digest send-window is
// evaluated per-user, in that user's own local timezone. Returns null only
// when there are no email-enabled users to check against at all.
export async function getNextDigestEtaMinutes(now: Date = new Date()): Promise<number | null> {
  let targetHour = DIGEST_HOUR
  let targetMinute = 0
  try {
    const [cfg] = await db.select().from(jobConfig).where(eq(jobConfig.jobKey, JOB_KEY)).limit(1)
    if (cfg?.scheduleHour != null) targetHour = cfg.scheduleHour
    if (cfg?.scheduleMinute != null) targetMinute = cfg.scheduleMinute
  } catch { /* fall back to defaults */ }
  const targetMinutes = targetHour * 60 + targetMinute

  const rows = await db
    .select({ timezone: userNotificationPrefs.timezone, lastDigestAt: userNotificationPrefs.lastDigestAt })
    .from(userNotificationPrefs)
    .where(eq(userNotificationPrefs.emailEnabled, true))

  let best: number | null = null
  for (const u of rows) {
    const tz = u.timezone || 'UTC'
    const todayKey = localDayKeyFor(tz, now)
    const alreadyToday = u.lastDigestAt ? localDayKeyFor(tz, u.lastDigestAt) === todayKey : false
    const delta = computeNextDigestDeltaMinutes(localMinutesFor(tz, now), targetMinutes, alreadyToday)
    if (best === null || delta < best) best = delta
  }
  return best
}

function buildDigestHtml(displayName: string, items: { message: string; createdAt: Date }[]): { html: string; text: string } {
  const escape = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c))
  const lis = items.map((n) => `<li style="margin: 0 0 8px 0;">${escape(n.message)}<br/><span style="color:#888;font-size:11px">${n.createdAt.toLocaleString()}</span></li>`).join('')
  const html = `
    <p>Hi ${escape(displayName)},</p>
    <p>You have ${items.length} new notification${items.length === 1 ? '' : 's'} from ImpactIQ since your last digest.</p>
    <ul style="padding-left: 16px;">${lis}</ul>
    <p style="color:#888;font-size:11px">You're receiving this because you have notification emails enabled. Manage in <em>My Settings → Notifications</em>.</p>
  `.trim()
  const text = `Hi ${displayName},\n\nYou have ${items.length} new notification(s) from ImpactIQ:\n\n` +
    items.map((n) => `- ${n.message} (${n.createdAt.toLocaleString()})`).join('\n') +
    `\n\nManage email notifications in My Settings → Notifications.`
  return { html, text }
}

export async function tickDigest(now: Date = new Date(), targetHour = DIGEST_HOUR, targetMinute = 0): Promise<{ sent: number }> {
  const targetMinutes = targetHour * 60 + targetMinute
  // Pull all users with email enabled.
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      transport: userNotificationPrefs.emailTransport,
      timezone: userNotificationPrefs.timezone,
      lastDigestAt: userNotificationPrefs.lastDigestAt,
    })
    .from(userNotificationPrefs)
    .innerJoin(users, eq(users.id, userNotificationPrefs.userId))
    .where(eq(userNotificationPrefs.emailEnabled, true))

  let sent = 0
  for (const u of rows) {
    try {
      if (localMinutesFor(u.timezone) < targetMinutes) continue
      const todayKey = localDayKeyFor(u.timezone, now)
      const lastKey = u.lastDigestAt ? localDayKeyFor(u.timezone, u.lastDigestAt) : null
      if (lastKey === todayKey) continue

      const since = u.lastDigestAt ?? new Date(now.getTime() - 24 * 60 * 60 * 1000)
      const items = await db
        .select({ message: notifications.message, createdAt: notifications.createdAt })
        .from(notifications)
        .where(and(eq(notifications.userId, u.userId), gt(notifications.createdAt, since)))
        .orderBy(desc(notifications.createdAt))
      if (items.length === 0) {
        // Nothing to send — still mark last_digest_at so we don't re-evaluate
        // this user every minute for the rest of the day.
        await db.update(userNotificationPrefs).set({ lastDigestAt: now }).where(eq(userNotificationPrefs.userId, u.userId))
        continue
      }
      const { html, text } = buildDigestHtml(u.displayName, items)
      const defaultSubject = `ImpactIQ — ${items.length} new notification${items.length === 1 ? '' : 's'}`
      const emailCfg = getEmailIntegrationConfig()
      const itemsList = items.map((i) => `• ${i.message}`).join('\n')
      const { sendByRule } = await import('../email/rule-sender.js')
      // v1.436.0: with no email integration the digest can still go out as a
      // Slack DM (Communications → "Also send as Slack DM"). When neither can
      // send, skip quietly as before and try again next tick.
      let result: Awaited<ReturnType<typeof sendByRule>>
      try {
        result = await sendByRule('daily_digest', {
          to: u.email,
          toName: u.displayName,
          defaultSubject,
          defaultBodyHtml: html,
          defaultBodyText: text,
          tokens: { name: u.displayName, count: items.length, itemsList },
          userId: u.userId,
        })
      } catch (err) {
        if (!emailCfg) continue
        throw err
      }
      if (!result.sent && result.reason === 'rule_inactive') {
        // Admin turned the digest off — mark last_digest_at so we don't
        // re-evaluate every minute.
        await db.update(userNotificationPrefs).set({ lastDigestAt: now }).where(eq(userNotificationPrefs.userId, u.userId))
        continue
      }
      await db.update(userNotificationPrefs).set({ lastDigestAt: now }).where(eq(userNotificationPrefs.userId, u.userId))
      console.log(`[digest] sent to ${u.email} (${items.length} items, via ${result.emailed && emailCfg ? emailCfg.authMethod : 'slack'})`)
      sent++
    } catch (err) {
      console.warn(`[digest] failed for user ${u.userId}:`, err)
    }
  }
  return { sent }
}

let stopFn: (() => void) | null = null
export function startDigestWorker(): void {
  if (stopFn) return
  // Don't tick immediately on boot — give the app a few seconds to settle.
  // scheduleJob's default firstRunDelayMs (= the interval itself) preserves
  // that.
  stopFn = scheduleJob(JOB_KEY, TICK_MS, async () => {
    const startedAt = new Date()
    try {
      // v1.230.0: admin-editable send time (Admin → Scheduling). A missing
      // row or null column falls back to the hardcoded 08:00 default.
      let targetHour = DIGEST_HOUR
      let targetMinute = 0
      try {
        const [cfg] = await db.select().from(jobConfig).where(eq(jobConfig.jobKey, JOB_KEY)).limit(1)
        if (cfg?.scheduleHour != null) targetHour = cfg.scheduleHour
        if (cfg?.scheduleMinute != null) targetMinute = cfg.scheduleMinute
      } catch { /* fall back to defaults */ }
      const { sent } = await tickDigest(startedAt, targetHour, targetMinute)
      // v1.227.0: this ticks every 60s just to check the clock — writing a
      // job_runs row on every quiet minute would drown the Recent Runs
      // table in ~1,440 no-op rows/day. Only record a run when something
      // actually happened; "Last run" then reflects the last real send,
      // which is more useful than a constantly-refreshing "checked, did
      // nothing" timestamp anyway.
      if (sent > 0) await writeRun(JOB_KEY, startedAt, 'ok', `Sent ${sent} digest email${sent === 1 ? '' : 's'}`, { sent })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await writeRun(JOB_KEY, startedAt, 'error', message, null)
    }
  })
}

export function stopDigestWorker(): void {
  stopFn?.()
  stopFn = null
}

// Suppress unused if not all imports referenced
void isNull
void or
