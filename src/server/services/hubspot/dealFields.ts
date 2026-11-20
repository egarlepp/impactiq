import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activityTypeTeams, hubspotOwners, teamActivityTypes, teamActivityTypeCrmExtras, users } from '../../../../drizzle/schema.js'
import { HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import { HUBSPOT_OPP_FIELD_OBJECT, HUBSPOT_PROPERTY_RX } from '../../../shared/crmExtras.js'
import { isImpactIqUserName } from '../salesforce/preview.js'
import { logSfSyncAttempt } from '../salesforce/syncAudit.js'
import { HubspotError, hubspotRequest } from './client.js'
import { loadHubspotMappings, isWritable } from './mappings.js'
import { getObjectProperties, getObjectPropertiesSafe, isOwnerProperty, optionLabel, ownerNames, type PropertyInfo } from './metadata.js'
import { getHubspotOwnerIdForUser, getUserForHubspotOwner, userIsHubspotOwner } from './owners.js'

// Deal fields ImpactIQ writes on HubSpot (HubSpot plan, phase 6): the
// Assigned SE picker on the activity form and the ACV secondary write-back.
// The HubSpot side of the Salesforce Assigned SE routes and writeback.ts's
// ACV update. Both only act through a writable `deals` mapping (Admin →
// HubSpot Field Mappings): HubSpot portals name these properties
// themselves, so there is no fallback property the way Salesforce falls
// back to Assigned_SE__c.

export type AssignedSeFieldType = 'owner' | 'picklist' | 'string'

export interface AssignedSeField {
  property: string
  fieldType: AssignedSeFieldType
  info: PropertyInfo | null
}

// The team's writable assigned_se_write mapping, with what kind of value
// the property takes. Null when the team hasn't mapped one.
export async function resolveAssignedSeField(teamId: string | null): Promise<AssignedSeField | null> {
  if (!teamId) return null
  const rows = await loadHubspotMappings(teamId, ['deals'])
  const row = rows.find((r) => r.appField === 'assigned_se_write' && isWritable(r))
  if (!row) return null
  const info = (await getObjectPropertiesSafe('deals')).get(row.property) ?? null
  const fieldType: AssignedSeFieldType = info && isOwnerProperty(info) ? 'owner' : info && info.options.size > 0 ? 'picklist' : 'string'
  return { property: row.property, fieldType, info }
}

// Is this person on ImpactIQ? An owner value is matched to a user by the
// owner rule (manual link, else email), anything else by display name, the
// same stand-in the Salesforce picker uses for its picklist strings.
async function ownerIsImpactIqUser(ownerId: string): Promise<boolean> {
  return (await getUserForHubspotOwner(ownerId)) !== null
}

export interface AssignedSeValue {
  userId: string | null
  userName: string | null
  matched: boolean | null
}

// The display value for a raw property value: owner ids become names,
// option values their labels.
async function displayValue(field: AssignedSeField, raw: string | null): Promise<AssignedSeValue> {
  if (!raw) return { userId: null, userName: null, matched: null }
  if (field.fieldType === 'owner') {
    const name = (await ownerNames([raw])).get(raw) ?? raw
    return { userId: raw, userName: name, matched: await ownerIsImpactIqUser(raw) }
  }
  const label = field.info ? optionLabel(new Map([[field.property, field.info]]), field.property, raw) ?? raw : raw
  return { userId: raw, userName: label, matched: await isImpactIqUserName(label) }
}

export async function readHubspotAssignedSe(field: AssignedSeField, dealId: string): Promise<AssignedSeValue> {
  if (!HUBSPOT_ID_RX.test(dealId)) return { userId: null, userName: null, matched: null }
  const { status, body } = await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, { query: { properties: field.property } })
  if (status === 404) return { userId: null, userName: null, matched: null }
  if (status < 200 || status >= 300) throw new HubspotError(status === 403 ? 'errors.hubspot.forbidden' : 'errors.hubspot.bad_response', status)
  const props = (body as { properties?: Record<string, unknown> } | null)?.properties ?? {}
  const raw = props[field.property]
  return displayValue(field, raw == null || raw === '' ? null : String(raw))
}

// What the picker offers: the portal's active owners for a "HubSpot user"
// property, the property's options for an enumeration, nothing for free
// text (the picker then writes what was typed).
export async function hubspotAssignedSeOptions(field: AssignedSeField): Promise<Array<{ value: string; label: string; matched: boolean }>> {
  if (field.fieldType === 'owner') {
    const rows = await db.select({ id: hubspotOwners.id, firstName: hubspotOwners.firstName, lastName: hubspotOwners.lastName, email: hubspotOwners.email })
      .from(hubspotOwners).where(eq(hubspotOwners.archived, false))
    const onImpactIq = new Set((await db.selectDistinct({ id: hubspotOwners.id })
      .from(hubspotOwners).innerJoin(users, userIsHubspotOwner)
      .where(eq(hubspotOwners.archived, false))).map((r) => r.id))
    return rows
      .map((r) => ({ value: r.id, label: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.email || r.id, matched: onImpactIq.has(r.id) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }
  if (field.fieldType === 'picklist' && field.info) {
    const out: Array<{ value: string; label: string; matched: boolean }> = []
    for (const [value, label] of field.info.options) out.push({ value, label, matched: !!(await isImpactIqUserName(label)) })
    return out
  }
  return []
}

// Only someone who is a HubSpot user in this portal (matched by the owner
// rule: manual link, else email) may change a Deal: ImpactIQ writes with the
// portal-wide key, so this stands in for Salesforce checking the user's own
// permissions on the record.
export async function canWriteHubspotDeals(userId: string): Promise<boolean> {
  return (await getHubspotOwnerIdForUser(userId)) !== null
}

function hubspotMessage(status: number, body: unknown): string {
  const msg = body && typeof body === 'object' ? (body as Record<string, unknown>)['message'] : null
  return `HubSpot ${status}${typeof msg === 'string' && msg ? `: ${msg}` : ''}`
}

// Writes the Assigned SE value (null clears it) and records the attempt in
// CRM Sync History. Resolves to null on success or HubSpot's error text.
export async function writeHubspotAssignedSe(args: { field: AssignedSeField; dealId: string; value: string | null; valueName: string | null; userId: string }): Promise<string | null> {
  const { field, dealId, value, valueName, userId } = args
  if (!HUBSPOT_ID_RX.test(dealId)) return `Not a HubSpot record: ${dealId}`
  const payload = { [field.property]: value ?? '' }
  let error: string | null = null
  try {
    const { status, body } = await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, { method: 'PATCH', body: { properties: payload } })
    if (status < 200 || status >= 300) error = hubspotMessage(status, body)
  } catch (err) {
    error = err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)
  }
  void logSfSyncAttempt({
    source: 'assigned_se_update', status: error ? 'failed' : 'success', operation: 'update', crmObject: 'deals', crmRecordId: dealId,
    userId, errorMessage: error, payload: { ...payload, assigneeName: valueName },
  })
  return error
}

// The ACV secondary write-back: after an activity's meeting/task syncs, its
// ACV goes onto the linked Deal through the team's writable `acv` mapping.
// No mapping, nothing written (same contract as Salesforce since v1.296).
// Never throws; a failure is returned for the caller to log.
export async function writeHubspotDealAcv(teamId: string, dealId: string, acv: number): Promise<string | null> {
  if (!HUBSPOT_ID_RX.test(dealId) || !Number.isFinite(acv)) return null
  try {
    const rows = await loadHubspotMappings(teamId, ['deals'])
    const row = rows.find((r) => r.appField === 'acv' && isWritable(r))
    if (!row) return null
    const { status, body } = await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, { method: 'PATCH', body: { properties: { [row.property]: String(acv) } } })
    return status >= 200 && status < 300 ? null : hubspotMessage(status, body)
  } catch (err) {
    return err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)
  }
}

// ── Opp field extras on a Deal ────────────────────────────────────────────
// An Activity Type's "Opp field" extra on HubSpot names one Deal property
// (config { sobject: 'deals', apiName }). The activity form shows its value
// and, when the extra is read / write, edits it: the HubSpot side of
// GET/PATCH /api/salesforce/opportunities/:id/field.

export interface DealFieldValue {
  // A checkbox reads as a boolean and a number property as a number, the
  // same shapes the Salesforce route returns; anything else is the raw text.
  value: unknown
  // The option label for an enumeration value, else null.
  label: string | null
  options: Array<{ value: string; label: string }> | null
  writable: boolean
}

export function dealFieldFromHubspot(info: PropertyInfo | null, raw: unknown): unknown {
  if (raw == null || raw === '') return null
  const s = String(raw)
  if (info?.type === 'bool') return s === 'true'
  if (info?.type === 'number') {
    const n = Number(s)
    return Number.isFinite(n) ? n : s
  }
  return s
}

// HubSpot takes every property value as text; null clears it.
export function dealFieldToHubspot(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function isWritableProperty(info: PropertyInfo | null): boolean {
  return !!info && !info.readOnly && !info.calculated
}

export async function readHubspotDealField(dealId: string, property: string): Promise<DealFieldValue> {
  const props = await getObjectPropertiesSafe('deals')
  const info = props.get(property) ?? null
  const options = info && info.options.size > 0 ? [...info.options].map(([value, label]) => ({ value, label })) : null
  const empty: DealFieldValue = { value: null, label: null, options, writable: isWritableProperty(info) }
  if (!HUBSPOT_ID_RX.test(dealId) || !HUBSPOT_PROPERTY_RX.test(property)) return empty
  const { status, body } = await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, { query: { properties: property } })
  if (status === 404) return empty
  if (status < 200 || status >= 300) throw new HubspotError(status === 403 ? 'errors.hubspot.forbidden' : 'errors.hubspot.bad_response', status)
  const raw = ((body as { properties?: Record<string, unknown> } | null)?.properties ?? {})[property]
  const value = dealFieldFromHubspot(info, raw)
  const label = typeof value === 'string' && info ? optionLabel(props, property, value) : null
  return { ...empty, value, label: label && label !== value ? label : null }
}

// Is `property` the target of a read / write Opp field extra on an activity
// type of one of these teams? ImpactIQ writes with the portal-wide key, so a
// Deal property is only editable where an admin turned that on.
export async function isEditableDealFieldExtra(teamIds: string[], property: string): Promise<boolean> {
  if (teamIds.length === 0) return false
  const rows = await db.select({ config: teamActivityTypeCrmExtras.config })
    .from(teamActivityTypeCrmExtras)
    .innerJoin(teamActivityTypes, eq(teamActivityTypeCrmExtras.teamActivityTypeId, teamActivityTypes.id))
    .leftJoin(activityTypeTeams, eq(activityTypeTeams.activityTypeId, teamActivityTypes.id))
    .where(and(
      eq(teamActivityTypeCrmExtras.kind, 'opp_field_display'),
      or(inArray(teamActivityTypes.teamId, teamIds), inArray(activityTypeTeams.teamId, teamIds)),
    ))
  return rows.some((r) => {
    const c = (r.config ?? {}) as Record<string, unknown>
    return c['sobject'] === HUBSPOT_OPP_FIELD_OBJECT && c['apiName'] === property && c['mode'] === 'read_write'
  })
}

export type DealFieldWriteResult = { ok: true } | { ok: false; status: number; error: string }

// Writes one Deal property and records the attempt in CRM Sync History.
// Refuses a property HubSpot won't let anyone edit, an option the property
// doesn't have, and text in a number property, before calling HubSpot.
export async function writeHubspotDealField(args: { dealId: string; property: string; value: unknown; userId: string }): Promise<DealFieldWriteResult> {
  const { dealId, property, value, userId } = args
  if (!HUBSPOT_ID_RX.test(dealId)) return { ok: false, status: 400, error: 'errors.hubspot.invalid_object' }
  if (!HUBSPOT_PROPERTY_RX.test(property)) return { ok: false, status: 400, error: 'errors.validation.invalid_api_name' }
  const info = (await getObjectProperties('deals')).get(property) ?? null
  if (!isWritableProperty(info)) return { ok: false, status: 400, error: 'errors.hubspot.deal_field_read_only' }
  const text = dealFieldToHubspot(value)
  if (text !== '' && info!.type === 'number' && !Number.isFinite(Number(text))) return { ok: false, status: 400, error: 'errors.hubspot.deal_field_invalid' }
  if (text !== '' && info!.type === 'enumeration' && info!.options.size > 0 && !text.split(';').every((v) => info!.options.has(v))) {
    return { ok: false, status: 400, error: 'errors.hubspot.deal_field_invalid' }
  }
  const payload = { [property]: text }
  let error: string | null = null
  try {
    const { status, body } = await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, { method: 'PATCH', body: { properties: payload } })
    if (status < 200 || status >= 300) error = hubspotMessage(status, body)
  } catch (err) {
    error = err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)
  }
  void logSfSyncAttempt({
    source: 'opportunity_field_update', status: error ? 'failed' : 'success', operation: 'update', crmObject: 'deals', crmRecordId: dealId,
    userId, errorMessage: error, payload,
  })
  return error ? { ok: false, status: 502, error } : { ok: true }
}
