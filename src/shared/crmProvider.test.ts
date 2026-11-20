import { describe, it, expect } from 'vitest'
import { normalizeCrmProvider, isCrmProviderId, DEFAULT_CRM_PROVIDER, normalizeCrmProviderSetting, crmProviderChangeAllowed } from './crmProvider.js'

describe('crm_provider setting', () => {
  it('defaults to Salesforce so installs that predate the setting are unchanged', () => {
    expect(DEFAULT_CRM_PROVIDER).toBe('salesforce')
    expect(normalizeCrmProvider(undefined)).toBe('salesforce')
    expect(normalizeCrmProvider(null)).toBe('salesforce')
    expect(normalizeCrmProvider({})).toBe('salesforce')
  })

  it('reads the stored { provider } shape', () => {
    expect(normalizeCrmProvider({ provider: 'hubspot' })).toBe('hubspot')
    expect(normalizeCrmProvider({ provider: 'none' })).toBe('none')
    expect(normalizeCrmProvider({ provider: 'salesforce' })).toBe('salesforce')
  })

  it('falls back to the default on anything unreadable, never to none', () => {
    expect(normalizeCrmProvider({ provider: 'dynamics' })).toBe('salesforce')
    expect(normalizeCrmProvider({ provider: 42 })).toBe('salesforce')
    expect(normalizeCrmProvider('HubSpot')).toBe('salesforce')
  })

  it('recognises only the known ids', () => {
    expect(isCrmProviderId('hubspot')).toBe(true)
    expect(isCrmProviderId('Salesforce')).toBe(false)
    expect(isCrmProviderId(undefined)).toBe(false)
  })
})

describe('crm_provider setting with its data CRM', () => {
  it('treats an install that predates dataProvider as holding Salesforce data', () => {
    expect(normalizeCrmProviderSetting({ provider: 'salesforce' })).toEqual({ provider: 'salesforce', dataProvider: 'salesforce' })
    expect(normalizeCrmProviderSetting({ provider: 'none' })).toEqual({ provider: 'none', dataProvider: 'salesforce' })
    expect(normalizeCrmProviderSetting(undefined)).toEqual({ provider: 'salesforce', dataProvider: 'salesforce' })
  })

  it('keeps a stored dataProvider and never stores none as one', () => {
    expect(normalizeCrmProviderSetting({ provider: 'none', dataProvider: 'hubspot' })).toEqual({ provider: 'none', dataProvider: 'hubspot' })
    expect(normalizeCrmProviderSetting({ provider: 'hubspot', dataProvider: 'none' })).toEqual({ provider: 'hubspot', dataProvider: 'hubspot' })
  })

  it('allows any change with no linked data, only the data CRM or none with it', () => {
    const sf = { provider: 'salesforce' as const, dataProvider: 'salesforce' as const }
    expect(crmProviderChangeAllowed(sf, 'hubspot', false)).toBe(true)
    expect(crmProviderChangeAllowed(sf, 'hubspot', true)).toBe(false)
    expect(crmProviderChangeAllowed(sf, 'none', true)).toBe(true)
    expect(crmProviderChangeAllowed({ provider: 'none', dataProvider: 'salesforce' }, 'salesforce', true)).toBe(true)
    expect(crmProviderChangeAllowed({ provider: 'none', dataProvider: 'salesforce' }, 'hubspot', true)).toBe(false)
  })
})
