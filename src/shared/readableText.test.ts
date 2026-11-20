import { describe, expect, it } from 'vitest'
import { readableTextOn } from './readableText.js'

describe('readableTextOn', () => {
  it('keeps white text on mid-tone and dark button colors', () => {
    for (const c of ['#2563EB', '#3B82F6', '#818CF8', '#A78BFA', '#60A5FA', '#4F46E5', '#18181B', '#15803D']) {
      expect(readableTextOn(c)).toBe('#FFFFFF')
    }
  })
  it('switches to dark ink on near-white or bright button colors', () => {
    for (const c of ['#F4F4F5', '#E5E5E5', '#D1D5DB', '#4ADE80']) {
      expect(readableTextOn(c)).toBe('#0F172A')
    }
  })
  it('returns undefined for a non-hex value', () => {
    expect(readableTextOn('blue')).toBeUndefined()
  })
})
