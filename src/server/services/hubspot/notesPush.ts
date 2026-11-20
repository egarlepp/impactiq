import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activityNotePushes, activityNotes, teamActivityTypes } from '../../../../drizzle/schema.js'
import { HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { deriveTitle, mdToHtml } from '../salesforce/notesPush.js'
import { logSfSyncAttempt } from '../salesforce/syncAudit.js'
import { HubspotError, hubspotRequest } from './client.js'
import { getHubspotConfig } from './config.js'
import { getHubspotOwnerIdForUser } from './owners.js'

// Note push to HubSpot (HubSpot plan, phase 4). The HubSpot counterpart of
// salesforce/notesPush.ts, on the same activity_note_pushes rows: the
// "Post: Opp/Acct Notes" checkboxes and My Notes' Push button queue a row,
// and this creates a HubSpot note on the Deal (Opportunity target) or the
// Company (Account target). crm_content_note_id holds the HubSpot note id,
// and every attempt lands in activity_sync_audit (source note_push), so
// Admin → CRM Sync shows it like a Salesforce push.
//
// HubSpot is one portal-wide connection, so a note isn't written "as" the
// author the way a Salesforce ContentNote is; the author's matched HubSpot
// owner is set as the note's owner instead (left blank when they have none).

const POLL_INTERVAL_MS = 30_000
const JOB_KEY = 'hubspot_notes_push_worker'

const TARGET_OBJECT: Record<string, 'deals' | 'companies'> = { Opportunity: 'deals', Account: 'companies' }

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The note body HubSpot stores: the "ImpactIQ: {type} - {title}" line a
// Salesforce ContentNote carries as its Title (HubSpot notes have no title
// field), then the note itself.
export function buildHubspotNoteBody(title: string, markdown: string): string {
  return `<p><strong>${escapeHtml(title)}</strong></p>${mdToHtml(markdown)}`
}

function hubspotMessage(status: number, body: unknown): string {
  const msg = body && typeof body === 'object' ? (body as Record<string, unknown>)['message'] : null
  return `HubSpot ${status}${typeof msg === 'string' && msg ? `: ${msg}` : ''}`
}

async function fail(pushId: string, message: string, audit: { activityId?: string | null; userId?: string | null; recordId?: string | null; payload: unknown }): Promise<void> {
  await db.update(activityNotePushes).set({ status: 'failed', error: message.slice(0, 800) }).where(eq(activityNotePushes.id, pushId))
  await logSfSyncAttempt({
    source: 'note_push', status: 'failed', operation: 'create', crmObject: 'notes', crmRecordId: audit.recordId ?? null,
    errorMessage: message, activityId: audit.activityId ?? null, userId: audit.userId ?? null, payload: audit.payload,
  })
}

export async function pushHubspotNote(pushId: string): Promise<void> {
  const [push] = await db.select().from(activityNotePushes).where(eq(activityNotePushes.id, pushId)).limit(1)
  if (!push || push.status !== 'pending') return
  const target = { crmTargetType: push.crmTargetType, crmTargetId: push.crmTargetId, crmTargetName: push.crmTargetName }

  const [note] = await db
    .select({
      activityId: activityNotes.activityId,
      body: activityNotes.body,
      createdBy: activityNotes.createdBy,
      activityTitle: activities.title,
      activityTypeName: teamActivityTypes.name,
    })
    .from(activityNotes)
    .leftJoin(activities, eq(activities.id, activityNotes.activityId))
    .leftJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .where(eq(activityNotes.id, push.activityNoteId))
    .limit(1)
  if (!note) { await fail(pushId, 'Source note deleted', { userId: push.pushedBy, payload: target }); return }

  const userId = push.pushedBy ?? note.createdBy
  const toObject = TARGET_OBJECT[push.crmTargetType]
  // A Salesforce id left on an older activity never reaches HubSpot.
  if (!toObject || !HUBSPOT_ID_RX.test(push.crmTargetId)) {
    await fail(pushId, `Not a HubSpot record: ${push.crmTargetType} ${push.crmTargetId}`, { activityId: note.activityId, userId, payload: target })
    return
  }
  if (!(await getHubspotConfig())) {
    await fail(pushId, 'HubSpot is not connected', { activityId: note.activityId, userId, payload: target })
    return
  }

  const title = deriveTitle(note.activityTypeName, note.activityTitle)
  let noteId: string | null = null
  try {
    const ownerId = userId ? await getHubspotOwnerIdForUser(userId) : null
    const properties: Record<string, string> = {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: buildHubspotNoteBody(title, note.body),
    }
    if (ownerId) properties['hubspot_owner_id'] = ownerId

    const created = await hubspotRequest('/crm/v3/objects/notes', { method: 'POST', body: { properties } })
    const id = created.body && typeof created.body === 'object' ? (created.body as { id?: unknown }).id : null
    if (created.status < 200 || created.status >= 300 || id == null) {
      await fail(pushId, hubspotMessage(created.status, created.body), { activityId: note.activityId, userId, payload: { ...target, title } })
      return
    }
    noteId = String(id)

    const linked = await hubspotRequest(`/crm/v4/objects/notes/${noteId}/associations/default/${toObject}/${push.crmTargetId}`, { method: 'PUT' })
    if (linked.status < 200 || linked.status >= 300) {
      // An unlinked note is invisible in HubSpot, so take it back out
      // rather than leave an orphan; retrying creates a fresh one.
      await hubspotRequest(`/crm/v3/objects/notes/${noteId}`, { method: 'DELETE' }).catch(() => null)
      await fail(pushId, `${toObject} ${push.crmTargetId}: ${hubspotMessage(linked.status, linked.body)}`, { activityId: note.activityId, userId, recordId: noteId, payload: { ...target, title } })
      return
    }

    await db.update(activityNotePushes)
      .set({ status: 'synced', crmContentNoteId: noteId, syncedAt: new Date(), error: null })
      .where(eq(activityNotePushes.id, pushId))
    await logSfSyncAttempt({
      source: 'note_push', status: 'success', operation: 'create', crmObject: 'notes', crmRecordId: noteId,
      activityId: note.activityId, userId, payload: { ...target, title, ownerId },
    })
  } catch (err) {
    const message = err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)
    await fail(pushId, message, { activityId: note.activityId, userId, recordId: noteId, payload: { ...target, title } })
  }
}

// Fire right away so the user doesn't wait a poll cycle; the worker picks up
// anything still pending.
export function kickHubspotNotePush(pushId: string): void {
  void pushHubspotNote(pushId).catch((err) => { console.error('[hubspot-notes-push] kick failed:', err) })
}

async function processPending(): Promise<number> {
  const rows = await db.select({ id: activityNotePushes.id }).from(activityNotePushes).where(eq(activityNotePushes.status, 'pending')).limit(20)
  for (const r of rows) await pushHubspotNote(r.id)
  return rows.length
}

let stopFn: (() => void) | null = null

export function startHubspotNotesPushWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, POLL_INTERVAL_MS, async () => {
    // HubSpot-only job, quiet unless HubSpot is the CRM; a run row only when
    // something was pushed (same gate as every 30s poller, CLAUDE.md §14).
    if (!(await isCrmProviderActive('hubspot'))) return
    const startedAt = new Date()
    try {
      const processed = await processPending()
      if (processed > 0) await writeRun(JOB_KEY, startedAt, 'ok', `Processed ${processed} pending note push${processed === 1 ? '' : 'es'}`, { processed })
    } catch (err) {
      console.error('[hubspot-notes-push] worker tick failed:', err)
      await writeRun(JOB_KEY, startedAt, 'error', err instanceof Error ? err.message : String(err), null)
    }
  })
}
