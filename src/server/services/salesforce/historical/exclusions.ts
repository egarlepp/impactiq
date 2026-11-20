import { db } from '../../../db/index.js'
import { crmHistoricalEvents, crmHistoricalExclusions } from '../../../../../drizzle/schema.js'
import { and, eq, sql, inArray, isNull, desc } from 'drizzle-orm'
import { sfIdKeys } from './linkage.js'

// v1.215.0: admin-managed exclusion of machine-generated Salesforce Events.
//
// Why this exists: a sales-engagement integration (Outreach, for example) can
// create a third or more of the Events the historical import targets, most of
// them Type 'Meeting'. Importing them would make the largest activity type in
// the history meaningless.
//
// Why it can't be automatic: the Outreach user has UserType 'Standard' and a
// System Administrator profile. So do ZoomInfo, GONG, and Marketo. There is
// no field that distinguishes an integration user from a person, so the only
// honest implementation is an explicit list an admin maintains.
//
// Two independent rules: exclude by who CREATED the Event (the Outreach case —
// it creates records and assigns them to human owners) and, separately, by who
// OWNS it (for shared/service accounts).

export type ExclusionKind = 'created_by' | 'owner'
export const EXCLUSION_KINDS: ExclusionKind[] = ['created_by', 'owner']

export function isExclusionKind(v: unknown): v is ExclusionKind {
  return v === 'created_by' || v === 'owner'
}

/** Salesforce User Id, 15- or 18-char. */
export const SF_USER_ID_RX = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/

/**
 * Max ids per kind embedded in the SOQL WHERE clause. At ~21 chars per literal
 * that's ~5.3k characters per clause, far inside Salesforce's 100k statement
 * limit and its 4,000-literal IN cap. The cap exists so a runaway UI or a bad
 * bulk paste can't produce an unparseable query — not because 250 automation
 * users is a real business boundary. Anything past it still gets caught by the
 * in-process backstop.
 */
export const MAX_SOQL_EXCLUSION_IDS = 250

export interface ExclusionSet {
  /** Both 15- and 18-char forms, for in-process matching. */
  createdBy: Set<string>
  owner: Set<string>
  /** Capped, sanitized 18-char ids for the SOQL clause. */
  createdBySoql: string[]
  ownerSoql: string[]
  /** How many active rules didn't fit in the SOQL clause. */
  overflow: number
}

export function emptyExclusionSet(): ExclusionSet {
  return { createdBy: new Set(), owner: new Set(), createdBySoql: [], ownerSoql: [], overflow: 0 }
}

/**
 * Loads active rules. Call ONCE per import run, alongside loadLinkageMaps() —
 * never per row.
 */
export async function loadExclusions(): Promise<ExclusionSet> {
  const rows = await db
    .select({
      kind: crmHistoricalExclusions.kind,
      crmUserId: crmHistoricalExclusions.crmUserId,
      createdAt: crmHistoricalExclusions.createdAt,
    })
    .from(crmHistoricalExclusions)
    .where(eq(crmHistoricalExclusions.isActive, true))
    // Oldest rules win a place in the SOQL clause — stable across runs.
    .orderBy(crmHistoricalExclusions.createdAt)

  const set = emptyExclusionSet()
  for (const r of rows) {
    const target = r.kind === 'owner' ? set.owner : set.createdBy
    const soql = r.kind === 'owner' ? set.ownerSoql : set.createdBySoql
    for (const k of sfIdKeys(r.crmUserId)) target.add(k)
    const clean = sanitizeSfId(r.crmUserId)
    if (!clean) continue
    if (soql.length < MAX_SOQL_EXCLUSION_IDS) soql.push(clean)
    else set.overflow += 1
  }
  return set
}

function sanitizeSfId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '')
}

/**
 * In-process backstop. Runs unconditionally, even when the SOQL clause already
 * filtered — that's what makes enforcement independent of whether the id made
 * it into the query (cap overflow, a 15/18 mismatch, an id sanitized away).
 * A Set lookup per row is free next to what ingest already does.
 */
export function isExcluded(
  set: ExclusionSet,
  createdById: string | null | undefined,
  ownerId: string | null | undefined,
): ExclusionKind | null {
  if (createdById && set.createdBy.size > 0) {
    for (const k of sfIdKeys(createdById)) if (set.createdBy.has(k)) return 'created_by'
  }
  if (ownerId && set.owner.size > 0) {
    for (const k of sfIdKeys(ownerId)) if (set.owner.has(k)) return 'owner'
  }
  return null
}

/**
 * SOQL fragment appended to the Event query, so excluded rows are never
 * fetched, paged, or staged at all. Excluding Outreach alone drops a third of
 * everything retrieved — post-fetch filtering would pay full API and ingest
 * cost for data already known to be garbage.
 *
 * Returns '' when a list is empty; `NOT IN ()` is a syntax error, and an
 * always-present clause would burden orgs with no exclusions configured.
 */
export function exclusionSoqlClause(set: ExclusionSet): string {
  const parts: string[] = []
  if (set.createdBySoql.length > 0) {
    parts.push(` AND CreatedById NOT IN (${set.createdBySoql.map((id) => `'${id}'`).join(',')})`)
  }
  if (set.ownerSoql.length > 0) {
    parts.push(` AND OwnerId NOT IN (${set.ownerSoql.map((id) => `'${id}'`).join(',')})`)
  }
  return parts.join('')
}

// --- admin-facing queries ---------------------------------------------------

/** The column an exclusion of this kind matches against. */
function columnFor(kind: ExclusionKind) {
  return kind === 'owner' ? crmHistoricalEvents.ownerCrmUserId : crmHistoricalEvents.createdByCrmUserId
}

export interface ExclusionMatch {
  matchedRows: number
  estimatedHours: number
  /**
   * Imported rows with no creator recorded. Only ever non-zero if rows were
   * imported before migration 0112 added the column — in which case a
   * created_by purge can't see them, and the UI must say so rather than
   * reporting a misleading zero.
   */
  matchedRowsNullCreatedBy: number
}

export async function countMatchingEvents(kind: ExclusionKind, crmUserId: string): Promise<ExclusionMatch> {
  const keys = sfIdKeys(crmUserId)
  const [agg] = (await db
    .select({
      matchedRows: sql<number>`count(*)::int`,
      estimatedHours: sql<number>`coalesce(sum(${crmHistoricalEvents.estimatedHours}), 0)::float8`,
    })
    .from(crmHistoricalEvents)
    .where(inArray(columnFor(kind), keys))) as Array<{ matchedRows: number; estimatedHours: number }>

  let nullCreatedBy = 0
  if (kind === 'created_by') {
    const [n] = (await db
      .select({ c: sql<number>`count(*)::int` })
      .from(crmHistoricalEvents)
      .where(isNull(crmHistoricalEvents.createdByCrmUserId))) as Array<{ c: number }>
    nullCreatedBy = n?.c ?? 0
  }

  return {
    matchedRows: agg?.matchedRows ?? 0,
    estimatedHours: Math.round((agg?.estimatedHours ?? 0) * 10) / 10,
    matchedRowsNullCreatedBy: nullCreatedBy,
  }
}

const PURGE_CHUNK = 5000

/**
 * Deletes imported events matching a rule, in chunks. One 16k-row DELETE would
 * be survivable but pointlessly holds locks and bloats WAL.
 *
 * Only crm_historical_events is touched. Run rows are left alone (so 0111's
 * provenance invariant holds), and orphaned rows in the Opportunity/Account
 * mirrors are left alone too — those are keyed independently, are cheap, and
 * get reused the moment another event links to the same record.
 */
export async function purgeMatchingEvents(kind: ExclusionKind, crmUserId: string): Promise<number> {
  const keys = sfIdKeys(crmUserId)
  const col = kind === 'owner' ? 'owner_crm_user_id' : 'created_by_crm_user_id'
  let deleted = 0
  for (;;) {
    // RETURNING rather than relying on a driver-specific affected-row count —
    // postgres.js reports that on a property of the result array, which is easy
    // to read as 0 and silently stop the loop after one chunk.
    const rows = (await db.execute(sql`
      DELETE FROM crm_historical_events
       WHERE ctid IN (
         SELECT ctid FROM crm_historical_events
          WHERE ${sql.raw(col)} IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
          LIMIT ${PURGE_CHUNK}
       )
      RETURNING crm_event_id
    `)) as unknown as unknown[]
    const n = Array.isArray(rows) ? rows.length : 0
    deleted += n
    if (n < PURGE_CHUNK) break
  }
  await db
    .update(crmHistoricalExclusions)
    .set({ lastPurgedAt: new Date(), purgedCount: sql`${crmHistoricalExclusions.purgedCount} + ${deleted}`, updatedAt: new Date() })
    .where(and(eq(crmHistoricalExclusions.kind, kind), eq(crmHistoricalExclusions.crmUserId, crmUserId)))
  return deleted
}

export interface TopCreator {
  createdByCrmUserId: string | null
  createdByName: string | null
  count: number
  estimatedHours: number
  alreadyExcluded: boolean
}

/**
 * Most prolific Event creators among imported rows. This is what an admin uses
 * to find automation accounts without hunting for User Ids in Salesforce.
 */
export async function listTopCreators(limit = 20): Promise<TopCreator[]> {
  const rows = (await db
    .select({
      createdByCrmUserId: crmHistoricalEvents.createdByCrmUserId,
      createdByName: sql<string | null>`max(${crmHistoricalEvents.createdByCrmUserName})`,
      count: sql<number>`count(*)::int`,
      estimatedHours: sql<number>`coalesce(sum(${crmHistoricalEvents.estimatedHours}), 0)::float8`,
    })
    .from(crmHistoricalEvents)
    .groupBy(crmHistoricalEvents.createdByCrmUserId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit)) as Array<{
    createdByCrmUserId: string | null
    createdByName: string | null
    count: number
    estimatedHours: number
  }>

  const active = await loadExclusions()
  return rows.map((r) => ({
    ...r,
    estimatedHours: Math.round(r.estimatedHours * 10) / 10,
    alreadyExcluded: !!r.createdByCrmUserId && isExcluded(active, r.createdByCrmUserId, null) === 'created_by',
  }))
}

/**
 * Rows still present that an active rule would have excluded. Surfaced on the
 * admin page so an add-without-purge can't rot silently — the read path
 * deliberately doesn't filter on exclusions, so purge is the only remedy.
 */
export async function countUnpurged(): Promise<number> {
  const set = await loadExclusions()
  if (set.createdBy.size === 0 && set.owner.size === 0) return 0
  const conds = []
  if (set.createdBy.size > 0) {
    conds.push(sql`${crmHistoricalEvents.createdByCrmUserId} IN (${sql.join(Array.from(set.createdBy).map((k) => sql`${k}`), sql`, `)})`)
  }
  if (set.owner.size > 0) {
    conds.push(sql`${crmHistoricalEvents.ownerCrmUserId} IN (${sql.join(Array.from(set.owner).map((k) => sql`${k}`), sql`, `)})`)
  }
  const [row] = (await db
    .select({ c: sql<number>`count(*)::int` })
    .from(crmHistoricalEvents)
    .where(sql`(${sql.join(conds, sql` OR `)})`)) as Array<{ c: number }>
  return row?.c ?? 0
}

export async function listExclusions() {
  return db
    .select()
    .from(crmHistoricalExclusions)
    .orderBy(crmHistoricalExclusions.kind, crmHistoricalExclusions.createdAt)
}
