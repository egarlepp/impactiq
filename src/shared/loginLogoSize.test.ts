import { describe, expect, it } from 'vitest'
import { defaultLoginLogoSize, isSquareish, normalizeLoginLogoDimension, resolveLoginLogoSize } from './loginLogoSize.js'

describe('login logo sizing', () => {
  it('gives a wide image the 750×200 default', () => {
    expect(defaultLoginLogoSize(1200, 320)).toEqual({ width: 750, height: 200 })
  })
  it('gives a square image the 250×250 default', () => {
    expect(defaultLoginLogoSize(512, 512)).toEqual({ width: 250, height: 250 })
    expect(isSquareish(512, 480)).toBe(true)
  })
  it('treats a tall image as rectangular', () => {
    expect(defaultLoginLogoSize(300, 900)).toEqual({ width: 750, height: 200 })
  })
  it('falls back to the rectangle default before the image size is known', () => {
    expect(defaultLoginLogoSize(0, 0)).toEqual({ width: 750, height: 200 })
  })
  it('uses configured dimensions and fills only the unset ones', () => {
    expect(resolveLoginLogoSize({ width: 500, height: 500 }, { width: 400, height: null })).toEqual({ width: 400, height: 250 })
    expect(resolveLoginLogoSize({ width: 900, height: 200 }, { width: 600, height: 150 })).toEqual({ width: 600, height: 150 })
  })
  it('normalizes dimensions into range, or null for unset', () => {
    expect(normalizeLoginLogoDimension(null)).toBeNull()
    expect(normalizeLoginLogoDimension('')).toBeNull()
    expect(normalizeLoginLogoDimension('abc')).toBeNull()
    expect(normalizeLoginLogoDimension(5)).toBe(40)
    expect(normalizeLoginLogoDimension(99999)).toBe(2000)
    expect(normalizeLoginLogoDimension(320.6)).toBe(321)
  })
})
