import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import { crmWordingVariables, CRM_PROVIDER_IDS } from './crmProvider.js'

const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'pt', 'it']

function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (typeof obj === 'string') out[prefix] = obj
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  }
  return out
}

function locale(lng: string): Record<string, string> {
  const p = path.resolve(__dirname, '../client/i18n/locales', lng, 'translation.json')
  return flatten(JSON.parse(fs.readFileSync(p, 'utf-8')))
}

describe('CRM wording variables', () => {
  it('names every CRM, short and long', () => {
    expect(crmWordingVariables('salesforce')).toEqual({ crm: 'Salesforce', crmShort: 'SF' })
    expect(crmWordingVariables('hubspot')).toEqual({ crm: 'HubSpot', crmShort: 'HubSpot' })
    expect(crmWordingVariables('none')).toEqual({ crm: 'CRM', crmShort: 'CRM' })
    for (const id of CRM_PROVIDER_IDS) {
      const v = crmWordingVariables(id)
      expect(v.crm.length).toBeGreaterThan(0)
      expect(v.crmShort.length).toBeGreaterThan(0)
    }
  })

  // applyCrmWording() (client i18n/index.ts) relies on i18next reading
  // interpolation.defaultVariables at translate time, not copying it at init.
  it('follows a later change to the default variables', async () => {
    const inst = i18next.createInstance()
    await inst.init({
      lng: 'en',
      resources: { en: { translation: { a: 'Refresh from {{crm}}', b: 'Open in {{crmShort}}' } } },
      interpolation: { escapeValue: false, defaultVariables: crmWordingVariables('salesforce') },
    })
    expect(inst.t('a')).toBe('Refresh from Salesforce')
    expect(inst.t('b')).toBe('Open in SF')
    const interp = inst.options.interpolation ?? {}
    interp.defaultVariables = { ...interp.defaultVariables, ...crmWordingVariables('hubspot') }
    expect(inst.t('a')).toBe('Refresh from HubSpot')
    expect(inst.t('b')).toBe('Open in HubSpot')
  })

  it('every locale uses the same CRM variables as English for each key', () => {
    const en = locale('en')
    const vars = (s: string) => [...s.matchAll(/\{\{(crm|crmShort)\}\}/g)].length > 0
    for (const lng of LOCALES.filter((l) => l !== 'en')) {
      const other = locale(lng)
      for (const [key, value] of Object.entries(en)) {
        if (!vars(value) || other[key] === undefined) continue
        expect(vars(other[key]!), `${lng}: ${key}`).toBe(true)
      }
    }
  })
})
