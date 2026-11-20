import { Router } from 'express'
import { db } from '../db/index.js'
import {
  crmHistoricalEvents,
  crmHistoricalOpportunities,
  teamActivityTypes,
  users,
} from '../../../drizzle/schema.js'
import { and, eq, gte, lte, desc, inArray, or, sql, isNotNull } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth.js'
import { getAccessibleTeamIds } from '../middleware/rbac.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { parseHistoryFlagFilters, historyFlagConds } from '../services/salesforce/historical/filters.js'
import { getCrmProviderId } from '../services/crm/providerSetting.js'
import { getHubspotOwnerIdForUser } from '../services/hubspot/owners.js'

// v1.214.0: read API for imported pre-ImpactIQ Salesforce Event history.
//
// DELIBERATE OMISSION: nothing in this file touches cost groups, hourly
// rates, or resolveCostBatch, and nothing here returns a dollar figure. The
// hours these rows carry are ESTIMATES derived from the meeting length
// scheduled in Salesforce, not effort anyone logged. Multiplying them by a
// rate would produce a number that looks authoritative and isn't, so the
// absence of any cost import here is a structural guard, not an oversight.
// Please don't add one.
//
// These live on their own router rather than extending
// GET /api/activities/by-sf because that endpoint inner-joins `users` and
// `team_activity_types` (historical rows have both NULL) and because its
// `meta.totalHours` is rendered as authoritative logged effort. Everything
// here reports `meta.estimatedHours` instead — that naming difference is the
// guardrail against the two ever being summed together.

export const historyRouter = Router()

historyRouter.use(requireAuth)

// Dedicated per-user throttle on top of the generous shared global limiter —
// real hardening follow-up from the go-live security audit. Both routes below can
// return up to MAX_LIMIT (2000) rows across multiple DB round-trips with no
// team_id row filter, so a runaway/scripted caller costs meaningfully more
// than a typical request. 30/min per user comfortably covers real usage
// (loading a modal or the /my-history page a few times in a row).
historyRouter.use(rateLimit({ windowMs: 60 * 1000, max: 30, keyFn: (req) => req.user!.id }))

const MAX_LIMIT = 2000
const DEFAULT_LIMIT = 500

function parseLimit(v: unknown, fallback = DEFAULT_LIMIT): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function dateRangeConds(startDate: unknown, endDate: unknown) {
  const conds = []
  if (typeof startDate === 'string' && startDate) {
    const s = new Date(startDate)
    if (!Number.isNaN(s.getTime())) conds.push(gte(crmHistoricalEvents.activityDate, startDate.slice(0, 10)))
  }
  if (typeof endDate === 'string' && endDate) {
    const e = new Date(endDate)
    if (!Number.isNaN(e.getTime())) conds.push(lte(crmHistoricalEvents.activityDate, endDate.slice(0, 10)))
  }
  return conds
}

interface HistRow {
  crmEventId: string
  subject: string | null
  crmType: string | null
  activityDate: string | null
  startDatetime: Date | null
  durationMinutes: number | null
  estimatedHours: string | null
  ownerCrmUserId: string | null
  ownerCrmUserName: string | null
  whatId: string | null
  whatType: string | null
  whatName: string | null
  accountId: string | null
  description: string | null
  userId: string | null
  activityTypeName: string | null
  isRecurrence: boolean
  isAllDayEvent: boolean
}

function summarize(rows: HistRow[]) {
  let estimatedHours = 0
  let rowsMissingDuration = 0
  const byType = new Map<string, { crmType: string; count: number; estimatedHours: number }>()
  const byOwner = new Map<
    string,
    { ownerCrmUserId: string | null; ownerCrmUserName: string | null; userId: string | null; count: number; estimatedHours: number }
  >()
  let earliest: string | null = null
  let latest: string | null = null

  for (const r of rows) {
    // A null estimate means "unknown", not zero — count it separately so the
    // UI can say so rather than rendering a misleading 0.0h.
    const h = r.estimatedHours != null ? Number(r.estimatedHours) : null
    if (h == null) rowsMissingDuration += 1
    else estimatedHours += h

    const typeKey = r.activityTypeName ?? r.crmType ?? '(unmapped)'
    const t = byType.get(typeKey) ?? { crmType: typeKey, count: 0, estimatedHours: 0 }
    t.count += 1
    t.estimatedHours += h ?? 0
    byType.set(typeKey, t)

    const ownerKey = r.ownerCrmUserId ?? '(unknown)'
    const o = byOwner.get(ownerKey) ?? {
      ownerCrmUserId: r.ownerCrmUserId,
      ownerCrmUserName: r.ownerCrmUserName,
      userId: r.userId,
      count: 0,
      estimatedHours: 0,
    }
    o.count += 1
    o.estimatedHours += h ?? 0
    byOwner.set(ownerKey, o)

    if (r.activityDate) {
      if (!earliest || r.activityDate < earliest) earliest = r.activityDate
      if (!latest || r.activityDate > latest) latest = r.activityDate
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100
  return {
    count: rows.length,
    estimatedHours: round(estimatedHours),
    rowsMissingDuration,
    earliest,
    latest,
    byType: Array.from(byType.values())
      .map((t) => ({ ...t, estimatedHours: round(t.estimatedHours) }))
      .sort((a, b) => b.count - a.count),
    byOwner: Array.from(byOwner.values())
      .map((o) => ({ ...o, estimatedHours: round(o.estimatedHours) }))
      .sort((a, b) => b.count - a.count),
  }
}

const ROW_SELECT = {
  crmEventId: crmHistoricalEvents.crmEventId,
  subject: crmHistoricalEvents.subject,
  crmType: crmHistoricalEvents.crmType,
  activityDate: crmHistoricalEvents.activityDate,
  startDatetime: crmHistoricalEvents.startDatetime,
  durationMinutes: crmHistoricalEvents.durationMinutes,
  estimatedHours: crmHistoricalEvents.estimatedHours,
  isRecurrence: crmHistoricalEvents.isRecurrence,
  isAllDayEvent: crmHistoricalEvents.isAllDayEvent,
  ownerCrmUserId: crmHistoricalEvents.ownerCrmUserId,
  ownerCrmUserName: crmHistoricalEvents.ownerCrmUserName,
  whatId: crmHistoricalEvents.whatId,
  whatType: crmHistoricalEvents.whatType,
  whatName: crmHistoricalEvents.whatName,
  accountId: crmHistoricalEvents.accountId,
  description: crmHistoricalEvents.description,
  userId: crmHistoricalEvents.userId,
  activityTypeName: teamActivityTypes.name,
}

// GET /api/history/by-sf
// Historical activity for one Opportunity / Account, for the modal's
// "Historical Salesforce Activity" section.
//
// NOTE ON teamId: it authorizes the caller but is deliberately NOT a row
// filter. Historical events predate ImpactIQ's teams, and a large share have
// team_id NULL because their SF owner never became an ImpactIQ user. Filtering
// on it would silently hide most of the history. Please don't "fix" this.
historyRouter.get('/by-sf', async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const whatId = req.query['whatId'] as string | undefined
  const whatIdsParam = req.query['whatIds'] as string | undefined
  const accountId = req.query['accountId'] as string | undefined
  const mode = (req.query['mode'] as string | undefined) ?? 'direct'
  const countOnly = req.query['countOnly'] === '1' || req.query['countOnly'] === 'true'

  if (!teamId || (!whatId && !whatIdsParam && !accountId)) {
    res.status(400).json({ data: null, error: 'errors.validation.history_params_required', meta: {} })
    return
  }

  const accessible = await getAccessibleTeamIds(req.user!.id)
  if (!accessible.includes(teamId)) {
    res.status(403).json({ data: null, error: 'errors.auth.forbidden', meta: {} })
    return
  }

  const allWhatIds = Array.from(
    new Set([...(whatId ? [whatId] : []), ...(whatIdsParam ? whatIdsParam.split(',').filter(Boolean) : [])]),
  )

  // Account "Include All" also sweeps in events hanging off that account's
  // opportunities. Campaign/Lead roll-up doesn't apply — the import only
  // covers Opportunity / Account / Evaluations__c linked events.
  const targetConds = []
  if (allWhatIds.length > 0) targetConds.push(inArray(crmHistoricalEvents.whatId, allWhatIds))
  if (accountId) {
    targetConds.push(eq(crmHistoricalEvents.accountId, accountId))
    if (mode === 'include_all') {
      const childOpps = await db
        .select({ id: crmHistoricalOpportunities.oppId })
        .from(crmHistoricalOpportunities)
        .where(eq(crmHistoricalOpportunities.accountId, accountId))
      if (childOpps.length > 0) {
        targetConds.push(inArray(crmHistoricalEvents.whatId, childOpps.map((c) => c.id)))
      }
    }
  }
  if (targetConds.length === 0) {
    res.json({ data: [], error: null, meta: { count: 0, estimatedHours: 0, rowsMissingDuration: 0 } })
    return
  }

  const flags = parseHistoryFlagFilters(req.query as Record<string, unknown>)
  const where = and(
    targetConds.length === 1 ? targetConds[0] : or(...targetConds),
    ...dateRangeConds(req.query['startDate'], req.query['endDate']),
    ...historyFlagConds(flags),
  )

  const limit = parseLimit(req.query['limit'])
  const rows = (await db
    .select(ROW_SELECT)
    .from(crmHistoricalEvents)
    // LEFT joins: a historical row may have no mapped activity type at all.
    .leftJoin(teamActivityTypes, eq(crmHistoricalEvents.activityTypeId, teamActivityTypes.id))
    .where(where)
    .orderBy(desc(crmHistoricalEvents.activityDate))
    .limit(limit + 1)) as HistRow[]

  const truncated = rows.length > limit
  const page = truncated ? rows.slice(0, limit) : rows
  const meta = summarize(page)

  res.json({
    data: countOnly ? [] : page,
    error: null,
    meta: { ...meta, truncated, filters: flags },
  })
})

// GET /api/history/me
// A contributor's own pre-ImpactIQ activity. Never accepts a userId param —
// there is deliberately no "view someone else's history" path here.
historyRouter.get('/me', async (req, res) => {
  const userId = req.user!.id
  // On HubSpot (v1.401.0) the imported owner id is the user's HubSpot owner,
  // matched by email; on Salesforce it's their linked SF User Id.
  let crmUserId: string | null
  if ((await getCrmProviderId()) === 'hubspot') {
    crmUserId = await getHubspotOwnerIdForUser(userId)
  } else {
    const [me] = await db.select({ crmUserId: users.crmUserId }).from(users).where(eq(users.id, userId)).limit(1)
    crmUserId = me?.crmUserId ?? null
  }

  // Match on the resolved link, falling back to the raw SF owner id so the
  // page still works if linkage hasn't been backfilled yet.
  const identity = crmUserId
    ? or(eq(crmHistoricalEvents.userId, userId), eq(crmHistoricalEvents.ownerCrmUserId, crmUserId))
    : eq(crmHistoricalEvents.userId, userId)

  const year = req.query['year'] as string | undefined
  // `sfType` is the pre-v1.413 name of this filter; both are accepted.
  const typeParam = req.query['crmType'] ?? req.query['sfType']
  const sfTypeFilter = typeof typeParam === 'string' ? typeParam : undefined
  const conds = [identity]
  if (year && /^\d{4}$/.test(year)) {
    conds.push(gte(crmHistoricalEvents.activityDate, `${year}-01-01`))
    conds.push(lte(crmHistoricalEvents.activityDate, `${year}-12-31`))
  }
  if (sfTypeFilter) conds.push(eq(crmHistoricalEvents.crmType, sfTypeFilter))
  const flags = parseHistoryFlagFilters(req.query as Record<string, unknown>)
  conds.push(...historyFlagConds(flags))

  const limit = parseLimit(req.query['limit'], MAX_LIMIT)
  const rows = (await db
    .select(ROW_SELECT)
    .from(crmHistoricalEvents)
    .leftJoin(teamActivityTypes, eq(crmHistoricalEvents.activityTypeId, teamActivityTypes.id))
    .where(and(...conds))
    .orderBy(desc(crmHistoricalEvents.activityDate))
    .limit(limit)) as HistRow[]

  // Distinct years across the user's whole history (not the filtered slice),
  // so the year picker doesn't collapse to the current selection.
  const yearRows = (await db
    .select({ yr: sql<string>`to_char(${crmHistoricalEvents.activityDate}, 'YYYY')` })
    .from(crmHistoricalEvents)
    .where(and(identity, isNotNull(crmHistoricalEvents.activityDate)))
    .groupBy(sql`to_char(${crmHistoricalEvents.activityDate}, 'YYYY')`)
    .orderBy(sql`to_char(${crmHistoricalEvents.activityDate}, 'YYYY') DESC`)) as Array<{ yr: string }>

  const accountIds = new Set(rows.map((r) => r.accountId).filter(Boolean))
  const meta = summarize(rows)

  res.json({
    data: rows,
    error: null,
    meta: {
      ...meta,
      // `linked: false` is what lets the client tell "your Salesforce user
      // isn't linked yet" apart from "linked, but nothing was imported".
      linked: !!crmUserId,
      distinctAccounts: accountIds.size,
      years: yearRows.map((y) => Number(y.yr)).filter((n) => Number.isFinite(n)),
      filters: flags,
    },
  })
})
