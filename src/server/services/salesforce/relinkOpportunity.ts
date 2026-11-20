import type jsforce from 'jsforce'
import { db } from '../../db/index.js'
import { activities } from '../../../../drizzle/schema.js'
import { and, eq, isNotNull } from 'drizzle-orm'
import {
  CORE_SELECT,
  ASSIGNED_SE_FALLBACK_FIELD,
  PRIMARY_ENGINEER_FALLBACK_FIELD,
  collectExtraSelect,
  resolveAppFieldPaths,
  resolveFieldPath,
} from './refreshOppSnapshots.js'
import { filterKnownFields } from './soqlHelpers.js'
import { safeSoqlLiteral } from './soql.js'

// vNext: Opportunity Relink (CLAUDE.md §7) — when a rep closes an
// Opportunity Lost/Duplicate and the real work continues under a different
// Opportunity, an admin/leader can bulk-move every ImpactIQ activity's link
// from the old Opp to the new one. This module builds the live snapshot of
// the TARGET Opportunity that gets written onto those activities — reusing
// the exact same field set/resolution logic refreshOppSnapshots.ts uses for
// its own nightly patch, so a relinked activity's snapshot is bit-for-bit
// what the nightly job would have produced for this Opp. Deliberately does
// NOT trust any client-supplied field values (e.g. from the SfSearch picker's
// own search-result payload) — this always re-reads live, since the result
// feeds a bulk write with audit-log stakes.

export interface RelinkOppRow {
  Id: string
  Name: string
  StageName: string | null
  ForecastCategoryName: string | null
  Amount: number | null
  IsClosed: boolean
  IsWon: boolean
  CloseDate: string | null
  OwnerId: string | null
  Owner?: { Name: string | null } | null
  AccountId: string | null
  Account?: { Name: string | null } | null
  [key: string]: unknown
}

export interface RelinkSnapshotPatch {
  crmWhatId: string
  crmWhatName: string
  crmAccountId: string | null
  crmAccountName: string | null
  salesStage: string | null
  forecastCategory: string | null
  oppAmount: string | null
  crmIsClosed: boolean
  crmIsWon: boolean
  crmOppCloseDate: string | null
  crmOppOwnerId: string | null
  crmOppOwnerName: string | null
  crmAssignedSeName: string | null
  crmPrimaryEngineerName: string | null
}

// Pure — no I/O — so this is independently unit-testable, mirroring how
// buildSfRecord() in writeback.ts was made testable. Degrades gracefully:
// a missing/null field on the record just produces a null in the patch,
// never throws.
export function buildRelinkSnapshotPatch(
  rec: RelinkOppRow,
  assignedSePath: string | undefined,
  primaryEngineerPath: string | undefined,
): RelinkSnapshotPatch {
  return {
    crmWhatId: rec.Id,
    crmWhatName: rec.Name,
    crmAccountId: rec.AccountId ?? null,
    crmAccountName: rec.Account?.Name ?? null,
    salesStage: rec.StageName ?? null,
    forecastCategory: rec.ForecastCategoryName ?? null,
    oppAmount: rec.Amount != null ? String(rec.Amount) : null,
    crmIsClosed: !!rec.IsClosed,
    crmIsWon: !!rec.IsWon,
    crmOppCloseDate: rec.CloseDate ?? null,
    crmOppOwnerId: rec.OwnerId ?? null,
    crmOppOwnerName: rec.Owner?.Name ?? null,
    crmAssignedSeName: (assignedSePath ? resolveFieldPath(rec, assignedSePath) : null) ?? resolveFieldPath(rec, ASSIGNED_SE_FALLBACK_FIELD),
    crmPrimaryEngineerName: (primaryEngineerPath ? resolveFieldPath(rec, primaryEngineerPath) : null) ?? resolveFieldPath(rec, PRIMARY_ENGINEER_FALLBACK_FIELD),
  }
}

// Live, single-record read of the target Opportunity via the ADMIN SF
// connection — see CLAUDE.md §7/§13 for why this uses the admin connection
// rather than the acting user's own (same "org-wide snapshot write, never
// per-clicking-user" convention as the manual "Refresh from Salesforce"
// button). Returns null if the Opp doesn't exist / isn't readable / the
// query fails — callers must treat null as "abort, do not relink," never as
// "relink with a blank snapshot."
export async function fetchLiveOpportunitySnapshot(
  conn: jsforce.Connection,
  oppId: string,
): Promise<RelinkSnapshotPatch | null> {
  const extraCandidates = Array.from(new Set([
    ...await collectExtraSelect('opportunity', CORE_SELECT),
    ASSIGNED_SE_FALLBACK_FIELD,
    PRIMARY_ENGINEER_FALLBACK_FIELD,
  ]))
  const extraSelect = await filterKnownFields(conn, 'Opportunity', extraCandidates)
  const soqlFields = [...CORE_SELECT, 'AccountId', 'Account.Name', ...extraSelect].join(', ')

  const appFieldPaths = await resolveAppFieldPaths()
  const assignedSePath = appFieldPaths.get('assigned_se_name')
  const primaryEngineerPath = appFieldPaths.get('primary_engineer_name')

  try {
    const soql = `SELECT ${soqlFields} FROM Opportunity WHERE Id = '${safeSoqlLiteral(oppId)}' LIMIT 1`
    const result = await conn.query<RelinkOppRow>(soql)
    const rec = result.records[0]
    if (!rec) return null
    return buildRelinkSnapshotPatch(rec, assignedSePath, primaryEngineerPath)
  } catch {
    return null
  }
}

export interface ApplyRelinkResult {
  movedIds: string[]
  requeuedIds: string[]
}

// The actual local-database side of a relink: (1) repoints every activity on
// fromOppId to the new snapshot — draft and submitted alike, all-time, no
// date-range narrowing (CLAUDE.md §7: a bulk data CORRECTION, not a
// leader-dashboard read) — and (2) re-queues Salesforce write-back ONLY for
// rows that already wrote a real Event/Task (crmRecordId set), scoped by the
// NEW toOppId post-move. Wrapped in one transaction so a failure between the
// two steps can't leave activities half-migrated. Pure DB logic, no SF I/O —
// independently testable against a seeded fixture (pglite).
export async function applyOpportunityRelink(params: {
  teamId: string
  fromOppId: string
  toOppId: string
  snapshot: RelinkSnapshotPatch
}): Promise<ApplyRelinkResult> {
  const { teamId, fromOppId, toOppId, snapshot } = params
  return db.transaction(async (tx) => {
    const moved = await tx.update(activities).set({
      crmWhatId: snapshot.crmWhatId,
      crmWhatName: snapshot.crmWhatName,
      crmAccountId: snapshot.crmAccountId,
      crmAccountName: snapshot.crmAccountName,
      salesStage: snapshot.salesStage,
      forecastCategory: snapshot.forecastCategory,
      oppAmount: snapshot.oppAmount,
      crmIsClosed: snapshot.crmIsClosed,
      crmIsWon: snapshot.crmIsWon,
      crmOppCloseDate: snapshot.crmOppCloseDate,
      crmOppOwnerId: snapshot.crmOppOwnerId,
      crmOppOwnerName: snapshot.crmOppOwnerName,
      crmAssignedSeName: snapshot.crmAssignedSeName,
      crmPrimaryEngineerName: snapshot.crmPrimaryEngineerName,
      crmSnapshotRefreshedAt: new Date(),
      // The target Opp was just confirmed to exist by the live read that
      // produced `snapshot` — any stale "broken link" flag from before the
      // relink (see "Activities Disconnected from SF", CLAUDE.md §7) must
      // clear immediately rather than wait for the next nightly check.
      crmWhatDeleted: false,
      crmDisconnectCheckedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(activities.teamId, teamId), eq(activities.crmWhatType, 'Opportunity'), eq(activities.crmWhatId, fromOppId)))
      .returning({ id: activities.id })

    const requeued = await tx.update(activities).set({
      crmSyncStatus: 'pending',
      crmSyncError: null,
      crmSyncAttempts: 0,
      crmNextRetryAt: null,
    }).where(and(
      eq(activities.teamId, teamId),
      eq(activities.crmWhatId, toOppId),
      isNotNull(activities.crmRecordId),
    )).returning({ id: activities.id })

    return { movedIds: moved.map((r) => r.id), requeuedIds: requeued.map((r) => r.id) }
  })
}
