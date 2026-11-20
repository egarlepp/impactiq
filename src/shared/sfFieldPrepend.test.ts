import { describe, it, expect } from 'vitest'
import { computeInitials, formatEntry, buildPrependedValue, computeCapacity } from './sfFieldPrepend.js'

describe('computeInitials', () => {
  it('uppercases first+last initial', () => {
    expect(computeInitials('Eric', 'Garlepp')).toBe('EG')
  })
  it('falls back to ? for a missing name rather than inventing one', () => {
    expect(computeInitials('', 'Garlepp')).toBe('?G')
    expect(computeInitials('Eric', null)).toBe('E?')
    expect(computeInitials(null, undefined)).toBe('??')
  })
  it('trims whitespace before taking the first character', () => {
    expect(computeInitials('  Eric', '  Garlepp')).toBe('EG')
  })
})

describe('formatEntry', () => {
  it('matches the exact required format', () => {
    expect(formatEntry('05/06/26', 'EG', 'Text, text, text')).toBe('05/06/26 - EG: Text, text, text')
  })
})

describe('buildPrependedValue', () => {
  it('AC2: empty existing value yields just the new entry, no stray blank lines', () => {
    expect(buildPrependedValue('', '05/06/26 - EG: First update')).toBe('05/06/26 - EG: First update')
    expect(buildPrependedValue(null, '05/06/26 - EG: First update')).toBe('05/06/26 - EG: First update')
    expect(buildPrependedValue(undefined, '05/06/26 - EG: First update')).toBe('05/06/26 - EG: First update')
  })

  it('AC1/AC3: prepends above existing content with one blank line, preserving it exactly', () => {
    const existing = '05/01/26 - JS: Customer has submitted the documentation.'
    const result = buildPrependedValue(existing, '05/06/26 - EG: PO should be issued by Friday. Follow up with Cary Monday.')
    expect(result).toBe(
      '05/06/26 - EG: PO should be issued by Friday. Follow up with Cary Monday.\n\n05/01/26 - JS: Customer has submitted the documentation.',
    )
  })

  it('preserves multi-entry history untouched beneath the new entry', () => {
    const existing = '05/01/26 - JS: Previous update text.\n\n04/28/26 - MB: Older update text.'
    const result = buildPrependedValue(existing, '05/06/26 - EG: New update text.')
    expect(result).toBe('05/06/26 - EG: New update text.\n\n05/01/26 - JS: Previous update text.\n\n04/28/26 - MB: Older update text.')
  })
})

describe('computeCapacity', () => {
  it('computes usage/remaining from the exact final submitted value, including prefix + separator', () => {
    const result = computeCapacity({
      existingValue: '05/01/26 - JS: Old update',
      formattedEntry: '05/06/26 - EG: New update',
      maxLength: 100,
    })
    // "05/06/26 - EG: New update" (25) + "\n\n" (2) + "05/01/26 - JS: Old update" (25) = 52
    expect(result.finalValue.length).toBe(52)
    expect(result.charactersUsed).toBe(52)
    expect(result.charactersRemaining).toBe(48)
    expect(result.overBy).toBe(0)
    expect(result.fits).toBe(true)
  })

  it('boundary: exactly at maximum is allowed', () => {
    const formattedEntry = '05/06/26 - EG: Hello'
    const result = computeCapacity({ existingValue: null, formattedEntry, maxLength: formattedEntry.length })
    expect(result.fits).toBe(true)
    expect(result.charactersRemaining).toBe(0)
    expect(result.overBy).toBe(0)
  })

  it('boundary: one character beyond maximum is rejected with the exact overage', () => {
    const formattedEntry = '05/06/26 - EG: Hello!'
    const result = computeCapacity({ existingValue: null, formattedEntry, maxLength: formattedEntry.length - 1 })
    expect(result.fits).toBe(false)
    expect(result.overBy).toBe(1)
    expect(result.charactersRemaining).toBe(-1)
  })

  it('null maxLength (unknown SF limit) never blocks submission', () => {
    const result = computeCapacity({ existingValue: 'x'.repeat(1_000_000), formattedEntry: 'y', maxLength: null })
    expect(result.fits).toBe(true)
    expect(result.maximumCharacters).toBeNull()
    expect(result.charactersRemaining).toBeNull()
  })

  it('Unicode: accented characters count as JS string.length (UTF-16 code units)', () => {
    // é as a single precomposed code point is 1 UTF-16 unit.
    const formattedEntry = '05/06/26 - EG: café résumé'
    const result = computeCapacity({ existingValue: null, formattedEntry, maxLength: 1000 })
    expect(result.charactersUsed).toBe(formattedEntry.length)
  })

  it('Unicode: smart quotes and an em dash count as ordinary single-unit characters', () => {
    const formattedEntry = '05/06/26 - EG: “quoted” — text'
    const result = computeCapacity({ existingValue: null, formattedEntry, maxLength: 1000 })
    expect(result.charactersUsed).toBe(formattedEntry.length)
  })

  it('Unicode: an emoji outside the BMP counts as 2 UTF-16 code units (surrogate pair)', () => {
    const formattedEntry = '05/06/26 - EG: Great work \u{1F389}' // 🎉
    const result = computeCapacity({ existingValue: null, formattedEntry, maxLength: 1000 })
    // Confirms and pins the surrogate-pair behavior rather than assuming it.
    expect(formattedEntry.length).toBeGreaterThan(Array.from(formattedEntry).length)
    expect(result.charactersUsed).toBe(formattedEntry.length)
  })

  it('multiline text: internal line breaks count and are preserved', () => {
    const formattedEntry = '05/06/26 - EG: Line one\nLine two'
    const existing = 'Existing line one\nExisting line two'
    const result = computeCapacity({ existingValue: existing, formattedEntry, maxLength: 1000 })
    expect(result.finalValue).toBe(`${formattedEntry}\n\n${existing}`)
    expect(result.charactersUsed).toBe(formattedEntry.length + 2 + existing.length)
  })
})
