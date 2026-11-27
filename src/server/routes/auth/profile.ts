import { Router } from 'express'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  users,
  teamMembers,
  rolePermissions,
  holidayCalendars,
  userHolidayCalendars,
  userPtoDays,
  teamHolidayCalendars,
  teams,
} from '../../../../drizzle/schema.js'
import { inArray, gte, lte } from 'drizzle-orm'
import { clearSessionCookie, readSessionCookie, verifySession } from '../../services/auth/session.js'
import { loginEvents } from '../../../../drizzle/schema.js'
import { requireAuth } from '../../middleware/auth.js'
import { isKnownTimeZone, isTimezoneSource, TIMEZONE_SOURCES } from '../../../shared/timezoneSource.js'

export const profileAuthRoutes = Router()

// GET /auth/me — returns the current user + their team roles, or 401.
profileAuthRoutes.get('/me', async (req, res) => {
  const session = await verifySession(readSessionCookie(req))
  if (!session) {
    res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} })
    return
  }
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isAppAdmin: users.isAppAdmin,
      // v1.332.0: gates the sidebar Update pill + Admin → Integrations → App
      // Updates configuration UI — see rbac.ts's requireDefaultAdmin.
      isDefaultAdmin: users.isDefaultAdmin,
      canSeeAllTeams: users.canSeeAllTeams,
      workDays: users.workDays,
      workDayStartHour: users.workDayStartHour,
      workDayEndHour: users.workDayEndHour,
      workHoursPerDay: users.workHoursPerDay,
      workerType: users.workerType,
      timezone: users.timezone,
      defaultTeamId: users.defaultTeamId,
      // v1.263.0: self-service scheduling preference — see schema.ts.
      defaultSubteamId: users.defaultSubteamId,
      preferredCurrency: users.preferredCurrency,
      outlookWritebackEnabled: users.outlookWritebackEnabled,
      // v1.262.0: "Private meetings → Non-Activity" — see CLAUDE.md §7.
      privateMeetingsAsNonActivity: users.privateMeetingsAsNonActivity,
      showFlightDeck: users.showFlightDeck,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)
  if (!user) {
    clearSessionCookie(res)
    res.status(401).json({ data: null, error: 'errors.user_not_found', meta: {} })
    return
  }
  const memberships = await db
    .select({ teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id))

  // Page-access matrix the client uses to gate sidebar/nav links. App admins
  // see everything; otherwise we union the access bits from every role the
  // user holds across their memberships.
  let permissions: Record<string, boolean> = {}
  if (user.isAppAdmin || memberships.some((m) => m.role === 'admin')) {
    permissions = { '*': true }
  } else {
    const roles = Array.from(new Set(memberships.map((m) => m.role)))
    if (roles.length > 0) {
      const rows = await db.select().from(rolePermissions).where(inArray(rolePermissions.role, roles))
      for (const r of rows) {
        if (r.hasAccess) permissions[r.pageKey] = true
      }
    }
  }

  // Resolve the caller's cost rate on their default team using the shared
  // resolver so Settings, dashboards, and every other surface agree.
  let effectiveHourlyCostRate: number | null = null
  let effectiveHourlyCostCurrency: string | null = null
  if (user.defaultTeamId) {
    const { resolveCostOne } = await import('../../services/capacity/resolver.js')
    const r = await resolveCostOne(user.id, user.defaultTeamId, new Date())
    effectiveHourlyCostRate = r.rate
    effectiveHourlyCostCurrency = r.currency
  }

  // Salesforce instance URL is used by the client to construct
  // per-activity "Open in Salesforce" links. Null when the user hasn't
  // authorized SF yet.
  const { userIntegrations } = await import('../../../../drizzle/schema.js')
  const [sfInt] = await db
    .select({ instanceUrl: userIntegrations.instanceUrl })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, user.id), eq(userIntegrations.provider, 'salesforce')))
    .limit(1)

  // v1.364.0: last successful login, for the sidebar user-pill's hover
  // tooltip. Same table + reduction as the admin roster's own "Last Logged
  // In" column (v1.318.0, routes/admin.ts) — just scoped to one user here
  // instead of the whole team, since this is a user viewing their OWN login
  // history, not an admin viewing someone else's.
  const [lastLogin] = await db
    .select({ lastAt: sql<Date | null>`max(${loginEvents.createdAt})` })
    .from(loginEvents)
    .where(and(eq(loginEvents.userId, user.id), eq(loginEvents.success, true)))

  res.json({
    data: {
      ...user,
      memberships,
      permissions,
      isAdmin: user.isAppAdmin || memberships.some((m) => m.role === 'admin'),
      effectiveHourlyCostRate,
      effectiveHourlyCostCurrency,
      sfInstanceUrl: sfInt?.instanceUrl ?? null,
      lastLoginAt: lastLogin?.lastAt ? new Date(lastLogin.lastAt).toISOString() : null,
    },
    error: null,
    meta: {},
  })
})

// GET /auth/me/teams — the caller's team memberships with their subteams.
// Powers the "Team" card in Settings so a user can see the main team they're
// on plus every subteam they've been added to, hierarchically. Team-Manager
// context is denormalized in so the card can show the manager without a
// second round-trip.
profileAuthRoutes.get('/me/teams', async (req, res) => {
  const session = await verifySession(readSessionCookie(req))
  if (!session) { res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} }); return }
  const userId = session.userId
  const { teams, subteams, subteamUsers } = await import('../../../../drizzle/schema.js')
  const memberships = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      teamName: teams.name,
      teamSlug: teams.slug,
      managerUserId: teams.managerUserId,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
  const teamIds = memberships.map((m) => m.teamId)
  const myLinks = teamIds.length === 0 ? [] : await db
    .select({ subteamId: subteamUsers.subteamId, role: subteamUsers.role })
    .from(subteamUsers)
    .where(eq(subteamUsers.userId, userId))
  const mySubteamIds = myLinks.map((l) => l.subteamId)
  const subteamRows = mySubteamIds.length === 0 ? [] : await db
    .select({ id: subteams.id, teamId: subteams.teamId, name: subteams.name, kind: subteams.kind })
    .from(subteams)
    .where(inArray(subteams.id, mySubteamIds))
  const roleBySubteamId = new Map(myLinks.map((l) => [l.subteamId, l.role]))
  const subteamsByTeam = subteamRows.reduce<Record<string, Array<{ id: string; name: string; kind: string | null; role: string }>>>((acc, s) => {
    ;(acc[s.teamId] ??= []).push({ id: s.id, name: s.name, kind: s.kind, role: roleBySubteamId.get(s.id) ?? 'member' })
    return acc
  }, {})
  res.json({
    data: memberships.map((m) => ({
      teamId: m.teamId,
      teamName: m.teamName,
      teamSlug: m.teamSlug,
      role: m.role,
      managerUserId: m.managerUserId,
      subteams: (subteamsByTeam[m.teamId] ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    })),
    error: null,
    meta: {},
  })
})

// GET /auth/me/timezone — the caller's timezone, where it comes from
// (users.timezone_source, v1.469.0) and the Outlook mailbox's own timezone,
// which Settings offers back even while the user has overridden it.
profileAuthRoutes.get('/me/timezone', requireAuth, async (req, res) => {
  const [row] = await db
    .select({ timezone: users.timezone, source: users.timezoneSource, outlookTimezone: users.outlookTimezone })
    .from(users).where(eq(users.id, req.user!.id)).limit(1)
  res.json({
    data: {
      timezone: row?.timezone ?? 'UTC',
      source: isTimezoneSource(row?.source) ? row.source : 'auto',
      outlookTimezone: row?.outlookTimezone ?? null,
    },
    error: null,
    meta: {},
  })
})

// PATCH /auth/me/timezone — user-initiated timezone switch from My Settings.
//   { source: 'auto' }                 follow Outlook (needs a known mailbox timezone)
//   { source: 'crm', timezone }        the CRM's timezone the page showed
//   { source: 'manual', timezone }     any IANA zone from the list
// 'crm' and 'manual' stick: the hourly Outlook check leaves them alone.
// A body with only { timezone } is read as 'manual' (older clients).
profileAuthRoutes.patch('/me/timezone', requireAuth, async (req, res) => {
  const schema = z.object({
    timezone: z.string().trim().min(1).max(100).optional(),
    source: z.enum(TIMEZONE_SOURCES).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const source = parsed.data.source ?? 'manual'
  let timezone: string
  if (source === 'auto') {
    const [row] = await db.select({ outlookTimezone: users.outlookTimezone }).from(users).where(eq(users.id, req.user!.id)).limit(1)
    if (!row?.outlookTimezone) { res.status(409).json({ data: null, error: 'errors.timezone.outlook_unknown', meta: {} }); return }
    timezone = row.outlookTimezone
  } else {
    if (!parsed.data.timezone || !isKnownTimeZone(parsed.data.timezone)) {
      res.status(400).json({ data: null, error: 'errors.timezone.invalid', meta: {} }); return
    }
    timezone = parsed.data.timezone
  }
  await db.update(users).set({ timezone, timezoneSource: source, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { timezone, source }, error: null, meta: {} })
})

// GET /auth/me/non-activity-keywords — the caller's personal Non-Activity
// subject keywords (v1.243.0). Separate from /auth/me so the Settings section
// can reload just this after a save without refetching the whole session.
profileAuthRoutes.get('/me/non-activity-keywords', requireAuth, async (req, res) => {
  const [row] = await db
    .select({ keywords: users.nonActivityKeywords })
    .from(users)
    .where(eq(users.id, req.user!.id))
    .limit(1)
  res.json({ data: { keywords: row?.keywords ?? [] }, error: null, meta: {} })
})

// PATCH /auth/me/non-activity-keywords  { keywords: string[] }
// Personal counterpart to a team keyword rule with action='mark_non_activity'.
// Applies to the caller's own ImpactIQ only — there is deliberately no
// admin-on-behalf variant, because nobody else should be deciding which of
// someone's meetings don't count as work.
profileAuthRoutes.patch('/me/non-activity-keywords', requireAuth, async (req, res) => {
  const schema = z.object({ keywords: z.array(z.string()).max(200) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Trim, drop blanks, cap length, and de-dupe case-insensitively. The matcher
  // is a case-insensitive substring test, so "1:1" and "1:1 " are the same
  // rule — storing both would just show the user a duplicate chip forever.
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const raw of parsed.data.keywords) {
    const k = raw.trim().slice(0, 200)
    if (!k) continue
    const lower = k.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    cleaned.push(k)
  }
  await db
    .update(users)
    .set({ nonActivityKeywords: cleaned, updatedAt: new Date() })
    .where(eq(users.id, req.user!.id))
  res.json({ data: { keywords: cleaned }, error: null, meta: {} })
})

// PATCH /auth/me/outlook-writeback — per-user opt-in to write logged
// activities back to the user's own Outlook calendar (v1.156.0). Off by
// default; the client shows a notice + reconnect hint when enabling.
profileAuthRoutes.patch('/me/outlook-writeback', requireAuth, async (req, res) => {
  const schema = z.object({ enabled: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db.update(users).set({ outlookWritebackEnabled: parsed.data.enabled, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { enabled: parsed.data.enabled }, error: null, meta: {} })
})

// PATCH /auth/me/private-meetings-as-non-activity (v1.262.0) — "Private
// meetings → Non-Activity" in My Settings. Default true (see the users
// table default) so a private/confidential Outlook meeting is auto-marked
// Non-Activity out of the box; this route lets the contributor turn that
// off. See CLAUDE.md §7 Private Meetings / matchPrivateSensitivity in
// services/ai/classify.ts.
profileAuthRoutes.patch('/me/private-meetings-as-non-activity', requireAuth, async (req, res) => {
  const schema = z.object({ enabled: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db.update(users).set({ privateMeetingsAsNonActivity: parsed.data.enabled, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { enabled: parsed.data.enabled }, error: null, meta: {} })
})

// PATCH /auth/me/default-team (v1.263.0) — My Settings → Work & Notifications
// self-service default team, shown only when the user belongs to more than
// one team. Restricted to teams the caller is actually a member of — this is
// still the same users.defaultTeamId column Flight Deck / Themes / cost-rate
// resolution already read, just now user-settable in addition to admin-set.
// Changing it clears defaultSubteamId, since a subteam only makes sense
// under the team it belongs to.
profileAuthRoutes.patch('/me/default-team', requireAuth, async (req, res) => {
  const schema = z.object({ teamId: z.string().uuid().nullable() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  if (parsed.data.teamId) {
    const [m] = await db.select({ teamId: teamMembers.teamId }).from(teamMembers)
      .where(and(eq(teamMembers.userId, req.user!.id), eq(teamMembers.teamId, parsed.data.teamId))).limit(1)
    if (!m) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  }
  await db.update(users).set({ defaultTeamId: parsed.data.teamId, defaultSubteamId: null, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { teamId: parsed.data.teamId }, error: null, meta: {} })
})

// PATCH /auth/me/default-subteam (v1.263.0) — seeds the Scheduling page's
// subteam filter. Restricted to a subteam the caller belongs to under their
// OWN defaultTeamId (a subteam under some other team would never resolve to
// anything meaningful on Scheduling, which always scopes by the active team).
profileAuthRoutes.patch('/me/default-subteam', requireAuth, async (req, res) => {
  const schema = z.object({ subteamId: z.string().uuid().nullable() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  if (parsed.data.subteamId) {
    const { subteams, subteamUsers } = await import('../../../../drizzle/schema.js')
    const [caller] = await db.select({ defaultTeamId: users.defaultTeamId }).from(users).where(eq(users.id, req.user!.id)).limit(1)
    const [row] = await db.select({ id: subteams.id })
      .from(subteams)
      .innerJoin(subteamUsers, eq(subteamUsers.subteamId, subteams.id))
      .where(and(
        eq(subteams.id, parsed.data.subteamId),
        eq(subteamUsers.userId, req.user!.id),
        ...(caller?.defaultTeamId ? [eq(subteams.teamId, caller.defaultTeamId)] : []),
      )).limit(1)
    if (!row) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  }
  await db.update(users).set({ defaultSubteamId: parsed.data.subteamId, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { subteamId: parsed.data.subteamId }, error: null, meta: {} })
})

// PATCH /auth/me/work-week — user-initiated work-week edit. Instead of writing
// directly to `users`, we enqueue a `work_week_change_requests` row that an
// app admin must approve. If the incoming values match the current effective
// row this is a no-op.
profileAuthRoutes.patch('/me/work-week', requireAuth, async (req, res) => {
  const schema = z.object({
    workerType: z.enum(['full_time','part_time','contractor']).optional(),
    workDays: z.number().int().min(0).max(127),
    workDayStartHour: z.number().int().min(0).max(23),
    workDayEndHour: z.number().int().min(1).max(24),
    workHoursPerDay: z.record(
      z.enum(['mon','tue','wed','thu','fri','sat','sun']),
      z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }),
    ).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  const { validateWorkWeek, workWeekEquals } = await import('../../../shared/schemas/workWeek.js')
  const { workWeekChangeRequests } = await import('../../../../drizzle/schema.js')

  const [current] = await db.select({
    workerType: users.workerType,
    workDays: users.workDays,
    workDayStartHour: users.workDayStartHour,
    workDayEndHour: users.workDayEndHour,
    workHoursPerDay: users.workHoursPerDay,
  }).from(users).where(eq(users.id, req.user!.id)).limit(1)
  if (!current) { res.status(404).json({ data: null, error: 'errors.user_not_found', meta: {} }); return }

  const after = {
    workerType: (parsed.data.workerType ?? (current.workerType as 'full_time'|'part_time'|'contractor')),
    workDays: parsed.data.workDays,
    workDayStartHour: parsed.data.workDayStartHour,
    workDayEndHour: parsed.data.workDayEndHour,
    workHoursPerDay: parsed.data.workHoursPerDay ?? null,
  } as const
  const err = validateWorkWeek(after)
  if (err) { res.status(400).json({ data: null, error: err, meta: {} }); return }

  const before = {
    workerType: current.workerType as 'full_time'|'part_time'|'contractor',
    workDays: current.workDays,
    workDayStartHour: current.workDayStartHour,
    workDayEndHour: current.workDayEndHour,
    workHoursPerDay: (current.workHoursPerDay as typeof after.workHoursPerDay) ?? null,
  }
  if (workWeekEquals(before, after)) {
    res.json({ data: { pending: false, requestId: null }, error: null, meta: {} })
    return
  }

  // Cancel any prior pending request from this user so the queue holds at
  // most one active request per user — admins only ever see the latest ask.
  await db.update(workWeekChangeRequests)
    .set({ status: 'rejected', resolvedAt: new Date(), resolvedBy: req.user!.id, notes: 'superseded' })
    .where(and(eq(workWeekChangeRequests.userId, req.user!.id), eq(workWeekChangeRequests.status, 'pending')))

  const [created] = await db.insert(workWeekChangeRequests).values({
    userId: req.user!.id,
    requestedBy: req.user!.id,
    beforeSnapshot: before,
    afterSnapshot: after,
  }).returning({ id: workWeekChangeRequests.id })
  res.json({ data: { pending: true, requestId: created?.id ?? null }, error: null, meta: {} })
})

// GET /auth/me/outlook-working-hours — read the caller's Outlook mailbox
// working hours (days + start/end). Returns values the client pre-fills into
// the Work Week form; it does NOT write them (the user still Saves through the
// admin-approval flow). 409 when Outlook isn't connected, 422 when Graph
// doesn't return workingHours.
profileAuthRoutes.get('/me/outlook-working-hours', requireAuth, async (req, res) => {
  const { getMicrosoftAccessToken } = await import('../../services/outlook/client.js')
  const token = await getMicrosoftAccessToken(req.user!.id)
  if (!token) { res.status(409).json({ data: null, error: 'errors.outlook.not_connected', meta: {} }); return }
  let workingHours: { daysOfWeek?: string[]; startTime?: string; endTime?: string } | undefined
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me/mailboxSettings', { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) { res.status(422).json({ data: null, error: 'errors.outlook.no_working_hours', meta: {} }); return }
    const mb = await r.json() as { workingHours?: typeof workingHours }
    workingHours = mb.workingHours
  } catch {
    res.status(422).json({ data: null, error: 'errors.outlook.no_working_hours', meta: {} }); return
  }
  if (!workingHours || !Array.isArray(workingHours.daysOfWeek) || workingHours.daysOfWeek.length === 0) {
    res.status(422).json({ data: null, error: 'errors.outlook.no_working_hours', meta: {} }); return
  }
  // Graph day names → workDays bitmask (mon=1..sun=64, per shared/schemas/workWeek).
  const DAY_BIT: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 4, thursday: 8, friday: 16, saturday: 32, sunday: 64 }
  let workDays = 0
  for (const d of workingHours.daysOfWeek) { workDays |= DAY_BIT[String(d).toLowerCase()] ?? 0 }
  // "HH:mm:ss.fffffff" → integer hour. Start floors, end rounds up so a 17:30
  // finish still covers the 17:00 hour block.
  const parseHour = (s: string | undefined, roundUp: boolean): number | null => {
    if (!s) return null
    const m = /^(\d{1,2}):(\d{2})/.exec(s)
    if (!m) return null
    const h = Number(m[1]); const min = Number(m[2])
    return roundUp ? Math.min(24, h + (min > 0 ? 1 : 0)) : h
  }
  const startHour = parseHour(workingHours.startTime, false)
  const endHour = parseHour(workingHours.endTime, true)
  if (workDays === 0 || startHour === null || endHour === null || endHour <= startHour) {
    res.status(422).json({ data: null, error: 'errors.outlook.no_working_hours', meta: {} }); return
  }
  res.json({ data: { workDays, workDayStartHour: startHour, workDayEndHour: endHour }, error: null, meta: {} })
})

// GET /auth/me/work-week-request — the caller's most recent pending request.
profileAuthRoutes.get('/me/work-week-request', requireAuth, async (req, res) => {
  const { desc: descOrd } = await import('drizzle-orm')
  const { workWeekChangeRequests } = await import('../../../../drizzle/schema.js')
  const [row] = await db.select().from(workWeekChangeRequests)
    .where(and(eq(workWeekChangeRequests.userId, req.user!.id), eq(workWeekChangeRequests.status, 'pending')))
    .orderBy(descOrd(workWeekChangeRequests.createdAt))
    .limit(1)
  res.json({ data: row ?? null, error: null, meta: {} })
})

// DELETE /auth/me/work-week-request/:id — cancel my own pending request.
profileAuthRoutes.delete('/me/work-week-request/:id', requireAuth, async (req, res) => {
  const { workWeekChangeRequests } = await import('../../../../drizzle/schema.js')
  const id = String(req.params['id'])
  const [row] = await db.select().from(workWeekChangeRequests).where(eq(workWeekChangeRequests.id, id)).limit(1)
  if (!row || row.userId !== req.user!.id) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (row.status !== 'pending') { res.status(400).json({ data: null, error: 'errors.workweek.not_pending', meta: {} }); return }
  await db.update(workWeekChangeRequests).set({ status: 'rejected', resolvedAt: new Date(), resolvedBy: req.user!.id, notes: 'cancelled_by_user' })
    .where(eq(workWeekChangeRequests.id, id))
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// GET /auth/holiday-calendars — public list of active calendars so users and
// admins can populate pickers without needing the /api/admin routes.
profileAuthRoutes.get('/holiday-calendars', requireAuth, async (_req, res) => {
  const rows = await db.select().from(holidayCalendars).where(eq(holidayCalendars.isActive, true)).orderBy(holidayCalendars.name)
  res.json({ data: rows, error: null, meta: {} })
})

// GET /auth/me/holiday-calendars — which calendars the caller is on.
// Returns { picked, inherited } where `picked` is the user's own selections
// (source of truth if non-empty) and `inherited` is the union of calendars
// assigned to each of their teams. The Settings card shows the picked set
// as editable chips and the team-inherited set as read-only "from <team>"
// chips so users understand where their holidays are coming from.
// v1.75.0: user picks a display currency in My Settings. Get + patch.
profileAuthRoutes.get('/me/preferred-currency', requireAuth, async (req, res) => {
  const [u] = await db.select({ code: users.preferredCurrency }).from(users).where(eq(users.id, req.user!.id)).limit(1)
  res.json({ data: { code: u?.code ?? null }, error: null, meta: {} })
})
profileAuthRoutes.put('/me/preferred-currency', requireAuth, async (req, res) => {
  const parsed = z.object({ code: z.string().length(3).nullable() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db.update(users).set({ preferredCurrency: parsed.data.code }).where(eq(users.id, req.user!.id))
  res.json({ data: { code: parsed.data.code }, error: null, meta: {} })
})

// v1.75.0: public FX-rates read used by user-facing revenue pills. The
// admin refresh endpoint stays app-admin-only; this is just the read.
profileAuthRoutes.get('/fx-rates', requireAuth, async (_req, res) => {
  const { listLatestRates } = await import('../../services/fx/rates.js')
  const rows = await listLatestRates()
  res.json({ data: rows, error: null, meta: {} })
})

profileAuthRoutes.get('/me/holiday-calendars', requireAuth, async (req, res) => {
  const userId = req.user!.id
  const picked = await db
    .select({ calendarId: userHolidayCalendars.calendarId })
    .from(userHolidayCalendars)
    .where(eq(userHolidayCalendars.userId, userId))
  const myTeams = await db
    .select({ teamId: teamMembers.teamId, teamName: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
  const teamCalRows = myTeams.length === 0 ? [] : await db
    .select({ teamId: teamHolidayCalendars.teamId, calendarId: teamHolidayCalendars.calendarId })
    .from(teamHolidayCalendars)
    .where(inArray(teamHolidayCalendars.teamId, myTeams.map((t) => t.teamId)))
  const inheritedByTeam = new Map<string, string[]>()
  for (const r of teamCalRows) {
    const arr = inheritedByTeam.get(r.teamId) ?? []
    arr.push(r.calendarId)
    inheritedByTeam.set(r.teamId, arr)
  }
  const inherited = myTeams
    .map((t) => ({ teamId: t.teamId, teamName: t.teamName, calendarIds: inheritedByTeam.get(t.teamId) ?? [] }))
    .filter((r) => r.calendarIds.length > 0)
  res.json({
    data: {
      picked: picked.map((r) => r.calendarId),
      inherited,
    },
    error: null,
    meta: {},
  })
})

// GET /auth/me/holidays?start=YYYY-MM-DD&end=YYYY-MM-DD — resolved dates for
// the caller's assigned calendars, used by the client to exclude those days
// from capacity math and mark them on the calendar column.
profileAuthRoutes.get('/me/holidays', requireAuth, async (req, res) => {
  const startStr = req.query['start'] as string | undefined
  const endStr = req.query['end'] as string | undefined
  if (!startStr || !endStr) { res.status(400).json({ data: null, error: 'errors.validation.date_range_required', meta: {} }); return }
  // Resolution: user's picks take precedence; if the user has none, fall back
  // to the union of holiday calendars assigned to any of their teams.
  const userAssigned = await db.select({ calendarId: userHolidayCalendars.calendarId })
    .from(userHolidayCalendars).where(eq(userHolidayCalendars.userId, req.user!.id))
  let calIds: string[] = userAssigned.map((a) => a.calendarId)
  if (calIds.length === 0) {
    const myTeams = await db.select({ teamId: teamMembers.teamId })
      .from(teamMembers).where(eq(teamMembers.userId, req.user!.id))
    if (myTeams.length > 0) {
      const teamRows = await db.select({ calendarId: teamHolidayCalendars.calendarId })
        .from(teamHolidayCalendars)
        .where(inArray(teamHolidayCalendars.teamId, myTeams.map((t) => t.teamId)))
      calIds = Array.from(new Set(teamRows.map((r) => r.calendarId)))
    }
  }
  if (calIds.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
  const { holidayDates } = await import('../../../../drizzle/schema.js')
  const rows = await db.select({ date: holidayDates.date, name: holidayDates.name })
    .from(holidayDates)
    .where(and(
      inArray(holidayDates.calendarId, calIds),
      gte(holidayDates.date, startStr),
      lte(holidayDates.date, endStr),
    ))
  res.json({ data: rows, error: null, meta: {} })
})

// PUT /auth/me/holiday-calendars — replace the caller's assigned set (max 3).
profileAuthRoutes.put('/me/holiday-calendars', requireAuth, async (req, res) => {
  const schema = z.object({ calendarIds: z.array(z.string().uuid()).max(3) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db.delete(userHolidayCalendars).where(eq(userHolidayCalendars.userId, req.user!.id))
  if (parsed.data.calendarIds.length > 0) {
    await db.insert(userHolidayCalendars).values(parsed.data.calendarIds.map((cid) => ({ userId: req.user!.id, calendarId: cid })))
  }
  res.json({ data: { calendarIds: parsed.data.calendarIds }, error: null, meta: {} })
})

// --- Personal PTO days ---
// GET /auth/me/pto?start=&end=
profileAuthRoutes.get('/me/pto', requireAuth, async (req, res) => {
  const startStr = req.query['start'] as string | undefined
  const endStr = req.query['end'] as string | undefined
  if (!startStr || !endStr) { res.status(400).json({ data: null, error: 'errors.validation.date_range_required', meta: {} }); return }
  const rows = await db.select({ date: userPtoDays.date, note: userPtoDays.note })
    .from(userPtoDays)
    .where(and(eq(userPtoDays.userId, req.user!.id), gte(userPtoDays.date, startStr), lte(userPtoDays.date, endStr)))
  res.json({ data: rows, error: null, meta: {} })
})

// POST /auth/me/pto { date: 'YYYY-MM-DD', note? }
profileAuthRoutes.post('/me/pto', requireAuth, async (req, res) => {
  const schema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(200).optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db.insert(userPtoDays).values({ userId: req.user!.id, date: parsed.data.date, note: parsed.data.note ?? null }).onConflictDoNothing()
  res.json({ data: parsed.data, error: null, meta: {} })
})

// DELETE /auth/me/pto/:date
profileAuthRoutes.delete('/me/pto/:date', requireAuth, async (req, res) => {
  const { date } = req.params as { date: string }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ data: null, error: 'errors.validation.date_range_required', meta: {} }); return }
  await db.delete(userPtoDays).where(and(eq(userPtoDays.userId, req.user!.id), eq(userPtoDays.date, date)))
  res.json({ data: { date }, error: null, meta: {} })
})
