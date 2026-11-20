import { describe, expect, it } from 'vitest'
import { canonicalWeekStartFor, displayWeekStartFor, weekOffsetForDate, workDayBit } from './weekNav.js'

// Local-time constructors, so the tests mean the same thing in any TZ.
const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h)
const ymd = (x: Date) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`

describe('canonicalWeekStartFor', () => {
  it('Sunday-first: a Sunday belongs to the week starting the next day', () => {
    expect(ymd(canonicalWeekStartFor(d(2026, 11, 1), false))).toBe('2026-11-2')
    expect(ymd(canonicalWeekStartFor(d(2026, 10, 18), false))).toBe('2026-10-19')
  })
  it('Sunday-first: Saturday stays in the week that started the Monday before', () => {
    expect(ymd(canonicalWeekStartFor(d(2026, 10, 24), false))).toBe('2026-10-19')
  })
  it('Monday-first: a Sunday ends its Monday week', () => {
    expect(ymd(canonicalWeekStartFor(d(2026, 11, 1), true))).toBe('2026-10-26')
  })
})

describe('displayWeekStartFor', () => {
  it('shifts to the Sunday before only in Sunday-first mode', () => {
    expect(ymd(displayWeekStartFor(d(2026, 10, 19, 0), false))).toBe('2026-10-18')
    expect(ymd(displayWeekStartFor(d(2026, 10, 19, 0), true))).toBe('2026-10-19')
  })
})

describe('weekOffsetForDate', () => {
  // The reported bug: today Sunday 2026-11-01, Sunday-first grid, click Mon Oct 19.
  const sunday = d(2026, 11, 1, 15)

  it('clicking the 19th from a Sunday opens the week of Oct 18, not Oct 11', () => {
    const offset = weekOffsetForDate(d(2026, 10, 19, 0), false, sunday)
    expect(offset).toBe(-2)
    const shown = displayWeekStartFor(canonicalWeekStartFor(sunday, false), false)
    const target = new Date(shown.getTime() + offset * 7 * 86400000)
    expect(ymd(target)).toBe('2026-10-18')
  })

  it('every day of a displayed Sunday-first week gives the same offset', () => {
    for (let day = 18; day <= 24; day++) {
      expect(weekOffsetForDate(d(2026, 10, day, 0), false, sunday)).toBe(-2)
    }
  })

  it('every day of a Monday-first week gives the same offset', () => {
    for (let day = 19; day <= 25; day++) {
      expect(weekOffsetForDate(d(2026, 10, day, 0), true, sunday)).toBe(-1)
    }
  })

  it('works on every weekday as "today", both modes', () => {
    for (let t = 2; t <= 8; t++) {
      const today = d(2026, 11, t, 9)
      expect(weekOffsetForDate(today, false, today)).toBe(0)
      expect(weekOffsetForDate(today, true, today)).toBe(0)
    }
  })

  it('is stable across a DST change', () => {
    // US DST ends 2026-11-01; EU ended 2026-10-25. Either way the week math rounds.
    expect(weekOffsetForDate(d(2026, 10, 26, 0), true, d(2026, 11, 4))).toBe(-1)
    expect(weekOffsetForDate(d(2026, 11, 9, 0), true, d(2026, 10, 28))).toBe(2)
  })
})

describe('workDayBit', () => {
  it('maps by real weekday, whichever day the displayed week starts on', () => {
    expect(workDayBit(d(2026, 10, 19))).toBe(1)   // Monday
    expect(workDayBit(d(2026, 10, 23))).toBe(16)  // Friday
    expect(workDayBit(d(2026, 10, 18))).toBe(64)  // Sunday
    // Default Mon–Fri mask (31) over a Sunday-first week: 5 working days, Sun and Sat off.
    const days = Array.from({ length: 7 }, (_, i) => d(2026, 10, 18 + i))
    expect(days.filter((x) => (31 & workDayBit(x)) !== 0).length).toBe(5)
    expect((31 & workDayBit(days[0]!)) === 0 && (31 & workDayBit(days[6]!)) === 0).toBe(true)
  })
})
