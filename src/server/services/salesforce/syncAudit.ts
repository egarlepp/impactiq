import { db } from '../../db/index.js'
import { activitySyncAudit } from '../../../../drizzle/schema.js'

// v1.259.0: the shared write path for Admin → CRM Sync → History
// (activity_sync_audit). Every Salesforce write attempt in the app should
// go through this — not just the activity Event/Task writeback worker,
// which owns its own local logAudit() in writeback.ts and doesn't need
// this (its rows already default to source='activity_writeback' at the
// column level). Use this helper for every OTHER Salesforce write site:
// note pushes, the Engineer Notes prepend-update, Assigned SE writes, and
// any ad-hoc Opportunity/Evaluation field write.
export type SyncSource =
  | 'note_push'
  | 'field_prepend'
  | 'evaluation_field_update'
  | 'opportunity_field_update'
  | 'assigned_se_update'

export interface SyncAuditRow {
  source: SyncSource
  status: 'success' | 'failed'
  operation: string
  crmObject?: string | null
  crmRecordId?: string | null
  errorMessage?: string | null
  payload?: unknown
  activityId?: string | null
  userId?: string | null
}

// Retention is handled entirely by the existing 6-hourly sweep in
// writeback.ts's startSyncAuditCull() — it culls activity_sync_audit by
// attemptedAt with no source filter, so it already covers every row this
// helper writes. No per-call cull needed here.
export async function logSfSyncAttempt(row: SyncAuditRow): Promise<void> {
  try {
    await db.insert(activitySyncAudit).values({
      source: row.source,
      activityId: row.activityId ?? null,
      userId: row.userId ?? null,
      status: row.status,
      operation: row.operation,
      crmObject: row.crmObject ?? null,
      crmRecordId: row.crmRecordId ?? null,
      errorMessage: row.errorMessage ?? null,
      payload: (row.payload ?? null) as Record<string, unknown> | null,
    })
  } catch (err) {
    console.error('[sf-sync-audit] log failed:', err instanceof Error ? err.message : String(err))
  }
}
