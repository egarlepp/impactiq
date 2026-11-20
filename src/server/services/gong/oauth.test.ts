import { describe, it, expect } from 'vitest'
import { buildGongAuthorizeUrl, parseGongTokenResponse } from './oauth.js'

describe('buildGongAuthorizeUrl', () => {
  it('asks app.gong.io for a code with every scope ImpactIQ uses', () => {
    const url = new URL(buildGongAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://iq.example.com/auth/gong/callback', state: 'st' }))
    expect(url.origin + url.pathname).toBe('https://app.gong.io/oauth2/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('scope')).toContain('api:calls:read:transcript')
  })
})

describe('parseGongTokenResponse', () => {
  it('reads the tokens, lifetime and tenant host', () => {
    expect(parseGongTokenResponse({
      access_token: 'a', refresh_token: 'r', expires_in: 86400, api_base_url_for_customer: 'https://us-1.api.gong.io',
    })).toEqual({ accessToken: 'a', refreshToken: 'r', expiresInSeconds: 86400, apiBaseUrl: 'https://us-1.api.gong.io' })
  })

  it('tolerates a missing refresh token and lifetime', () => {
    expect(parseGongTokenResponse({ access_token: 'a' })).toEqual({ accessToken: 'a', refreshToken: null, expiresInSeconds: null, apiBaseUrl: null })
  })

  it('returns null for anything without an access token', () => {
    expect(parseGongTokenResponse({ error: 'invalid_grant' })).toBeNull()
    expect(parseGongTokenResponse(null)).toBeNull()
  })
})
