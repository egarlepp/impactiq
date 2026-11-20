import { describe, it, expect } from 'vitest'
import { GONG_OAUTH_SCOPES, clampTranscriptCacheDays, normalizeGongApiBaseUrl } from './gong.js'

describe('normalizeGongApiBaseUrl', () => {
  it('accepts api.gong.io and tenant hosts under it', () => {
    expect(normalizeGongApiBaseUrl('https://api.gong.io')).toBe('https://api.gong.io')
    expect(normalizeGongApiBaseUrl(' https://US-12345.api.gong.io/ ')).toBe('https://us-12345.api.gong.io')
  })

  it('refuses any other host, scheme, port, path or credentials', () => {
    for (const bad of [
      'http://api.gong.io',
      'https://api.gong.io.evil.example.com',
      'https://evil.example.com',
      'https://a.b.api.gong.io',
      'https://api.gong.io:8443',
      'https://api.gong.io/v2',
      'https://user:pw@api.gong.io',
      'https://api.gong.io/?x=1',
      'not a url',
      '',
    ]) expect(normalizeGongApiBaseUrl(bad)).toBeNull()
  })
})

describe('clampTranscriptCacheDays', () => {
  it('keeps the period between 1 day and 1 year', () => {
    expect(clampTranscriptCacheDays(30)).toBe(30)
    expect(clampTranscriptCacheDays(0)).toBe(1)
    expect(clampTranscriptCacheDays(400)).toBe(365)
    expect(clampTranscriptCacheDays('90')).toBe(90)
    expect(clampTranscriptCacheDays(7.6)).toBe(8)
  })

  it('falls back to 30 days for anything that is not a number', () => {
    expect(clampTranscriptCacheDays('abc')).toBe(30)
    expect(clampTranscriptCacheDays(undefined)).toBe(30)
  })
})

describe('GONG_OAUTH_SCOPES', () => {
  it('asks for every scope the capability check probes', () => {
    expect(GONG_OAUTH_SCOPES).toEqual(['api:users:read', 'api:workspaces:read', 'api:calls:read:extensive', 'api:calls:read:transcript'])
  })
})
