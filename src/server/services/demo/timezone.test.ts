import { describe, it, expect } from 'vitest'
import { addDaysToDate, dayOfWeek, isValidTimeZone, localDateOf, localMondayOf, localToUtc } from './timezone.js'

describe('demo timezone helpers', () => {
  it('works in UTC when no zone is given', () => {
    expect(localToUtc('2026-10-21', 14.5).toISOString()).toBe('2026-10-21T14:30:00.000Z')
    expect(localDateOf(new Date('2026-10-21T23:30:00Z'))).toBe('2026-10-21')
    expect(localMondayOf(new Date('2026-10-25T12:00:00Z'))).toBe('2026-10-19')
  })

  it('converts local wall-clock time, across DST', () => {
    expect(localToUtc('2026-10-21', 9.5, 'America/New_York').toISOString()).toBe('2026-10-21T13:30:00.000Z') // EDT
    expect(localToUtc('2026-11-02', 9.5, 'America/New_York').toISOString()).toBe('2026-11-02T14:30:00.000Z') // EST
    expect(localToUtc('2026-10-21', 9, 'Asia/Tokyo').toISOString()).toBe('2026-10-21T00:00:00.000Z')
    expect(localDateOf(new Date('2026-10-21T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-22')
    expect(localMondayOf(new Date('2026-10-25T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-26')
  })

  it('does calendar-date math and validates zones', () => {
    expect(addDaysToDate('2026-10-30', 3)).toBe('2026-11-02')
    expect(dayOfWeek('2026-10-25')).toBe(0)
    expect(isValidTimeZone('Europe/Berlin')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
  })
})
