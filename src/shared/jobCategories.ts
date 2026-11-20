// Admin → Scheduling groups jobs by what they do (v1.439.0). Categories are
// listed in display order; a job missing from JOB_CATEGORY lands in 'other',
// so a new job still shows up before anyone files it.
export const JOB_CATEGORIES = [
  'crm_writeback',
  'crm_refresh',
  'historical',
  'calendar',
  'transcripts',
  'notifications',
  'webhooks',
  'security',
  'maintenance',
  'other',
] as const

export type JobCategory = (typeof JOB_CATEGORIES)[number]

export const JOB_CATEGORY: Readonly<Record<string, JobCategory>> = {
  // Activities and notes going out to the CRM
  writeback_worker: 'crm_writeback',
  notes_push_worker: 'crm_writeback',
  hubspot_writeback_worker: 'crm_writeback',
  hubspot_notes_push_worker: 'crm_writeback',
  // CRM and Project data coming in
  refresh_opp_snapshots: 'crm_refresh',
  refresh_opp_coverage: 'crm_refresh',
  detect_disconnected_links: 'crm_refresh',
  salesforce_user_sync: 'crm_refresh',
  refresh_hubspot_snapshots: 'crm_refresh',
  refresh_hubspot_opp_coverage: 'crm_refresh',
  hubspot_detect_disconnected_links: 'crm_refresh',
  hubspot_owner_sync: 'crm_refresh',
  refresh_criteriaiq_projects: 'crm_refresh',
  // Historical import
  refresh_historical_opps: 'historical',
  historical_backfill: 'historical',
  // Outlook
  outlook_writeback_worker: 'calendar',
  // Gong call transcripts (Gong plan)
  gong_user_sync: 'transcripts',
  gong_call_index: 'transcripts',
  gong_auto_link: 'transcripts',
  // Nudges, digests and recaps
  notification_sweep: 'notifications',
  digest_worker: 'notifications',
  weekly_recap_worker: 'notifications',
  // Event webhooks
  event_webhook_worker: 'webhooks',
  anomaly_webhook_scan: 'webhooks',
  // Accounts
  password_expiry_enforcement: 'security',
  // Housekeeping and app updates
  sync_audit_cull: 'maintenance',
  check_for_updates: 'maintenance',
  restart_scheduler: 'maintenance',
}

export function jobCategory(jobKey: string): JobCategory {
  return Object.prototype.hasOwnProperty.call(JOB_CATEGORY, jobKey) ? JOB_CATEGORY[jobKey] ?? 'other' : 'other'
}

// Recent runs shows 20, 50 or 100 runs a page (v1.439.0; paged since v1.441.0).
export const RECENT_RUN_LIMITS = [20, 50, 100] as const
export type RecentRunLimit = (typeof RECENT_RUN_LIMITS)[number]

export function parseRecentRunLimit(raw: unknown): RecentRunLimit {
  const n = typeof raw === 'string' ? Number(raw) : NaN
  return (RECENT_RUN_LIMITS as readonly number[]).includes(n) ? (n as RecentRunLimit) : 20
}

// 1-based page number from a query string; anything else is page 1.
export function parseRecentRunPage(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 1 ? n : 1
}
