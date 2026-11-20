import { Router } from 'express'
import { and, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { activities, activityGongCalls, gongCalls, gongLinkDismissals, outlookEvents, rolePermissions, teamMembers, users } from '../../../drizzle/schema.js'
import {
  GONG_INDEX_LOOKBACK_DAYS,
  GONG_SUGGESTION_LIMIT,
  GONG_SUGGESTION_MIN_SCORE,
  type GongActivityCalls,
  type GongCallSummary,
  type GongParty,
  type GongSuggestion,
  type GongTranscriptView,
  type LinkedGongCall,
  type GongLinkMethod,
  type GongWeekMarks,
} from '../../shared/gong.js'
import { logAudit } from '../services/audit/log.js'
import { canViewActivity } from '../services/activities/access.js'
import { canLinkGongCalls, canReadTranscript } from '../services/gong/access.js'
import { GongError } from '../services/gong/client.js'
import { callScopeFor, DEMO_GONG_CALL_ID_RX, gongReadinessForTeam, isDemoGongCallId, isGongAvailable } from '../services/gong/demo.js'
import { getGongIdentities, isOnCall, mergeIdentities, onCallCondition, type GongIdentity } from '../services/gong/identity.js'
import { outlookIdsOf, scoreGongCall, toMatchActivity } from '../services/gong/match.js'
import { getGongTranscript } from '../services/gong/transcripts.js'
import { textArray } from '../services/gong/sqlArray.js'

// The Transcripts tab on the activity drawer (Gong plan, phase 2). Every
// route needs a Gong connection, the activities.transcripts Role Management
// key and a caller who can see the activity. Suggestions and search only ever
// list calls the activity's owner or the caller was on, and a transcript is
// served only past canReadTranscript().

export const gongRouter = Router()

const TRANSCRIPT_PAGE_KEY = 'activities.transcripts'
const DAY_MS = 24 * 60 * 60 * 1000

async function hasTranscriptsPage(userId: string): Promise<boolean> {
  const [u] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, userId)).limit(1)
  if (u?.isAppAdmin) return true
  const roles = [...new Set((await db.select({ role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.userId, userId))).map((r) => r.role))]
  if (roles.includes('admin')) return true
  if (roles.length === 0) return false
  const [grant] = await db
    .select({ role: rolePermissions.role })
    .from(rolePermissions)
    .where(and(inArray(rolePermissions.role, roles), eq(rolePermissions.pageKey, TRANSCRIPT_PAGE_KEY), eq(rolePermissions.hasAccess, true)))
    .limit(1)
  return !!grant
}

// Whether the tab shows for this person at all. With ?activityId=, for that
// activity: a demo-team activity shows the tab when demo Gong calls exist
// (v1.459.0), any other activity only with a real Gong connection.
gongRouter.get('/status', async (req, res) => {
  const activityId = typeof req.query['activityId'] === 'string' ? req.query['activityId'] : undefined
  const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : undefined
  let available: boolean
  if (teamId && !activityId) {
    // v1.460.0: per-team readiness for the weekly view's Transcripts icon, so
    // it follows the same rule as the drawer tab (demo team: demo calls only).
    available = z.string().uuid().safeParse(teamId).success && (await gongReadinessForTeam(teamId)).ready
  } else if (activityId) {
    const act = z.string().uuid().safeParse(activityId).success
      ? (await db.select({ teamId: activities.teamId }).from(activities).where(eq(activities.id, activityId)).limit(1))[0]
      : undefined
    available = !!act && (await gongReadinessForTeam(act.teamId)).ready
  } else {
    available = await isGongAvailable()
  }
  const allowed = available && await hasTranscriptsPage(req.user!.id)
  res.json({ data: { enabled: available && allowed }, error: null, meta: {} })
})

// Every other route: Gong connected (or demo Gong data present) and the page
// key granted. Per-activity routes also check the activity's own team.
gongRouter.use(async (req, res, next) => {
  if (!(await isGongAvailable())) {
    res.status(409).json({ data: null, error: 'errors.gong.not_configured', meta: {} })
    return
  }
  if (!(await hasTranscriptsPage(req.user!.id))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  next()
})

interface LoadedActivity {
  id: string
  userId: string
  teamId: string
  status: string
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
  // A demo-team activity: demo Gong calls only.
  demo: boolean
}

// The activity, or null (missing or not visible: callers answer 404 for both).
async function loadActivity(callerId: string, id: string): Promise<LoadedActivity | null> {
  if (!z.string().uuid().safeParse(id).success) return null
  const [act] = await db.select({
    id: activities.id,
    userId: activities.userId,
    teamId: activities.teamId,
    status: activities.status,
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
  }).from(activities).where(eq(activities.id, id)).limit(1)
  if (!act || !(await canViewActivity(callerId, act))) return null
  // A real activity needs a real connection; a demo one needs demo calls.
  const readiness = await gongReadinessForTeam(act.teamId)
  if (!readiness.ready) return null
  return { ...act, demo: readiness.demo }
}

type CallRow = typeof gongCalls.$inferSelect

function summarize(c: CallRow): GongCallSummary {
  const parties = (Array.isArray(c.parties) ? c.parties : []) as GongParty[]
  const host = parties.find((p) => p.gongUserId && p.gongUserId === c.primaryUserId)
  return {
    id: c.id,
    title: c.title,
    url: c.url,
    startedAt: c.startedAt.toISOString(),
    durationS: c.durationS,
    hostName: host?.name ?? null,
    partyCount: parties.length,
  }
}

function notFound(res: import('express').Response): void {
  res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
}

function gongFailure(res: import('express').Response, err: unknown): void {
  const code = err instanceof GongError ? err.code : 'errors.gong.unreachable'
  res.status(502).json({ data: null, error: code, meta: {} })
}

// Owner and caller identities: calls either of them was on are the only ones
// suggestions and search may list.
async function searchIdentity(callerId: string, ownerId: string): Promise<{ owner: GongIdentity; both: GongIdentity }> {
  const ids = await getGongIdentities([callerId, ownerId])
  const owner = ids.get(ownerId) ?? { emails: [], gongUserIds: [] }
  return { owner, both: mergeIdentities(owner, ids.get(callerId)) }
}

const weekQuery = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
const WEEK_MAX_SPAN_MS = 45 * DAY_MS
const RECORDED_WINDOW_MS = 15 * 60 * 1000

// GET /week?from=&to=: which of the caller's own meetings were recorded in
// Gong (same calendar meeting, or the caller on a call starting within 15
// minutes) and which of their activities have a call linked. Only the
// caller's own data, so the weekly view can mark them.
gongRouter.get('/week', async (req, res) => {
  const parsed = weekQuery.safeParse({
    from: typeof req.query['from'] === 'string' ? req.query['from'] : undefined,
    to: typeof req.query['to'] === 'string' ? req.query['to'] : undefined,
  })
  const from = parsed.success ? new Date(parsed.data.from) : null
  const to = parsed.success ? new Date(parsed.data.to) : null
  if (!from || !to || to <= from || to.getTime() - from.getTime() > WEEK_MAX_SPAN_MS) {
    res.status(400).json({ data: null, error: 'errors.validation', meta: {} })
    return
  }
  const callerId = req.user!.id
  const identity = (await getGongIdentities([callerId])).get(callerId) ?? { emails: [], gongUserIds: [] }
  const events = await db.select({ id: outlookEvents.id, start: outlookEvents.startDatetime }).from(outlookEvents)
    .where(and(eq(outlookEvents.userId, callerId), eq(outlookEvents.isAllDay, false), gte(outlookEvents.startDatetime, from), lte(outlookEvents.startDatetime, to)))
  const eventIds = events.map((e) => e.id)
  const sameMeeting = eventIds.length > 0 ? sql`gong_calls.calendar_event_id = ANY(${textArray(eventIds)})` : sql`false`
  const calls = await db.select({ calendarEventId: gongCalls.calendarEventId, startedAt: gongCalls.startedAt, partyEmails: gongCalls.partyEmails, partyUserIds: gongCalls.partyUserIds })
    .from(gongCalls)
    .where(and(
      gte(gongCalls.startedAt, new Date(from.getTime() - RECORDED_WINDOW_MS)),
      lte(gongCalls.startedAt, new Date(to.getTime() + RECORDED_WINDOW_MS)),
      sql`(${onCallCondition(identity)} OR ${sameMeeting})`,
    ))
  const recorded = new Set<string>()
  for (const c of calls) {
    if (c.calendarEventId && eventIds.includes(c.calendarEventId)) { recorded.add(c.calendarEventId); continue }
    if (!isOnCall(identity, c)) continue
    for (const e of events) {
      if (Math.abs(c.startedAt.getTime() - e.start.getTime()) <= RECORDED_WINDOW_MS) recorded.add(e.id)
    }
  }
  const linked = await db.selectDistinct({ id: activities.id }).from(activities)
    .innerJoin(activityGongCalls, eq(activityGongCalls.activityId, activities.id))
    .where(and(eq(activities.userId, callerId), gte(activities.startDatetime, from), lte(activities.startDatetime, to)))
  const data: GongWeekMarks = { recordedEvents: [...recorded], linkedActivities: linked.map((r) => r.id) }
  res.json({ data, error: null, meta: {} })
})

// GET /activities/:id/calls: the linked calls and whether the viewer may
// read each one.
gongRouter.get('/activities/:id/calls', async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(callerId, req.params['id']!)
  if (!act) return notFound(res)
  const links = await db.select().from(activityGongCalls).where(eq(activityGongCalls.activityId, act.id)).orderBy(desc(activityGongCalls.linkedAt))
  const indexed = links.length === 0 ? [] : await db.select().from(gongCalls).where(inArray(gongCalls.id, links.map((l) => l.gongCallId)))
  const byId = new Map(indexed.map((c) => [c.id, c]))
  const calls: LinkedGongCall[] = []
  for (const l of links) {
    const c = byId.get(l.gongCallId) ?? null
    calls.push({
      id: l.gongCallId,
      title: c?.title ?? l.title,
      url: c?.url ?? l.url,
      startedAt: (c?.startedAt ?? l.startedAt)?.toISOString() ?? null,
      durationS: c?.durationS ?? l.durationS,
      linkMethod: l.linkMethod as GongLinkMethod,
      linkedAt: l.linkedAt.toISOString(),
      canRead: await canReadTranscript(callerId, act, c),
    })
  }
  const data: GongActivityCalls = { calls, canLink: await canLinkGongCalls(callerId, act) }
  res.json({ data, error: null, meta: {} })
})

// GET /activities/:id/suggestions: calls near the activity's time that its
// owner or the viewer was on, scored, best first.
gongRouter.get('/activities/:id/suggestions', async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(callerId, req.params['id']!)
  if (!act) return notFound(res)
  const { owner, both } = await searchIdentity(callerId, act.userId)
  const outlookEventIds = outlookIdsOf(act)
  const near = and(
    gte(gongCalls.startedAt, new Date(act.startDatetime.getTime() - DAY_MS)),
    lte(gongCalls.startedAt, new Date(act.endDatetime.getTime() + DAY_MS)),
  )
  const sameMeeting = outlookEventIds.length > 0 ? sql`gong_calls.calendar_event_id = ANY(${textArray(outlookEventIds)})` : sql`false`
  const candidates = await db.select().from(gongCalls)
    .where(and(onCallCondition(both), callScopeFor(act.demo), sql`(${near} OR ${sameMeeting})`))
    .orderBy(gongCalls.startedAt)
    .limit(100)
  const linked = new Set((await db.select({ id: activityGongCalls.gongCallId }).from(activityGongCalls).where(eq(activityGongCalls.activityId, act.id))).map((r) => r.id))
  const matchActivity = toMatchActivity(act)
  const suggestions: GongSuggestion[] = candidates
    .filter((c) => !linked.has(c.id))
    .map((c) => ({ c, m: scoreGongCall(matchActivity, c, owner) }))
    .filter(({ m }) => m.score >= GONG_SUGGESTION_MIN_SCORE)
    .sort((a, b) => b.m.score - a.m.score)
    .slice(0, GONG_SUGGESTION_LIMIT)
    .map(({ c, m }) => ({ ...summarize(c), score: m.score, reasons: m.reasons }))
  res.json({ data: suggestions, error: null, meta: {} })
})

const searchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

// GET /activities/:id/search?q=&from=&to=: the call index, limited to calls
// the activity's owner or the viewer was on, within the lookback window.
gongRouter.get('/activities/:id/search', async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(callerId, req.params['id']!)
  if (!act) return notFound(res)
  const parsed = searchQuery.safeParse({
    q: typeof req.query['q'] === 'string' ? req.query['q'] : undefined,
    from: typeof req.query['from'] === 'string' ? req.query['from'] : undefined,
    to: typeof req.query['to'] === 'string' ? req.query['to'] : undefined,
  })
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.validation', meta: {} })
    return
  }
  const floor = new Date(Date.now() - GONG_INDEX_LOOKBACK_DAYS * DAY_MS)
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(act.startDatetime.getTime() - 3 * DAY_MS)
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date(act.startDatetime.getTime() + 3 * DAY_MS)
  const { both } = await searchIdentity(callerId, act.userId)
  const conditions = [onCallCondition(both), callScopeFor(act.demo), gte(gongCalls.startedAt, from > floor ? from : floor), lte(gongCalls.startedAt, to)]
  const q = parsed.data.q
  if (q) conditions.push(ilike(gongCalls.title, `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`))
  const rows = await db.select().from(gongCalls).where(and(...conditions)).orderBy(desc(gongCalls.startedAt)).limit(25)
  res.json({ data: rows.map(summarize), error: null, meta: {} })
})

const linkBody = z.object({ gongCallId: z.string().regex(/^\d{1,30}$/).or(z.string().regex(DEMO_GONG_CALL_ID_RX)) })

// POST /activities/:id/calls { gongCallId }: link a call by hand. Owner or
// App Admin, and only a call the owner or the caller was on.
gongRouter.post('/activities/:id/calls', async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(callerId, req.params['id']!)
  if (!act) return notFound(res)
  if (!(await canLinkGongCalls(callerId, act))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const parsed = linkBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.validation', meta: {} })
    return
  }
  const [call] = await db.select().from(gongCalls).where(eq(gongCalls.id, parsed.data.gongCallId)).limit(1)
  const { both } = await searchIdentity(callerId, act.userId)
  // Demo calls link only to demo activities, real calls only to real ones.
  if (!call || isDemoGongCallId(call.id) !== act.demo || !isOnCall(both, call)) return notFound(res)
  await db.insert(activityGongCalls).values({
    activityId: act.id,
    gongCallId: call.id,
    title: call.title,
    url: call.url,
    startedAt: call.startedAt,
    durationS: call.durationS,
    linkMethod: 'manual',
    linkedBy: callerId,
  }).onConflictDoNothing()
  // Linking by hand undoes an earlier Unlink.
  await db.delete(gongLinkDismissals).where(and(eq(gongLinkDismissals.activityId, act.id), eq(gongLinkDismissals.gongCallId, call.id)))
  await logAudit(req, { action: 'activity.gong_call.link', targetType: 'activity', targetId: act.id, meta: { gongCallId: call.id } })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// DELETE /activities/:id/calls/:callId: unlink. Remembered, so auto-linking
// never puts the same call back on this activity.
gongRouter.delete('/activities/:id/calls/:callId', async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(callerId, req.params['id']!)
  if (!act) return notFound(res)
  if (!(await canLinkGongCalls(callerId, act))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const callId = req.params['callId']!
  const removed = await db.delete(activityGongCalls)
    .where(and(eq(activityGongCalls.activityId, act.id), eq(activityGongCalls.gongCallId, callId)))
    .returning({ id: activityGongCalls.id })
  if (removed.length === 0) return notFound(res)
  await db.insert(gongLinkDismissals).values({ activityId: act.id, gongCallId: callId, dismissedBy: callerId }).onConflictDoNothing()
  await logAudit(req, { action: 'activity.gong_call.unlink', targetType: 'activity', targetId: act.id, meta: { gongCallId: callId } })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// GET /activities/:id/calls/:callId/transcript: a linked call's transcript,
// from the cache or Gong, with speaker names from the call's parties.
gongRouter.get('/activities/:id/calls/:callId/transcript', async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(callerId, req.params['id']!)
  if (!act) return notFound(res)
  const callId = req.params['callId']!
  const [link] = await db.select().from(activityGongCalls)
    .where(and(eq(activityGongCalls.activityId, act.id), eq(activityGongCalls.gongCallId, callId))).limit(1)
  if (!link) return notFound(res)
  const [call] = await db.select().from(gongCalls).where(eq(gongCalls.id, callId)).limit(1)
  if (!(await canReadTranscript(callerId, act, call ?? null))) {
    res.status(403).json({ data: null, error: 'errors.gong.transcript_withheld', meta: {} })
    return
  }
  let transcript
  try {
    transcript = await getGongTranscript(callId)
  } catch (err) {
    return gongFailure(res, err)
  }
  if (!transcript) {
    res.status(404).json({ data: null, error: 'errors.gong.transcript_not_ready', meta: {} })
    return
  }
  const parties = ((call?.parties ?? []) as GongParty[])
  const known = parties.length === 0 ? [] : await db.select({ email: users.email }).from(users)
    .where(sql`lower(${users.email}) = ANY(${textArray(parties.map((p) => p.email?.toLowerCase()).filter((e): e is string => !!e))})`)
  const knownEmails = new Set(known.map((k) => k.email.toLowerCase()))
  const data: GongTranscriptView = {
    callId,
    url: call?.url ?? link.url,
    parties: parties.map((p) => ({ ...p, isImpactIqUser: !!p.email && knownEmails.has(p.email) })),
    monologues: transcript.monologues,
    fetchedAt: transcript.fetchedAt.toISOString(),
  }
  res.json({ data, error: null, meta: {} })
})
