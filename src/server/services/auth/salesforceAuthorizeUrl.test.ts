import { describe, it, expect } from 'vitest'
import { isSalesforceAuthorizeUrl } from './salesforce.js'

describe('isSalesforceAuthorizeUrl', () => {
  it('accepts Salesforce login and My Domain hosts on the authorize path', () => {
    expect(isSalesforceAuthorizeUrl('https://login.salesforce.com/services/oauth2/authorize?a=1')).toBe(true)
    expect(isSalesforceAuthorizeUrl('https://acme.my.salesforce.com/services/oauth2/authorize?a=1')).toBe(true)
    expect(isSalesforceAuthorizeUrl('https://acme--dev.sandbox.my.site.force.com/services/oauth2/authorize')).toBe(true)
  })
  it('rejects other hosts, plain http and other paths', () => {
    expect(isSalesforceAuthorizeUrl('https://evil.example.com/services/oauth2/authorize')).toBe(false)
    expect(isSalesforceAuthorizeUrl('https://salesforce.com.evil.example/services/oauth2/authorize')).toBe(false)
    expect(isSalesforceAuthorizeUrl('https://evilsalesforce.com/services/oauth2/authorize')).toBe(false)
    expect(isSalesforceAuthorizeUrl('http://login.salesforce.com/services/oauth2/authorize')).toBe(false)
    expect(isSalesforceAuthorizeUrl('https://login.salesforce.com/other')).toBe(false)
    expect(isSalesforceAuthorizeUrl('not a url')).toBe(false)
  })
})
