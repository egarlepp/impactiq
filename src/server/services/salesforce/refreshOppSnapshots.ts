import { db } from '../../db/index.js'
import { activities, crmLeadAccountLink, crmSnapshotState, crmFieldMappings } from '../../../../drizzle/schema.js'
import { eq, sql, and, inArray } from 'drizzle-orm'
import { getAdminSfConnection } from './client.js'
import { filterKnownFields, soqlDateTime } from './soqlHelpers.js'
import { writeRun } from '../jobs/writeRun.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { resolveUserLookupNames } from './resolveLookupNames.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { getEvaluationSourceSetting } from '../criteriaiq/evaluationSource.js'
import { CRITERIAIQ_RELATED_TYPE, crmProjectsActive } from '../../../shared/evaluationSource.js'
import { notDemoCrmId } from '../demo/ids.js'

// v1.137.0 / v1.138.0: Refresh SF-derived snapshot columns on activities so
// dashboard filters (Sales Stage / Forecast Category) reflect CURRENT Opp
// state, not state at logging time. Also refreshes Lead → Account link
// cache so the Most-Expensive-Account rollup can attribute Lead activity
// cost to the account the lead converted to.
//
// Runs against the admin SF connection so it works across all tenants
// without a user context. Chunks to 200 ids per SOQL WHERE IN(...).
//
// v1.138.0: extended payload — pulls Assigned SE / Primary Engineer /
// Owner / CloseDate / Evaluation lookup in addition to the v1.137 core
// fields. Fields toggled on via crm_field_mappings.background_refresh are
// pulled + snapshotted on top of the core set. Also emits job_runs rows
// so the Admin → Monitoring → Scheduling page can display cadence.
//
// v1.213.0: incremental refresh. Each run reads the SystemModstamp
// watermark left by the previous successful run (crm_snapshot_state) and
// adds `SystemModstamp >= watermark` to every SOQL query, so unchanged
// records aren't re-pulled or re-written on nights nothing changed. A
// SAFETY_BUFFER absorbs clock skew between the watermark being read and
// the run actually starting. Per-record `db.update()` calls are replaced
// with one bulk `UPDATE ... FROM (VALUES ...)` per chunk. First run ever
// (no watermark) still does a full pull, matching the old behavior.

const CHUNK_SIZE = 200
const SAFETY_BUFFER_MS = 15 * 60 * 1000 // 15 min — covers clock skew / in-flight writes

export interface RefreshResult {
  oppsScanned: number
  oppsUpdated: number
  leadsScanned: number
  leadsLinked: number
  evalsScanned: number
  evalsUpdated: number
  errors: string[]
  durationMs: number
  // v1.273.0: distinguishes a leader clicking "Refresh from Salesforce" from
  // the job's own 24h schedule, so Admin -> Monitoring -> Scheduling's
  // Recent Runs can show which one happened — surfaced via `detail` since
  // this whole object is stored verbatim as job_runs.detail.
  source?: 'scheduled' | 'manual'
}

// v1.141.0: CORE_SELECT covers ONLY standard Opportunity fields every
// org has. Custom fields (Assigned_SE__r.Name, Primary_Engineer__r.Name,
// Evaluation__c) are pulled via crm_field_mappings so an org whose custom
// relationships have different API names doesn't error the whole batch.
// If a mapping references a field the org doesn't have, the SOQL failure
// is retried once with the offending field removed.
export const CORE_SELECT = [
  'Id',
  'StageName',
  'ForecastCategoryName',
  'Amount',
  'IsClosed',
  'IsWon',
  'CloseDate',
  'OwnerId',
  'Owner.Name',
]

// v1.282.0: assigned_se_name / primary_engineer_name's admin-configured
// crm_field_api can be stuck on the seed default (Assigned_SE__r.Name /
// Primary_Engineer__r.Name — a User lookup) on an org whose actual field is
// a flat text/picklist (Assigned_SE__c / Primary_Engineer__c) — exactly the
// shape the "Assigned Oppty SE" picker's own hardcoded query already
// expects (services/salesforce -> routes/salesforce.ts's
// /opportunities/:id/assigned-se). Rather than depending on an admin
// noticing and fixing the mapping, always ALSO pull these canonical flat
// fields as a fallback candidate — filterKnownFields silently drops them on
// an org that genuinely doesn't have them, so this is free when unneeded.
export const ASSIGNED_SE_FALLBACK_FIELD = 'Assigned_SE__c'
export const PRIMARY_ENGINEER_FALLBACK_FIELD = 'Primary_Engineer__c'

// v1.148.0: generalized from a hardcoded 'opportunity' filter so the same
// helper can also drive the Evaluation__c batch below.
// v1.218.0: exported so the inline SF record preview builds its SELECT from
// exactly the same admin-configured mappings the nightly refresh uses. Two
// field lists that drift apart would mean the popover showing a different
// Assigned SE than the dashboards.
export async function collectExtraSelect(sobject: string, coreSelect: string[]): Promise<string[]> {
  // v1.140.0: mappings flagged EITHER backgroundRefresh OR
  // refreshOnlyForReports contribute their crmFieldApi to the SELECT
  // list. Deduped against coreSelect.
  const rows = await db
    .select({ api: crmFieldMappings.crmFieldApi, sobj: crmFieldMappings.crmObject, bg: crmFieldMappings.backgroundRefresh, ro: crmFieldMappings.refreshOnlyForReports })
    .from(crmFieldMappings)
  const extras = rows
    .filter((r) => (r.sobj ?? '').toLowerCase() === sobject.toLowerCase())
    .filter((r) => r.bg || r.ro)
    .map((r) => r.api)
    .filter((api) => !!api && !coreSelect.some((c) => c.toLowerCase() === api.toLowerCase()))
  return Array.from(new Set(extras))
}

interface OppRow {
  Id: string
  StageName: string | null
  ForecastCategoryName: string | null
  Amount: number | null
  IsClosed: boolean
  IsWon: boolean
  CloseDate: string | null
  OwnerId: string | null
  Owner?: { Name: string | null } | null
  [key: string]: unknown
}

// v1.279.0: assigned_se_name / primary_engineer_name default to a User
// LOOKUP shape (Assigned_SE__r.Name) in the seed, but an admin can remap
// crm_field_api to a flat field instead (e.g. a plain Assigned_SE__c text/
// picklist, which many orgs actually use) — both this refresh job and the
// inline SF record preview used to hardcode the lookup shape regardless, so
// a remapped org's Assigned SE / Primary Engineer silently came back null
// everywhere (the snapshot columns, and the popover). Exported so both
// consumers share one resolution instead of drifting.
//
// v1.293.0: also resolves the 4 Total Bookings breakdown app fields (New
// Business / Renewal ACV / TCV, see the Opportunity Info expandable panel
// on the activity form) — same "admin maps an app-side concept to whatever
// this org actually calls the field" pattern, so a second lookup helper
// isn't worth the duplication.
const APP_FIELD_TTL_MS = 60 * 60 * 1000
let appFieldCache: { at: number; map: Map<string, string> } | null = null
export async function resolveAppFieldPaths(): Promise<Map<string, string>> {
  if (appFieldCache && Date.now() - appFieldCache.at < APP_FIELD_TTL_MS) return appFieldCache.map
  const rows = await db.select({ appField: crmFieldMappings.appField, api: crmFieldMappings.crmFieldApi })
    .from(crmFieldMappings)
    .where(and(inArray(crmFieldMappings.appField, [
      'assigned_se_name', 'primary_engineer_name', 'evaluation_lookup',
      'opp_new_business_acv', 'opp_new_business_tcv', 'opp_renewal_acv', 'opp_renewal_tcv',
    ]), eq(crmFieldMappings.isActive, true)))
  const map = new Map<string, string>()
  for (const r of rows) if (r.api && !map.has(r.appField)) map.set(r.appField, r.api)
  appFieldCache = { at: Date.now(), map }
  return map
}

/** Extracts a dot-path (e.g. 'Assigned_SE__r.Name' or a flat 'Assigned_SE__c') from a JSForce record. */
export function resolveFieldPath(rec: Record<string, unknown>, path: string): string | null {
  let cur: unknown = rec
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur == null ? null : String(cur)
}

// Reads the last successful watermark for `key`, minus a safety buffer.
// Returns null when there's no prior state — the caller should then do a
// full (non-incremental) pull, same as pre-v1.213 behavior.
async function readWatermark(key: string): Promise<Date | null> {
  const [row] = await db.select().from(crmSnapshotState).where(eq(crmSnapshotState.key, key)).limit(1)
  if (!row?.refreshedAt) return null
  return new Date(row.refreshedAt.getTime() - SAFETY_BUFFER_MS)
}

interface OppPatchRow {
  id: string
  salesStage: string | null
  forecastCategory: string | null
  oppAmount: string | null
  crmIsClosed: boolean
  crmIsWon: boolean
  crmOppOwnerId: string | null
  crmOppOwnerName: string | null
  crmOppCloseDate: string | null
  crmAssignedSeName: string | null
  crmPrimaryEngineerName: string | null
  crmRelatedId: string | null
}

// Bulk-writes one UPDATE...FROM(VALUES...) per chunk instead of a
// per-record db.update() — cuts N round-trips down to 1 per chunk.
async function bulkUpdateOppPatches(rows: OppPatchRow[]): Promise<void> {
  if (rows.length === 0) return
  const values = sql.join(
    rows.map((r) => sql`(${r.id}, ${r.salesStage}, ${r.forecastCategory}, ${r.oppAmount}, ${r.crmIsClosed}, ${r.crmIsWon}, ${r.crmOppOwnerId}, ${r.crmOppOwnerName}, ${r.crmOppCloseDate}, ${r.crmAssignedSeName}, ${r.crmPrimaryEngineerName}, ${r.crmRelatedId})`),
    sql`, `,
  )
  await db.execute(sql`
    UPDATE activities AS a SET
      sales_stage = v.sales_stage,
      forecast_category = v.forecast_category,
      opp_amount = v.opp_amount::numeric,
      crm_is_closed = v.crm_is_closed,
      crm_is_won = v.crm_is_won,
      crm_snapshot_refreshed_at = now(),
      crm_opp_owner_id = v.crm_opp_owner_id,
      crm_opp_owner_name = v.crm_opp_owner_name,
      crm_opp_close_date = v.crm_opp_close_date::date,
      crm_assigned_se_name = v.crm_assigned_se_name,
      crm_primary_engineer_name = v.crm_primary_engineer_name,
      crm_related_id = COALESCE(v.crm_related_id, a.crm_related_id)
    FROM (VALUES ${values}) AS v(id, sales_stage, forecast_category, opp_amount, crm_is_closed, crm_is_won, crm_opp_owner_id, crm_opp_owner_name, crm_opp_close_date, crm_assigned_se_name, crm_primary_engineer_name, crm_related_id)
    WHERE a.crm_what_type = 'Opportunity' AND a.crm_what_id = v.id
  `)
}

// Exported for HubSpot's refresh, which fills the same Lead → Account cache.
export async function bulkUpsertLeadLinks(rows: Array<{ leadId: string; accountId: string | null }>): Promise<void> {
  if (rows.length === 0) return
  const values = sql.join(rows.map((r) => sql`(${r.leadId}, ${r.accountId})`), sql`, `)
  await db.execute(sql`
    INSERT INTO crm_lead_account_link (lead_id, account_id, refreshed_at)
    SELECT v.lead_id, v.account_id, now() FROM (VALUES ${values}) AS v(lead_id, account_id)
    ON CONFLICT (lead_id) DO UPDATE SET account_id = EXCLUDED.account_id, refreshed_at = EXCLUDED.refreshed_at
  `)
}

interface EvalPatchRow {
  id: string
  crmRelatedName: string | null
  crmEvalStatus: string | null
  crmEvalStage: string | null
  crmEvalType: string | null
  crmEvalStartDate: string | null
  crmEvalEndDate: string | null
  crmEvalPrimaryEngineer: string | null
}

async function bulkUpdateEvalPatches(relType: string, rows: EvalPatchRow[]): Promise<void> {
  if (rows.length === 0) return
  const values = sql.join(
    rows.map((r) => sql`(${r.id}, ${r.crmRelatedName}, ${r.crmEvalStatus}, ${r.crmEvalStage}, ${r.crmEvalType}, ${r.crmEvalStartDate}, ${r.crmEvalEndDate}, ${r.crmEvalPrimaryEngineer})`),
    sql`, `,
  )
  await db.execute(sql`
    UPDATE activities AS a SET
      crm_related_name = COALESCE(v.crm_related_name, a.crm_related_name),
      crm_eval_status = COALESCE(v.crm_eval_status, a.crm_eval_status),
      crm_eval_stage = COALESCE(v.crm_eval_stage, a.crm_eval_stage),
      crm_eval_type = COALESCE(v.crm_eval_type, a.crm_eval_type),
      crm_eval_start_date = COALESCE(v.crm_eval_start_date::date, a.crm_eval_start_date),
      crm_eval_end_date = COALESCE(v.crm_eval_end_date::date, a.crm_eval_end_date),
      crm_eval_primary_engineer = COALESCE(v.crm_eval_primary_engineer, a.crm_eval_primary_engineer),
      crm_snapshot_refreshed_at = now()
    FROM (VALUES ${values}) AS v(id, crm_related_name, crm_eval_status, crm_eval_stage, crm_eval_type, crm_eval_start_date, crm_eval_end_date, crm_eval_primary_engineer)
    WHERE a.crm_related_type = ${relType} AND a.crm_related_id = v.id
  `)
}

export async function refreshOppSnapshots(opts?: { source?: 'scheduled' | 'manual' }): Promise<RefreshResult> {
  const startedAt = new Date()
  const result: RefreshResult = { oppsScanned: 0, oppsUpdated: 0, leadsScanned: 0, leadsLinked: 0, evalsScanned: 0, evalsUpdated: 0, errors: [], durationMs: 0, source: opts?.source ?? 'scheduled' }
  const conn = await getAdminSfConnection()
  if (!conn) {
    result.errors.push('no_admin_sf_connection')
    await writeRun('refresh_opp_snapshots', startedAt, 'error', 'no_admin_sf_connection', result)
    return result
  }

  const watermark = await readWatermark('opp_snapshot')
  const modstampClause = watermark ? ` AND SystemModstamp >= ${soqlDateTime(watermark)}` : ''

  // v1.141.0: describe the org once and filter extraSelect to only fields
  // (or relationship paths) that actually exist. Prevents "Didn't
  // understand relationship 'X__r' in field path" from failing every
  // Opp chunk when a customer's custom SF fields have different API
  // names than the seeded defaults.
  const extraCandidates = Array.from(new Set([
    ...await collectExtraSelect('opportunity', CORE_SELECT),
    ASSIGNED_SE_FALLBACK_FIELD,
    PRIMARY_ENGINEER_FALLBACK_FIELD,
  ]))
  const extraSelect = await filterKnownFields(
    conn,
    'Opportunity',
    extraCandidates,
    (msg) => result.errors.push(msg),
  )
  const soqlFields = [...CORE_SELECT, ...extraSelect].join(', ')

  // Distinct Opp ids across active activities.
  const oppRows = await db
    .selectDistinct({ id: activities.crmWhatId })
    .from(activities)
    .where(and(
      eq(activities.crmWhatType, 'Opportunity'),
      eq(activities.isArchived, false),
      sql`${activities.crmWhatId} IS NOT NULL`,
      notDemoCrmId(activities.crmWhatId),
    ))
  const oppIds = oppRows.map((r) => r.id!).filter(Boolean)
  result.oppsScanned = oppIds.length

  const appFieldPaths = await resolveAppFieldPaths()
  const assignedSePath = appFieldPaths.get('assigned_se_name')
  const primaryEngineerPath = appFieldPaths.get('primary_engineer_name')
  // v1.301.0: evaluation_lookup's crmFieldApi used to be read here as a
  // hardcoded rec.Evaluation__c regardless of what the mapping was actually
  // configured to — the exact same "never hardcode SF field API names"
  // violation as the Assigned SE picker (§9/§21) had. An org whose real
  // Project/Evaluation lookup field isn't literally named Evaluation__c
  // (a real production org among them — Validate & Dry Run flags
  // "'Evaluation__c' doesn't exist on this object") had this refresh silently do nothing, and
  // remapping the row in Admin -> SF Field Mappings had no effect either way.
  const evaluationLookupPath = appFieldPaths.get('evaluation_lookup') ?? 'Evaluation__c'
  // v1.387.0 / v1.388.0: the Opportunity's Evaluation lookup and the Project
  // fields are refreshed only while the CRM object is the Project source. With
  // Projects off no link is ever added; with CriteriaIQ as primary a
  // Salesforce Evaluation id must never overwrite a CriteriaIQ project link
  // (refresh_criteriaiq_projects keeps those fresh instead).
  const crmProjects = crmProjectsActive((await getEvaluationSourceSetting()).primary)

  for (let i = 0; i < oppIds.length; i += CHUNK_SIZE) {
    const chunk = oppIds.slice(i, i + CHUNK_SIZE)
    try {
      const soql = `SELECT ${soqlFields} FROM Opportunity WHERE Id IN (${chunk.map((id) => `'${id}'`).join(',')})${modstampClause}`
      const r = await conn.query<OppRow>(soql)
      const patches: OppPatchRow[] = r.records.map((rec) => ({
        id: rec.Id,
        salesStage: rec.StageName ?? null,
        forecastCategory: rec.ForecastCategoryName ?? null,
        oppAmount: rec.Amount != null ? String(rec.Amount) : null,
        crmIsClosed: !!rec.IsClosed,
        crmIsWon: !!rec.IsWon,
        crmOppOwnerId: rec.OwnerId ?? null,
        crmOppOwnerName: rec.Owner?.Name ?? null,
        crmOppCloseDate: rec.CloseDate ?? null,
        crmAssignedSeName: (assignedSePath ? resolveFieldPath(rec, assignedSePath) : null) ?? resolveFieldPath(rec, ASSIGNED_SE_FALLBACK_FIELD),
        crmPrimaryEngineerName: (primaryEngineerPath ? resolveFieldPath(rec, primaryEngineerPath) : null) ?? resolveFieldPath(rec, PRIMARY_ENGINEER_FALLBACK_FIELD),
        // Evaluation lookup on the Opp (custom lookup ID). Only mirror it
        // when present — never clobber a good value with null (COALESCE
        // in the bulk update handles that).
        crmRelatedId: crmProjects ? resolveFieldPath(rec, evaluationLookupPath) : null,
      }))
      await bulkUpdateOppPatches(patches)
      result.oppsUpdated += patches.length
    } catch (e) {
      result.errors.push(`opp_chunk_${i}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Lead → Account link refresh.
  const leadRows = await db
    .selectDistinct({ id: activities.crmWhoId })
    .from(activities)
    .where(and(
      eq(activities.crmWhoType, 'Lead'),
      eq(activities.isArchived, false),
      sql`${activities.crmWhoId} IS NOT NULL`,
      notDemoCrmId(activities.crmWhoId),
    ))
  const leadIds = leadRows.map((r) => r.id!).filter(Boolean)
  result.leadsScanned = leadIds.length

  for (let i = 0; i < leadIds.length; i += CHUNK_SIZE) {
    const chunk = leadIds.slice(i, i + CHUNK_SIZE)
    try {
      const soql = `SELECT Id, ConvertedAccountId FROM Lead WHERE Id IN (${chunk.map((id) => `'${id}'`).join(',')})${modstampClause}`
      const r = await conn.query<{ Id: string; ConvertedAccountId: string | null }>(soql)
      await bulkUpsertLeadLinks(r.records.map((rec) => ({ leadId: rec.Id, accountId: rec.ConvertedAccountId ?? null })))
      result.leadsLinked += r.records.filter((rec) => !!rec.ConvertedAccountId).length
    } catch (e) {
      result.errors.push(`lead_chunk_${i}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // v1.148.0 / v1.149.0: Evaluation ("Project") field refresh. Object-
  // agnostic — the SF object API name comes from each activity's
  // crmRelatedType (whatever the admin's related_object_picker configured,
  // e.g. "Evaluations__c"), NOT a hardcoded literal. Group linked records
  // by their object type and run one batch per type. Mapped field API
  // names come from crm_field_mappings for that object (migration 0090
  // app_field keys: eval_name/eval_status/eval_stage/eval_type/
  // eval_start_date/eval_end_date).
  const relRows = !crmProjects ? [] : await db
    .selectDistinct({ type: activities.crmRelatedType, id: activities.crmRelatedId })
    .from(activities)
    .where(and(
      eq(activities.isArchived, false),
      sql`${activities.crmRelatedType} IS NOT NULL`,
      sql`${activities.crmRelatedId} IS NOT NULL`,
      sql`${activities.crmRelatedType} <> ${CRITERIAIQ_RELATED_TYPE}`,
      notDemoCrmId(activities.crmRelatedId),
    ))
  const idsByType = new Map<string, string[]>()
  for (const r of relRows) {
    if (!r.type || !r.id) continue
    const list = idsByType.get(r.type) ?? []
    list.push(r.id)
    idsByType.set(r.type, list)
  }

  for (const [relType, ids] of idsByType) {
    if (!/^[A-Za-z0-9_]{1,80}$/.test(relType)) continue
    const evalMappingRows = await db
      .select({ appField: crmFieldMappings.appField, api: crmFieldMappings.crmFieldApi, referenceTo: crmFieldMappings.referenceTo })
      .from(crmFieldMappings)
      .where(and(eq(crmFieldMappings.crmObject, relType), eq(crmFieldMappings.isActive, true)))
    const mappingByAppField = new Map<string, { api: string; referenceTo: string | null }>()
    for (const r of evalMappingRows) if (!mappingByAppField.has(r.appField)) mappingByAppField.set(r.appField, { api: r.api, referenceTo: r.referenceTo })
    // Only refresh related objects that actually have eval field mappings.
    const statusApi = mappingByAppField.get('eval_status')?.api
    const stageApi = mappingByAppField.get('eval_stage')?.api
    const typeApi = mappingByAppField.get('eval_type')?.api
    const startApi = mappingByAppField.get('eval_start_date')?.api
    const endApi = mappingByAppField.get('eval_end_date')?.api
    const nameApi = mappingByAppField.get('eval_name')?.api
    const primaryEngineerApi = mappingByAppField.get('eval_primary_engineer')?.api
    // v1.286.0: describe() already told us (at mapping-save time) whether
    // Primary Engineer is a Salesforce Lookup(User) — if so its raw SOQL
    // value is a User Id, not a name, and needs resolving against the local
    // crm_users cache (see resolveLookupNames.ts).
    const primaryEngineerIsUserLookup = mappingByAppField.get('eval_primary_engineer')?.referenceTo === 'User'
    if (![statusApi, stageApi, typeApi, startApi, endApi, nameApi, primaryEngineerApi].some(Boolean)) continue

    result.evalsScanned += ids.length
    // v1.150.0: describe the object and drop any mapped field that doesn't
    // exist on it, so a mis-seeded API name (e.g. "Eval_EndDate" missing
    // its __c) doesn't fail the whole batch and blank every field.
    let validNames: Set<string> | null = null
    try {
      const meta = await conn.sobject(relType).describe()
      validNames = new Set((meta.fields ?? []).map((f) => (f.name ?? '').toLowerCase()))
    } catch (e) {
      result.errors.push(`eval_describe_${relType}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const fieldOk = (f: string | undefined): f is string => !!f && /^[A-Za-z0-9_.]{1,80}$/.test(f) && (!validNames || validNames.has(f.toLowerCase()))
    const evalFields = ['Id', nameApi, statusApi, stageApi, typeApi, startApi, endApi, primaryEngineerApi].filter((f) => f === 'Id' || fieldOk(f)) as string[]

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE)
      try {
        const soql = `SELECT ${evalFields.join(', ')} FROM ${relType} WHERE Id IN (${chunk.map((id) => `'${id}'`).join(',')})${modstampClause}`
        const r = await conn.query<Record<string, unknown>>(soql)
        const selected = new Set(evalFields.map((f) => f.toLowerCase()))
        const patches: EvalPatchRow[] = r.records.map((rec) => ({
          id: String(rec['Id']),
          crmRelatedName: nameApi && selected.has(nameApi.toLowerCase()) ? (rec[nameApi] as string | null ?? null) : null,
          crmEvalStatus: statusApi && selected.has(statusApi.toLowerCase()) ? (rec[statusApi] as string | null ?? null) : null,
          crmEvalStage: stageApi && selected.has(stageApi.toLowerCase()) ? (rec[stageApi] as string | null ?? null) : null,
          crmEvalType: typeApi && selected.has(typeApi.toLowerCase()) ? (rec[typeApi] as string | null ?? null) : null,
          crmEvalStartDate: startApi && selected.has(startApi.toLowerCase()) ? (rec[startApi] as string | null ?? null) : null,
          crmEvalEndDate: endApi && selected.has(endApi.toLowerCase()) ? (rec[endApi] as string | null ?? null) : null,
          crmEvalPrimaryEngineer: primaryEngineerApi && selected.has(primaryEngineerApi.toLowerCase()) ? (rec[primaryEngineerApi] as string | null ?? null) : null,
        }))
        if (primaryEngineerIsUserLookup) {
          const nameById = await resolveUserLookupNames(patches.map((p) => p.crmEvalPrimaryEngineer))
          for (const p of patches) {
            if (p.crmEvalPrimaryEngineer) p.crmEvalPrimaryEngineer = nameById.get(p.crmEvalPrimaryEngineer) ?? p.crmEvalPrimaryEngineer
          }
        }
        await bulkUpdateEvalPatches(relType, patches)
        result.evalsUpdated += patches.length
      } catch (e) {
        result.errors.push(`eval_chunk_${relType}_${i}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // Stamp overall state. This becomes next run's watermark, so a run that
  // errored partway through still advances the watermark for whatever DID
  // succeed — chunks that failed will simply be retried in full next time
  // since their records won't reflect the new watermark... this mirrors
  // the original job's semantics (best-effort, self-healing nightly job).
  await db.insert(crmSnapshotState).values({
    key: 'opp_snapshot',
    refreshedAt: new Date(),
    lastError: result.errors.length > 0 ? result.errors.join(' | ') : null,
  }).onConflictDoUpdate({
    target: crmSnapshotState.key,
    set: { refreshedAt: new Date(), lastError: result.errors.length > 0 ? result.errors.join(' | ') : null },
  })

  result.durationMs = Date.now() - startedAt.getTime()
  const message = result.errors.length > 0
    ? result.errors[0] ?? null
    : `${result.oppsUpdated}/${result.oppsScanned} opps updated, ${result.leadsLinked}/${result.leadsScanned} leads linked, ${result.evalsUpdated}/${result.evalsScanned} evals updated`
  await writeRun('refresh_opp_snapshots', startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}

// v1.138.0: nightly cron loop. Started from src/server/index.ts.
// Runs every 24h from process boot. Cheap idempotent — safe if it
// double-fires. If admins want to force a fresh pull off-cycle, they use
// the manual button on the Dashboard header (POST /refresh-opp-snapshots).
let stopFn: (() => void) | null = null
export function startOppSnapshotWorker() {
  if (stopFn) return
  // Kick once ~60s after boot so a first run lands before any admin pokes
  // the Scheduling page — preserved via firstRunDelayMs.
  stopFn = scheduleJob('refresh_opp_snapshots', 24 * 60 * 60 * 1000, async () => {
    // Salesforce-only job: a quiet no-op when the install runs another CRM.
    if (!(await isCrmProviderActive('salesforce'))) return
    await refreshOppSnapshots().catch(() => {})
  }, { firstRunDelayMs: 60 * 1000 })
}
