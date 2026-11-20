import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { gongTranscriptCache } from '../../../../drizzle/schema.js'
import type { GongTranscriptMonologue } from '../../../shared/gong.js'
import { gongRequest } from './client.js'
import { getGongTranscriptCacheDays } from './config.js'
import { isDemoGongCallId, notDemoGongCall } from './demo.js'

// Transcripts are fetched from Gong the first time someone opens one and kept
// for the admin-set cache period (decided question 3), then culled by the
// housekeeping sweep. A culled transcript is fetched again on the next open.

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

// The monologues of one call from POST /v2/calls/transcript; null when the
// answer has no transcript for it.
export function pickTranscript(body: unknown, callId: string): GongTranscriptMonologue[] | null {
  const b = rec(body)
  const list = b ? b['callTranscripts'] : null
  if (!Array.isArray(list)) return null
  const entry = list.map(rec).find((t) => t && String(t['callId']) === callId)
  if (!entry || !Array.isArray(entry['transcript'])) return null
  const out: GongTranscriptMonologue[] = []
  for (const m of entry['transcript']) {
    const r = rec(m)
    if (!r) continue
    const sentences = (Array.isArray(r['sentences']) ? r['sentences'] : [])
      .map(rec)
      .filter((s): s is Record<string, unknown> => !!s && typeof s['text'] === 'string')
      .map((s) => ({ start: Number.isFinite(Number(s['start'])) ? Number(s['start']) : 0, text: String(s['text']) }))
    if (sentences.length === 0) continue
    out.push({
      speakerId: r['speakerId'] === undefined || r['speakerId'] === null ? null : String(r['speakerId']),
      topic: typeof r['topic'] === 'string' && r['topic'] !== '' ? r['topic'] : null,
      sentences,
    })
  }
  return out
}

export async function getGongTranscript(callId: string): Promise<{ monologues: GongTranscriptMonologue[]; fetchedAt: Date } | null> {
  const [cached] = await db.select().from(gongTranscriptCache).where(eq(gongTranscriptCache.gongCallId, callId)).limit(1)
  if (cached) return { monologues: cached.monologues as GongTranscriptMonologue[], fetchedAt: cached.fetchedAt }
  // Demo transcripts only ever come from the cache Demo Data filled.
  if (isDemoGongCallId(callId)) return null
  const res = await gongRequest('/v2/calls/transcript', { method: 'POST', body: { filter: { callIds: [callId] } }, allowStatuses: [404] })
  if (res.status === 404) return null
  const monologues = pickTranscript(res.body, callId)
  if (!monologues) return null
  const fetchedAt = new Date()
  await db.insert(gongTranscriptCache).values({ gongCallId: callId, monologues, fetchedAt })
    .onConflictDoUpdate({ target: gongTranscriptCache.gongCallId, set: { monologues, fetchedAt } })
  return { monologues, fetchedAt }
}

export async function cullGongTranscripts(now: number = Date.now()): Promise<number> {
  const days = await getGongTranscriptCacheDays()
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000)
  return (await db.delete(gongTranscriptCache).where(and(lt(gongTranscriptCache.fetchedAt, cutoff), notDemoGongCall(gongTranscriptCache.gongCallId))).returning({ id: gongTranscriptCache.gongCallId })).length
}

// On disconnect. Demo transcripts stay until Remove Demo Data.
export async function clearGongTranscripts(): Promise<void> {
  await db.delete(gongTranscriptCache).where(notDemoGongCall(gongTranscriptCache.gongCallId))
}
