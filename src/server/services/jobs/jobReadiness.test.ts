import { describe, it, expect, vi, beforeEach } from 'vitest'

const hubspotConfigured = vi.fn(async () => false)
vi.mock('../hubspot/config.js', () => ({ isHubspotConfigured: () => hubspotConfigured() }))
const msConfig = vi.fn((): object | null => null)
vi.mock('../config/integrations.js', () => ({
  getMsIntegrationConfig: () => msConfig(),
  getSfIntegrationConfig: () => null,
  getEmailIntegrationConfig: () => null,
}))
const adminSf = vi.fn(async (): Promise<{ accessTokenEncrypted?: string } | null> => null)
vi.mock('../salesforce/client.js', () => ({ getAdminSfConnectionRecord: () => adminSf() }))

import { JOB_CRM } from './jobCrm.js'
import { JOB_NEEDS, jobWaitingFor, resolveSetupNeed } from './jobReadiness.js'

beforeEach(() => {
  hubspotConfigured.mockImplementation(async () => false)
  msConfig.mockImplementation(() => null)
  adminSf.mockImplementation(async () => null)
})

describe('resolveSetupNeed', () => {
  it('turns crm_admin into the active CRM connection', () => {
    expect(resolveSetupNeed('crm_admin', 'salesforce')).toBe('salesforce_admin')
    expect(resolveSetupNeed('crm_admin', 'hubspot')).toBe('hubspot')
    expect(resolveSetupNeed('crm_admin', 'none')).toBeNull()
    expect(resolveSetupNeed('microsoft', 'none')).toBe('microsoft')
  })

  it('names a setup need for every CRM job', () => {
    for (const key of Object.keys(JOB_CRM)) expect(JOB_NEEDS[key], key).toBeDefined()
  })
})

describe('jobWaitingFor', () => {
  it('holds HubSpot jobs until the HubSpot key is saved', async () => {
    expect(await jobWaitingFor('hubspot_writeback_worker', 'hubspot')).toBe('hubspot')
    hubspotConfigured.mockImplementation(async () => true)
    expect(await jobWaitingFor('hubspot_writeback_worker', 'hubspot')).toBeNull()
  })

  it('holds the Outlook write-back until Microsoft Graph is connected', async () => {
    expect(await jobWaitingFor('outlook_writeback_worker', 'none')).toBe('microsoft')
    msConfig.mockImplementation(() => ({ clientId: 'x' }))
    expect(await jobWaitingFor('outlook_writeback_worker', 'none')).toBeNull()
  })

  it('checks the historical refresh against the active CRM', async () => {
    expect(await jobWaitingFor('refresh_historical_opps', 'hubspot')).toBe('hubspot')
    expect(await jobWaitingFor('refresh_historical_opps', 'salesforce')).toBe('salesforce_admin')
    adminSf.mockImplementation(async () => ({ accessTokenEncrypted: 'enc' }))
    expect(await jobWaitingFor('refresh_historical_opps', 'salesforce')).toBeNull()
  })

  it('never holds a job with no setup need', async () => {
    expect(await jobWaitingFor('sync_audit_cull', 'none')).toBeNull()
    expect(await jobWaitingFor('notification_sweep', 'hubspot')).toBeNull()
  })

  it('lets a job run when the check itself fails', async () => {
    hubspotConfigured.mockImplementation(async () => { throw new Error('db down') })
    expect(await jobWaitingFor('hubspot_owner_sync', 'hubspot')).toBeNull()
  })
})
