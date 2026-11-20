import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, crmFieldMappings, crmFieldMappingTeams, teamActivityTypes } from '../../../../drizzle/schema.js'
import {
  HUBSPOT_DEAL_WRITE_APP_FIELDS,
  HUBSPOT_ID_RX,
  HUBSPOT_PROJECT_EDITABLE_APP_FIELDS,
  HUBSPOT_PROJECT_PREPEND_APP_FIELDS,
  HUBSPOT_SE_FILTER_APP_FIELD,
  hubspotAppFieldsFor,
  hubspotObjectTakesConstants,
  isHubspotMappingTarget,
  isHubspotProjectObject,
} from '../../../shared/hubspot.js'
import type { Finding, Level, PreviewField, SampleField, SampleResult, SobjectResult, ValidationResult } from '../salesforce/mappingValidation.js'
import { hubspotJson } from './client.js'
import { getHubspotConfig } from './config.js'
import { getObjectProperties, isOwnerProperty, optionLabel, resolveOwnerValue, type PropertyInfo } from './metadata.js'
import { isWritable, type HubspotMappingRow } from './mappings.js'
import { getHubspotOwnerIdForUser } from './owners.js'
import { buildHubspotEngagement, type HubspotEngagementObject } from './writeback.js'
import { isPrependable } from './projects.js'

// Validate & dry run for HubSpot field mappings (HubSpot plan, phase 2b part
// 2). The HubSpot counterpart of salesforce/mappingValidation.ts, returning
// the same result shape so Admin → SF Field Mappings renders it unchanged.
//
// Three layers, all read-only:
//   Static: duplicates, app fields nothing reads, read-only rows that switch
//   off a standard engagement property, constants on objects that are never
//   written.
//   Property: the mapped property exists in the portal, can be written when
//   the write-back sends to it, and its type can hold the value (an
//   enumeration must list the activity type value or constant).
//   Dry run: the write-back's own buildHubspotEngagement(), run against the
//   team's most recent submitted activity, so the preview is the exact
//   property set the worker would send.
//
// Nothing here writes to HubSpot or Postgres.

export interface HubspotValidationRow extends HubspotMappingRow {
  id: string
}

interface ActiveType {
  id: string
  name: string
  crmObjectType: string
  crmPicklistValue: string | null
}

function engagementFor(crmObjectType: string): HubspotEngagementObject {
  return crmObjectType === 'Task' ? 'tasks' : 'meetings'
}

// What the write-back puts in each engagement app field's property.
type ValueKind = 'string' | 'datetime' | 'number' | 'owner' | 'type'
const ENGAGEMENT_VALUE_KIND: Record<string, ValueKind> = {
  title: 'string',
  notes: 'string',
  description: 'string',
  start_datetime: 'datetime',
  end_datetime: 'datetime',
  effort_hours: 'number',
  user_id: 'owner',
  activity_type: 'type',
}

// Standard engagement properties the write-back fills when there's no
// mapping row. A read-only row for one of these switches the standard
// property off, which is rarely what an admin meant.
const STANDARD_ENGAGEMENT_FIELDS: Record<HubspotEngagementObject, readonly string[]> = {
  meetings: ['title', 'start_datetime', 'end_datetime', 'notes', 'user_id'],
  tasks: ['title', 'notes', 'user_id'],
}

// Engagement app fields HubSpot has no standard property for, so they only
// reach HubSpot when mapped.
const MAPPING_ONLY_FIELDS = ['activity_type', 'effort_hours'] as const

// Deal app fields read as numbers by the Deal hover preview.
const DEAL_NUMBER_FIELDS = new Set(['acv', 'opp_new_business_acv', 'opp_new_business_tcv', 'opp_renewal_acv', 'opp_renewal_tcv'])

function kindFits(kind: ValueKind, p: PropertyInfo): boolean {
  switch (kind) {
    case 'string': return p.type === 'string' || p.type === 'phone_number'
    // A HubSpot date property only accepts midnight UTC; the write-back
    // sends a full timestamp.
    case 'datetime': return p.type === 'datetime'
    case 'number': return p.type === 'number'
    case 'owner': return isOwnerProperty(p)
    case 'type': return p.type === 'string' || p.type === 'enumeration'
  }
}

function constantFits(p: PropertyInfo, value: string): boolean {
  if (p.type === 'number') return value.trim() !== '' && Number.isFinite(Number(value))
  if (p.type === 'bool') return value === 'true' || value === 'false'
  return true
}

function renderValue(v: string): string {
  return v.length > 120 ? `${v.slice(0, 117)}…` : v
}

export async function validateHubspotTeamMappings(teamId: string): Promise<ValidationResult> {
  const rows = await db
    .select({
      id: crmFieldMappings.id,
      appField: crmFieldMappings.appField,
      property: crmFieldMappings.crmFieldApi,
      crmObject: crmFieldMappings.crmObject,
      direction: crmFieldMappings.direction,
      isActive: crmFieldMappings.isActive,
      constantValue: crmFieldMappings.constantValue,
      refreshOnlyForReports: crmFieldMappings.refreshOnlyForReports,
    })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(
      eq(crmFieldMappingTeams.teamId, teamId),
      eq(crmFieldMappings.isActive, true),
    ))
  // HubSpot rows only: the fixed objects plus Project objects (0-970, 2-…).
  const mappingRows: HubspotValidationRow[] = rows
    .filter((r) => isHubspotMappingTarget(r.crmObject))
    .map((r) => ({ ...r, refreshOnlyForReports: !!r.refreshOnlyForReports }))

  const activeTypes: ActiveType[] = await db
    .select({ id: teamActivityTypes.id, name: teamActivityTypes.name, crmObjectType: teamActivityTypes.crmObjectType, crmPicklistValue: teamActivityTypes.crmPicklistValue })
    .from(teamActivityTypes)
    .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.isActive, true)))

  const connected = !!(await getHubspotConfig().catch(() => null))

  // Engagement objects this team's activity types write to (meetings when
  // none do), then any other HubSpot object with a mapping.
  const objects: string[] = [...new Set<string>(activeTypes.map((t) => engagementFor(t.crmObjectType)))]
  if (objects.length === 0) objects.push('meetings')
  for (const m of mappingRows) {
    if (!objects.includes(m.crmObject)) objects.push(m.crmObject)
  }

  const sobjects: SobjectResult[] = []
  for (const object of objects) {
    let props: Map<string, PropertyInfo> | null = null
    if (connected) {
      try { props = await getObjectProperties(object, { fresh: true }) } catch { props = null }
    }
    const result = validateHubspotObject({ object, mappingRows, activeTypes, props, connected })
    if (result.isEngagement) {
      result.result.preview = await buildHubspotPreview({ teamId, object: object as HubspotEngagementObject, mappingRows, activeTypes, props })
    }
    sobjects.push(result.result)
  }

  const counts = { error: 0, warning: 0, info: 0 }
  for (const s of sobjects) for (const f of s.findings) counts[f.level] += 1
  return { teamId, checkedAt: new Date().toISOString(), connected, counts, sobjects }
}

// Static and property checks for one object. Pure (no I/O) so tests drive it
// with fixture rows and properties.
export function validateHubspotObject(args: {
  object: string
  mappingRows: HubspotValidationRow[]
  activeTypes: ActiveType[]
  // Null when HubSpot couldn't be read: property checks are skipped.
  props: Map<string, PropertyInfo> | null
  connected: boolean
}): { isEngagement: boolean; result: SobjectResult } {
  const { object, mappingRows, activeTypes, props, connected } = args
  const findings: Finding[] = []
  const add = (level: Level, code: string, params: Record<string, string | number> = {}, m?: HubspotValidationRow) => {
    findings.push({ level, code, sobject: object, appField: m?.appField ?? null, crmFieldApi: m?.property ?? null, mappingId: m?.id ?? null, params })
  }

  const isEngagement = object === 'meetings' || object === 'tasks'
  const isProject = isHubspotProjectObject(object)
  // Project fields the activity drawer writes: edited in the Project panel
  // or posted to as a dated entry (Engineer Notes / Next Steps).
  const projectWrite = (appField: string) => isProject && (HUBSPOT_PROJECT_EDITABLE_APP_FIELDS.has(appField) || HUBSPOT_PROJECT_PREPEND_APP_FIELDS.has(appField))
  const active = mappingRows.filter((m) => m.crmObject === object && m.isActive)
  const typesHere = isEngagement ? activeTypes.filter((t) => engagementFor(t.crmObjectType) === object) : []
  const known = new Set(hubspotAppFieldsFor(object))
  const hasConstant = (m: HubspotValidationRow) => m.constantValue != null && m.constantValue !== ''

  // ── Static ──────────────────────────────────────────────────────────
  if (isEngagement && typesHere.length === 0) add('info', 'no_activity_types')

  // The write-back takes the first row per app field. The SE deal filter is
  // the one app field that uses every row.
  const byAppField = new Map<string, HubspotValidationRow[]>()
  for (const m of active) {
    if (m.appField === '_constant' || m.appField === HUBSPOT_SE_FILTER_APP_FIELD) continue
    byAppField.set(m.appField, [...(byAppField.get(m.appField) ?? []), m])
  }
  for (const [appField, list] of byAppField) {
    if (list.length > 1) add('error', 'duplicate_app_field', { appField, count: list.length, winner: list[0]!.property }, list[0])
  }

  const writableHere = isEngagement ? active.filter((m) => isWritable(m) && (known.has(m.appField) || hasConstant(m))) : []
  if (isEngagement) {
    const byTarget = new Map<string, HubspotValidationRow[]>()
    for (const m of writableHere) {
      const key = m.property.toLowerCase()
      byTarget.set(key, [...(byTarget.get(key) ?? []), m])
    }
    for (const list of byTarget.values()) {
      if (list.length > 1) add('warning', 'duplicate_sf_field', { crmFieldApi: list[0]!.property, appFields: list.map((m) => m.appField).join(', ') }, list[0])
    }
  }

  for (const m of active) {
    if (m.appField === '_constant' || hasConstant(m)) {
      if (!hubspotObjectTakesConstants(object)) add('info', 'hubspot_constant_ignored', {}, m)
      else if (!isWritable(m)) add('warning', 'hubspot_constant_not_written', {}, m)
      if (m.appField === '_constant') continue
    }
    if (!known.has(m.appField)) {
      add('info', 'unknown_app_field', { appField: m.appField }, m)
      continue
    }
    if (isEngagement && !isWritable(m)) {
      const standard = (STANDARD_ENGAGEMENT_FIELDS[object as HubspotEngagementObject] ?? []).includes(m.appField)
      add(standard ? 'warning' : 'info', m.refreshOnlyForReports ? 'refresh_only_on_required' : 'read_only_on_required', { appField: m.appField, crmFieldApi: m.property }, m)
    }
    const dealWrite = object === 'deals' && HUBSPOT_DEAL_WRITE_APP_FIELDS.has(m.appField)
    if (isProject) {
      if (projectWrite(m.appField) && !isWritable(m)) add('info', 'hubspot_project_write_off', { appField: m.appField }, m)
      else if (!projectWrite(m.appField) && m.direction !== 'read') add('info', 'hubspot_project_read_only', { appField: m.appField }, m)
    } else if (dealWrite && !isWritable(m)) add('info', 'hubspot_deal_write_off', { appField: m.appField }, m)
    else if (!isEngagement && !dealWrite && m.direction !== 'read') add('info', object === 'tickets' ? 'hubspot_ticket_read_only' : 'hubspot_deal_read_only', { appField: m.appField }, m)
  }

  if (typesHere.length > 0) {
    for (const appField of MAPPING_ONLY_FIELDS) {
      if (!active.some((m) => m.appField === appField)) add('info', 'hubspot_unmapped_optional', { appField })
    }
  }

  // ── Property checks ─────────────────────────────────────────────────
  if (connected && !props) add('warning', 'describe_failed')
  if (props) {
    for (const m of active) {
      const p = props.get(m.property)
      if (!p) {
        add('error', 'field_not_found', { crmFieldApi: m.property }, m)
        continue
      }
      const writes = (isEngagement && isWritable(m) && (known.has(m.appField) || hasConstant(m)))
        || (object === 'deals' && HUBSPOT_DEAL_WRITE_APP_FIELDS.has(m.appField) && isWritable(m))
        || (projectWrite(m.appField) && isWritable(m))
      if (writes && (p.readOnly || p.calculated)) {
        add('error', 'hubspot_property_read_only', { crmFieldApi: p.name }, m)
        continue
      }
      if (writes && isEngagement && !hasConstant(m)) {
        const kind = ENGAGEMENT_VALUE_KIND[m.appField]
        if (kind && !kindFits(kind, p)) add('error', 'type_mismatch', { crmFieldApi: p.name, crmType: p.type, expected: kind }, m)
      }
      if (writes && isEngagement && hasConstant(m)) {
        const value = m.constantValue!
        if (p.options.size > 0) {
          const missing = value.split(';').filter((v) => !p.options.has(v))
          if (missing.length > 0) add('error', 'constant_not_in_picklist', { crmFieldApi: p.name, value }, m)
        } else if (!constantFits(p, value)) {
          add('error', 'type_mismatch', { crmFieldApi: p.name, crmType: p.type, expected: p.type }, m)
        }
      }
      if (writes && isProject && HUBSPOT_PROJECT_PREPEND_APP_FIELDS.has(m.appField) && !isPrependable(p)) {
        add('error', 'hubspot_not_prependable', { crmFieldApi: p.name }, m)
      }
      if (!isEngagement && !isProject) {
        if (m.appField === HUBSPOT_SE_FILTER_APP_FIELD && !isOwnerProperty(p)) add('warning', 'hubspot_not_owner_property', { crmFieldApi: p.name }, m)
        if (DEAL_NUMBER_FIELDS.has(m.appField) && p.type !== 'number') add('warning', 'type_mismatch', { crmFieldApi: p.name, crmType: p.type, expected: 'number' }, m)
      }
    }

    // Each active type's value must be one of an enumeration's options, or
    // HubSpot rejects the whole engagement.
    const typeRow = writableHere.find((m) => m.appField === 'activity_type')
    const typeProp = typeRow ? props.get(typeRow.property) : undefined
    if (typeRow && typeProp && typeProp.type === 'enumeration' && typeProp.options.size > 0) {
      for (const t of typesHere) {
        const value = t.crmPicklistValue?.trim() || t.name
        if (!typeProp.options.has(value)) add('error', 'type_not_in_picklist', { type: t.name, value, crmFieldApi: typeProp.name }, typeRow)
      }
    }
  }

  if (isProject) add('info', 'hubspot_project_no_dry_run')
  else if (!isEngagement) add('info', 'dry_run_unavailable')

  return {
    isEngagement,
    result: {
      sobject: object,
      mappingCount: active.length,
      activityTypeCount: typesHere.length,
      describeOk: !!props,
      findings,
      preview: null,
    },
  }
}

// The property set the write-back would send for the team's most recent
// submitted activity on this engagement object. Associations aren't shown:
// they're separate calls, not properties.
async function buildHubspotPreview(args: {
  teamId: string
  object: HubspotEngagementObject
  mappingRows: HubspotValidationRow[]
  activeTypes: ActiveType[]
  props: Map<string, PropertyInfo> | null
}): Promise<SobjectResult['preview']> {
  const { teamId, object, mappingRows, activeTypes, props } = args
  const typesHere = activeTypes.filter((t) => engagementFor(t.crmObjectType) === object)
  if (typesHere.length === 0) return null
  const [row] = await db.select().from(activities)
    .where(and(
      eq(activities.teamId, teamId),
      eq(activities.status, 'submitted'),
      inArray(activities.activityTypeId, typesHere.map((t) => t.id)),
    ))
    .orderBy(desc(activities.updatedAt))
    .limit(1)
  if (!row) return { activityId: null, activityTitle: null, fields: [] }

  const type = typesHere.find((t) => t.id === row.activityTypeId)
  const ownerId = await getHubspotOwnerIdForUser(row.userId).catch(() => null)
  const payload = buildHubspotEngagement({
    activity: row,
    activityTypeName: type?.name ?? '',
    picklistValueOverride: type?.crmPicklistValue ?? null,
    objectType: object,
    mappings: mappingRows.filter((m) => m.crmObject === object),
    ownerId,
  })
  const fields: PreviewField[] = Object.entries(payload).map(([name, value]) => {
    const p = props?.get(name)
    return { crmFieldApi: name, label: p?.label ?? null, type: p?.type ?? null, value: renderValue(value) }
  }).sort((a, b) => a.crmFieldApi.localeCompare(b.crmFieldApi))
  return { activityId: row.id, activityTitle: row.title, fields }
}

const PROPERTY_RX = /^[A-Za-z0-9_]{1,100}$/

// "Sample record" for a HubSpot object: any one record, read with the
// team's mapped properties, owner ids and option values shown as names.
export async function sampleHubspotRecord(teamId: string, object: string): Promise<SampleResult> {
  if (!isHubspotMappingTarget(object)) return { sobject: object, connected: false, recordId: null, fields: [] }
  const rows = await db
    .select({ appField: crmFieldMappings.appField, property: crmFieldMappings.crmFieldApi })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(eq(crmFieldMappingTeams.teamId, teamId), eq(crmFieldMappings.crmObject, object), eq(crmFieldMappings.isActive, true)))
  const valid = rows.filter((r) => PROPERTY_RX.test(r.property))
  if (valid.length === 0) return { sobject: object, connected: true, recordId: null, fields: [] }
  if (!(await getHubspotConfig().catch(() => null))) return { sobject: object, connected: false, recordId: null, fields: [] }

  try {
    const body = await hubspotJson<{ results?: Array<{ id?: unknown; properties?: Record<string, string | null> }> }>(
      `/crm/v3/objects/${object}`,
      { query: { limit: 1, properties: [...new Set(valid.map((r) => r.property))].join(','), archived: false } },
    )
    const record = body.results?.[0]
    const id = record?.id != null ? String(record.id) : null
    if (!record || !id || !HUBSPOT_ID_RX.test(id)) return { sobject: object, connected: true, recordId: null, fields: [] }
    const props = await getObjectProperties(object).catch(() => new Map<string, PropertyInfo>())
    const fields: SampleField[] = []
    for (const r of valid) {
      const raw = record.properties?.[r.property] ?? null
      const info = props.get(r.property)
      const value = info && isOwnerProperty(info) ? await resolveOwnerValue(raw) : optionLabel(props, r.property, raw)
      fields.push({ appField: r.appField, crmFieldApi: r.property, value: value ?? '∅' })
    }
    return { sobject: object, connected: true, recordId: id, fields }
  } catch {
    return { sobject: object, connected: true, recordId: null, fields: [] }
  }
}
