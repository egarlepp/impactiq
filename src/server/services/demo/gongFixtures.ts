import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activityAiNoteItems,
  activityAiNotes,
  activityGongCalls,
  gongCalls,
  gongTranscriptCache,
} from '../../../../drizzle/schema.js'
import type { GongLinkMethod, GongParty, GongTranscriptMonologue } from '../../../shared/gong.js'
import type { AiNoteCitation, AiNoteMeddpiccKey, AiNoteSection, AiNoteSectionMeta, AiNoteVerdict } from '../../../shared/aiNotes.js'
import { DEMO_GONG_CALL_PREFIX } from '../gong/demo.js'
import type { DemoCrm } from './crmFixtures.js'
import type { DemoScoreTarget } from './assessmentFixtures.js'
import { DEMO_CUSTOM_SECTIONS, type DemoCustomSectionKey } from './profileFixtures.js'

const CUSTOM_SECTION_META = new Map<string, AiNoteSectionMeta>(
  Object.values(DEMO_CUSTOM_SECTIONS).map((c) => [c.key, { name: c.name, icon: c.icon, color: c.color }]),
)

// Demo Gong data (v1.459.0): sample calls "imported" from Gong, their
// transcripts, and AI Notes in mixed review states, on the demo team's
// activities. Nothing here calls Gong or the AI: transcripts go straight
// into the transcript cache (which the Transcripts tab reads first, and
// which never fetches a demo call from Gong), and the AI Notes are written
// as if an owner had generated them already.

export const DEMO_GONG_MODEL = 'Demo sample'
const DAY_MS = 24 * 60 * 60 * 1000
const MIN_MS = 60_000
// How far back calls go: Gong is a recent addition, and a few weeks of
// recordings is enough to show every state.
const LOOKBACK_DAYS = 42
const MAX_LINKED_CALLS = 150
const MAX_SUGGESTIONS_PER_GROUP = 6
const SKIPPED_TYPES = new Set(['Enablement', 'Marketing', 'RFx Work'])

export interface DemoGongActivity {
  activityId: string
  userId: string
  title: string
  typeName: string
  start: Date
  end: Date
  outlookEventId: string | null
  crmWhatId: string | null
  crmWhatType: string | null
  crmAccountId: string | null
  accountName: string | null
}

export interface DemoGongPerson { id: string; name: string; email: string }
export interface DemoGongNote { id: string; activityId: string; isPrivate: boolean }

export interface DemoGongInput {
  activities: DemoGongActivity[]
  people: DemoGongPerson[]
  adminUserId: string
  notes: DemoGongNote[]
  evalWork: string
  crm: DemoCrm
  now: Date
  rnd: () => number
}

export interface DemoGongBuild {
  calls: Array<typeof gongCalls.$inferInsert>
  links: Array<typeof activityGongCalls.$inferInsert>
  transcripts: Array<typeof gongTranscriptCache.$inferInsert>
  aiNotes: Array<typeof activityAiNotes.$inferInsert>
  aiNoteItems: Array<typeof activityAiNoteItems.$inferInsert>
  // Linked activities an AI Assessment can score (assessmentFixtures.ts).
  scoreTargets: DemoScoreTarget[]
}

type Role = 'se' | 'ae' | 'c1' | 'c2'
type ScriptKind = 'discovery' | 'demo' | 'eval' | 'exec' | 'check_in'

interface ScriptItem {
  section: AiNoteSection | DemoCustomSectionKey
  text: string
  lines: number[]
  verdict?: AiNoteVerdict
  owner?: Role
  meddpicc?: AiNoteMeddpiccKey
}

interface Script {
  lines: Array<[Role, string]>
  topics: Record<number, string>
  items: ScriptItem[]
}

// Placeholders: {account}, {se}, {ae}, {c1}, {c2}.
export const SCRIPTS: Record<ScriptKind, Script> = {
  discovery: {
    topics: { 0: 'Introductions', 1: 'Current setup', 4: 'Requirements', 7: 'Decision process', 9: 'Next steps' },
    lines: [
      ['ae', "Thanks for making time today. I've brought {se}, who will run the technical side of anything we do together."],
      ['c1', 'Great. Quick context: we have three teams across two regions, and today everything runs through a tool we built in-house.'],
      ['se', "What's driving the look at alternatives now? Is it scale, upkeep, or something else?"],
      ['c1', 'Mostly upkeep. Two people spend half their week keeping it running, and audit season is painful.'],
      ['c2', "From the security side, we need single sign-on and an audit trail we can export. That's not negotiable."],
      ['se', 'Understood. How many users would you expect at launch, and does anything need to stay in one region?'],
      ['c1', 'Around four hundred to start. EU data has to stay in the EU.'],
      ['ae', 'And who else would weigh in on a decision like this?'],
      ['c1', 'Our VP of Operations signs off. Procurement runs a standard security review first, usually four to six weeks.'],
      ['se', "That helps. I'd suggest a tailored demo next, focused on single sign-on, audit export and the regional setup."],
      ['c2', 'That works. Can you send the security pack ahead of time so I can start the questionnaire?'],
      ['ae', "Yes, I'll send it today and propose two times for the demo next week."],
    ],
    items: [
      { section: 'summary', text: '{account} runs three teams across two regions on an in-house tool that takes two people half their week to maintain. They need single sign-on, an exportable audit trail and EU data residency.', lines: [1, 3, 4, 6] },
      { section: 'checked', verdict: 'confirmed', text: 'About 400 users at launch.', lines: [6] },
      { section: 'checked', verdict: 'not_in_notes', text: 'Procurement runs a security review of four to six weeks before signature.', lines: [8] },
      { section: 'next_steps', owner: 'ae', text: 'Send the security pack ahead of the demo.', lines: [10, 11] },
      { section: 'next_steps', owner: 'ae', text: 'Propose two demo times for next week.', lines: [11] },
      { section: 'next_steps', owner: 'se', text: 'Prepare a demo focused on single sign-on, audit export and the regional setup.', lines: [9] },
      { section: 'risks', text: 'The security review alone can take four to six weeks; start the questionnaire early.', lines: [8] },
      { section: DEMO_CUSTOM_SECTIONS.pain.key, text: 'Two people spend half their week keeping the in-house tool running, and audit season is painful.', lines: [3] },
      { section: DEMO_CUSTOM_SECTIONS.decision.key, text: 'The VP of Operations signs off after a procurement security review of four to six weeks.', lines: [8] },
      { section: 'meddpicc', meddpicc: 'identified_pain', text: 'The in-house tool costs two people half their week to maintain.', lines: [3] },
      { section: 'meddpicc', meddpicc: 'economic_buyer', text: 'VP of Operations signs off.', lines: [8] },
      { section: 'meddpicc', meddpicc: 'decision_criteria', text: 'Single sign-on, an exportable audit trail and EU data residency.', lines: [4, 6] },
    ],
  },
  demo: {
    topics: { 0: 'Agenda', 2: 'Single sign-on', 5: 'Audit trail', 8: 'Evaluation plan' },
    lines: [
      ['se', "I'll start where we left off: single sign-on, then the audit trail, then the regional setup."],
      ['c1', 'Sounds good. Our admins will be the main users, so keep that lens.'],
      ['se', "Here's sign-in through your identity provider. Groups map straight to roles, so nobody is set up by hand."],
      ['c2', 'Can we restrict admin rights to one named group only?'],
      ['se', "Yes, that's a role mapping. I'll show it on your test tenant during the evaluation."],
      ['c1', 'The audit view is what our compliance team will care about. Can it export to our log platform?'],
      ['se', 'It exports on a schedule or streams through a webhook. Most teams start with the scheduled export.'],
      ['c2', 'Streaming would be better for us, but scheduled is fine to start.'],
      ['ae', 'What would you want to prove in an evaluation before going to procurement?'],
      ['c1', 'Single sign-on with our groups, the audit export, and that the EU region keeps data in place.'],
      ['se', "I'll write those up as success criteria and send them for your review."],
      ['c1', 'Great. If those three pass, I can take it to our VP.'],
    ],
    items: [
      { section: 'summary', text: 'The demo covered single sign-on with group-to-role mapping, the audit trail and its export options. {c1} will take it to their VP if an evaluation proves single sign-on, audit export and EU residency.', lines: [2, 6, 9, 11] },
      { section: 'checked', verdict: 'confirmed', text: 'Admins will be the main users.', lines: [1] },
      { section: 'checked', verdict: 'differs', text: 'Your notes say a scheduled export is required; on the call {c2} preferred streaming, with scheduled acceptable to start.', lines: [6, 7] },
      { section: 'next_steps', owner: 'se', text: 'Write up the three success criteria and send them for review.', lines: [10] },
      { section: 'next_steps', owner: 'se', text: 'Show admin rights limited to one named group on their test tenant.', lines: [3, 4] },
      { section: 'risks', text: 'Streaming export is preferred: confirm the webhook option fits their log platform.', lines: [7] },
      { section: DEMO_CUSTOM_SECTIONS.objections.key, text: '{c2} asked whether admin rights can be limited to one named group: yes, through role mapping, to be shown on their test tenant.', lines: [3, 4] },
      { section: DEMO_CUSTOM_SECTIONS.objections.key, text: '{c2} would prefer streaming audit export: the webhook option covers it, with scheduled export to start.', lines: [6, 7] },
      { section: 'meddpicc', meddpicc: 'decision_criteria', text: 'Single sign-on with their groups, audit export, EU data residency.', lines: [9] },
      { section: 'meddpicc', meddpicc: 'champion', text: '{c1}, who will take a passing evaluation to their VP.', lines: [11] },
    ],
  },
  eval: {
    topics: { 0: 'Success criteria', 2: 'Open items', 6: 'Steering committee', 9: 'Security' },
    lines: [
      ['se', 'Checkpoint time. Of the eight success criteria, six are signed off.'],
      ['c1', 'Yes, single sign-on and the role mapping went smoothly. My team liked the audit view.'],
      ['se', 'The two open items are the data export and the reporting test, and both need your export file.'],
      ['c2', "That's on us. The export slipped a week because of a change freeze."],
      ['se', 'No problem. If we get it by Wednesday, we can still finish inside the evaluation window.'],
      ['c1', "Wednesday should work. I'll chase it today."],
      ['ae', 'Is anything else needed for the steering committee review?'],
      ['c1', 'A one-page summary of results, and a rough rollout plan for the first two teams.'],
      ['se', "I'll draft the summary once the last two criteria pass, and we'll propose a rollout plan."],
      ['c2', 'One thing: our security team asked for the penetration test report.'],
      ['ae', "I'll request it today and share it under your NDA."],
      ['c1', "Then we're on track for the committee at the end of the month."],
    ],
    items: [
      { section: 'summary', text: "Six of eight success criteria are signed off. The last two wait on {account}'s data export, now due Wednesday, ahead of a steering committee at month end.", lines: [0, 2, 3, 11] },
      { section: 'checked', verdict: 'confirmed', text: 'Six of eight success criteria met.', lines: [0] },
      { section: 'checked', verdict: 'not_in_notes', text: 'Their security team asked for the penetration test report.', lines: [9] },
      { section: 'next_steps', owner: 'c1', text: 'Deliver the export file by Wednesday.', lines: [4, 5] },
      { section: 'next_steps', owner: 'se', text: 'Draft a one-page results summary and a rollout plan for the first two teams.', lines: [7, 8] },
      { section: 'next_steps', owner: 'ae', text: 'Request the penetration test report and share it under NDA.', lines: [10] },
      { section: 'risks', text: "If the export slips again, the last two criteria may not finish inside the evaluation window.", lines: [3, 4] },
      // The evaluation type's Settings Profile replaces the default sections
      // (profileFixtures.ts), so this note has no MEDDPICC section.
      { section: DEMO_CUSTOM_SECTIONS.criteria.key, text: 'Met: single sign-on, role mapping, audit view and three more (six of eight).', lines: [0, 1] },
      { section: DEMO_CUSTOM_SECTIONS.criteria.key, text: "Open: data export and the reporting test, both waiting on {account}'s export file, due Wednesday.", lines: [2, 3, 4] },
    ],
  },
  exec: {
    topics: { 0: 'Introductions', 1: 'Cost of operations', 5: 'Vendor consolidation', 6: 'Timeline' },
    lines: [
      ['ae', 'Thank you for joining. We wanted to share what your team has seen so far and hear your priorities.'],
      ['c1', 'Happy to. My main question is what this does for our cost of operations next year.'],
      ['se', "Your team spends about two people's time maintaining the current tool. Most of that goes away."],
      ['c1', "That's the number my CFO will look at. Can you put it in writing?"],
      ['ae', "Yes, we'll send a one-page ROI summary with your own figures."],
      ['c2', "We're also consolidating vendors, so fewer tools is a plus."],
      ['c1', 'Timing matters too. I want this in place before our next audit cycle in the spring.'],
      ['se', "That's realistic if the rollout starts next quarter. We'd begin with one region."],
      ['c1', "Then let's aim for a decision this quarter."],
      ['ae', "We'll come back with the ROI summary and a timeline that lands before the spring audit."],
    ],
    items: [
      { section: 'summary', text: '{c1} wants the cost case in writing for their CFO and a rollout in place before the spring audit, with a decision this quarter.', lines: [1, 3, 6, 8] },
      { section: 'checked', verdict: 'confirmed', text: 'The executive sponsor asked for a one-page ROI summary.', lines: [3, 4] },
      { section: 'next_steps', owner: 'ae', text: 'Send a one-page ROI summary using their own figures.', lines: [4] },
      { section: 'next_steps', owner: 'se', text: 'Share a timeline that lands before the spring audit, starting with one region.', lines: [7, 9] },
      { section: 'risks', text: 'The spring audit deadline leaves little slack if procurement runs long.', lines: [6, 7] },
      { section: 'meddpicc', meddpicc: 'metrics', text: "Free up about two people's time spent maintaining the current tool.", lines: [2] },
      { section: 'meddpicc', meddpicc: 'economic_buyer', text: '{c1}, with the CFO reviewing the cost case.', lines: [3] },
      { section: 'meddpicc', meddpicc: 'competition', text: 'Vendor consolidation favors fewer tools.', lines: [5] },
    ],
  },
  check_in: {
    topics: { 0: 'Rollout status', 3: 'Data imports', 5: 'Training', 7: 'Expansion' },
    lines: [
      ['se', 'Thanks for the time. I wanted to check in on how the rollout is going.'],
      ['c1', 'Mostly well. Adoption in the first team is strong, the second team is slower.'],
      ['se', "What's holding the second team back?"],
      ['c1', 'They still import data by hand. The mapping template confused a few people.'],
      ['se', "That was a problem in our template. I'll send a corrected version today."],
      ['c2', 'Could we get a short training session for that team too?'],
      ['se', "Yes. Thirty minutes is usually enough. I'll propose a few times."],
      ['c1', 'Also, we may add a third region next year, so keep that in mind.'],
      ['ae', "Good to know. Let's plan a review next quarter to scope it."],
      ['c1', 'Works for us.'],
    ],
    items: [
      { section: 'summary', text: 'The rollout is going well in the first team; the second team is slowed by manual imports. A third region may come next year.', lines: [1, 3, 7] },
      { section: 'checked', verdict: 'confirmed', text: 'The import issue came from the mapping template.', lines: [3, 4] },
      { section: 'checked', verdict: 'not_in_notes', text: '{c2} asked for a short training session for the second team.', lines: [5] },
      { section: 'next_steps', owner: 'se', text: 'Send the corrected mapping template.', lines: [4] },
      { section: 'next_steps', owner: 'se', text: 'Propose times for a 30-minute training session.', lines: [6] },
      { section: 'next_steps', owner: 'ae', text: 'Schedule a review next quarter to scope a third region.', lines: [8] },
      { section: 'risks', text: "Slow adoption in the second team could weaken the renewal case.", lines: [1, 3] },
      { section: 'meddpicc', meddpicc: 'identified_pain', text: "Manual data imports slow the second team's adoption.", lines: [3] },
    ],
  },
}

const AE_NAMES = ['Jordan Reyes', 'Sam Patel', 'Casey Morgan', 'Riley Brooks']
const CONTACTS: Array<{ name: string; title: string }> = [
  { name: 'Priya Nair', title: 'Director of IT Operations' },
  { name: 'Marcus Chen', title: 'VP of Operations' },
  { name: 'Elena Rossi', title: 'Head of Platform' },
  { name: 'Tom Becker', title: 'Security Architect' },
  { name: 'Aiko Tanaka', title: 'IT Manager' },
  { name: 'Luis Ortega', title: 'Compliance Lead' },
  { name: 'Hannah Weiss', title: 'Systems Engineer' },
  { name: 'Omar Haddad', title: 'Procurement Manager' },
]

function scriptKindFor(typeName: string, evalWork: string): ScriptKind {
  if (typeName === 'Discovery') return 'discovery'
  if (typeName === 'Demo') return 'demo'
  if (typeName === evalWork || typeName === 'Eval Work') return 'eval'
  if (typeName === 'Executive Briefing') return 'exec'
  return 'check_in'
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'customer'
}

function emailFor(name: string, domain: string): string {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${domain}`
}

function fill(text: string, names: Record<Role, string> & { account: string }): string {
  return text
    .replace(/\{account\}/g, names.account)
    .replace(/\{se\}/g, names.se)
    .replace(/\{ae\}/g, names.ae)
    .replace(/\{c1\}/g, names.c1)
    .replace(/\{c2\}/g, names.c2)
}

const SPEAKER: Record<Role, string> = { se: '1', ae: '2', c1: '3', c2: '4' }

export function buildDemoGong(input: DemoGongInput): DemoGongBuild {
  const { rnd, now } = input
  const out: DemoGongBuild = { calls: [], links: [], transcripts: [], aiNotes: [], aiNoteItems: [], scoreTargets: [] }
  const personById = new Map(input.people.map((p) => [p.id, p]))
  const personIndex = new Map(input.people.map((p, i) => [p.id, i]))
  const notesByActivity = new Map<string, DemoGongNote[]>()
  for (const n of input.notes) notesByActivity.set(n.activityId, [...(notesByActivity.get(n.activityId) ?? []), n])
  const floor = now.getTime() - LOOKBACK_DAYS * DAY_MS
  const eligible = input.activities
    .filter((a) => a.crmWhatId && !SKIPPED_TYPES.has(a.typeName) && a.end.getTime() <= now.getTime() && a.start.getTime() >= floor)
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  let seq = 0
  let linkedCount = 0
  const suggestions = { admin: 0, others: 0 }
  const systemName = input.crm === 'hubspot' ? 'HubSpot' : 'Salesforce'

  for (const act of eligible) {
    const owner = personById.get(act.userId)
    if (!owner) continue
    const isAdmin = act.userId === input.adminUserId
    const roll = rnd()
    // Linked to the activity, or left unlinked so the tab suggests it.
    const linked = roll < (isAdmin ? 0.6 : 0.2) && linkedCount < MAX_LINKED_CALLS
    const group = isAdmin ? 'admin' : 'others'
    if (linked) linkedCount += 1
    else if (suggestions[group] < MAX_SUGGESTIONS_PER_GROUP && rnd() < 0.25) suggestions[group] += 1
    else continue

    seq += 1
    const callId = `${DEMO_GONG_CALL_PREFIX}${String(seq).padStart(6, '0')}`
    const account = act.accountName ?? 'the customer'
    const domain = `${slug(account)}.example`
    const ae = AE_NAMES[Math.floor(rnd() * AE_NAMES.length)]!
    const c1 = CONTACTS[Math.floor(rnd() * CONTACTS.length)]!
    let c2 = CONTACTS[Math.floor(rnd() * CONTACTS.length)]!
    if (c2.name === c1.name) c2 = CONTACTS[(CONTACTS.indexOf(c1) + 1) % CONTACTS.length]!
    const names = { account, se: owner.name, ae, c1: c1.name, c2: c2.name }
    const ownerGongId = `${DEMO_GONG_CALL_PREFIX}user-${personIndex.get(owner.id) ?? 0}`
    const parties: GongParty[] = [
      { name: owner.name, email: owner.email.toLowerCase(), title: 'Solutions Engineer', affiliation: 'internal', speakerId: SPEAKER.se, gongUserId: ownerGongId },
      { name: ae, email: emailFor(ae, 'sales.demo.impactiq.local'), title: 'Account Executive', affiliation: 'internal', speakerId: SPEAKER.ae, gongUserId: null },
      { name: c1.name, email: emailFor(c1.name, domain), title: c1.title, affiliation: 'external', speakerId: SPEAKER.c1, gongUserId: null },
      { name: c2.name, email: emailFor(c2.name, domain), title: c2.title, affiliation: 'external', speakerId: SPEAKER.c2, gongUserId: null },
    ]
    const crmObjects: Array<{ system: string; objectType: string; objectId: string }> = []
    if (act.crmWhatId) {
      const opp = act.crmWhatType === 'Opportunity'
      crmObjects.push({ system: systemName, objectType: opp ? (input.crm === 'hubspot' ? 'Deal' : 'Opportunity') : (input.crm === 'hubspot' ? 'Company' : 'Account'), objectId: act.crmWhatId })
    }
    if (act.crmAccountId && act.crmAccountId !== act.crmWhatId) {
      crmObjects.push({ system: systemName, objectType: input.crm === 'hubspot' ? 'Company' : 'Account', objectId: act.crmAccountId })
    }

    const startedAt = new Date(act.start.getTime() + (1 + Math.floor(rnd() * 4)) * MIN_MS)
    const meetingS = Math.round((act.end.getTime() - act.start.getTime()) / 1000)
    const durationS = Math.max(600, meetingS - 120 - Math.floor(rnd() * 240))
    const callEnd = startedAt.getTime() + durationS * 1000
    out.calls.push({
      id: callId,
      workspaceId: null,
      title: act.title,
      url: null,
      scheduledAt: act.start,
      startedAt,
      durationS,
      scope: 'External',
      isPrivate: false,
      // A suggestion has no calendar link, so it stays a suggestion.
      calendarEventId: linked ? act.outlookEventId : null,
      primaryUserId: ownerGongId,
      parties,
      partyEmails: parties.map((p) => p.email!).filter(Boolean),
      partyUserIds: [ownerGongId],
      crmObjects,
      crmObjectIds: crmObjects.map((o) => o.objectId),
      indexedAt: new Date(Math.min(callEnd + 15 * MIN_MS, now.getTime())),
    })

    // Transcript: one monologue per line, spread across the call.
    const script = SCRIPTS[scriptKindFor(act.typeName, input.evalWork)]
    const durationMs = durationS * 1000
    const lineStart = script.lines.map((_, i) => Math.round((i * durationMs) / script.lines.length) + 20_000)
    const monologues: GongTranscriptMonologue[] = script.lines.map(([role, text], i) => {
      const parts = fill(text, names).split(/(?<=[.?!])\s+/).filter(Boolean)
      return {
        speakerId: SPEAKER[role],
        topic: script.topics[i] ?? null,
        sentences: parts.map((p, k) => ({ start: lineStart[i]! + k * 4000, text: p })),
      }
    })
    out.transcripts.push({ gongCallId: callId, monologues, fetchedAt: new Date(Math.min(callEnd + 30 * MIN_MS, now.getTime())) })

    if (!linked) continue
    const method: GongLinkMethod = act.outlookEventId ? 'calendar_event' : rnd() < 0.7 ? 'auto' : 'manual'
    out.links.push({
      activityId: act.activityId,
      gongCallId: callId,
      title: act.title,
      url: null,
      startedAt,
      durationS,
      linkMethod: method,
      matchScore: method === 'auto' ? 86 + Math.floor(rnd() * 13) : method === 'calendar_event' ? 100 : null,
      linkedBy: method === 'manual' ? act.userId : null,
      linkedAt: new Date(Math.min(callEnd + (15 + Math.floor(rnd() * 75)) * MIN_MS, now.getTime())),
    })

    // AI Note: most of the admin's recorded activities, some of the team's.
    // Without one, the score reads as a Leader's Run assessment.
    const hasAiNote = rnd() < (isAdmin ? 0.75 : 0.4)
    const generatedAt = new Date(Math.min(callEnd + (20 + Math.floor(rnd() * 100)) * MIN_MS, now.getTime()))
    out.scoreTargets.push({
      activityId: act.activityId,
      userId: act.userId,
      typeName: act.typeName,
      callId,
      citeMs: lineStart,
      runBy: hasAiNote ? act.userId : input.adminUserId,
      runAt: hasAiNote ? generatedAt : new Date(Math.min(callEnd + (2 + Math.floor(rnd() * 5 * 24)) * 60 * MIN_MS, now.getTime())),
    })
    if (!hasAiNote) continue
    const notes = notesByActivity.get(act.activityId) ?? []
    const aiNoteId = randomUUID()
    out.aiNotes.push({
      id: aiNoteId,
      activityId: act.activityId,
      generatedAt,
      generatedBy: act.userId,
      providerId: null,
      model: DEMO_GONG_MODEL,
      inputHash: null,
      gongCallIds: [callId],
      noteCount: notes.length,
      usedPrivateNotes: notes.some((n) => n.isPrivate),
    })

    // Review state: waiting for review, partly reviewed, or reviewed (kept,
    // with an item or two removed, which deletes them).
    const stateRoll = rnd()
    const state: 'pending' | 'partial' | 'reviewed' = stateRoll < 0.4 ? 'pending' : stateRoll < 0.65 ? 'partial' : 'reviewed'
    const reviewedAt = new Date(Math.min(generatedAt.getTime() + (60 + Math.floor(rnd() * 2 * 24 * 60)) * MIN_MS, now.getTime()))
    const removeCount = state === 'pending' ? 0 : 1 + Math.floor(rnd() * 2)
    // The summary and the profiles' custom sections always stay, so each
    // demo note shows what its profile adds.
    const removable = script.items.map((_, i) => i).filter((i) => script.items[i]!.section !== 'summary' && !CUSTOM_SECTION_META.has(script.items[i]!.section))
    const removed = new Set<number>()
    while (removed.size < Math.min(removeCount, removable.length)) removed.add(removable[Math.floor(rnd() * removable.length)]!)
    let sort = 0
    script.items.forEach((item, i) => {
      if (removed.has(i)) return
      const kept = state === 'reviewed' || (state === 'partial' && rnd() < 0.5)
      const citations: AiNoteCitation[] = item.lines.map((l) => ({ kind: 'transcript', callId, startMs: lineStart[l] ?? 0 }))
      if (item.section === 'checked' && item.verdict !== 'not_in_notes' && notes[0]) citations.push({ kind: 'note', noteId: notes[0].id })
      sort += 1
      out.aiNoteItems.push({
        aiNoteId,
        activityId: act.activityId,
        section: item.section,
        sectionMeta: CUSTOM_SECTION_META.get(item.section) ?? null,
        text: fill(item.text, names),
        verdict: item.verdict ?? null,
        ownerName: item.owner ? names[item.owner] : null,
        meddpiccKey: item.meddpicc ?? null,
        citations,
        status: kept ? 'kept' : 'to_review',
        sortOrder: sort,
        fromTranscript: true,
        createdAt: generatedAt,
        reviewedBy: kept ? act.userId : null,
        reviewedAt: kept ? reviewedAt : null,
      })
    })
  }
  return out
}

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>, size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size))
}

export async function seedDemoGong(build: DemoGongBuild): Promise<void> {
  await insertChunked(build.calls, (c) => db.insert(gongCalls).values(c).onConflictDoNothing())
  await insertChunked(build.transcripts, (c) => db.insert(gongTranscriptCache).values(c).onConflictDoNothing())
  await insertChunked(build.links, (c) => db.insert(activityGongCalls).values(c).onConflictDoNothing())
  await insertChunked(build.aiNotes, (c) => db.insert(activityAiNotes).values(c).onConflictDoNothing())
  await insertChunked(build.aiNoteItems, (c) => db.insert(activityAiNoteItems).values(c))
}

// Links, AI Notes and dismissals go with the demo activities; the call
// index and transcript cache are keyed by call id.
export async function removeDemoGong(): Promise<number> {
  const removed = await db.delete(gongCalls).where(sql`${gongCalls.id} LIKE ${DEMO_GONG_CALL_PREFIX + '%'}`).returning({ id: gongCalls.id })
  await db.delete(gongTranscriptCache).where(sql`${gongTranscriptCache.gongCallId} LIKE ${DEMO_GONG_CALL_PREFIX + '%'}`)
  // Links an admin made by hand on a real activity can't point at a demo
  // call (the route refuses), but clear any that predate that check.
  await db.delete(activityGongCalls).where(sql`${activityGongCalls.gongCallId} LIKE ${DEMO_GONG_CALL_PREFIX + '%'}`)
  return removed.length
}

