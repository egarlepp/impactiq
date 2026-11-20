import { describe, it, expect } from 'vitest'
import { localDayKeyFor } from './localDate.js'

describe('localDayKeyFor', () => {
  it('formats as YYYY-MM-DD', () => {
    const at = new Date('2026-03-15T12:00:00Z')
    expect(localDayKeyFor('UTC', at)).toBe('2026-03-15')
  })

  it('a late-evening instant in one timezone can be a different calendar day than in UTC', () => {
    // 11:30pm on Mar 14 in Los Angeles (UTC-7 during DST) is already
    // 2026-03-15T06:30:00Z — the exact boundary case this helper exists for.
    const at = new Date('2026-03-15T06:30:00Z')
    expect(localDayKeyFor('America/Los_Angeles', at)).toBe('2026-03-14')
    expect(localDayKeyFor('UTC', at)).toBe('2026-03-15')
  })

  it('a pre-midnight instant in a timezone ahead of UTC can be the next calendar day', () => {
    // 00:30 in Tokyo (UTC+9) on Mar 15 is still Mar 14 in UTC.
    const at = new Date('2026-03-14T15:30:00Z')
    expect(localDayKeyFor('Asia/Tokyo', at)).toBe('2026-03-15')
    expect(localDayKeyFor('UTC', at)).toBe('2026-03-14')
  })

  it('falls back to the UTC ISO date on an invalid IANA timezone rather than throwing', () => {
    const at = new Date('2026-03-15T12:00:00Z')
    expect(localDayKeyFor('Not/ARealZone', at)).toBe('2026-03-15')
  })
})
