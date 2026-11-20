import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities } from '../../../../drizzle/schema.js'
import {
  HUBSPOT_ID_RX,
  HUBSPOT_PROJECTS_OBJECT_TYPE_ID,
  HUBSPOT_PROJECT_EDITABLE_APP_FIELDS,
  HUBSPOT_PROJECT_PREPEND_APP_FIELDS,
  isHubspotProjectObject,
  type HubspotProjectObject,
} from '../../../shared/hubspot.js'
import { computeCapacity, computeInitials, formatEntry } from '../../../shared/sfFieldPrepend.js'
import { formatDateMMDDYY } from '../salesforce/fieldPrepend.js'
import { logSfSyncAttempt } from '../salesforce/syncAudit.js'
import { HubspotError, hubspotJson, hubspotRequest } from './client.js'
import { isWritable, loadHubspotMappings, type HubspotMappingRow } from './mappings.js'
import { getObjectPropertiesSafe, isOwnerProperty, optionLabel, resolveOwnerValue, type PropertyInfo } from './metadata.js'
import { repointMergedLinks, resolveHubspotRecords } from './linkHealth.js'
import { batchRead } from './search.js'

// Projects (Evaluations) on HubSpot (HubSpot plan, phase 6b): the HubSpot side
// of the Salesforce Evaluation picker, Project field editor, Engineer Notes /
// Next Steps posting and the Project snapshot. A team's Project object is
// HubSpot's standard Projects object (0-970) or an Enterprise custom object
// (2-…), named everywhere by its object type id. Which property feeds each
// field comes from the team's eval_* mappings on that object (Admin → HubSpot
// Field Mappings); nothing assumes a property name except the standard
// object's own `hs_name` for the record label.

// HubSpot keeps string property values up to this many characters.
export const HUBSPOT_STRING_MAX = 65_536

// The fields the Project panel and the snapshot read (Engineer Notes and Next
// Steps are only posted to, never shown in the panel).
const READ_APP_FIELDS = [
  'eval_name', 'eval_status', 'eval_stage', 'eval_type', 'eval_start_date', 'eval_end_date', 'eval_primary_engineer',
] as const
type ReadAppField = (typeof READ_APP_FIELDS)[number]
const DATE_FIELDS = new Set(['eval_start_date', 'eval_end_date'])

const SNAPSHOT_COLUMN: Record<Exclude<ReadAppField, 'eval_name'>, 'crmEvalStatus' | 'crmEvalStage' | 'crmEvalType' | 'crmEvalStartDate' | 'crmEvalEndDate' | 'crmEvalPrimaryEngineer'> = {
  eval_status: 'crmEvalStatus',
  eval_stage: 'crmEvalStage',
  eval_type: 'crmEvalType',
  eval_start_date: 'crmEvalStartDate',
  eval_end_date: 'crmEvalEndDate',
  eval_primary_engineer: 'crmEvalPrimaryEngineer',
}

function hubspotMessage(status: number, body: unknown): string {
  const msg = body && typeof body === 'object' ? (body as Record<string, unknown>)['message'] : null
  return `HubSpot ${status}${typeof msg === 'string' && msg ? `: ${msg}` : ''}`
}

function errorText(err: unknown): string {
  if (err instanceof HubspotError) return err.code
  return err instanceof Error ? err.message : String(err)
}

// ── Which objects can hold Projects ────────────────────────────────────────

interface SchemaApi {
  objectTypeId?: unknown
  archived?: unknown
  labels?: { singular?: unknown; plural?: unknown }
  primaryDisplayProperty?: unknown
}

// The standard Projects object when the portal has it and the key may read
// it, plus every custom object. Each source is checked on its own, so a
// portal without custom objects still offers Projects and the other way round.
export async function listHubspotProjectObjects(): Promise<HubspotProjectObject[]> {
  const out: HubspotProjectObject[] = []
  const standard = await hubspotRequest(`/crm/v3/objects/${HUBSPOT_PROJECTS_OBJECT_TYPE_ID}`, { query: { limit: 1 } })
  if (standard.status >= 200 && standard.status < 300) {
    out.push({ objectTypeId: HUBSPOT_PROJECTS_OBJECT_TYPE_ID, standard: true, label: null, primaryDisplayProperty: 'hs_name' })
  }
  const schemas = await hubspotRequest('/crm/v3/schemas')
  if (schemas.status >= 200 && schemas.status < 300) {
    const results = (schemas.body as { results?: SchemaApi[] } | null)?.results ?? []
    for (const s of results) {
      const id = typeof s.objectTypeId === 'string' ? s.objectTypeId : null
      if (!id || !isHubspotProjectObject(id) || s.archived === true) continue
      out.push({
        objectTypeId: id,
        standard: false,
        label: typeof s.labels?.singular === 'string' ? s.labels.singular : id,
        primaryDisplayProperty: typeof s.primaryDisplayProperty === 'string' && s.primaryDisplayProperty ? s.primaryDisplayProperty : 'hs_object_id',
      })
    }
  }
  return out
}

// ── The picker: records associated to a Deal ───────────────────────────────

const PROPERTY_RX = /^[A-Za-z0-9_]{1,100}$/

export function projectLabelProperty(objectTypeId: string, labelField: string | null | undefined): string {
  if (labelField && PROPERTY_RX.test(labelField) && labelField !== 'Name') return labelField
  return objectTypeId === HUBSPOT_PROJECTS_OBJECT_TYPE_ID ? 'hs_name' : 'hs_object_id'
}

interface AssocPage {
  results?: Array<{ toObjectId?: unknown }>
  paging?: { next?: { after?: unknown } }
}

// Every record of the Project object associated to the Deal, by name. A Deal
// HubSpot doesn't know lists nothing.
export async function listDealProjects(dealId: string, objectTypeId: string, labelField?: string | null): Promise<Array<{ id: string; name: string }>> {
  if (!HUBSPOT_ID_RX.test(dealId) || !isHubspotProjectObject(objectTypeId)) return []
  const ids: string[] = []
  let after: string | undefined
  for (let page = 0; page < 10; page++) {
    const res = await hubspotRequest(`/crm/v4/objects/deals/${dealId}/associations/${objectTypeId}`, { query: { limit: 500, after } })
    if (res.status === 404) return []
    if (res.status === 403) throw new HubspotError('errors.hubspot.forbidden', 403)
    if (res.status < 200 || res.status >= 300) throw new HubspotError('errors.hubspot.bad_response', res.status)
    const body = (res.body ?? {}) as AssocPage
    for (const r of body.results ?? []) if (r.toObjectId != null) ids.push(String(r.toObjectId))
    const next = body.paging?.next?.after
    if (typeof next !== 'string' || !next) break
    after = next
  }
  if (ids.length === 0) return []
  const labelProperty = projectLabelProperty(objectTypeId, labelField)
  const records = await batchRead(objectTypeId, ids, [labelProperty])
  return [...records.values()]
    .map((r) => ({ id: String(r.id), name: (r.properties?.[labelProperty] as string | null | undefined) || String(r.id) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ── Mappings ───────────────────────────────────────────────────────────────

async function projectMappings(teamId: string | null, objectTypeId: string): Promise<Map<string, HubspotMappingRow>> {
  const rows = await loadHubspotMappings(teamId, [objectTypeId])
  const out = new Map<string, HubspotMappingRow>()
  for (const r of rows) if (PROPERTY_RX.test(r.property) && !out.has(r.appField)) out.set(r.appField, r)
  return out
}

// ── Reading values ─────────────────────────────────────────────────────────

// Date properties come back as YYYY-MM-DD, datetime ones as an ISO timestamp
// or epoch milliseconds; the panel and the snapshot columns take a date.
export function toDateOnly(raw: string | null): string | null {
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  if (/^\d{10,15}$/.test(raw)) return new Date(Number(raw)).toISOString().slice(0, 10)
  return null
}

interface ResolvedValue { value: string | null; label: string | null }

// Pipeline stage ids (hs_pipeline_stage) as labels, read once an hour.
const stageCache = new Map<string, { at: number; stages: Map<string, { label: string; pipelineLabel: string }> }>()
export function clearProjectStageCache(): void { stageCache.clear() }

async function pipelineStages(objectTypeId: string): Promise<Map<string, { label: string; pipelineLabel: string }>> {
  const hit = stageCache.get(objectTypeId)
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.stages
  const stages = new Map<string, { label: string; pipelineLabel: string }>()
  try {
    const body = await hubspotJson<{ results?: Array<{ label?: unknown; stages?: Array<{ id?: unknown; label?: unknown }> }> }>(`/crm/v3/pipelines/${objectTypeId}`)
    for (const p of body.results ?? []) {
      for (const s of p.stages ?? []) {
        if (typeof s.id === 'string') stages.set(s.id, { label: typeof s.label === 'string' ? s.label : s.id, pipelineLabel: typeof p.label === 'string' ? p.label : '' })
      }
    }
  } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
  }
  stageCache.set(objectTypeId, { at: Date.now(), stages })
  return stages
}

async function resolveValue(appField: string, property: string, raw: string | null, props: Map<string, PropertyInfo>, objectTypeId: string): Promise<ResolvedValue> {
  if (raw == null || raw === '') return { value: null, label: null }
  if (DATE_FIELDS.has(appField)) {
    const d = toDateOnly(raw)
    return { value: d, label: d }
  }
  const info = props.get(property)
  if (info && isOwnerProperty(info)) {
    const name = await resolveOwnerValue(raw)
    return { value: raw, label: name }
  }
  if (property === 'hs_pipeline_stage') {
    const stage = (await pipelineStages(objectTypeId)).get(raw)
    return { value: raw, label: stage?.label ?? raw }
  }
  return { value: raw, label: optionLabel(props, property, raw) }
}

export interface ProjectFieldsRead {
  // Raw HubSpot values (option values, owner ids, dates), what the editor sends back.
  values: Record<string, string | null>
  // What a person reads: option labels, owner names.
  labels: Record<string, string | null>
  dropped: string[]
}

// Live read of the mapped Project fields for one record. 'unmapped' when the
// team has no Project field mapped on this object; null when HubSpot has no
// such record.
export async function readHubspotProjectFields(teamId: string, objectTypeId: string, recordId: string): Promise<ProjectFieldsRead | 'unmapped' | null> {
  if (!isHubspotProjectObject(objectTypeId) || !HUBSPOT_ID_RX.test(recordId)) return null
  const mappings = await projectMappings(teamId, objectTypeId)
  const pairs = READ_APP_FIELDS.flatMap((f) => { const m = mappings.get(f); return m ? [[f, m.property] as const] : [] })
  if (pairs.length === 0) return 'unmapped'
  const props = await getObjectPropertiesSafe(objectTypeId)
  const dropped: string[] = []
  const kept = props.size === 0 ? pairs : pairs.filter(([f, p]) => {
    if (props.has(p)) return true
    dropped.push(`${f}:${p}`)
    return false
  })
  const out: ProjectFieldsRead = { values: {}, labels: {}, dropped }
  if (kept.length === 0) return out
  const res = await hubspotRequest(`/crm/v3/objects/${objectTypeId}/${recordId}`, { query: { properties: [...new Set(kept.map(([, p]) => p))].join(',') } })
  if (res.status === 404) return null
  if (res.status === 403) throw new HubspotError('errors.hubspot.forbidden', 403)
  if (res.status < 200 || res.status >= 300) throw new HubspotError('errors.hubspot.bad_response', res.status)
  const properties = ((res.body as { properties?: Record<string, string | null> } | null)?.properties) ?? {}
  for (const [appField, property] of kept) {
    const r = await resolveValue(appField, property, properties[property] ?? null, props, objectTypeId)
    out.values[appField] = appField === 'eval_primary_engineer' ? r.label : r.value
    out.labels[appField] = r.label
  }
  return out
}

// The options an editable Project field offers: an enumeration's options, or
// the object's pipeline stages for hs_pipeline_stage. 'unmapped' with no mapping.
export async function hubspotProjectOptions(teamId: string, objectTypeId: string, appField: string): Promise<Array<{ value: string; label: string }> | 'unmapped'> {
  if (!isHubspotProjectObject(objectTypeId)) return 'unmapped'
  const m = (await projectMappings(teamId, objectTypeId)).get(appField)
  if (!m) return 'unmapped'
  if (m.property === 'hs_pipeline_stage') {
    const stages = await pipelineStages(objectTypeId)
    const pipelines = new Set([...stages.values()].map((s) => s.pipelineLabel))
    return [...stages].map(([value, s]) => ({ value, label: pipelines.size > 1 && s.pipelineLabel ? `${s.pipelineLabel} · ${s.label}` : s.label }))
  }
  const info = (await getObjectPropertiesSafe(objectTypeId)).get(m.property)
  return info ? [...info.options].map(([value, label]) => ({ value, label })) : []
}

// ── Editing fields ─────────────────────────────────────────────────────────

// A date for a date property is YYYY-MM-DD; a datetime property gets midnight
// UTC of that day. Empty clears the value.
export function toHubspotDate(value: string | null, info: PropertyInfo | undefined): string {
  if (!value) return ''
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  if (!d) return value
  return info?.type === 'datetime' ? `${d}T00:00:00.000Z` : d
}

export type ProjectFieldWrite =
  | { ok: true; updated: string[]; skipped: string[] }
  | { ok: false; status: 400 | 404 | 502; error: string; skipped: string[] }

// Writes the edited fields to the HubSpot record, then mirrors them onto the
// snapshot of every activity on the team linked to it (labels, as the nightly
// refresh stores them). Only writable eval mappings are sent.
export async function writeHubspotProjectFields(args: {
  teamId: string
  objectTypeId: string
  recordId: string
  fields: Record<string, string | null | undefined>
  userId: string
}): Promise<ProjectFieldWrite> {
  const { teamId, objectTypeId, recordId, fields, userId } = args
  const skipped: string[] = []
  if (!isHubspotProjectObject(objectTypeId) || !HUBSPOT_ID_RX.test(recordId)) return { ok: false, status: 400, error: 'errors.hubspot.invalid_object', skipped }
  const mappings = await projectMappings(teamId, objectTypeId)
  const props = await getObjectPropertiesSafe(objectTypeId)
  const payload: Record<string, string> = {}
  const local: Record<string, string | null> = {}
  for (const [appField, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const m = mappings.get(appField)
    if (!HUBSPOT_PROJECT_EDITABLE_APP_FIELDS.has(appField) || !m || !isWritable(m)) { skipped.push(appField); continue }
    const info = props.get(m.property)
    payload[m.property] = DATE_FIELDS.has(appField) ? toHubspotDate(value, info) : (value ?? '')
    const resolved = await resolveValue(appField, m.property, value, props, objectTypeId)
    local[SNAPSHOT_COLUMN[appField as Exclude<ReadAppField, 'eval_name'>]] = resolved.label
  }
  if (Object.keys(payload).length === 0) return { ok: false, status: 400, error: 'errors.hubspot.project_field_unmapped', skipped }

  let error: string | null = null
  let status: 400 | 404 | 502 = 502
  try {
    const res = await hubspotRequest(`/crm/v3/objects/${objectTypeId}/${recordId}`, { method: 'PATCH', body: { properties: payload } })
    if (res.status < 200 || res.status >= 300) {
      error = hubspotMessage(res.status, res.body)
      if (res.status === 404) status = 404
    }
  } catch (err) {
    error = errorText(err)
  }
  void logSfSyncAttempt({
    source: 'evaluation_field_update', status: error ? 'failed' : 'success', operation: 'update', crmObject: objectTypeId, crmRecordId: recordId,
    userId, errorMessage: error, payload: { fields: payload, skipped },
  })
  if (error) return { ok: false, status, error, skipped }

  await db.update(activities).set({ ...local, crmSnapshotRefreshedAt: new Date() })
    .where(and(eq(activities.teamId, teamId), eq(activities.crmRelatedType, objectTypeId), eq(activities.crmRelatedId, recordId)))
  return { ok: true, updated: Object.keys(payload), skipped }
}

// ── Engineer Notes / Next Steps: dated, prepended entries ──────────────────

export interface PrependTarget { property: string; label: string }

// The writable text property mapped to a prepend field, or null. Only plain
// single- or multi-line text takes a dated entry: rich text would need HTML,
// and anything else isn't free text at all.
export async function resolvePrependTarget(teamId: string, objectTypeId: string, appField: string): Promise<PrependTarget | 'unmapped' | 'not_prependable'> {
  if (!isHubspotProjectObject(objectTypeId) || !HUBSPOT_PROJECT_PREPEND_APP_FIELDS.has(appField)) return 'unmapped'
  const m = (await projectMappings(teamId, objectTypeId)).get(appField)
  if (!m || !isWritable(m)) return 'unmapped'
  const info = (await getObjectPropertiesSafe(objectTypeId)).get(m.property)
  if (!info || !isPrependable(info)) return 'not_prependable'
  return { property: m.property, label: info.label }
}

export function isPrependable(info: Pick<PropertyInfo, 'type' | 'fieldType' | 'readOnly' | 'calculated'>): boolean {
  return info.type === 'string' && (info.fieldType === 'textarea' || info.fieldType === 'text') && !info.readOnly && !info.calculated
}

export interface PrependCurrent { value: string | null; lastModifiedDate: string | null }

export async function readPrependCurrent(objectTypeId: string, recordId: string, property: string): Promise<PrependCurrent | null> {
  if (!HUBSPOT_ID_RX.test(recordId)) return null
  const res = await hubspotRequest(`/crm/v3/objects/${objectTypeId}/${recordId}`, { query: { properties: `${property},hs_lastmodifieddate` } })
  if (res.status === 404) return null
  if (res.status === 403) throw new HubspotError('errors.hubspot.forbidden', 403)
  if (res.status < 200 || res.status >= 300) throw new HubspotError('errors.hubspot.bad_response', res.status)
  const body = res.body as { properties?: Record<string, string | null>; updatedAt?: unknown } | null
  const value = body?.properties?.[property] ?? null
  const modified = body?.properties?.['hs_lastmodifieddate'] ?? (typeof body?.updatedAt === 'string' ? body.updatedAt : null)
  return { value: value === '' ? null : value, lastModifiedDate: modified }
}

export type PrependResult =
  | { ok: true; formattedEntry: string; charactersUsed: number; maximumCharacters: number; charactersRemaining: number | null }
  | { ok: false; status: 400 | 404 | 409 | 422 | 502; error: string; meta?: Record<string, unknown> }

// Posts one dated entry above the field's current text. The date, initials
// and capacity are worked out here, never taken from the browser, and the
// field is read fresh first: if it changed since the caller looked, nothing
// is written (409), the same contract as the Salesforce route.
export async function prependHubspotProjectField(args: {
  teamId: string
  objectTypeId: string
  recordId: string
  appField: string
  text: string
  expectedLastModifiedDate?: string | null | undefined
  user: { id: string; firstName: string | null; lastName: string | null; timezone: string | null }
}): Promise<PrependResult & { target?: PrependTarget }> {
  const { teamId, objectTypeId, recordId, appField, text, expectedLastModifiedDate, user } = args
  const target = await resolvePrependTarget(teamId, objectTypeId, appField)
  if (target === 'unmapped') return { ok: false, status: 400, error: 'errors.hubspot.project_field_unmapped' }
  if (target === 'not_prependable') return { ok: false, status: 422, error: 'errors.hubspot.field_not_prependable' }

  const formattedEntry = formatEntry(formatDateMMDDYY(new Date(), user.timezone ?? 'UTC'), computeInitials(user.firstName, user.lastName), text.trim())
  let fresh: PrependCurrent | null
  try {
    fresh = await readPrependCurrent(objectTypeId, recordId, target.property)
  } catch (err) {
    return { ok: false, status: 502, error: errorText(err) }
  }
  if (!fresh) return { ok: false, status: 404, error: 'errors.hubspot.record_not_found' }
  if (expectedLastModifiedDate && fresh.lastModifiedDate && expectedLastModifiedDate !== fresh.lastModifiedDate) {
    return {
      ok: false, status: 409, error: 'errors.hubspot.field_changed',
      meta: { currentValue: fresh.value, currentLength: fresh.value?.length ?? 0, lastModifiedDate: fresh.lastModifiedDate },
    }
  }
  const capacity = computeCapacity({ existingValue: fresh.value, formattedEntry, maxLength: HUBSPOT_STRING_MAX })
  if (!capacity.fits) {
    return {
      ok: false, status: 400, error: 'errors.hubspot.field_capacity_exceeded',
      meta: { maximumCharacters: capacity.maximumCharacters, charactersUsed: capacity.charactersUsed, overBy: capacity.overBy },
    }
  }

  let error: string | null = null
  try {
    const res = await hubspotRequest(`/crm/v3/objects/${objectTypeId}/${recordId}`, { method: 'PATCH', body: { properties: { [target.property]: capacity.finalValue } } })
    if (res.status < 200 || res.status >= 300) error = hubspotMessage(res.status, res.body)
  } catch (err) {
    error = errorText(err)
  }
  void logSfSyncAttempt({
    source: 'field_prepend', status: error ? 'failed' : 'success', operation: 'update', crmObject: objectTypeId, crmRecordId: recordId,
    userId: user.id, errorMessage: error, payload: { fieldApiName: target.property, appField, charactersUsed: capacity.charactersUsed },
  })
  if (error) return { ok: false, status: 502, error }
  return {
    ok: true,
    target,
    formattedEntry,
    charactersUsed: capacity.charactersUsed,
    maximumCharacters: HUBSPOT_STRING_MAX,
    charactersRemaining: capacity.charactersRemaining,
  }
}

// ── Snapshot ───────────────────────────────────────────────────────────────

export interface HubspotProjectSnapshot {
  crmRelatedName: string
  crmEvalStatus: string | null
  crmEvalStage: string | null
  crmEvalType: string | null
  crmEvalStartDate: string | null
  crmEvalEndDate: string | null
  crmEvalPrimaryEngineer: string | null
  crmRelatedDeleted: false
}

// The properties to read for snapshots of one Project object: the label
// property plus every mapped eval field (any team's).
function snapshotProperties(objectTypeId: string, mappings: Map<string, HubspotMappingRow>): string[] {
  const props = new Set<string>([projectLabelProperty(objectTypeId, null)])
  for (const f of READ_APP_FIELDS) { const m = mappings.get(f); if (m) props.add(m.property) }
  return [...props]
}

async function toSnapshot(
  objectTypeId: string,
  record: { id: unknown; properties?: Record<string, string | null | undefined> },
  mappings: Map<string, HubspotMappingRow>,
  props: Map<string, PropertyInfo>,
): Promise<HubspotProjectSnapshot> {
  const raw = (p: string | undefined) => (p ? (record.properties?.[p] ?? null) || null : null)
  const label = async (f: ReadAppField) => {
    const m = mappings.get(f)
    return m ? (await resolveValue(f, m.property, raw(m.property), props, objectTypeId)).label : null
  }
  const nameProperty = mappings.get('eval_name')?.property ?? projectLabelProperty(objectTypeId, null)
  return {
    crmRelatedName: raw(nameProperty) ?? raw(projectLabelProperty(objectTypeId, null)) ?? String(record.id),
    crmEvalStatus: await label('eval_status'),
    crmEvalStage: await label('eval_stage'),
    crmEvalType: await label('eval_type'),
    crmEvalStartDate: await label('eval_start_date'),
    crmEvalEndDate: await label('eval_end_date'),
    crmEvalPrimaryEngineer: await label('eval_primary_engineer'),
    crmRelatedDeleted: false,
  }
}

// Read when an activity is saved with a new HubSpot Project link: the stored
// name and fields come from HubSpot, not the browser. Null when the record
// doesn't exist; throws when HubSpot can't be asked.
export async function hubspotProjectSnapshot(teamId: string | null, objectTypeId: string, recordId: string): Promise<HubspotProjectSnapshot | null> {
  if (!isHubspotProjectObject(objectTypeId) || !HUBSPOT_ID_RX.test(recordId)) return null
  const mappings = await projectMappings(teamId, objectTypeId)
  const res = await hubspotRequest(`/crm/v3/objects/${objectTypeId}/${recordId}`, { query: { properties: snapshotProperties(objectTypeId, mappings).join(',') } })
  if (res.status === 404) return null
  if (res.status === 403) throw new HubspotError('errors.hubspot.forbidden', 403)
  if (res.status < 200 || res.status >= 300) throw new HubspotError('errors.hubspot.bad_response', res.status)
  const props = await getObjectPropertiesSafe(objectTypeId)
  return toSnapshot(objectTypeId, res.body as { id: unknown; properties?: Record<string, string | null> }, mappings, props)
}

export interface ProjectRefreshResult { scanned: number; updated: number; notFound: number; errors: string[] }

// Nightly: every HubSpot Project linked from an activity, read in batches of
// 100 per object. A record HubSpot reports as not found gets the "link
// broken" flag (cleared again if it comes back); a merged record moves its
// activities to the surviving record; a failed batch writes nothing.
export async function refreshHubspotProjectSnapshots(): Promise<ProjectRefreshResult> {
  const result: ProjectRefreshResult = { scanned: 0, updated: 0, notFound: 0, errors: [] }
  const links = await db.selectDistinct({ type: activities.crmRelatedType, id: activities.crmRelatedId })
    .from(activities)
    .where(and(isNotNull(activities.crmRelatedId), sql`${activities.crmRelatedType} ~ '^[02]-[0-9]{1,15}$'`))
  const byObject = new Map<string, string[]>()
  for (const l of links) {
    if (!l.type || !l.id || !isHubspotProjectObject(l.type) || !HUBSPOT_ID_RX.test(l.id)) continue
    byObject.set(l.type, [...(byObject.get(l.type) ?? []), l.id])
  }
  for (const [objectTypeId, ids] of byObject) {
    result.scanned += ids.length
    const mappings = await projectMappings(null, objectTypeId)
    const properties = snapshotProperties(objectTypeId, mappings)
    let props: Map<string, PropertyInfo>
    try { props = await getObjectPropertiesSafe(objectTypeId) } catch (err) { result.errors.push(`${objectTypeId}: ${errorText(err)}`); break }
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      try {
        const resolved = await resolveHubspotRecords(objectTypeId, chunk, properties)
        await repointMergedLinks('related', objectTypeId, resolved.merged)
        for (const id of chunk) {
          const currentId = resolved.merged.get(id) ?? id
          const linked = and(eq(activities.crmRelatedType, objectTypeId), eq(activities.crmRelatedId, currentId))
          const record = resolved.records.get(id)
          if (resolved.gone.has(id)) {
            await db.update(activities).set({ crmRelatedDeleted: true, crmDisconnectCheckedAt: new Date() }).where(linked)
            result.notFound += 1
            continue
          }
          if (!record) continue
          const snap = await toSnapshot(objectTypeId, record, mappings, props)
          await db.update(activities).set({ ...snap, crmSnapshotRefreshedAt: new Date(), crmDisconnectCheckedAt: new Date() }).where(linked)
          result.updated += 1
        }
      } catch (err) {
        result.errors.push(`${objectTypeId}_batch_${i}: ${errorText(err)}`)
        if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') return result
      }
    }
  }
  return result
}
