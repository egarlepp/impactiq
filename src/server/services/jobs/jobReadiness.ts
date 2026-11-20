import type { CrmProviderId } from '../../../shared/crmProvider.js'

// What each scheduled job needs set up before it can do anything (v1.438.0).
// A job whose integration isn't connected doesn't tick, Run Now refuses it,
// and Admin → Scheduling shows it as waiting for setup instead of Active.
// A job missing from this map needs nothing beyond its CRM (jobCrm.ts).
//
// 'crm_admin' means the active CRM's org-wide connection: the admin
// Salesforce connection on Salesforce, the HubSpot key on HubSpot.
export const JOB_SETUP_NEEDS = [
  'salesforce_app',
  'salesforce_admin',
  'hubspot',
  'crm_admin',
  'microsoft',
  'criteriaiq',
  'gong',
  'github_updates',
  'email_or_slack',
  'event_webhooks',
] as const
export type JobSetupNeed = typeof JOB_SETUP_NEEDS[number]

export const JOB_NEEDS: Readonly<Record<string, JobSetupNeed>> = {
  // Per-user Salesforce tokens: needs the connected app.
  writeback_worker: 'salesforce_app',
  notes_push_worker: 'salesforce_app',
  // Org-wide reads on the admin Salesforce connection.
  refresh_opp_snapshots: 'salesforce_admin',
  refresh_opp_coverage: 'salesforce_admin',
  detect_disconnected_links: 'salesforce_admin',
  salesforce_user_sync: 'salesforce_admin',
  refresh_hubspot_snapshots: 'hubspot',
  refresh_hubspot_opp_coverage: 'hubspot',
  hubspot_writeback_worker: 'hubspot',
  hubspot_notes_push_worker: 'hubspot',
  hubspot_detect_disconnected_links: 'hubspot',
  hubspot_owner_sync: 'hubspot',
  refresh_historical_opps: 'crm_admin',
  historical_backfill: 'crm_admin',
  outlook_writeback_worker: 'microsoft',
  refresh_criteriaiq_projects: 'criteriaiq',
  gong_user_sync: 'gong',
  gong_call_index: 'gong',
  gong_auto_link: 'gong',
  check_for_updates: 'github_updates',
  digest_worker: 'email_or_slack',
  weekly_recap_worker: 'email_or_slack',
  event_webhook_worker: 'event_webhooks',
  anomaly_webhook_scan: 'event_webhooks',
}

export function jobSetupNeed(jobKey: string): JobSetupNeed | null {
  return Object.prototype.hasOwnProperty.call(JOB_NEEDS, jobKey) ? JOB_NEEDS[jobKey] ?? null : null
}

// The concrete thing to check for a need on this CRM. 'crm_admin' turns into
// the active CRM's own connection; with no CRM there is nothing to check
// (jobCrm.ts already stops those jobs).
export function resolveSetupNeed(need: JobSetupNeed, activeCrm: CrmProviderId): Exclude<JobSetupNeed, 'crm_admin'> | null {
  if (need !== 'crm_admin') return need
  if (activeCrm === 'salesforce') return 'salesforce_admin'
  if (activeCrm === 'hubspot') return 'hubspot'
  return null
}

// Each check is cheap (a settings row or an in-memory config) and imported
// lazily, since the scheduler is imported by the services these read.
async function isSetUp(need: Exclude<JobSetupNeed, 'crm_admin'>): Promise<boolean> {
  switch (need) {
    case 'salesforce_app': {
      const { getSfIntegrationConfig } = await import('../config/integrations.js')
      return getSfIntegrationConfig() !== null
    }
    case 'salesforce_admin': {
      const { getAdminSfConnectionRecord } = await import('../salesforce/client.js')
      return !!(await getAdminSfConnectionRecord())?.accessTokenEncrypted
    }
    case 'hubspot': {
      const { isHubspotConfigured } = await import('../hubspot/config.js')
      return isHubspotConfigured()
    }
    case 'microsoft': {
      const { getMsIntegrationConfig } = await import('../config/integrations.js')
      return getMsIntegrationConfig() !== null
    }
    case 'criteriaiq': {
      const { isCriteriaIqConfigured } = await import('../criteriaiq/config.js')
      return isCriteriaIqConfigured()
    }
    case 'gong': {
      const { isGongConfigured } = await import('../gong/config.js')
      return isGongConfigured()
    }
    case 'github_updates': {
      const { getUpdateConfigSummary } = await import('../updates/checkForUpdates.js')
      return (await getUpdateConfigSummary()).configured
    }
    case 'email_or_slack': {
      const { getEmailIntegrationConfig } = await import('../config/integrations.js')
      if (getEmailIntegrationConfig() !== null) return true
      const { getSlackConfigSummary } = await import('../slack/client.js')
      return (await getSlackConfigSummary()).configured
    }
    case 'event_webhooks': {
      const { db } = await import('../../db/index.js')
      const { eventWebhooks } = await import('../../../../drizzle/schema.js')
      const { eq } = await import('drizzle-orm')
      const [row] = await db.select({ id: eventWebhooks.id }).from(eventWebhooks).where(eq(eventWebhooks.isActive, true)).limit(1)
      return !!row
    }
  }
}

// null when the job can run; otherwise the setup it is waiting for. A check
// that throws counts as set up, so a settings read failure never silently
// parks a job (the job's own error handling still applies).
export async function jobWaitingFor(jobKey: string, activeCrm: CrmProviderId): Promise<Exclude<JobSetupNeed, 'crm_admin'> | null> {
  const need = jobSetupNeed(jobKey)
  if (need === null) return null
  const resolved = resolveSetupNeed(need, activeCrm)
  if (resolved === null) return null
  try {
    return (await isSetUp(resolved)) ? null : resolved
  } catch {
    return null
  }
}
