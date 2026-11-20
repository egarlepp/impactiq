import type jsforce from 'jsforce'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activities,
  sfEventTypeConfig,
  crmFieldMappings,
  crmFieldMappingTeams,
  teamActivityTypes,
  users,
} from '../../../../drizzle/schema.js'
import { getAdminSfConnection } from './client.js'
import { buildSfRecord } from './writeback.js'
import { resolveFieldPath } from './refreshOppSnapshots.js'
import { resolveOwnerLookupNames } from './resolveLookupNames.js'
import { isHubspotMappingTarget } from '../../../shared/hubspot.js'
import { SF_SE_FILTER_APP_FIELD, SF_SE_FILTER_FIELD_TYPES } from '../../../shared/salesforceSeFilter.js'

// v1.219.0: pre-flight validation + dry run for Admin → SF Field Mappings.
//
// A bad mapping row is uniquely nasty: nothing complains at save time, and the
// damage surfaces hours later as a night of failed write-backs in Sync Issues
// — or, worse, as *silent* data loss, because most mapping mistakes don't
// error at all. A `direction: 'read'` on `title` doesn't fail the sync; it
// creates an Event with a blank Subject. A missing `crm_what_id` mapping
// doesn't fail either; it creates an Event linked to nothing, which quietly
// destroys the entire point of the integration.
//
// Two layers, both read-only:
//
//   Static — duplicates, missing required app fields, direction / refresh-only
//   flags that exclude a field the writeback needs, mappings whose appField
//   the code never reads. Runs with no Salesforce at all.
//
//   Describe — the field exists on this org's object, is createable and
//   updateable, its type can hold what we send, a constantValue fits the
//   field's length and (for picklists) is an allowed value. Uses the ADMIN
//   connection: this is an Admin page doing org-level metadata inspection,
//   which is exactly what that connection is for.
//
// Plus a dry run: the real `buildSfRecord()` from the writeback worker, run
// against a real recent activity, so an admin sees the exact payload the sync
// would send. Deliberately reuses the worker's function rather than
// reimplementing it — a second copy would drift and start reassuring admins
// about a payload that never gets sent.
//
// Nothing here writes. Not to Salesforce, not to Postgres.

export type Level = 'error' | 'warning' | 'info'

export interface Finding {
  level: Level
  /** i18n key suffix under `admin.sf_mappings.validate.codes.*`. */
  code: string
  sobject: string
  appField: string | null
  crmFieldApi: string | null
  mappingId: string | null
  /** Interpolation values for the message. */
  params: Record<string, string | number>
}

export interface PreviewField {
  crmFieldApi: string
  /** SF field label, when describe reached the org. */
  label: string | null
  /** SF field type (`string`, `datetime`, `picklist`, …). */
  type: string | null
  /** The value the writeback worker would send, rendered for display. */
  value: string
}

export interface SobjectResult {
  sobject: string
  /** Active mapping rows scoped to this team + object. */
  mappingCount: number
  /** Active activity types on this team that write to this object. */
  activityTypeCount: number
  describeOk: boolean
  findings: Finding[]
  preview: {
    /** Null when the team has no submitted activity for this object yet. */
    activityId: string | null
    activityTitle: string | null
    fields: PreviewField[]
  } | null
}

export interface ValidationResult {
  teamId: string
  checkedAt: string
  connected: boolean
  counts: { error: number; warning: number; info: number }
  sobjects: SobjectResult[]
}

// The app fields `buildSfRecord` actually reads. Anything else in the
// mappings table is inert for write-back — worth telling an admin about,
// since a typo'd appField looks configured but does nothing.
const KNOWN_WRITE_APP_FIELDS = new Set([
  'title', 'activity_type', 'crm_what_id', 'notes', 'description',
  'start_datetime', 'effort_hours', 'user_id',
])

// v1.300.0: app fields with a REAL write mechanism that lives OUTSIDE
// buildSfRecord() entirely — the SF Project field prepend-update
// (fieldPrepend.ts, §9), the Assigned SE picker's write
// (resolveAssignedSeWriteField in routes/salesforce.ts, §9), and the ACV
// secondary write-back to Opportunity (writeback.ts, §9 "Write-back"). These
// used to fall through to `unknown_app_field` ("isn't an app field the sync
// reads, so this mapping has no effect") — technically true for
// buildSfRecord specifically, but misleading for a field that IS actively
// written by a different, real code path. `compatibleTypes: null` means
// "don't second-guess the SF type" (assigned_se_write already adapts to
// whatever field shape is configured — see the picker's free-text fallback).
const OTHER_WRITE_APP_FIELDS: Record<string, { compatibleTypes: string[] | null }> = {
  eval_engineer_notes: { compatibleTypes: ['textarea', 'string'] },
  eval_next_steps: { compatibleTypes: ['textarea', 'string'] },
  assigned_se_write: { compatibleTypes: null },
  acv: { compatibleTypes: ['int', 'double', 'currency', 'percent'] },
}

// v1.338.0: the Support Ticket attachment feature's app fields (§7/§9) — a
// genuine read path (GET /api/salesforce/tickets/search), just not one that
// routes through buildSfRecord() or refreshOppSnapshots' background-refresh
// convention (backgroundRefresh/refreshOnlyForReports don't apply here: the
// ticket picker reads live per-request, it never gets pulled onto a
// snapshot column nightly). Without this, every ticket_* mapping falsely
// showed as "unknown_app_field" ("isn't an app field the sync reads, so
// this mapping has no effect") even though it's actively used — the exact
// false-negative OTHER_WRITE_APP_FIELDS exists to prevent, just on the read
// side instead of write.
const KNOWN_READ_APP_FIELDS = new Set([
  'ticket_number', 'ticket_subject', 'ticket_date_opened', 'ticket_status',
  'ticket_contact', 'ticket_description', 'ticket_platform', 'ticket_owner',
  'ticket_account',
  // v1.474.0: the default Opportunity search's SE filter (several rows allowed).
  SF_SE_FILTER_APP_FIELD,
])

// App fields that legitimately take several active rows on one object.
const MULTI_ROW_APP_FIELDS = new Set<string>([SF_SE_FILTER_APP_FIELD])

// Without these, the SF record is created but is either unidentifiable or
// unlinked. `crm_what_id` is the one that matters most: an Event with no
// WhatId never appears on the Opportunity, which is the entire integration.
const REQUIRED_APP_FIELDS: Record<string, string[]> = {
  Event: ['title', 'activity_type', 'crm_what_id', 'start_datetime'],
  Task: ['title', 'activity_type', 'crm_what_id', 'start_datetime'],
}

/** What kind of value buildSfRecord puts in each app field's slot. */
type ValueKind = 'string' | 'number' | 'datetime' | 'date' | 'reference' | 'picklist'
const APP_FIELD_VALUE_KIND: Record<string, ValueKind> = {
  title: 'string',
  activity_type: 'picklist',
  crm_what_id: 'reference',
  notes: 'string',
  description: 'string',
  effort_hours: 'number',
  user_id: 'reference',
  // start_datetime is datetime on Event, date on Task — resolved per object.
}

// SF `field.type` values each kind can safely land in. Intentionally
// permissive: the goal is to catch "hours into a text field", not to
// second-guess an admin who knows their org.
const COMPATIBLE_TYPES: Record<ValueKind, string[]> = {
  // v1.300.0: 'combobox' added — a Salesforce combobox (e.g. the standard
  // Event/Task Subject field) is a picklist WITH free-text entry allowed, so
  // writing an arbitrary string to it is always valid. Flagging it as a type
  // mismatch was a false positive on every team's Subject → title mapping.
  string: ['string', 'textarea', 'picklist', 'combobox', 'email', 'phone', 'url', 'encryptedstring', 'multipicklist'],
  number: ['int', 'double', 'currency', 'percent'],
  datetime: ['datetime'],
  date: ['date', 'datetime'],
  reference: ['reference', 'id', 'string'],
  picklist: ['picklist', 'string', 'textarea', 'combobox'],
}

interface DescribedField {
  name: string
  label: string | null
  type: string
  createable: boolean
  updateable: boolean
  nillable: boolean
  length: number | null
  picklistValues: string[]
}

async function describeFields(
  conn: jsforce.Connection,
  sobject: string,
): Promise<Map<string, DescribedField> | null> {
  try {
    const meta = await conn.sobject(sobject).describe()
    const out = new Map<string, DescribedField>()
    for (const f of meta.fields ?? []) {
      const name = f.name ?? ''
      if (!name) continue
      out.set(name.toLowerCase(), {
        name,
        label: f.label ?? null,
        type: String(f.type ?? ''),
        createable: f.createable !== false,
        updateable: f.updateable !== false,
        nillable: f.nillable !== false,
        length: typeof f.length === 'number' && f.length > 0 ? f.length : null,
        picklistValues: Array.isArray(f.picklistValues)
          ? f.picklistValues.filter((p) => p.active !== false).map((p) => p.value)
          : [],
      })
    }
    return out
  } catch {
    return null
  }
}

function renderValue(v: unknown): string {
  if (v === null) return '∅'
  if (v === undefined) return '∅'
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 117)}…` : v
  return String(v)
}

/**
 * Runs every check for one team. Never throws: a Salesforce failure degrades
 * to static-only results with `describeOk: false`, because half an answer
 * beats a red box on a page whose whole job is telling admins what's wrong.
 */
export async function validateTeamMappings(teamId: string): Promise<ValidationResult> {
  const mappingRows = await db
    .select({
      id: crmFieldMappings.id,
      appField: crmFieldMappings.appField,
      crmFieldApi: crmFieldMappings.crmFieldApi,
      crmObject: crmFieldMappings.crmObject,
      direction: crmFieldMappings.direction,
      isActive: crmFieldMappings.isActive,
      constantValue: crmFieldMappings.constantValue,
      backgroundRefresh: crmFieldMappings.backgroundRefresh,
      refreshOnlyForReports: crmFieldMappings.refreshOnlyForReports,
    })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(eq(crmFieldMappingTeams.teamId, teamId))
    // HubSpot mappings share this table (crm_object 'meetings', 'deals', ...)
    // and are checked by hubspot/mappingValidation.ts, never against
    // Salesforce.
    .then((rows) => rows.filter((m) => !isHubspotMappingTarget(m.crmObject)))

  const typeRows = await db
    .select({
      id: teamActivityTypes.id,
      name: teamActivityTypes.name,
      crmObjectType: teamActivityTypes.crmObjectType,
      crmPicklistValue: teamActivityTypes.crmPicklistValue,
      isActive: teamActivityTypes.isActive,
    })
    .from(teamActivityTypes)
    .where(eq(teamActivityTypes.teamId, teamId))
  const activeTypes = typeRows.filter((t) => t.isActive)

  const picklistConfig = await db
    .select({
      crmPicklistValue: sfEventTypeConfig.sfPicklistValue,
      isActive: sfEventTypeConfig.isActive,
      fallbackValue: sfEventTypeConfig.fallbackValue,
    })
    .from(sfEventTypeConfig)
    .where(eq(sfEventTypeConfig.teamId, teamId))

  const conn = await getAdminSfConnection().catch(() => null)

  // Event/Task: the objects this team's active activity types write to.
  // Validating Task mappings for a team with no Task activity types would
  // be noise.
  const eventTaskObjects: string[] = Array.from(new Set(activeTypes.map((t) => t.crmObjectType)))
  if (eventTaskObjects.length === 0) eventTaskObjects.push('Event')

  // v1.296.0: this used to be Event/Task only, which silently skipped every
  // OTHER object a team can genuinely write to — Opportunity (the ACV
  // secondary write-back writeback.ts does after the Event/Task sync) and
  // Evaluations__c (PATCH /evaluations/:relatedId, the field-prepend
  // route) both use real crm_field_mappings rows with direction write/
  // read_write, so a bad mapping there had zero pre-flight coverage. Any
  // object with at least one active write-capable mapping now gets its own
  // section too. Static + describe-layer checks apply the same way; the
  // dry-run payload preview stays Event/Task-only (buildSfRecord() doesn't
  // know how to build a payload for an arbitrary object) — see
  // 'dry_run_unavailable' below.
  const otherWriteObjects = Array.from(new Set(
    mappingRows
      .filter((m) => m.isActive && (m.direction === 'write' || m.direction === 'read_write') && !eventTaskObjects.includes(m.crmObject))
      .map((m) => m.crmObject),
  ))

  // v1.338.0: the above two tiers only ever covered Event/Task and objects
  // with at least one WRITE-capable mapping — a newly-mapped object whose
  // mappings are ALL direction 'read' (e.g. the Support Ticket attachment's
  // ticket_* fields on Case/a custom ticket object, §7/§9) got zero
  // coverage at all: it simply never appeared on this page, with no error
  // or indication anything was skipped. An admin who'd just finished mapping
  // 9 fields for a brand-new object had no way to check any of them without
  // this. Any object with at least one active mapping, any direction, not
  // already covered above, now gets the same static + describe-layer
  // checks (field exists, is queryable, etc.) — just never a dry-run
  // payload preview, exactly like Opportunity/Evaluations__c above.
  const otherReadOnlyObjects = Array.from(new Set(
    mappingRows
      .filter((m) => m.isActive && !eventTaskObjects.includes(m.crmObject) && !otherWriteObjects.includes(m.crmObject))
      .map((m) => m.crmObject),
  ))
  const objects = [...eventTaskObjects, ...otherWriteObjects, ...otherReadOnlyObjects]

  const sobjects: SobjectResult[] = []
  for (const sobject of objects) {
    sobjects.push(await validateOne({
      teamId, sobject, mappingRows, activeTypes, picklistConfig, conn,
    }))
  }

  const counts = { error: 0, warning: 0, info: 0 }
  for (const s of sobjects) for (const f of s.findings) counts[f.level] += 1

  return {
    teamId,
    checkedAt: new Date().toISOString(),
    connected: !!conn,
    counts,
    sobjects,
  }
}

export type MappingRow = {
  id: string
  appField: string
  crmFieldApi: string
  crmObject: string
  direction: string
  isActive: boolean
  constantValue: string | null
  backgroundRefresh: boolean | null
  refreshOnlyForReports: boolean | null
}

// Exported so tests can drive every static + describe-layer check directly
// with fixture data, the same reason buildSfRecord() is exported above — a
// second reimplementation of this logic in a test file would drift.
export async function validateOne(args: {
  teamId: string
  sobject: string
  mappingRows: MappingRow[]
  activeTypes: Array<{ id: string; name: string; crmObjectType: string; crmPicklistValue: string | null }>
  picklistConfig: Array<{ crmPicklistValue: string; isActive: boolean; fallbackValue: string | null }>
  conn: jsforce.Connection | null
}): Promise<SobjectResult> {
  const { teamId, sobject, mappingRows, activeTypes, picklistConfig, conn } = args
  const findings: Finding[] = []
  const add = (
    level: Level,
    code: string,
    params: Record<string, string | number> = {},
    m?: { id: string; appField: string; crmFieldApi: string },
  ) => {
    findings.push({
      level, code, sobject,
      appField: m?.appField ?? null,
      crmFieldApi: m?.crmFieldApi ?? null,
      mappingId: m?.id ?? null,
      params,
    })
  }

  const forObject = mappingRows.filter((m) => m.crmObject === sobject)
  const active = forObject.filter((m) => m.isActive)
  const typesHere = activeTypes.filter((t) => t.crmObjectType === sobject)
  // v1.296.0: activity types only ever target Event/Task (the enum has no
  // other values) — an object like Opportunity or Evaluations__c never has
  // a matching activity type, which isn't the same thing as "misconfigured."
  const isActivityObject = sobject === 'Event' || sobject === 'Task'

  // ── Static: duplicates ────────────────────────────────────────────────
  // resolveSfField() takes the FIRST active match, so a second row for the
  // same appField is dead config that looks live in the table.
  const byAppField = new Map<string, MappingRow[]>()
  for (const m of active) {
    const list = byAppField.get(m.appField) ?? []
    list.push(m)
    byAppField.set(m.appField, list)
  }
  for (const [appField, list] of byAppField) {
    if (list.length > 1 && !MULTI_ROW_APP_FIELDS.has(appField)) {
      add('error', 'duplicate_app_field',
        { appField, count: list.length, winner: list[0]!.crmFieldApi },
        { id: list[0]!.id, appField, crmFieldApi: list[0]!.crmFieldApi })
    }
  }
  const byTarget = new Map<string, MappingRow[]>()
  for (const m of active) {
    const key = m.crmFieldApi.toLowerCase()
    const list = byTarget.get(key) ?? []
    list.push(m)
    byTarget.set(key, list)
  }
  for (const list of byTarget.values()) {
    if (list.length > 1) {
      add('warning', 'duplicate_sf_field',
        { crmFieldApi: list[0]!.crmFieldApi, appFields: list.map((m) => m.appField).join(', ') },
        { id: list[0]!.id, appField: list[0]!.appField, crmFieldApi: list[0]!.crmFieldApi })
    }
  }

  // ── Static: required fields, direction, refresh-only ──────────────────
  const writable = active.filter(
    (m) => (m.direction === 'write' || m.direction === 'read_write') && !m.refreshOnlyForReports,
  )
  const writableByApp = new Map(writable.map((m) => [m.appField, m]))

  if (isActivityObject) {
    if (typesHere.length === 0) {
      add('info', 'no_activity_types', {})
    } else if (active.length === 0) {
      add('error', 'no_mappings', { types: typesHere.length })
    }
  } else if (active.length === 0) {
    // Shouldn't happen — this object only appears in `objects` because it
    // has an active write mapping — but stay honest if that ever changes.
    add('error', 'no_mappings', { types: 0 })
  }

  // v1.300.0: only demand these when the object is actually in use — an
  // Event-only team's Task object has zero active activity types routing to
  // it (already surfaced above as the 'no_activity_types' info note), so
  // requiring Task to ALSO have title/activity_type/crm_what_id/start_datetime
  // mapped was pure noise: 4 scary "missing required field" errors for an
  // object nothing ever actually writes to.
  if (typesHere.length > 0) {
    for (const required of REQUIRED_APP_FIELDS[sobject] ?? []) {
      if (writableByApp.has(required)) continue
      const present = active.find((m) => m.appField === required)
      if (!present) {
        add('error', 'missing_required_app_field', { appField: required })
      } else if (present.refreshOnlyForReports) {
        add('warning', 'refresh_only_on_required', { appField: required, crmFieldApi: present.crmFieldApi },
          { id: present.id, appField: present.appField, crmFieldApi: present.crmFieldApi })
      } else {
        add('warning', 'read_only_on_required', { appField: required, crmFieldApi: present.crmFieldApi },
          { id: present.id, appField: present.appField, crmFieldApi: present.crmFieldApi })
      }
    }
  }

  for (const m of active) {
    // An OTHER_WRITE_APP_FIELDS row only counts as "recognized" while its
    // direction could actually feed that other write path (both
    // field-prepend.ts and the Assigned SE write route require
    // write/read_write themselves) — a read-only row is just as inert as a
    // genuinely unknown appField and should still be flagged.
    const isOtherWriteField = !!OTHER_WRITE_APP_FIELDS[m.appField] && (m.direction === 'write' || m.direction === 'read_write')
    if (!KNOWN_WRITE_APP_FIELDS.has(m.appField) && !isOtherWriteField && !KNOWN_READ_APP_FIELDS.has(m.appField) && !m.constantValue && !m.backgroundRefresh && !m.refreshOnlyForReports) {
      add('info', 'unknown_app_field', { appField: m.appField },
        { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
    }
  }

  // ── Describe-driven checks ────────────────────────────────────────────
  const described = conn ? await describeFields(conn, sobject) : null
  if (conn && !described) add('warning', 'describe_failed', {})

  if (described) {
    for (const m of active) {
      // Relationship paths (`Owner.Name`) are read-side only and never
      // appear in a write payload — skip rather than false-alarm.
      if (m.crmFieldApi.includes('.')) continue
      const f = described.get(m.crmFieldApi.toLowerCase())
      if (!f) {
        add('error', 'field_not_found', { crmFieldApi: m.crmFieldApi },
          { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
        continue
      }
      // v1.300.0: correctness checks (createable/updateable/type) only apply
      // when this mapping's appField is one something ACTUALLY writes —
      // buildSfRecord (KNOWN_WRITE_APP_FIELDS), one of the other real write
      // paths (OTHER_WRITE_APP_FIELDS), or a constant (always applied by
      // writeback.ts regardless of appField). A mapping whose appField
      // nothing reads is already flagged by 'unknown_app_field' above — it
      // would never actually reach Salesforce, so a scary "Salesforce will
      // reject the record" error on top of that was a false alarm: e.g.
      // Assigned_To_Name__c (unrecognized appField, describe() reports
      // createable:false because it's a formula field) used to fire
      // not_createable even though buildSfRecord never sends that field.
      if (m.appField === SF_SE_FILTER_APP_FIELD && !(SF_SE_FILTER_FIELD_TYPES as readonly string[]).includes(f.type)) {
        add('error', 'type_mismatch', { crmFieldApi: f.name, crmType: f.type, expected: SF_SE_FILTER_FIELD_TYPES.join('/') },
          { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
      }
      const otherWrite = OTHER_WRITE_APP_FIELDS[m.appField]
      const isRecognizedWriteField = KNOWN_WRITE_APP_FIELDS.has(m.appField) || !!otherWrite
      const hasConstant = m.constantValue != null && m.constantValue !== ''
      const isWritable = (isRecognizedWriteField && writableByApp.get(m.appField)?.id === m.id) || hasConstant
      if (isWritable) {
        if (!f.createable) {
          add('error', 'not_createable', { crmFieldApi: f.name, type: f.type },
            { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
        } else if (!f.updateable) {
          // Creates succeed, re-syncs fail. Worth a warning, not an error.
          add('warning', 'not_updateable', { crmFieldApi: f.name },
            { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
        }
        const kind: ValueKind | undefined = m.appField === 'start_datetime'
          ? (sobject === 'Event' ? 'datetime' : 'date')
          : APP_FIELD_VALUE_KIND[m.appField]
        if (kind && f.createable && !COMPATIBLE_TYPES[kind].includes(f.type)) {
          add('error', 'type_mismatch', { crmFieldApi: f.name, crmType: f.type, expected: kind },
            { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
        } else if (otherWrite?.compatibleTypes && f.createable && !otherWrite.compatibleTypes.includes(f.type)) {
          add('error', 'type_mismatch', { crmFieldApi: f.name, crmType: f.type, expected: otherWrite.compatibleTypes.join('/') },
            { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
        }
      }
      if (m.constantValue != null && m.constantValue !== '') {
        if (f.length && m.constantValue.length > f.length) {
          add('error', 'constant_too_long', { crmFieldApi: f.name, length: f.length, actual: m.constantValue.length },
            { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
        }
        if (f.picklistValues.length > 0 && !f.picklistValues.includes(m.constantValue)) {
          add('error', 'constant_not_in_picklist', { crmFieldApi: f.name, value: m.constantValue },
            { id: m.id, appField: m.appField, crmFieldApi: m.crmFieldApi })
        }
      }
    }

    // Every active activity type resolves to a Type value that has to exist
    // in the org's picklist. This is the check that catches the classic
    // "the SF admin never added Meeting" failure — one row per type, before
    // a single sync runs.
    const typeMapping = writableByApp.get('activity_type')
    if (typeMapping) {
      const f = described.get(typeMapping.crmFieldApi.toLowerCase())
      if (f && f.picklistValues.length > 0) {
        for (const t of typesHere) {
          const resolved = t.crmPicklistValue?.trim() || t.name
          const cfg = picklistConfig.find((p) => p.crmPicklistValue === resolved)
          // Mirror buildSfRecord's fallback semantics exactly: an inactive
          // config row substitutes its fallback, and a missing row when
          // other rows exist means the Type is dropped entirely.
          const effective = cfg
            ? (cfg.isActive ? resolved : cfg.fallbackValue)
            : (picklistConfig.length === 0 ? resolved : null)
          if (effective === null) {
            add('warning', 'type_dropped', { type: t.name })
            continue
          }
          if (!f.picklistValues.includes(effective)) {
            add('error', 'type_not_in_picklist',
              { type: t.name, value: effective, crmFieldApi: f.name },
              { id: typeMapping.id, appField: 'activity_type', crmFieldApi: typeMapping.crmFieldApi })
          }
        }
      }
    }
  }

  // ── Dry run ───────────────────────────────────────────────────────────
  // buildSfRecord() only knows how to build an Event/Task payload — it has
  // no concept of an Opportunity or Evaluations__c record shape. Say so
  // rather than silently showing an empty preview for those objects.
  if (!isActivityObject) add('info', 'dry_run_unavailable', {})
  const preview = isActivityObject
    ? await buildPreview({ teamId, sobject, typesHere, forObject, picklistConfig, described })
    : null

  return {
    sobject,
    mappingCount: active.length,
    activityTypeCount: typesHere.length,
    describeOk: !!described,
    findings,
    preview,
  }
}

/**
 * Builds the payload the writeback worker WOULD send, from the team's most
 * recent submitted activity on this object. Returns null when there's nothing
 * to build from — better an honest "no activity yet" than a synthetic payload
 * an admin might mistake for real data.
 */
async function buildPreview(args: {
  teamId: string
  sobject: string
  typesHere: Array<{ id: string; name: string; crmPicklistValue: string | null }>
  forObject: MappingRow[]
  picklistConfig: Array<{ crmPicklistValue: string; isActive: boolean; fallbackValue: string | null }>
  described: Map<string, DescribedField> | null
}): Promise<SobjectResult['preview']> {
  const { teamId, sobject, typesHere, forObject, picklistConfig, described } = args
  if (typesHere.length === 0) return null
  const typeIds = typesHere.map((t) => t.id)
  const [row] = await db
    .select({ a: activities, crmUserId: users.crmUserId })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.userId))
    .where(and(
      eq(activities.teamId, teamId),
      eq(activities.status, 'submitted'),
      inArray(activities.activityTypeId, typeIds),
    ))
    .orderBy(desc(activities.updatedAt))
    .limit(1)
  if (!row) return { activityId: null, activityTitle: null, fields: [] }

  const type = typesHere.find((t) => t.id === row.a.activityTypeId)
  const record = buildSfRecord({
    activity: row.a,
    activityTypeName: type?.name ?? '',
    sfPicklistValueOverride: type?.crmPicklistValue ?? null,
    crmObjectType: sobject === 'Task' ? 'Task' : 'Event',
    fieldMappings: forObject.map((m) => ({
      appField: m.appField,
      crmFieldApi: m.crmFieldApi,
      isActive: m.isActive,
      direction: m.direction,
      constantValue: m.constantValue,
      refreshOnlyForReports: m.refreshOnlyForReports ?? false,
    })),
    picklistConfig,
    ownerCrmUserId: row.crmUserId ?? null,
  })

  const fields: PreviewField[] = Object.entries(record).map(([crmFieldApi, value]) => {
    const f = described?.get(crmFieldApi.toLowerCase())
    return {
      crmFieldApi,
      label: f?.label ?? null,
      type: f?.type ?? null,
      value: renderValue(value),
    }
  }).sort((a, b) => a.crmFieldApi.localeCompare(b.crmFieldApi))

  return { activityId: row.a.id, activityTitle: row.a.title, fields }
}

// v1.338.0: "Sample record" — an on-demand, per-object live read, separate
// from Run Check (which stays static + describe only, so clicking it never
// costs a live SOQL query per object). Answers the question the dry-run
// preview can't for anything but Event/Task: "what does this actually look
// like coming back from Salesforce?" — most useful for exactly the object
// class §9's dry-run explicitly can't build a payload for (Opportunity,
// Evaluations__c, and now any read-only-mapped object like the Ticket
// picker's Case/Ticket object), but works for every object.
//
// Admin connection (org-level read on an Admin page, same as the describe
// layer above), no WHERE/ORDER BY — literally "any one record" rather than
// something curated, so an admin sees real, unfiltered field shapes
// (blank/null included) instead of a hand-picked good example.
const FIELD_PATH_RX = /^[A-Za-z0-9_.]{1,120}$/

export interface SampleField {
  appField: string
  crmFieldApi: string
  value: string
}

export interface SampleResult {
  sobject: string
  connected: boolean
  recordId: string | null
  fields: SampleField[]
}

export async function sampleObjectRecord(teamId: string, sobject: string): Promise<SampleResult> {
  if (!FIELD_PATH_RX.test(sobject)) return { sobject, connected: false, recordId: null, fields: [] }

  const rows = await db
    .select({ appField: crmFieldMappings.appField, crmFieldApi: crmFieldMappings.crmFieldApi, referenceTo: crmFieldMappings.referenceTo })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(
      eq(crmFieldMappingTeams.teamId, teamId),
      eq(crmFieldMappings.crmObject, sobject),
      eq(crmFieldMappings.isActive, true),
    ))
  const valid = rows.filter((r) => FIELD_PATH_RX.test(r.crmFieldApi))
  if (valid.length === 0) return { sobject, connected: true, recordId: null, fields: [] }

  const conn = await getAdminSfConnection().catch(() => null)
  if (!conn) return { sobject, connected: false, recordId: null, fields: [] }

  const selectFields = Array.from(new Set(valid.map((r) => r.crmFieldApi)))
  const soql = `SELECT Id, ${selectFields.join(', ')} FROM ${sobject} LIMIT 1`
  try {
    const q = await conn.query<Record<string, unknown>>(soql)
    const record = q.records[0]
    if (!record) return { sobject, connected: true, recordId: null, fields: [] }
    const rawValues = valid.map((r) => resolveFieldPath(record, r.crmFieldApi))
    // v1.286.0 already established this exact fix for eval_primary_engineer
    // (a genuine Lookup(User) whose raw value is a Salesforce Id, not a
    // name) — same resolution here for any mapped field on any object, e.g.
    // ticket_owner -> Case.OwnerId. v1.340.0: gated on referenceTo being
    // truthy rather than exactly 'User' — OwnerId-shaped fields are
    // POLYMORPHIC (User or Group/Queue), and the admin UI's auto-captured
    // referenceTo only ever stores one of the two possible target types, so
    // resolveOwnerLookupNames() tries the local crm_users cache first, then
    // falls back to a live Group query for whatever's left unresolved.
    const lookupRawIds = valid
      .map((r, i) => (r.referenceTo ? rawValues[i] : null))
      .filter((v): v is string => !!v)
    const nameById = await resolveOwnerLookupNames(conn, lookupRawIds)
    const fields: SampleField[] = valid.map((r, i) => {
      const raw = rawValues[i]
      const resolved = r.referenceTo && raw ? (nameById.get(raw) ?? raw) : raw
      return { appField: r.appField, crmFieldApi: r.crmFieldApi, value: resolved ?? '∅' }
    })
    return { sobject, connected: true, recordId: String(record['Id']), fields }
  } catch {
    // A field that exists in the mapping but not on this org (already
    // caught by Run Check's field_not_found) would fail the whole SELECT —
    // degrade to "no sample available" rather than a 500, same "half an
    // answer beats none" posture as validateTeamMappings() above.
    return { sobject, connected: true, recordId: null, fields: [] }
  }
}
