import { addDays, startOfWeek } from 'date-fns'

// v1.456.1: week navigation for the Activities page's Sun-first / Mon-first
// toggle (§8).
//
// The page keeps one canonical, Monday-anchored week (`useActivities`'
// `weekStart`) and, in Sunday-first mode, displays the Sunday before that
// Monday through the Saturday after it. So the canonical week that DISPLAYS a
// given Sunday is the one starting the day after it, not the one ending on it
// (which is where date-fns' Monday anchor puts a Sunday).
//
// Before this helper, the month calendar measured a click against
// `startOfWeek(today, Sunday)` while the page's week offset 0 was measured from
// `startOfWeek(today, Monday)`. Those two disagree only when today is a Sunday,
// so on a Sunday every click landed one week early (click the 19th, get the
// week of the 11th), and "this week" showed last week.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Monday (local midnight) of the canonical week whose displayed 7 days contain `date`. */
export function canonicalWeekStartFor(date: Date, weekStartsMonday: boolean): Date {
  const anchor = !weekStartsMonday && date.getDay() === 0 ? addDays(date, 1) : date
  return startOfWeek(anchor, { weekStartsOn: 1 })
}

/** First displayed day (Monday, or the Sunday before it) for a canonical Monday week start. */
export function displayWeekStartFor(canonicalWeekStart: Date, weekStartsMonday: boolean): Date {
  return weekStartsMonday ? canonicalWeekStart : addDays(canonicalWeekStart, -1)
}

/**
 * Week offset (relative to the week displayed for `today`) of the week that
 * displays `date`. Rounded so a DST change inside the span (23h or 25h day)
 * never shifts the result.
 */
export function weekOffsetForDate(date: Date, weekStartsMonday: boolean, today: Date = new Date()): number {
  const target = canonicalWeekStartFor(date, weekStartsMonday).getTime()
  const current = canonicalWeekStartFor(today, weekStartsMonday).getTime()
  return Math.round((target - current) / WEEK_MS)
}

/** `users.work_days` bit for a date: Monday = 1, Tuesday = 2, … Sunday = 64 (v1.456.2). */
export function workDayBit(d: Date): number {
  return 1 << ((d.getDay() + 6) % 7)
}
