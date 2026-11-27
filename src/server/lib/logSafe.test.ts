import { describe, it, expect } from 'vitest'
import { logSafe } from './logSafe.js'

describe('logSafe', () => {
  it('removes line breaks so a value cannot start a new log line', () => {
    expect(logSafe('abc\r\n[req] 200 GET /forged')).toBe('abc[req] 200 GET /forged')
  })
  it('logs an Error as its message', () => {
    expect(logSafe(new Error('boom\nline'))).toBe('boomline')
  })
  it('stringifies other values and caps the length', () => {
    expect(logSafe(42)).toBe('42')
    expect(logSafe(null)).toBe('null')
    expect(logSafe('x'.repeat(5000))).toHaveLength(1000)
  })
})
