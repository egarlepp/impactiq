import { db } from '../../db/index.js'
import { activityNotePushes, activityNotes, activities, teamActivityTypes } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { getSfConnection } from './client.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { logSfSyncAttempt } from './syncAudit.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'

const POLL_INTERVAL_MS = 30_000
const JOB_KEY = 'notes_push_worker'

// Tiny markdown → HTML for what our ReactMarkdown surface supports:
// bold, italic, inline code, links, unordered lists, headings. SF's
// ContentNote accepts a limited HTML subset; anything richer gets
// stripped by SF anyway, so we keep it minimal and safe. Exported for the
// HubSpot note push (hs_note_body takes the same small HTML subset).
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = md.split('\n')
  const out: string[] = []
  let inList = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    if (inList) { out.push('</ul>'); inList = false }
    if (!line) { out.push('<br/>'); continue }
    const h = /^(#{1,3})\s+(.*)/.exec(line)
    if (h && h[1] && h[2] !== undefined) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue }
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inList) out.push('</ul>')
  return out.join('')

  function inline(s: string): string {
    let x = esc(s)
    x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    x = x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    x = x.replace(/(^|\W)_([^_]+)_/g, '$1<i>$2</i>')
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>')
    return x
  }
}

// v1.260.0: was derived from the note body's first line, which gave the
// SF user no indication the record came from ImpactIQ and no reliable
// sense of what it was about (a note's first line is often just prose).
// Now: "ImpactIQ: {Activity Type} - {Activity Title}", e.g.
// "ImpactIQ: Demo - Acme Corp Renewal", so the source and the subject are
// both obvious in the SF Notes & Attachments list. Falls back gracefully
// if either part is missing (e.g. the activity was since deleted).
// SF's ContentNote Title has a 200-char limit. Exported for the HubSpot note
// push, which puts the same title on the note's first line.
export function deriveTitle(activityTypeName: string | null, activityTitle: string | null): string {
  const parts = [activityTypeName, activityTitle].filter((s): s is string => !!s && s.trim().length > 0)
  const subject = parts.length > 0 ? parts.join(' - ') : 'Note'
  return `ImpactIQ: ${subject}`.slice(0, 200)
}

async function pushOne(pushId: string): Promise<void> {
  const [push] = await db.select().from(activityNotePushes).where(eq(activityNotePushes.id, pushId)).limit(1)
  if (!push || push.status !== 'pending') return

  const [note] = await db
    .select({
      id: activityNotes.id,
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
  if (!note) {
    await db.update(activityNotePushes).set({ status: 'failed', error: 'source note deleted' }).where(eq(activityNotePushes.id, pushId))
    await logSfSyncAttempt({
      source: 'note_push', status: 'failed', operation: 'create', crmObject: 'ContentNote',
      errorMessage: 'Source note deleted', userId: push.pushedBy ?? null,
      payload: { pushId, crmTargetType: push.crmTargetType, crmTargetId: push.crmTargetId },
    })
    return
  }

  // Use the *author*'s Salesforce connection so the ContentNote is owned
  // by the person who wrote it — matches the mental model of "I pushed
  // my note to Salesforce" and inherits their sharing scope.
  const ownerId = push.pushedBy ?? note.createdBy
  if (!ownerId) {
    await db.update(activityNotePushes).set({ status: 'failed', error: 'no owner user' }).where(eq(activityNotePushes.id, pushId))
    await logSfSyncAttempt({
      source: 'note_push', status: 'failed', operation: 'create', crmObject: 'ContentNote',
      errorMessage: 'No owner user (note has no author and no pushedBy)', activityId: note.activityId,
      payload: { pushId, crmTargetType: push.crmTargetType, crmTargetId: push.crmTargetId },
    })
    return
  }
  const conn = await getSfConnection(ownerId)
  if (!conn) {
    await db.update(activityNotePushes).set({ status: 'failed', error: 'Salesforce not connected for user' }).where(eq(activityNotePushes.id, pushId))
    await logSfSyncAttempt({
      source: 'note_push', status: 'failed', operation: 'create', crmObject: 'ContentNote',
      errorMessage: 'Salesforce not connected for user', activityId: note.activityId, userId: ownerId,
      payload: { pushId, crmTargetType: push.crmTargetType, crmTargetId: push.crmTargetId },
    })
    return
  }

  let contentNoteId: string | undefined
  try {
    const html = mdToHtml(note.body)
    const title = deriveTitle(note.activityTypeName, note.activityTitle)
    const contentBase64 = Buffer.from(html, 'utf8').toString('base64')

    // 1. Create the ContentNote.
    const createRes = await conn.sobject('ContentNote').create({ Title: title, Content: contentBase64 }) as { id?: string; success?: boolean; errors?: unknown[]; Id?: string }
    contentNoteId = createRes.id ?? createRes.Id
    if (!contentNoteId) throw new Error('ContentNote create returned no id')

    // 2. Link it to the target Opportunity/Account.
    //
    // v1.259.1 fix: this used to re-derive the ContentDocumentId with a
    // nested SOQL query (ContentNote -> ContentDocument.LatestPublishedVersionId
    // -> ContentVersion.ContentDocumentId), immediately after create(). Per
    // Salesforce's own ContentNote object reference, a ContentNote's Id IS
    // its ContentDocument's Id — the query was round-tripping back to the
    // exact id it already had. Worse, querying a record the instant after
    // creating it is exactly the shape of Salesforce's eventual-consistency
    // indexing lag, so that lookup would occasionally return zero rows and
    // fail the whole push with "ContentDocument lookup failed" — a push
    // that would have succeeded outright the moment the real bottleneck
    // (this unnecessary query) was removed. This is very likely the actual
    // cause behind at least some "Push failed" chips in My Notes.
    const contentDocumentId = contentNoteId
    await conn.sobject('ContentDocumentLink').create({
      ContentDocumentId: contentDocumentId,
      LinkedEntityId: push.crmTargetId,
      ShareType: 'V',
      Visibility: 'AllUsers',
    })

    await db.update(activityNotePushes)
      .set({ status: 'synced', crmContentNoteId: contentNoteId, syncedAt: new Date(), error: null })
      .where(eq(activityNotePushes.id, pushId))
    await logSfSyncAttempt({
      source: 'note_push', status: 'success', operation: 'create', crmObject: 'ContentNote', crmRecordId: contentNoteId,
      activityId: note.activityId, userId: ownerId,
      payload: { title, crmTargetType: push.crmTargetType, crmTargetId: push.crmTargetId, crmTargetName: push.crmTargetName },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.update(activityNotePushes).set({ status: 'failed', error: msg.slice(0, 800) }).where(eq(activityNotePushes.id, pushId))
    await logSfSyncAttempt({
      source: 'note_push', status: 'failed', operation: 'create', crmObject: 'ContentNote', crmRecordId: contentNoteId ?? null,
      errorMessage: msg, activityId: note.activityId, userId: ownerId,
      payload: { crmTargetType: push.crmTargetType, crmTargetId: push.crmTargetId, crmTargetName: push.crmTargetName },
    })
  }
}

// Fire immediately when a push is created so the user doesn't wait a
// full poll cycle to see the "synced" state. Errors are swallowed —
// the worker will retry status=pending rows.
export function kickNotePush(pushId: string): void {
  void pushOne(pushId).catch((err) => console.error('[notes-push] kick failed:', err))
}

async function processPendingPushes(): Promise<{ processed: number }> {
  const rows = await db.select({ id: activityNotePushes.id }).from(activityNotePushes).where(eq(activityNotePushes.status, 'pending')).limit(20)
  for (const r of rows) {
    await pushOne(r.id)
  }
  return { processed: rows.length }
}

let stopFn: (() => void) | null = null

export function startNotesPushWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, POLL_INTERVAL_MS, async () => {
    // Salesforce-only job: a quiet no-op when the install runs another CRM.
    if (!(await isCrmProviderActive('salesforce'))) return
    const startedAt = new Date()
    try {
      const { processed } = await processPendingPushes()
      // v1.229.0: only record a run when something actually happened. A
      // quiet 30s tick carries the same "alive, nothing to do"
      // non-information as digest_worker/weekly_recap_worker's quiet
      // ticks — and at 2,880 ticks/day this poller produces far more
      // potential no-op rows than either of those (1,440/288/day), which
      // is exactly what filled up job_runs after v1.227.0 made every job
      // log unconditionally. See CLAUDE.md §14.
      if (processed > 0) {
        await writeRun(JOB_KEY, startedAt, 'ok', `Processed ${processed} pending note push${processed === 1 ? '' : 'es'}`, { processed })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[notes-push] worker tick failed:', err)
      await writeRun(JOB_KEY, startedAt, 'error', message, null)
    }
  })
  console.log(`[notes-push] worker started, polling every ${POLL_INTERVAL_MS / 1000}s`)
}

export function stopNotesPushWorker(): void {
  stopFn?.()
  stopFn = null
}
