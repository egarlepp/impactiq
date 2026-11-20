import { describe, it, expect } from 'vitest'
import { JOB_CRM, jobAppliesToCrm, jobCrmScope } from './jobCrm.js'

describe('jobAppliesToCrm', () => {
  it('runs a Salesforce job only on Salesforce', () => {
    expect(jobAppliesToCrm('writeback_worker', 'salesforce')).toBe(true)
    expect(jobAppliesToCrm('writeback_worker', 'hubspot')).toBe(false)
    expect(jobAppliesToCrm('writeback_worker', 'none')).toBe(false)
  })

  it('runs a HubSpot job only on HubSpot', () => {
    expect(jobAppliesToCrm('hubspot_owner_sync', 'hubspot')).toBe(true)
    expect(jobAppliesToCrm('hubspot_owner_sync', 'salesforce')).toBe(false)
    expect(jobAppliesToCrm('hubspot_owner_sync', 'none')).toBe(false)
  })

  it('runs a shared CRM job on either CRM but not with None', () => {
    expect(jobAppliesToCrm('refresh_historical_opps', 'salesforce')).toBe(true)
    expect(jobAppliesToCrm('refresh_historical_opps', 'hubspot')).toBe(true)
    expect(jobAppliesToCrm('refresh_historical_opps', 'none')).toBe(false)
  })

  it('always runs a job that is not a CRM job', () => {
    for (const crm of ['salesforce', 'hubspot', 'none'] as const) {
      expect(jobAppliesToCrm('digest_worker', crm)).toBe(true)
      expect(jobAppliesToCrm('sync_audit_cull', crm)).toBe(true)
    }
    expect(jobCrmScope('toString')).toBeNull()
  })

  it('gives both CRMs the same number of jobs', () => {
    const scopes = Object.values(JOB_CRM)
    expect(scopes.filter((s) => s === 'salesforce').length).toBe(scopes.filter((s) => s === 'hubspot').length)
  })
})
