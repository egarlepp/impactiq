import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SSO_ERROR_REASONS, isSsoErrorReason, ssoErrorReason } from './ssoErrors.js'

const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'pt', 'it']

function lookup(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree)
}

describe('SSO sign-in error reasons', () => {
  it('maps identity provider errors to a known reason', () => {
    expect(ssoErrorReason('access_denied')).toBe('errors.auth.sso_denied')
    expect(ssoErrorReason('server_error')).toBe('errors.auth.sso_failed')
    expect(ssoErrorReason('<b>anything</b>')).toBe('errors.auth.sso_failed')
  })

  it('accepts only listed keys', () => {
    expect(isSsoErrorReason('errors.auth.account_disabled')).toBe(true)
    expect(isSsoErrorReason('errors.auth.something_else')).toBe(false)
    expect(isSsoErrorReason('Call 555-0100 to restore access')).toBe(false)
    expect(isSsoErrorReason(null)).toBe(false)
  })

  it('has a string for every reason in every locale', () => {
    for (const lng of LOCALES) {
      const tree: unknown = JSON.parse(readFileSync(`src/client/i18n/locales/${lng}/translation.json`, 'utf8').replace(/^﻿/, ''))
      for (const reason of SSO_ERROR_REASONS) expect(typeof lookup(tree, reason), `${lng}: ${reason}`).toBe('string')
    }
  })

  it('covers every reason the Okta and Azure callbacks redirect with', () => {
    for (const file of ['src/server/routes/auth/okta.ts', 'src/server/routes/auth/azure.ts']) {
      const reasons = [...readFileSync(file, 'utf8').matchAll(/reason=(errors\.[a-z_.]+)/g)].map((m) => m[1])
      expect(reasons.length).toBeGreaterThan(0)
      for (const r of reasons) expect(isSsoErrorReason(r), `${file}: ${r}`).toBe(true)
    }
  })
})
