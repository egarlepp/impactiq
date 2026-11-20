import { db } from '../../../db/index.js'
import {
  crmHistoricalEvents,
  crmHistoricalOpportunities,
  crmHistoricalAccounts,
  sfUserNames,
} from '../../../../../drizzle/schema.js'
import { sql, inArray } from 'drizzle-orm'

// The CRM-neutral half of the historical import (v1.401.0): the per-slice
// stats shape and the writes into the local history tables. Salesforce
// (backfill.ts) and HubSpot (services/hubspot/historical.ts) each fetch and
// resolve a slice their own way, then hand the staged rows here, so both CRMs
// fill the same tables the same way.

const EVENT_CHUNK = 1000 // rows per bulk upsert; ~30 cols keeps us far under 65535 bind params

export interface SliceStats {
  eventsFetched: number
  eventsInserted: number
  eventsSkipped: number
  /** Dropped by an exclusion rule. Distinct from eventsSkipped (malformed). */
  eventsExcluded: number
  oppsUpserted: number
  accountsUpserted: number
  usersMatched: number
  usersUnmatched: number
  typesMatched: number
  typesUnmatched: number
  crmApiCalls: number
  unmatchedTypeSamples: Record<string, number>
  unmatchedOwnerSamples: Record<string, string>
}

export type StagedHistoricalEvent = typeof crmHistoricalEvents.$inferInsert
export type HistoricalOppRow = typeof crmHistoricalOpportunities.$inferInsert
export type HistoricalAccountRow = typeof crmHistoricalAccounts.$inferInsert

export function emptyStats(): SliceStats {
  return {
    eventsFetched: 0,
    eventsInserted: 0,
    eventsSkipped: 0,
    eventsExcluded: 0,
    oppsUpserted: 0,
    accountsUpserted: 0,
    usersMatched: 0,
    usersUnmatched: 0,
    typesMatched: 0,
    typesUnmatched: 0,
    crmApiCalls: 0,
    unmatchedTypeSamples: {},
    unmatchedOwnerSamples: {},
  }
}

export function excluded(col: string) {
  return sql.raw(`excluded.${col}`)
}

/**
 * Upserts staged events (keyed on the CRM's own record id, so replaying a
 * slice is idempotent) and shares resolved owner names with the name cache.
 * Returns how many events were written.
 */
export async function writeHistoricalEvents(
  staged: StagedHistoricalEvent[],
  ownerNames: Map<string, string>,
): Promise<number> {
  let written = 0
  for (let i = 0; i < staged.length; i += EVENT_CHUNK) {
    const chunk = staged.slice(i, i + EVENT_CHUNK)
    await db
      .insert(crmHistoricalEvents)
      .values(chunk)
      .onConflictDoUpdate({
        target: crmHistoricalEvents.crmEventId,
        set: {
          subject: excluded('subject'),
          crmType: excluded('crm_type'),
          activityDate: excluded('activity_date'),
          startDatetime: excluded('start_datetime'),
          endDatetime: excluded('end_datetime'),
          durationMinutes: excluded('duration_minutes'),
          isAllDayEvent: excluded('is_all_day_event'),
          isRecurrence: excluded('is_recurrence'),
          ownerCrmUserId: excluded('owner_crm_user_id'),
          ownerCrmUserName: excluded('owner_crm_user_name'),
          createdByCrmUserId: excluded('created_by_crm_user_id'),
          createdByCrmUserName: excluded('created_by_crm_user_name'),
          whatId: excluded('what_id'),
          whatType: excluded('what_type'),
          whatName: excluded('what_name'),
          whoId: excluded('who_id'),
          accountId: excluded('account_id'),
          description: excluded('description'),
          location: excluded('location'),
          crmCreatedDate: excluded('crm_created_date'),
          crmSystemModstamp: excluded('crm_system_modstamp'),
          userId: excluded('user_id'),
          teamId: excluded('team_id'),
          activityTypeId: excluded('activity_type_id'),
          userMatchMethod: excluded('user_match_method'),
          typeMatchMethod: excluded('type_match_method'),
          estimatedHours: excluded('estimated_hours'),
          importRunId: excluded('import_run_id'),
        },
      })
    written += chunk.length
  }

  // Share resolved owner names with the existing name cache.
  if (ownerNames.size > 0) {
    const rows = Array.from(ownerNames.entries()).map(([sfUserId, name]) => ({ sfUserId, name }))
    for (let i = 0; i < rows.length; i += EVENT_CHUNK) {
      await db
        .insert(sfUserNames)
        .values(rows.slice(i, i + EVENT_CHUNK))
        .onConflictDoUpdate({
          target: sfUserNames.sfUserId,
          set: { name: excluded('name'), refreshedAt: excluded('refreshed_at') },
        })
    }
  }
  return written
}

/** Upserts Opportunity (Deal) detail rows. A frozen (closed) row is never changed. */
export async function upsertHistoricalOpportunities(rows: HistoricalOppRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await db
    .insert(crmHistoricalOpportunities)
    .values(rows)
    .onConflictDoUpdate({
      target: crmHistoricalOpportunities.oppId,
      set: {
        oppName: excluded('opp_name'),
        accountId: excluded('account_id'),
        accountName: excluded('account_name'),
        stageName: excluded('stage_name'),
        forecastCategory: excluded('forecast_category'),
        isClosed: excluded('is_closed'),
        isWon: excluded('is_won'),
        amount: excluded('amount'),
        totalAcv: excluded('total_acv'),
        closeDate: excluded('close_date'),
        createdDate: excluded('created_date'),
        ownerId: excluded('owner_id'),
        ownerName: excluded('owner_name'),
        refreshedAt: sql`now()`,
        frozenAt: excluded('frozen_at'),
      },
      // Never mutate a frozen row, even from here.
      setWhere: sql`${crmHistoricalOpportunities.frozenAt} IS NULL`,
    })
  return rows.length
}

/** Inserts Account (Company) detail rows. Immutable once stored. */
export async function insertHistoricalAccounts(rows: HistoricalAccountRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await db.insert(crmHistoricalAccounts).values(rows).onConflictDoNothing()
  return rows.length
}

/**
 * Drops ids we've already mirrored. Over a multi-slice backfill the local
 * mirror saturates quickly, so this collapses the detail pass to near zero
 * after the first few slices.
 */
export async function filterUnknownIds(ids: Iterable<string>, kind: 'opp' | 'account'): Promise<string[]> {
  const all = Array.from(new Set(ids))
  if (all.length === 0) return []
  const known = new Set<string>()
  for (let i = 0; i < all.length; i += 1000) {
    const chunk = all.slice(i, i + 1000)
    if (kind === 'opp') {
      const rows = await db
        .select({ id: crmHistoricalOpportunities.oppId })
        .from(crmHistoricalOpportunities)
        .where(inArray(crmHistoricalOpportunities.oppId, chunk))
      for (const r of rows) known.add(r.id)
    } else {
      const rows = await db
        .select({ id: crmHistoricalAccounts.accountId })
        .from(crmHistoricalAccounts)
        .where(inArray(crmHistoricalAccounts.accountId, chunk))
      for (const r of rows) known.add(r.id)
    }
  }
  return all.filter((id) => !known.has(id))
}
