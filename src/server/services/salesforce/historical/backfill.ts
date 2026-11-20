import { db } from '../../../db/index.js'
import {
  crmHistoricalImportRuns,
  crmHistoricalBackfillState,
} from '../../../../../drizzle/schema.js'
import { eq, sql } from 'drizzle-orm'
import { getAdminSfConnection } from '../client.js'
import { filterKnownFields, queryAllPaged, soqlDateTime } from '../soqlHelpers.js'
import { writeRun } from '../../jobs/writeRun.js'
import { getHistoricalImportWindow } from '../../config/integrations.js'
import { loadLinkageMaps, resolveEventLinkage, estimateHours, type LinkageMaps } from './linkage.js'
import { loadExclusions, isExcluded, exclusionSoqlClause, type ExclusionSet } from './exclusions.js'
import {
  emptyStats,
  writeHistoricalEvents,
  upsertHistoricalOpportunities,
  insertHistoricalAccounts,
  filterUnknownIds,
  type SliceStats,
  type StagedHistoricalEvent,
} from './store.js'
import { getCrmProviderId } from '../../crm/providerSetting.js'

export type { SliceStats } from './store.js'

// v1.213.0: resumable backfill of pre-ImpactIQ Salesforce Event history.
//
// Walks BACKWARDS in time from now() to a floor (default 3 years), one slice
// at a time. The cursor advances only after a slice's rows are committed, so
// a crash replays at most one slice — and because the upsert is keyed on the
// SF Event Id, replay is idempotent. That is the entire resumability story.
//
// Scope: only Events linked to an Opportunity, Account, or Evaluations__c.
// Measured against the production org, that's ~48k of the 140k Events in the
// trailing 3 years; the remainder are TimeTrade scheduling artifacts, Cases,
// and unlinked events, none of which carry analytical value here.

export const BACKFILL_KEY = 'events'
export const HISTORICAL_BACKFILL_JOB_KEY = 'historical_backfill'

const DEFAULT_LOOKBACK_DAYS = 1095 // 3 years
const DEFAULT_SLICE_DAYS = 90
const MIN_SLICE_DAYS = 7
// If a slice returns more than this, halve sliceDays and redo it — activity
// volume is not uniform across three years.
const SLICE_ROW_CEILING = 20_000
const ID_CHUNK = 200 // ids per `Id IN (...)` for the Opp/Account detail pass
const SLICE_BREATHER_MS = 200 // don't starve the request pool / write-back worker

/** SF objects whose linked Events we import. */
const LINKED_WHAT_TYPES = ['Opportunity', 'Account', 'Evaluations__c']

const EVENT_FIELDS = [
  'Id',
  'Subject',
  'Type',
  'ActivityDate',
  'ActivityDateTime',
  'EndDateTime',
  'DurationInMinutes',
  'IsAllDayEvent',
  'IsRecurrence',
  'OwnerId',
  'Owner.Name',
  'CreatedById',
  'CreatedBy.Name',
  'WhatId',
  'What.Type',
  'What.Name',
  'WhoId',
  'AccountId',
  'Description',
  'Location',
  'CreatedDate',
  'SystemModstamp',
]

export interface BackfillStatus {
  key: string
  status: string
  cursorBefore: string
  floorAt: string
  sliceDays: number
  totalEventsImported: number
  totalSlicesDone: number
  lastError: string | null
  startedAt: string | null
  updatedAt: string
  percentComplete: number
}

// --- state ------------------------------------------------------------------

// The configured import floor — either a relative window or a fixed earliest
// date. Falls back to the 3-year constant if the settings read fails: a DB
// hiccup must not silently produce a 0-day window, which would make the
// backfill look "complete" with nothing imported.
async function resolveFloorAt(): Promise<Date> {
  try {
    const { floorAt } = await getHistoricalImportWindow()
    return floorAt
  } catch {
    return new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  }
}

async function ensureState(floorOverride?: Date) {
  const [existing] = await db
    .select()
    .from(crmHistoricalBackfillState)
    .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
    .limit(1)
  if (existing) return existing
  // v1.222.0: the window is admin-configurable (3-year max, or a fixed date).
  // Read it here rather than defaulting to the constant, so the very first run
  // on a fresh install already honours a shortened window instead of only
  // doing so after a Reset cursor.
  const floorAt = floorOverride ?? await resolveFloorAt()
  const now = new Date()
  await db
    .insert(crmHistoricalBackfillState)
    .values({
      key: BACKFILL_KEY,
      cursorBefore: now,
      floorAt,
      sliceDays: DEFAULT_SLICE_DAYS,
      status: 'idle',
    })
    .onConflictDoNothing()
  const [created] = await db
    .select()
    .from(crmHistoricalBackfillState)
    .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
    .limit(1)
  return created!
}

function toStatus(row: typeof crmHistoricalBackfillState.$inferSelect): BackfillStatus {
  // Progress is how much of the [floorAt, now] window the cursor has already
  // walked past, since the walk runs backwards from now() toward floorAt.
  const span = Date.now() - new Date(row.floorAt).getTime()
  const remaining = new Date(row.cursorBefore).getTime() - new Date(row.floorAt).getTime()
  const pct = span > 0 ? Math.max(0, Math.min(100, ((span - remaining) / span) * 100)) : 0
  return {
    key: row.key,
    status: row.status,
    cursorBefore: new Date(row.cursorBefore).toISOString(),
    floorAt: new Date(row.floorAt).toISOString(),
    sliceDays: row.sliceDays,
    totalEventsImported: row.totalEventsImported,
    totalSlicesDone: row.totalSlicesDone,
    lastError: row.lastError,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
    percentComplete: Math.round(pct * 10) / 10,
  }
}

export async function getBackfillStatus(): Promise<BackfillStatus> {
  const row = await ensureState()
  return toStatus(row)
}

export async function getRecentImportRuns(limit = 20) {
  return db
    .select()
    .from(crmHistoricalImportRuns)
    .orderBy(sql`${crmHistoricalImportRuns.startedAt} DESC`)
    .limit(limit)
}

// --- slice ingestion ----------------------------------------------------------

interface RawEvent extends Record<string, unknown> {
  Id: string
}

function str(v: unknown): string | null {
  return v == null ? null : String(v)
}

function dateOnly(v: unknown): string | null {
  const s = str(v)
  return s ? s.slice(0, 10) : null
}

function ts(v: unknown): Date | null {
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Fetches, resolves, and (unless dryRun) writes one time slice.
 * Returns the stats for that slice.
 */
async function ingestSlice(
  conn: NonNullable<Awaited<ReturnType<typeof getAdminSfConnection>>>,
  maps: LinkageMaps,
  soqlFields: string,
  sliceFrom: Date,
  sliceTo: Date,
  runId: string | null,
  dryRun: boolean,
  exclusions: ExclusionSet,
): Promise<SliceStats> {
  const stats = emptyStats()
  const whatTypes = LINKED_WHAT_TYPES.map((t) => `'${t}'`).join(',')
  // Exclusions are applied in SOQL so machine-generated events are never
  // fetched, paged, or staged at all — in this org that's a third of the
  // result set. The in-process check below still runs as a backstop.
  const soql =
    `SELECT ${soqlFields} FROM Event ` +
    `WHERE ActivityDateTime >= ${soqlDateTime(sliceFrom)} AND ActivityDateTime < ${soqlDateTime(sliceTo)} ` +
    `AND What.Type IN (${whatTypes})` +
    exclusionSoqlClause(exclusions) +
    ` ORDER BY ActivityDateTime DESC`

  const staged: StagedHistoricalEvent[] = []
  const oppIds = new Set<string>()
  const accountIds = new Set<string>()
  const ownerNames = new Map<string, string>()

  await queryAllPaged<RawEvent>(conn, soql, (records) => {
    stats.crmApiCalls += 1
    for (const rec of records) {
      stats.eventsFetched += 1
      const crmEventId = str(rec['Id'])
      if (!crmEventId) {
        stats.eventsSkipped += 1
        continue
      }
      const ownerCrmUserId = str(rec['OwnerId'])
      const ownerCrmUserName = (rec['Owner'] as { Name?: string } | null)?.Name ?? null
      const createdByCrmUserId = str(rec['CreatedById'])
      const createdByCrmUserName = (rec['CreatedBy'] as { Name?: string } | null)?.Name ?? null
      // Backstop: catches anything the SOQL clause missed (cap overflow, a
      // 15/18-char mismatch, an id that got sanitized away).
      if (isExcluded(exclusions, createdByCrmUserId, ownerCrmUserId)) {
        stats.eventsExcluded += 1
        continue
      }
      const crmType = str(rec['Type'])
      const link = resolveEventLinkage(maps, ownerCrmUserId, crmType)

      if (link.userId) stats.usersMatched += 1
      else {
        stats.usersUnmatched += 1
        if (ownerCrmUserId && ownerCrmUserName && Object.keys(stats.unmatchedOwnerSamples).length < 50) {
          stats.unmatchedOwnerSamples[ownerCrmUserId] = ownerCrmUserName
        }
      }
      if (link.activityTypeId) stats.typesMatched += 1
      else {
        stats.typesUnmatched += 1
        const k = crmType ?? '(none)'
        stats.unmatchedTypeSamples[k] = (stats.unmatchedTypeSamples[k] ?? 0) + 1
      }

      if (ownerCrmUserId && ownerCrmUserName) ownerNames.set(ownerCrmUserId, ownerCrmUserName)

      const whatId = str(rec['WhatId'])
      const whatType = (rec['What'] as { Type?: string } | null)?.Type ?? null
      const accountId = str(rec['AccountId'])
      if (whatId && whatType === 'Opportunity') oppIds.add(whatId)
      if (accountId) accountIds.add(accountId)

      const isAllDayEvent = !!rec['IsAllDayEvent']
      const durationMinutes =
        rec['DurationInMinutes'] != null ? Number(rec['DurationInMinutes']) : null

      staged.push({
        crmEventId,
        subject: str(rec['Subject']),
        crmType,
        activityDate: dateOnly(rec['ActivityDate']),
        startDatetime: ts(rec['ActivityDateTime']),
        endDatetime: ts(rec['EndDateTime']),
        durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
        isAllDayEvent,
        isRecurrence: !!rec['IsRecurrence'],
        ownerCrmUserId,
        ownerCrmUserName,
        createdByCrmUserId,
        createdByCrmUserName,
        whatId,
        whatType,
        whatName: (rec['What'] as { Name?: string } | null)?.Name ?? null,
        whoId: str(rec['WhoId']),
        accountId,
        description: str(rec['Description']),
        location: str(rec['Location']),
        crmCreatedDate: ts(rec['CreatedDate']),
        crmSystemModstamp: ts(rec['SystemModstamp']),
        userId: link.userId,
        teamId: link.teamId,
        activityTypeId: link.activityTypeId,
        userMatchMethod: link.userMatchMethod,
        typeMatchMethod: link.typeMatchMethod,
        estimatedHours: estimateHours(durationMinutes, isAllDayEvent, maps.allDayCapHours),
        importRunId: runId,
      })
    }
  })

  if (dryRun) return stats

  stats.eventsInserted += await writeHistoricalEvents(staged, ownerNames)

  // --- Opportunity + Account detail pass ---------------------------------
  stats.oppsUpserted += await fetchOpportunities(conn, oppIds, stats)
  stats.accountsUpserted += await fetchAccounts(conn, accountIds, stats)

  return stats
}

/** Pulls Opportunity detail for ids not already mirrored locally. */
async function fetchOpportunities(
  conn: NonNullable<Awaited<ReturnType<typeof getAdminSfConnection>>>,
  ids: Set<string>,
  stats: SliceStats,
): Promise<number> {
  const wanted = await filterUnknownIds(ids, 'opp')
  if (wanted.length === 0) return 0
  let upserted = 0
  for (let i = 0; i < wanted.length; i += ID_CHUNK) {
    const chunk = wanted.slice(i, i + ID_CHUNK)
    const soql =
      `SELECT Id, Name, AccountId, Account.Name, StageName, ForecastCategoryName, IsClosed, IsWon, ` +
      `Amount, Total_Acv__c, CloseDate, CreatedDate, OwnerId, Owner.Name FROM Opportunity ` +
      `WHERE Id IN (${chunk.map((id) => `'${id.replace(/[^A-Za-z0-9]/g, '')}'`).join(',')})`
    stats.crmApiCalls += 1
    const res = await conn.query<Record<string, unknown>>(soql)
    const rows = (res.records ?? []).map((r) => {
      const isClosed = !!r['IsClosed']
      return {
        oppId: String(r['Id']),
        oppName: str(r['Name']),
        accountId: str(r['AccountId']),
        accountName: (r['Account'] as { Name?: string } | null)?.Name ?? null,
        stageName: str(r['StageName']),
        forecastCategory: str(r['ForecastCategoryName']),
        isClosed,
        isWon: !!r['IsWon'],
        amount: str(r['Amount']),
        totalAcv: str(r['Total_Acv__c']),
        closeDate: dateOnly(r['CloseDate']),
        createdDate: dateOnly(r['CreatedDate']),
        ownerId: str(r['OwnerId']),
        ownerName: (r['Owner'] as { Name?: string } | null)?.Name ?? null,
        // Freeze immediately if it's already closed — this row will never be
        // refreshed again.
        frozenAt: isClosed ? new Date() : null,
      }
    })
    upserted += await upsertHistoricalOpportunities(rows)
  }
  return upserted
}

/** Pulls Account detail for ids not already mirrored locally. Immutable. */
async function fetchAccounts(
  conn: NonNullable<Awaited<ReturnType<typeof getAdminSfConnection>>>,
  ids: Set<string>,
  stats: SliceStats,
): Promise<number> {
  const wanted = await filterUnknownIds(ids, 'account')
  if (wanted.length === 0) return 0
  let upserted = 0
  for (let i = 0; i < wanted.length; i += ID_CHUNK) {
    const chunk = wanted.slice(i, i + ID_CHUNK)
    const soql =
      `SELECT Id, Name, OwnerId, Industry FROM Account ` +
      `WHERE Id IN (${chunk.map((id) => `'${id.replace(/[^A-Za-z0-9]/g, '')}'`).join(',')})`
    stats.crmApiCalls += 1
    const res = await conn.query<Record<string, unknown>>(soql)
    const rows = (res.records ?? []).map((r) => ({
      accountId: String(r['Id']),
      name: str(r['Name']),
      ownerId: str(r['OwnerId']),
      industry: str(r['Industry']),
    }))
    upserted += await insertHistoricalAccounts(rows)
  }
  return upserted
}

// --- the walker ---------------------------------------------------------------

// In-process guard so a double-clicked Start can't spawn two walkers. The DB
// status check alone isn't enough — two requests can race before either
// commits.
let walkerRunning = false

export function isBackfillRunning(): boolean {
  return walkerRunning
}

/** Fetches, resolves and (unless dryRun) writes one time slice. */
export type SliceIngestor = (sliceFrom: Date, sliceTo: Date, runId: string | null, dryRun: boolean) => Promise<SliceStats>

/**
 * The slice ingestor for the install's CRM (v1.401.0). On HubSpot, meetings
 * come from HubSpot's API through services/hubspot/historical.ts; otherwise
 * Events come from Salesforce as before. Loaded once per session, since the
 * HubSpot side reads property metadata and mappings up front.
 */
async function makeIngestor(maps: LinkageMaps, exclusions: ExclusionSet): Promise<SliceIngestor | { error: string }> {
  if ((await getCrmProviderId()) === 'hubspot') {
    const { getHubspotConfig } = await import('../../hubspot/config.js')
    if (!(await getHubspotConfig())) return { error: 'hubspot_not_connected' }
    const { prepareHubspotHistorical, ingestHubspotSlice } = await import('../../hubspot/historical.js')
    const ctx = await prepareHubspotHistorical()
    return (from, to, runId, dryRun) => ingestHubspotSlice(ctx, maps, exclusions, from, to, runId, dryRun)
  }
  const conn = await getAdminSfConnection()
  if (!conn) return { error: 'no_admin_sf_connection' }
  const soqlFields = (await filterKnownFields(conn, 'Event', EVENT_FIELDS)).join(', ')
  return (from, to, runId, dryRun) => ingestSlice(conn, maps, soqlFields, from, to, runId, dryRun, exclusions)
}

/**
 * Runs a single slice without writing, for pre-flight validation of match
 * rates before committing the full import.
 */
export async function dryRunBackfillSlice(): Promise<{ stats: SliceStats; sliceFrom: string; sliceTo: string } | { error: string }> {
  const state = await ensureState()
  const maps = await loadLinkageMaps()
  const exclusions = await loadExclusions()
  const ingest = await makeIngestor(maps, exclusions)
  if (typeof ingest !== 'function') return ingest
  const sliceTo = new Date(state.cursorBefore)
  const sliceFrom = new Date(
    Math.max(sliceTo.getTime() - state.sliceDays * 24 * 60 * 60 * 1000, new Date(state.floorAt).getTime()),
  )
  const stats = await ingest(sliceFrom, sliceTo, null, true)
  return { stats, sliceFrom: sliceFrom.toISOString(), sliceTo: sliceTo.toISOString() }
}

/**
 * Starts (or resumes) the backfill walker. Returns immediately; the walk runs
 * detached and reports progress through crm_historical_backfill_state and
 * crm_historical_import_runs.
 */
export async function startBackfill(triggeredBy: string | null): Promise<BackfillStatus | { error: string }> {
  const state = await ensureState()
  if (walkerRunning || state.status === 'running') return { error: 'already_running' }
  if (new Date(state.cursorBefore).getTime() <= new Date(state.floorAt).getTime()) {
    return { error: 'already_complete' }
  }
  await db
    .update(crmHistoricalBackfillState)
    .set({ status: 'running', lastError: null, startedAt: state.startedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))

  void runWalker(triggeredBy).catch(() => {})
  return getBackfillStatus()
}

export async function pauseBackfill(): Promise<BackfillStatus> {
  await db
    .update(crmHistoricalBackfillState)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
  return getBackfillStatus()
}

/**
 * Resets the cursor to now(), so the next start re-walks the full window.
 * This is also the point at which a changed lookback setting takes effect —
 * it's the only operation that legitimately rewrites floorAt.
 */
export async function resetBackfill(floorOverride?: Date): Promise<BackfillStatus> {
  const floorAt = floorOverride ?? await resolveFloorAt()
  const now = new Date()
  await db
    .update(crmHistoricalBackfillState)
    .set({
      cursorBefore: now,
      floorAt,
      status: 'idle',
      totalEventsImported: 0,
      totalSlicesDone: 0,
      lastError: null,
      startedAt: null,
      updatedAt: now,
    })
    .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
  return getBackfillStatus()
}

/**
 * Moves the state floor to the configured window, but ONLY when the backfill
 * has nothing to lose — not running, no slices done, no events imported.
 *
 * The general rule is that a window change waits for Reset cursor, because
 * rewriting floorAt mid-import either abandons rows already stored or
 * re-walks ground already covered. Neither applies to a backfill that has
 * never run, and that's the common case: an admin configures the window
 * before the first import. Making them click Save and then Reset cursor to
 * change a number on a table with zero rows is ceremony, and the page
 * meanwhile shows a stale "earliest" date that looks like the save failed.
 *
 * Returns true when the floor moved.
 */
export async function applyWindowIfUntouched(): Promise<boolean> {
  if (walkerRunning) return false
  const [existing] = await db
    .select()
    .from(crmHistoricalBackfillState)
    .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
    .limit(1)
  // No row yet means ensureState() will read the configured window anyway.
  if (!existing) return false
  if (existing.status === 'running') return false
  if ((existing.totalSlicesDone ?? 0) > 0 || (existing.totalEventsImported ?? 0) > 0) return false
  const floorAt = await resolveFloorAt()
  if (existing.floorAt && existing.floorAt.getTime() === floorAt.getTime()) return false
  await db
    .update(crmHistoricalBackfillState)
    .set({ floorAt, cursorBefore: new Date(), status: 'idle', lastError: null, updatedAt: new Date() })
    .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
  return true
}

async function runWalker(triggeredBy: string | null): Promise<void> {
  if (walkerRunning) return
  walkerRunning = true
  const sessionStartedAt = new Date()
  let sessionEvents = 0
  let sessionSlices = 0
  let sessionError: string | null = null

  try {
    // Loaded once per session, not per slice.
    const maps = await loadLinkageMaps()
    const exclusions = await loadExclusions()
    const ingest = await makeIngestor(maps, exclusions)
    if (typeof ingest !== 'function') {
      sessionError = ingest.error
      await db
        .update(crmHistoricalBackfillState)
        .set({ status: 'error', lastError: sessionError, updatedAt: new Date() })
        .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
      return
    }

    for (;;) {
      const [state] = await db
        .select()
        .from(crmHistoricalBackfillState)
        .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
        .limit(1)
      if (!state || state.status !== 'running') break

      const cursor = new Date(state.cursorBefore).getTime()
      const floor = new Date(state.floorAt).getTime()
      if (cursor <= floor) {
        await db
          .update(crmHistoricalBackfillState)
          .set({ status: 'complete', updatedAt: new Date() })
          .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
        break
      }

      let sliceDays = state.sliceDays
      const sliceTo = new Date(cursor)
      let sliceFrom = new Date(Math.max(cursor - sliceDays * 24 * 60 * 60 * 1000, floor))

      const [run] = await db
        .insert(crmHistoricalImportRuns)
        .values({ status: 'running', kind: 'backfill', triggeredBy, sliceFrom, sliceTo })
        .returning({ id: crmHistoricalImportRuns.id })
      const runId = run!.id
      const runStartedAt = new Date()

      try {
        let stats = await ingest(sliceFrom, sliceTo, runId, false)

        // Adaptive guard: a slice that came back huge means this stretch of
        // history is dense. Narrow the window for the remainder.
        if (stats.eventsFetched > SLICE_ROW_CEILING && sliceDays > MIN_SLICE_DAYS) {
          sliceDays = Math.max(MIN_SLICE_DAYS, Math.floor(sliceDays / 2))
          sliceFrom = new Date(Math.max(cursor - sliceDays * 24 * 60 * 60 * 1000, floor))
          stats = await ingest(sliceFrom, sliceTo, runId, false)
        }

        sessionEvents += stats.eventsInserted
        sessionSlices += 1

        await db
          .update(crmHistoricalImportRuns)
          .set({
            status: 'ok',
            finishedAt: new Date(),
            durationMs: Date.now() - runStartedAt.getTime(),
            sliceFrom,
            eventsFetched: stats.eventsFetched,
            eventsInserted: stats.eventsInserted,
            eventsSkipped: stats.eventsSkipped,
            eventsExcluded: stats.eventsExcluded,
            oppsUpserted: stats.oppsUpserted,
            accountsUpserted: stats.accountsUpserted,
            usersMatched: stats.usersMatched,
            usersUnmatched: stats.usersUnmatched,
            typesMatched: stats.typesMatched,
            typesUnmatched: stats.typesUnmatched,
            crmApiCalls: stats.crmApiCalls,
            detail: {
              unmatchedTypeSamples: stats.unmatchedTypeSamples,
              unmatchedOwnerSamples: stats.unmatchedOwnerSamples,
              // Non-zero means more active rules than fit the SOQL clause; the
              // remainder were caught in-process. Surfaced so it can't hide.
              exclusionOverflow: exclusions.overflow,
            },
          })
          .where(eq(crmHistoricalImportRuns.id, runId))

        // Cursor advances only now that the slice is committed. A crash
        // before this point simply replays the slice (idempotent).
        await db
          .update(crmHistoricalBackfillState)
          .set({
            cursorBefore: sliceFrom,
            sliceDays,
            lastRunId: runId,
            totalEventsImported: state.totalEventsImported + stats.eventsInserted,
            totalSlicesDone: state.totalSlicesDone + 1,
            updatedAt: new Date(),
          })
          .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
      } catch (e) {
        sessionError = e instanceof Error ? e.message : String(e)
        await db
          .update(crmHistoricalImportRuns)
          .set({
            status: 'error',
            finishedAt: new Date(),
            durationMs: Date.now() - runStartedAt.getTime(),
            error: sessionError,
          })
          .where(eq(crmHistoricalImportRuns.id, runId))
        await db
          .update(crmHistoricalBackfillState)
          .set({ status: 'error', lastError: sessionError, updatedAt: new Date() })
          .where(eq(crmHistoricalBackfillState.key, BACKFILL_KEY))
        break
      }

      await new Promise((r) => setTimeout(r, SLICE_BREATHER_MS))
    }
  } finally {
    walkerRunning = false
    // One summary job_runs row per session, so the backfill inherits the
    // Scheduling page and its error-notification path.
    await writeRun(
      HISTORICAL_BACKFILL_JOB_KEY,
      sessionStartedAt,
      sessionError ? 'error' : 'ok',
      sessionError,
      { sessionEvents, sessionSlices },
    )
  }
}
