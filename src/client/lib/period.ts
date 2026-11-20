import { addDays, addMonths, addQuarters, addYears, startOfWeek, startOfMonth, startOfQuarter, startOfYear } from 'date-fns'
import type { FiscalConfig } from '../hooks/useFiscalConfig.js'

export type CompareMode = 'off' | 'wow' | 'mom' | 'qoq' | 'yoy'

export interface DateRange { start: Date; end: Date }

// Given the current range, compute the "prior" range for a comparison mode.
// - MoM: shift back exactly 1 month (calendar), preserving day-of-month best-effort
// - QoQ: shift back one quarter. Under a fiscal config, quarters are 3-month
//   windows aligned to the fiscal start month, so the shift is the same 3-month
//   arithmetic regardless of mode; the label produced by fiscalLabelOf differs.
// - YoY: shift back exactly 1 year
export function priorRange(range: DateRange, mode: CompareMode, _cfg: FiscalConfig): DateRange | null {
  if (mode === 'off') return null
  const start = new Date(range.start)
  const end = new Date(range.end)
  switch (mode) {
    case 'wow':
      return { start: addDays(start, -7), end: addDays(end, -7) }
    case 'mom':
      return { start: addMonths(start, -1), end: addMonths(end, -1) }
    case 'qoq':
      return { start: addQuarters(start, -1), end: addQuarters(end, -1) }
    case 'yoy':
      return { start: addYears(start, -1), end: addYears(end, -1) }
  }
}

// Convert weeksBack preset into an explicit range ending today.
export function rangeFromWeeksBack(weeks: number): DateRange {
  const end = new Date()
  const start = startOfWeek(addDays(end, -7 * (weeks - 1)), { weekStartsOn: 1 })
  return { start, end }
}

// Helper: given a mode label + current range, return a short human suffix
// for display next to a metric (e.g. "vs last 4w", "vs Jun 2025").
export function comparisonLabel(mode: CompareMode): string {
  switch (mode) {
    case 'off': return ''
    case 'wow': return 'vs last week'
    case 'mom': return 'vs last month'
    case 'qoq': return 'vs last quarter'
    case 'yoy': return 'vs last year'
  }
}

// Compute % delta with sensible handling of zero baseline.
export function pctChange(current: number, prior: number): { pct: number; direction: 'up' | 'down' | 'flat'; hidden: boolean } {
  if (prior === 0 && current === 0) return { pct: 0, direction: 'flat', hidden: false }
  if (prior === 0) return { pct: 0, direction: 'up', hidden: true }
  const raw = ((current - prior) / prior) * 100
  const rounded = Math.round(raw * 10) / 10
  return { pct: rounded, direction: rounded > 0.05 ? 'up' : rounded < -0.05 ? 'down' : 'flat', hidden: false }
}

// Fiscal-anchored range presets (kept simple: current fiscal quarter/year).
export function currentFiscalQuarterRange(cfg: FiscalConfig, now: Date = new Date()): DateRange {
  const m = now.getMonth() + 1
  const monthsFromStart = cfg.mode === 'fiscal' ? (m - cfg.startMonth + 12) % 12 : (m - 1) % 12
  const qStartMonthIndex = Math.floor(monthsFromStart / 3) * 3  // 0,3,6,9
  const startMonthCalendar = cfg.mode === 'fiscal' ? ((cfg.startMonth - 1 + qStartMonthIndex) % 12) + 1 : qStartMonthIndex + 1
  const start = new Date(now.getFullYear(), startMonthCalendar - 1, 1)
  if (start > now) start.setFullYear(start.getFullYear() - 1)
  return { start, end: now }
}

// Utilities re-exported for callers that want raw date-fns starts.
export { startOfWeek, startOfMonth, startOfQuarter, startOfYear }
