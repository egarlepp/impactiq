import { and, eq, gte, inArray, lte, notExists, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activityGongCalls, gongCalls, gongLinkDismissals } from '../../../../drizzle/schema.js'
import {
  GONG_AUTO_LINK_LOOKBACK_DAYS,
  GONG_AUTO_LINK_MIN_SCORE,
  GONG_SUGGESTION_MIN_SCORE,
  type GongLinkMethod,
} from '../../../shared/gong.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { getGongConfig } from './config.js'
import { notDemoGongCall } from './demo.js'
import { getDemoTeamId } from '../demo/ids.js'
import { getGongIdentities, onCallCondition } from './identity.js'
import { outlookIdsOf, scoreGongCall, toMatchActivity } from './match.js'
import { textArray } from './sqlArray.js'

// Auto-linking (Gong plan, phase 3). An activity with no call linked gets one
// when the answer is clear:
//   - the call was recorded from the same calendar meeting (calendar_event), or
//   - exactly one call the owner was on scores GONG_SUGGESTION_MIN_SCORE or
//     more, and that call scores GONG_AUTO_LINK_MIN_SCORE or more (auto).
// Anything less clear stays a suggestion on the Transcripts tab. A call
// someone unlinked from an activity is never put back on it, a call already
// linked elsewhere is never auto-linked again, and a call that fits two
// activities equally is left for a person to place. Links made here have no
// linked_by, which is how the tab tells them apart.

const DAY_MS = 24 * 60 * 60 * 1000
// Activities read per pass; the newest first.
const MAX_ACTIVITIES = 2000

export interface AutoLinkCandidate {
  activityId: string
  callId: string
  score: number
  sameMeeting: boolean
}

export interface AutoLinkDecision {
  activityId: string
  callId: string
  method: Exclude<GongLinkMethod, 'manual'>
  score: number
}

// Pure: which candidates become links. `linkedElsewhere` holds calls already
// linked to some activity.
export function decideAutoLinks(candidates: AutoLinkCandidate[], linkedElsewhere: Set<string> = new Set()): AutoLinkDecision[] {
  const byActivity = new Map<string, AutoLinkCandidate[]>()
  for (const c of candidates) {
    const list = byActivity.get(c.activityId) ?? []
    list.push(c)
    byActivity.set(c.activityId, list)
  }
  const proposed: AutoLinkDecision[] = []
  for (const [activityId, list] of byActivity) {
    const same = list.filter((c) => c.sameMeeting)
    if (same.length > 0) {
      for (const c of same) proposed.push({ activityId, callId: c.callId, method: 'calendar_event', score: 100 })
      continue
    }
    const plausible = list.filter((c) => c.score >= GONG_SUGGESTION_MIN_SCORE)
    const best = plausible[0]
    if (plausible.length === 1 && best && best.score >= GONG_AUTO_LINK_MIN_SCORE && !linkedElsewhere.has(best.callId)) {
      proposed.push({ activityId, callId: best.callId, method: 'auto', score: best.score })
    }
  }
  // A call proposed by score for two activities is ambiguous: neither gets it.
  const autoCount = new Map<string, number>()
  for (const p of proposed) if (p.method === 'auto') autoCount.set(p.callId, (autoCount.get(p.callId) ?? 0) + 1)
  return proposed.filter((p) => p.method !== 'auto' || autoCount.get(p.callId) === 1)
}

type CallRow = typeof gongCalls.$inferSelect

export interface AutoLinkResult {
  activities: number
  linked: number
}

// One pass. With `callIds` (the webhook), only activities near those calls
// are considered; otherwise every activity in the lookback window.
export async function autoLinkGongCalls(opts: { now?: number; callIds?: string[] } = {}): Promise<AutoLinkResult> {
  const now = opts.now ?? Date.now()
  let from = new Date(now - GONG_AUTO_LINK_LOOKBACK_DAYS * DAY_MS)
  let to = new Date(now + DAY_MS)
  let onlyCalls: CallRow[] | null = null
  if (opts.callIds) {
    if (opts.callIds.length === 0) return { activities: 0, linked: 0 }
    onlyCalls = await db.select().from(gongCalls).where(and(inArray(gongCalls.id, opts.callIds), notDemoGongCall(gongCalls.id)))
    if (onlyCalls.length === 0) return { activities: 0, linked: 0 }
    const starts = onlyCalls.map((c) => c.startedAt.getTime())
    from = new Date(Math.min(...starts) - DAY_MS)
    to = new Date(Math.max(...starts) + DAY_MS)
  }

  // Demo Data (v1.459.0) brings its own links: never auto-link a demo-team
  // activity, or a demo call.
  const demoTeamId = await getDemoTeamId()
  const acts = await db.select({
    id: activities.id,
    userId: activities.userId,
    title: activities.title,
    startDatetime: activities.startDatetime,
    endDatetime: activities.endDatetime,
    outlookEventId: activities.outlookEventId,
    outlookWritebackEventId: activities.outlookWritebackEventId,
    crmWhatId: activities.crmWhatId,
    crmAccountId: activities.crmAccountId,
    crmWhoId: activities.crmWhoId,
    crmRelatedId: activities.crmRelatedId,
    attendees: activities.attendees,
    meetingOwnerEmail: activities.meetingOwnerEmail,
  }).from(activities).where(and(
    eq(activities.isArchived, false),
    demoTeamId ? sql`${activities.teamId} <> ${demoTeamId}` : undefined,
    gte(activities.startDatetime, from),
    lte(activities.startDatetime, to),
    notExists(db.select({ one: sql`1` }).from(activityGongCalls).where(eq(activityGongCalls.activityId, activities.id))),
  )).orderBy(sql`${activities.startDatetime} DESC`).limit(MAX_ACTIVITIES)
  if (acts.length === 0) return { activities: 0, linked: 0 }

  const dismissed = new Set((await db.select({ a: gongLinkDismissals.activityId, c: gongLinkDismissals.gongCallId })
    .from(gongLinkDismissals).where(inArray(gongLinkDismissals.activityId, acts.map((a) => a.id))))
    .map((r) => `${r.a}|${r.c}`))
  const identities = await getGongIdentities(acts.map((a) => a.userId))

  // Candidates, one owner at a time: calls near that owner's activities that
  // the owner was on, or that were recorded from one of their meetings.
  const byOwner = new Map<string, typeof acts>()
  for (const a of acts) byOwner.set(a.userId, [...(byOwner.get(a.userId) ?? []), a])
  const candidates: AutoLinkCandidate[] = []
  const callsById = new Map<string, CallRow>()
  for (const [ownerId, list] of byOwner) {
    const owner = identities.get(ownerId) ?? { emails: [], gongUserIds: [] }
    const outlookIds = list.flatMap(outlookIdsOf)
    let calls: CallRow[]
    if (onlyCalls) {
      calls = onlyCalls
    } else {
      const lo = new Date(Math.min(...list.map((a) => a.startDatetime.getTime())) - DAY_MS)
      const hi = new Date(Math.max(...list.map((a) => a.endDatetime.getTime())) + DAY_MS)
      const sameMeeting = outlookIds.length > 0 ? sql`gong_calls.calendar_event_id = ANY(${textArray(outlookIds)})` : sql`false`
      calls = await db.select().from(gongCalls).where(and(
        notDemoGongCall(gongCalls.id),
        gte(gongCalls.startedAt, lo),
        lte(gongCalls.startedAt, hi),
        sql`(${onCallCondition(owner)} OR ${sameMeeting})`,
      ))
    }
    for (const act of list) {
      const match = toMatchActivity(act)
      const lo = act.startDatetime.getTime() - DAY_MS
      const hi = act.endDatetime.getTime() + DAY_MS
      for (const call of calls) {
        if (dismissed.has(`${act.id}|${call.id}`)) continue
        const sameMeeting = !!call.calendarEventId && match.outlookEventIds.includes(call.calendarEventId)
        const t = call.startedAt.getTime()
        if (!sameMeeting && (t < lo || t > hi)) continue
        const { score, reasons } = scoreGongCall(match, call, owner)
        // Only calls the owner was on can be linked by score.
        if (!sameMeeting && !reasons.some((r) => r.kind === 'owner_on_call')) continue
        candidates.push({ activityId: act.id, callId: call.id, score, sameMeeting })
        callsById.set(call.id, call)
      }
    }
  }
  if (candidates.length === 0) return { activities: acts.length, linked: 0 }

  const callIds = [...callsById.keys()]
  const linkedElsewhere = new Set((await db.select({ id: activityGongCalls.gongCallId }).from(activityGongCalls)
    .where(inArray(activityGongCalls.gongCallId, callIds))).map((r) => r.id))
  candidates.sort((a, b) => b.score - a.score)
  const decisions = decideAutoLinks(candidates, linkedElsewhere)

  let linked = 0
  for (const d of decisions) {
    const call = callsById.get(d.callId)
    if (!call) continue
    const inserted = await db.insert(activityGongCalls).values({
      activityId: d.activityId,
      gongCallId: call.id,
      title: call.title,
      url: call.url,
      startedAt: call.startedAt,
      durationS: call.durationS,
      linkMethod: d.method,
      matchScore: d.score,
      linkedBy: null,
    }).onConflictDoNothing().returning({ id: activityGongCalls.id })
    linked += inserted.length
  }
  return { activities: acts.length, linked }
}

// Does nothing (null, no run row) unless Gong is connected with working
// credentials and Link calls automatically is on. The scheduler also holds
// the job until Gong is set up (JOB_NEEDS in jobReadiness.ts).
export async function runGongAutoLink(opts: { source?: 'scheduled' | 'manual' | 'webhook'; callIds?: string[] } = {}): Promise<AutoLinkResult | null> {
  const cfg = await getGongConfig()
  if (!cfg || !cfg.autoLink) return null
  const startedAt = new Date()
  const source = opts.source ?? 'scheduled'
  try {
    const result = await autoLinkGongCalls(opts.callIds ? { callIds: opts.callIds } : {})
    // Quiet passes record no run row.
    if (result.linked > 0 || source === 'manual') {
      await writeRun('gong_auto_link', startedAt, 'ok', `${result.linked} calls linked`, { ...result, source })
    }
    return result
  } catch (err) {
    await writeRun('gong_auto_link', startedAt, 'error', err instanceof Error ? err.message : String(err), { source })
    throw err
  }
}

let stopFn: (() => void) | null = null
export function startGongAutoLinkWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob('gong_auto_link', 15 * 60 * 1000, async () => {
    await runGongAutoLink().catch(() => {})
  }, { firstRunDelayMs: 10 * 60 * 1000 })
}
