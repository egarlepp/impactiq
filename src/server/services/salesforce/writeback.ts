import { db } from '../../db/index.js'
import {
  activities,
  activitySyncAudit,
  teamActivityTypes,
  crmFieldMappings,
  crmFieldMappingTeams,
  sfEventTypeConfig,
  users,
} from '../../../../drizzle/schema.js'
import { and, eq, lt, lte, or, isNotNull } from 'drizzle-orm'
import { getSfConnection } from './client.js'
import { safeSoqlLiteral } from './soql.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { emitActivityEvent } from '../webhooks/events.js'
import { parkDemoActivitySync } from '../demo/ids.js'

const BATCH_SIZE = 25
// Automatic retry of failed write-backs. Failed rows are re-attempted with
// exponential backoff up to MAX_SYNC_RETRIES, after which they park as
// `failed` (nextRetryAt cleared) for manual retry from Admin → Sync Issues.
// Shared with the HubSpot write-back worker (services/hubspot/writeback.ts),
// so both CRMs retry on the same schedule.
export const MAX_SYNC_RETRIES = 6
export function retryBackoffMs(attempts: number): number {
  // 2, 4, 8, 16, 32, 60 … minutes (capped at 60).
  return Math.min(2 ** attempts, 60) * 60_000
}
const POLL_INTERVAL_MS = 30 * 1000

// Resolve an app field to its SF API name from the team's mappings.
function resolveSfField(
  mappings: Array<{ appField: string; crmFieldApi: string; isActive: boolean }>,
  appField: string,
): string | null {
  const m = mappings.find((x) => x.appField === appField && x.isActive)
  return m?.crmFieldApi ?? null
}

// v1.219.0: exported so the Admin → SF Field Mappings dry run builds its
// preview payload with the EXACT function the writeback worker uses. A
// re-implementation would drift and start reassuring admins about a payload
// the real sync never sends.
export interface BuildSfRecordParams {
  activity: typeof activities.$inferSelect
  activityTypeName: string
  // When the activity type carries an SF picklist-value override, that string
  // wins over the activity type name for both the sf_event_type_config lookup
  // and the value we write to SF. Enables many-to-one mapping (Build out /
  // Test / Architect all resolving to Eval Work).
  sfPicklistValueOverride: string | null
  crmObjectType: 'Event' | 'Task'
  fieldMappings: Array<{ appField: string; crmFieldApi: string; isActive: boolean; direction: string; constantValue: string | null; refreshOnlyForReports?: boolean | null }>
  picklistConfig: Array<{ crmPicklistValue: string; isActive: boolean; fallbackValue: string | null }>
  ownerCrmUserId: string | null
}

export function buildSfRecord(params: BuildSfRecordParams): Record<string, unknown> {
  const { activity, activityTypeName, sfPicklistValueOverride, crmObjectType, fieldMappings: allMappings, picklistConfig, ownerCrmUserId } = params
  // Read-only mappings never write to SF — they're pulled into ImpactIQ for
  // display but the app has no authority to overwrite them (matches the SF
  // Admin's expectation for fields like ACV, Opportunity Owner, etc.).
  // v1.140.0: refresh-only mappings are never pushed to SF — they exist
  // so the nightly refresher can pull the field into activity snapshot
  // columns, no writeback.
  const fieldMappings = allMappings
    .filter((m) => m.direction === 'write' || m.direction === 'read_write')
    .filter((m) => !m.refreshOnlyForReports)

  // Resolve the picklist value with fallback semantics.
  const resolvedPicklistValue = sfPicklistValueOverride && sfPicklistValueOverride.trim().length > 0
    ? sfPicklistValueOverride
    : activityTypeName
  let typeValue: string | null = resolvedPicklistValue
  if (picklistConfig.length === 0) {
    // No sf_event_type_config seeded for this team — trust the activity
    // type name and let SF reject it if the value isn't in the org's
    // picklist. Previous behavior silently dropped the Type field which
    // is worse: the SF Event was created with Type blank.
  } else {
    const picklist = picklistConfig.find((p) => p.crmPicklistValue === resolvedPicklistValue)
    if (picklist) {
      if (!picklist.isActive) typeValue = picklist.fallbackValue
    } else {
      // Row missing for THIS value even though the team has config for
      // others — treat as not-in-picklist and skip.
      typeValue = null
    }
  }

  const record: Record<string, unknown> = {}

  const titleField = resolveSfField(fieldMappings, 'title')
  if (titleField) record[titleField] = activity.title

  const typeField = resolveSfField(fieldMappings, 'activity_type')
  if (typeField && typeValue !== null) record[typeField] = typeValue

  const whatIdField = resolveSfField(fieldMappings, 'crm_what_id')
  if (whatIdField && activity.crmWhatId) record[whatIdField] = activity.crmWhatId

  // WhoId (Contact / Lead / User). ALWAYS written on Event/Task —
  // including a null clear — so re-syncs remove any WhoId set by a
  // previous version of this code. Otherwise a leftover WhoId keeps SF's
  // auto-created IsInvitee=false EventRelation alive, which blocks our
  // explicit IsInvitee=true write with DUPLICATE_VALUE.
  if (crmObjectType === 'Event' || crmObjectType === 'Task') {
    record['WhoId'] = activity.crmWhoId ?? null
  }

  const notesField = resolveSfField(fieldMappings, 'notes')
  if (notesField && activity.notes) record[notesField] = activity.notes

  // Description body: the Outlook meeting body (or free-text entered on
  // the form) syncs to whatever field the team maps to app_field
  // 'description'. Meeting owner has no native SF field, so if the
  // description field is mapped we prepend `Meeting Owner = <name>` as
  // a one-line header — reviewers see who organized the meeting without
  // a schema change.
  const descriptionField = resolveSfField(fieldMappings, 'description')
  if (descriptionField) {
    const body = activity.descriptionBody ?? ''
    const ownerLine = activity.meetingOwner && activity.meetingOwner.trim()
      ? `Meeting Owner = ${activity.meetingOwner.trim()}`
      : ''
    const combined = [ownerLine, body].filter(Boolean).join('\n\n')
    if (combined) record[descriptionField] = combined
  }

  if (crmObjectType === 'Event') {
    const startField = resolveSfField(fieldMappings, 'start_datetime')
    if (startField) record[startField] = activity.startDatetime.toISOString()

    const effortField = resolveSfField(fieldMappings, 'effort_hours')
    if (effortField) {
      const minutes = Math.round(Number(activity.effortHours) * 60)
      record[effortField] = minutes
    }
  } else {
    // Task: maps start_datetime → ActivityDate (date-only); effort_hours has no native Task home.
    const startField = resolveSfField(fieldMappings, 'start_datetime')
    if (startField) record[startField] = activity.startDatetime.toISOString().slice(0, 10)
  }

  const ownerField = resolveSfField(fieldMappings, 'user_id')
  if (ownerField && ownerCrmUserId) record[ownerField] = ownerCrmUserId

  // Constants override — mappings that carry a constantValue write that
  // literal onto crmFieldApi. Common uses: Activity_Status__c='Completed',
  // ShowAs='Busy'. Runs last so it can override anything else in the record.
  for (const m of fieldMappings) {
    if (m.isActive && m.constantValue !== null && m.constantValue !== '') {
      record[m.crmFieldApi] = m.constantValue
    }
  }

  return record
}

// v1.144.0: bumped 5 → 30. At 5 days, admins investigating a sync issue
// often found the row already culled — especially when a user syncs
// once a week or less. 30 days matches the nudge_history retention.
const AUDIT_RETENTION_DAYS = 30

async function logAudit(row: {
  activityId: string
  status: 'success' | 'failed'
  operation: 'create' | 'update' | 'skipped'
  crmObject: string | null
  crmRecordId: string | null
  errorMessage: string | null
  payload: unknown
}): Promise<void> {
  try {
    await db.insert(activitySyncAudit).values({
      activityId: row.activityId,
      status: row.status,
      operation: row.operation,
      crmObject: row.crmObject,
      crmRecordId: row.crmRecordId,
      errorMessage: row.errorMessage,
      payload: row.payload as Record<string, unknown> | null,
    })
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    await db
      .delete(activitySyncAudit)
      .where(and(eq(activitySyncAudit.activityId, row.activityId), lt(activitySyncAudit.attemptedAt, cutoff)))
  } catch (err) {
    console.error('[sf-writeback] audit log failed:', err instanceof Error ? err.message : String(err))
  }
}

interface RelationSyncResult {
  attemptedEmails: string[]
  matchedByType: { contacts: number; leads: number; users: number }
  toCreate: string[]
  existingSkipped: string[]
  createResults: Array<{ id: string | null; success: boolean; errors?: unknown }>
  errors: string[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncEventRelations(conn: any, eventId: string, attendees: { name?: string; email?: string }[], ownerCrmUserId: string | null): Promise<RelationSyncResult> {
  const result: RelationSyncResult = {
    attemptedEmails: [],
    matchedByType: { contacts: 0, leads: 0, users: 0 },
    toCreate: [],
    existingSkipped: [],
    createResults: [],
    errors: [],
  }
  const emails = Array.from(new Set(
    attendees.map((a) => (a.email ?? '').trim().toLowerCase()).filter((e) => e && /@/.test(e)),
  ))
  result.attemptedEmails = emails
  if (emails.length === 0) return result

  const escaped = emails.map((e) => `'${safeSoqlLiteral(e)}'`).join(',')

  const emailToRelId = new Map<string, string>()
  try {
    const contacts = await conn.query(
      `SELECT Id, Email FROM Contact WHERE Email IN (${escaped}) LIMIT 200`,
    )
    for (const c of contacts.records as Array<{ Id: string; Email: string | null }>) {
      if (c.Email) { emailToRelId.set(c.Email.toLowerCase(), c.Id); result.matchedByType.contacts++ }
    }
    const leads = await conn.query(
      `SELECT Id, Email FROM Lead WHERE Email IN (${escaped}) AND IsConverted = false LIMIT 200`,
    )
    for (const l of leads.records as Array<{ Id: string; Email: string | null }>) {
      if (l.Email && !emailToRelId.has(l.Email.toLowerCase())) {
        emailToRelId.set(l.Email.toLowerCase(), l.Id); result.matchedByType.leads++
      }
    }
    const users = await conn.query(
      `SELECT Id, Email FROM User WHERE IsActive = true AND Email IN (${escaped}) LIMIT 200`,
    )
    for (const u of users.records as Array<{ Id: string; Email: string | null }>) {
      if (u.Email && !emailToRelId.has(u.Email.toLowerCase())) {
        emailToRelId.set(u.Email.toLowerCase(), u.Id); result.matchedByType.users++
      }
    }
  } catch (err) {
    result.errors.push(`attendee lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    return result
  }

  if (emailToRelId.size === 0) return result

  // Skip attendees who already have ANY EventRelation row for this
  // Event. Some SF orgs enforce (EventId, RelationId) uniqueness across
  // IsInvitee values — so we can't add a second IsInvitee=true row for
  // a person who already has an IsInvitee=false row (auto-created when
  // WhoId was set). Now that WhoId is always cleared on re-sync unless
  // explicitly picked, stale WhoId-derived rows disappear from SF on
  // the next sync attempt and won't block subsequent creates.
  let existingRelIds = new Set<string>()
  try {
    const existing = await conn.query(
      `SELECT RelationId FROM EventRelation WHERE EventId = '${safeSoqlLiteral(eventId)}' LIMIT 500`,
    )
    for (const r of existing.records as Array<{ RelationId: string }>) {
      existingRelIds.add(r.RelationId)
    }
  } catch (err) {
    result.errors.push(`existing EventRelation query failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Salesforce rejects EventRelation with RelationId == OwnerId
  // ("You cannot add the owner of the event as an invitee"). The owner
  // is already the primary Name on the Event by virtue of OwnerId, so
  // skip them silently — they'd be a duplicate anyway.
  const toCreate = Array.from(emailToRelId.values())
    .filter((id) => {
      if (existingRelIds.has(id)) { result.existingSkipped.push(id); return false }
      if (ownerCrmUserId && id === ownerCrmUserId) { result.existingSkipped.push(id); return false }
      return true
    })
    .map((id) => ({ EventId: eventId, RelationId: id, IsInvitee: true }))
  result.toCreate = toCreate.map((r) => r.RelationId)
  if (toCreate.length === 0) return result

  try {
    const createRes = await conn.sobject('EventRelation').create(toCreate)
    const rows = Array.isArray(createRes) ? createRes : [createRes]
    result.createResults = rows.map((r: { id?: string; success: boolean; errors?: unknown }) => ({ id: r.id ?? null, success: r.success, errors: r.errors }))
    const failed = rows.filter((r: { success: boolean }) => !r.success)
    if (failed.length > 0) {
      result.errors.push(`${failed.length}/${rows.length} EventRelation rows failed`)
    }
  } catch (err) {
    result.errors.push(`EventRelation.create threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  return result
}

async function syncActivity(activityId: string): Promise<{ ok: true; crmRecordId: string; attendeeSyncError: string | null } | { ok: false; error: string }> {
  const [activity] = await db.select().from(activities).where(eq(activities.id, activityId)).limit(1)
  if (!activity) return { ok: false, error: 'Activity not found' }
  if (!activity.crmWhatId && !activity.crmWhoId) {
    await logAudit({ activityId, status: 'failed', operation: 'skipped', crmObject: null, crmRecordId: null, errorMessage: 'No SF record to link (activity has no WhatId and no WhoId)', payload: null })
    return { ok: false, error: 'No SF record to link' }
  }

  const conn = await getSfConnection(activity.userId)
  if (!conn) {
    await logAudit({ activityId, status: 'failed', operation: 'skipped', crmObject: null, crmRecordId: null, errorMessage: 'Salesforce not connected for the activity owner', payload: null })
    return { ok: false, error: 'Salesforce not connected' }
  }

  const [activityType] = await db
    .select({ name: teamActivityTypes.name, crmObjectType: teamActivityTypes.crmObjectType, crmPicklistValue: teamActivityTypes.crmPicklistValue })
    .from(teamActivityTypes)
    .where(eq(teamActivityTypes.id, activity.activityTypeId))
    .limit(1)
  if (!activityType) return { ok: false, error: 'Activity type not found' }

  const fieldMappings = await db
    .select({
      appField: crmFieldMappings.appField,
      crmFieldApi: crmFieldMappings.crmFieldApi,
      direction: crmFieldMappings.direction,
      isActive: crmFieldMappings.isActive,
      constantValue: crmFieldMappings.constantValue,
      // v1.219.0: this column was never selected, so the "refresh-only
      // mappings are never pushed to SF" filter in buildSfRecord() read
      // undefined and excluded nothing. Harmless for the seeded refresh-only
      // rows (they're all crmObject='Opportunity', which this query doesn't
      // match) but an admin who ticked the flag on an Event/Task mapping got
      // it written anyway, contrary to the documented behaviour.
      refreshOnlyForReports: crmFieldMappings.refreshOnlyForReports,
    })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(
      and(eq(crmFieldMappingTeams.teamId, activity.teamId), eq(crmFieldMappings.crmObject, activityType.crmObjectType)),
    )

  const picklistConfig = await db
    .select({
      crmPicklistValue: sfEventTypeConfig.sfPicklistValue,
      isActive: sfEventTypeConfig.isActive,
      fallbackValue: sfEventTypeConfig.fallbackValue,
    })
    .from(sfEventTypeConfig)
    .where(eq(sfEventTypeConfig.teamId, activity.teamId))

  const [user] = await db
    .select({ crmUserId: users.crmUserId })
    .from(users)
    .where(eq(users.id, activity.userId))
    .limit(1)

  const record = buildSfRecord({
    activity,
    activityTypeName: activityType.name,
    sfPicklistValueOverride: activityType.crmPicklistValue,
    crmObjectType: activityType.crmObjectType,
    fieldMappings,
    picklistConfig,
    ownerCrmUserId: user?.crmUserId ?? null,
  })

  // WhoId (Name field) is intentionally NOT auto-populated from
  // attendees. Salesforce's (EventId, RelationId) uniqueness in some
  // orgs means a person set as WhoId can't ALSO appear as an
  // IsInvitee=true EventRelation, and vice versa. Since Meeting Digest's
  // "Outside Your Organization" list reads only IsInvitee=true rows,
  // routing every matched attendee through EventRelation (below in
  // syncEventRelations) gives the widest coverage — every external
  // attendee appears in the invitee list. If the user wants a specific
  // person as the Event's primary Name, they pick them explicitly via
  // the SF Who picker on the activity form; that value flows through
  // activity.crmWhoId and lands on the record.

  try {
    // Idempotency: if this activity has already been written to
    // Salesforce (crmRecordId is set), update the existing Event/Task
    // rather than creating a new one — otherwise every re-sync creates
    // a duplicate SF record.
    let crmRecordId: string
    const operation: 'create' | 'update' = activity.crmRecordId ? 'update' : 'create'
    if (activity.crmRecordId) {
      const updRes = await conn.sobject(activityType.crmObjectType).update({ Id: activity.crmRecordId, ...record })
      const updated = Array.isArray(updRes) ? updRes[0] : updRes
      if (!updated || !updated.success) {
        const errors = updated && 'errors' in updated ? updated.errors : undefined
        const message = errors && errors.length > 0 ? errors.join('; ') : 'Unknown SF error'
        await logAudit({ activityId, status: 'failed', operation, crmObject: activityType.crmObjectType, crmRecordId: activity.crmRecordId, errorMessage: message, payload: record })
        return { ok: false, error: message }
      }
      crmRecordId = activity.crmRecordId
    } else {
      const result = await conn.sobject(activityType.crmObjectType).create(record)
      const created = Array.isArray(result) ? result[0] : result
      if (!created || !created.success) {
        const errors = created && 'errors' in created ? created.errors : undefined
        const message = errors && errors.length > 0 ? errors.join('; ') : 'Unknown SF error'
        await logAudit({ activityId, status: 'failed', operation, crmObject: activityType.crmObjectType, crmRecordId: null, errorMessage: message, payload: record })
        return { ok: false, error: message }
      }
      crmRecordId = created.id!
    }
    // Multi-attendee sync via EventRelation: each attendee with an email
    // is resolved to a SF Contact (preferred) or Lead Id, and an
    // EventRelation row is created linking that record to the Event.
    // Unmatched emails (people not in SF) are ignored — they stay in the
    // activity's attendees JSON but don't produce a Name on the Event.
    // Failures are logged but don't fail the primary sync.
    let attendeeSyncError: string | null = null
    if (activityType.crmObjectType === 'Event' && Array.isArray(activity.attendees) && (activity.attendees as unknown[]).length > 0) {
      try {
        const rel = await syncEventRelations(conn, crmRecordId, activity.attendees as { name?: string; email?: string }[], user?.crmUserId ?? null)
        const status: 'success' | 'failed' = rel.errors.length === 0 ? 'success' : 'failed'
        const summary = rel.errors.length > 0
          ? rel.errors.join('; ')
          : `Matched ${rel.matchedByType.contacts} Contact / ${rel.matchedByType.leads} Lead / ${rel.matchedByType.users} User out of ${rel.attemptedEmails.length} attendee email(s). Created ${rel.toCreate.length} EventRelation row(s); skipped ${rel.existingSkipped.length} already linked.`
        if (rel.errors.length > 0) attendeeSyncError = `Attendee sync: ${summary}`
        await logAudit({
          activityId,
          status,
          operation: 'update',
          crmObject: 'EventRelation',
          crmRecordId,
          errorMessage: rel.errors.length > 0 ? summary : null,
          payload: rel as unknown as Record<string, unknown>,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        attendeeSyncError = `Attendee sync threw: ${msg}`
        await logAudit({
          activityId,
          status: 'failed',
          operation: 'update',
          crmObject: 'EventRelation',
          crmRecordId,
          errorMessage: msg,
          payload: null,
        })
      }
    }

    // If ACV is set and the activity links to an Opportunity, push it into
    // the Opportunity itself using the team's mapping. Failures on this
    // secondary write don't fail the sync — they only get logged so the
    // Event/Task still records as synced.
    //
    // v1.296.0: this used to fall back to a hardcoded 'Total_Acv__c' when no
    // active write mapping was found, which meant marking the 'acv' mapping
    // read-only in Admin -> SF Field Mappings had no actual effect — the
    // write happened anyway. The mapping's direction is the only signal of
    // admin intent here (there's no seeded default to fall back to), so
    // absence of a write-capable mapping now means "don't write," matching
    // what the admin sees configured.
    if (activity.acv != null && activity.crmWhatType === 'Opportunity' && activity.crmWhatId) {
      const writeMappings = fieldMappings.filter((m) => m.direction === 'write' || m.direction === 'read_write')
      const acvField = resolveSfField(writeMappings, 'acv')
      try {
        if (acvField) await conn.sobject('Opportunity').update({ Id: activity.crmWhatId, [acvField]: Number(activity.acv) })
      } catch (err) {
        console.warn(`[sf-writeback] ACV update failed for ${activity.id}:`, err instanceof Error ? err.message : String(err))
      }
    }
    await logAudit({ activityId, status: 'success', operation, crmObject: activityType.crmObjectType, crmRecordId, errorMessage: null, payload: record })
    return { ok: true, crmRecordId, attendeeSyncError }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logAudit({ activityId, status: 'failed', operation: activity.crmRecordId ? 'update' : 'create', crmObject: activityType.crmObjectType, crmRecordId: activity.crmRecordId, errorMessage: message, payload: record })
    return { ok: false, error: message }
  }
}

// In-memory dedup: if a sync for this activity id is already running,
// skip. Prevents the race where kickSync (fire-and-forget on POST) and
// the periodic worker tick both grab the same 'pending' row and each
// call conn.sobject.create() — producing two SF Event records for one
// ImpactIQ activity. Cleared in a finally block.
const inFlight = new Set<string>()

export async function processActivitySync(activityId: string): Promise<void> {
  if (inFlight.has(activityId)) return
  inFlight.add(activityId)
  try {
  if (await parkDemoActivitySync(activityId)) return
  // Current retry count, to advance/reset it after this attempt.
  const [cur] = await db.select({ attempts: activities.crmSyncAttempts }).from(activities).where(eq(activities.id, activityId)).limit(1)
  const priorAttempts = cur?.attempts ?? 0
  const result = await syncActivity(activityId)
  if (result.ok) {
    // If attendee (EventRelation) sync failed, keep the crmRecordId but
    // mark the activity as failed so Admin → Sync Issues surfaces it.
    // The Event itself was still written; crmSyncError explains what's
    // missing (Names section).
    const attendeeErr = result.attendeeSyncError
    await db
      .update(activities)
      .set({
        crmRecordId: result.crmRecordId,
        crmSyncStatus: attendeeErr ? 'failed' : 'synced',
        crmSyncError: attendeeErr,
        crmSyncedAt: new Date(),
        // Full success resets the retry counter; a partial (attendee-only)
        // failure is NOT auto-retried — the Event already exists, so re-running
        // would risk duplicates. Leave it parked (nextRetryAt null) for manual
        // attention via Sync Issues.
        crmSyncAttempts: attendeeErr ? priorAttempts : 0,
        crmNextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(activities.id, activityId))
  } else {
    // Hard failure — nothing was written. Schedule an automatic retry with
    // backoff until the cap, then park for manual retry.
    const attempts = priorAttempts + 1
    const willRetry = attempts < MAX_SYNC_RETRIES
    await db
      .update(activities)
      .set({
        crmSyncStatus: 'failed',
        crmSyncError: result.error,
        crmSyncAttempts: attempts,
        crmNextRetryAt: willRetry ? new Date(Date.now() + retryBackoffMs(attempts)) : null,
        updatedAt: new Date(),
      })
      .where(eq(activities.id, activityId))
    // Only once automatic retries have run out, so a webhook hears about
    // failures someone has to act on, not every transient one.
    if (!willRetry) await emitActivityEvent('activity.crm_sync_failed', activityId)
  }
  } finally {
    inFlight.delete(activityId)
  }
}

// `syncOne` defaults to the Salesforce sync; the HubSpot worker passes its
// own, reusing the same pick-up rule (fresh pending rows plus failed rows due
// for an automatic retry).
export async function processPendingActivities(syncOne: (activityId: string) => Promise<void> = processActivitySync): Promise<{ processed: number }> {
  // Pick up fresh 'pending' rows plus 'failed' rows that are due for an
  // automatic retry (attempts under the cap and nextRetryAt reached). Partial
  // failures (nextRetryAt null) are excluded.
  const pending = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(
      eq(activities.status, 'submitted'),
      or(
        eq(activities.crmSyncStatus, 'pending'),
        and(
          eq(activities.crmSyncStatus, 'failed'),
          lt(activities.crmSyncAttempts, MAX_SYNC_RETRIES),
          isNotNull(activities.crmNextRetryAt),
          lte(activities.crmNextRetryAt, new Date()),
        ),
      ),
    ))
    .limit(BATCH_SIZE)

  let processed = 0
  for (const row of pending) {
    try {
      await syncOne(row.id)
      processed++
    } catch (err) {
      console.error('[sf-writeback] error syncing %s:', row.id, err)
    }
  }
  return { processed }
}

// Fire-and-forget kick for a single activity right after it's submitted. Doesn't block the request.
export function kickSync(activityId: string): void {
  void processActivitySync(activityId).catch((err) => {
    console.error('[sf-writeback] inline kick failed for %s:', activityId, err)
  })
}

let stopWriteBackWorkerFn: (() => void) | null = null
let stopSyncAuditCullFn: (() => void) | null = null

const SYNC_AUDIT_CULL_JOB_KEY = 'sync_audit_cull'
const WRITEBACK_WORKER_JOB_KEY = 'writeback_worker'

// Global sync-audit cull. The per-write retention in logAudit only
// culls rows for the specific activity being written; stale rows on
// activities that no longer sync would linger indefinitely without a
// periodic sweep.
export function startSyncAuditCull(): void {
  if (stopSyncAuditCullFn) return
  stopSyncAuditCullFn = scheduleJob(SYNC_AUDIT_CULL_JOB_KEY, 6 * 60 * 60 * 1000, async () => {
    const startedAt = new Date()
    const dayMs = 24 * 60 * 60 * 1000
    const days = (key: string, fallback: number) => { const n = Number(process.env[key]); return Number.isFinite(n) && n > 0 ? n : fallback }
    const ymd = (d: Date) => d.toISOString().slice(0, 10)
    const ago = (n: number) => new Date(Date.now() - n * dayMs)

    // v1.443.0: each table is culled on its own, so one failing step (say, a
    // table whose migration hasn't run) no longer skips every step after it.
    // The run is still an error if any step failed, naming the step and the
    // database's own message rather than drizzle's "Failed query" wrapper.
    const counts: Record<string, number> = {}
    const failures: string[] = []
    const step = async (key: string, run: () => Promise<number>) => {
      try {
        counts[key] = await run()
      } catch (err) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err
        const message = cause instanceof Error ? cause.message : String(cause)
        console.error(`[audit cull] ${key} failed:`, message)
        failures.push(`${key}: ${message}`)
      }
    }

    try {
      const { nudgeEvents, mcpToolCalls, auditEvents, jobRuns, attachRateHistory, activities, loginEvents, aiRequests, aiClassificationCache } = await import('../../../../drizzle/schema.js')
      const { cullDeliveries } = await import('../webhooks/delivery.js')
      const { cullEmailDeliveries } = await import('../email/deliveryLog.js')
      // v1.444.0: periods come from one list App Health also checks against.
      const { retentionDays } = await import('../health/retention.js')

      await step('sync-audit', async () => (await db.delete(activitySyncAudit).where(lt(activitySyncAudit.attemptedAt, ago(retentionDays('activity_sync_audit')))).returning({ id: activitySyncAudit.id })).length)
      // Nudge events: 30-day retention. Ride the same 6h tick so we
      // don't spawn a second interval.
      await step('nudge', async () => (await db.delete(nudgeEvents).where(lt(nudgeEvents.deliveredAt, ago(retentionDays('nudge_events')))).returning({ id: nudgeEvents.id })).length)
      // v1.145.0: MCP tool-call audit rows — same 30-day retention.
      await step('MCP', async () => (await db.delete(mcpToolCalls).where(lt(mcpToolCalls.calledAt, ago(retentionDays('mcp_tool_calls')))).returning({ id: mcpToolCalls.id })).length)

      // Previously unbounded log tables — cull to their retention so they
      // can't grow forever over the 3-year window. All tunable via env.
      await step('audit-event', async () => (await db.delete(auditEvents).where(lt(auditEvents.createdAt, ago(retentionDays('audit_events')))).returning({ id: auditEvents.id })).length)
      await step('job-run', async () => (await db.delete(jobRuns).where(lt(jobRuns.startedAt, ago(retentionDays('job_runs')))).returning({ id: jobRuns.id })).length)
      await step('attach-rate-history', async () => (await db.delete(attachRateHistory).where(lt(attachRateHistory.snapshotDate, ymd(ago(days('ATTACH_RATE_HISTORY_RETENTION_DAYS', 1095))))).returning({ teamId: attachRateHistory.teamId })).length)
      // v1.364.0: login_events (Login History, §14) had no retention at all —
      // same "previously unbounded log table" class as the three above.
      await step('login-event', async () => (await db.delete(loginEvents).where(lt(loginEvents.createdAt, ago(retentionDays('login_events')))).returning({ id: loginEvents.id })).length)
      // v1.391.0: AI Assistant usage log (one row per AI call, no input text)
      // and the calendar classification cache, which only needs entries that
      // are still being reused.
      await step('AI-request', async () => (await db.delete(aiRequests).where(lt(aiRequests.createdAt, ago(retentionDays('ai_requests')))).returning({ id: aiRequests.id })).length)
      await step('AI-cache', async () => (await db.delete(aiClassificationCache).where(lt(aiClassificationCache.lastUsedAt, ago(90))).returning({ id: aiClassificationCache.id })).length)
      // v1.427.0: outbound event webhook deliveries that are finished.
      await step('webhook-delivery', () => cullDeliveries(retentionDays('event_webhook_deliveries')))
      // v1.440.0: outbound email delivery log (App Health's Email tile).
      await step('email-delivery', () => cullEmailDeliveries(retentionDays('email_deliveries')))
      // v1.453.0: Gong transcripts past the cache period set on the Gong card.
      await step('gong-transcript', async () => (await import('../gong/transcripts.js')).cullGongTranscripts())
      // v1.457.0: AI Note items nobody reviewed, once their transcript would be gone.
      await step('AI-note-item', async () => (await import('../aiNotes/generate.js')).cullUnreviewedAiNoteItems())

      // Activities archival is opt-in (business data). Set ACTIVITIES_ARCHIVE_DAYS
      // > 0 to soft-archive (is_archived = true, reversible, kept for audit)
      // activities older than that many days. Disabled by default.
      const archiveDays = Number(process.env['ACTIVITIES_ARCHIVE_DAYS'])
      if (Number.isFinite(archiveDays) && archiveDays > 0) {
        await step('archive', async () => (await db.update(activities)
          .set({ isArchived: true })
          .where(and(eq(activities.isArchived, false), lt(activities.createdAt, ago(archiveDays))))
          .returning({ id: activities.id })).length)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[audit cull] failed:', message)
      failures.push(message)
    }

    const archived = counts['archive'] ?? 0
    const culled = Object.entries(counts).filter(([key]) => key !== 'archive').map(([key, n]) => `${n} ${key}`)
    const summary = (culled.length > 0 ? `Culled ${culled.join(', ')} row(s)` : 'Culled nothing')
      + (archived > 0 ? `; archived ${archived} activities` : '')
    const meta = { ...counts, failed: failures.length }
    if (failures.length > 0) {
      await writeRun(SYNC_AUDIT_CULL_JOB_KEY, startedAt, 'error', `Failed: ${failures.join('; ')}. ${summary}`, meta)
    } else {
      await writeRun(SYNC_AUDIT_CULL_JOB_KEY, startedAt, 'ok', summary, meta)
    }
  }, { firstRunDelayMs: 0 }) // Run once at boot, then every 6 hours — matches prior behavior.
  console.log('[retention cull] scheduled — sweeping every 6h')
}

export function startWriteBackWorker(): void {
  if (stopWriteBackWorkerFn) return
  stopWriteBackWorkerFn = scheduleJob(WRITEBACK_WORKER_JOB_KEY, POLL_INTERVAL_MS, async () => {
    // Salesforce-only job: a quiet no-op when the install runs another CRM.
    if (!(await isCrmProviderActive('salesforce'))) return
    const startedAt = new Date()
    try {
      const { processed } = await processPendingActivities()
      // v1.229.0: only record a run when something actually happened. A
      // quiet 30s tick carries the same "alive, nothing to do"
      // non-information as digest_worker/weekly_recap_worker's quiet
      // ticks — and at 2,880 ticks/day this poller produces far more
      // potential no-op rows than either of those (1,440/288/day), which
      // is exactly what filled up job_runs after v1.227.0 made every job
      // log unconditionally. See CLAUDE.md §14.
      if (processed > 0) {
        await writeRun(WRITEBACK_WORKER_JOB_KEY, startedAt, 'ok', `Processed ${processed} pending activit${processed === 1 ? 'y' : 'ies'}`, { processed })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[sf-writeback] worker tick failed:', err)
      await writeRun(WRITEBACK_WORKER_JOB_KEY, startedAt, 'error', message, null)
    }
  })
  console.log(`[sf-writeback] worker started, polling every ${POLL_INTERVAL_MS / 1000}s`)
}

export function stopWriteBackWorker(): void {
  stopWriteBackWorkerFn?.()
  stopWriteBackWorkerFn = null
}
