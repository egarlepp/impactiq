import { db } from '../../db/index.js'
import { attachRateFields, crmOpportunityCoverage, attachRateHistory, sfUserNames, crmSnapshotState } from '../../../../drizzle/schema.js'
import { eq, and, or, isNull, lt, sql } from 'drizzle-orm'
import { getAdminSfConnection } from './client.js'
import { filterKnownFields, queryAllPaged, soqlDateTime } from './soqlHelpers.js'
import { writeRun } from '../jobs/writeRun.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { getDemoTeamId, isDemoCrmId } from '../demo/ids.js'

// v1.188.0: refresh the local Attach Rate opportunity snapshot. Pulls the
// union of every team's active attach-rate fields for a bounded set of
// opportunities (all open, plus anything created or closed within the
// lookback window) and stores the SE user ids found in each field per opp.
// The dashboard then computes attach rate locally per team config, with no
// live SF call at view time.
//
// Runs on the admin SF connection so it works tenant-wide without a user
// context. Upserts into the snapshot each run; rows are never wholesale
// replaced (see the age-based cull below) — see v1.213.0 note.
//
// v1.213.0: incremental refresh. Once a prior run has left a watermark
// (crm_snapshot_state key 'opp_coverage'), the main query and every
// related-object rollup query add `SystemModstamp >= watermark`, so a
// night with few changed Opportunities/Evaluations pulls only those
// records instead of the full ~open + 2yr window every time. Because the
// per-run result set no longer represents "every opp currently in
// scope," the old cull ("delete anything not touched this run") would
// wrongly delete every unchanged row — replaced with an age-based cull
// that only removes rows that have aged out of the lookback window. The
// open-pipeline attach-rate history snapshot (used for Compare/trend) is
// now computed by reading the current full table state after the
// upsert, not from the in-memory `staged` batch, since `staged` may only
// contain a fraction of all open opps on an incremental run.

const SF_FIELD_PATH = /^[A-Za-z0-9_.]{1,80}$/
const SOBJECT_RX = /^[A-Za-z0-9_]{1,80}$/
// Salesforce record ids are 15 or 18 char alphanumerics — used to tell a
// user-lookup value (resolve to a name) from an already-name value.
const SF_ID_RX = /^[A-Za-z0-9]{15}$|^[A-Za-z0-9]{18}$/
// How far back to keep closed/created opps. Two years covers the widest
// dashboard window (all-time is capped to this on the read side).
export const LOOKBACK_DAYS = 730
const PAGE_SIZE = 2000
const USER_ID_CHUNK = 200 // SOQL IN(...) cap for the User name lookup
export const MAX_OPPS = 100_000 // hard backstop so a huge org can't run unbounded
const SAFETY_BUFFER_MS = 15 * 60 * 1000 // clock-skew guard, mirrors refreshOppSnapshots

async function readWatermark(key: string): Promise<Date | null> {
  const [row] = await db.select().from(crmSnapshotState).where(eq(crmSnapshotState.key, key)).limit(1)
  if (!row?.refreshedAt) return null
  return new Date(row.refreshedAt.getTime() - SAFETY_BUFFER_MS)
}

export interface CoverageRefreshResult {
  fieldsUsed: string[]
  oppsScanned: number
  oppsStored: number
  errors: string[]
  durationMs: number
}

export interface CoverageRow {
  oppId: string
  createdDate: string | null
  closeDate: string | null
  stageName: string | null
  forecastCategory: string | null
  isClosed: boolean
  ownerId: string | null
  ownerName: string | null
  amount: string | null
  totalAcv: string | null
  oppName: string | null
  fieldValues: Record<string, string[]>
  snapshotAt: Date
}

// Resolve a possibly-dotted field path against a record.
function resolvePath(rec: Record<string, unknown>, path: string): unknown {
  let cur: unknown = rec
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

export async function refreshOppCoverage(): Promise<CoverageRefreshResult> {
  const startedAt = new Date()
  const result: CoverageRefreshResult = { fieldsUsed: [], oppsScanned: 0, oppsStored: 0, errors: [], durationMs: 0 }
  const watermark = await readWatermark('opp_coverage')
  const modstampClause = watermark ? ` AND SystemModstamp >= ${soqlDateTime(watermark)}` : ''

  // Every team's active attach fields, grouped by SF object. Fields whose
  // object is Opportunity are read on the Opportunity query; fields on any
  // other object (e.g. Evaluations__c) are read from that object and rolled
  // up to their parent Opportunity via the configured link field.
  const cfgRows = await db
    .select({ fieldApi: attachRateFields.fieldApi, crmObject: attachRateFields.crmObject, oppLinkField: attachRateFields.oppLinkField })
    .from(attachRateFields)
    .where(eq(attachRateFields.isActive, true))
  const oppFields = Array.from(new Set(
    cfgRows.filter((r) => (r.crmObject ?? '').toLowerCase() === 'opportunity')
      .map((r) => r.fieldApi).filter((f) => SF_FIELD_PATH.test(f)),
  ))
  // object (lower-cased original preserved) → { fields, linkField }
  const relObjects = new Map<string, { object: string; fields: Set<string>; linkField: string }>()
  for (const r of cfgRows) {
    const obj = r.crmObject ?? ''
    if (obj.toLowerCase() === 'opportunity') continue
    if (!SOBJECT_RX.test(obj) || !SF_FIELD_PATH.test(r.fieldApi)) continue
    const link = r.oppLinkField && SOBJECT_RX.test(r.oppLinkField) ? r.oppLinkField : 'Opportunity__c'
    const entry = relObjects.get(obj) ?? { object: obj, fields: new Set<string>(), linkField: link }
    entry.fields.add(r.fieldApi)
    // First non-default link field wins for the object.
    if (r.oppLinkField && SOBJECT_RX.test(r.oppLinkField)) entry.linkField = r.oppLinkField
    relObjects.set(obj, entry)
  }
  if (oppFields.length === 0 && relObjects.size === 0) {
    await writeRun('refresh_opp_coverage', startedAt, 'ok', 'no_attach_fields_configured', result)
    result.durationMs = Date.now() - startedAt.getTime()
    return result
  }

  const conn = await getAdminSfConnection()
  if (!conn) {
    result.errors.push('no_admin_sf_connection')
    await writeRun('refresh_opp_coverage', startedAt, 'error', 'no_admin_sf_connection', result)
    result.durationMs = Date.now() - startedAt.getTime()
    return result
  }

  // Validate Opportunity fields against the org so a mis-typed API name
  // doesn't fail the whole query (mirrors refreshOppSnapshots).
  const validOppFields = await filterKnownFields(conn, 'Opportunity', oppFields, (msg) =>
    result.errors.push(msg),
  )
  result.fieldsUsed = [...validOppFields.map((f) => `Opportunity::${f}`)]

  const soqlFields = ['Id', 'Name', 'CreatedDate', 'CloseDate', 'StageName', 'ForecastCategoryName', 'IsClosed', 'OwnerId', 'Owner.Name', 'Amount', 'Total_Acv__c', ...validOppFields].join(', ')
  const soql = `SELECT ${soqlFields} FROM Opportunity ` +
    `WHERE (IsClosed = false OR CreatedDate >= LAST_N_DAYS:${LOOKBACK_DAYS} OR CloseDate >= LAST_N_DAYS:${LOOKBACK_DAYS})${modstampClause}`

  const staged: CoverageRow[] = []
  const stagedById = new Map<string, CoverageRow>()
  try {
    const consume = (records: Record<string, unknown>[]) => {
      for (const rec of records) {
        if (staged.length >= MAX_OPPS) break
        const oppId = String(rec['Id'] ?? '')
        if (!oppId) continue
        const fieldValues: Record<string, string[]> = {}
        for (const f of validOppFields) {
          const v = resolvePath(rec, f)
          if (v == null) continue
          const ids = String(v).split(';').map((s) => s.trim()).filter(Boolean)
          if (ids.length > 0) fieldValues[`Opportunity::${f}`] = Array.from(new Set(ids))
        }
        const createdRaw = rec['CreatedDate'] != null ? String(rec['CreatedDate']) : null
        const row: CoverageRow = {
          oppId,
          createdDate: createdRaw ? createdRaw.slice(0, 10) : null,
          closeDate: rec['CloseDate'] != null ? String(rec['CloseDate']).slice(0, 10) : null,
          stageName: rec['StageName'] != null ? String(rec['StageName']) : null,
          forecastCategory: rec['ForecastCategoryName'] != null ? String(rec['ForecastCategoryName']) : null,
          isClosed: !!rec['IsClosed'],
          ownerId: rec['OwnerId'] != null ? String(rec['OwnerId']) : null,
          ownerName: (rec['Owner'] as { Name?: string } | null)?.Name ?? null,
          amount: rec['Amount'] != null ? String(rec['Amount']) : null,
          totalAcv: rec['Total_Acv__c'] != null ? String(rec['Total_Acv__c']) : null,
          oppName: rec['Name'] != null ? String(rec['Name']) : null,
          fieldValues,
          snapshotAt: startedAt,
        }
        staged.push(row)
        stagedById.set(oppId, row)
      }
    }
    await queryAllPaged<Record<string, unknown>>(conn, soql, consume, { max: MAX_OPPS })
  } catch (e) {
    result.errors.push(`query: ${e instanceof Error ? e.message : String(e)}`)
    await writeRun('refresh_opp_coverage', startedAt, 'error', result.errors[0] ?? null, result)
    result.durationMs = Date.now() - startedAt.getTime()
    return result
  }
  result.oppsScanned = staged.length

  // Related-object rollup: for each non-Opportunity object, read its rows and
  // fold the engineer values onto the parent opp already in the snapshot.
  // On an incremental run a changed related record's parent Opp may not
  // itself have changed (so it's absent from `staged`) — those merges are
  // collected here and written directly to the DB below instead of being
  // silently dropped.
  const orphanFieldUpdates = new Map<string, Record<string, string[]>>()
  for (const { object, fields, linkField } of relObjects.values()) {
    try {
      const meta = await conn.sobject(object).describe()
      const known = new Set<string>((meta.fields ?? []).map((f) => (f.name ?? '').toLowerCase()))
      if (!known.has(linkField.toLowerCase())) { result.errors.push(`${object}: link field ${linkField} not found`); continue }
      const useFields = Array.from(fields).filter((f) => known.has(f.toLowerCase()))
      if (useFields.length === 0) { result.errors.push(`${object}: no valid fields`); continue }
      result.fieldsUsed.push(...useFields.map((f) => `${object}::${f}`))
      const relSoql = `SELECT Id, ${linkField}, ${useFields.join(', ')} FROM ${object} WHERE ${linkField} != null${modstampClause}`
      let scanned = 0
      const foldIn = (records: Record<string, unknown>[]) => {
        for (const rec of records) {
          if (scanned >= MAX_OPPS) break
          scanned += 1
          const oppId = String(rec[linkField] ?? '')
          if (!oppId) continue
          const row = stagedById.get(oppId)
          if (row) {
            for (const f of useFields) {
              const v = rec[f]
              if (v == null) continue
              const ids = String(v).split(';').map((s) => s.trim()).filter(Boolean)
              if (ids.length === 0) continue
              const key = `${object}::${f}`
              const merged = new Set([...(row.fieldValues[key] ?? []), ...ids])
              row.fieldValues[key] = Array.from(merged)
            }
            continue
          }
          // Opp wasn't re-pulled this run (unchanged) but its related record
          // was — merge into whatever coverage row already exists for it.
          const orphan = orphanFieldUpdates.get(oppId) ?? {}
          for (const f of useFields) {
            const v = rec[f]
            if (v == null) continue
            const ids = String(v).split(';').map((s) => s.trim()).filter(Boolean)
            if (ids.length === 0) continue
            const key = `${object}::${f}`
            orphan[key] = Array.from(new Set([...(orphan[key] ?? []), ...ids]))
          }
          orphanFieldUpdates.set(oppId, orphan)
        }
      }
      await queryAllPaged<Record<string, unknown>>(conn, relSoql, foldIn, { max: MAX_OPPS })
    } catch (e) {
      result.errors.push(`rel_${object}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Resolve Salesforce User Ids found in the attach-field values to display
  // names so the dashboard's per-SE breakdown never shows raw ids (covers SF
  // users who aren't ImpactIQ users too).
  try {
    const ids = new Set<string>()
    for (const row of staged) {
      for (const vals of Object.values(row.fieldValues)) {
        for (const v of vals) if (SF_ID_RX.test(v)) ids.add(v)
      }
    }
    const idList = Array.from(ids)
    for (let i = 0; i < idList.length; i += USER_ID_CHUNK) {
      const chunk = idList.slice(i, i + USER_ID_CHUNK)
      const soql = `SELECT Id, Name FROM User WHERE Id IN (${chunk.map((id) => `'${id.replace(/[^A-Za-z0-9]/g, '')}'`).join(',')})`
      const r = await conn.query<{ Id: string; Name: string | null }>(soql)
      for (const rec of r.records) {
        await db.insert(sfUserNames).values({ sfUserId: rec.Id, name: rec.Name ?? null, refreshedAt: startedAt }).onConflictDoUpdate({
          target: sfUserNames.sfUserId,
          set: { name: sqlExcluded('name'), refreshedAt: sqlExcluded('refreshed_at') },
        })
      }
    }
  } catch (e) {
    result.errors.push(`user_names: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Upsert changed opps in chunks.
  {
    const up = await upsertCoverageRows(staged)
    result.oppsStored += up.stored
    result.errors.push(...up.errors)
  }

  // Merge related-object changes for opps whose parent Opp itself didn't
  // change this run (so it's not in `staged`, but already has a row from
  // an earlier run). jsonb `||` only touches the specific keys present in
  // the patch, leaving every other field_values key untouched.
  if (orphanFieldUpdates.size > 0) {
    try {
      const entries = Array.from(orphanFieldUpdates.entries())
      for (let i = 0; i < entries.length; i += PAGE_SIZE) {
        const chunk = entries.slice(i, i + PAGE_SIZE)
        const values = sql.join(
          chunk.map(([oppId, patch]) => sql`(${oppId}, ${JSON.stringify(patch)}::jsonb)`),
          sql`, `,
        )
        await db.execute(sql`
          UPDATE crm_opportunity_coverage AS c SET
            field_values = COALESCE(c.field_values, '{}'::jsonb) || v.patch,
            snapshot_at = now()
          FROM (VALUES ${values}) AS v(opp_id, patch)
          WHERE c.opp_id = v.opp_id
        `)
      }
    } catch (e) {
      result.errors.push(`orphan_merge: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Age-based cull: a wholesale "delete anything not touched this run"
  // (the old model) would delete every unchanged row on an incremental
  // run. Instead remove only rows that have genuinely aged out of scope.
  try {
    await cullAgedCoverage(startedAt)
  } catch (e) {
    result.errors.push(`cull: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Record today's open-pipeline attach rate per team (Compare + trend on
  // the Open Pipeline basis), from the CURRENT full table state.
  try {
    await recordAttachRateHistory(startedAt)
  } catch (e) {
    result.errors.push(`history: ${e instanceof Error ? e.message : String(e)}`)
  }

  result.durationMs = Date.now() - startedAt.getTime()
  const message = result.errors.length > 0
    ? result.errors[0] ?? null
    : `${result.oppsStored}/${result.oppsScanned} opps stored`
  await writeRun('refresh_opp_coverage', startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}

// EXCLUDED.<col> reference for onConflictDoUpdate (drizzle passes raw SQL).
function sqlExcluded(col: string) {
  return sql.raw(`excluded.${col}`)
}

// ── Shared with the HubSpot coverage refresh (services/hubspot/attachCoverage.ts) ──

// Upsert coverage rows in chunks; a failed chunk is reported, not thrown.
export async function upsertCoverageRows(rows: CoverageRow[]): Promise<{ stored: number; errors: string[] }> {
  const out = { stored: 0, errors: [] as string[] }
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE)
    try {
      await db.insert(crmOpportunityCoverage).values(chunk).onConflictDoUpdate({
        target: crmOpportunityCoverage.oppId,
        set: {
          createdDate: sqlExcluded('created_date'),
          closeDate: sqlExcluded('close_date'),
          stageName: sqlExcluded('stage_name'),
          forecastCategory: sqlExcluded('forecast_category'),
          isClosed: sqlExcluded('is_closed'),
          ownerId: sqlExcluded('owner_id'),
          ownerName: sqlExcluded('owner_name'),
          amount: sqlExcluded('amount'),
          totalAcv: sqlExcluded('total_acv'),
          oppName: sqlExcluded('opp_name'),
          fieldValues: sqlExcluded('field_values'),
          snapshotAt: sqlExcluded('snapshot_at'),
        },
      })
      out.stored += chunk.length
    } catch (e) {
      out.errors.push(`upsert_${i}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

// Closed opps whose close and created dates are both older than the lookback
// window, matching the refresh's own scope.
export async function cullAgedCoverage(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  await db.delete(crmOpportunityCoverage).where(and(
    eq(crmOpportunityCoverage.isClosed, true),
    or(isNull(crmOpportunityCoverage.closeDate), lt(crmOpportunityCoverage.closeDate, cutoff)),
    or(isNull(crmOpportunityCoverage.createdDate), lt(crmOpportunityCoverage.createdDate, cutoff)),
  ))
}

// Today's open-pipeline attach rate per team, one row per team per day.
export async function recordAttachRateHistory(now: Date): Promise<void> {
  const teamCfg = await db
    .select({ teamId: attachRateFields.teamId, fieldApi: attachRateFields.fieldApi, crmObject: attachRateFields.crmObject })
    .from(attachRateFields)
    .where(eq(attachRateFields.isActive, true))
  const keysByTeam = new Map<string, Set<string>>()
  for (const r of teamCfg) {
    if (!r.crmObject || !SF_FIELD_PATH.test(r.fieldApi)) continue
    const set = keysByTeam.get(r.teamId) ?? new Set<string>()
    set.add(`${r.crmObject}::${r.fieldApi}`)
    keysByTeam.set(r.teamId, set)
  }
  const openRows = await db
    .select({ oppId: crmOpportunityCoverage.oppId, fieldValues: crmOpportunityCoverage.fieldValues })
    .from(crmOpportunityCoverage)
    .where(eq(crmOpportunityCoverage.isClosed, false))
  const snapshotDate = now.toISOString().slice(0, 10)
  // Demo pipeline rows count only for the demo team, and only they do.
  const demoTeamId = await getDemoTeamId()
  for (const [teamId, keys] of keysByTeam) {
    let total = 0, attached = 0
    for (const r of openRows) {
      if (demoTeamId && isDemoCrmId(r.oppId) !== (teamId === demoTeamId)) continue
      total += 1
      const fv = (r.fieldValues ?? {}) as Record<string, string[]>
      let ok = false
      for (const k of keys) { const v = fv[k]; if (Array.isArray(v) && v.length > 0) { ok = true; break } }
      if (ok) attached += 1
    }
    await db.insert(attachRateHistory).values({ teamId, snapshotDate, total, attached }).onConflictDoUpdate({
      target: [attachRateHistory.teamId, attachRateHistory.snapshotDate],
      set: { total: sqlExcluded('total'), attached: sqlExcluded('attached') },
    })
  }
}

// Nightly cron loop. Started from src/server/index.ts alongside the other
// SF snapshot worker. Cheap + idempotent; safe if it double-fires.
let stopFn: (() => void) | null = null
export function startOppCoverageWorker() {
  if (stopFn) return
  // Kick ~90s after boot, staggered behind refresh_opp_snapshots — preserved
  // via firstRunDelayMs.
  stopFn = scheduleJob('refresh_opp_coverage', 24 * 60 * 60 * 1000, async () => {
    // Salesforce-only job: a quiet no-op when the install runs another CRM.
    if (!(await isCrmProviderActive('salesforce'))) return
    await refreshOppCoverage().catch(() => {})
  }, { firstRunDelayMs: 90 * 1000 })
}
