import type { CrmProviderId } from '../../../shared/crmProvider.js'

// Which CRM each scheduled job belongs to (v1.437.0). A job for one CRM runs
// and shows on Admin → Scheduling only while that CRM is the active one; a job
// marked 'any' serves whichever CRM is active and stands down when the CRM is
// None. A job missing from this map isn't a CRM job and always runs.
//
// Salesforce and HubSpot jobs come in pairs, so an install on either CRM gets
// the same background work:
//   refresh_opp_snapshots      ↔ refresh_hubspot_snapshots
//   refresh_opp_coverage       ↔ refresh_hubspot_opp_coverage
//   writeback_worker           ↔ hubspot_writeback_worker
//   notes_push_worker          ↔ hubspot_notes_push_worker
//   detect_disconnected_links  ↔ hubspot_detect_disconnected_links
//   salesforce_user_sync       ↔ hubspot_owner_sync
// refresh_historical_opps and historical_backfill serve both CRMs under one key.
//
// Job keys are kept as they are (no salesforce_ prefix on the older ones):
// job_config and job_runs rows are keyed by them.
export type JobCrmScope = Exclude<CrmProviderId, 'none'> | 'any'

export const JOB_CRM: Readonly<Record<string, JobCrmScope>> = {
  refresh_opp_snapshots: 'salesforce',
  refresh_opp_coverage: 'salesforce',
  writeback_worker: 'salesforce',
  notes_push_worker: 'salesforce',
  detect_disconnected_links: 'salesforce',
  salesforce_user_sync: 'salesforce',
  refresh_hubspot_snapshots: 'hubspot',
  refresh_hubspot_opp_coverage: 'hubspot',
  hubspot_writeback_worker: 'hubspot',
  hubspot_notes_push_worker: 'hubspot',
  hubspot_detect_disconnected_links: 'hubspot',
  hubspot_owner_sync: 'hubspot',
  refresh_historical_opps: 'any',
  historical_backfill: 'any',
}

export function jobCrmScope(jobKey: string): JobCrmScope | null {
  return Object.prototype.hasOwnProperty.call(JOB_CRM, jobKey) ? JOB_CRM[jobKey] ?? null : null
}

// True when the job should run (and be listed) with this CRM active.
export function jobAppliesToCrm(jobKey: string, activeCrm: CrmProviderId): boolean {
  const scope = jobCrmScope(jobKey)
  if (scope === null) return true
  if (activeCrm === 'none') return false
  return scope === 'any' || scope === activeCrm
}
