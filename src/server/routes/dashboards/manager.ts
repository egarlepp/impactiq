import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/index.js'
import {
  activities,
  teamActivityTypes,
  teams,
  users,
  subteams,
  subteamUsers,
  oppReviewDismissals,
} from '../../../../drizzle/schema.js'
import { getSfConnection } from '../../services/salesforce/client.js'
import { safeSoqlLiteral } from '../../services/salesforce/soql.js'
import { and, eq, sql, inArray } from 'drizzle-orm'
import { getFiscalConfig } from '../../services/config/fiscal.js'
import { resolveCostBatch } from '../../services/capacity/resolver.js'
import { loadSubteamAttribution, loadTeamRoster, UNASSIGNED_SUBTEAM_ID } from '../../services/dashboards/subteamAttribution.js'
import { countPeriodsInRangeWithConfig } from '../../services/dashboards/periodCounts.js'
import { requireRole, requireAnyLeaderOrAdmin, requireDashboardAccess, isAppAdmin } from '../../middleware/rbac.js'
import { getEvaluationSourceSetting, requireProjectsOn } from '../../services/criteriaiq/evaluationSource.js'
import { opportunitiesWithCriteriaIqProject } from '../../services/criteriaiq/primaryProjects.js'
import { CriteriaIqError } from '../../services/criteriaiq/client.js'

import {
  resolveTeamScope,
  parseDateBasis,
  resolveRange,
  dateWindow,
  parseProductIds,
  parseSubtypeIds,
  subtypeFilterCond,
  parseMemberIds,
  productFilterCond,
  parseAcvRanges,
  amountInRanges,
  acvRangesInUsd,
  loadFxByCurrency,
  toUsd,
  directCostUsd,
} from './shared.js'

export const managerDashRoutes = Router()

// GET /api/dashboards/manager-rollup?teamIds=csv&weeks=8
// Team-of-teams view for Directors / VPs. Aggregates the caller's accessible
// teams (or a subset via ?teamIds=) into a compact per-team row. Reuses the
// same rangeFor() window and effective-cost-rate coalesce as the Revenue
// endpoints, so numbers line up 1:1 with the per-team dashboards.
managerDashRoutes.get('/manager-rollup', requireAnyLeaderOrAdmin, async (req, res) => {
  // v1.131.0: wrap the whole endpoint so an internal error still
  // returns diagnostics to the client instead of a bare HTTP 500. The
  // client's amber Diagnostics box now surfaces the exception message
  // + stack trace so we can pinpoint the bad code path.
  try {
  const requested = (req.query['teamIds'] as string | undefined)?.split(',').filter(Boolean)
  const accessible = (await resolveTeamScope(req, undefined)) ?? []
  const scope = requested && requested.length > 0
    ? requested.filter((t) => accessible.includes(t))
    : accessible
  // v1.126.0: soft empty response so the client can render a helpful
  // "you have no accessible teams" empty state instead of a generic
  // "No data in this period" (previous behavior swallowed the 400 and
  // rendered the wrong copy).
  // v1.129.0: include diagnostics here too so the Diagnostics expander
  // in the client empty state always has something to show (previously
  // only the success path carried diagnostics, which is why the
  // expander never rendered when scope was empty).
  if (scope.length === 0) {
    // Peek at users.is_app_admin so the empty-state diagnostic tells
    // us WHY resolveTeamScope returned nothing (not app admin, no
    // team_members rows, no subteam roles).
    const [callerRow] = await db
      .select({ isAppAdmin: users.isAppAdmin })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1)
    const totalTeams = (await db.select({ id: teams.id }).from(teams)).length
    const activeTeams = (await db.select({ id: teams.id }).from(teams).where(eq(teams.isActive, true))).length
    res.json({
      data: [],
      error: null,
      meta: {
        weeks: 0,
        teamIds: [],
        reason: 'no_accessible_teams',
        diagnostics: {
          scopeSize: 0,
          teamRowsCount: 0,
          rawRowCount: 0,
          rangeStart: 'n/a',
          rangeEnd: 'n/a',
          callerIsAppAdmin: !!callerRow?.isAppAdmin,
          totalTeams,
          activeTeams,
          requestedTeamIds: requested ?? [],
          accessibleTeamIds: accessible,
        },
      },
    })
    return
  }
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const acvRanges = parseAcvRanges(req.query['acv'])
  const { rangeStart, rangeEnd } = resolveRange(req)
  // v1.245.0: Products / Stage / Forecast / Subteam / Team-member chips render
  // for the Manager group but previously had zero effect on this endpoint's
  // output — see CLAUDE.md §13. Wired the same way ProjectCosting/AttachRate
  // already apply them.
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const userIdMr = typeof req.query['userId'] === 'string' && req.query['userId'] ? req.query['userId'] : null
  const userIdsMr = String(req.query['userIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  // Per-team aggregates: hours, cost, activity count, unique contributors,
  // unique opps. Cost is resolved per-activity via the resolver so
  // historical activities use the rate that was in effect at their time.
  const rawRows = await db
    .select({
      userId: activities.userId,
      teamId: activities.teamId,
      startDatetime: activities.startDatetime,
      effortHours: activities.effortHours,
      costTransportation: activities.costTransportation,
      costLodging: activities.costLodging,
      costFood: activities.costFood,
      incidentalCurrency: activities.incidentalCurrency,
      acv: activities.acv,
      crmWhatId: activities.crmWhatId,
      // v1.133.0: pull crm_what_type + crm_who_id/type + crm_account_id/name so
      // the endpoint can split unique-linked-object counts by SF type
      // (Accounts / Campaigns / Leads / Opps) and roll up "most
      // expensive Account" from each Opp's parent Account.
      crmWhatType: activities.crmWhatType,
      crmWhatName: activities.crmWhatName,
      crmWhoId: activities.crmWhoId,
      crmWhoType: activities.crmWhoType,
      crmWhoName: activities.crmWhoName,
      crmAccountId: activities.crmAccountId,
      crmAccountName: activities.crmAccountName,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
    })
    .from(activities)
    .where(and(
      inArray(activities.teamId, scope),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
      ...(userIdMr ? [eq(activities.userId, userIdMr)] : []),
      ...(userIdsMr.length > 0 ? [inArray(activities.userId, userIdsMr)] : []),
    ))

  const costResolved = await resolveCostBatch(rawRows.map((r) => ({
    userId: r.userId, teamId: r.teamId, asOf: new Date(r.startDatetime),
  })))
  const fx = await loadFxByCurrency()

  // ACV range / Stage / Forecast: when any is active, every aggregate here
  // counts ONLY Opportunity activity that matches all three — non-Opp rows
  // (accounts, campaigns, leads, account-direct) drop out. Cost tab → bucket
  // bounds are nominal in the display currency, mapped back to USD. Filter
  // rawRows once and reuse the result in every loop below so hours/cost/
  // counts/ACV stay consistent.
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, fx)
  const hasOppFilterMr = acvRanges.length > 0 || stages.length > 0 || forecast.length > 0
  const oppMaxAcvMr = new Map<string, number>()
  if (hasOppFilterMr) {
    for (const r of rawRows) {
      if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
        const v = Number(r.acv ?? 0)
        if (v > (oppMaxAcvMr.get(r.crmWhatId) ?? 0)) oppMaxAcvMr.set(r.crmWhatId, v)
      }
    }
  }
  const mrRows = !hasOppFilterMr
    ? rawRows
    : rawRows.filter((r) => {
        if (r.crmWhatType !== 'Opportunity' || !r.crmWhatId) return false
        if (acvRanges.length > 0 && !amountInRanges(oppMaxAcvMr.get(r.crmWhatId) ?? 0, usdAcvRanges)) return false
        if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) return false
        if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) return false
        return true
      })

  interface Agg {
    teamId: string
    hours: number
    costDollars: number
    directCostsUsd: number
    activityCount: number
    contributors: Set<string>
    opps: Set<string>
    accounts: Set<string>
    campaigns: Set<string>
    leads: Set<string>
  }
  const byTeam = new Map<string, Agg>()
  for (const r of mrRows) {
    const cur = byTeam.get(r.teamId) ?? { teamId: r.teamId, hours: 0, costDollars: 0, directCostsUsd: 0, activityCount: 0, contributors: new Set(), opps: new Set(), accounts: new Set(), campaigns: new Set(), leads: new Set() }
    const resolvedCost = costResolved.get(`${r.userId}::${r.teamId}`)
    const rate = resolvedCost?.rate ?? 0
    const h = Number(r.effortHours)
    const direct = directCostUsd(r, fx)
    cur.hours += h
    // costDollars = labor (FX→USD) + direct costs (FX→USD).
    cur.costDollars += toUsd(h * rate, resolvedCost?.currency, fx) + direct
    cur.directCostsUsd += direct
    cur.activityCount += 1
    cur.contributors.add(r.userId)
    // v1.133.0: split unique-linked-object counts by SF type. Opps and
    // Campaigns live on crmWhatType; Leads on crmWhoType. For Accounts we
    // count DIRECT account links AND every Opp's parent account (from
    // crmAccountId snapshot) so a team logging only Opp activity still
    // shows accounts touched.
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) cur.opps.add(r.crmWhatId)
    if (r.crmWhatType === 'Campaign' && r.crmWhatId) cur.campaigns.add(r.crmWhatId)
    if (r.crmWhoType === 'Lead' && r.crmWhoId) cur.leads.add(r.crmWhoId)
    if (r.crmWhatType === 'Account' && r.crmWhatId) cur.accounts.add(r.crmWhatId)
    if (r.crmWhatType === 'Opportunity' && r.crmAccountId) cur.accounts.add(r.crmAccountId)
    byTeam.set(r.teamId, cur)
  }
  const rows = Array.from(byTeam.values()).map((a) => ({
    teamId: a.teamId,
    hours: String(a.hours),
    costDollars: String(a.costDollars),
    activityCount: a.activityCount,
    uniqueContributors: a.contributors.size,
    uniqueOpps: a.opps.size,
    uniqueAccounts: a.accounts.size,
    uniqueCampaigns: a.campaigns.size,
    uniqueLeads: a.leads.size,
  }))

  // Per-team ACV — sum(max(acv) grouped by opp) so a chatty opp doesn't
  // multi-count its ACV.
  // v1.132.0: the outer select / group by referenced `activities.teamId`,
  // but the outer FROM is the `per_opp` subquery, so drizzle threw
  // `Your "teamId" field references a column "activities"."team_id",
  // but the table "activities" is not part of the query!`. Compute
  // the per-team sum in JavaScript from a flat `per_opp` result set
  // instead — same math, no drizzle subquery alias plumbing needed.
  const perOppRows = await db
    .select({
      teamId: activities.teamId,
      crmWhatId: activities.crmWhatId,
      maxAcv: sql<string>`max(${activities.acv})`.as('max_acv'),
    })
    .from(activities)
    .where(and(
      inArray(activities.teamId, scope),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      sql`${activities.crmWhatId} IS NOT NULL`,
      eq(activities.crmWhatType, 'Opportunity'),
    ))
    .groupBy(activities.teamId, activities.crmWhatId)
  const perOppRowsFiltered = acvRanges.length === 0
    ? perOppRows
    : perOppRows.filter((r) => amountInRanges(Number(r.maxAcv), usdAcvRanges))
  const acvByTeam = new Map<string, number>()
  for (const r of perOppRowsFiltered) {
    const v = Number(r.maxAcv ?? 0)
    acvByTeam.set(r.teamId, (acvByTeam.get(r.teamId) ?? 0) + v)
  }
  const acvRows = Array.from(acvByTeam.entries()).map(([teamId, sumAcv]) => ({ teamId, sumAcv: String(sumAcv) }))

  // Team names for display.
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, scope))

  const nameById = new Map(teamRows.map((r) => [r.id, r.name] as const))
  const acvById = new Map<string, number>(acvRows.map((r) => [r.teamId, Number(r.sumAcv ?? 0)] as [string, number]))

  const enriched = rows.map((r) => ({
    teamId: r.teamId,
    teamName: nameById.get(r.teamId) ?? r.teamId,
    hours: Number(r.hours ?? 0),
    costDollars: Number(r.costDollars ?? 0),
    acv: acvById.get(r.teamId) ?? 0,
    activityCount: Number(r.activityCount ?? 0),
    uniqueContributors: Number(r.uniqueContributors ?? 0),
    uniqueOpps: Number(r.uniqueOpps ?? 0),
    uniqueAccounts: Number(r.uniqueAccounts ?? 0),
    uniqueCampaigns: Number(r.uniqueCampaigns ?? 0),
    uniqueLeads: Number(r.uniqueLeads ?? 0),
  }))

  // Include teams that have zero activity in the range so the UI can still
  // show them (as an implicit signal that the team is under-reporting).
  for (const t of teamRows) {
    if (!enriched.some((r) => r.teamId === t.id)) {
      enriched.push({ teamId: t.id, teamName: t.name, hours: 0, costDollars: 0, acv: 0, activityCount: 0, uniqueContributors: 0, uniqueOpps: 0, uniqueAccounts: 0, uniqueCampaigns: 0, uniqueLeads: 0 })
    }
  }
  enriched.sort((a, b) => b.hours - a.hours)

  // v1.133.0: rolled-up ACV per account (via each Opp's parent
  // crmAccountId) and per user (via activities.userId + linked opp's
  // max ACV). Duplicate opp rows across users are counted once per
  // (opp,user) to preserve the "who worked on it" attribution — one
  // opp with 3 users each puts full ACV against all 3.
  const oppMaxAcv = new Map<string, number>()
  for (const r of perOppRowsFiltered) {
    const key = String(r.crmWhatId ?? '')
    if (!key) continue
    const v = Number(r.maxAcv ?? 0)
    if (v > (oppMaxAcv.get(key) ?? 0)) oppMaxAcv.set(key, v)
  }
  // v1.136.0: Most-Expensive-Account KPI is now driven by ACTIVITY COST
  // (sum of effortHours * resolved cost rate) attributed to the account —
  // either directly (crmWhatType='Account') or via each Opp's parent
  // crmAccountId. ACV is no longer used for this KPI. Biggest-Impact
  // still ranks users by ACV touched.
  const acctCost = new Map<string, { name: string | null; cost: number }>()
  const userAcv = new Map<string, { acv: number }>()
  const seenOppByUser = new Map<string, Set<string>>()
  const userDisplayName = new Map<string, string>()
  for (const r of mrRows) {
    const rc = costResolved.get(`${r.userId}::${r.teamId}`)
    const activityCost = toUsd(Number(r.effortHours) * (rc?.rate ?? 0), rc?.currency, fx) + directCostUsd(r, fx)
    // Per-account cost: sum activity cost (labor + direct, USD) against direct
    // Account links AND each Opp's parent Account snapshot.
    const acctBuckets: Array<{ id: string; name: string | null }> = []
    if (r.crmWhatType === 'Account' && r.crmWhatId) acctBuckets.push({ id: r.crmWhatId, name: r.crmWhatName ?? null })
    if (r.crmWhatType === 'Opportunity' && r.crmAccountId) acctBuckets.push({ id: r.crmAccountId, name: r.crmAccountName ?? null })
    for (const b of acctBuckets) {
      const cur = acctCost.get(b.id) ?? { name: b.name, cost: 0 }
      cur.cost += activityCost
      if (!cur.name && b.name) cur.name = b.name
      acctCost.set(b.id, cur)
    }
    // Per-user ACV: attribute once per (user, opp), same as before.
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
      const oppAcv = oppMaxAcv.get(r.crmWhatId) ?? 0
      if (oppAcv > 0) {
        const seenU = seenOppByUser.get(r.userId) ?? new Set<string>()
        if (!seenU.has(r.crmWhatId)) {
          seenU.add(r.crmWhatId)
          seenOppByUser.set(r.userId, seenU)
          const cur = userAcv.get(r.userId) ?? { acv: 0 }
          cur.acv += oppAcv
          userAcv.set(r.userId, cur)
        }
      }
    }
  }
  // Resolve user display names in one shot.
  const userIdsWithAcv = Array.from(userAcv.keys())
  if (userIdsWithAcv.length > 0) {
    const uRows = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, userIdsWithAcv))
    for (const u of uRows) userDisplayName.set(u.id, u.displayName ?? '')
  }
  const mostExpensiveAccount = Array.from(acctCost.entries())
    .map(([id, v]) => ({ id, name: v.name, cost: v.cost }))
    .filter((r) => r.cost > 0)
    .sort((a, b) => b.cost - a.cost)[0] ?? null
  const topUser = Array.from(userAcv.entries())
    .map(([id, v]) => ({ id, displayName: userDisplayName.get(id) ?? id, acv: v.acv }))
    .sort((a, b) => b.acv - a.acv)[0] ?? null

  // v1.126.0: subteam breakdown per team. Groups the same `rawRows`
  // pool by (teamId, subteamId) using subteam_users membership. A user
  // may belong to zero, one, or many subteams; when zero, their
  // activities roll up under an "Unassigned" subteam bucket per team.
  const subteamRows = await db
    .select({ id: subteams.id, teamId: subteams.teamId, name: subteams.name, isActive: subteams.isActive, parentSubteamId: subteams.parentSubteamId })
    .from(subteams)
    .where(inArray(subteams.teamId, scope))
  const activeSubteams = subteamRows.filter((s) => s.isActive)
  const subById = new Map(activeSubteams.map((s) => [s.id, s]))
  // Depth (top-level = 1) walking active ancestors; inactive parents break the
  // chain (child becomes a root among active subteams).
  const depthOf = (id: string): number => {
    let d = 1
    const guard = new Set<string>([id])
    let cur = subById.get(id)?.parentSubteamId ?? null
    while (cur && subById.has(cur) && !guard.has(cur)) { d += 1; guard.add(cur); cur = subById.get(cur)!.parentSubteamId ?? null }
    return d
  }
  // Active children per subteam (parent must also be active to count).
  const childrenOf = new Map<string, string[]>()
  for (const s of activeSubteams) {
    if (s.parentSubteamId && subById.has(s.parentSubteamId)) {
      const arr = childrenOf.get(s.parentSubteamId) ?? []
      arr.push(s.id)
      childrenOf.set(s.parentSubteamId, arr)
    }
  }
  const userSubteamRows = await db
    .select({ userId: subteamUsers.userId, subteamId: subteamUsers.subteamId })
    .from(subteamUsers)
    .where(inArray(subteamUsers.subteamId, activeSubteams.map((s) => s.id).length > 0 ? activeSubteams.map((s) => s.id) : ['00000000-0000-0000-0000-000000000000']))
  const subteamsByUser = new Map<string, Set<string>>()
  for (const r of userSubteamRows) {
    const s = subteamsByUser.get(r.userId) ?? new Set<string>()
    s.add(r.subteamId)
    subteamsByUser.set(r.userId, s)
  }
  // Leaf aggregation: each activity is attributed ONCE, to the user's DEEPEST
  // subteam in that team (tie → alphabetically-first). No even-split. Parents'
  // totals are computed by rolling up descendants below, so a user in both a
  // parent and child subteam is never double-counted.
  interface SubLeaf { hours: number; costDollars: number; activityCount: number; contributors: Set<string>; opps: Set<string>; accounts: Set<string>; leads: Set<string>; campaigns: Set<string> }
  const newLeaf = (): SubLeaf => ({ hours: 0, costDollars: 0, activityCount: 0, contributors: new Set(), opps: new Set(), accounts: new Set(), leads: new Set(), campaigns: new Set() })
  const leafByTeam = new Map<string, Map<string, SubLeaf>>() // key = subteamId | '__unassigned__'
  for (const r of mrRows) {
    const rc = costResolved.get(`${r.userId}::${r.teamId}`)
    const h = Number(r.effortHours)
    const activityCostUsd = toUsd(h * (rc?.rate ?? 0), rc?.currency, fx) + directCostUsd(r, fx)
    const teamSubs = subteamsByUser.get(r.userId)
    const hits = teamSubs ? activeSubteams.filter((s) => s.teamId === r.teamId && teamSubs.has(s.id)) : []
    let key = '__unassigned__'
    if (hits.length > 0) {
      const best = hits
        .map((s) => ({ s, d: depthOf(s.id) }))
        .sort((a, b) => b.d - a.d || a.s.name.localeCompare(b.s.name))[0]!.s
      key = best.id
    }
    const perTeam = leafByTeam.get(r.teamId) ?? new Map<string, SubLeaf>()
    const cur = perTeam.get(key) ?? newLeaf()
    cur.hours += h
    cur.costDollars += activityCostUsd
    cur.activityCount += 1
    cur.contributors.add(r.userId)
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) cur.opps.add(r.crmWhatId)
    if (r.crmWhatType === 'Account' && r.crmWhatId) cur.accounts.add(r.crmWhatId)
    if (r.crmWhatType === 'Opportunity' && r.crmAccountId) cur.accounts.add(r.crmAccountId)
    if (r.crmWhatType === 'Campaign' && r.crmWhatId) cur.campaigns.add(r.crmWhatId)
    if (r.crmWhoType === 'Lead' && r.crmWhoId) cur.leads.add(r.crmWhoId)
    perTeam.set(key, cur)
    leafByTeam.set(r.teamId, perTeam)
  }
  // Roll up: a node's totals = its own leaf + the recursive sum/union of all
  // descendant leaves. ACV = sum of max-ACV over the subtree's unique opps.
  interface SubNode { subteamId: string | null; subteamName: string; parentSubteamId: string | null; depth: number; hours: number; costDollars: number; activityCount: number; acv: number; uniqueContributors: number; uniqueOpps: number; uniqueAccounts: number; uniqueLeads: number; uniqueCampaigns: number }
  const subteamBreakdownByTeam = new Map<string, SubNode[]>()
  for (const teamId of scope) {
    const leaves = leafByTeam.get(teamId) ?? new Map<string, SubLeaf>()
    const teamSubteams = activeSubteams.filter((s) => s.teamId === teamId)
    // Recursively gather a subtree's merged aggregate.
    const rollup = (id: string, guard = new Set<string>()): SubLeaf => {
      const acc = newLeaf()
      if (guard.has(id)) return acc
      guard.add(id)
      const self = leaves.get(id)
      const merge = (src?: SubLeaf) => {
        if (!src) return
        acc.hours += src.hours; acc.costDollars += src.costDollars; acc.activityCount += src.activityCount
        for (const x of src.contributors) acc.contributors.add(x)
        for (const x of src.opps) acc.opps.add(x)
        for (const x of src.accounts) acc.accounts.add(x)
        for (const x of src.leads) acc.leads.add(x)
        for (const x of src.campaigns) acc.campaigns.add(x)
      }
      merge(self)
      for (const child of childrenOf.get(id) ?? []) merge(rollup(child, guard))
      return acc
    }
    const acvOf = (opps: Set<string>): number => { let a = 0; for (const o of opps) a += oppMaxAcv.get(o) ?? 0; return a }
    const nodes: SubNode[] = []
    const emit = (id: string) => {
      const s = subById.get(id)!
      const agg = rollup(id)
      if (agg.activityCount > 0) {
        nodes.push({
          subteamId: id, subteamName: s.name, parentSubteamId: s.parentSubteamId && subById.has(s.parentSubteamId) ? s.parentSubteamId : null,
          depth: depthOf(id), hours: Math.round(agg.hours * 100) / 100, costDollars: Math.round(agg.costDollars * 100) / 100,
          activityCount: agg.activityCount, acv: acvOf(agg.opps), uniqueContributors: agg.contributors.size,
          uniqueOpps: agg.opps.size, uniqueAccounts: agg.accounts.size, uniqueLeads: agg.leads.size, uniqueCampaigns: agg.campaigns.size,
        })
      }
      ;(childrenOf.get(id) ?? [])
        .map((cid) => subById.get(cid)!)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((c) => emit(c.id))
    }
    // Depth-first from active roots (no active parent), alpha-sorted.
    teamSubteams
      .filter((s) => !s.parentSubteamId || !subById.has(s.parentSubteamId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((s) => emit(s.id))
    // "Unassigned" bucket last (flat, no nesting).
    const un = leaves.get('__unassigned__')
    if (un && un.activityCount > 0) {
      nodes.push({
        subteamId: null, subteamName: 'Unassigned', parentSubteamId: null, depth: 1,
        hours: Math.round(un.hours * 100) / 100, costDollars: Math.round(un.costDollars * 100) / 100,
        activityCount: un.activityCount, acv: acvOf(un.opps), uniqueContributors: un.contributors.size,
        uniqueOpps: un.opps.size, uniqueAccounts: un.accounts.size, uniqueLeads: un.leads.size, uniqueCampaigns: un.campaigns.size,
      })
    }
    if (nodes.length > 0) subteamBreakdownByTeam.set(teamId, nodes)
  }

  // v1.131.0: pre-compute the raw activity counts outside the response
  // literal. Wrapping each in try/catch so a single query failure
  // doesn't blow up the whole endpoint (which is what caused the
  // HTTP 500 seen in v1.129 / v1.130).
  let activitiesInScopeAllTime: number | string = 'unknown'
  let activitiesInScopeSubmitted: number | string = 'unknown'
  try {
    activitiesInScopeAllTime = (await db.select({ id: activities.id }).from(activities).where(inArray(activities.teamId, scope))).length
  } catch (e) {
    activitiesInScopeAllTime = `error: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    activitiesInScopeSubmitted = (await db.select({ id: activities.id }).from(activities).where(and(inArray(activities.teamId, scope), eq(activities.status, 'submitted'), eq(activities.isArchived, false)))).length
  } catch (e) {
    activitiesInScopeSubmitted = `error: ${e instanceof Error ? e.message : String(e)}`
  }

  // v1.128.0: rich diagnostic meta so the client empty state can
  // explain WHY it's empty (scope resolved to 0 teams? teams had 0
  // matching rows? window off?). Shown in the DashboardEmptyState.
  res.json({
    data: enriched,
    error: null,
    meta: {
      weeks: weeksBack,
      teamIds: scope,
      subteamsByTeam: Object.fromEntries(subteamBreakdownByTeam),
      mostExpensiveAccount,
      topUser,
      diagnostics: {
        scopeSize: scope.length,
        teamRowsCount: teamRows.length,
        rawRowCount: rawRows.length,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
        accessibleTeamIds: accessible,
        activitiesInScopeAllTime,
        activitiesInScopeSubmitted,
        // v1.129.0: peek at the raw activities table (ignoring window,
        // status, archived) so we can tell if activities exist at all
        // under the resolved scope. If activitiesInScopeAllTime > 0 but
        // rawRowCount === 0, the range or the submitted filter is the
        // problem, not team scope.
        // v1.131.0: pre-compute these OUTSIDE the response literal so
        // an error here doesn't surface as HTTP 500 and blow up the
        // entire response. If they throw, we surface null and continue.
      },
    },
  })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error('[manager-rollup] endpoint failed:', message, stack)
    // v1.289.0: security audit finding D1 — errorStack leaked internal file
    // paths / call-stack detail to any Team Leader, in every environment.
    // Kept for App Admins only (still useful for diagnosing a real
    // misconfiguration without needing server log access); everyone else
    // gets the message alone.
    const callerIsAppAdmin = req.user ? await isAppAdmin(req.user.id) : false
    res.json({
      data: [],
      error: `manager-rollup failed: ${message}`,
      meta: {
        weeks: 0,
        teamIds: [],
        reason: 'endpoint_error',
        diagnostics: {
          errorMessage: message,
          ...(callerIsAppAdmin ? { errorStack: (stack ?? '').split('\n').slice(0, 8).join('\n') } : {}),
        },
      },
    })
  }
})

// ─── Team Activity Deep-Dive (v1.245.0) ────────────────────────────────────
// Manager-group, but unlike its two cross-team siblings this one is deliberately
// SINGLE-team scoped: a concrete `teamId` is required. Activity types are rows
// scoped to exactly one team (schema: unique(teamId, name)), and per the human
// review of this feature, the point is drilling into ONE team's own activity
// mix by Subteam and by user — not aggregating same-named types across teams.
//
// Row hierarchy is fixed at exactly three tiers: Activity Type -> Subteam ->
// User. "Subteam" here is always the user's DEEPEST matching subteam (or
// Unassigned) via loadSubteamAttribution — this dashboard does not expand the
// app's separate arbitrary-depth subteam-of-subteam hierarchy into extra tiers.
//
// The roster (which Activity Types / Subteams / Users appear as rows) is
// independent of the content filters (Products/Stage/Forecast/ACV/date) —
// every active type and every current team member shows up, even at zero,
// per an explicit product decision to make "nothing happened here" visible
// rather than silently absent. The Subteam and Team-member filters DO narrow
// the roster (picking one subteam or one user is a request to see only that
// slice), which is why they're read here as plain `subteamId`/`userId`
// params rather than the generic pre-resolved `userIds` list ProjectCosting/
// AttachRate use — this dashboard needs to know which SUBTEAM was picked, not
// just which users fell out of it, because Subteam is a row axis here, not
// just a content filter.
managerDashRoutes.get('/team-activity-deep-dive', requireDashboardAccess('teamActivityDeepDive'), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  if (!teamId || teamId === 'all') {
    res.status(400).json({ data: null, error: 'errors.validation.team_required', meta: {} })
    return
  }

  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const { rangeStart, rangeEnd } = resolveRange(req)
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const subteamIdParam = typeof req.query['subteamId'] === 'string' && req.query['subteamId'] ? req.query['subteamId'] : null
  const userIdParam = typeof req.query['userId'] === 'string' && req.query['userId'] ? req.query['userId'] : null
  // v1.265.0: multi-select superset of the two single-value params above —
  // OR'd together rather than replacing them, so a caller that only ever
  // sent the singular params keeps working unchanged. Multiple subteams
  // means "show only these branches of the tree" (still narrows the
  // roster — an unlisted subteam disappears rather than showing at zero).
  const subteamIdsParam = parseMemberIds(req.query['subteamIds'])
  const memberIdsParam = parseMemberIds(req.query['userIds'])
  // v1.267.0: Subtype is a content filter here (unlike Subteam/Member above),
  // same as every other dashboard — it narrows which activities count at
  // every tier rather than acting as a roster axis.
  const subtypeIds = parseSubtypeIds(req.query['subtypeIds'])
  const subtypeCond = subtypeFilterCond(subtypeIds)

  // ── Roster: active types, subteam attribution, current team members ──────
  const activeTypes = await db
    .select({ id: teamActivityTypes.id, name: teamActivityTypes.name, color: teamActivityTypes.color, icon: teamActivityTypes.icon, sortOrder: teamActivityTypes.sortOrder })
    .from(teamActivityTypes)
    .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.isActive, true)))
    .orderBy(teamActivityTypes.sortOrder)

  const attribution = await loadSubteamAttribution([teamId])
  let rosterUserIds = (await loadTeamRoster(teamId)).map((r) => r.userId)

  // Subteam filter narrows the roster to just that subteam's (or Unassigned's)
  // members — the OTHER subteams disappear entirely rather than showing at
  // zero, because picking one is an explicit request to see only that slice.
  const subteamIdSet = subteamIdParam ? [subteamIdParam, ...subteamIdsParam] : subteamIdsParam
  if (subteamIdSet.length > 0) {
    const allowed = new Set(subteamIdSet)
    rosterUserIds = rosterUserIds.filter((uid) => {
      const best = attribution.bestSubteamOf(uid, teamId)
      return allowed.has(UNASSIGNED_SUBTEAM_ID) && best === null ? true : (best != null && allowed.has(best.id))
    })
  }
  const memberIdSet = userIdParam ? [userIdParam, ...memberIdsParam] : memberIdsParam
  if (memberIdSet.length > 0) {
    const allowed = new Set(memberIdSet)
    rosterUserIds = rosterUserIds.filter((uid) => allowed.has(uid))
  }

  if (activeTypes.length === 0 || rosterUserIds.length === 0) {
    res.json({ data: [], error: null, meta: { periodCounts: { weeks: 1, months: 1, quarters: 1, years: 1 } } })
    return
  }

  const rosterUsers = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, rosterUserIds))
  const userNameById = new Map(rosterUsers.map((u) => [u.id, u.displayName]))
  // userId -> their fixed subteam bucket for THIS report. Computed once so
  // every leaf/rollup below reads the same attribution rather than
  // re-resolving it per activity row.
  const subteamKeyOf = new Map<string, string>()
  const subteamNameByKey = new Map<string, string>([[UNASSIGNED_SUBTEAM_ID, 'Unassigned']])
  for (const s of attribution.activeSubteams) subteamNameByKey.set(s.id, s.name)
  for (const uid of rosterUserIds) {
    const best = attribution.bestSubteamOf(uid, teamId)
    subteamKeyOf.set(uid, best?.id ?? UNASSIGNED_SUBTEAM_ID)
  }

  // ── Activity data ─────────────────────────────────────────────────────────
  const typeIds = activeTypes.map((t) => t.id)
  const rawRows = await db
    .select({
      userId: activities.userId,
      activityTypeId: activities.activityTypeId,
      effortHours: activities.effortHours,
      acv: activities.acv,
      crmWhatId: activities.crmWhatId,
      crmWhatType: activities.crmWhatType,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
      subtypeName: activities.subtypeName,
    })
    .from(activities)
    .where(and(
      eq(activities.teamId, teamId),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      inArray(activities.activityTypeId, typeIds),
      inArray(activities.userId, rosterUserIds),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
      ...(subtypeCond ? [subtypeCond] : []),
    ))

  const fx = await loadFxByCurrency()
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, fx)
  // Max ACV per Opportunity across the whole fetched set, so a chatty opp
  // doesn't multi-count its ACV once summed across rows/rollups.
  const oppMaxAcvAll = new Map<string, number>()
  for (const r of rawRows) {
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
      const v = Number(r.acv ?? 0)
      if (v > (oppMaxAcvAll.get(r.crmWhatId) ?? 0)) oppMaxAcvAll.set(r.crmWhatId, v)
    }
  }
  const hasContentFilter = stages.length > 0 || forecast.length > 0 || acvRanges.length > 0

  // v1.245.0: deliberately DIFFERENT from ProjectCosting/most-expensive's
  // convention of dropping every non-Opportunity row outright when a Stage/
  // Forecast/ACV filter is active. Per explicit product decision for this
  // dashboard: those filters narrow which OPPORTUNITIES qualify (so a
  // non-matching Opportunity-linked activity is excluded, same as everywhere
  // else), but an activity with NO Opportunity link always counts toward
  // Total Count / Duration / the per-period averages regardless — it simply
  // never had a stage/forecast/ACV to filter on. It still never contributes
  // to the ACV or Count-Per-Oppty columns, which is a property of having no
  // linked Opportunity, not of the filter state.
  function passesContentFilter(r: (typeof rawRows)[number]): boolean {
    if (!hasContentFilter) return true
    if (r.crmWhatType !== 'Opportunity' || !r.crmWhatId) return true
    if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) return false
    if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) return false
    if (acvRanges.length > 0 && !amountInRanges(oppMaxAcvAll.get(r.crmWhatId) ?? 0, usdAcvRanges)) return false
    return true
  }

  interface Acc {
    totalCount: number
    totalHours: number
    oppLinkedCount: number
    oppIds: Set<string>
  }
  function emptyAcc(): Acc { return { totalCount: 0, totalHours: 0, oppLinkedCount: 0, oppIds: new Set() } }
  function mergeInto(target: Acc, src: Acc): void {
    target.totalCount += src.totalCount
    target.totalHours += src.totalHours
    target.oppLinkedCount += src.oppLinkedCount
    for (const id of src.oppIds) target.oppIds.add(id)
  }

  // Leaf key: type|subteamKey|userId. Seeded for EVERY roster combination up
  // front (types x users, each user's subteamKey fixed) so a zero-activity
  // combination still gets a row, per the "show all configured rows" decision.
  const leaves = new Map<string, Acc>()
  const leafMeta = new Map<string, { activityTypeId: string; subteamKey: string; userId: string }>()
  // v1.267.0: Subtype breakdown per leaf (Type|Subteam|User) — unlike the
  // Type/Subteam/User tiers above, this is NOT seeded for every combination:
  // Subtypes are opt-in per team and per-activity, so a leaf with none gets
  // no entry at all here, which is exactly what the client uses to decide
  // whether to render a 4th-tier chevron for that user (see /breakdown's
  // identical convention in ActivityBreakdown.tsx).
  const leafSubtypeAcc = new Map<string, Map<string, Acc>>()
  for (const t of activeTypes) {
    for (const uid of rosterUserIds) {
      const key = `${t.id}|${subteamKeyOf.get(uid)}|${uid}`
      leaves.set(key, emptyAcc())
      leafMeta.set(key, { activityTypeId: t.id, subteamKey: subteamKeyOf.get(uid)!, userId: uid })
    }
  }
  for (const r of rawRows) {
    if (!passesContentFilter(r)) continue
    const subKey = subteamKeyOf.get(r.userId)
    if (subKey === undefined) continue // not in the (possibly narrowed) roster
    const key = `${r.activityTypeId}|${subKey}|${r.userId}`
    const acc = leaves.get(key)
    if (!acc) continue // activity type not active, or user not in roster
    acc.totalCount += 1
    acc.totalHours += Number(r.effortHours)
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
      acc.oppLinkedCount += 1
      acc.oppIds.add(r.crmWhatId)
    }
    if (r.subtypeName) {
      const bySubtype = leafSubtypeAcc.get(key) ?? new Map<string, Acc>()
      const subAcc = bySubtype.get(r.subtypeName) ?? emptyAcc()
      subAcc.totalCount += 1
      subAcc.totalHours += Number(r.effortHours)
      if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
        subAcc.oppLinkedCount += 1
        subAcc.oppIds.add(r.crmWhatId)
      }
      bySubtype.set(r.subtypeName, subAcc)
      leafSubtypeAcc.set(key, bySubtype)
    }
  }

  // Roll up leaves -> subteam-level -> type-level. ACV is NOT summed from
  // children's already-computed numbers (that would double-count an
  // Opportunity touched by two different users in the same subteam) — every
  // level unions the underlying oppIds sets and re-derives ACV from
  // oppMaxAcvAll at display time, same MAX-per-opportunity rule used
  // everywhere else in this file.
  const subteamAcc = new Map<string, Acc>()
  const typeAcc = new Map<string, Acc>()
  for (const [key, acc] of leaves) {
    const m = leafMeta.get(key)!
    const subKey = `${m.activityTypeId}|${m.subteamKey}`
    const tKey = m.activityTypeId
    if (!subteamAcc.has(subKey)) subteamAcc.set(subKey, emptyAcc())
    mergeInto(subteamAcc.get(subKey)!, acc)
    if (!typeAcc.has(tKey)) typeAcc.set(tKey, emptyAcc())
    mergeInto(typeAcc.get(tKey)!, acc)
  }

  const periodCounts = countPeriodsInRangeWithConfig(rangeStart, rangeEnd, await getFiscalConfig())

  function acvOf(acc: Acc): number {
    let total = 0
    for (const id of acc.oppIds) total += oppMaxAcvAll.get(id) ?? 0
    return total
  }
  function toMetrics(acc: Acc) {
    return {
      totalCount: acc.totalCount,
      totalHours: acc.totalHours,
      avgDurationHours: acc.totalCount > 0 ? acc.totalHours / acc.totalCount : 0,
      totalAcv: acvOf(acc),
      avgCountPerOppty: acc.oppIds.size > 0 ? acc.oppLinkedCount / acc.oppIds.size : 0,
      avgPerWeek: acc.totalCount / periodCounts.weeks,
      avgPerMonth: acc.totalCount / periodCounts.months,
      avgPerQuarter: acc.totalCount / periodCounts.quarters,
      avgPerYear: acc.totalCount / periodCounts.years,
    }
  }

  interface OutRow {
    id: string
    name: string
    parentId: string | null
    depth: number
    metrics: ReturnType<typeof toMetrics>
  }
  const out: OutRow[] = []
  const sortedTypes = [...activeTypes].sort((a, b) => (typeAcc.get(b.id)?.totalCount ?? 0) - (typeAcc.get(a.id)?.totalCount ?? 0))
  for (const t of sortedTypes) {
    const tId = `type:${t.id}`
    out.push({ id: tId, name: t.name, parentId: null, depth: 0, metrics: toMetrics(typeAcc.get(t.id) ?? emptyAcc()) })

    const subKeysForType = Array.from(subteamAcc.keys()).filter((k) => k.startsWith(`${t.id}|`)).map((k) => k.slice(t.id.length + 1))
    const sortedSubKeys = subKeysForType.sort((a, b) => (subteamAcc.get(`${t.id}|${b}`)?.totalCount ?? 0) - (subteamAcc.get(`${t.id}|${a}`)?.totalCount ?? 0))
    for (const subKey of sortedSubKeys) {
      const subId = `${tId}|sub:${subKey}`
      out.push({ id: subId, name: subteamNameByKey.get(subKey) ?? subKey, parentId: tId, depth: 1, metrics: toMetrics(subteamAcc.get(`${t.id}|${subKey}`) ?? emptyAcc()) })

      const usersInSub = rosterUserIds.filter((uid) => subteamKeyOf.get(uid) === subKey)
      const sortedUsers = usersInSub.sort((a, b) => (leaves.get(`${t.id}|${subKey}|${b}`)?.totalCount ?? 0) - (leaves.get(`${t.id}|${subKey}|${a}`)?.totalCount ?? 0))
      for (const uid of sortedUsers) {
        const leafKey = `${t.id}|${subKey}|${uid}`
        const leafAcc = leaves.get(leafKey) ?? emptyAcc()
        const userId = `${subId}|user:${uid}`
        out.push({ id: userId, name: userNameById.get(uid) ?? uid, parentId: subId, depth: 2, metrics: toMetrics(leafAcc) })

        // v1.267.0: 4th tier — Subtype breakdown of this user's own activity
        // under this Activity Type. Only emitted when the leaf actually has
        // Subtype data (see leafSubtypeAcc above); no entry means no
        // chevron client-side, matching every other Subtype-dimension surface.
        const bySubtype = leafSubtypeAcc.get(leafKey)
        if (bySubtype && bySubtype.size > 0) {
          const sortedSubtypes = [...bySubtype.entries()].sort((a, b) => b[1].totalCount - a[1].totalCount)
          for (const [subtypeName, subAcc] of sortedSubtypes) {
            out.push({ id: `${userId}|subtype:${subtypeName}`, name: subtypeName, parentId: userId, depth: 3, metrics: toMetrics(subAcc) })
          }
        }
      }
    }
  }

  // v1.320.0: alternate Subteam-first tree (Subteam -> User -> Activity Type
  // -> Subtype) for the client's view toggle. Reorganizes the SAME leaves/
  // leafSubtypeAcc facts already computed above — no second query. The id/
  // parentId/depth shape is identical in structure to `out`, so the client's
  // existing generic tree renderer (expand/collapse, indentation, the
  // Unassigned-subteam label check on the id) works unchanged for either.
  const subteamOnlyAcc = new Map<string, Acc>()
  const subteamUserAcc = new Map<string, Acc>()
  for (const [key, acc] of leaves) {
    const m = leafMeta.get(key)!
    const suKey = `${m.subteamKey}|${m.userId}`
    if (!subteamUserAcc.has(suKey)) subteamUserAcc.set(suKey, emptyAcc())
    mergeInto(subteamUserAcc.get(suKey)!, acc)
    if (!subteamOnlyAcc.has(m.subteamKey)) subteamOnlyAcc.set(m.subteamKey, emptyAcc())
    mergeInto(subteamOnlyAcc.get(m.subteamKey)!, acc)
  }
  const outBySubteam: OutRow[] = []
  const allSubteamKeys = Array.from(new Set(rosterUserIds.map((uid) => subteamKeyOf.get(uid)!)))
  const sortedSubteamKeys = allSubteamKeys.sort((a, b) => (subteamOnlyAcc.get(b)?.totalCount ?? 0) - (subteamOnlyAcc.get(a)?.totalCount ?? 0))
  for (const subKey of sortedSubteamKeys) {
    const subId = `sub:${subKey}`
    outBySubteam.push({ id: subId, name: subteamNameByKey.get(subKey) ?? subKey, parentId: null, depth: 0, metrics: toMetrics(subteamOnlyAcc.get(subKey) ?? emptyAcc()) })

    const usersInSub = rosterUserIds.filter((uid) => subteamKeyOf.get(uid) === subKey)
    const sortedUsersInSub = usersInSub.sort((a, b) => (subteamUserAcc.get(`${subKey}|${b}`)?.totalCount ?? 0) - (subteamUserAcc.get(`${subKey}|${a}`)?.totalCount ?? 0))
    for (const uid of sortedUsersInSub) {
      const userNodeId = `${subId}|user:${uid}`
      outBySubteam.push({ id: userNodeId, name: userNameById.get(uid) ?? uid, parentId: subId, depth: 1, metrics: toMetrics(subteamUserAcc.get(`${subKey}|${uid}`) ?? emptyAcc()) })

      const sortedTypesForUser = [...activeTypes].sort((a, b) => (leaves.get(`${b.id}|${subKey}|${uid}`)?.totalCount ?? 0) - (leaves.get(`${a.id}|${subKey}|${uid}`)?.totalCount ?? 0))
      for (const t of sortedTypesForUser) {
        const leafKey = `${t.id}|${subKey}|${uid}`
        const leafAcc = leaves.get(leafKey) ?? emptyAcc()
        const typeNodeId = `${userNodeId}|type:${t.id}`
        outBySubteam.push({ id: typeNodeId, name: t.name, parentId: userNodeId, depth: 2, metrics: toMetrics(leafAcc) })

        const bySubtype = leafSubtypeAcc.get(leafKey)
        if (bySubtype && bySubtype.size > 0) {
          const sortedSubtypes = [...bySubtype.entries()].sort((a, b) => b[1].totalCount - a[1].totalCount)
          for (const [subtypeName, subAcc] of sortedSubtypes) {
            outBySubteam.push({ id: `${typeNodeId}|subtype:${subtypeName}`, name: subtypeName, parentId: typeNodeId, depth: 3, metrics: toMetrics(subAcc) })
          }
        }
      }
    }
  }

  res.json({
    data: out,
    error: null,
    meta: {
      periodCounts,
      // Surfaced so the client can show the same "excludes unlinked
      // activities from ACV math" note the ACV-range filter already carries
      // elsewhere, scoped correctly to just the two Opportunity-specific
      // columns rather than the whole dashboard.
      hasContentFilter,
      // v1.320.0: the Subteam-first alternate tree — sent alongside `data`
      // (not behind a separate query param) so the client's view toggle
      // switches instantly with no extra round trip.
      bySubteamRows: outBySubteam,
    },
  })
})

// ─── Won w/o POC (v1.268.0, Manager group) ─────────────────────────────────
// Surfaces Closed-Won Opportunities that have ImpactIQ activity logged
// against them but no linked Evaluation (POC) record in Salesforce. This is
// a different, stronger signal than activities.crmRelatedId elsewhere in the
// app (Project Costing, the Notes tab's "Project" link) — that column only
// reflects an Evaluation a contributor happened to manually attach while
// logging an activity. This does a LIVE, per-request read of the actual
// Evaluation object for the candidate Opportunities, same on-demand pattern
// /sales-team-breakdown already uses for its own live SF reads — no new
// schema or nightly job.
//
// "The POC object" is never hardcoded: it's resolved from whichever Activity
// Type(s) on this team have a teamActivityTypeCrmExtras row of kind
// 'related_object_picker' — the exact config that already powers the Eval
// Work "related object" picker on the Activity form (config.sobject /
// config.parentField, e.g. Evaluations__c / Opportunity__c). A team that
// hasn't configured this returns { configured: false } rather than
// guessing at "Eval Work" or "Evaluations__c".
//
// Row hierarchy: Subteam -> User -> Opportunity. Unlike Team Activity
// Deep-Dive, only non-empty branches are emitted (product decision for this
// dashboard specifically) — the whole point here is surfacing gaps, not
// full roster coverage. The same Opportunity can legitimately appear under
// more than one User if more than one person logged activity against it —
// same "per-opportunity aggregation idiom" User Leaderboard already uses
// for its own per-user ACV totals.
managerDashRoutes.get('/won-without-poc', requireDashboardAccess('wonWithoutPoc'), requireProjectsOn(), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  if (!teamId || teamId === 'all') {
    res.status(400).json({ data: null, error: 'errors.validation.team_required', meta: {} })
    return
  }
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const { rangeStart, rangeEnd } = resolveRange(req)
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const memberIds = parseMemberIds(req.query['userIds'])

  // ── Resolve the POC-check config for this team ──────────────────────────
  const { teamActivityTypeCrmExtras } = await import('../../../../drizzle/schema.js')
  const extrasRows = await db
    .select({
      sobject: sql<string | null>`${teamActivityTypeCrmExtras.config}->>'sobject'`,
      parentField: sql<string | null>`${teamActivityTypeCrmExtras.config}->>'parentField'`,
    })
    .from(teamActivityTypeCrmExtras)
    .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, teamActivityTypeCrmExtras.teamActivityTypeId))
    .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypeCrmExtras.kind, 'related_object_picker')))
  const pocConfigs = Array.from(new Map(
    extrasRows
      .filter((r): r is { sobject: string; parentField: string | null } => !!r.sobject)
      .map((r) => [`${r.sobject}::${r.parentField ?? 'Opportunity__c'}`, { sobject: r.sobject, parentField: r.parentField ?? 'Opportunity__c' }]),
  ).values())
  // v1.388.0: with CriteriaIQ as the primary Project source, the POC check
  // reads CriteriaIQ instead of Salesforce (see below), and any Project
  // picker on the team counts as configured.
  const pocSource = (await getEvaluationSourceSetting()).primary === 'criteriaiq' ? 'criteriaiq' as const : 'crm' as const
  const configured = pocSource === 'criteriaiq' ? extrasRows.length > 0 : pocConfigs.length > 0
  if (!configured) {
    res.json({ data: [], error: null, meta: { configured: false, pocSource } })
    return
  }

  const activeTypes = await db
    .select({ id: teamActivityTypes.id, name: teamActivityTypes.name, color: teamActivityTypes.color, icon: teamActivityTypes.icon, sortOrder: teamActivityTypes.sortOrder })
    .from(teamActivityTypes)
    .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.isActive, true)))
    .orderBy(teamActivityTypes.sortOrder)
  const typeNameById = new Map(activeTypes.map((t) => [t.id, t.name]))

  const attribution = await loadSubteamAttribution([teamId])
  let rosterUserIds = (await loadTeamRoster(teamId)).map((r) => r.userId)
  if (memberIds.length > 0) {
    const allowed = new Set(memberIds)
    rosterUserIds = rosterUserIds.filter((uid) => allowed.has(uid))
  }
  if (activeTypes.length === 0 || rosterUserIds.length === 0) {
    res.json({ data: [], error: null, meta: { configured: true, sfConnected: true, activityTypes: activeTypes } })
    return
  }

  const rawRows = await db
    .select({
      userId: activities.userId,
      activityTypeId: activities.activityTypeId,
      acv: activities.acv,
      crmWhatId: activities.crmWhatId,
      crmWhatName: activities.crmWhatName,
      crmIsWon: activities.crmIsWon,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
    })
    .from(activities)
    .where(and(
      eq(activities.teamId, teamId),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      inArray(activities.activityTypeId, activeTypes.map((t) => t.id)),
      inArray(activities.userId, rosterUserIds),
      eq(activities.crmWhatType, 'Opportunity'),
      sql`${activities.crmWhatId} IS NOT NULL`,
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(productCond ? [productCond] : []),
    ))

  const fx = await loadFxByCurrency()
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, fx)

  interface OppAgg {
    oppId: string
    name: string
    acv: number
    isWon: boolean
    salesStage: string | null
    forecastCategory: string | null
    byUser: Map<string, { count: number; byType: Map<string, number> }>
  }
  const oppAgg = new Map<string, OppAgg>()
  for (const r of rawRows) {
    if (!r.crmWhatId) continue
    const agg = oppAgg.get(r.crmWhatId) ?? { oppId: r.crmWhatId, name: r.crmWhatName ?? r.crmWhatId, acv: 0, isWon: false, salesStage: r.salesStage, forecastCategory: r.forecastCategory, byUser: new Map() }
    const v = Number(r.acv ?? 0)
    if (v > agg.acv) agg.acv = v
    if (r.crmIsWon) agg.isWon = true
    const u = agg.byUser.get(r.userId) ?? { count: 0, byType: new Map<string, number>() }
    u.count += 1
    const typeName = typeNameById.get(r.activityTypeId)
    if (typeName) u.byType.set(typeName, (u.byType.get(typeName) ?? 0) + 1)
    agg.byUser.set(r.userId, u)
    oppAgg.set(r.crmWhatId, agg)
  }

  // Closed-Won only; Stage/Forecast/ACV narrow further exactly like every
  // other Opportunity-scoped dashboard.
  let candidateOpps = Array.from(oppAgg.values()).filter((o) => o.isWon)
  if (stages.length > 0) candidateOpps = candidateOpps.filter((o) => o.salesStage != null && stages.includes(o.salesStage))
  if (forecast.length > 0) candidateOpps = candidateOpps.filter((o) => o.forecastCategory != null && forecast.includes(o.forecastCategory))
  if (acvRanges.length > 0) candidateOpps = candidateOpps.filter((o) => amountInRanges(o.acv, usdAcvRanges))

  if (candidateOpps.length === 0) {
    res.json({ data: [], error: null, meta: { configured: true, sfConnected: true, activityTypes: activeTypes } })
    return
  }

  let hasPoc = new Set<string>()
  if (pocSource === 'criteriaiq') {
    // ── CriteriaIQ check: an Opp has a POC when an activity on it links a
    // CriteriaIQ project, or a CriteriaIQ project names it. CriteriaIQ being
    // unreachable leaves the tree empty with a notice, never a false "no POC".
    try {
      hasPoc = await opportunitiesWithCriteriaIqProject(candidateOpps.map((o) => ({ oppId: o.oppId, name: o.name })))
    } catch (e) {
      if (!(e instanceof CriteriaIqError)) throw e
      res.json({ data: [], error: null, meta: { configured: true, sfConnected: true, pocSource, criteriaiqError: e.code, activityTypes: activeTypes } })
      return
    }
  }

  // ── Live SF check: which candidate Opps have >=1 linked Evaluation? ──────
  // No SF connection means we genuinely cannot tell — render nothing rather
  // than risk a false "no POC" on an Opp that actually has one (same choice
  // /sales-team-breakdown makes: "a missing SF connection just leaves the
  // tree empty").
  const conn = pocSource === 'crm' ? await getSfConnection(req.user!.id) : null
  if (pocSource === 'crm' && !conn) {
    res.json({ data: [], error: null, meta: { configured: true, sfConnected: false, activityTypes: activeTypes } })
    return
  }
  const apiNameRx = /^[A-Za-z0-9_]{1,80}$/
  if (conn) try {
    const chunkSize = 200
    const ids = candidateOpps.map((o) => o.oppId)
    for (const cfg of pocConfigs) {
      if (!apiNameRx.test(cfg.sobject) || !apiNameRx.test(cfg.parentField)) continue
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize)
        const escaped = chunk.map((id) => `'${safeSoqlLiteral(id)}'`).join(',')
        const soql = `SELECT Id, ${cfg.parentField} FROM ${cfg.sobject} WHERE ${cfg.parentField} IN (${escaped})`
        const q = await conn.query<Record<string, unknown>>(soql)
        for (const rec of q.records) {
          const linked = rec[cfg.parentField]
          if (typeof linked === 'string') hasPoc.add(linked)
        }
      }
    }
  } catch (e) {
    res.json({
      data: [], error: 'errors.salesforce.query_failed',
      meta: { configured: true, sfConnected: true, sfError: e instanceof Error ? e.message : String(e), activityTypes: activeTypes },
    })
    return
  }

  const withoutPoc = candidateOpps.filter((o) => !hasPoc.has(o.oppId))

  // ── Build Subteam -> User -> Opportunity tree, non-empty branches only ──
  interface OppLeaf { oppId: string; oppName: string; acv: number; activityCount: number; countByType: Record<string, number> }
  interface UserNode { userId: string; displayName: string; totalAcv: number; totalActivityCount: number; countByType: Record<string, number>; opps: OppLeaf[] }
  interface SubteamNode { subteamKey: string; subteamName: string; totalAcv: number; totalActivityCount: number; countByType: Record<string, number>; users: UserNode[] }

  const rosterUsers = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, rosterUserIds))
  const userNameById = new Map(rosterUsers.map((u) => [u.id, u.displayName]))
  const subteamNameByKey = new Map<string, string>([[UNASSIGNED_SUBTEAM_ID, 'Unassigned']])
  for (const s of attribution.activeSubteams) subteamNameByKey.set(s.id, s.name)

  function mergeCounts(target: Record<string, number>, src: Map<string, number>): void {
    for (const [k, v] of src) target[k] = (target[k] ?? 0) + v
  }

  const subteamMap = new Map<string, SubteamNode>()
  for (const opp of withoutPoc) {
    for (const [uid, u] of opp.byUser) {
      const subKey = attribution.bestSubteamOf(uid, teamId)?.id ?? UNASSIGNED_SUBTEAM_ID
      let subNode = subteamMap.get(subKey)
      if (!subNode) {
        subNode = { subteamKey: subKey, subteamName: subteamNameByKey.get(subKey) ?? subKey, totalAcv: 0, totalActivityCount: 0, countByType: {}, users: [] }
        subteamMap.set(subKey, subNode)
      }
      let userNode = subNode.users.find((x) => x.userId === uid)
      if (!userNode) {
        userNode = { userId: uid, displayName: userNameById.get(uid) ?? uid, totalAcv: 0, totalActivityCount: 0, countByType: {}, opps: [] }
        subNode.users.push(userNode)
      }
      const oppCountByType: Record<string, number> = {}
      mergeCounts(oppCountByType, u.byType)
      userNode.opps.push({ oppId: opp.oppId, oppName: opp.name, acv: opp.acv, activityCount: u.count, countByType: oppCountByType })
      userNode.totalAcv += opp.acv
      userNode.totalActivityCount += u.count
      mergeCounts(userNode.countByType, u.byType)
      subNode.totalAcv += opp.acv
      subNode.totalActivityCount += u.count
      mergeCounts(subNode.countByType, u.byType)
    }
  }

  const data = Array.from(subteamMap.values())
    .map((s) => ({
      ...s,
      users: s.users
        .map((u) => ({ ...u, opps: u.opps.sort((a, b) => b.acv - a.acv) }))
        .sort((a, b) => b.totalAcv - a.totalAcv),
    }))
    .sort((a, b) => b.totalAcv - a.totalAcv)

  res.json({ data, error: null, meta: { configured: true, sfConnected: true, pocSource, activityTypes: activeTypes } })
})


// Pivots ImpactIQ activity data on the SF sales hierarchy. Data flows:
//   1. Pull the caller's team-scope of activities in the window that are
//      linked to an SF Account or Opportunity.
//   2. Resolve each activity's SF owner via a live SF query (batched, same
//      shape as /revenue/cost-per-acv). For opps, we also resolve their
//      parent Account so the tree can group by Account.
//   3. Group into Manager → Owner → Account → Opportunity (or Owner →
//      Account → Opportunity when pivot=owner), using crm_user_alignments as
//      the seed set of "who counts". Owners not in any alignment are
//      surfaced under a synthetic "unassigned" node so drift is visible.
//
// Design note: the SF query is only issued for the crm_what_ids that appear
// in the caller's already-scoped rows — so a manager with a small team
// generates a small SF query. Empty tree (no activities, no alignments)
// short-circuits before touching Salesforce.
// ─── Closed Lost — Needs Review (vNext, Manager group) ──────────────────────
// See CLAUDE.md §7 (Opportunity Relink) / §13. Surfaces Opportunities that
// are closed-and-not-won (crm_is_closed = true AND crm_is_won = false — the
// portable, non-hardcoded signal for "Closed Lost or Closed - Duplicate",
// since Stage label text isn't standardized org to org) with ImpactIQ
// activity still linked to them — most likely because the real work moved
// to a different, replacement Opportunity that ImpactIQ has no way to know
// about on its own.
//
// A LIVE query at load time against already-fresh local Postgres columns —
// crm_is_closed/crm_is_won are kept current by the existing nightly
// refresh_opp_snapshots job, so no new nightly-job work or schema for the
// candidate list itself. Self-healing by construction: once a Relink (see
// POST /api/activities/relink-opportunity) moves every activity off an Opp,
// the next load of this query naturally excludes it — no extra bookkeeping.
//
// Note: the CANDIDATE LIST here is subject to the dashboard's own standard
// date-range chips like every other dashboard — normal, expected behavior.
// This is unrelated to and does not affect the Relink action's own all-time,
// unfiltered scope (it moves EVERY activity ever logged on the old Opp,
// regardless of what date range happened to be selected when the queue row
// was clicked) — don't conflate "which Opps show up in the queue today"
// with "how much moves when Relink is clicked on one."
managerDashRoutes.get('/closed-lost-review', requireDashboardAccess('closedLostReview'), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  if (!teamId || teamId === 'all') {
    res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} })
    return
  }
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const { rangeStart, rangeEnd } = resolveRange(req)
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  const productIds = parseProductIds(req.query['productIds'])
  const memberIds = parseMemberIds(req.query['userIds'])
  const includeDismissed = req.query['includeDismissed'] === 'true'

  const { fetchClosedLostReviewCandidates } = await import('../../services/dashboards/closedLostReview.js')
  const data = await fetchClosedLostReviewCandidates({
    teamId, dateBasis, rangeStart, rangeEnd, stages, forecast, acvRanges, productIds, memberIds, includeDismissed,
  })

  res.json({ data, error: null, meta: { count: data.length } })
})

// POST /api/dashboards/closed-lost-review/dismiss { teamId, crmOppId, crmOppName }
// A leader/admin marking "reviewed, genuinely nothing to relink" so this Opp
// stops resurfacing. Permanent by design (see opp_review_dismissals) — a
// one-time judgment call, not a recurring reminder. Same requireRole gate as
// the Relink action itself (CLAUDE.md §18: never trust requireAnyLeaderOrAdmin
// for a team-scoped write — it only proves leader/admin on ANY team).
managerDashRoutes.post('/closed-lost-review/dismiss', requireRole('leader', 'admin'), async (req, res) => {
  const parsed = z.object({ teamId: z.string().uuid(), crmOppId: z.string().min(1), crmOppName: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamId, crmOppId, crmOppName } = parsed.data
  await db.insert(oppReviewDismissals).values({ teamId, crmOppId, crmOppName, dismissedBy: req.user!.id })
    .onConflictDoUpdate({
      target: [oppReviewDismissals.teamId, oppReviewDismissals.crmOppId],
      set: { crmOppName, dismissedBy: req.user!.id, dismissedAt: new Date() },
    })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// DELETE /api/dashboards/closed-lost-review/dismiss { teamId, crmOppId }
managerDashRoutes.delete('/closed-lost-review/dismiss', requireRole('leader', 'admin'), async (req, res) => {
  const parsed = z.object({ teamId: z.string().uuid(), crmOppId: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamId, crmOppId } = parsed.data
  await db.delete(oppReviewDismissals).where(and(eq(oppReviewDismissals.teamId, teamId), eq(oppReviewDismissals.crmOppId, crmOppId)))
  res.json({ data: { ok: true }, error: null, meta: {} })
})
