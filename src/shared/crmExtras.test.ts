import { describe, expect, it } from 'vitest'
import { activityTypeExtraCrm, isActivityTypeExtraShownOn } from './crmExtras.js'

describe('activityTypeExtraCrm', () => {
  it('reads an Opp field as Salesforce unless it names the HubSpot deals object', () => {
    expect(activityTypeExtraCrm('opp_field_display', { apiName: 'Total_Acv__c' })).toBe('salesforce')
    expect(activityTypeExtraCrm('opp_field_display', { sobject: 'Opportunity', apiName: 'X' })).toBe('salesforce')
    expect(activityTypeExtraCrm('opp_field_display', { sobject: 'deals', apiName: 'amount' })).toBe('hubspot')
  })

  it('reads a related picker by its object', () => {
    expect(activityTypeExtraCrm('related_object_picker', { sobject: 'Evaluations__c' })).toBe('salesforce')
    expect(activityTypeExtraCrm('related_object_picker', { sobject: '0-970' })).toBe('hubspot')
    expect(activityTypeExtraCrm('related_object_picker', { sobject: 'CriteriaIQ' })).toBeNull()
  })

  it('treats the ticket picker as working on any CRM', () => {
    expect(activityTypeExtraCrm('ticket_picker', { sobject: 'Case' })).toBeNull()
    expect(activityTypeExtraCrm('ticket_picker', null)).toBeNull()
  })
})

describe('isActivityTypeExtraShownOn', () => {
  it('shows an extra only on its own CRM', () => {
    expect(isActivityTypeExtraShownOn('opp_field_display', { apiName: 'X' }, 'salesforce')).toBe(true)
    expect(isActivityTypeExtraShownOn('opp_field_display', { apiName: 'X' }, 'hubspot')).toBe(false)
    expect(isActivityTypeExtraShownOn('opp_field_display', { sobject: 'deals' }, 'hubspot')).toBe(true)
    expect(isActivityTypeExtraShownOn('opp_field_display', { sobject: 'deals' }, 'none')).toBe(false)
  })

  it('shows CRM-neutral extras everywhere', () => {
    expect(isActivityTypeExtraShownOn('ticket_picker', {}, 'hubspot')).toBe(true)
    expect(isActivityTypeExtraShownOn('related_object_picker', { sobject: 'CriteriaIQ' }, 'none')).toBe(true)
  })
})
