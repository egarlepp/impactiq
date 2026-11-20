import { inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { hubspotOwners } from '../../../../drizzle/schema.js'
import type { HubspotPropertyField } from '../../../shared/hubspot.js'
import { HubspotError, hubspotJson } from './client.js'

// Portal metadata that turns HubSpot's internal values into the labels a
// person reads (phase 2b): deal stage ids → stage names, enumeration values
// → option labels, owner ids → names. Pipelines and properties change on the
// scale of admin edits, so they're cached for an hour. Owner names come from
// the local hubspot_owners copy (owners.ts), never a live call.

const TTL_MS = 60 * 60 * 1000

export interface DealStageInfo {
  label: string
  pipelineId: string
  pipelineLabel: string
  isClosed: boolean
  // HubSpot marks a won stage with probability 1.0 on a closed stage.
  isWon: boolean
}

export interface PropertyInfo {
  name: string
  label: string
  type: string
  fieldType: string
  readOnly: boolean
  // Calculated properties (rollups, formulas) can't be written either.
  calculated: boolean
  // HubSpot's own property, as opposed to one the portal added.
  hubspotDefined: boolean
  // 'OWNER' on a "HubSpot user" property (its values are owner ids).
  referencedObjectType: string | null
  options: Map<string, string>
}

let stageCache: { at: number; stages: Map<string, DealStageInfo> } | null = null
const propertyCache = new Map<string, { at: number; props: Map<string, PropertyInfo> }>()

interface PipelineApi {
  id?: unknown
  label?: unknown
  stages?: Array<{ id?: unknown; label?: unknown; metadata?: { isClosed?: unknown; probability?: unknown } }>
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

export function stagesFromPipelines(pipelines: PipelineApi[]): Map<string, DealStageInfo> {
  const out = new Map<string, DealStageInfo>()
  for (const p of pipelines) {
    const pipelineId = text(p.id)
    if (!pipelineId) continue
    for (const s of p.stages ?? []) {
      const id = text(s.id)
      if (!id) continue
      const isClosed = String(s.metadata?.isClosed) === 'true'
      out.set(id, {
        label: text(s.label) ?? id,
        pipelineId,
        pipelineLabel: text(p.label) ?? pipelineId,
        isClosed,
        isWon: isClosed && Number(s.metadata?.probability) === 1,
      })
    }
  }
  return out
}

export async function getDealStages(): Promise<Map<string, DealStageInfo>> {
  if (stageCache && Date.now() - stageCache.at < TTL_MS) return stageCache.stages
  const body = await hubspotJson<{ results?: PipelineApi[] }>('/crm/v3/pipelines/deals')
  const stages = stagesFromPipelines(Array.isArray(body.results) ? body.results : [])
  stageCache = { at: Date.now(), stages }
  return stages
}

// Stage labels without failing the caller: a missing pipelines scope or a
// HubSpot hiccup leaves the raw stage id showing instead of an error.
export async function getDealStagesSafe(): Promise<Map<string, DealStageInfo>> {
  try { return await getDealStages() } catch { return new Map() }
}

interface PropertyApi {
  name?: unknown
  label?: unknown
  type?: unknown
  fieldType?: unknown
  calculated?: unknown
  hubspotDefined?: unknown
  referencedObjectType?: unknown
  modificationMetadata?: { readOnlyValue?: unknown }
  options?: Array<{ value?: unknown; label?: unknown; hidden?: unknown }>
}

// `fresh` skips the cache: the admin mappings screen and its validation
// should see a property an admin created a minute ago.
export async function getObjectProperties(objectType: string, opts: { fresh?: boolean } = {}): Promise<Map<string, PropertyInfo>> {
  const hit = propertyCache.get(objectType)
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.props
  const body = await hubspotJson<{ results?: PropertyApi[] }>(`/crm/v3/properties/${encodeURIComponent(objectType)}`)
  const props = new Map<string, PropertyInfo>()
  for (const p of Array.isArray(body.results) ? body.results : []) {
    const name = text(p.name)
    if (!name) continue
    const options = new Map<string, string>()
    for (const o of p.options ?? []) {
      const value = text(o.value)
      if (value) options.set(value, text(o.label) ?? value)
    }
    props.set(name, {
      name,
      label: text(p.label) ?? name,
      type: text(p.type) ?? 'string',
      fieldType: text(p.fieldType) ?? 'text',
      readOnly: p.modificationMetadata?.readOnlyValue === true,
      calculated: p.calculated === true,
      hubspotDefined: p.hubspotDefined === true,
      referencedObjectType: text(p.referencedObjectType),
      options,
    })
  }
  propertyCache.set(objectType, { at: Date.now(), props })
  return props
}

export async function getObjectPropertiesSafe(objectType: string): Promise<Map<string, PropertyInfo>> {
  try { return await getObjectProperties(objectType) } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
    return new Map()
  }
}

// The option label for an enumeration value; multi-select values (a;b) are
// labelled one by one.
export function optionLabel(props: Map<string, PropertyInfo>, property: string, value: string | null): string | null {
  if (value == null || value === '') return null
  const info = props.get(property)
  if (!info || info.options.size === 0) return value
  return value.split(';').map((v) => info.options.get(v) ?? v).join(', ')
}

export async function ownerNames(ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((v): v is string => !!v))]
  const out = new Map<string, string>()
  if (wanted.length === 0) return out
  const rows = await db.select({ id: hubspotOwners.id, firstName: hubspotOwners.firstName, lastName: hubspotOwners.lastName, email: hubspotOwners.email })
    .from(hubspotOwners).where(inArray(hubspotOwners.id, wanted))
  for (const r of rows) {
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim()
    out.set(r.id, name || r.email || r.id)
  }
  return out
}

// Owner-id properties ("HubSpot user" type) hold one or more owner ids
// separated by ';'. Resolves each to a name when it's a known owner, keeping
// the raw value otherwise.
export async function resolveOwnerValue(value: string | null): Promise<string | null> {
  if (!value) return null
  const parts = value.split(';').map((v) => v.trim()).filter(Boolean)
  if (parts.length === 0 || !parts.every((p) => /^[0-9]+$/.test(p))) return value
  const names = await ownerNames(parts)
  return parts.map((p) => names.get(p) ?? p).join(', ')
}

export function isOwnerProperty(info: Pick<PropertyInfo, 'referencedObjectType'>): boolean {
  return info.referencedObjectType === 'OWNER'
}

// A property in the shape the mappings screen uses for Salesforce fields
// (phase 2b part 2), with HubSpot's type folded into the Salesforce-style
// names the constant input understands.
export function toPropertyField(info: PropertyInfo): HubspotPropertyField {
  let type: HubspotPropertyField['type'] = 'string'
  if (info.type === 'bool' || info.fieldType === 'booleancheckbox') type = 'boolean'
  else if (info.type === 'enumeration') type = isOwnerProperty(info) ? 'owner' : info.fieldType === 'checkbox' ? 'multipicklist' : 'picklist'
  else if (info.type === 'number') type = 'double'
  else if (info.type === 'date') type = 'date'
  else if (info.type === 'datetime') type = 'datetime'
  else if (info.fieldType === 'textarea' || info.fieldType === 'html') type = 'textarea'
  return {
    apiName: info.name,
    label: info.label,
    type,
    hubspotType: info.type,
    fieldType: info.fieldType,
    isCustom: !info.hubspotDefined,
    readOnly: info.readOnly || info.calculated,
    referenceTo: [],
    picklistValues: [...info.options].map(([value, label]) => ({ value, label })),
  }
}

export function clearHubspotMetadataCache(): void {
  stageCache = null
  propertyCache.clear()
}

// Options for the dashboard's Deal Stage and Forecast filter chips (phase 3):
// every stage label across the portal's deal pipelines, in pipeline order,
// and the forecast category option labels, which are the values the
// snapshot columns hold. Stage labels shared by several pipelines ("Closed
// won") are one option, since the filter matches on the label. With more
// than one pipeline each stage is grouped under its (first) pipeline.
export async function getDealFilterOptions(): Promise<{ stages: string[]; forecast: string[]; stageGroups: Record<string, string> | null }> {
  const [stages, props] = await Promise.all([getDealStagesSafe(), getObjectPropertiesSafe('deals').catch(() => new Map<string, PropertyInfo>())])
  const labels: string[] = []
  const groups: Record<string, string> = {}
  const pipelines = new Set<string>()
  for (const s of stages.values()) {
    pipelines.add(s.pipelineId)
    if (labels.includes(s.label)) continue
    labels.push(s.label)
    groups[s.label] = s.pipelineLabel
  }
  const forecast = [...new Set(props.get('hs_manual_forecast_category')?.options.values() ?? [])]
  return { stages: labels, forecast, stageGroups: pipelines.size > 1 ? groups : null }
}
