import { describe, it, expect } from 'vitest'
import { stripTrailing, trimChar } from './strings.js'

describe('stripTrailing', () => {
  it('removes every trailing copy of the character', () => {
    expect(stripTrailing('https://x.example.com///', '/')).toBe('https://x.example.com')
    expect(stripTrailing('ABC==', '=')).toBe('ABC')
  })
  it('leaves other text alone', () => {
    expect(stripTrailing('a/b', '/')).toBe('a/b')
    expect(stripTrailing('', '/')).toBe('')
    expect(stripTrailing('///', '/')).toBe('')
  })
  it('handles a long run of the character quickly', () => {
    const input = '/'.repeat(100_000) + 'x'
    expect(stripTrailing(input, '/')).toBe(input)
  })
  it('rejects a multi-character argument', () => {
    expect(() => stripTrailing('a', '//')).toThrow()
  })
})

describe('trimChar', () => {
  it('removes the character from both ends only', () => {
    expect(trimChar('--sales-engineering--', '-')).toBe('sales-engineering')
    expect(trimChar('---', '-')).toBe('')
    expect(trimChar('a-b', '-')).toBe('a-b')
  })
})
