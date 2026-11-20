import { describe, it, expect } from 'vitest'
import { DEFAULT_CRM_FEATURES, blockedCrmLinkError, isBlockedCampaignLink, isBlockedLeadLink, normalizeCrmFeatures } from './crmFeatures.js'

const ON = { campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: true }
const OFF = { campaignsEnabled: false, leadsEnabled: true, hubspotCreateMeetings: true }
const LEADS_OFF = { campaignsEnabled: true, leadsEnabled: false, hubspotCreateMeetings: true }

describe('normalizeCrmFeatures', () => {
  it('defaults every switch to on for an unset or malformed row', () => {
    expect(normalizeCrmFeatures(undefined)).toEqual(DEFAULT_CRM_FEATURES)
    expect(normalizeCrmFeatures(null)).toEqual({ campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: true })
    expect(normalizeCrmFeatures({ campaignsEnabled: 'no', leadsEnabled: 0, hubspotCreateMeetings: 'off' })).toEqual({ campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: true })
  })
  it('keeps a stored boolean', () => {
    expect(normalizeCrmFeatures({ campaignsEnabled: false })).toEqual({ campaignsEnabled: false, leadsEnabled: true, hubspotCreateMeetings: true })
    expect(normalizeCrmFeatures({ leadsEnabled: false })).toEqual({ campaignsEnabled: true, leadsEnabled: false, hubspotCreateMeetings: true })
    expect(normalizeCrmFeatures({ hubspotCreateMeetings: false })).toEqual({ campaignsEnabled: true, leadsEnabled: true, hubspotCreateMeetings: false })
  })
})

describe('isBlockedCampaignLink', () => {
  it('never blocks while Campaigns is on', () => {
    expect(isBlockedCampaignLink(ON, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe(false)
  })
  it('blocks a new Campaign link while off', () => {
    expect(isBlockedCampaignLink(OFF, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe(true)
  })
  it('blocks switching an activity from an Opportunity to a Campaign while off', () => {
    expect(isBlockedCampaignLink(OFF, { crmWhatType: 'Campaign', crmWhatId: 'c1' }, { crmWhatType: 'Opportunity', crmWhatId: 'o1' })).toBe(true)
  })
  it('blocks switching to a different Campaign while off', () => {
    expect(isBlockedCampaignLink(OFF, { crmWhatType: 'Campaign', crmWhatId: 'c2' }, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe(true)
  })
  it('allows re-saving the same Campaign link while off', () => {
    expect(isBlockedCampaignLink(OFF, { crmWhatType: 'Campaign', crmWhatId: 'c1' }, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe(false)
    // A PATCH that only resends the type keeps the stored id.
    expect(isBlockedCampaignLink(OFF, { crmWhatType: 'Campaign' }, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe(false)
  })
  it('allows non-Campaign links and edits that leave the link alone while off', () => {
    expect(isBlockedCampaignLink(OFF, { crmWhatType: 'Opportunity', crmWhatId: 'o1' })).toBe(false)
    expect(isBlockedCampaignLink(OFF, {}, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe(false)
    expect(isBlockedCampaignLink(OFF, { crmWhatType: null, crmWhatId: null }, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe(false)
  })
})

describe('isBlockedLeadLink', () => {
  it('never blocks while Leads is on', () => {
    expect(isBlockedLeadLink(ON, { crmWhoType: 'Lead', crmWhoId: 'l1' })).toBe(false)
  })
  it('blocks a new or changed Lead link while off', () => {
    expect(isBlockedLeadLink(LEADS_OFF, { crmWhoType: 'Lead', crmWhoId: 'l1' })).toBe(true)
    expect(isBlockedLeadLink(LEADS_OFF, { crmWhoType: 'Lead', crmWhoId: 'l1' }, { crmWhoType: 'Contact', crmWhoId: 'k1' })).toBe(true)
    expect(isBlockedLeadLink(LEADS_OFF, { crmWhoType: 'Lead', crmWhoId: 'l2' }, { crmWhoType: 'Lead', crmWhoId: 'l1' })).toBe(true)
  })
  it('allows keeping an existing Lead link, Contacts, and clearing the link while off', () => {
    expect(isBlockedLeadLink(LEADS_OFF, { crmWhoType: 'Lead', crmWhoId: 'l1' }, { crmWhoType: 'Lead', crmWhoId: 'l1' })).toBe(false)
    expect(isBlockedLeadLink(LEADS_OFF, { crmWhoType: 'Lead' }, { crmWhoType: 'Lead', crmWhoId: 'l1' })).toBe(false)
    expect(isBlockedLeadLink(LEADS_OFF, { crmWhoType: 'Contact', crmWhoId: 'k1' })).toBe(false)
    expect(isBlockedLeadLink(LEADS_OFF, { crmWhoType: null, crmWhoId: null }, { crmWhoType: 'Lead', crmWhoId: 'l1' })).toBe(false)
  })
})

describe('blockedCrmLinkError', () => {
  it('names the switch that blocks the save, or null', () => {
    expect(blockedCrmLinkError(ON, { crmWhatType: 'Campaign', crmWhoType: 'Lead' })).toBeNull()
    expect(blockedCrmLinkError(OFF, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBe('errors.crm.campaigns_disabled')
    expect(blockedCrmLinkError(LEADS_OFF, { crmWhoType: 'Lead', crmWhoId: 'l1' })).toBe('errors.crm.leads_disabled')
    expect(blockedCrmLinkError(LEADS_OFF, { crmWhatType: 'Campaign', crmWhatId: 'c1' })).toBeNull()
  })
})
