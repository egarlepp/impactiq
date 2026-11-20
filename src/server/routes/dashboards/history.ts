import { Router } from 'express'
import { db } from '../../db/index.js'
import { teamActivityTypes, crmHistoricalEvents, crmHistoricalAccounts } from '../../../../drizzle/schema.js'
import { and, eq, gte, lte, sql, inArray, or, isNotNull, isNull } from 'drizzle-orm'
import type { Request } from 'express'
import { requireAnyLeaderOrAdmin } from '../../middleware/rbac.js'
import { parseHistoryFlagFilters, historyFlagConds } from '../../services/salesforce/historical/filters.js'
import { format, subDays } from 'date-fns'

import { resolveTeamScope, assertTeamIdAccessible } from './shared.js'

export const historyDashRoutes = Router()

// ─── v1.214.0: Historical (pre-ImpactIQ) Salesforce activity ────────────
//
// These three read crm_historical_events, NOT `activities`. Their hours are
// estimates from SF scheduled meeting length, so they never feed a cost or
// capacity figure — see the header comment in src/server/routes/history.ts.
//
// Two deliberate differences from every other dashboard endpoint here:
//   1. Rows with team_id NULL are INCLUDED and reported in `linkage`. A large
//      share of historical events belong to SF users who never became
//      ImpactIQ users; filtering them out would under-report by ~30% with no
//      indication that it happened.
//   2. They ignore DASH_MAX_WINDOW_DAYS. That cap is 1095 days, which lands
//      exactly on the 3-year import window and would silently clip the
//      oldest month or two of an "All time" view.

const HISTORY_MAX_WINDOW_DAYS = 1460 // 4y — comfortably past the 3y import

function historyRange(req: Request): { start: string; end: string } {
  const rawStart = req.query['start'] as string | undefined
  const rawEnd = req.query['end'] as string | undefined
  const end = rawEnd && /^\d{4}-\d{2}-\d{2}$/.test(rawEnd) ? rawEnd : format(new Date(), 'yyyy-MM-dd')
  const floor = format(subDays(new Date(end), HISTORY_MAX_WINDOW_DAYS), 'yyyy-MM-dd')
  const start = rawStart && /^\d{4}-\d{2}-\d{2}$/.test(rawStart) && rawStart > floor ? rawStart : floor
  return { start, end }
}

// Team scoping that keeps unlinked rows. Returns undefined (no filter) when
// the caller is scoped to all teams.
function historyTeamCond(teamIds: string[] | null, teamIdParam: string | undefined) {
  if (!teamIdParam || teamIdParam === 'all' || !teamIds || teamIds.length === 0) return undefined
  return or(inArray(crmHistoricalEvents.teamId, teamIds), isNull(crmHistoricalEvents.teamId))
}

historyDashRoutes.get('/history-overview', requireAnyLeaderOrAdmin, async (req, res) => {
  const teamIdParam = req.query['teamId'] as string | undefined
  if (!(await assertTeamIdAccessible(req, teamIdParam))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }
  const teamIds = await resolveTeamScope(req, teamIdParam)
  const { start, end } = historyRange(req)
  const flags = parseHistoryFlagFilters(req.query as Record<string, unknown>)
  // One shared `where` reused by totals / byQuarter / byType below, so the
  // filter can't end up on two of the three and desync the KPI row.
  const where = and(
    gte(crmHistoricalEvents.activityDate, start),
    lte(crmHistoricalEvents.activityDate, end),
    historyTeamCond(teamIds, teamIdParam),
    ...historyFlagConds(flags),
  )
  // Flag counts are computed WITHOUT the flag filters, so a chip can show how
  // many rows the lever would affect before anyone pulls it.
  const unfilteredWhere = and(
    gte(crmHistoricalEvents.activityDate, start),
    lte(crmHistoricalEvents.activityDate, end),
    historyTeamCond(teamIds, teamIdParam),
  )
  const [flagCounts] = (await db
    .select({
      recurringCount: sql<number>`count(*) FILTER (WHERE ${crmHistoricalEvents.isRecurrence})::int`,
      allDayCount: sql<number>`count(*) FILTER (WHERE ${crmHistoricalEvents.isAllDayEvent})::int`,
    })
    .from(crmHistoricalEvents)
    .where(unfilteredWhere)) as Array<{ recurringCount: number; allDayCount: number }>

  const [totals] = (await db
    .select({
      activities: sql<number>`count(*)::int`,
      estimatedHours: sql<number>`coalesce(sum(${crmHistoricalEvents.estimatedHours}), 0)::float8`,
      rowsMissingDuration: sql<number>`count(*) FILTER (WHERE ${crmHistoricalEvents.estimatedHours} IS NULL)::int`,
      distinctAccounts: sql<number>`count(DISTINCT ${crmHistoricalEvents.accountId})::int`,
      distinctOwners: sql<number>`count(DISTINCT ${crmHistoricalEvents.ownerCrmUserId})::int`,
      rowsWithUser: sql<number>`count(*) FILTER (WHERE ${crmHistoricalEvents.userId} IS NOT NULL)::int`,
      earliest: sql<string | null>`min(${crmHistoricalEvents.activityDate})::text`,
      latest: sql<string | null>`max(${crmHistoricalEvents.activityDate})::text`,
    })
    .from(crmHistoricalEvents)
    .where(where)) as Array<{
    activities: number
    estimatedHours: number
    rowsMissingDuration: number
    distinctAccounts: number
    distinctOwners: number
    rowsWithUser: number
    earliest: string | null
    latest: string | null
  }>

  const byQuarter = (await db
    .select({
      period: sql<string>`to_char(${crmHistoricalEvents.activityDate}, 'YYYY') || '-Q' || to_char(${crmHistoricalEvents.activityDate}, 'Q')`,
      year: sql<number>`extract(year from ${crmHistoricalEvents.activityDate})::int`,
      quarter: sql<number>`extract(quarter from ${crmHistoricalEvents.activityDate})::int`,
      activities: sql<number>`count(*)::int`,
      estimatedHours: sql<number>`coalesce(sum(${crmHistoricalEvents.estimatedHours}), 0)::float8`,
    })
    .from(crmHistoricalEvents)
    .where(where)
    .groupBy(sql`1, 2, 3`)
    .orderBy(sql`2, 3`)) as Array<{ period: string; year: number; quarter: number; activities: number; estimatedHours: number }>

  const byType = (await db
    .select({
      label: sql<string>`coalesce(${teamActivityTypes.name}, ${crmHistoricalEvents.crmType}, '(unmapped)')`,
      activities: sql<number>`count(*)::int`,
      estimatedHours: sql<number>`coalesce(sum(${crmHistoricalEvents.estimatedHours}), 0)::float8`,
    })
    .from(crmHistoricalEvents)
    .leftJoin(teamActivityTypes, eq(crmHistoricalEvents.activityTypeId, teamActivityTypes.id))
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`count(*) DESC`)
    .limit(25)) as Array<{ label: string; activities: number; estimatedHours: number }>

  const t = totals ?? {
    activities: 0, estimatedHours: 0, rowsMissingDuration: 0, distinctAccounts: 0,
    distinctOwners: 0, rowsWithUser: 0, earliest: null, latest: null,
  }
  const byYearMap = new Map<number, { year: number; activities: number; estimatedHours: number }>()
  for (const q of byQuarter) {
    const y = byYearMap.get(q.year) ?? { year: q.year, activities: 0, estimatedHours: 0 }
    y.activities += q.activities
    y.estimatedHours += q.estimatedHours
    byYearMap.set(q.year, y)
  }

  res.json({
    data: {
      totals: {
        activities: t.activities,
        estimatedHours: Math.round(t.estimatedHours * 10) / 10,
        rowsMissingDuration: t.rowsMissingDuration,
        distinctAccounts: t.distinctAccounts,
        distinctOwners: t.distinctOwners,
        earliest: t.earliest,
        latest: t.latest,
        recurringCount: flagCounts?.recurringCount ?? 0,
        allDayCount: flagCounts?.allDayCount ?? 0,
      },
      linkage: {
        rowsWithUser: t.rowsWithUser,
        rowsWithoutUser: t.activities - t.rowsWithUser,
        pctLinked: t.activities > 0 ? Math.round((t.rowsWithUser / t.activities) * 1000) / 10 : 0,
      },
      byYear: Array.from(byYearMap.values())
        .map((y) => ({ ...y, estimatedHours: Math.round(y.estimatedHours * 10) / 10 }))
        .sort((a, b) => a.year - b.year),
      byQuarter: byQuarter.map((q) => ({ ...q, estimatedHours: Math.round(q.estimatedHours * 10) / 10 })),
      byType: byType.map((x) => ({ ...x, estimatedHours: Math.round(x.estimatedHours * 10) / 10 })),
    },
    error: null,
    meta: { start, end, filters: flags },
  })
})

historyDashRoutes.get('/history-accounts', requireAnyLeaderOrAdmin, async (req, res) => {
  const teamIdParam = req.query['teamId'] as string | undefined
  if (!(await assertTeamIdAccessible(req, teamIdParam))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }
  const teamIds = await resolveTeamScope(req, teamIdParam)
  const { start, end } = historyRange(req)
  const limit = Math.min(Number(req.query['limit']) || 100, 500)
  const flags = parseHistoryFlagFilters(req.query as Record<string, unknown>)

  const rows = (await db
    .select({
      crmAccountId: crmHistoricalEvents.accountId,
      crmAccountName: sql<string | null>`max(${crmHistoricalAccounts.name})`,
      activities: sql<number>`count(*)::int`,
      estimatedHours: sql<number>`coalesce(sum(${crmHistoricalEvents.estimatedHours}), 0)::float8`,
      distinctOwners: sql<number>`count(DISTINCT ${crmHistoricalEvents.ownerCrmUserId})::int`,
      firstTouch: sql<string | null>`min(${crmHistoricalEvents.activityDate})::text`,
      lastTouch: sql<string | null>`max(${crmHistoricalEvents.activityDate})::text`,
    })
    .from(crmHistoricalEvents)
    .leftJoin(crmHistoricalAccounts, eq(crmHistoricalEvents.accountId, crmHistoricalAccounts.accountId))
    .where(and(
      gte(crmHistoricalEvents.activityDate, start),
      lte(crmHistoricalEvents.activityDate, end),
      isNotNull(crmHistoricalEvents.accountId),
      historyTeamCond(teamIds, teamIdParam),
      ...historyFlagConds(flags),
    ))
    .groupBy(crmHistoricalEvents.accountId)
    .orderBy(sql`count(*) DESC`)
    .limit(limit)) as Array<{
    crmAccountId: string | null
    crmAccountName: string | null
    activities: number
    estimatedHours: number
    distinctOwners: number
    firstTouch: string | null
    lastTouch: string | null
  }>

  res.json({
    data: rows.map((r) => ({ ...r, estimatedHours: Math.round(r.estimatedHours * 10) / 10 })),
    error: null,
    meta: { start, end, limit, filters: flags },
  })
})

historyDashRoutes.get('/history-coverage', requireAnyLeaderOrAdmin, async (req, res) => {
  const teamIdParam = req.query['teamId'] as string | undefined
  if (!(await assertTeamIdAccessible(req, teamIdParam))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }
  const teamIds = await resolveTeamScope(req, teamIdParam)
  const { start, end } = historyRange(req)
  const bucket = req.query['bucket'] === 'quarter' ? 'quarter' : 'month'
  const flags = parseHistoryFlagFilters(req.query as Record<string, unknown>)
  const periodExpr = bucket === 'quarter'
    ? sql`to_char(${crmHistoricalEvents.activityDate}, 'YYYY') || '-Q' || to_char(${crmHistoricalEvents.activityDate}, 'Q')`
    : sql`to_char(${crmHistoricalEvents.activityDate}, 'YYYY-MM')`

  const rows = (await db
    .select({
      period: sql<string>`${periodExpr}`,
      distinctAccounts: sql<number>`count(DISTINCT ${crmHistoricalEvents.accountId})::int`,
      activities: sql<number>`count(*)::int`,
      estimatedHours: sql<number>`coalesce(sum(${crmHistoricalEvents.estimatedHours}), 0)::float8`,
    })
    .from(crmHistoricalEvents)
    .where(and(
      gte(crmHistoricalEvents.activityDate, start),
      lte(crmHistoricalEvents.activityDate, end),
      historyTeamCond(teamIds, teamIdParam),
      ...historyFlagConds(flags),
    ))
    .groupBy(sql`1`)
    .orderBy(sql`1`)) as Array<{ period: string; distinctAccounts: number; activities: number; estimatedHours: number }>

  res.json({
    data: rows.map((r) => ({ ...r, estimatedHours: Math.round(r.estimatedHours * 10) / 10 })),
    error: null,
    meta: { start, end, bucket, filters: flags },
  })
})
