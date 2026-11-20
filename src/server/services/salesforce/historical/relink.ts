import { db } from '../../../db/index.js'
import { crmHistoricalEvents, crmHistoricalImportRuns } from '../../../../../drizzle/schema.js'
import { isNull, sql } from 'drizzle-orm'
import { loadLinkageMaps, resolveEventLinkage, estimateHours } from './linkage.js'
import { clearHistoricalRecomputeNeeded } from '../../config/integrations.js'

// v1.213.0: re-resolves user / team / activity-type linkage for already-
// imported historical events, using ONLY local tables. No Salesforce calls.
//
// v1.215.0: also recomputes estimated_hours against the admin-configured
// all-day cap. That column is stored (six SQL aggregation sites read it), so
// lowering the cap would otherwise leave every all-day row stale. This pass is
// already the "make local derived state consistent with local config" verb and
// already walks every row, so widening it beats a second identical walk.
//
// This is what makes the import recoverable. Without it, the only remedy for
// a wrong mapping — an admin backfilling users.crm_user_id, or adding a
// crm_historical_type_map override for an SF Type the ladders couldn't
// resolve — would be re-importing three years of data from Salesforce.
// With it, the fix is a few minutes of local UPDATEs.

const PAGE = 2000
const UPDATE_CHUNK = 500

export interface RelinkResult {
  scanned: number
  changed: number
  hoursRecomputed: number
  usersMatched: number
  usersUnmatched: number
  typesMatched: number
  typesUnmatched: number
  durationMs: number
}

export async function runHistoricalRelink(triggeredBy: string | null): Promise<RelinkResult> {
  const startedAt = new Date()
  const result: RelinkResult = {
    scanned: 0,
    changed: 0,
    hoursRecomputed: 0,
    usersMatched: 0,
    usersUnmatched: 0,
    typesMatched: 0,
    typesUnmatched: 0,
    durationMs: 0,
  }

  const maps = await loadLinkageMaps()
  const now = new Date()

  // Keyset pagination on the primary key — stable under concurrent writes and
  // doesn't degrade the way OFFSET does across a large table.
  let after: string | null = null
  for (;;) {
    const rows: Array<{
      crmEventId: string
      ownerCrmUserId: string | null
      crmType: string | null
      userId: string | null
      teamId: string | null
      activityTypeId: string | null
      durationMinutes: number | null
      isAllDayEvent: boolean
      estimatedHours: string | null
    }> = await db
      .select({
        crmEventId: crmHistoricalEvents.crmEventId,
        ownerCrmUserId: crmHistoricalEvents.ownerCrmUserId,
        crmType: crmHistoricalEvents.crmType,
        userId: crmHistoricalEvents.userId,
        teamId: crmHistoricalEvents.teamId,
        activityTypeId: crmHistoricalEvents.activityTypeId,
        durationMinutes: crmHistoricalEvents.durationMinutes,
        isAllDayEvent: crmHistoricalEvents.isAllDayEvent,
        estimatedHours: crmHistoricalEvents.estimatedHours,
      })
      .from(crmHistoricalEvents)
      .where(after ? sql`${crmHistoricalEvents.crmEventId} > ${after}` : sql`true`)
      .orderBy(sql`${crmHistoricalEvents.crmEventId} ASC`)
      .limit(PAGE)
    if (rows.length === 0) break
    after = rows[rows.length - 1]!.crmEventId

    const changed: Array<{
      crmEventId: string
      userId: string | null
      teamId: string | null
      activityTypeId: string | null
      userMatchMethod: string | null
      typeMatchMethod: string | null
      estimatedHours: string | null
    }> = []

    for (const r of rows) {
      result.scanned += 1
      const link = resolveEventLinkage(maps, r.ownerCrmUserId, r.crmType)
      if (link.userId) result.usersMatched += 1
      else result.usersUnmatched += 1
      if (link.activityTypeId) result.typesMatched += 1
      else result.typesUnmatched += 1

      // numeric(6,2) round-trips as a fixed-2 string, and estimateHours also
      // returns toFixed(2), so string comparison is exact and dodges float noise.
      const hours = estimateHours(r.durationMinutes, r.isAllDayEvent, maps.allDayCapHours)
      const hoursChanged = hours !== r.estimatedHours
      if (hoursChanged) result.hoursRecomputed += 1

      if (
        hoursChanged ||
        link.userId !== r.userId ||
        link.teamId !== r.teamId ||
        link.activityTypeId !== r.activityTypeId
      ) {
        changed.push({
          crmEventId: r.crmEventId,
          userId: link.userId,
          teamId: link.teamId,
          activityTypeId: link.activityTypeId,
          userMatchMethod: link.userMatchMethod,
          typeMatchMethod: link.typeMatchMethod,
          estimatedHours: hours,
        })
      }
    }

    for (let i = 0; i < changed.length; i += UPDATE_CHUNK) {
      const chunk = changed.slice(i, i + UPDATE_CHUNK)
      const values = sql.join(
        chunk.map(
          (c) =>
            sql`(${c.crmEventId}, ${c.userId}::uuid, ${c.teamId}::uuid, ${c.activityTypeId}::uuid, ${c.userMatchMethod}, ${c.typeMatchMethod}, ${c.estimatedHours}::numeric)`,
        ),
        sql`, `,
      )
      await db.execute(sql`
        UPDATE crm_historical_events AS e SET
          user_id = v.user_id,
          team_id = v.team_id,
          activity_type_id = v.activity_type_id,
          user_match_method = v.user_match_method,
          type_match_method = v.type_match_method,
          estimated_hours = v.estimated_hours,
          relinked_at = ${now}
        FROM (VALUES ${values}) AS v(crm_event_id, user_id, team_id, activity_type_id, user_match_method, type_match_method, estimated_hours)
        WHERE e.crm_event_id = v.crm_event_id
      `)
      result.changed += chunk.length
    }

    if (rows.length < PAGE) break
  }

  result.durationMs = Date.now() - startedAt.getTime()
  // Estimates now match the configured cap.
  try {
    await clearHistoricalRecomputeNeeded()
  } catch {
    // Non-fatal: the flag is a UI hint, not correctness.
  }
  try {
    await db.insert(crmHistoricalImportRuns).values({
      status: 'ok',
      kind: 'relink',
      triggeredBy,
      startedAt,
      finishedAt: new Date(),
      durationMs: result.durationMs,
      eventsFetched: result.scanned,
      eventsInserted: result.changed,
      usersMatched: result.usersMatched,
      usersUnmatched: result.usersUnmatched,
      typesMatched: result.typesMatched,
      typesUnmatched: result.typesUnmatched,
      // Distinguishes a linkage-only pass from one that moved every estimate.
      detail: { hoursRecomputed: result.hoursRecomputed },
    })
  } catch {
    // Never let run auditing break the relink.
  }
  return result
}

/**
 * SF Type values across imported events that resolved to no local activity
 * type, with counts. Drives the read-only "unmapped types" panel on the
 * admin import page, which is the input an admin needs before adding
 * crm_historical_type_map overrides.
 */
export async function listUnmappedTypes(limit = 100) {
  const rows = await db
    .select({
      crmType: crmHistoricalEvents.crmType,
      teamId: crmHistoricalEvents.teamId,
      count: sql<number>`count(*)::int`,
    })
    .from(crmHistoricalEvents)
    .where(isNull(crmHistoricalEvents.activityTypeId))
    .groupBy(crmHistoricalEvents.crmType, crmHistoricalEvents.teamId)
    .orderBy(sql`count(*) DESC`)
    .limit(limit)
  return rows
}
