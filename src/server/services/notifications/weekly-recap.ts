// Friday afternoon weekly-recap email.
//
// For each user with weekly_recap_enabled = true, at 17:00 in the user's
// local timezone on Fridays, sends an HTML + plain-text summary of the
// previous work week (Mon–Fri in local TZ): total hours, capacity %,
// breakdown by activity type, top 3 opportunities by hours.
//
// The cron ticker polls every 5 minutes and de-duplicates on
// last_weekly_recap_at so restarts don't double-send.

import { db } from '../../db/index.js'
import {
  users,
  userNotificationPrefs,
  activities,
  teamMembers,
  teamActivityTypes,
  jobConfig,
} from '../../../../drizzle/schema.js'
import { and, eq, gte, lte, inArray, sql } from 'drizzle-orm'
import { sendEmailViaConfigured, type EmailMessage } from '../email/index.js'
import { resolveCapacityBatch } from '../capacity/resolver.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { localDayKeyFor } from '../../lib/localDate.js'

const TICK_MS = 5 * 60_000
const RECAP_HOUR = 17
const RECAP_DAY = 5 // Friday (0 Sun … 5 Fri)
const JOB_KEY = 'weekly_recap_worker'

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
    return (h % 24) * 60 + m
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes()
  }
}

function localDayOfWeek(tz: string, at: Date = new Date()): number {
  // Sunday-indexed to match Date#getDay in the local TZ.
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz })
    const wd = fmt.format(at).toLowerCase()
    return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wd.slice(0, 3))
  } catch { return at.getUTCDay() }
}

// v1.329.0: pure minutes-from-now math for "when will this user's local
// clock next reach the target day + time" — factored out so it's unit
// testable without a DB. `alreadyThisWeek` means this user's last recap was
// already stamped for today's local day, i.e. sent earlier on this exact
// target day (the worker only ever attempts a send on the target day of
// week, so "sent today" and "sent this week" are the same fact here).
export function computeNextWeeklyRecapDeltaMinutes(
  nowDay: number, nowMinutes: number, targetDay: number, targetMinutes: number, alreadyThisWeek: boolean,
): number {
  const daysAhead = (targetDay - nowDay + 7) % 7
  const total = daysAhead * 24 * 60 + (targetMinutes - nowMinutes)
  if (total >= 0) return total
  // Only reachable when daysAhead === 0 (today is the target day) and the
  // target time has already passed today.
  return alreadyThisWeek ? total + 7 * 24 * 60 : 0
}

// The real ETA, across every currently recap-enabled user: the earliest
// moment any one of them will next qualify. Not a single global clock — see
// CLAUDE.md §14/§18 (v1.329) for why this is evaluated per-user, in that
// user's own local timezone/day-of-week. Returns null only when there are
// no eligible users to check against at all.
export async function getNextWeeklyRecapEtaMinutes(now: Date = new Date()): Promise<number | null> {
  let targetDay = RECAP_DAY
  let targetMinutes = RECAP_HOUR * 60
  try {
    const [cfg] = await db.select().from(jobConfig).where(eq(jobConfig.jobKey, JOB_KEY)).limit(1)
    if (cfg?.scheduleDayOfWeek != null) targetDay = cfg.scheduleDayOfWeek
    if (cfg?.scheduleHour != null) targetMinutes = cfg.scheduleHour * 60 + (cfg.scheduleMinute ?? 0)
  } catch { /* fall back to defaults */ }

  const rows = await db
    .select({ timezone: userNotificationPrefs.timezone, lastAt: userNotificationPrefs.lastWeeklyRecapAt })
    .from(userNotificationPrefs)
    .where(and(eq(userNotificationPrefs.emailEnabled, true), eq(userNotificationPrefs.weeklyRecapEnabled, true)))

  let best: number | null = null
  for (const u of rows) {
    const tz = u.timezone || 'UTC'
    const todayKey = localDayKeyFor(tz, now)
    const alreadyThisWeek = u.lastAt ? localDayKeyFor(tz, new Date(u.lastAt)) === todayKey : false
    const delta = computeNextWeeklyRecapDeltaMinutes(localDayOfWeek(tz, now), localMinutesFor(tz, now), targetDay, targetMinutes, alreadyThisWeek)
    if (best === null || delta < best) best = delta
  }
  return best
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c))
}

interface RecapPayload {
  displayName: string
  weekLabel: string
  totalHours: number
  capacityHours: number
  byType: { name: string; hours: number }[]
  topOpps: { name: string; hours: number }[]
}

function renderRecap(p: RecapPayload): { html: string; text: string; subject: string } {
  const capacityPct = p.capacityHours > 0 ? Math.round((p.totalHours / p.capacityHours) * 100) : null
  const byTypeRows = p.byType.map((t) =>
    `<tr><td style="padding:4px 8px;border:1px solid #e5e7eb">${escapeHtml(t.name)}</td>` +
    `<td style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right">${t.hours.toFixed(1)}h</td></tr>`,
  ).join('')
  const topOppRows = p.topOpps.map((o) =>
    `<li>${escapeHtml(o.name)} — <b>${o.hours.toFixed(1)}h</b></li>`,
  ).join('')
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;background:#f9fafb;padding:16px;color:#111827">
      <table style="width:100%;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px" cellspacing="0" cellpadding="0">
        <tr><td style="padding:16px 20px">
          <h2 style="margin:0 0 8px 0;font-size:16px">ImpactIQ weekly recap</h2>
          <p style="margin:0 0 12px 0;color:#4b5563">Hi ${escapeHtml(p.displayName)}, here's a summary of ${escapeHtml(p.weekLabel)}.</p>
          <p style="margin:0 0 12px 0">
            <b>${p.totalHours.toFixed(1)}h</b> logged
            ${capacityPct !== null ? ` &middot; ${capacityPct}% of your ${p.capacityHours.toFixed(0)}h target` : ''}
          </p>
          ${p.byType.length ? `<p style="margin:12px 0 4px 0;font-size:13px;color:#374151"><b>By activity type</b></p>
          <table style="border-collapse:collapse;width:100%;font-size:13px">${byTypeRows}</table>` : ''}
          ${p.topOpps.length ? `<p style="margin:12px 0 4px 0;font-size:13px;color:#374151"><b>Top opportunities</b></p>
          <ol style="margin:0;padding-left:20px;font-size:13px">${topOppRows}</ol>` : ''}
        </td></tr>
      </table>
    </div>`
  const text = [
    `Weekly recap — ${p.weekLabel}`,
    `Total: ${p.totalHours.toFixed(1)}h${capacityPct !== null ? ` (${capacityPct}% of ${p.capacityHours.toFixed(0)}h target)` : ''}`,
    p.byType.length ? '\nBy activity type:' : '',
    ...p.byType.map((t) => `  ${t.name}: ${t.hours.toFixed(1)}h`),
    p.topOpps.length ? '\nTop opportunities:' : '',
    ...p.topOpps.map((o, i) => `  ${i + 1}. ${o.name} — ${o.hours.toFixed(1)}h`),
  ].filter(Boolean).join('\n')
  return { html, text, subject: `ImpactIQ weekly recap: ${p.weekLabel}` }
}

// Previous Mon–Fri window in the user's local timezone. Called on
// Friday afternoon after end-of-day so the recap covers the just-
// completed week.
function previousWorkWeek(tz: string): { start: Date; end: Date; label: string } {
  const now = new Date()
  const dow = localDayOfWeek(tz) // 0 Sun … 6 Sat
  // Monday of the current week in UTC — good enough for the SQL filter;
  // Salesforce start_datetime is stored as UTC.
  const daysBackToMon = ((dow + 6) % 7) // Mon=0, Sun=6
  const thisMon = new Date(now)
  thisMon.setUTCDate(thisMon.getUTCDate() - daysBackToMon)
  thisMon.setUTCHours(0, 0, 0, 0)
  // On Friday afternoon we want *this* week's Mon–Fri.
  const start = thisMon
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 5) // Sat 00:00 (exclusive)
  const label = `${start.toISOString().slice(0, 10)} – ${new Date(end.getTime() - 86400000).toISOString().slice(0, 10)}`
  return { start, end, label }
}

export async function sendWeeklyRecap(userId: string): Promise<{ sent: boolean; reason?: string }> {
  const [user] = await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, userId))
  if (!user) return { sent: false, reason: 'no_user' }
  const [prefs] = await db.select().from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, userId))
  const tz = prefs?.timezone ?? 'UTC'

  const { start, end, label } = previousWorkWeek(tz)

  const rows = await db
    .select({
      hours: activities.effortHours,
      activityTypeName: teamActivityTypes.name,
      crmWhatId: activities.crmWhatId,
      crmWhatName: activities.crmWhatName,
      teamId: activities.teamId,
    })
    .from(activities)
    .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .where(and(
      eq(activities.userId, userId),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      gte(activities.startDatetime, start),
      lte(activities.startDatetime, end),
    ))

  const totalHours = rows.reduce((s, r) => s + Number(r.hours), 0)
  const byTypeMap = new Map<string, number>()
  const byOppMap = new Map<string, { name: string; hours: number }>()
  for (const r of rows) {
    byTypeMap.set(r.activityTypeName, (byTypeMap.get(r.activityTypeName) ?? 0) + Number(r.hours))
    if (r.crmWhatId) {
      const cur = byOppMap.get(r.crmWhatId) ?? { name: r.crmWhatName ?? r.crmWhatId, hours: 0 }
      cur.hours += Number(r.hours)
      byOppMap.set(r.crmWhatId, cur)
    }
  }
  const byType = Array.from(byTypeMap.entries()).map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours)
  const topOpps = Array.from(byOppMap.values()).sort((a, b) => b.hours - a.hours).slice(0, 3)

  // Capacity — pick the user's first team for the resolver.
  let capacityHours = 0
  const [membership] = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)).limit(1)
  if (membership) {
    const resolved = await resolveCapacityBatch([{ userId, teamId: membership.teamId, asOf: start }])
    capacityHours = resolved.get(`${userId}::${membership.teamId}`)?.hours ?? 0
  }

  const { html, text, subject } = renderRecap({
    displayName: user.displayName ?? user.email,
    weekLabel: label,
    totalHours,
    capacityHours,
    byType,
    topOpps,
  })

  const { sendByRule } = await import('../email/rule-sender.js')
  try {
    const result = await sendByRule('weekly_recap', {
      to: user.email,
      toName: user.displayName ?? undefined,
      defaultSubject: subject,
      defaultBodyHtml: html,
      defaultBodyText: text,
      tokens: {
        name: user.displayName ?? user.email,
        weekLabel: label,
        totalHours: totalHours.toFixed(1),
        capacityHours: capacityHours.toFixed(1),
      },
      userId,
    })
    if (result.sent) {
      await db.update(userNotificationPrefs).set({ lastWeeklyRecapAt: new Date() }).where(eq(userNotificationPrefs.userId, userId))
      return { sent: true }
    }
    return { sent: false, reason: result.reason ?? 'unknown' }
  } catch (err) {
    console.warn('[weekly-recap] send failed', userId, (err as Error).message)
    return { sent: false, reason: 'send_error' }
  }
}

let stopFn: (() => void) | null = null

export function startWeeklyRecapWorker() {
  if (stopFn) return
  // Kick immediately so restarts near the send window still fire once —
  // scheduleJob's firstRunDelayMs: 0 preserves that. Note the old in-tick
  // `running` guard is no longer needed: scheduleJob's loop always awaits
  // one tick fully before arming the next, so ticks can't overlap.
  stopFn = scheduleJob(JOB_KEY, TICK_MS, async () => {
    const startedAt = new Date()
    let sent = 0
    try {
      // v1.230.0: admin-editable send day/time (Admin → Scheduling). A
      // missing row or null column falls back to the hardcoded Friday
      // 17:00 default.
      let targetDay = RECAP_DAY
      let targetMinutes = RECAP_HOUR * 60
      try {
        const [cfg] = await db.select().from(jobConfig).where(eq(jobConfig.jobKey, JOB_KEY)).limit(1)
        if (cfg?.scheduleDayOfWeek != null) targetDay = cfg.scheduleDayOfWeek
        if (cfg?.scheduleHour != null) targetMinutes = cfg.scheduleHour * 60 + (cfg.scheduleMinute ?? 0)
      } catch { /* fall back to defaults */ }
      const candidates = await db
        .select({ userId: userNotificationPrefs.userId, timezone: userNotificationPrefs.timezone, lastAt: userNotificationPrefs.lastWeeklyRecapAt })
        .from(userNotificationPrefs)
        .where(and(eq(userNotificationPrefs.emailEnabled, true), eq(userNotificationPrefs.weeklyRecapEnabled, true)))
      for (const c of candidates) {
        const tz = c.timezone || 'UTC'
        const dow = localDayOfWeek(tz)
        if (dow !== targetDay || localMinutesFor(tz) < targetMinutes) continue
        // Dedup: only send once per local day.
        const today = localDayKeyFor(tz, new Date())
        if (c.lastAt && localDayKeyFor(tz, new Date(c.lastAt)) === today) continue
        const result = await sendWeeklyRecap(c.userId)
        if (result.sent) sent++
      }
      // v1.227.0: this ticks every 5 minutes just to check for the Friday
      // send window — writing a job_runs row on every quiet tick would
      // drown the Recent Runs table in ~288 no-op rows/day for a job that
      // meaningfully does something once a week. Only record a run when
      // something actually sent.
      if (sent > 0) await writeRun(JOB_KEY, startedAt, 'ok', `Sent ${sent} weekly recap${sent === 1 ? '' : 's'}`, { sent })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[weekly-recap] tick failed', message)
      await writeRun(JOB_KEY, startedAt, 'error', message, null)
    }
  }, { firstRunDelayMs: 0 })
}

export function stopWeeklyRecapWorker(): void {
  stopFn?.()
  stopFn = null
}
