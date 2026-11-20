// v1.476.0: the "change-me" placeholders .env.example ships are long enough to
// pass the 32-char check, so they must be recognized and refused separately.
import { describe, it, expect } from 'vitest'
import { isPlaceholderSecret } from './env.js'

describe('isPlaceholderSecret', () => {
  it('recognizes the .env.example placeholder and its spellings', () => {
    expect(isPlaceholderSecret('change-me-32-byte-hex-key-here-00')).toBe(true)
    expect(isPlaceholderSecret('changeme')).toBe(true)
    expect(isPlaceholderSecret('CHANGE_ME_please')).toBe(true)
    expect(isPlaceholderSecret('  change-me  ')).toBe(true)
  })

  it('accepts generated secrets', () => {
    expect(isPlaceholderSecret('9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70')).toBe(false)
    expect(isPlaceholderSecret('a-real-secret-that-mentions-change-me-later')).toBe(false)
  })
})
