import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { db } from '../db/index.js'
import { activities, outlookEvents, teamActivityTypes, teamMembers, subteamUsers, users, userPtoDays } from '../../../drizzle/schema.js'
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm'
import { resolveCapacityBatch } from '../services/capacity/resolver.js'
import { syncUserCalendar } from '../services/outlook/sync.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { demoCalendarFor } from '../services/demo/generator.js'

export const schedulingRouter = Router()
schedulingRouter.use(requireAuth)

// Manual calendar refresh fans out to Microsoft Graph per user — tight limit
// on top of the global one so it can't be spammed into a Graph-throttling loop.
const refreshLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10 })

// How many users a single manual refresh will sync — bounds the Graph
// load per click (see plan §7). Larger selections still render from the
// existing cache; only the first N get a fresh pull.
const REFRESH_USER_CAP = 15
const REFRESH_THROTTLE_MS = 10 * 60 * 1000

// Resolve the caller's privilege on a team: app-admin / can-see-all, or a
// leader/team_admin/admin membership row. Contributors are NOT privileged
// and only ever see their own event detail.
async function callerPrivilege(callerId: string, teamId: string): Promise<{ privileged: boolean }>
{
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams }).from(users).where(eq(users.id, callerId)).limit(1)
  if (caller?.isAppAdmin || caller?.canSeeAllTeams) return { privileged: true }
  const [m] = await db.select({ role: teamMembers.role }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, callerId))).limit(1)
  const role = m?.role
  return { privileged: role === 'leader' || role === 'team_admin' || role === 'admin' }
}

// GET /api/scheduling/week?teamId=&start=&end=&subteamIds=csv&userIds=csv
// Team free/busy for a week, read from the cached outlook_events +
// activities (no live Graph). Privacy: names/subjects are only included
// for privileged callers or the caller's OWN blocks. Everyone else gets
// anonymized, colored busy blocks (no name/subject/id).
schedulingRouter.get('/week', async (req, res) => {
  const callerId = req.user!.id
  // Coerce to string — Express query values can arrive as arrays/objects
  // (?start[]=x), so a bare cast is unsafe (CodeQL: type confusion).
  const q = req.query as Record<string, unknown>
  const teamId = typeof q['teamId'] === 'string' ? q['teamId'] : undefined
  const startIso = typeof q['start'] === 'string' ? q['start'] : undefined
  const endIso = typeof q['end'] === 'string' ? q['end'] : undefined
  if (!teamId || !startIso || !endIso) {
    res.status(400).json({ data: null, error: 'errors.validation.date_range_required', meta: {} })
    return
  }
  const start = new Date(startIso)
  const end = new Date(endIso)

  // Caller must belong to the team (or be privileged) to see anything.
  const { privileged } = await callerPrivilege(callerId, teamId)
  const [callerMember] = await db.select({ userId: teamMembers.userId }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, callerId))).limit(1)
  if (!privileged && !callerMember) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }

  const subteamIds = String(req.query['subteamIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const explicitUserIds = String(req.query['userIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  // Everyone on this team (the scope ceiling — we never leak outside it).
  const teamRoster = await db
    .select({ id: teamMembers.userId, displayName: users.displayName, role: teamMembers.role, timezone: users.timezone })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
  const rosterIds = new Set(teamRoster.map((r) => r.id))
  const nameById = new Map(teamRoster.map((r) => [r.id, r.displayName] as const))
  // Timezone is non-sensitive, so it's returned for every user (even
  // anonymized peers) so the grid can render/label in the right zone.
  const tzById = new Map(teamRoster.map((r) => [r.id, r.timezone] as const))

  // Build the target set from subteams ∪ explicit users, intersected with
  // the team roster. Default to the caller alone when nothing is selected.
  const target = new Set<string>()
  if (subteamIds.length > 0) {
    const rows = await db.select({ userId: subteamUsers.userId }).from(subteamUsers).where(inArray(subteamUsers.subteamId, subteamIds))
    for (const r of rows) if (rosterIds.has(r.userId)) target.add(r.userId)
  }
  for (const u of explicitUserIds) if (rosterIds.has(u)) target.add(u)
  if (target.size === 0) target.add(callerId)
  const targetIds = Array.from(target)

  // Cached Outlook events for the window across the target users.
  const storedEvRows = await db
    .select()
    .from(outlookEvents)
    .where(and(
      inArray(outlookEvents.userId, targetIds),
      gte(outlookEvents.startDatetime, start),
      lte(outlookEvents.startDatetime, end),
    ))
  // Demo calendars aren't all stored: the admin who generated demo data
  // gets the fixture served live, and demo people's stored events stop at
  // the day Generate ran. Fill both in from the same fixture the weekly
  // view uses, so ids match what was logged.
  type EvRow = Pick<typeof outlookEvents.$inferSelect, 'id' | 'userId' | 'subject' | 'isAllDay' | 'startDatetime' | 'endDatetime' | 'sensitivity' | 'responseStatus'>
  const evRows: EvRow[] = [...storedEvRows]
  const storedIds = new Set(storedEvRows.map((r) => r.id))
  for (const userId of targetIds) {
    const fixture = await demoCalendarFor(userId, start.toISOString(), end.toISOString())
    if (!fixture) continue
    for (const ev of fixture) {
      const evStart = new Date(ev.start)
      if (storedIds.has(ev.id) || evStart < start || evStart > end) continue
      evRows.push({ id: ev.id, userId, subject: ev.subject, isAllDay: ev.isAllDay, startDatetime: evStart, endDatetime: new Date(ev.end), sensitivity: ev.sensitivity, responseStatus: ev.responseStatus })
    }
  }

  // Logged activities in the window for the target users. Submitted rows are
  // visible for everyone in scope; a caller's own drafts are included too so
  // their in-progress work still shows. Manually-created activities (no
  // Outlook event behind them) only appear here — this is what makes them
  // show on the grid. Join the activity type for its color.
  const actRows = targetIds.length
    ? await db
        .select({
          id: activities.id,
          userId: activities.userId,
          title: activities.title,
          startDatetime: activities.startDatetime,
          endDatetime: activities.endDatetime,
          outlookEventId: activities.outlookEventId,
          outlookWritebackEventId: activities.outlookWritebackEventId,
          color: teamActivityTypes.color,
          isPrivateMeeting: activities.isPrivateMeeting,
        })
        .from(activities)
        .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
        .where(and(
          eq(activities.teamId, teamId),
          eq(activities.isArchived, false),
          inArray(activities.userId, targetIds),
          gte(activities.startDatetime, start),
          lte(activities.startDatetime, end),
          or(eq(activities.status, 'submitted'), eq(activities.userId, callerId)),
        ))
    : []
  // Colors + logged-flag for Outlook events that were logged as activities.
  const colorByEvent = new Map<string, string | null>()
  const loggedEventIds = new Set<string>()
  for (const r of actRows) {
    // Inbound: activity created FROM this meeting. Outbound (v1.156.0):
    // activity we WROTE to Outlook. Either way the Outlook event mirrors an
    // activity, so mark it logged to avoid double-counting in the All view.
    if (r.outlookEventId) { colorByEvent.set(r.outlookEventId, r.color); loggedEventIds.add(r.outlookEventId) }
    if (r.outlookWritebackEventId) { colorByEvent.set(r.outlookWritebackEventId, r.color); loggedEventIds.add(r.outlookWritebackEventId) }
  }

  // PTO for the window.
  const ptoRows = targetIds.length
    ? await db.select({ userId: userPtoDays.userId, date: userPtoDays.date })
        .from(userPtoDays)
        .where(and(inArray(userPtoDays.userId, targetIds), gte(userPtoDays.date, startIso.slice(0, 10)), lte(userPtoDays.date, endIso.slice(0, 10))))
    : []
  const ptoByUser = new Map<string, string[]>()
  for (const r of ptoRows) { const l = ptoByUser.get(r.userId) ?? []; l.push(r.date); ptoByUser.set(r.userId, l) }

  // Weekly capacity targets.
  const capMap = await resolveCapacityBatch(targetIds.map((userId) => ({ userId, teamId, asOf: start })))

  // Assemble per-user payload with privacy applied. Each block carries a
  // `source` ('outlook' | 'activity') so the client's View toggle can show
  // the calendar, the logged activities, or a deduped union of both. Outlook
  // blocks also carry `logged` (true when an activity references them) so the
  // union can drop the calendar copy and keep the logged one.
  //
  // v1.263.0: `isPrivate` (Outlook sensitivity / activities.isPrivateMeeting)
  // is a SEPARATE, stricter privacy gate than `privileged` — see PRD §7
  // Scheduling: "Private meetings are shown to the user, but the title and
  // any info other than the time is hidden to any other." A leader can see
  // every OTHER detail of a teammate's calendar on this grid, but not the
  // subject of a meeting the teammate themselves marked private/confidential
  // in Outlook. Only the meeting's own owner ever gets its real subject —
  // canDetail below is deliberately `isSelf || (privileged && !isPrivate)`,
  // not the plain `privileged || isSelf` used everywhere else on this route.
  type Block = { start: string; end: string; isAllDay: boolean; color: string | null; subject?: string; id?: string; source: 'outlook' | 'activity'; logged?: boolean; isPrivate?: boolean; isTentative?: boolean }
  const blocksByUser = new Map<string, Block[]>()
  for (const id of targetIds) blocksByUser.set(id, [])
  for (const r of evRows) {
    const isSelf = r.userId === callerId
    const isPrivate = r.sensitivity === 'private' || r.sensitivity === 'confidential'
    const canDetail = isSelf || (privileged && !isPrivate)
    const block: Block = {
      start: r.startDatetime.toISOString(),
      end: r.endDatetime.toISOString(),
      isAllDay: r.isAllDay,
      color: colorByEvent.get(r.id) ?? null,
      source: 'outlook',
      logged: loggedEventIds.has(r.id),
      isPrivate,
      // v1.263.0: reuses the same Graph responseStatus already cached for
      // capacity/attendee-awareness work — drives the same .stripe-tentative
      // hatch pattern as the Activities cards and calendar column.
      isTentative: r.responseStatus === 'tentativelyAccepted',
    }
    if (canDetail) { block.subject = r.subject ?? '(No subject)'; block.id = r.id }
    blocksByUser.get(r.userId)?.push(block)
  }
  for (const a of actRows) {
    const isSelf = a.userId === callerId
    const isPrivate = !!a.isPrivateMeeting
    const canDetail = isSelf || (privileged && !isPrivate)
    const block: Block = {
      start: a.startDatetime.toISOString(),
      end: a.endDatetime.toISOString(),
      isAllDay: false,
      color: a.color ?? null,
      source: 'activity',
      isPrivate,
    }
    if (canDetail) { block.subject = a.title; block.id = a.id }
    blocksByUser.get(a.userId)?.push(block)
  }

  const usersOut = targetIds.map((id, idx) => {
    const isSelf = id === callerId
    const canName = privileged || isSelf
    const cap = capMap.get(`${id}::${teamId}`)
    return {
      userId: id,
      // Anonymized label for contributors viewing peers.
      displayName: canName ? (nameById.get(id) ?? '—') : `Teammate ${idx + 1}`,
      isSelf,
      anonymized: !canName,
      timezone: tzById.get(id) ?? undefined,
      capacityHours: cap?.hours ?? null,
      pto: ptoByUser.get(id) ?? [],
      blocks: blocksByUser.get(id) ?? [],
    }
  })

  res.json({ data: { users: usersOut, privileged, teamRoster: privileged ? teamRoster.map((r) => ({ id: r.id, displayName: r.displayName })) : undefined }, error: null, meta: { count: usersOut.length } })
})

// POST /api/scheduling/refresh  { teamId, userIds:[] }
// Bounded, throttled manual sync of the selected users' Outlook calendars
// into outlook_events. Reuses the per-user snapshot throttle column.
schedulingRouter.post('/refresh', refreshLimiter, async (req, res) => {
  const callerId = req.user!.id
  const teamId = String((req.body?.teamId as string | undefined) ?? '')
  const userIds = Array.isArray(req.body?.userIds) ? (req.body.userIds as string[]) : []
  if (!teamId) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }

  const [u] = await db.select({ last: users.snapshotRefreshLastAt }).from(users).where(eq(users.id, callerId)).limit(1)
  if (u?.last && Date.now() - u.last.getTime() < REFRESH_THROTTLE_MS) {
    const retryAfterSec = Math.ceil((REFRESH_THROTTLE_MS - (Date.now() - u.last.getTime())) / 1000)
    res.status(429).json({ data: null, error: 'throttled', meta: { retryAfterSec } })
    return
  }

  const { privileged } = await callerPrivilege(callerId, teamId)
  // Only sync users the caller may see: privileged → any team member;
  // contributor → themselves only.
  const roster = await db.select({ id: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, teamId))
  const rosterIds = new Set(roster.map((r) => r.id))
  let toSync = privileged ? userIds.filter((id) => rosterIds.has(id)) : userIds.filter((id) => id === callerId)
  if (toSync.length === 0) toSync = [callerId]
  toSync = toSync.slice(0, REFRESH_USER_CAP)

  await db.update(users).set({ snapshotRefreshLastAt: new Date() }).where(eq(users.id, callerId))
  const results = await Promise.allSettled(toSync.map((id) => syncUserCalendar(id)))
  const synced = results.filter((r) => r.status === 'fulfilled').length
  res.json({ data: { synced, attempted: toSync.length }, error: null, meta: {} })
})
