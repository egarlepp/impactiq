import { startOfWeek, addWeeks, addMonths, differenceInCalendarMonths } from 'date-fns'
import { getFiscalConfig, fiscalPeriodOf, type FiscalConfig } from '../config/fiscal.js'

// v1.245.0: "how many weeks/months/quarters/years does this date range span"
// has no precedent anywhere in this codebase — every existing dashboard picks
// a window and aggregates a total over it, never divides by a period count.
// Built fresh for the Team Activity Deep-Dive dashboard's AVG Per Week/Month/
// Quarter/Year columns.
//
// This app's fiscal model (services/config/fiscal.ts) only ever shifts QUARTER
// and YEAR framing via `startMonth` — it has no concept of a "fiscal week" or
// "fiscal month" (weeks stay 7 days, months stay calendar months either way).
// So weeks/months are always calendar-counted; only quarters/years consult
// `fiscalPeriodOf()` and therefore change when Admin -> Calendars is set to
// Fiscal. Keeping all four as a DISTINCT-BUCKET count (not a fractional-days
// estimate) is deliberate: it's the same "count the periods this range
// actually touches" idea at every granularity, which is what makes the four
// columns comparable to each other and consistent with however the range was
// selected (Range dropdown, custom dates, or the FY/FQ quick-pick).
export interface PeriodCounts {
  weeks: number
  months: number
  quarters: number
  years: number
}

/**
 * Counts the distinct week/month/quarter/year buckets a [start, end] range
 * touches, in the team's configured fiscal or calendar framing. Every count is
 * floored at 1 so a caller can safely divide a total by any of these without
 * a zero-division guard.
 */
export async function countPeriodsInRange(rangeStart: Date, rangeEnd: Date): Promise<PeriodCounts> {
  const cfg = await getFiscalConfig()
  return countPeriodsInRangeWithConfig(rangeStart, rangeEnd, cfg)
}

/** Same as {@link countPeriodsInRange}, for callers that already have the config. */
export function countPeriodsInRangeWithConfig(rangeStart: Date, rangeEnd: Date, cfg: FiscalConfig): PeriodCounts {
  if (rangeEnd.getTime() < rangeStart.getTime()) return { weeks: 1, months: 1, quarters: 1, years: 1 }

  // Weeks: distinct Monday-start week buckets. Matches startOfWeek(..., {
  // weekStartsOn: 1 }) used throughout the client (WeeklyView, CalendarPanel)
  // so "a week" means the same thing on this dashboard as everywhere else.
  const weekKeys = new Set<string>()
  for (let w = startOfWeek(rangeStart, { weekStartsOn: 1 }); w.getTime() <= rangeEnd.getTime(); w = addWeeks(w, 1)) {
    weekKeys.add(w.toISOString().slice(0, 10))
  }

  // Months/quarters/years: walking month-by-month is enough (a fiscal quarter
  // never realigns mid-month in this app's {mode,startMonth,yearNaming} model),
  // and caps at ~36 iterations even for the 3-year "All time" ceiling — cheap
  // regardless of how many days the range spans.
  const monthKeys = new Set<string>()
  const quarterKeys = new Set<string>()
  const yearKeys = new Set<string>()
  const monthSpan = Math.max(0, differenceInCalendarMonths(rangeEnd, rangeStart))
  for (let i = 0; i <= monthSpan; i++) {
    const d = addMonths(rangeStart, i)
    monthKeys.add(`${d.getFullYear()}-${d.getMonth()}`)
    const fp = fiscalPeriodOf(d, cfg)
    quarterKeys.add(`${fp.year}-Q${fp.quarter}`)
    yearKeys.add(String(fp.year))
  }

  return {
    weeks: Math.max(1, weekKeys.size),
    months: Math.max(1, monthKeys.size),
    quarters: Math.max(1, quarterKeys.size),
    years: Math.max(1, yearKeys.size),
  }
}
