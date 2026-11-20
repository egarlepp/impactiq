import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activityNotePushes } from '../../../../drizzle/schema.js'
import { queueCrmNotePush } from './index.js'

// Convenience for the API: create the push row + kick the active CRM's
// push (Salesforce ContentNote, or a HubSpot note since phase 4). The row
// shape is the same for both, so My Notes' push chips and Admin → CRM Sync
// read it the same way.
export async function enqueuePush(params: {
  activityNoteId: string
  pushedBy: string
  crmTargetType: 'Opportunity' | 'Account'
  crmTargetId: string
  crmTargetName: string | null
}): Promise<{ id: string; status: string }> {
  // Dedupe: if there's already a synced or pending push for the same
  // note+target, skip and return the existing row instead of creating a
  // duplicate SF ContentNote.
  const [existing] = await db.select()
    .from(activityNotePushes)
    .where(and(
      eq(activityNotePushes.activityNoteId, params.activityNoteId),
      eq(activityNotePushes.crmTargetId, params.crmTargetId),
    ))
    .limit(1)
  if (existing && existing.status !== 'failed') {
    return { id: existing.id, status: existing.status }
  }
  const inserted = await db.insert(activityNotePushes).values({
    activityNoteId: params.activityNoteId,
    pushedBy: params.pushedBy,
    crmTargetType: params.crmTargetType,
    crmTargetId: params.crmTargetId,
    crmTargetName: params.crmTargetName,
  }).returning()
  const row = inserted[0]
  if (!row) throw new Error('failed to insert activity_note_pushes row')
  queueCrmNotePush(row.id)
  return { id: row.id, status: row.status }
}
