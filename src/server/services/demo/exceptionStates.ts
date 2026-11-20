import type { activities, activityCrmTickets, outlookEvents } from '../../../../drizzle/schema.js'
import { DEMO_CRM_ID_PREFIX } from './ids.js'

type ActivityRow = typeof activities.$inferInsert
type CalendarRow = typeof outlookEvents.$inferInsert

// Retry cap the write-back worker parks a failed row at (writeback.ts
// MAX_SYNC_RETRIES). Kept local so this module stays free of CRM clients.
const PARKED_SYNC_ATTEMPTS = 6

const SYNC_ERRORS = [
  'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id (WhatId)',
  'FIELD_CUSTOM_VALIDATION_EXCEPTION: Type is required for this Event record type',
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id',
]

const MEETING_REASONS = [
  'Weekly status sync with the account team',
  'Internal pipeline review',
  'Partner enablement check-in',
  'Deal strategy session with the AE',
  'Customer success handoff',
  'Pricing and packaging questions',
]

// Internal meetings the generator never logs as activity; most of them are
// marked Non-Activity instead.
export const DEMO_NON_ACTIVITY_SUBJECTS = ['Internal team sync', 'Sales weekly']

const MARKETING_EVENTS = ['Spring Product Summit', 'Regional Partner Roadshow', 'Cloud Security Webinar', 'Customer Advisory Board']

const NOTES = [
  'Customer wants a follow-up on SSO and SCIM provisioning before the next call.',
  'Walked through the reporting module; they asked for a sandbox to test data exports.',
  'Champion confirmed budget is approved for this quarter. Procurement next.',
  'Two open technical questions on API rate limits; sent docs after the call.',
  'Architecture review went well. Needs a sizing estimate for 5,000 users.',
  'Prep for the executive readout: success criteria are all green so far.',
]

const TICKET_SUBJECTS = [
  'Login fails after SSO certificate rotation',
  'Report export times out on large date ranges',
  'Webhook deliveries delayed during peak hours',
  'Mobile app crashes on older Android versions',
]

export interface ExceptionStatesInput {
  rows: ActivityRow[]
  calendarRows: CalendarRow[]
  demoUserIds: string[]
  adminUserId: string
  typeNameById: Map<string, string>
  now: Date
  thisMonday: Date
  rnd: () => number
}

export interface ExceptionStatesResult {
  // Row index → ticket snapshot, inserted once activity ids are known.
  tickets: Array<{ rowIndex: number; ticket: Omit<typeof activityCrmTickets.$inferInsert, 'activityId'> }>
  nonActivity: Array<{ userId: string; outlookEventId: string }>
}

// A few rows in every state an exception queue or per-activity feature
// looks for, so each of those screens has something to show: drafts, CRM
// sync results (synced and parked failures), links whose CRM record is
// gone, approved meetings deleted from Outlook, "Why Meeting?" reasons,
// Marketing event names, notes, travel costs, support tickets and
// Non-Activity meetings. Mutates `rows` in place.
export function applyExceptionStates(input: ExceptionStatesInput): ExceptionStatesResult {
  const { rows, calendarRows, demoUserIds, adminUserId, typeNameById, now, thisMonday, rnd } = input
  const typeName = (r: ActivityRow) => typeNameById.get(r.activityTypeId) ?? ''
  const dayMs = 86400_000
  const result: ExceptionStatesResult = { tickets: [], nonActivity: [] }
  const reserved = new Set<number>()

  // Drafts: each demo person's last one or two activities this week are
  // still waiting to be submitted.
  for (const userId of demoUserIds) {
    const mine = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.userId === userId && r.startDatetime.getTime() >= thisMonday.getTime())
      .slice(-(1 + Math.floor(rnd() * 2)))
    for (const { r, i } of mine) {
      r.status = 'draft'
      r.submittedAt = null
      reserved.add(i)
    }
  }

  const submitted = rows.map((r, i) => ({ r, i })).filter(({ i }) => !reserved.has(i))
  const take = (pred: (r: ActivityRow) => boolean, n: number): Array<{ r: ActivityRow; i: number }> => {
    const pool = submitted.filter(({ r, i }) => !reserved.has(i) && pred(r))
    const out: Array<{ r: ActivityRow; i: number }> = []
    while (out.length < n && pool.length > 0) {
      const picked = pool.splice(Math.floor(rnd() * pool.length), 1)[0]!
      reserved.add(picked.i)
      out.push(picked)
    }
    return out
  }
  const recent = (r: ActivityRow, days: number) => r.endDatetime.getTime() > now.getTime() - days * dayMs
  const isDemoUser = (r: ActivityRow) => r.userId !== adminUserId

  // One approved meeting in the admin's own Keep / Delete queue, picked
  // before sync so it has no CRM record for Delete to destroy.
  take((r) => !isDemoUser(r), 1).forEach(({ r }, k) => {
    r.outlookEventId = `demo-outlook-admin-deleted-${k + 1}`
    r.outlookDeletedAt = new Date(now.getTime() - dayMs)
  })

  // CRM sync: a handful of failures parked for manual retry (Admin → CRM
  // Sync shows them with Retry / Resolve); every other linked activity
  // older than a day reads as synced.
  take((r) => !!r.crmWhatId && isDemoUser(r) && recent(r, 21), 3).forEach(({ r }, k) => {
    r.crmSyncStatus = 'failed'
    r.crmSyncError = SYNC_ERRORS[k % SYNC_ERRORS.length]!
    r.crmSyncAttempts = PARKED_SYNC_ATTEMPTS
    r.crmNextRetryAt = null
  })
  let recordN = 0
  for (const { r } of submitted) {
    if (!r.crmWhatId || r.crmSyncStatus === 'failed' || r.status === 'draft' || r.outlookDeletedAt) continue
    if (r.endDatetime.getTime() > now.getTime() - dayMs) continue
    recordN += 1
    r.crmSyncStatus = 'synced'
    r.crmRecordId = `${DEMO_CRM_ID_PREFIX}rec-${String(recordN).padStart(5, '0')}`
    r.crmSyncedAt = new Date((r.createdAt ?? r.endDatetime).getTime() + 5 * 60_000)
  }

  // Links whose CRM record was deleted (Activities Disconnected from CRM).
  for (const { r } of take((r) => r.crmWhatType === 'Opportunity' && isDemoUser(r), 2)) {
    r.crmWhatDeleted = true
    r.crmDisconnectCheckedAt = now
  }
  for (const { r } of take((r) => !!r.crmRelatedId && isDemoUser(r), 1)) {
    r.crmRelatedDeleted = true
    r.crmDisconnectCheckedAt = now
  }

  // Approved meetings since deleted from Outlook (the leader dashboard).
  for (const { r } of take((r) => !!r.outlookEventId && isDemoUser(r) && recent(r, 14), 2)) {
    r.outlookDeletedAt = new Date(now.getTime() - 2 * dayMs)
  }

  // "Why Meeting?" reasons, some already triaged on Activity Health.
  const statuses = [null, null, 'will_watch', 'ignore', 'addressed'] as const
  for (const { r } of submitted) {
    if (typeName(r) !== 'Meeting' || rnd() > 0.4) continue
    r.meetingTypeReason = MEETING_REASONS[Math.floor(rnd() * MEETING_REASONS.length)]!
    const status = statuses[Math.floor(rnd() * statuses.length)] ?? null
    if (status) {
      r.meetingTypeReasonStatus = status
      r.meetingTypeReasonReviewedBy = adminUserId
      r.meetingTypeReasonReviewedAt = new Date(now.getTime() - Math.floor(rnd() * 7) * dayMs)
    }
  }

  // Every Marketing row names its event, this week's drafts included (a
  // Campaign-linked one uses the Campaign's name).
  for (const r of rows) {
    if (typeName(r) === 'Marketing') r.marketingEventName = r.crmWhatType === 'Campaign' && r.crmWhatName ? r.crmWhatName : MARKETING_EVENTS[Math.floor(rnd() * MARKETING_EVENTS.length)]!
  }

  for (const { r } of submitted) {
    // Notes on about a quarter of the demo people's work (the admin's own
    // rows keep their [DEMO] marker note).
    if (isDemoUser(r) && !r.notes && rnd() < 0.25) r.notes = NOTES[Math.floor(rnd() * NOTES.length)]!
  }

  // Travel on a few customer-facing visits (Direct Costs).
  for (const { r } of take((r) => isDemoUser(r) && ['Executive Briefing', 'Demo', 'Discovery'].includes(typeName(r)) && !!r.crmWhatId, 4)) {
    r.locationMode = 'onsite'
    r.location = 'Customer office'
    r.costTransportation = (250 + Math.floor(rnd() * 8) * 50).toFixed(2)
    r.costLodging = (180 + Math.floor(rnd() * 4) * 40).toFixed(2)
    r.costFood = (40 + Math.floor(rnd() * 4) * 15).toFixed(2)
    r.incidentalCurrency = 'USD'
  }

  // Support tickets attached to Support activities.
  let ticketN = 0
  rows.forEach((r, i) => {
    if (typeName(r) !== 'Support' || !isDemoUser(r) || rnd() > 0.6) return
    ticketN += 1
    const n = String(ticketN).padStart(5, '0')
    result.tickets.push({
      rowIndex: i,
      ticket: {
        crmTicketId: `${DEMO_CRM_ID_PREFIX}ticket-${n}`,
        crmTicketNumber: `0010${n}`,
        crmSubject: TICKET_SUBJECTS[ticketN % TICKET_SUBJECTS.length]!,
        crmDateOpened: new Date(r.startDatetime.getTime() - (1 + Math.floor(rnd() * 5)) * dayMs),
        crmStatus: rnd() < 0.5 ? 'Open' : 'Closed',
        crmContact: 'Customer Admin',
        crmPlatform: 'Web',
        crmOwner: 'Support Team',
        attachedBy: r.userId,
        attachedAt: r.createdAt ?? r.endDatetime,
      },
    })
  })

  // Internal meetings the demo people marked Non-Activity themselves. Every
  // fourth one is left unmarked, so the day list still has one to decide.
  const logged = new Set(rows.map((r) => r.outlookEventId).filter((x): x is string => !!x))
  let internalN = 0
  for (const ev of calendarRows) {
    if (logged.has(ev.id) || ev.isAllDay || ev.isCancelled || !DEMO_NON_ACTIVITY_SUBJECTS.includes(ev.subject ?? '')) continue
    internalN += 1
    if (internalN % 4 !== 0) result.nonActivity.push({ userId: ev.userId, outlookEventId: ev.id })
  }

  return result
}
