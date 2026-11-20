import { Router } from 'express'
import { db } from '../../db/index.js'
import { activities, teamActivityTypes, users, teamMembers, sfEventTypeConfig } from '../../../../drizzle/schema.js'
import { and, eq, gte, lte, sql, desc, inArray } from 'drizzle-orm'
import { resolveCapacityBatch } from '../../services/capacity/resolver.js'
import { realMeetingLoadHoursByUserWeek } from '../../services/capacity/meetingLoad.js'
import { requireDashboardAccess } from '../../middleware/rbac.js'
import { startOfWeek, addWeeks, subWeeks, endOfWeek } from 'date-fns'

import {
  excludedHoursByUserWeek,
  nonActivityHoursByUserWeek,
  anyTeamHasRealMeetingLoadEnabled,
  resolveTeamScope,
  assertUserInTeams,
  rangeFor,
  parseDateBasis,
  windowFor,
  dateWindow,
  parseWeekShift,
  parseProductIds,
  parseSubtypeIds,
  subtypeFilterCond,
  parseMemberIds,
  productFilterCond,
  getTeamCapacityTotal,
} from './shared.js'

export const capacityDashRoutes = Router()

// GET /api/dashboards/heatmap?teamId=&weeks=8
capacityDashRoutes.get('/heatmap', requireDashboardAccess('heatmap'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])

  if (teamIds.length === 0) {
    res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} })
    return
  }

  // Honor an explicit start/end (custom range or FY/FQ pick) for both the
  // data filter and the week columns; otherwise fall back to weeksBack.
  const { rangeStart, rangeEnd, weeks } = windowFor(req, weeksBack, weekShift)
  const productCond = productFilterCond(productIds)

  const rows = await db
    .select({
      userId: activities.userId,
      displayName: users.displayName,
      weekStart: sql<string>`date_trunc('week', ${activities.startDatetime})`.as('week_start'),
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
    })
    .from(activities)
    .innerJoin(users, eq(activities.userId, users.id))
    .where(
      and(
        inArray(activities.teamId, teamIds),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        ...dateWindow(dateBasis, rangeStart, rangeEnd),
        ...(productCond ? [productCond] : []),
        ...(userId ? [eq(activities.userId, userId)] : []),
        ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
      ),
    )
    .groupBy(activities.userId, users.displayName, sql`date_trunc('week', ${activities.startDatetime})`)
    .orderBy(users.displayName, sql`date_trunc('week', ${activities.startDatetime})`)

  // Anchor for capacity resolution: the last week in the rendered window.
  const anchor = weeks.length > 0 ? new Date(`${weeks[weeks.length - 1]}T00:00:00`) : subWeeks(new Date(), -weekShift)

  // Capacity targets — resolved per (user, team) as of the anchor week.
  // Heatmap surfaces one capacity number per user, so we pick their
  // primary team by taking whichever team appears in the rows we
  // already loaded; this matches the previous behaviour where a user
  // could only be in one group and that group belonged to one team.
  const heatmapAsOf = startOfWeek(anchor, { weekStartsOn: 1 })
  const heatmapUserTeam = new Map<string, string>()
  for (const r of rows) {
    if (!heatmapUserTeam.has(r.userId)) heatmapUserTeam.set(r.userId, teamIds[0]!)
  }
  const heatmapPairs = Array.from(heatmapUserTeam.entries()).map(([userId, teamId]) => ({ userId, teamId, asOf: heatmapAsOf }))
  const heatmapResolved = await resolveCapacityBatch(heatmapPairs)
  const capacityByUser: Record<string, number> = {}
  for (const [userId, teamId] of heatmapUserTeam.entries()) {
    const r = heatmapResolved.get(`${userId}::${teamId}`)
    capacityByUser[userId] = r?.hours ?? 30
  }
  // Per-user, per-week exclusions (PTO + assigned holidays) so the client
  // can dim/reduce the capacity target for weeks where the contributor is
  // partially or fully out.
  const userIdsInRange = Array.from(new Set(rows.map((r) => r.userId)))
  const { total: excludedByUserWeek, pto: ptoByUserWeek } = await excludedHoursByUserWeek(userIdsInRange, rangeStart, rangeEnd)

  // Non-activity (uncaptured Outlook meeting) hours per user/week, shown as a
  // dark-grey split in each cell for the contributors already listed.
  const includeNonActivities = req.query['nonActivities'] !== '0'
  const nonActivityByUserWeek = includeNonActivities
    ? await nonActivityHoursByUserWeek(userIdsInRange, rangeStart, rangeEnd)
    : {}
  // v1.225.0: corrected "real meeting load" figure — measures meeting load,
  // not availability; see CLAUDE.md §12. Admin opt-in per capacity group, so
  // most requests skip the extra query entirely.
  const meetingLoadEnabled = await anyTeamHasRealMeetingLoadEnabled(teamIds)
  const meetingLoadByUserWeek = meetingLoadEnabled
    ? await realMeetingLoadHoursByUserWeek(userIdsInRange, rangeStart, rangeEnd)
    : undefined

  // totalHours is a raw sum(...) aggregate — the `postgres` driver returns a
  // numeric column as a string, and sql<string> is a compile-time-only
  // TypeScript annotation, not a runtime cast. Coerce before it leaves the
  // server, matching /this-week-capacity's convention (Number(r.totalHours)).
  const heatmapRows = rows.map((r) => ({ ...r, totalHours: Number(r.totalHours ?? 0) }))

  res.json({
    data: { rows: heatmapRows, weeks, capacityByUser, excludedByUserWeek, ptoByUserWeek, nonActivityByUserWeek, meetingLoadByUserWeek, meetingLoadEnabled },
    error: null,
    meta: { rangeStart: rangeStart.toISOString(), rangeEnd: rangeEnd.toISOString() },
  })
})

// GET /api/dashboards/breakdown?teamId=&weeks=4&userId=
capacityDashRoutes.get('/breakdown', requireDashboardAccess('breakdown'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  const subtypeIds = parseSubtypeIds(req.query['subtypeIds'])

  if (teamIds.length === 0) {
    res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} })
    return
  }
  if (userId && !(await assertUserInTeams(userId, teamIds, req.user?.id))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }

  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)

  const conditions = [
    inArray(activities.teamId, teamIds),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    ...dateWindow(dateBasis, rangeStart, rangeEnd),
  ]
  if (userId) conditions.push(eq(activities.userId, userId))
  if (memberIds.length > 0) conditions.push(inArray(activities.userId, memberIds))
  const productCond = productFilterCond(productIds)
  if (productCond) conditions.push(productCond)
  const subtypeCond = subtypeFilterCond(subtypeIds)
  if (subtypeCond) conditions.push(subtypeCond)

  const rows = await db
    .select({
      userId: activities.userId,
      displayName: users.displayName,
      activityTypeName: teamActivityTypes.name,
      activityTypeColor: teamActivityTypes.color,
      activityTypeIcon: teamActivityTypes.icon,
      // v1.265.0: Subtype dimension (PRD §7) — additional grouping level
      // under each activity type. Null for activities with no Subtype
      // picked (most teams, since Subtypes are opt-in per CLAUDE.md §7), in
      // which case the client simply doesn't render a subtype breakdown for
      // that type — see ActivityBreakdown.tsx.
      subtypeName: activities.subtypeName,
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
      activityCount: sql<number>`count(*)`.as('activity_count'),
    })
    .from(activities)
    .innerJoin(users, eq(activities.userId, users.id))
    .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(and(...conditions))
    .groupBy(activities.userId, users.displayName, teamActivityTypes.name, teamActivityTypes.color, teamActivityTypes.icon, activities.subtypeName)
    .orderBy(users.displayName, teamActivityTypes.name)

  res.json({ data: rows, error: null, meta: {} })
})

// GET /api/dashboards/capacity-trend?teamId=&weeks=8
capacityDashRoutes.get('/capacity-trend', requireDashboardAccess('capacityTrend'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }

  const { rangeStart, rangeEnd, weeks } = windowFor(req, weeksBack, weekShift)
  const productCond = productFilterCond(productIds)
  const rows = await db
    .select({
      weekStart: sql<string>`date_trunc('week', ${activities.startDatetime})`.as('week_start'),
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
    })
    .from(activities)
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))
    .groupBy(sql`date_trunc('week', ${activities.startDatetime})`)
    .orderBy(sql`date_trunc('week', ${activities.startDatetime})`)

  // When narrowed to specific people, capacity/PTO/non-activity math below
  // should reflect just that subset — not the whole team's roster.
  const memberFilterActive = !!userId || memberIds.length > 0
  const selectedIds = new Set(userId ? [userId, ...memberIds] : memberIds)
  const teamCapacity = await getTeamCapacityTotal(teamIds, new Date(), memberFilterActive ? Array.from(selectedIds) : undefined)

  // Team roster — used for both the non-activity split and the per-week
  // PTO/holiday capacity reduction below.
  const roster = await db.select({ userId: teamMembers.userId }).from(teamMembers).where(inArray(teamMembers.teamId, teamIds))
  const rosterIds = Array.from(new Set(roster.map((r) => r.userId).filter((id) => !memberFilterActive || selectedIds.has(id))))

  // Per-week team-wide non-activity (uncaptured meeting) hours — the black
  // portion of each trend bar (logged = blue, non-activity = black).
  const includeNonActivities = req.query['nonActivities'] !== '0'
  const nonActivityByWeek: Record<string, number> = {}
  if (includeNonActivities) {
    const perUser = await nonActivityHoursByUserWeek(rosterIds, rangeStart, rangeEnd)
    for (const weekMap of Object.values(perUser)) {
      for (const [wk, hrs] of Object.entries(weekMap)) {
        nonActivityByWeek[wk] = (nonActivityByWeek[wk] ?? 0) + hrs
      }
    }
  }

  // v1.225.0: corrected "real meeting load" figure, team-wide per week.
  // Admin opt-in per capacity group; see CLAUDE.md §12.
  const meetingLoadEnabled = await anyTeamHasRealMeetingLoadEnabled(teamIds)
  let meetingLoadByWeek: Record<string, number> | undefined
  if (meetingLoadEnabled) {
    meetingLoadByWeek = {}
    const perUserLoad = await realMeetingLoadHoursByUserWeek(rosterIds, rangeStart, rangeEnd)
    for (const weekMap of Object.values(perUserLoad)) {
      for (const [wk, hrs] of Object.entries(weekMap)) {
        meetingLoadByWeek[wk] = (meetingLoadByWeek[wk] ?? 0) + hrs
      }
    }
  }

  // Per-week team PTO + holiday hours, so the capacity line reflects the
  // team's actually-available hours that week (e.g. a company-holiday week
  // is not held to the full 160h/wk target).
  const { total: excludedByUser } = await excludedHoursByUserWeek(rosterIds, rangeStart, rangeEnd)
  const excludedByWeek: Record<string, number> = {}
  for (const weekMap of Object.values(excludedByUser)) {
    for (const [wk, hrs] of Object.entries(weekMap)) {
      excludedByWeek[wk] = (excludedByWeek[wk] ?? 0) + hrs
    }
  }
  const capacityByWeek: Record<string, number> = {}
  for (const wk of weeks) capacityByWeek[wk] = Math.max(0, teamCapacity - (excludedByWeek[wk] ?? 0))

  // Same raw-string-aggregate coercion as /heatmap above.
  const trendRows = rows.map((r) => ({ ...r, totalHours: Number(r.totalHours ?? 0) }))

  res.json({ data: { rows: trendRows, weeks, teamCapacityPerWeek: teamCapacity, capacityByWeek, excludedByWeek, nonActivityByWeek, meetingLoadByWeek, meetingLoadEnabled }, error: null, meta: {} })
})

// GET /api/dashboards/this-week-capacity?teamId=
capacityDashRoutes.get('/this-week-capacity', requireDashboardAccess('thisWeek'), async (req, res) => {
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  // Optional weekOffset: -N moves the query window to N weeks ago. Used by
  // the client's Compare toggle to pull MoM/QoQ/YoY prior-period totals.
  const weekOffset = Number(req.query['weekOffset'] ?? 0)
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  const referenceDate = addWeeks(new Date(), weekOffset)
  const weekStart = startOfWeek(referenceDate, { weekStartsOn: 1 })
  const weekEnd = endOfWeek(referenceDate, { weekStartsOn: 1 })

  let memberRows = await db
    .select({ userId: teamMembers.userId, displayName: users.displayName })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(inArray(teamMembers.teamId, teamIds))
    .orderBy(users.displayName)
  // This dashboard is inherently per-person already — narrowing to specific
  // people just trims the roster it renders, same list shape either way.
  if (userId || memberIds.length > 0) {
    const allowed = new Set(userId ? [userId, ...memberIds] : memberIds)
    memberRows = memberRows.filter((m) => allowed.has(m.userId))
  }

  const hoursRows = await db
    .select({
      userId: activities.userId,
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
    })
    .from(activities)
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      gte(activities.startDatetime, weekStart),
      lte(activities.startDatetime, weekEnd),
      ...(productCond ? [productCond] : []),
    ))
    .groupBy(activities.userId)

  const hoursByUser = Object.fromEntries(hoursRows.map((r) => [r.userId, Number(r.totalHours ?? 0)]))

  // Resolve each member's target as of the week's start. `memberRows`
  // carries the team the caller queried; each (user, team) pair goes to
  // the resolver.
  const memberTeamRows = await db
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(inArray(teamMembers.teamId, teamIds))
  const primaryTeamByUser = new Map<string, string>()
  for (const r of memberTeamRows) if (!primaryTeamByUser.has(r.userId)) primaryTeamByUser.set(r.userId, r.teamId)
  const targetLookups = memberRows
    .map((m) => ({ userId: m.userId, teamId: primaryTeamByUser.get(m.userId) ?? teamIds[0]!, asOf: weekStart }))
  const resolved = await resolveCapacityBatch(targetLookups)
  const targetByUser: Record<string, number> = {}
  for (const l of targetLookups) targetByUser[l.userId] = resolved.get(`${l.userId}::${l.teamId}`)?.hours ?? 30

  const { total: excluded, pto } = await excludedHoursByUserWeek(memberRows.map((m) => m.userId), weekStart, weekEnd)
  const includeNonActivities = req.query['nonActivities'] !== '0'
  const nonActivity = includeNonActivities
    ? await nonActivityHoursByUserWeek(memberRows.map((m) => m.userId), weekStart, weekEnd)
    : {}
  // v1.225.0: corrected "real meeting load" per user this week. Admin opt-in
  // per capacity group; see CLAUDE.md §12.
  const meetingLoadEnabled = await anyTeamHasRealMeetingLoadEnabled(teamIds)
  const meetingLoad = meetingLoadEnabled
    ? await realMeetingLoadHoursByUserWeek(memberRows.map((m) => m.userId), weekStart, weekEnd)
    : {}
  const weekIso = weekStart.toISOString().slice(0, 10)
  const rows = memberRows.map((m) => ({
    userId: m.userId,
    displayName: m.displayName,
    hours: hoursByUser[m.userId] ?? 0,
    target: Math.max(0, (targetByUser[m.userId] ?? 30) - (excluded[m.userId]?.[weekIso] ?? 0)),
    excludedHours: excluded[m.userId]?.[weekIso] ?? 0,
    // PTO-only slice of excludedHours, so the client can show "X h PTO" and
    // paint a PTO segment on the bar.
    ptoHours: pto[m.userId]?.[weekIso] ?? 0,
    // Holiday portion = excluded − PTO, so a company holiday is shown
    // distinctly from personal time off.
    holidayHours: Math.max(0, (excluded[m.userId]?.[weekIso] ?? 0) - (pto[m.userId]?.[weekIso] ?? 0)),
    // Uncaptured Outlook meeting hours this week — the dark-grey portion.
    nonActivityHours: nonActivity[m.userId]?.[weekIso] ?? 0,
    // Corrected meeting-load hours (excludes declined/cancelled/free-marked
    // events); undefined when the team hasn't opted in.
    meetingLoadHours: meetingLoadEnabled ? (meetingLoad[m.userId]?.[weekIso] ?? 0) : undefined,
  }))
  res.json({ data: { rows, weekStart: weekStart.toISOString(), meetingLoadEnabled }, error: null, meta: {} })
})

// GET /api/dashboards/plan-vs-actual?teamId=&weeks=4
capacityDashRoutes.get('/plan-vs-actual', requireDashboardAccess('planVsActual'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)
  const productCond = productFilterCond(productIds)

  const rows = await db
    .select({
      activityTypeName: teamActivityTypes.name,
      // v1.125.0: pull the per-team typical duration alongside the
      // activity so we don't need a second lookup keyed by name.
      typicalDurationMinutes: teamActivityTypes.typicalDurationMinutes,
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
      activityCount: sql<number>`count(*)`.as('activity_count'),
    })
    .from(activities)
    .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))
    .groupBy(teamActivityTypes.name, teamActivityTypes.typicalDurationMinutes)
    .orderBy(desc(sql`sum(${activities.effortHours})`))

  // Fallback typical durations from the SF picklist config (matched by
  // name) — kept for backwards compat with existing configurations that
  // only set the value on sf_event_type_config.
  const cfgRows = await db
    .select({ name: sfEventTypeConfig.sfPicklistValue, typicalMinutes: sfEventTypeConfig.typicalDurationMinutes })
    .from(sfEventTypeConfig)
    .where(inArray(sfEventTypeConfig.teamId, teamIds))
  const typicalByName = Object.fromEntries(cfgRows.filter((r) => r.typicalMinutes != null).map((r) => [r.name, Number(r.typicalMinutes)]))

  const data = rows.map((r) => {
    // v1.125.0: prefer the value on team_activity_types itself; fall
    // back to sf_event_type_config keyed by name.
    const typicalMinutes = (r.typicalDurationMinutes != null ? Number(r.typicalDurationMinutes) : null)
      ?? typicalByName[r.activityTypeName]
      ?? null
    const estimatedHours = typicalMinutes != null ? (typicalMinutes / 60) * Number(r.activityCount) : null
    return {
      activityTypeName: r.activityTypeName,
      actualHours: Number(r.totalHours ?? 0),
      activityCount: Number(r.activityCount),
      typicalMinutes,
      estimatedHours,
    }
  })
  res.json({ data, error: null, meta: {} })
})
