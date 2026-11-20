import type { GongMatchReason } from '../../../shared/gong.js'
import { isOnCall, type GongIdentity } from './identity.js'

// How well a Gong call fits an activity (Gong plan, "Matching a call to an
// activity"). Pure, so the weights are tested directly.

export interface MatchActivity {
  title: string
  startDatetime: Date
  endDatetime: Date
  outlookEventIds: string[]
  crmIds: string[]
  attendeeEmails: string[]
}

export interface MatchCall {
  title: string | null
  startedAt: Date
  durationS: number | null
  calendarEventId: string | null
  partyEmails: string[]
  partyUserIds: string[]
  crmObjectIds: string[]
}

const START_WINDOW_MS = 15 * 60 * 1000

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))
}

export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const w of ta) if (tb.has(w)) shared += 1
  return shared / Math.min(ta.size, tb.size)
}

export function scoreGongCall(activity: MatchActivity, call: MatchCall, owner: GongIdentity): { score: number; reasons: GongMatchReason[] } {
  const reasons: GongMatchReason[] = []
  if (call.calendarEventId && activity.outlookEventIds.includes(call.calendarEventId)) {
    return { score: 100, reasons: [{ kind: 'same_meeting' }] }
  }
  let score = 0
  const callStart = call.startedAt.getTime()
  const callEnd = callStart + (call.durationS ?? 0) * 1000
  const actStart = activity.startDatetime.getTime()
  const actEnd = activity.endDatetime.getTime()
  const delta = callStart - actStart
  const overlaps = callStart <= actEnd && callEnd >= actStart
  if (Math.abs(delta) <= START_WINDOW_MS && overlaps) {
    score += 40
    reasons.push({ kind: 'starts_close', minutes: Math.round(delta / 60000) })
  }
  if (isOnCall(owner, call)) {
    score += 25
    reasons.push({ kind: 'owner_on_call' })
  }
  const others = activity.attendeeEmails.filter((e) => !owner.emails.includes(e) && call.partyEmails.includes(e))
  if (others.length > 0) {
    const n = Math.min(3, others.length)
    score += 5 * n
    reasons.push({ kind: 'attendees', count: others.length })
  }
  if (activity.crmIds.some((id) => call.crmObjectIds.includes(id))) {
    score += 20
    reasons.push({ kind: 'same_record' })
  }
  const sim = call.title ? titleSimilarity(activity.title, call.title) : 0
  if (sim > 0) {
    score += Math.round(sim * 10)
    if (sim >= 0.5) reasons.push({ kind: 'similar_title' })
  }
  return { score: Math.min(100, score), reasons }
}

// The activity columns matching reads, as both the Transcripts tab and the
// auto-link job load them.
export interface MatchableActivity {
  title: string
  startDatetime: Date
  endDatetime: Date
  outlookEventId: string | null
  outlookWritebackEventId: string | null
  crmWhatId: string | null
  crmAccountId: string | null
  crmWhoId: string | null
  crmRelatedId: string | null
  attendees: unknown
  meetingOwnerEmail: string | null
}

export function attendeeEmailsOf(attendees: unknown, meetingOwnerEmail: string | null): string[] {
  const out = new Set<string>()
  if (Array.isArray(attendees)) {
    for (const a of attendees) {
      const email = a && typeof a === 'object' ? (a as Record<string, unknown>)['email'] : null
      if (typeof email === 'string' && email.includes('@')) out.add(email.trim().toLowerCase())
    }
  }
  if (meetingOwnerEmail?.includes('@')) out.add(meetingOwnerEmail.trim().toLowerCase())
  return [...out]
}

export function outlookIdsOf(act: Pick<MatchableActivity, 'outlookEventId' | 'outlookWritebackEventId'>): string[] {
  return [act.outlookEventId, act.outlookWritebackEventId].filter((v): v is string => !!v)
}

export function toMatchActivity(act: MatchableActivity): MatchActivity {
  return {
    title: act.title,
    startDatetime: act.startDatetime,
    endDatetime: act.endDatetime,
    outlookEventIds: outlookIdsOf(act),
    crmIds: [act.crmWhatId, act.crmAccountId, act.crmWhoId, act.crmRelatedId].filter((v): v is string => !!v),
    attendeeEmails: attendeeEmailsOf(act.attendees, act.meetingOwnerEmail),
  }
}
