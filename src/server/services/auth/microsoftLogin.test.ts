import { describe, it, expect } from 'vitest'
import { isValidMicrosoftTenant, microsoftLoginUrl } from './microsoftLogin.js'

describe('microsoftLoginUrl', () => {
  it('builds the URL for a GUID, a domain or a special tenant', () => {
    expect(microsoftLoginUrl('0f8fad5b-d9cb-469f-a165-70867728950e', '/oauth2/v2.0/token'))
      .toBe('https://login.microsoftonline.com/0f8fad5b-d9cb-469f-a165-70867728950e/oauth2/v2.0/token')
    expect(microsoftLoginUrl(' contoso.onmicrosoft.com ', '/v2.0/.well-known/openid-configuration'))
      .toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0/.well-known/openid-configuration')
    expect(microsoftLoginUrl('common', '/oauth2/v2.0/authorize')).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
  })
  it('refuses a tenant that could change the host or path', () => {
    for (const bad of ['', 'evil.com/x', 'a@evil.com', '..', 'a/../b', 'x?y', 'x#y', '-a', 'a b']) {
      expect(isValidMicrosoftTenant(bad)).toBe(false)
      expect(() => microsoftLoginUrl(bad, '/oauth2/v2.0/token')).toThrow()
    }
  })
})
