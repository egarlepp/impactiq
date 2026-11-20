import { describe, it, expect } from 'vitest'
import { normalizeTimeZone, windowsToIana } from './windowsTimezones.js'

describe('normalizeTimeZone (v1.471.1)', () => {
  it('converts Windows names Graph sends to IANA ids', () => {
    expect(normalizeTimeZone('Pacific Standard Time')).toBe('America/Los_Angeles')
    expect(normalizeTimeZone('W. Europe Standard Time')).toBe('Europe/Berlin')
    expect(normalizeTimeZone('Tokyo Standard Time')).toBe('Asia/Tokyo')
    expect(normalizeTimeZone('Coordinated Universal Time')).toBe('UTC')
  })

  it('ignores case and surrounding spaces', () => {
    expect(normalizeTimeZone('  eastern standard time ')).toBe('America/New_York')
  })

  it('keeps IANA ids and UTC as given', () => {
    expect(normalizeTimeZone('Europe/London')).toBe('Europe/London')
    expect(normalizeTimeZone('UTC')).toBe('UTC')
  })

  it('answers null for empty or unknown values', () => {
    expect(normalizeTimeZone(null)).toBeNull()
    expect(normalizeTimeZone('')).toBeNull()
    expect(normalizeTimeZone('Not A Zone')).toBeNull()
  })

  it('maps only to zones this runtime accepts', () => {
    expect(windowsToIana('India Standard Time')).toBe('Asia/Kolkata')
    expect(windowsToIana('Europe/Paris')).toBeNull()
  })
})
