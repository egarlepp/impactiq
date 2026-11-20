import { and, inArray, ne } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities } from '../../../../drizzle/schema.js'
import { hubspotSearch, type HubspotObject } from './search.js'

// Finding a meeting HubSpot already has (v1.410.0). A rep who connects their
// Outlook or Google calendar to HubSpot gets their meetings logged by
// HubSpot itself; if ImpactIQ then created its own meeting on approval, the
// same meeting would show twice on the Deal. So before creating a meeting,
// write-back looks for one with the same owner and the same start and end
// time, and fills that in instead (the activity "adopts" it).
//
// Owner and times only, never the title: a meeting synced from the
// organizer's calendar belongs to someone else, and writing ImpactIQ's
// notes and links onto another rep's meeting isn't ours to do.

// HubSpot stores times to the second; calendar sync and ImpactIQ can round
// differently, so a minute either way still counts as the same time.
export const MEETING_MATCH_TOLERANCE_MS = 60_000

export interface MeetingCandidate {
  id: string
  ownerId: string | null
  title: string | null
  start: number | null
  end: number | null
}

export interface MeetingToMatch {
  ownerId: string
  title: string
  start: Date
  end: Date
}

function ms(v: string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  return Number.isFinite(n) ? n : null
}

export function toMeetingCandidate(o: HubspotObject): MeetingCandidate {
  const p = o.properties ?? {}
  return {
    id: String(o.id),
    ownerId: p['hubspot_owner_id'] ? String(p['hubspot_owner_id']) : null,
    title: p['hs_meeting_title'] ? String(p['hs_meeting_title']) : null,
    start: ms(p['hs_meeting_start_time'] ?? undefined) ?? ms(p['hs_timestamp'] ?? undefined),
    end: ms(p['hs_meeting_end_time'] ?? undefined),
  }
}

function sameTitle(a: string | null, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()
}

// The candidate to adopt, or null. Same owner, start within the tolerance,
// end within it too (a meeting with no end time recorded can't be told
// apart from a different one at the same start, so it isn't taken). Ids
// another activity already holds are skipped, so two activities never share
// one meeting. Several left: the one with the same title, then the oldest.
export function pickMatchingMeeting(candidates: MeetingCandidate[], target: MeetingToMatch, taken: Set<string>): string | null {
  const start = target.start.getTime()
  const end = target.end.getTime()
  const matches = candidates.filter((c) =>
    !taken.has(c.id)
    && c.ownerId === target.ownerId
    && c.start != null && Math.abs(c.start - start) <= MEETING_MATCH_TOLERANCE_MS
    && c.end != null && Math.abs(c.end - end) <= MEETING_MATCH_TOLERANCE_MS)
  if (matches.length === 0) return null
  const byAge = [...matches].sort((a, b) => Number(a.id) - Number(b.id))
  return (byAge.find((c) => sameTitle(c.title, target.title)) ?? byAge[0]!).id
}

// Searches HubSpot for the meeting and returns its id, or null. Throws a
// HubspotError when the search itself fails, so the caller retries rather
// than creating a duplicate it couldn't rule out.
export async function findExistingHubspotMeeting(activityId: string, target: MeetingToMatch): Promise<string | null> {
  const start = target.start.getTime()
  const results = await hubspotSearch('meetings', {
    limit: 100,
    properties: ['hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_timestamp', 'hubspot_owner_id'],
    filterGroups: [{
      filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ', value: target.ownerId },
        { propertyName: 'hs_timestamp', operator: 'GTE', value: String(start - MEETING_MATCH_TOLERANCE_MS) },
        { propertyName: 'hs_timestamp', operator: 'LTE', value: String(start + MEETING_MATCH_TOLERANCE_MS) },
      ],
    }],
  })
  const candidates = results.map(toMeetingCandidate)
  if (candidates.length === 0) return null
  const ids = candidates.map((c) => c.id)
  const held = await db.select({ id: activities.crmRecordId }).from(activities)
    .where(and(inArray(activities.crmRecordId, ids), ne(activities.id, activityId)))
  const taken = new Set(held.map((r) => r.id).filter((v): v is string => v != null))
  return pickMatchingMeeting(candidates, target, taken)
}
