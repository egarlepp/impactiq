import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activitySyncAudit, teamActivityTypes } from '../../../../drizzle/schema.js'
import { HUBSPOT_CAMPAIGN_ID_RX, HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { MAX_SYNC_RETRIES, processPendingActivities, retryBackoffMs } from '../salesforce/writeback.js'
import { HubspotError, hubspotRequest } from './client.js'
import { isWritable, loadHubspotMappings, type HubspotMappingRow } from './mappings.js'
import { getHubspotOwnerIdForUser } from './owners.js'
import { writeHubspotDealAcv } from './dealFields.js'
import { hubspotSearch } from './search.js'
import { findExistingHubspotMeeting } from './meetingMatch.js'
import { getCrmFeatures } from '../crm/features.js'
import { emitActivityEvent } from '../webhooks/events.js'
import { parkDemoActivitySync } from '../demo/ids.js'

// Activity write-back to HubSpot (HubSpot plan, phase 2b). The HubSpot
// counterpart of salesforce/writeback.ts, using the same activity columns:
// crm_record_id holds the HubSpot engagement id, crm_sync_status / attempts /
// next_retry_at drive the same retry schedule, and every attempt lands in
// activity_sync_audit so Admin → CRM Sync shows it.
//
// An activity type's SF object picks the engagement: Event → meeting,
// Task → task. Where Salesforce has one polymorphic WhatId, HubSpot links a
// meeting to several records at once through associations: the Deal, its
// Company, the Contact / Lead in the Who slot, and attendees found as
// Contacts by email. A Marketing Hub campaign in the What slot isn't an
// association: the meeting is added to the campaign as a campaign asset.
//
// Properties: HubSpot's own standard engagement properties (title, times,
// body, owner) are written by name, since every portal has them. Anything a
// portal defines itself (the activity type value, effort hours, a
// description property) is written only when an admin maps it (crm_object
// 'meetings' / 'tasks'), and constants run last, same as Salesforce.
//
// Meetings already in HubSpot (v1.410.0): a rep whose calendar is connected
// to HubSpot has their meetings logged by HubSpot itself. Before creating a
// meeting, write-back looks for that one (meetingMatch.ts: same owner, same
// start and end) and adopts it: activities.crm_record_adopted is set, and
// from then on ImpactIQ fills in only its own fields, adds links without
// removing any, and never deletes the meeting. The CRM features switch
// "Create HubSpot meetings" off means write-back only ever adopts.

export type HubspotEngagementObject = 'meetings' | 'tasks'

const DEFAULT_PROPERTIES: Record<HubspotEngagementObject, { title: string; notes: string; start: string | null; end: string | null }> = {
  meetings: { title: 'hs_meeting_title', notes: 'hs_meeting_body', start: 'hs_meeting_start_time', end: 'hs_meeting_end_time' },
  tasks: { title: 'hs_task_subject', notes: 'hs_task_body', start: null, end: null },
}

export interface BuildHubspotEngagementParams {
  activity: Pick<typeof activities.$inferSelect, 'title' | 'notes' | 'descriptionBody' | 'meetingOwner' | 'startDatetime' | 'endDatetime' | 'effortHours'>
  activityTypeName: string
  // Team's picklist-value override for the type, same meaning as Salesforce.
  picklistValueOverride: string | null
  objectType: HubspotEngagementObject
  // Active mappings for this object (crm_object = objectType), any direction.
  mappings: HubspotMappingRow[]
  ownerId: string | null
  // The meeting was already in HubSpot (logged by HubSpot's calendar sync)
  // and ImpactIQ adopted it. HubSpot's copy of the calendar event stays the
  // record of what happened: title, times, owner and the invite body are
  // never written, and notes go to the meeting's internal notes instead of
  // its body. Everything ImpactIQ adds (type, effort, notes, constants) is.
  adopted?: boolean
}

// What an adopted meeting never gets written: the calendar event's own
// fields, which HubSpot's sync owns.
const ADOPTED_PROTECTED = new Set(['hs_timestamp', 'hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_body', 'hubspot_owner_id'])
const ADOPTED_NOTES_PROPERTY = 'hs_internal_meeting_notes'

// Exported so tests (and the part-2 dry run) build the exact payload the
// worker sends.
export function buildHubspotEngagement(params: BuildHubspotEngagementParams): Record<string, string> {
  const { activity, objectType, ownerId } = params
  const rows = params.mappings.filter((m) => m.crmObject === objectType)
  const defaults = DEFAULT_PROPERTIES[objectType]
  const props: Record<string, string> = {}

  // A mapping row for an app field governs it: write to the mapped property
  // when the row is writable, write nothing when it's read-only. With no row,
  // the standard property (if the field has one) is used.
  const target = (appField: string, fallback: string | null): string | null => {
    const row = rows.find((m) => m.appField === appField)
    if (row) return isWritable(row) ? row.property : null
    return fallback
  }

  const adopted = params.adopted === true && objectType === 'meetings'
  const start = activity.startDatetime.toISOString()
  if (!adopted) {
    // hs_timestamp is required on every engagement: when it happened
    // (meeting) or its due date (task).
    props['hs_timestamp'] = start

    const titleProp = target('title', defaults.title)
    if (titleProp) props[titleProp] = activity.title

    const startProp = target('start_datetime', defaults.start)
    if (startProp) props[startProp] = start
    const endProp = target('end_datetime', defaults.end)
    if (endProp) props[endProp] = activity.endDatetime.toISOString()
  }

  let notesProp = target('notes', adopted ? ADOPTED_NOTES_PROPERTY : defaults.notes)
  if (adopted && notesProp === defaults.notes) notesProp = ADOPTED_NOTES_PROPERTY
  if (notesProp && activity.notes) props[notesProp] = activity.notes

  // The Outlook meeting body, with the organizer as a header line (Salesforce
  // does the same). Mapping-only: meetings have no standard home for it
  // beside the body the notes already use. An adopted meeting already has
  // the invite body from HubSpot's sync.
  const descriptionProp = adopted ? null : target('description', null)
  if (descriptionProp) {
    const ownerLine = activity.meetingOwner?.trim() ? `Meeting Owner = ${activity.meetingOwner.trim()}` : ''
    const combined = [ownerLine, activity.descriptionBody ?? ''].filter(Boolean).join('\n\n')
    if (combined) props[descriptionProp] = combined
  }

  // The activity type value is portal-defined (hs_activity_type options are
  // each account's own), so it's only sent when mapped.
  const typeProp = target('activity_type', null)
  if (typeProp) {
    const value = params.picklistValueOverride?.trim() ? params.picklistValueOverride : params.activityTypeName
    props[typeProp] = value
  }

  // HubSpot engagements have no effort field; a portal adds a number
  // property for it. Written in hours, the unit ImpactIQ logs.
  const effortProp = target('effort_hours', null)
  if (effortProp && activity.effortHours != null) props[effortProp] = String(Number(activity.effortHours))

  const ownerProp = adopted ? null : target('user_id', 'hubspot_owner_id')
  if (ownerProp && ownerId) props[ownerProp] = ownerId

  // A logged task is work already done.
  if (objectType === 'tasks' && !rows.some((m) => m.property === 'hs_task_status')) props['hs_task_status'] = 'COMPLETED'

  for (const m of rows) {
    if (adopted && ADOPTED_PROTECTED.has(m.property)) continue
    if (isWritable(m) && m.constantValue != null && m.constantValue !== '') props[m.property] = m.constantValue
  }
  return props
}

export interface AssociationTargets {
  deals: string[]
  companies: string[]
  contacts: string[]
  leads: string[]
  // A Marketing Hub campaign (UUID). Not an association: the meeting is
  // added to it as a campaign asset after the save.
  campaign: string | null
}

// Records the engagement links to, from the activity's What / Who slots.
// Only HubSpot-shaped ids: a stale Salesforce id left on an old activity is
// never sent to HubSpot.
export function associationTargets(activity: Pick<typeof activities.$inferSelect, 'crmWhatId' | 'crmWhatType' | 'crmAccountId' | 'crmWhoId' | 'crmWhoType'>): AssociationTargets {
  const out: AssociationTargets = { deals: [], companies: [], contacts: [], leads: [], campaign: null }
  const ok = (v: string | null | undefined): v is string => !!v && HUBSPOT_ID_RX.test(v)
  if (activity.crmWhatType === 'Opportunity' && ok(activity.crmWhatId)) {
    out.deals.push(activity.crmWhatId)
    if (ok(activity.crmAccountId)) out.companies.push(activity.crmAccountId)
  } else if (activity.crmWhatType === 'Account' && ok(activity.crmWhatId)) {
    out.companies.push(activity.crmWhatId)
  } else if (activity.crmWhatType === 'Campaign' && activity.crmWhatId && HUBSPOT_CAMPAIGN_ID_RX.test(activity.crmWhatId)) {
    out.campaign = activity.crmWhatId.toLowerCase()
  }
  if (activity.crmWhoType === 'Lead' && ok(activity.crmWhoId)) out.leads.push(activity.crmWhoId)
  else if (ok(activity.crmWhoId)) out.contacts.push(activity.crmWhoId)
  return out
}

// Something the engagement can be linked to. A campaign only counts for a
// meeting: HubSpot campaigns take meetings as assets, but have no asset
// type for tasks.
function hasTarget(t: AssociationTargets, objectType: HubspotEngagementObject): boolean {
  return t.deals.length + t.companies.length + t.contacts.length + t.leads.length > 0
    || (objectType === 'meetings' && t.campaign != null)
}

// Adds the meeting to a Marketing Hub campaign as a MEETING_EVENT asset.
// Adding one that's already there counts as done, so a re-sync is harmless.
async function addMeetingToCampaign(campaignId: string, meetingId: string): Promise<string | null> {
  const { status, body } = await hubspotRequest(`/marketing/v3/campaigns/${campaignId}/assets/MEETING_EVENT/${meetingId}`, { method: 'PUT' })
  return (status >= 200 && status < 300) || status === 409 ? null : `campaign ${campaignId}: ${hubspotMessage(status, body)}`
}

// HubSpot's own error text, kept for Admin → CRM Sync (an admin needs to see
// which property HubSpot rejected).
function hubspotMessage(status: number, body: unknown): string {
  const msg = body && typeof body === 'object' ? (body as Record<string, unknown>)['message'] : null
  return `HubSpot ${status}${typeof msg === 'string' && msg ? `: ${msg}` : ''}`
}

const EMAIL_RX = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/

// Attendees who are HubSpot Contacts, found by email in one search call.
async function attendeeContactIds(attendees: unknown): Promise<string[]> {
  if (!Array.isArray(attendees)) return []
  const emails = [...new Set(attendees
    .map((a) => (a && typeof a === 'object' ? (a as { email?: unknown }).email : null))
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length <= 254 && EMAIL_RX.test(e)))].slice(0, 100)
  if (emails.length === 0) return []
  const found = await hubspotSearch('contacts', {
    limit: 100,
    properties: ['email'],
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: emails }] }],
  })
  return found.map((c) => String(c.id))
}

async function associate(objectType: HubspotEngagementObject, id: string, toType: string, toId: string): Promise<string | null> {
  const { status, body } = await hubspotRequest(`/crm/v4/objects/${objectType}/${id}/associations/default/${toType}/${toId}`, { method: 'PUT' })
  return status >= 200 && status < 300 ? null : `${toType} ${toId}: ${hubspotMessage(status, body)}`
}

// Deals mirror Salesforce's single WhatId: after a relink the old deal is
// unlinked. Companies and contacts are only ever added, since HubSpot (and
// people) add their own, e.g. a contact's company.
async function unlinkOtherDeals(objectType: HubspotEngagementObject, id: string, keep: string[]): Promise<string[]> {
  const { status, body } = await hubspotRequest(`/crm/v4/objects/${objectType}/${id}/associations/deals`, { query: { limit: 100 } })
  if (status < 200 || status >= 300) return [`deals: ${hubspotMessage(status, body)}`]
  const current = ((body as { results?: Array<{ toObjectId?: unknown }> } | null)?.results ?? [])
    .map((r) => (r.toObjectId != null ? String(r.toObjectId) : null))
    .filter((v): v is string => !!v)
  const errors: string[] = []
  for (const dealId of current.filter((d) => !keep.includes(d))) {
    const del = await hubspotRequest(`/crm/v4/objects/${objectType}/${id}/associations/deals/${dealId}`, { method: 'DELETE' })
    if (del.status < 200 || del.status >= 300) errors.push(`deal ${dealId}: ${hubspotMessage(del.status, del.body)}`)
  }
  return errors
}

async function logAudit(row: { activityId: string; userId: string | null; status: 'success' | 'failed'; operation: 'create' | 'update' | 'skipped'; crmObject: string | null; crmRecordId: string | null; errorMessage: string | null; payload: unknown }): Promise<void> {
  try {
    await db.insert(activitySyncAudit).values({
      source: 'activity_writeback',
      activityId: row.activityId,
      userId: row.userId,
      status: row.status,
      operation: row.operation,
      crmObject: row.crmObject,
      crmRecordId: row.crmRecordId,
      errorMessage: row.errorMessage,
      payload: (row.payload ?? null) as Record<string, unknown> | null,
    })
    // Same 30-day per-activity retention as the Salesforce worker.
    await db.delete(activitySyncAudit).where(and(eq(activitySyncAudit.activityId, row.activityId), lt(activitySyncAudit.attemptedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))))
  } catch (err) {
    console.error('[hubspot-writeback] audit log failed:', err instanceof Error ? err.message : String(err))
  }
}

export type HubspotSyncResult =
  | { ok: true; recordId: string; partialError: string | null; adopted: boolean }
  | { ok: false; error: string; retry: boolean; clearRecordId?: boolean }

export async function syncHubspotActivity(activityId: string): Promise<HubspotSyncResult> {
  const [activity] = await db.select().from(activities).where(eq(activities.id, activityId)).limit(1)
  if (!activity) return { ok: false, error: 'Activity not found', retry: false }
  const targets = associationTargets(activity)
  const [type] = await db.select({ name: teamActivityTypes.name, crmObjectType: teamActivityTypes.crmObjectType, crmPicklistValue: teamActivityTypes.crmPicklistValue })
    .from(teamActivityTypes).where(eq(teamActivityTypes.id, activity.activityTypeId)).limit(1)
  if (!type) return { ok: false, error: 'Activity type not found', retry: false }
  const objectType: HubspotEngagementObject = type.crmObjectType === 'Task' ? 'tasks' : 'meetings'
  if (!hasTarget(targets, objectType)) {
    const error = objectType === 'tasks' && targets.campaign
      ? 'HubSpot campaigns take meetings, not tasks: link a Deal, Company or Contact, or log this type as a meeting'
      : 'No HubSpot record to link (no Deal, Company, Contact, Lead or Campaign)'
    await logAudit({ activityId, userId: activity.userId, status: 'failed', operation: 'skipped', crmObject: null, crmRecordId: null, errorMessage: error, payload: null })
    return { ok: false, error, retry: false }
  }

  const [mappings, ownerId, features] = await Promise.all([
    loadHubspotMappings(activity.teamId, [objectType]),
    getHubspotOwnerIdForUser(activity.userId),
    getCrmFeatures(),
  ])
  const hasRecord = !!activity.crmRecordId && HUBSPOT_ID_RX.test(activity.crmRecordId)

  // A meeting not yet in HubSpot: first look for the same meeting already
  // logged by HubSpot's calendar sync (same owner, same times) and adopt it
  // rather than log it twice. A failed search is retried, never treated as
  // "none found", since creating then could make the duplicate this exists
  // to avoid.
  let existingId = hasRecord ? activity.crmRecordId : null
  let adopted = hasRecord && activity.crmRecordAdopted
  if (!hasRecord && objectType === 'meetings') {
    let found: string | null = null
    if (ownerId) {
      try {
        found = await findExistingHubspotMeeting(activityId, { ownerId, title: activity.title, start: activity.startDatetime, end: activity.endDatetime })
      } catch (err) {
        const error = `Looking for this meeting in HubSpot failed: ${err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)}`
        await logAudit({ activityId, userId: activity.userId, status: 'failed', operation: 'skipped', crmObject: objectType, crmRecordId: null, errorMessage: error, payload: null })
        return { ok: false, error, retry: true }
      }
    }
    if (found) {
      existingId = found
      adopted = true
    } else if (!features.hubspotCreateMeetings) {
      // The admin turned meeting creation off: wait for HubSpot's calendar
      // sync to log it, checking again on the retry schedule.
      const error = ownerId
        ? 'No matching meeting in HubSpot yet (same owner, start and end time), and creating HubSpot meetings is turned off in CRM features. ImpactIQ checks again on the retry schedule.'
        : 'This user is not matched to a HubSpot owner, so an existing meeting can\'t be found, and creating HubSpot meetings is turned off in CRM features.'
      await logAudit({ activityId, userId: activity.userId, status: 'failed', operation: 'skipped', crmObject: objectType, crmRecordId: null, errorMessage: error, payload: null })
      return { ok: false, error, retry: true }
    }
  }

  const properties = buildHubspotEngagement({
    activity, activityTypeName: type.name, picklistValueOverride: type.crmPicklistValue, objectType, mappings, ownerId, adopted,
  })
  const operation: 'create' | 'update' = existingId ? 'update' : 'create'
  const audit = (status: 'success' | 'failed', recordId: string | null, errorMessage: string | null, payload: unknown = { properties, ...(adopted ? { adopted: true } : {}) }) =>
    logAudit({ activityId, userId: activity.userId, status, operation, crmObject: objectType, crmRecordId: recordId, errorMessage, payload })

  try {
    let recordId: string
    if (existingId) {
      const { status, body } = await hubspotRequest(`/crm/v3/objects/${objectType}/${existingId}`, { method: 'PATCH', body: { properties } })
      if (status === 404) {
        // Deleted in HubSpot. Not retried automatically (someone may have
        // removed a duplicate on purpose); a manual Retry creates it again.
        const error = 'HubSpot 404: the engagement was deleted in HubSpot. Retry to create it again.'
        await audit('failed', existingId, error)
        return { ok: false, error, retry: false, clearRecordId: true }
      }
      if (status < 200 || status >= 300) {
        const error = hubspotMessage(status, body)
        await audit('failed', existingId, error)
        return { ok: false, error, retry: status >= 500 || status === 403 }
      }
      recordId = existingId
    } else {
      const { status, body } = await hubspotRequest(`/crm/v3/objects/${objectType}`, { method: 'POST', body: { properties } })
      const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : null
      if (status < 200 || status >= 300 || id == null) {
        const error = hubspotMessage(status, body)
        await audit('failed', null, error)
        return { ok: false, error, retry: status >= 500 || status === 403 || status === 0 }
      }
      recordId = String(id)
    }

    // Associations. A failure here keeps the engagement (it exists) and
    // parks the row as failed for attention, like Salesforce's attendee
    // (EventRelation) failures: retrying could not make it more correct.
    const errors: string[] = []
    let attendees: string[] = []
    try { attendees = await attendeeContactIds(activity.attendees) } catch (err) {
      errors.push(`attendee lookup: ${err instanceof Error ? err.message : String(err)}`)
    }
    const contacts = [...new Set([...targets.contacts, ...attendees])]
    // An adopted meeting's links are add-only: Deals HubSpot's sync or the
    // rep attached stay, since ImpactIQ didn't make them.
    if (operation === 'update' && !adopted) errors.push(...await unlinkOtherDeals(objectType, recordId, targets.deals))
    for (const [toType, ids] of [['deals', targets.deals], ['companies', targets.companies], ['contacts', contacts], ['leads', targets.leads]] as const) {
      for (const toId of ids) {
        const err = await associate(objectType, recordId, toType, toId)
        if (err) errors.push(err)
      }
    }
    // A task can't be a campaign asset; its other links still saved, so the
    // campaign is noted in the payload rather than failing the sync.
    if (targets.campaign && objectType === 'meetings') {
      const err = await addMeetingToCampaign(targets.campaign, recordId)
      if (err) errors.push(err)
    }
    // ACV onto the linked Deal through the team's writable `acv` mapping
    // (phase 6). Like Salesforce, a failure here is logged but doesn't fail
    // the activity's own sync: the meeting is written and linked.
    let acvError: string | null = null
    if (activity.acv != null && targets.deals.length > 0) {
      acvError = await writeHubspotDealAcv(activity.teamId, targets.deals[0]!, Number(activity.acv))
      if (acvError) console.warn('[hubspot-writeback] ACV update failed for %s: %s', activityId, acvError)
    }
    const partialError = errors.length > 0 ? `Associations: ${errors.join('; ')}` : null
    await audit(partialError ? 'failed' : 'success', recordId, partialError, {
      properties,
      ...(adopted ? { adopted: true } : {}),
      ...(acvError ? { acvError } : {}),
      associations: { ...targets, contacts },
      ...(targets.campaign && objectType === 'tasks' ? { campaignSkipped: 'HubSpot campaigns take meetings, not tasks' } : {}),
    })
    return { ok: true, recordId, partialError, adopted }
  } catch (err) {
    const error = err instanceof HubspotError ? err.code : (err instanceof Error ? err.message : String(err))
    await audit('failed', existingId, error)
    // Network trouble and rate limits clear up on their own; a rejected
    // token waits for an admin, but retrying on the backoff costs nothing.
    return { ok: false, error, retry: true }
  }
}

const inFlight = new Set<string>()

export async function processHubspotActivitySync(activityId: string): Promise<void> {
  if (inFlight.has(activityId)) return
  inFlight.add(activityId)
  try {
    if (await parkDemoActivitySync(activityId)) return
    const [cur] = await db.select({ attempts: activities.crmSyncAttempts }).from(activities).where(eq(activities.id, activityId)).limit(1)
    const priorAttempts = cur?.attempts ?? 0
    const result = await syncHubspotActivity(activityId)
    if (result.ok) {
      await db.update(activities).set({
        crmRecordId: result.recordId,
        crmRecordAdopted: result.adopted,
        crmSyncStatus: result.partialError ? 'failed' : 'synced',
        crmSyncError: result.partialError,
        crmSyncedAt: new Date(),
        crmSyncAttempts: result.partialError ? priorAttempts : 0,
        crmNextRetryAt: null,
        updatedAt: new Date(),
      }).where(eq(activities.id, activityId))
      return
    }
    const attempts = priorAttempts + 1
    const willRetry = result.retry && attempts < MAX_SYNC_RETRIES
    await db.update(activities).set({
      crmSyncStatus: 'failed',
      crmSyncError: result.error,
      crmSyncAttempts: attempts,
      crmNextRetryAt: willRetry ? new Date(Date.now() + retryBackoffMs(attempts)) : null,
      ...(result.clearRecordId ? { crmRecordId: null, crmRecordAdopted: false } : {}),
      updatedAt: new Date(),
    }).where(eq(activities.id, activityId))
    if (!willRetry) await emitActivityEvent('activity.crm_sync_failed', activityId)
  } finally {
    inFlight.delete(activityId)
  }
}

// Deletes an activity's HubSpot meeting or task when the activity itself
// is deleted (phase 4), the HubSpot side of the Salesforce destroy() in
// routes/activities.ts. Resolves to null on success (a record HubSpot no
// longer has counts: the goal state already holds) or the failure reason;
// never throws, since a CRM failure must not block the local delete.
export async function deleteHubspotEngagement(recordId: string, crmObjectType: string | null): Promise<string | null> {
  if (!HUBSPOT_ID_RX.test(recordId)) return `Not a HubSpot record: ${recordId}`
  const objectType: HubspotEngagementObject = crmObjectType === 'Task' ? 'tasks' : 'meetings'
  try {
    const res = await hubspotRequest(`/crm/v3/objects/${objectType}/${recordId}`, { method: 'DELETE' })
    if ((res.status >= 200 && res.status < 300) || res.status === 404) return null
    const msg = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>)['message'] : null
    return `HubSpot ${res.status}${typeof msg === 'string' && msg ? `: ${msg}` : ''}`
  } catch (err) {
    return err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)
  }
}

export function kickHubspotSync(activityId: string): void {
  void processHubspotActivitySync(activityId).catch((err) => {
    console.error('[hubspot-writeback] inline kick failed for %s:', activityId, err)
  })
}

const JOB_KEY = 'hubspot_writeback_worker'
let stopFn: (() => void) | null = null

// 30s queue poller, a quiet no-op (no job_runs row) unless HubSpot is the
// install's CRM and something was processed.
export function startHubspotWriteBackWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, 30 * 1000, async () => {
    if (!(await isCrmProviderActive('hubspot'))) return
    const startedAt = new Date()
    try {
      const { processed } = await processPendingActivities(processHubspotActivitySync)
      if (processed > 0) await writeRun(JOB_KEY, startedAt, 'ok', `Processed ${processed} pending activit${processed === 1 ? 'y' : 'ies'}`, { processed })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[hubspot-writeback] worker tick failed:', err)
      await writeRun(JOB_KEY, startedAt, 'error', message, null)
    }
  })
}

export function stopHubspotWriteBackWorker(): void {
  stopFn?.()
  stopFn = null
}
