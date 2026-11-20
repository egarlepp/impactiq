// pglite-backed: the CRM feature switches round-trip through system_settings.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

// The active CRM and the HubSpot portal's last access check, set per test.
let providerId = 'salesforce'
let capabilities: Array<{ key: string; status: string }> | null = null
vi.mock('./providerSetting.js', async () => {
  const actual = await vi.importActual<typeof import('./providerSetting.js')>('./providerSetting.js')
  return { ...actual, getCrmProviderId: async () => providerId }
})
vi.mock('../hubspot/config.js', async () => {
  const actual = await vi.importActual<typeof import('../hubspot/config.js')>('../hubspot/config.js')
  return { ...actual, getHubspotConfig: async () => (capabilities ? { lastCheck: { capabilities } } : null) }
})

let features: typeof import('./features.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  features = await import('./features.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

describe('CRM feature switches', () => {
  it('defaults to every switch on when nothing is stored', async () => {
    features.clearCrmFeaturesCache()
    expect(await features.getCrmFeatures()).toEqual({ campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: true })
  })

  it('stores a change and reads it back', async () => {
    expect(await features.setCrmFeatures({ campaignsEnabled: false })).toEqual({ campaignsEnabled: false, leadsEnabled: true, hubspotCreateMeetings: true })
    features.clearCrmFeaturesCache()
    expect(await features.getCrmFeatures()).toEqual({ campaignsEnabled: false, leadsEnabled: true, hubspotCreateMeetings: true })
    const [row] = await testDb.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, 'crm_features'))
    expect(row?.value).toEqual({ campaignsEnabled: false, leadsEnabled: true, hubspotCreateMeetings: true })
  })

  it('updates the existing row rather than inserting a second one', async () => {
    await features.setCrmFeatures({ campaignsEnabled: true })
    const rows = await testDb.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, 'crm_features'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toEqual({ campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: true })
  })

  it('an empty patch keeps the current value', async () => {
    await features.setCrmFeatures({ campaignsEnabled: false })
    expect(await features.setCrmFeatures({})).toEqual({ campaignsEnabled: false, leadsEnabled: true, hubspotCreateMeetings: true })
  })

  it('changing Leads leaves Campaigns alone', async () => {
    await features.setCrmFeatures({ campaignsEnabled: false })
    expect(await features.setCrmFeatures({ leadsEnabled: false })).toEqual({ campaignsEnabled: false, leadsEnabled: false, hubspotCreateMeetings: true })
    features.clearCrmFeaturesCache()
    expect(await features.getCrmFeatures()).toEqual({ campaignsEnabled: false, leadsEnabled: false, hubspotCreateMeetings: true })
  })

  it('stores the HubSpot meeting switch without touching the others', async () => {
    expect(await features.setCrmFeatures({ hubspotCreateMeetings: false })).toEqual({ campaignsEnabled: false, leadsEnabled: false, hubspotCreateMeetings: false })
    await features.setCrmFeatures({ campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: true })
  })
})

describe('what the CRM offers', () => {
  async function reset(sw: { campaignsEnabled: boolean; leadsEnabled: boolean }) {
    await features.setCrmFeatures(sw)
    providerId = 'salesforce'
    capabilities = null
  }

  it('Salesforce offers both, so the switches apply as set', async () => {
    await reset({ campaignsEnabled: true, leadsEnabled: false })
    expect(await features.getCrmFeatureAvailability()).toEqual({ campaigns: true, leads: true })
    expect(await features.getEffectiveCrmFeatures()).toEqual({ campaignsEnabled: true, leadsEnabled: false, hubspotCreateMeetings: true })
    expect(await features.crmFeatureBlock('leads')).toBe('errors.crm.leads_disabled')
    expect(await features.crmFeatureBlock('campaigns')).toBeNull()
  })

  it('a HubSpot portal missing Campaigns hides them even with the switch on', async () => {
    await reset({ campaignsEnabled: true, leadsEnabled: true })
    providerId = 'hubspot'
    capabilities = [{ key: 'campaigns_read', status: 'missing' }, { key: 'leads_read', status: 'ok' }]
    expect(await features.getEffectiveCrmFeatures()).toEqual({ campaignsEnabled: false, leadsEnabled: true, hubspotCreateMeetings: true })
    expect(await features.crmFeatureBlock('campaigns')).toBe('errors.crm.campaigns_unavailable')
    expect(await features.crmLinkBlockError({ crmWhatType: 'Campaign', crmWhatId: '9' })).toBe('errors.crm.campaigns_unavailable')
    expect(await features.crmLinkBlockError({ crmWhoType: 'Lead', crmWhoId: '7' })).toBeNull()
  })

  it('says "turned off" when the admin switched it off, even if the portal lacks it too', async () => {
    await reset({ campaignsEnabled: true, leadsEnabled: false })
    providerId = 'hubspot'
    capabilities = [{ key: 'leads_read', status: 'missing' }]
    expect(await features.crmLinkBlockError({ crmWhoType: 'Lead', crmWhoId: '7' })).toBe('errors.crm.leads_disabled')
  })

  it('a probe that failed some other way, or no check yet, counts as available', async () => {
    await reset({ campaignsEnabled: true, leadsEnabled: true })
    providerId = 'hubspot'
    capabilities = [{ key: 'campaigns_read', status: 'unknown' }]
    expect(await features.getCrmFeatureAvailability()).toEqual({ campaigns: true, leads: true })
    capabilities = null
    expect(await features.getCrmFeatureAvailability()).toEqual({ campaigns: true, leads: true })
  })

  it('keeping an existing Campaign link is still allowed when the portal lacks Campaigns', async () => {
    await reset({ campaignsEnabled: true, leadsEnabled: true })
    providerId = 'hubspot'
    capabilities = [{ key: 'campaigns_read', status: 'missing' }]
    const existing = { crmWhatType: 'Campaign', crmWhatId: '9' }
    expect(await features.crmLinkBlockError({ crmWhatType: 'Campaign', crmWhatId: '9' }, existing)).toBeNull()
  })
})
