import { Router } from 'express'
import { db } from '../../db/index.js'
import { activities, teamActivityTypes, users, crmLeadAccountLink } from '../../../../drizzle/schema.js'
import { and, eq, gte, lte, sql, desc, inArray } from 'drizzle-orm'
import { requireDashboardAccess } from '../../middleware/rbac.js'
import { startOfWeek, subWeeks, endOfWeek } from 'date-fns'

import {
  resolveTeamScope,
  assertUserInTeams,
  rangeFor,
  parseDateBasis,
  dateWindow,
  parseWeekShift,
  parseProductIds,
  parseSubtypeIds,
  subtypeFilterCond,
  parseMemberIds,
  productFilterCond,
  parseAcvRanges,
  amountInRanges,
} from './shared.js'

export const activityDashRoutes = Router()

// GET /api/dashboards/activity-mix?teamId=&weeks=4
activityDashRoutes.get('/activity-mix', requireDashboardAccess('mix'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  const subtypeIds = parseSubtypeIds(req.query['subtypeIds'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)
  const productCond = productFilterCond(productIds)
  const subtypeCond = subtypeFilterCond(subtypeIds)

  const rows = await db
    .select({
      userId: activities.userId,
      displayName: users.displayName,
      activityTypeName: teamActivityTypes.name,
      // v1.266.0: the type's admin-set color, so the Mix chart's segments
      // match Activity Type Breakdown's bars instead of an insertion-order
      // palette that shifted colors whenever the Subtype filter narrowed
      // which types were present.
      activityTypeColor: teamActivityTypes.color,
      // v1.265.0: Subtype dimension (PRD §7) — see /breakdown for rationale.
      subtypeName: activities.subtypeName,
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
    })
    .from(activities)
    .innerJoin(users, eq(activities.userId, users.id))
    .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
      ...(subtypeCond ? [subtypeCond] : []),
    ))
    .groupBy(activities.userId, users.displayName, teamActivityTypes.name, teamActivityTypes.color, activities.subtypeName)
    .orderBy(users.displayName, teamActivityTypes.name)
  res.json({ data: rows, error: null, meta: {} })
})

// GET /api/dashboards/account-concentration?teamId=&weeks=4
// v1.272.0: rewritten as an actual Account rollup. Previously this grouped
// raw crmWhatId (Opportunity / Account / whatever the activity happened to
// be linked to) and rendered each as its own "account" segment — so a team
// with 2 real Accounts could show "6 accounts" once Opportunities, and any
// Stage/Forecast/ACV filter was silently ignored (missing from this route
// entirely, unlike Most Expensive / Manager Rollup). Now every Opportunity-
// linked and Lead-linked activity rolls up to its actual parent Account
// (same sources Most Expensive's scope=account and Burn's account_rollup
// use: activities.crmAccountId, falling back to sf_object_owner_cache for
// older rows, and crm_lead_account_link for converted Leads) and the
// response carries a per-account `breakdown` of the Opportunities/Leads/
// direct-Account activity making it up, for the drill-down bar. Campaigns
// have no stable Campaign→Account link in this org (documented on Most
// Expensive above) so Campaign-linked activity can't roll into an Account
// and is excluded here, same as there.
activityDashRoutes.get('/account-concentration', requireDashboardAccess('concentration'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const acvRanges = parseAcvRanges(req.query['acv'])
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)
  const productCond = productFilterCond(productIds)

  const rawRows = await db
    .select({
      userId: activities.userId,
      displayName: users.displayName,
      crmWhatId: activities.crmWhatId,
      crmWhatName: activities.crmWhatName,
      crmWhatType: activities.crmWhatType,
      crmWhoId: activities.crmWhoId,
      crmWhoType: activities.crmWhoType,
      crmWhoName: activities.crmWhoName,
      crmAccountId: activities.crmAccountId,
      crmAccountName: activities.crmAccountName,
      effortHours: activities.effortHours,
      acv: activities.acv,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
    })
    .from(activities)
    .innerJoin(users, eq(activities.userId, users.id))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      sql`(${activities.crmWhatId} IS NOT NULL OR ${activities.crmWhoId} IS NOT NULL)`,
      ...(productCond ? [productCond] : []),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
    ))

  // Stage / Forecast / ACV range apply only to Opportunity-linked rows; when
  // any is active, non-Opp rows are dropped — same convention as Most
  // Expensive / Manager Rollup / Project Costing.
  const hasOppFilter = acvRanges.length > 0 || stages.length > 0 || forecast.length > 0
  const oppMaxAcv = new Map<string, number>()
  if (hasOppFilter) {
    for (const r of rawRows) {
      if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
        const v = Number(r.acv ?? 0)
        if (v > (oppMaxAcv.get(r.crmWhatId) ?? 0)) oppMaxAcv.set(r.crmWhatId, v)
      }
    }
  }
  const rows = !hasOppFilter ? rawRows : rawRows.filter((r) => {
    if (r.crmWhatType !== 'Opportunity' || !r.crmWhatId) return false
    if (acvRanges.length > 0 && !amountInRanges(oppMaxAcv.get(r.crmWhatId) ?? 0, acvRanges)) return false
    if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) return false
    if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) return false
    return true
  })

  // Resolve Opp → parent Account for rows missing the crmAccountId snapshot.
  const { sfObjectOwnerCache } = await import('../../../../drizzle/schema.js')
  const missingParentIds = Array.from(new Set(
    rows.filter((r) => r.crmWhatType === 'Opportunity' && r.crmWhatId && !r.crmAccountId).map((r) => r.crmWhatId!)
  ))
  const cachedParents = missingParentIds.length === 0 ? [] : await db
    .select({ sfId: sfObjectOwnerCache.sfId, objectType: sfObjectOwnerCache.objectType, accountId: sfObjectOwnerCache.accountId, accountName: sfObjectOwnerCache.accountName })
    .from(sfObjectOwnerCache)
    .where(inArray(sfObjectOwnerCache.sfId, missingParentIds))
  const parentByOppId = new Map<string, { accountId: string; accountName: string | null }>()
  for (const c of cachedParents) {
    if (c.objectType === 'Opportunity' && c.accountId) parentByOppId.set(c.sfId, { accountId: c.accountId, accountName: c.accountName })
  }

  // Lead → Account via crm_lead_account_link (same source as Most
  // Expensive's scope=account).
  const leadIds = Array.from(new Set(rows.filter((r) => r.crmWhoType === 'Lead' && r.crmWhoId).map((r) => r.crmWhoId!)))
  const leadAcctMap = new Map<string, string | null>()
  if (leadIds.length > 0) {
    const linkRows = await db.select().from(crmLeadAccountLink).where(inArray(crmLeadAccountLink.leadId, leadIds))
    for (const l of linkRows) leadAcctMap.set(l.leadId, l.accountId)
  }

  interface Item { type: 'Opportunity' | 'Lead' | 'Account'; id: string; name: string | null; hours: number }
  interface UserAcc { userId: string; displayName: string; accountId: string; accountName: string | null; hours: number; items: Map<string, Item> }
  const byUserAccount = new Map<string, UserAcc>()

  for (const r of rows) {
    const hours = Number(r.effortHours)
    let accountId: string | null = null
    let accountName: string | null = null
    let item: Item | null = null

    if (r.crmWhatType === 'Account' && r.crmWhatId) {
      accountId = r.crmWhatId
      accountName = r.crmWhatName
      item = { type: 'Account', id: r.crmWhatId, name: r.crmWhatName, hours }
    } else if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
      if (r.crmAccountId) {
        accountId = r.crmAccountId
        accountName = r.crmAccountName ?? null
      } else {
        const parent = parentByOppId.get(r.crmWhatId)
        if (parent) { accountId = parent.accountId; accountName = parent.accountName }
      }
      if (accountId) item = { type: 'Opportunity', id: r.crmWhatId, name: r.crmWhatName, hours }
    } else if (r.crmWhoType === 'Lead' && r.crmWhoId) {
      const acct = leadAcctMap.get(r.crmWhoId)
      if (acct) {
        accountId = acct
        item = { type: 'Lead', id: r.crmWhoId, name: r.crmWhoName, hours }
      }
    }

    // Opportunities/Leads with no resolvable parent Account don't roll into
    // any Account and are excluded (they're covered by the other scopes on
    // Most Expensive instead).
    if (!accountId || !item) continue

    const key = `${r.userId}::${accountId}`
    const cur = byUserAccount.get(key) ?? { userId: r.userId, displayName: r.displayName, accountId, accountName, hours: 0, items: new Map<string, Item>() }
    cur.hours += hours
    if (!cur.accountName && accountName) cur.accountName = accountName
    const itemKey = `${item.type}:${item.id}`
    const itemCur = cur.items.get(itemKey) ?? { ...item, hours: 0 }
    itemCur.hours += hours
    cur.items.set(itemKey, itemCur)
    byUserAccount.set(key, cur)
  }

  const concentrationData = Array.from(byUserAccount.values())
    .map((a) => ({
      userId: a.userId,
      displayName: a.displayName,
      accountId: a.accountId,
      accountName: a.accountName,
      totalHours: String(a.hours),
      breakdown: Array.from(a.items.values()).sort((x, y) => y.hours - x.hours).map((it) => ({ ...it, hours: it.hours })),
    }))
    .sort((x, y) => Number(y.totalHours) - Number(x.totalHours))

  res.json({ data: concentrationData, error: null, meta: {} })
})

// GET /api/dashboards/wow-delta?teamId=&weeks=4
activityDashRoutes.get('/wow-delta', requireDashboardAccess('wow'), async (req, res) => {
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }

  const anchor = subWeeks(new Date(), -weekShift)
  const currentStart = startOfWeek(subWeeks(anchor, weeksBack - 1), { weekStartsOn: 1 })
  const currentEnd = endOfWeek(anchor, { weekStartsOn: 1 })
  const priorStart = startOfWeek(subWeeks(anchor, weeksBack * 2 - 1), { weekStartsOn: 1 })
  const priorEnd = endOfWeek(subWeeks(anchor, weeksBack), { weekStartsOn: 1 })
  const productCond = productFilterCond(productIds)
  const memberConds = [
    ...(userId ? [eq(activities.userId, userId)] : []),
    ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
  ]

  async function totalsFor(start: Date, end: Date) {
    const overall = await db
      .select({ totalHours: sql<string>`coalesce(sum(${activities.effortHours}),0)`.as('total_hours') })
      .from(activities)
      .where(and(
        inArray(activities.teamId, teamIds),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        gte(activities.startDatetime, start),
        lte(activities.startDatetime, end),
        ...(productCond ? [productCond] : []),
        ...memberConds,
      ))
    const byType = await db
      .select({
        activityTypeName: teamActivityTypes.name,
        totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
      })
      .from(activities)
      .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
      .where(and(
        inArray(activities.teamId, teamIds),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        gte(activities.startDatetime, start),
        lte(activities.startDatetime, end),
        ...(productCond ? [productCond] : []),
        ...memberConds,
      ))
      .groupBy(teamActivityTypes.name)
    return {
      total: Number(overall[0]?.totalHours ?? 0),
      byType: Object.fromEntries(byType.map((r) => [r.activityTypeName, Number(r.totalHours ?? 0)])),
    }
  }

  const current = await totalsFor(currentStart, currentEnd)
  const prior = await totalsFor(priorStart, priorEnd)
  const allTypes = new Set([...Object.keys(current.byType), ...Object.keys(prior.byType)])
  const perType = Array.from(allTypes).map((name) => ({
    activityTypeName: name,
    current: current.byType[name] ?? 0,
    prior: prior.byType[name] ?? 0,
    delta: (current.byType[name] ?? 0) - (prior.byType[name] ?? 0),
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  res.json({
    data: {
      currentTotal: current.total,
      priorTotal: prior.total,
      delta: current.total - prior.total,
      pctDelta: prior.total > 0 ? ((current.total - prior.total) / prior.total) * 100 : null,
      perType,
    },
    error: null,
    meta: {},
  })
})

// GET /api/dashboards/burn?teamId=&weeks=4&activityTypeId=&userId=
activityDashRoutes.get('/burn', requireDashboardAccess('burn'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string; const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const acvRanges = parseAcvRanges(req.query['acv'])
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const scope = req.query['scope'] as string | undefined

  if (teamIds.length === 0) {
    res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} })
    return
  }
  const targetUserId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  if (targetUserId && !(await assertUserInTeams(targetUserId, teamIds, req.user?.id))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }

  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)

  const conditions = [
    inArray(activities.teamId, teamIds),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    ...dateWindow(dateBasis, rangeStart, rangeEnd),
    sql`${activities.crmWhatId} IS NOT NULL`,
  ]
  if (req.query['activityTypeId']) conditions.push(eq(activities.activityTypeId, req.query['activityTypeId'] as string))
  if (targetUserId) conditions.push(eq(activities.userId, targetUserId))
  if (memberIds.length > 0) conditions.push(inArray(activities.userId, memberIds))
  const productCondBurn = productFilterCond(productIds)
  if (productCondBurn) conditions.push(productCondBurn)

  // Account rollup: attribute Opportunity activities to their parent
  // Account (via sf_object_owner_cache) so a leader can see per-Account
  // totals that include everything logged against Opps under them. Rows
  // are returned as crmWhatType='Account' with rolled-up hours.
  if (scope === 'account_rollup') {
    // v1.117.0: primary source for the Opp→Account map is the
    // crmAccountId/Name persisted on the activity itself (stamped by
    // ActivityForm and SuggestedActivityCard). Fall back to
    // sf_object_owner_cache for older activities missing the snapshot.
    const raw = await db
      .select({
        crmWhatId: activities.crmWhatId,
        crmWhatName: activities.crmWhatName,
        crmWhatType: activities.crmWhatType,
        crmAccountId: activities.crmAccountId,
        crmAccountName: activities.crmAccountName,
        effortHours: activities.effortHours,
        costTransportation: activities.costTransportation,
        costLodging: activities.costLodging,
        costFood: activities.costFood,
        incidentalCurrency: activities.incidentalCurrency,
        acv: activities.acv,
        salesStage: activities.salesStage,
        forecastCategory: activities.forecastCategory,
      })
      .from(activities)
      .where(and(...conditions))

    // ACV range: keep only Opps whose (max) ACV falls in the range, and drop
    // Account-direct rows entirely (they carry no Opportunity ACV). Uses the
    // per-Opp max so a chatty low-ACV activity can't sink an in-range Opp.
    const oppMaxAcvBurn = new Map<string, number>()
    if (acvRanges.length > 0) {
      for (const r of raw) {
        if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
          const v = Number(r.acv ?? 0)
          if (v > (oppMaxAcvBurn.get(r.crmWhatId) ?? 0)) oppMaxAcvBurn.set(r.crmWhatId, v)
        }
      }
    }
    const acvKeepsBurn = (r: { crmWhatType: string | null; crmWhatId: string | null; salesStage: string | null; forecastCategory: string | null }): boolean => {
      if (acvRanges.length === 0 && stages.length === 0 && forecast.length === 0) return true
      if (r.crmWhatType !== 'Opportunity' || !r.crmWhatId) return false
      if (acvRanges.length > 0 && !amountInRanges(oppMaxAcvBurn.get(r.crmWhatId) ?? 0, acvRanges)) return false
      if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) return false
      if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) return false
      return true
    }

    const { sfObjectOwnerCache } = await import('../../../../drizzle/schema.js')
    const missingParentIds = Array.from(new Set(
      raw
        .filter((r) => r.crmWhatType === 'Opportunity' && r.crmWhatId && !r.crmAccountId)
        .map((r) => r.crmWhatId!)
    ))
    const cached = missingParentIds.length === 0 ? [] : await db
      .select({ sfId: sfObjectOwnerCache.sfId, objectType: sfObjectOwnerCache.objectType, accountId: sfObjectOwnerCache.accountId, accountName: sfObjectOwnerCache.accountName })
      .from(sfObjectOwnerCache)
      .where(inArray(sfObjectOwnerCache.sfId, missingParentIds))
    const parentByOppId = new Map<string, { accountId: string; accountName: string | null }>()
    for (const c of cached) {
      if (c.objectType === 'Opportunity' && c.accountId) {
        parentByOppId.set(c.sfId, { accountId: c.accountId, accountName: c.accountName })
      }
    }

    interface OppAgg { oppId: string; oppName: string | null; hours: number; count: number }
    interface Agg { accountId: string; accountName: string | null; hours: number; count: number; oppIds: Set<string>; opps: Map<string, OppAgg> }
    const byAccount = new Map<string, Agg>()
    let droppedOppHours = 0
    let droppedOppCount = 0
    for (const r of raw) {
      if (!r.crmWhatId) continue
      if (!acvKeepsBurn(r)) continue
      let accountId: string
      let accountName: string | null
      let oppId: string | null = null
      let oppName: string | null = null
      if (r.crmWhatType === 'Account') {
        accountId = r.crmWhatId
        accountName = r.crmWhatName
      } else if (r.crmWhatType === 'Opportunity') {
        oppId = r.crmWhatId
        oppName = r.crmWhatName
        if (r.crmAccountId) {
          accountId = r.crmAccountId
          accountName = r.crmAccountName ?? null
        } else {
          const parent = parentByOppId.get(r.crmWhatId)
          if (!parent) {
            // Opportunity with no resolvable parent — surface as its own
            // top-level row so it isn't silently dropped from the rollup
            // (this is what the user reported).
            droppedOppHours += Number(r.effortHours)
            droppedOppCount += 1
            const cur = byAccount.get(r.crmWhatId) ?? { accountId: r.crmWhatId, accountName: r.crmWhatName, hours: 0, count: 0, oppIds: new Set<string>(), opps: new Map() }
            cur.hours += Number(r.effortHours)
            cur.count += 1
            cur.oppIds.add(r.crmWhatId)
            const oppCur = cur.opps.get(r.crmWhatId) ?? { oppId: r.crmWhatId, oppName: r.crmWhatName, hours: 0, count: 0 }
            oppCur.hours += Number(r.effortHours)
            oppCur.count += 1
            cur.opps.set(r.crmWhatId, oppCur)
            byAccount.set(r.crmWhatId, cur)
            continue
          }
          accountId = parent.accountId
          accountName = parent.accountName ?? r.crmWhatName
        }
      } else {
        continue
      }
      const cur = byAccount.get(accountId) ?? { accountId, accountName, hours: 0, count: 0, oppIds: new Set<string>(), opps: new Map() }
      cur.hours += Number(r.effortHours)
      cur.count += 1
      if (oppId) {
        cur.oppIds.add(oppId)
        const oppCur = cur.opps.get(oppId) ?? { oppId, oppName, hours: 0, count: 0 }
        oppCur.hours += Number(r.effortHours)
        oppCur.count += 1
        if (oppName) oppCur.oppName = oppName
        cur.opps.set(oppId, oppCur)
      }
      if (r.crmWhatType === 'Account' && r.crmWhatName) cur.accountName = r.crmWhatName
      byAccount.set(accountId, cur)
    }
    const rollupRows = Array.from(byAccount.values())
      .map((a) => ({
        crmWhatId: a.accountId,
        crmWhatName: a.accountName,
        crmWhatType: 'Account' as const,
        totalHours: String(a.hours),
        activityCount: a.count,
        rollupOppIds: Array.from(a.oppIds),
        // v1.117.0: per-Opp breakdown for the expandable row. Sorted
        // descending so the biggest burn shows first.
        oppBreakdown: Array.from(a.opps.values())
          .sort((x, y) => y.hours - x.hours)
          .map((o) => ({ oppId: o.oppId, oppName: o.oppName, totalHours: String(o.hours), activityCount: o.count })),
      }))
      .sort((x, y) => Number(y.totalHours) - Number(x.totalHours))
    res.json({ data: rollupRows, error: null, meta: { scope: 'account_rollup', droppedOppHours, droppedOppCount } })
    return
  }

  const rows = await db
    .select({
      crmWhatId: activities.crmWhatId,
      crmWhatName: activities.crmWhatName,
      crmWhatType: activities.crmWhatType,
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
      activityCount: sql<number>`count(*)`.as('activity_count'),
      maxAcv: sql<string>`max(${activities.acv})`.as('max_acv'),
      salesStage: sql<string | null>`max(${activities.salesStage})`.as('sales_stage'),
      forecastCategory: sql<string | null>`max(${activities.forecastCategory})`.as('forecast_category'),
    })
    .from(activities)
    .where(and(...conditions))
    .groupBy(activities.crmWhatId, activities.crmWhatName, activities.crmWhatType)
    .orderBy(desc(sql`sum(${activities.effortHours})`))

  // ACV range / Stage / Forecast: keep only Opportunity rows that match
  // (Accounts/other objects are dropped when any is active) — same
  // Opp-only convention as Most Expensive / Manager Rollup.
  const hasOppFilterBurn = acvRanges.length > 0 || stages.length > 0 || forecast.length > 0
  const burnData = (!hasOppFilterBurn
    ? rows
    : rows.filter((r) => {
        if (r.crmWhatType !== 'Opportunity') return false
        if (acvRanges.length > 0 && !amountInRanges(Number(r.maxAcv), acvRanges)) return false
        if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) return false
        if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) return false
        return true
      })
  ).map(({ maxAcv: _maxAcv, salesStage: _salesStage, forecastCategory: _forecastCategory, ...rest }) => rest)

  res.json({ data: burnData, error: null, meta: {} })
})

// GET /api/dashboards/products-breakdown?teamId=&weeks=&productIds=csv
// Returns per-product total hours + activity count. Also folds in a synthetic
// "(none)" row for activities that aren't linked to any product so the pie
// still totals 100%.
activityDashRoutes.get('/products-breakdown', requireDashboardAccess('productsBreakdown'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string
  const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 4)
  const weekShift = parseWeekShift(req.query['weekShift'])
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const productIdsFilter = (req.query['productIds'] as string | undefined)?.split(',').filter(Boolean) ?? []
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])

  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)
  const { products, activityProducts } = await import('../../../../drizzle/schema.js')

  const linkedConds = [
    inArray(activities.teamId, teamIds),
    eq(activities.isArchived, false),
    eq(activities.status, 'submitted'),
    ...dateWindow(dateBasis, rangeStart, rangeEnd),
  ]
  if (productIdsFilter.length > 0) linkedConds.push(inArray(activityProducts.productId, productIdsFilter))
  if (userId) linkedConds.push(eq(activities.userId, userId))
  if (memberIds.length > 0) linkedConds.push(inArray(activities.userId, memberIds))

  const linkedRows = await db
    .select({
      productId: products.id,
      productName: products.name,
      abbreviation: products.abbreviation,
      totalHours: sql<string>`sum(${activities.effortHours})`.as('total_hours'),
      activityCount: sql<number>`count(distinct ${activities.id})`.as('activity_count'),
    })
    .from(activities)
    .innerJoin(activityProducts, eq(activityProducts.activityId, activities.id))
    .innerJoin(products, eq(products.id, activityProducts.productId))
    .where(and(...linkedConds))
    .groupBy(products.id, products.name, products.abbreviation)
    .orderBy(desc(sql`sum(${activities.effortHours})`))

  // Per-product breakdown: (productId, activityTypeId, userId) hours + activityCount.
  // Used by the client to render segmented bars (by activity type) and the
  // per-member drill-down under each product row.
  const detailRows = linkedRows.length === 0 ? [] : await db
    .select({
      productId: activityProducts.productId,
      activityTypeId: activities.activityTypeId,
      activityTypeName: teamActivityTypes.name,
      activityTypeColor: teamActivityTypes.color,
      userId: activities.userId,
      userName: users.displayName,
      hours: sql<string>`sum(${activities.effortHours})`.as('hours'),
      activityCount: sql<number>`count(distinct ${activities.id})`.as('activity_count'),
    })
    .from(activities)
    .innerJoin(activityProducts, eq(activityProducts.activityId, activities.id))
    .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .innerJoin(users, eq(users.id, activities.userId))
    .where(and(...linkedConds))
    .groupBy(activityProducts.productId, activities.activityTypeId, teamActivityTypes.name, teamActivityTypes.color, activities.userId, users.displayName)

  // Aggregate per-product members + activity-type totals from detailRows.
  interface TypeAgg { id: string; name: string; color: string | null; hours: number }
  interface MemberAgg { userId: string; userName: string; hours: number; activityCount: number; byType: Record<string, number> }
  const perProduct = new Map<string, { members: Map<string, MemberAgg>; byType: Map<string, TypeAgg> }>()
  for (const r of detailRows) {
    let bucket = perProduct.get(r.productId)
    if (!bucket) { bucket = { members: new Map(), byType: new Map() }; perProduct.set(r.productId, bucket) }
    const hrs = Number(r.hours)
    let ta = bucket.byType.get(r.activityTypeId)
    if (!ta) { ta = { id: r.activityTypeId, name: r.activityTypeName ?? '—', color: r.activityTypeColor, hours: 0 }; bucket.byType.set(r.activityTypeId, ta) }
    ta.hours += hrs
    let mem = bucket.members.get(r.userId)
    if (!mem) { mem = { userId: r.userId, userName: r.userName ?? 'Unknown', hours: 0, activityCount: 0, byType: {} }; bucket.members.set(r.userId, mem) }
    mem.hours += hrs
    mem.activityCount += Number(r.activityCount)
    mem.byType[r.activityTypeId] = (mem.byType[r.activityTypeId] ?? 0) + hrs
  }

  const MEMBER_CAP = 20
  const enriched = linkedRows.map((row) => {
    const bucket = perProduct.get(row.productId)
    const byType = bucket ? Array.from(bucket.byType.values()).sort((a, b) => b.hours - a.hours) : []
    const membersAll = bucket ? Array.from(bucket.members.values()).sort((a, b) => b.hours - a.hours) : []
    const members = membersAll.slice(0, MEMBER_CAP)
    return {
      ...row,
      byType,
      members,
      memberTotal: membersAll.length,
      memberTruncated: membersAll.length > MEMBER_CAP,
    }
  })

  // Rows with no product link — only meaningful when no productIds filter is applied.
  let noneHours = 0
  let noneCount = 0
  if (productIdsFilter.length === 0) {
    const [none] = await db
      .select({
        totalHours: sql<string>`coalesce(sum(${activities.effortHours}), 0)`.as('total_hours'),
        activityCount: sql<number>`count(*)`.as('activity_count'),
      })
      .from(activities)
      .where(and(
        inArray(activities.teamId, teamIds),
        eq(activities.isArchived, false),
        eq(activities.status, 'submitted'),
        ...dateWindow(dateBasis, rangeStart, rangeEnd),
        sql`not exists (select 1 from ${activityProducts} ap where ap.activity_id = ${activities.id})`,
      ))
    noneHours = Number(none?.totalHours ?? 0)
    noneCount = Number(none?.activityCount ?? 0)
  }

  res.json({
    data: {
      products: enriched,
      unlinked: { totalHours: noneHours, activityCount: noneCount },
    },
    error: null,
    meta: {},
  })
})
