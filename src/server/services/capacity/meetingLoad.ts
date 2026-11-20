// v1.225.0: calendar-derived capacity (CLAUDE.md §12).
//
// Shared between src/server/routes/dashboards.ts (the "Meeting Load" figure
// shown alongside logged/target hours) and resolver.ts (the calendar_derived
// capacity_method's trailing-average target). Lives here rather than in
// dashboards.ts so resolver.ts never has to import from a routes file.
//
// This measures MEETING LOAD, not availability. An empty calendar is not
// free time — it just means no meetings were scheduled. Every caller-facing
// label/tooltip for this number must say so; see CLAUDE.md §12.

import { and, eq, gte, inArray, isNotNull, lte, or } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, outlookEvents } from '../../../../drizzle/schema.js'
// v1.309.0: isRealMeetingLoad() moved to src/shared so WeeklyView.tsx's own
// "other meetings" math can import the exact same predicate instead of a
// hand-duplicated copy — see CLAUDE.md §12.1. Re-exported here so every
// existing import of `isRealMeetingLoad` from this file keeps working.
import { isRealMeetingLoad } from '../../../shared/meetingLoad.js'
export { isRealMeetingLoad } from '../../../shared/meetingLoad.js'

function mondayIsoUtc(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const dow = d.getUTCDay()
  const monShift = dow === 0 ? -6 : 1 - dow
  d.setUTCDate(d.getUTCDate() + monShift)
  return d.toISOString().slice(0, 10)
}

/**
 * Per-user, per-ISO-week real meeting-load hours in [rangeStart, rangeEnd] —
 * the corrected sibling of `nonActivityHoursByUserWeek` in dashboards.ts.
 * That function deliberately stays as-is (it feeds the existing "Other
 * meetings" ambient context); this one applies `isRealMeetingLoad` on top,
 * for callers that need the more accurate figure. Two numbers, two jobs.
 *
 * Same "already logged as an activity" exclusion as `nonActivityHoursByUserWeek`
 * — a meeting the contributor logged shouldn't double as both an activity
 * hour and meeting-load noise.
 */
export async function realMeetingLoadHoursByUserWeek(
  userIds: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Record<string, Record<string, number>>> {
  if (userIds.length === 0) return {}
  const events = await db
    .select({
      id: outlookEvents.id,
      userId: outlookEvents.userId,
      start: outlookEvents.startDatetime,
      end: outlookEvents.endDatetime,
      isAllDay: outlookEvents.isAllDay,
      isCancelled: outlookEvents.isCancelled,
      showAs: outlookEvents.showAs,
      responseStatus: outlookEvents.responseStatus,
    })
    .from(outlookEvents)
    .where(and(
      inArray(outlookEvents.userId, userIds),
      eq(outlookEvents.isAllDay, false),
      gte(outlookEvents.startDatetime, rangeStart),
      lte(outlookEvents.startDatetime, rangeEnd),
    ))
  if (events.length === 0) return {}

  const logged = await db
    .select({ a: activities.outlookEventId, b: activities.outlookWritebackEventId })
    .from(activities)
    .where(and(
      inArray(activities.userId, userIds),
      eq(activities.isArchived, false),
      or(isNotNull(activities.outlookEventId), isNotNull(activities.outlookWritebackEventId)),
    ))
  const loggedIds = new Set<string>()
  for (const r of logged) { if (r.a) loggedIds.add(r.a); if (r.b) loggedIds.add(r.b) }

  const out: Record<string, Record<string, number>> = {}
  for (const e of events) {
    if (loggedIds.has(e.id)) continue
    if (!isRealMeetingLoad(e)) continue
    const hrs = (e.end.getTime() - e.start.getTime()) / 3_600_000
    if (!(hrs > 0)) continue
    const weekIso = mondayIsoUtc(e.start.toISOString().slice(0, 10))
    out[e.userId] ??= {}
    out[e.userId]![weekIso] = (out[e.userId]![weekIso] ?? 0) + hrs
  }
  return out
}

export interface TrailingMeetingLoad {
  /** Average real-meeting-load hours/week over the weeks that had any. */
  averageHours: number
  /** How many of the trailing weeks had at least one qualifying event. */
  weeksWithData: number
}

// Matches the anomaly detector's own baseline constants (BASELINE_WEEKS /
// MIN_BASELINE_WEEKS in src/server/services/dashboards/anomalies.ts) so
// "baseline" means the same trailing window everywhere in the app, not a
// second independently-tuned number.
export const CALENDAR_DERIVED_TRAILING_WEEKS = 8
export const CALENDAR_DERIVED_MIN_WEEKS = 4

/**
 * Trailing-average real meeting load per user, for the `calendar_derived`
 * capacity_method. One batched query for every user sharing the same `asOf`.
 *
 * The window ends at the START of asOf's own ISO week (exclusive) — the
 * current, possibly still-in-progress week is never part of the average, so
 * a partial week never skews the baseline down.
 *
 * A week with zero qualifying events looks identical here to a week with no
 * calendar data at all (both produce no entry in the underlying per-week
 * map) — `weeksWithData` is therefore a conservative lower bound on actual
 * connected weeks, not an exact count. That's the safe direction: it can
 * only make this method fall back to the group floor more readily, never
 * extrapolate confidently from sparse data.
 */
export async function trailingRealMeetingLoad(
  userIds: string[],
  asOf: Date,
  weeks: number = CALENDAR_DERIVED_TRAILING_WEEKS,
): Promise<Map<string, TrailingMeetingLoad>> {
  const out = new Map<string, TrailingMeetingLoad>()
  if (userIds.length === 0) return out

  const asOfMondayIso = mondayIsoUtc(asOf.toISOString().slice(0, 10))
  const rangeEnd = new Date(`${asOfMondayIso}T00:00:00Z`)
  const rangeStart = new Date(rangeEnd.getTime() - weeks * 7 * 86_400_000)

  const byUserWeek = await realMeetingLoadHoursByUserWeek(userIds, rangeStart, rangeEnd)
  for (const userId of userIds) {
    const weekMap = byUserWeek[userId] ?? {}
    const values = Object.values(weekMap)
    const weeksWithData = values.length
    const averageHours = weeksWithData > 0 ? values.reduce((a, b) => a + b, 0) / weeksWithData : 0
    out.set(userId, { averageHours, weeksWithData })
  }
  return out
}
