import type { activities } from '../../../../drizzle/schema.js'
import { HUBSPOT_PROJECTS_OBJECT_TYPE_ID } from '../../../shared/hubspot.js'
import { DEMO_CRM_ID_PREFIX } from './ids.js'

type ActivityRow = typeof activities.$inferInsert

// The CRM the demo data is shaped for: the install's CRM, or Salesforce
// when none is chosen yet.
export type DemoCrm = 'salesforce' | 'hubspot'

// Leads (Salesforce Leads, HubSpot Leads). A converted Lead points at the
// Account it became, which is what rolls its hours up into that Account on
// Account / Opportunity Concentration and Most Expensive.
export interface LeadFixture { id: string; name: string; company: string; convertedAccountId: string | null }
export const DEMO_LEADS: LeadFixture[] = [
  { id: `${DEMO_CRM_ID_PREFIX}lead-001`, name: 'Uma Buyer', company: 'Sierra Robotics', convertedAccountId: null },
  { id: `${DEMO_CRM_ID_PREFIX}lead-002`, name: 'Victor Champion', company: 'Tango Freight', convertedAccountId: null },
  { id: `${DEMO_CRM_ID_PREFIX}lead-003`, name: 'Wendy Architect', company: 'Hotel Co', convertedAccountId: 'demo-acc-003' },
  { id: `${DEMO_CRM_ID_PREFIX}lead-004`, name: 'Xavier Director', company: 'Juliet Energy', convertedAccountId: 'demo-acc-005' },
  { id: `${DEMO_CRM_ID_PREFIX}lead-005`, name: 'Yara Analyst', company: 'Uniform Bio', convertedAccountId: null },
  { id: `${DEMO_CRM_ID_PREFIX}lead-006`, name: 'Zane Admin', company: 'Victor Mining', convertedAccountId: null },
]

// Marketing campaigns that Marketing activities link to.
export interface CampaignFixture { id: string; name: string }
export const DEMO_CAMPAIGNS: CampaignFixture[] = [
  { id: `${DEMO_CRM_ID_PREFIX}camp-001`, name: 'Spring Product Summit' },
  { id: `${DEMO_CRM_ID_PREFIX}camp-002`, name: 'Regional Partner Roadshow' },
  { id: `${DEMO_CRM_ID_PREFIX}camp-003`, name: 'Cloud Security Webinar Series' },
  { id: `${DEMO_CRM_ID_PREFIX}camp-004`, name: 'Customer Advisory Board' },
]

export function leadColumns(lead: LeadFixture): Partial<ActivityRow> {
  return {
    crmWhoId: lead.id,
    crmWhoType: 'Lead',
    crmWhoName: `${lead.name} (${lead.company})`,
  }
}

export function campaignColumns(campaign: CampaignFixture): Partial<ActivityRow> {
  return {
    crmWhatId: campaign.id,
    crmWhatType: 'Campaign',
    crmWhatName: campaign.name,
  }
}

// The fixtures are written with Salesforce's default stage and forecast
// names. On HubSpot they read as the default sales pipeline's deal stages
// and HubSpot's forecast categories, which is what the HubSpot snapshot
// job stores for real Deals, and a Project is HubSpot's Projects object.
const HUBSPOT_STAGES: Record<string, string> = {
  Prospecting: 'Appointment Scheduled',
  Qualification: 'Qualified To Buy',
  'Technical Validation': 'Presentation Scheduled',
  Proposal: 'Decision Maker Bought-In',
  Negotiation: 'Contract Sent',
  'Closed Won': 'Closed Won',
  'Closed Lost': 'Closed Lost',
}
const HUBSPOT_FORECASTS: Record<string, string> = {
  Pipeline: 'Pipeline',
  'Best Case': 'Best case',
  Commit: 'Commit',
  Closed: 'Closed won',
  Omitted: 'Omit',
}
export function demoStage(stage: string, crm: DemoCrm): string {
  return crm === 'hubspot' ? HUBSPOT_STAGES[stage] ?? stage : stage
}

export function demoForecast(forecast: string, crm: DemoCrm): string {
  return crm === 'hubspot' ? HUBSPOT_FORECASTS[forecast] ?? forecast : forecast
}

// Rewrites Salesforce-shaped activity rows for HubSpot in place.
export function applyHubspotVocabulary(rows: ActivityRow[], evalObject: string): void {
  for (const r of rows) {
    if (r.salesStage) r.salesStage = demoStage(r.salesStage, 'hubspot')
    if (r.forecastCategory) r.forecastCategory = demoForecast(r.forecastCategory, 'hubspot')
    if (r.crmRelatedType === evalObject) r.crmRelatedType = HUBSPOT_PROJECTS_OBJECT_TYPE_ID
  }
}
