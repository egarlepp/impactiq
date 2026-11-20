import { Router } from 'express'
import { db } from '../../db/index.js'
import { activities, teamActivityTypes, teams, users, teamMembers } from '../../../../drizzle/schema.js'
import { and, eq, gte, sql, desc, inArray, or } from 'drizzle-orm'
import { requireDashboardAccess } from '../../middleware/rbac.js'
import { startOfWeek, subWeeks, format } from 'date-fns'

import {
  resolveTeamScope,
  rangeFor,
  parseDateBasis,
  windowFor,
  dateWindow,
  parseWeekShift,
  parseProductIds,
  parseMemberIds,
  productFilterCond,
} from './shared.js'

export const healthDashRoutes = Router()

// GET /api/dashboards/logging-compliance?teamId=&weeks=4
healthDashRoutes.get('/logging-compliance', requireDashboardAccess('compliance'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const { rangeStart, rangeEnd, weeks } = windowFor(req, weeksBack, weekShift)
  const productCond = productFilterCond(productIds)

  let memberRows = await db
    .select({ userId: teamMembers.userId, displayName: users.displayName })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(inArray(teamMembers.teamId, teamIds))
    .orderBy(users.displayName)
  // Narrowing to specific people changes the DENOMINATOR too — "% of the
  // selected subset who logged", not "% of the whole team".
  if (userId || memberIds.length > 0) {
    const allowed = new Set(userId ? [userId, ...memberIds] : memberIds)
    memberRows = memberRows.filter((m) => allowed.has(m.userId))
  }

  const loggedRows = await db
    .select({
      userId: activities.userId,
      weekStart: sql<string>`date_trunc('week', ${activities.startDatetime})`.as('week_start'),
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
    .groupBy(activities.userId, sql`date_trunc('week', ${activities.startDatetime})`)

  // Per-week % compliance
  const loggedByWeek: Record<string, Set<string>> = {}
  for (const r of loggedRows) {
    const key = r.weekStart.slice(0, 10)
    if (!loggedByWeek[key]) loggedByWeek[key] = new Set()
    loggedByWeek[key].add(r.userId)
  }
  const totalMembers = memberRows.length || 1
  const weekly = weeks.map((w) => ({
    weekStart: w,
    pct: Math.round(((loggedByWeek[w]?.size ?? 0) / totalMembers) * 100),
    loggedCount: loggedByWeek[w]?.size ?? 0,
    totalMembers,
  }))

  // Who hasn't logged THIS week
  const thisWeekKey = format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd')
  const loggedThisWeek = loggedByWeek[thisWeekKey] ?? new Set()
  const slackers = memberRows
    .filter((m) => !loggedThisWeek.has(m.userId))
    .map((m) => ({ userId: m.userId, displayName: m.displayName }))

  res.json({ data: { weekly, slackers }, error: null, meta: {} })
})

// GET /api/dashboards/logging-entry-heatmap?teamId=&weeks=&userId=
// Returns raw createdAt timestamps for activities in the window so the client
// can render a per-day heatmap of when people actually created entries.
healthDashRoutes.get('/logging-entry-heatmap', requireDashboardAccess('compliance'), async (req, res) => {
  const teamId = req.query['teamId'] as string
  const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const now = new Date()
  const rangeStart = startOfWeek(subWeeks(now, weeksBack - 1), { weekStartsOn: 1 })
  const productCond = productFilterCond(productIds)
  const rows = await db
    .select({ createdAt: activities.createdAt, userId: activities.userId })
    .from(activities)
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.isArchived, false),
      gte(activities.createdAt, rangeStart),
      ...(productCond ? [productCond] : []),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))
  const createdAt = rows.map((r) => new Date(r.createdAt).toISOString())
  res.json({ data: { createdAt, rangeStart: rangeStart.toISOString() }, error: null, meta: {} })
})

// GET /api/dashboards/logging-lag?teamId=&weeks=4
healthDashRoutes.get('/logging-lag', requireDashboardAccess('lag'), async (req, res) => {
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
      userId: activities.userId,
      displayName: users.displayName,
      avgLagDays: sql<string>`avg(extract(epoch from (${activities.createdAt} - ${activities.endDatetime})) / 86400)`.as('avg_lag_days'),
      activityCount: sql<number>`count(*)`.as('activity_count'),
    })
    .from(activities)
    .innerJoin(users, eq(activities.userId, users.id))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))
    .groupBy(activities.userId, users.displayName)
    .orderBy(desc(sql`avg(extract(epoch from (${activities.createdAt} - ${activities.endDatetime})) / 86400)`))

  res.json({
    data: rows.map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      avgLagDays: Number(r.avgLagDays ?? 0),
      activityCount: Number(r.activityCount),
    })),
    error: null,
    meta: {},
  })
})

// GET /api/dashboards/sf-disconnected?teamId=&userIds=
// v1.344.0: table dashboard listing every submitted activity whose linked
// Salesforce What/Who/Related record has since been deleted (CLAUDE.md §7).
// Reads ONLY the local crm_*_deleted flags — batch-computed nightly by
// detect_disconnected_links.ts (and self-healed live by the drawer's own
// check) — so this loads fast and works for every viewer regardless of
// their own SF connection. Deliberately no date-range filter: a broken
// link is either broken right now or it isn't, independent of when the
// activity happened — startDatetime is still returned as a column for
// context/sort, just not filtered on.
healthDashRoutes.get('/sf-disconnected', requireDashboardAccess('sfDisconnected'), async (req, res) => {
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const memberIds = parseMemberIds(req.query['userIds'])
  const userId = req.query['userId'] as string | undefined
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }

  const rows = await db
    .select({
      id: activities.id,
      title: activities.title,
      startDatetime: activities.startDatetime,
      ownerId: activities.userId,
      ownerName: users.displayName,
      teamId: activities.teamId,
      teamName: teams.name,
      subtypeName: activities.subtypeName,
      crmWhatId: activities.crmWhatId,
      crmWhatType: activities.crmWhatType,
      crmWhatName: activities.crmWhatName,
      crmWhoId: activities.crmWhoId,
      crmWhoType: activities.crmWhoType,
      crmWhoName: activities.crmWhoName,
      crmRelatedId: activities.crmRelatedId,
      crmRelatedType: activities.crmRelatedType,
      crmRelatedName: activities.crmRelatedName,
      crmWhatDeleted: activities.crmWhatDeleted,
      crmWhoDeleted: activities.crmWhoDeleted,
      crmRelatedDeleted: activities.crmRelatedDeleted,
      crmDisconnectCheckedAt: activities.crmDisconnectCheckedAt,
    })
    .from(activities)
    .innerJoin(users, eq(activities.userId, users.id))
    .innerJoin(teams, eq(activities.teamId, teams.id))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'), // CLAUDE.md §21: never draft on a leader dashboard
      eq(activities.isArchived, false),
      or(eq(activities.crmWhatDeleted, true), eq(activities.crmWhoDeleted, true), eq(activities.crmRelatedDeleted, true)),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))
    .orderBy(desc(activities.startDatetime))

  const data = rows.map((r) => {
    const brokenLinks: Array<{ linkType: 'What' | 'Who' | 'Related'; objectType: string | null; lastKnownName: string | null; lastKnownId: string | null }> = []
    if (r.crmWhatDeleted) brokenLinks.push({ linkType: 'What', objectType: r.crmWhatType, lastKnownName: r.crmWhatName, lastKnownId: r.crmWhatId })
    if (r.crmWhoDeleted) brokenLinks.push({ linkType: 'Who', objectType: r.crmWhoType, lastKnownName: r.crmWhoName, lastKnownId: r.crmWhoId })
    if (r.crmRelatedDeleted) brokenLinks.push({ linkType: 'Related', objectType: r.crmRelatedType, lastKnownName: r.crmRelatedName, lastKnownId: r.crmRelatedId })
    return {
      id: r.id,
      title: r.title,
      startDatetime: r.startDatetime,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      teamId: r.teamId,
      teamName: r.teamName,
      subtypeName: r.subtypeName,
      crmDisconnectCheckedAt: r.crmDisconnectCheckedAt,
      brokenLinks,
    }
  })

  res.json({ data, error: null, meta: { count: data.length } })
})

// GET /api/dashboards/outlook-disconnected?teamId=&userIds=
// v1.362.0: leader-dashboard counterpart to /sf-disconnected, for the OTHER
// side of the same "link went away" problem — an APPROVED activity whose
// Outlook meeting was deleted (§10), still awaiting the owner's Keep/Delete
// decision. Read-only here, same as /sf-disconnected: a leader/admin can see
// the queue and its team-wide age, but the Keep/Delete action itself stays
// on the owning contributor via the existing outlook-deleted routes above —
// this table only links out to the activity's own week (via the same
// `?openActivityId=&startDate=` deep link this same release also fixed on
// the ConnectionsBanner's Review link) rather than acting on someone else's
// row directly.
healthDashRoutes.get('/outlook-disconnected', requireDashboardAccess('outlookDisconnected'), async (req, res) => {
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const memberIds = parseMemberIds(req.query['userIds'])
  const userId = req.query['userId'] as string | undefined
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }

  const rows = await db
    .select({
      id: activities.id,
      title: activities.title,
      startDatetime: activities.startDatetime,
      effortHours: activities.effortHours,
      ownerId: activities.userId,
      ownerName: users.displayName,
      teamId: activities.teamId,
      teamName: teams.name,
      subtypeName: activities.subtypeName,
      activityTypeName: teamActivityTypes.name,
      activityTypeColor: teamActivityTypes.color,
      activityTypeIcon: teamActivityTypes.icon,
      outlookDeletedAt: activities.outlookDeletedAt,
      createdAt: activities.createdAt,
    })
    .from(activities)
    .innerJoin(users, eq(activities.userId, users.id))
    .innerJoin(teams, eq(activities.teamId, teams.id))
    .leftJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'), // CLAUDE.md §21: never draft on a leader dashboard
      eq(activities.isArchived, false),
      eq(activities.outlookDeletedKept, false),
      sql`${activities.outlookDeletedAt} IS NOT NULL`,
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))
    .orderBy(activities.startDatetime)

  res.json({ data: rows, error: null, meta: { count: rows.length } })
})
