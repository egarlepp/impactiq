import { db } from '../../../db/index.js'
import { crmHistoricalOpportunities, crmSnapshotState, crmHistoricalImportRuns } from '../../../../../drizzle/schema.js'
import { eq, isNull, sql, inArray } from 'drizzle-orm'
import { getAdminSfConnection } from '../client.js'
import { soqlDateTime } from '../soqlHelpers.js'
import { writeRun } from '../../jobs/writeRun.js'
import { scheduleJob } from '../../jobs/scheduler.js'
import { isCrmProviderActive } from '../../crm/providerSetting.js'

// v1.213.0: keeps the historical Opportunity mirror current — but ONLY for
// opportunities that haven't closed yet.
//
// The user-facing rule is "anything not Closed Won / Closed Lost should be
// refreshed; the rest are stored and linked". `frozen_at` is how that's
// enforced: it's set once, the first time IsClosed = true is observed, and
// never cleared. The selection below filters `frozen_at IS NULL`, and the
// upsert carries a matching setWhere so even a buggy caller can't mutate a
// frozen row.
//
// The job therefore gets monotonically cheaper as deals close. It is
// deliberately NOT merged into refreshOppSnapshots / refreshOppCoverage:
// those have different WHERE clauses, retention rules, and config gates, and
// merging would couple three features with contradictory lifecycles for the
// sake of ~10 API calls a night.

export const HISTORICAL_OPP_JOB_KEY = 'refresh_historical_opps'
const WATERMARK_KEY = 'historical_opp_refresh'
const SAFETY_BUFFER_MS = 15 * 60 * 1000
const ID_CHUNK = 500
const MAX_PER_RUN = 5000

export interface HistoricalOppRefreshResult {
  candidates: number
  refreshed: number
  frozen: number
  errors: string[]
  durationMs: number
}

export async function refreshHistoricalOpps(): Promise<HistoricalOppRefreshResult> {
  const startedAt = new Date()
  const result: HistoricalOppRefreshResult = {
    candidates: 0,
    refreshed: 0,
    frozen: 0,
    errors: [],
    durationMs: 0,
  }

  // Selection is purely local — no SF call needed to decide what to refresh.
  const candidates = await db
    .select({ oppId: crmHistoricalOpportunities.oppId })
    .from(crmHistoricalOpportunities)
    .where(isNull(crmHistoricalOpportunities.frozenAt))
    .orderBy(sql`${crmHistoricalOpportunities.refreshedAt} ASC`)
    .limit(MAX_PER_RUN)
  result.candidates = candidates.length
  // v1.438.0: nothing to refresh (no historical import yet, or every Opp has
  // closed) is a quiet no-op with no job_runs row, like the HubSpot side.
  // Checked before the connection, so an install that never ran the import
  // doesn't log a nightly no_admin_sf_connection error.
  if (candidates.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime()
    return result
  }

  const conn = await getAdminSfConnection()
  if (!conn) {
    result.errors.push('no_admin_sf_connection')
    result.durationMs = Date.now() - startedAt.getTime()
    await writeRun(HISTORICAL_OPP_JOB_KEY, startedAt, 'error', 'no_admin_sf_connection', result)
    return result
  }

  const [state] = await db
    .select()
    .from(crmSnapshotState)
    .where(eq(crmSnapshotState.key, WATERMARK_KEY))
    .limit(1)
  const watermark = state?.refreshedAt ? new Date(state.refreshedAt.getTime() - SAFETY_BUFFER_MS) : null
  const modstampClause = watermark ? ` AND SystemModstamp >= ${soqlDateTime(watermark)}` : ''

  const ids = candidates.map((c) => c.oppId)
  const runStartedAt = new Date()

  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    try {
      const soql =
        `SELECT Id, Name, AccountId, Account.Name, StageName, ForecastCategoryName, IsClosed, IsWon, ` +
        `Amount, Total_Acv__c, CloseDate, OwnerId, Owner.Name FROM Opportunity ` +
        `WHERE Id IN (${chunk.map((id) => `'${id.replace(/[^A-Za-z0-9]/g, '')}'`).join(',')})${modstampClause}`
      const res = await conn.query<Record<string, unknown>>(soql)
      for (const r of res.records ?? []) {
        const isClosed = !!r['IsClosed']
        await db
          .update(crmHistoricalOpportunities)
          .set({
            oppName: r['Name'] != null ? String(r['Name']) : null,
            accountId: r['AccountId'] != null ? String(r['AccountId']) : null,
            accountName: (r['Account'] as { Name?: string } | null)?.Name ?? null,
            stageName: r['StageName'] != null ? String(r['StageName']) : null,
            forecastCategory: r['ForecastCategoryName'] != null ? String(r['ForecastCategoryName']) : null,
            isClosed,
            isWon: !!r['IsWon'],
            amount: r['Amount'] != null ? String(r['Amount']) : null,
            totalAcv: r['Total_Acv__c'] != null ? String(r['Total_Acv__c']) : null,
            closeDate: r['CloseDate'] != null ? String(r['CloseDate']).slice(0, 10) : null,
            ownerId: r['OwnerId'] != null ? String(r['OwnerId']) : null,
            ownerName: (r['Owner'] as { Name?: string } | null)?.Name ?? null,
            refreshedAt: new Date(),
            // The deal just closed — freeze it. This row will never be
            // selected for refresh again.
            ...(isClosed ? { frozenAt: new Date() } : {}),
          })
          .where(eq(crmHistoricalOpportunities.oppId, String(r['Id'])))
        result.refreshed += 1
        if (isClosed) result.frozen += 1
      }
    } catch (e) {
      result.errors.push(`chunk_${i}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Bump refreshedAt even for rows SF didn't return (unchanged since the
  // watermark), so the ORDER BY refreshed_at rotation keeps moving instead of
  // re-selecting the same ids every night.
  if (modstampClause) {
    try {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        await db
          .update(crmHistoricalOpportunities)
          .set({ refreshedAt: new Date() })
          .where(inArray(crmHistoricalOpportunities.oppId, ids.slice(i, i + ID_CHUNK)))
      }
    } catch (e) {
      result.errors.push(`touch: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  await db
    .insert(crmSnapshotState)
    .values({
      key: WATERMARK_KEY,
      refreshedAt: new Date(),
      lastError: result.errors.length > 0 ? result.errors.join(' | ') : null,
    })
    .onConflictDoUpdate({
      target: crmSnapshotState.key,
      set: {
        refreshedAt: new Date(),
        lastError: result.errors.length > 0 ? result.errors.join(' | ') : null,
      },
    })

  result.durationMs = Date.now() - startedAt.getTime()

  // Domain-level run row alongside the job_runs entry, so the Scheduling page
  // and the import history page both have what they need.
  try {
    await db.insert(crmHistoricalImportRuns).values({
      status: result.errors.length > 0 ? 'error' : 'ok',
      kind: 'opp_refresh',
      startedAt: runStartedAt,
      finishedAt: new Date(),
      durationMs: result.durationMs,
      oppsUpserted: result.refreshed,
      error: result.errors[0] ?? null,
      detail: { candidates: result.candidates, frozen: result.frozen, errors: result.errors },
    })
  } catch {
    // Never let run auditing break the job.
  }

  const message = result.errors.length > 0
    ? result.errors[0] ?? null
    : `${result.refreshed}/${result.candidates} opps refreshed, ${result.frozen} newly frozen (closed)`
  await writeRun(
    HISTORICAL_OPP_JOB_KEY,
    startedAt,
    result.errors.length > 0 ? 'error' : 'ok',
    message,
    result,
  )
  return result
}

// Nightly loop. Started from src/server/index.ts, staggered at 150s behind
// refresh_opp_snapshots (60s) and refresh_opp_coverage (90s).
let stopFn: (() => void) | null = null
export function startHistoricalOppWorker() {
  if (stopFn) return
  stopFn = scheduleJob(HISTORICAL_OPP_JOB_KEY, 24 * 60 * 60 * 1000, async () => {
    // HubSpot installs refresh their historical Deals instead (v1.401.0);
    // with no CRM active the job is a quiet no-op.
    if (await isCrmProviderActive('hubspot')) {
      const { refreshHubspotHistoricalDeals } = await import('../../hubspot/historical.js')
      await refreshHubspotHistoricalDeals(HISTORICAL_OPP_JOB_KEY).catch((err) => {
        console.error('[historical-opps] HubSpot refresh failed:', err)
      })
      return
    }
    if (!(await isCrmProviderActive('salesforce'))) return
    await refreshHistoricalOpps().catch(() => {})
  }, { firstRunDelayMs: 150 * 1000 })
}
