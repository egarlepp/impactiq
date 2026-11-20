import { describe, it, expect, vi } from 'vitest'

// The pure parts of the Gong phase 2 modules: call parsing, the index plan,
// match scoring, the transcript access rule and transcript parsing. Nothing
// here touches the database or Gong.
vi.mock('../../db/index.js', () => ({ db: {} }))

import { pickGongCalls, planIndexWindows, toGongCallRow } from './calls.js'
import { scoreGongCall, titleSimilarity, type MatchActivity, type MatchCall } from './match.js'
import { decideTranscriptAccess } from './access.js'
import { pickTranscript } from './transcripts.js'
import { formatTranscriptOffset, gongCallUrlAt, GONG_INDEX_LOOKBACK_DAYS } from '../../../shared/gong.js'

const DAY = 24 * 60 * 60 * 1000

describe('toGongCallRow / pickGongCalls', () => {
  const raw = {
    metaData: {
      id: '7782342274025937895',
      url: 'https://app.gong.io/call?id=778',
      title: ' Acme discovery ',
      scheduled: '2026-10-20T15:00:00Z',
      started: '2026-10-20T15:02:00Z',
      duration: 1799.6,
      primaryUserId: '234',
      scope: 'External',
      isPrivate: false,
      calendarEventId: 'AAMkAD=',
      workspaceId: '55',
    },
    context: [{ system: 'Salesforce', objects: [{ objectType: 'Opportunity', objectId: '006A' }, { objectType: 'Account', objectId: '001B' }, { objectType: 'Lead' }] }],
    parties: [
      { emailAddress: 'Pat@Example.com', name: 'Pat Lee', affiliation: 'Internal', userId: '234', speakerId: 's1' },
      { emailAddress: 'pat@example.com', name: 'Pat again', affiliation: 'Internal', userId: '234' },
      { name: 'Buyer', affiliation: 'External', speakerId: 's2' },
      { name: 'Dial-in', affiliation: 'weird' },
    ],
  }

  it('maps metadata, parties and CRM context', () => {
    const row = toGongCallRow(raw)
    expect(row).not.toBeNull()
    expect(row?.id).toBe('7782342274025937895')
    expect(row?.title).toBe('Acme discovery')
    expect(row?.startedAt.toISOString()).toBe('2026-10-20T15:02:00.000Z')
    expect(row?.durationS).toBe(1800)
    expect(row?.calendarEventId).toBe('AAMkAD=')
    expect(row?.parties.map((p) => p.affiliation)).toEqual(['internal', 'internal', 'external', 'unknown'])
    expect(row?.partyEmails).toEqual(['pat@example.com'])
    expect(row?.partyUserIds).toEqual(['234'])
    expect(row?.crmObjectIds).toEqual(['006A', '001B'])
    expect(row?.crmObjects[0]).toEqual({ system: 'Salesforce', objectType: 'Opportunity', objectId: '006A' })
  })

  it('falls back to the scheduled time and rejects a call with no id or time', () => {
    expect(toGongCallRow({ metaData: { id: '1', scheduled: '2026-10-20T15:00:00Z' } })?.startedAt.toISOString()).toBe('2026-10-20T15:00:00.000Z')
    expect(toGongCallRow({ metaData: { id: '1' } })).toBeNull()
    expect(toGongCallRow({ metaData: { started: '2026-10-20T15:00:00Z' } })).toBeNull()
    expect(toGongCallRow('nope')).toBeNull()
  })

  it('picks the valid calls out of a page', () => {
    expect(pickGongCalls({ calls: [raw, { metaData: {} }, null] })).toHaveLength(1)
    expect(pickGongCalls({})).toEqual([])
    expect(pickGongCalls(null)).toEqual([])
  })
})

describe('planIndexWindows', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')

  it('starts with the last 30 days and a first backfill slice', () => {
    const w = planIndexWindows({ indexedTo: null, backfilledFrom: null, backfillDone: false }, now)
    expect(w[0]).toEqual({ from: now - 30 * DAY, to: now, kind: 'recent' })
    expect(w[1]).toEqual({ from: now - 60 * DAY, to: now - 30 * DAY, kind: 'backfill' })
  })

  it('re-reads the last day after a previous pass', () => {
    const indexedTo = now - 15 * 60 * 1000
    const w = planIndexWindows({ indexedTo: new Date(indexedTo).toISOString(), backfilledFrom: null, backfillDone: true }, now)
    expect(w).toEqual([{ from: indexedTo - DAY, to: now, kind: 'recent' }])
  })

  it('stops the backfill at the lookback floor', () => {
    const floor = now - GONG_INDEX_LOOKBACK_DAYS * DAY
    const w = planIndexWindows({ indexedTo: new Date(now).toISOString(), backfilledFrom: new Date(floor + 10 * DAY).toISOString(), backfillDone: false }, now)
    expect(w[1]).toEqual({ from: floor, to: floor + 10 * DAY, kind: 'backfill' })
    const done = planIndexWindows({ indexedTo: new Date(now).toISOString(), backfilledFrom: new Date(floor).toISOString(), backfillDone: false }, now)
    expect(done).toHaveLength(1)
  })
})

describe('scoreGongCall', () => {
  const start = new Date('2026-10-20T15:00:00Z')
  const activity: MatchActivity = {
    title: 'Acme discovery call',
    startDatetime: start,
    endDatetime: new Date(start.getTime() + 60 * 60 * 1000),
    outlookEventIds: ['evt-1'],
    crmIds: ['006A'],
    attendeeEmails: ['owner@corp.com', 'buyer@acme.com', 'cto@acme.com'],
  }
  const owner = { emails: ['owner@corp.com'], gongUserIds: ['234'] }
  const call: MatchCall = {
    title: 'Acme discovery',
    startedAt: new Date(start.getTime() + 5 * 60 * 1000),
    durationS: 1800,
    calendarEventId: null,
    partyEmails: ['owner@corp.com', 'buyer@acme.com'],
    partyUserIds: ['234'],
    crmObjectIds: ['006A'],
  }

  it('scores the same calendar meeting 100 on its own', () => {
    expect(scoreGongCall(activity, { ...call, calendarEventId: 'evt-1' }, owner)).toEqual({ score: 100, reasons: [{ kind: 'same_meeting' }] })
  })

  it('adds time, owner, attendees, record and title, capped at 100', () => {
    const r = scoreGongCall(activity, call, owner)
    expect(r.reasons.map((x) => x.kind)).toEqual(['starts_close', 'owner_on_call', 'attendees', 'same_record', 'similar_title'])
    expect(r.reasons[0]).toEqual({ kind: 'starts_close', minutes: 5 })
    expect(r.reasons[2]).toEqual({ kind: 'attendees', count: 1 })
    expect(r.score).toBe(100)
  })

  it('gives no time credit outside 15 minutes', () => {
    const r = scoreGongCall(activity, { ...call, startedAt: new Date(start.getTime() + 20 * 60 * 1000), crmObjectIds: [], title: null }, owner)
    expect(r.reasons.map((x) => x.kind)).toEqual(['owner_on_call', 'attendees'])
    expect(r.score).toBe(30)
  })

  it('scores a stranger’s call low', () => {
    const r = scoreGongCall(activity, { ...call, partyEmails: [], partyUserIds: [], crmObjectIds: [], title: 'Weekly sync' }, owner)
    expect(r.score).toBeLessThan(45)
  })
})

describe('titleSimilarity', () => {
  it('compares words longer than two letters', () => {
    expect(titleSimilarity('Acme discovery', 'ACME Discovery call')).toBe(1)
    expect(titleSimilarity('Acme', 'Globex')).toBe(0)
    expect(titleSimilarity('a b', 'a b')).toBe(0)
  })
})

describe('decideTranscriptAccess', () => {
  const none = { isAppAdmin: false, isOwner: false, onCall: false, leaderSwitchOn: false, isTeamLeader: false }
  it('lets the owner, people on the call and App Admins read', () => {
    expect(decideTranscriptAccess({ ...none, isOwner: true })).toBe(true)
    expect(decideTranscriptAccess({ ...none, onCall: true })).toBe(true)
    expect(decideTranscriptAccess({ ...none, isAppAdmin: true })).toBe(true)
  })
  it('lets a leader read only with the team switch on', () => {
    expect(decideTranscriptAccess({ ...none, isTeamLeader: true })).toBe(false)
    expect(decideTranscriptAccess({ ...none, leaderSwitchOn: true })).toBe(false)
    expect(decideTranscriptAccess({ ...none, isTeamLeader: true, leaderSwitchOn: true })).toBe(true)
  })
})

describe('pickTranscript', () => {
  const body = {
    callTranscripts: [
      { callId: '1', transcript: [{ speakerId: 's1', topic: 'Intro', sentences: [{ start: 0, end: 900, text: 'Hi' }, { start: 'x', text: 'there' }] }] },
      { callId: 2, transcript: [{ speakerId: 9, topic: '', sentences: [{ start: 1200, text: 'Two' }] }, { sentences: [] }] },
    ],
  }
  it('returns the monologues for the call asked for', () => {
    expect(pickTranscript(body, '1')).toEqual([{ speakerId: 's1', topic: 'Intro', sentences: [{ start: 0, text: 'Hi' }, { start: 0, text: 'there' }] }])
    expect(pickTranscript(body, '2')).toEqual([{ speakerId: '9', topic: null, sentences: [{ start: 1200, text: 'Two' }] }])
  })
  it('returns null when the call is missing', () => {
    expect(pickTranscript(body, '3')).toBeNull()
    expect(pickTranscript({}, '1')).toBeNull()
  })
})

describe('transcript display helpers', () => {
  it('formats offsets', () => {
    expect(formatTranscriptOffset(0)).toBe('00:00')
    expect(formatTranscriptOffset(65_400)).toBe('01:05')
    expect(formatTranscriptOffset(3_725_000)).toBe('1:02:05')
    expect(formatTranscriptOffset(-5)).toBe('00:00')
  })
  it('adds the second to a Gong call URL', () => {
    expect(gongCallUrlAt('https://app.gong.io/call?id=778', 65_400)).toBe('https://app.gong.io/call?id=778&t=65')
    expect(gongCallUrlAt(null, 1000)).toBeNull()
    expect(gongCallUrlAt('not a url', 1000)).toBeNull()
  })
})
