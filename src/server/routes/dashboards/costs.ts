import { Router } from 'express'
import { db } from '../../db/index.js'
import { activities, teams, users, subteams, subteamUsers, crmLeadAccountLink } from '../../../../drizzle/schema.js'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { resolveCostBatch } from '../../services/capacity/resolver.js'
import { loadSubteamAttribution } from '../../services/dashboards/subteamAttribution.js'
import { requireAnyLeaderOrAdmin, requireDashboardAccess } from '../../middleware/rbac.js'
import { requireProjectsOn } from '../../services/criteriaiq/evaluationSource.js'

import {
  resolveTeamScope,
  parseDateBasis,
  resolveRange,
  dateWindow,
  parseProductIds,
  parseMemberIds,
  productFilterCond,
  parseAcvRanges,
  amountInRanges,
  acvRangesInUsd,
  loadFxByCurrency,
  toUsd,
  directCostUsd,
} from './shared.js'

export const costsDashRoutes = Router()

// ─── v1.137.0: Most Expensive dashboard ─────────────────────────────────
//
// Top-25 ranked by cost-of-effort. `scope` picks the SF object type ranked:
//   account | opp | campaign | lead
//
// For scope=account, cost rolls up every activity attributable to the
// account: direct Account links + child Opp activities (via crmAccountId)
// + Lead activities where the lead converted into a contact under the
// account (crmLeadAccountLink cache). Campaigns don't currently have a
// stable Campaign→Account link so they're excluded from the account
// roll-up; direct Campaign activities still show under scope=campaign.
//
// Optional filters:
//   stages=csv    — activities.salesStage IN (…) (Opp-linked activities only)
//   forecast=csv  — activities.forecastCategory IN (…)  (Opp-linked only)
// v1.138.0: use requireAuth (not requireRole) so callers don't need to pass a
// teamId — the endpoint intentionally scans every team the caller can see
// (same posture as /manager-rollup). requireRole demands teamId in the
// querystring and would 400 every call from the Accounts group.
// v1.245.0: requireAuth alone meant any signed-in Contributor could call this
// directly and get real cross-team data back — the tab was hidden only by
// client-side nav. Switched to requireAnyLeaderOrAdmin, which keeps the same
// "no teamId required" property (it checks role on ANY team, not a specific
// one) while actually gating on leader/admin/team_admin.
costsDashRoutes.get('/most-expensive', requireAnyLeaderOrAdmin, async (req, res) => {
  const scope = String(req.query['scope'] ?? 'account').toLowerCase() as 'account' | 'opp' | 'campaign' | 'lead'
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const { rangeStart, rangeEnd } = resolveRange(req)
  const teamScope = (await resolveTeamScope(req, undefined)) ?? []
  if (teamScope.length === 0) { res.json({ data: [], error: null, meta: { totalCost: 0 } }); return }

  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  // v1.274.0: Products + member/subteam scoping were never wired here,
  // unlike this dashboard's Accounts-group siblings Account Burn and
  // Account / Opportunity Concentration (both of which support them).
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])

  const rawRows = await db.select({
    userId: activities.userId,
    teamId: activities.teamId,
    startDatetime: activities.startDatetime,
    effortHours: activities.effortHours,
    costTransportation: activities.costTransportation,
    costLodging: activities.costLodging,
    costFood: activities.costFood,
    incidentalCurrency: activities.incidentalCurrency,
    crmWhatId: activities.crmWhatId,
    crmWhatType: activities.crmWhatType,
    crmWhatName: activities.crmWhatName,
    crmWhoId: activities.crmWhoId,
    crmWhoType: activities.crmWhoType,
    crmWhoName: activities.crmWhoName,
    crmAccountId: activities.crmAccountId,
    crmAccountName: activities.crmAccountName,
    salesStage: activities.salesStage,
    forecastCategory: activities.forecastCategory,
    acv: activities.acv,
  }).from(activities).where(and(
    inArray(activities.teamId, teamScope),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    ...dateWindow(dateBasis, rangeStart, rangeEnd),
    ...(productCond ? [productCond] : []),
    ...(userId ? [eq(activities.userId, userId)] : []),
    ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
  ))

  // Lead → Account cache — one shot, only when scope needs it.
  const leadAcctMap = new Map<string, string | null>()
  if (scope === 'account') {
    const leadIds = rawRows.filter((r) => r.crmWhoType === 'Lead' && r.crmWhoId).map((r) => r.crmWhoId!)
    if (leadIds.length > 0) {
      const rows = await db.select().from(crmLeadAccountLink).where(inArray(crmLeadAccountLink.leadId, leadIds))
      for (const r of rows) leadAcctMap.set(r.leadId, r.accountId)
    }
  }

  const costResolved = await resolveCostBatch(rawRows.map((r) => ({
    userId: r.userId, teamId: r.teamId, asOf: new Date(r.startDatetime),
  })))
  const fx = await loadFxByCurrency()
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, fx)

  interface Bucket { id: string; name: string | null; cost: number; activityCount: number; contributors: Set<string> }
  const buckets = new Map<string, Bucket>()
  const bump = (id: string, name: string | null, cost: number, userId: string) => {
    const cur = buckets.get(id) ?? { id, name, cost: 0, activityCount: 0, contributors: new Set<string>() }
    cur.cost += cost
    cur.activityCount += 1
    cur.contributors.add(userId)
    if (!cur.name && name) cur.name = name
    buckets.set(id, cur)
  }

  for (const r of rawRows) {
    // Stage / forecast filters apply only to Opp-linked rows (they only
    // make sense against Opportunity metadata).
    if (r.crmWhatType === 'Opportunity') {
      if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) continue
      if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) continue
      if (acvRanges.length > 0 && !amountInRanges(Number(r.acv), usdAcvRanges)) continue
    } else if (stages.length > 0 || forecast.length > 0 || acvRanges.length > 0) {
      // Filters set → non-Opp rows are excluded by design.
      continue
    }

    const rc = costResolved.get(`${r.userId}::${r.teamId}`)
    // Cost of engagement (USD) = labor (FX→USD) + direct/travel costs (FX→USD).
    const activityCost = toUsd(Number(r.effortHours) * (rc?.rate ?? 0), rc?.currency, fx) + directCostUsd(r, fx)

    if (scope === 'account') {
      if (r.crmWhatType === 'Account' && r.crmWhatId) bump(r.crmWhatId, r.crmWhatName ?? null, activityCost, r.userId)
      if (r.crmWhatType === 'Opportunity' && r.crmAccountId) bump(r.crmAccountId, r.crmAccountName ?? null, activityCost, r.userId)
      if (r.crmWhoType === 'Lead' && r.crmWhoId) {
        const acct = leadAcctMap.get(r.crmWhoId)
        if (acct) bump(acct, null, activityCost, r.userId)
      }
    } else if (scope === 'opp') {
      if (r.crmWhatType === 'Opportunity' && r.crmWhatId) bump(r.crmWhatId, r.crmWhatName ?? null, activityCost, r.userId)
    } else if (scope === 'campaign') {
      if (r.crmWhatType === 'Campaign' && r.crmWhatId) bump(r.crmWhatId, r.crmWhatName ?? null, activityCost, r.userId)
    } else if (scope === 'lead') {
      if (r.crmWhoType === 'Lead' && r.crmWhoId) bump(r.crmWhoId, r.crmWhoName ?? null, activityCost, r.userId)
    }
  }

  const ranked = Array.from(buckets.values())
    .filter((b) => b.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 25)
    .map((b) => ({ id: b.id, name: b.name, cost: b.cost, activityCount: b.activityCount, uniqueContributors: b.contributors.size }))

  const totalCost = ranked.reduce((s, r) => s + r.cost, 0)
  res.json({ data: ranked, error: null, meta: { totalCost, scope, weeks: weeksBack } })
})

// ─── v1.182.0: Project-Specific Costing (Infrastructure) ───────────────
//
// Rolls up ONLY project-linked activity (activities.crmRelatedId not null —
// the per-activity-type SF related object, e.g. Eval Work → Evaluation__c).
// A 4-way scope toggle re-groups that same project activity:
//   project  — one row per Project (crmRelatedId)
//   opp      — group by parent Opportunity (crmWhatId)
//   account  — group by Account (direct + each Opp's parent crmAccountId)
//   team     — nested Team→Subteam tree (deepest-subteam attribution)
// Cost = labor (FX→USD) + direct/travel costs. ACV = Σ max-ACV over the
// group's unique opps. KPI cards (meta.kpis) are ALWAYS project-scoped,
// independent of the toggle.
costsDashRoutes.get('/project-costing', requireDashboardAccess('projectCosting'), requireProjectsOn(), async (req, res) => {
  const scope = String(req.query['scope'] ?? 'project').toLowerCase() as 'project' | 'opp' | 'account' | 'team'
  const teamId = req.query['teamId'] as string | undefined
  const scopeTeams = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const { rangeStart, rangeEnd } = resolveRange(req)
  const emptyKpis = { projects: 0, hours: 0, cost: 0, acv: 0, activities: 0, contributors: 0 }
  if (scopeTeams.length === 0) { res.json({ data: [], error: null, meta: { scope, kpis: emptyKpis } }); return }

  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const userId = typeof req.query['userId'] === 'string' && req.query['userId'] ? req.query['userId'] : null
  // Subteam scoping: when a subteam is selected the client sends its member
  // ids so the whole tree filters to those contributors (empty subteam sends
  // a sentinel id that matches nothing).
  const userIds = String(req.query['userIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  const rawRows = await db.select({
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
    crmWhatType: activities.crmWhatType,
    crmAccountId: activities.crmAccountId,
    crmAccountName: activities.crmAccountName,
    crmWhatName: activities.crmWhatName,
    crmRelatedId: activities.crmRelatedId,
    crmRelatedName: activities.crmRelatedName,
    salesStage: activities.salesStage,
    forecastCategory: activities.forecastCategory,
  }).from(activities).where(and(
    inArray(activities.teamId, scopeTeams),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    isNotNull(activities.crmRelatedId), // project-linked activity only
    ...dateWindow(dateBasis, rangeStart, rangeEnd),
    ...(userId ? [eq(activities.userId, userId)] : []),
    ...(userIds.length > 0 ? [inArray(activities.userId, userIds)] : []),
    ...(productCond ? [productCond] : []),
  ))

  const fx = await loadFxByCurrency()
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, fx)
  // Apply the Opp-only stage/forecast/ACV filters (mirrors most-expensive).
  const rows = rawRows.filter((r) => {
    if (r.crmWhatType === 'Opportunity') {
      if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) return false
      if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) return false
      if (acvRanges.length > 0 && !amountInRanges(Number(r.acv), usdAcvRanges)) return false
      return true
    }
    return !(stages.length > 0 || forecast.length > 0 || acvRanges.length > 0)
  })

  const costResolved = await resolveCostBatch(rows.map((r) => ({ userId: r.userId, teamId: r.teamId, asOf: new Date(r.startDatetime) })))
  const costOf = (r: typeof rows[number]): number => {
    const rc = costResolved.get(`${r.userId}::${r.teamId}`)
    return toUsd(Number(r.effortHours) * (rc?.rate ?? 0), rc?.currency, fx) + directCostUsd(r, fx)
  }
  // Max ACV per Opportunity so a chatty opp doesn't multi-count its ACV.
  const oppMaxAcv = new Map<string, number>()
  for (const r of rows) {
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
      const v = Number(r.acv ?? 0)
      if (v > (oppMaxAcv.get(r.crmWhatId) ?? 0)) oppMaxAcv.set(r.crmWhatId, v)
    }
  }
  const acvOf = (opps: Set<string>): number => { let a = 0; for (const o of opps) a += oppMaxAcv.get(o) ?? 0; return a }

  interface Row { id: string; name: string | null; parentId: string | null; depth: number; activityCount: number; hours: number; costDollars: number; acv: number; uniqueContributors: number }

  // KPI cards — always project-scoped (independent of the toggle).
  const kpiProjects = new Set<string>()
  const kpiOpps = new Set<string>()
  const kpiContributors = new Set<string>()
  let kpiHours = 0, kpiCost = 0, kpiActivities = 0
  for (const r of rows) {
    if (r.crmRelatedId) kpiProjects.add(r.crmRelatedId)
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) kpiOpps.add(r.crmWhatId)
    kpiContributors.add(r.userId)
    kpiHours += Number(r.effortHours)
    kpiCost += costOf(r)
    kpiActivities += 1
  }
  const kpis = {
    projects: kpiProjects.size,
    hours: Math.round(kpiHours * 100) / 100,
    cost: Math.round(kpiCost * 100) / 100,
    acv: acvOf(kpiOpps),
    activities: kpiActivities,
    contributors: kpiContributors.size,
  }

  // ── Shared hierarchical aggregator ──
  // Every scope now returns a nested tree. Each activity row contributes to
  // every node along its path (root → leaf), so parent rows roll up their
  // descendants' totals without double-counting (ACV is deduped per opp via
  // acvOf over the node's distinct-opp set).
  interface Node { id: string; name: string | null; parentId: string | null; depth: number; hours: number; cost: number; activityCount: number; contributors: Set<string>; opps: Set<string> }
  const nodes = new Map<string, Node>()
  const ensure = (id: string, name: string | null, parentId: string | null, depth: number): Node => {
    let n = nodes.get(id)
    if (!n) { n = { id, name, parentId, depth, hours: 0, cost: 0, activityCount: 0, contributors: new Set(), opps: new Set() }; nodes.set(id, n) }
    else if (!n.name && name) n.name = name
    return n
  }
  const addTo = (n: Node, r: typeof rows[number]) => {
    n.hours += Number(r.effortHours); n.cost += costOf(r); n.activityCount += 1; n.contributors.add(r.userId)
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) n.opps.add(r.crmWhatId)
  }
  type Seg = { id: string; name: string | null; parentId: string | null; depth: number }

  if (scope !== 'team') {
    // For the project scope the leaf level is the contributor, so we need
    // their display names.
    const nameByUser = new Map<string, string>()
    if (scope === 'project') {
      const uids = Array.from(new Set(rows.map((r) => r.userId)))
      if (uids.length > 0) {
        const nr = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, uids))
        for (const u of nr) nameByUser.set(u.id, u.displayName ?? u.id)
      }
    }
    for (const r of rows) {
      const path: Seg[] = []
      if (scope === 'project') {
        if (!r.crmRelatedId) continue
        const pid = `p:${r.crmRelatedId}`
        path.push({ id: pid, name: r.crmRelatedName ?? null, parentId: null, depth: 0 })
        path.push({ id: `${pid}|u:${r.userId}`, name: nameByUser.get(r.userId) ?? r.userId, parentId: pid, depth: 1 })
      } else if (scope === 'opp') {
        if (!(r.crmWhatType === 'Opportunity' && r.crmWhatId)) continue
        const oid = `o:${r.crmWhatId}`
        path.push({ id: oid, name: r.crmWhatName ?? null, parentId: null, depth: 0 })
        if (r.crmRelatedId) path.push({ id: `${oid}|p:${r.crmRelatedId}`, name: r.crmRelatedName ?? null, parentId: oid, depth: 1 })
      } else { // account → opportunity → project
        const accId = r.crmWhatType === 'Account' && r.crmWhatId ? r.crmWhatId : r.crmAccountId
        const accName = r.crmWhatType === 'Account' ? (r.crmWhatName ?? null) : (r.crmAccountName ?? null)
        if (!accId) continue
        const aid = `a:${accId}`
        path.push({ id: aid, name: accName, parentId: null, depth: 0 })
        let parent = aid, depth = 1
        if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
          const oid = `${aid}|o:${r.crmWhatId}`
          path.push({ id: oid, name: r.crmWhatName ?? null, parentId: aid, depth: 1 })
          parent = oid; depth = 2
        }
        if (r.crmRelatedId) path.push({ id: `${parent}|p:${r.crmRelatedId}`, name: r.crmRelatedName ?? null, parentId: parent, depth })
      }
      for (const seg of path) addTo(ensure(seg.id, seg.name, seg.parentId, seg.depth), r)
    }
  } else {
    // ── Team scope: Team → Subteam chain → Project ──
    const subteamRows = await db
      .select({ id: subteams.id, teamId: subteams.teamId, name: subteams.name, isActive: subteams.isActive, parentSubteamId: subteams.parentSubteamId })
      .from(subteams).where(inArray(subteams.teamId, scopeTeams))
    const activeSubteams = subteamRows.filter((s) => s.isActive)
    const subById = new Map(activeSubteams.map((s) => [s.id, s]))
    const depthOf = (id: string): number => {
      let d = 1; const guard = new Set<string>([id]); let cur = subById.get(id)?.parentSubteamId ?? null
      while (cur && subById.has(cur) && !guard.has(cur)) { d += 1; guard.add(cur); cur = subById.get(cur)!.parentSubteamId ?? null }
      return d
    }
    const usRows = await db.select({ userId: subteamUsers.userId, subteamId: subteamUsers.subteamId }).from(subteamUsers)
      .where(inArray(subteamUsers.subteamId, activeSubteams.map((s) => s.id).length > 0 ? activeSubteams.map((s) => s.id) : ['00000000-0000-0000-0000-000000000000']))
    const subteamsByUser = new Map<string, Set<string>>()
    for (const r of usRows) { const s = subteamsByUser.get(r.userId) ?? new Set<string>(); s.add(r.subteamId); subteamsByUser.set(r.userId, s) }
    const teamNames = new Map((await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, scopeTeams))).map((t) => [t.id, t.name]))

    for (const r of rows) {
      const teamNodeId = `team:${r.teamId}`
      const path: Seg[] = [{ id: teamNodeId, name: teamNames.get(r.teamId) ?? r.teamId, parentId: null, depth: 0 }]
      const teamSubs = subteamsByUser.get(r.userId)
      const hits = teamSubs ? activeSubteams.filter((s) => s.teamId === r.teamId && teamSubs.has(s.id)) : []
      let leafId = teamNodeId, leafDepth = 0
      if (hits.length > 0) {
        // Attribute to the deepest matching subteam, then build the full
        // ancestor chain root → leaf so every level rolls up.
        const leaf = hits.map((s) => ({ s, d: depthOf(s.id) })).sort((a, b) => b.d - a.d || a.s.name.localeCompare(b.s.name))[0]!.s
        const chain: typeof activeSubteams = []
        const guard = new Set<string>()
        let cur: (typeof activeSubteams)[number] | undefined = leaf
        while (cur && !guard.has(cur.id)) { chain.unshift(cur); guard.add(cur.id); cur = cur.parentSubteamId ? subById.get(cur.parentSubteamId) : undefined }
        let parentId = teamNodeId
        for (const s of chain) { path.push({ id: `sub:${s.id}`, name: s.name, parentId, depth: depthOf(s.id) }); parentId = `sub:${s.id}` }
        leafId = `sub:${leaf.id}`; leafDepth = depthOf(leaf.id)
      } else {
        path.push({ id: `un:${r.teamId}`, name: 'Unassigned', parentId: teamNodeId, depth: 1 })
        leafId = `un:${r.teamId}`; leafDepth = 1
      }
      if (r.crmRelatedId) path.push({ id: `${leafId}|p:${r.crmRelatedId}`, name: r.crmRelatedName ?? null, parentId: leafId, depth: leafDepth + 1 })
      for (const seg of path) addTo(ensure(seg.id, seg.name, seg.parentId, seg.depth), r)
    }
  }

  // DFS render — parents before children, each level sorted by cost desc.
  const childrenByParent = new Map<string, Node[]>()
  for (const n of nodes.values()) {
    if (n.parentId !== null) { const a = childrenByParent.get(n.parentId) ?? []; a.push(n); childrenByParent.set(n.parentId, a) }
  }
  const toRow = (n: Node): Row => ({ id: n.id, name: n.name, parentId: n.parentId, depth: n.depth, activityCount: n.activityCount, hours: Math.round(n.hours * 100) / 100, costDollars: Math.round(n.cost * 100) / 100, acv: acvOf(n.opps), uniqueContributors: n.contributors.size })
  const data: Row[] = []
  const walk = (n: Node) => { data.push(toRow(n)); (childrenByParent.get(n.id) ?? []).sort((a, b) => b.cost - a.cost).forEach(walk) }
  Array.from(nodes.values()).filter((n) => n.parentId === null).sort((a, b) => b.cost - a.cost).forEach(walk)
  res.json({ data, error: null, meta: { scope, weeks: weeksBack, kpis } })
})

// ─── v1.137.0: User Leaderboard ────────────────────────────────────────
//
// Per-user totals across the caller's accessible teams. Columns:
//   totalAcv        — ACV attributed to the user, once per (user, opp)
//   closedAcv       — subset of totalAcv where crmIsWon = true
//   totalCost       — sum(effortHours * rate) across all activities
//   netDealMargin   — totalAcv - totalCost
//   efficiencyRatio — closedAcv / totalCost  (null when cost==0)
// v1.138.0: see /most-expensive note — requireAuth, not requireRole.
costsDashRoutes.get('/user-leaderboard', requireAnyLeaderOrAdmin, async (req, res) => {
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const { rangeStart, rangeEnd } = resolveRange(req)
  const teamScope = (await resolveTeamScope(req, undefined)) ?? []
  if (teamScope.length === 0) { res.json({ data: [], error: null, meta: {} }); return }

  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  // v1.245.0: Products / Team-member chips render for this dashboard but
  // previously had zero effect on its output — see CLAUDE.md §13.
  const productIdsUl = parseProductIds(req.query['productIds'])
  const productCondUl = productFilterCond(productIdsUl)
  const userIdsUl = String(req.query['userIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  const rawRows = await db.select({
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
    crmWhatType: activities.crmWhatType,
    salesStage: activities.salesStage,
    forecastCategory: activities.forecastCategory,
    crmIsWon: activities.crmIsWon,
  }).from(activities).where(and(
    inArray(activities.teamId, teamScope),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    ...dateWindow(dateBasis, rangeStart, rangeEnd),
    ...(productCondUl ? [productCondUl] : []),
    ...(userIdsUl.length > 0 ? [inArray(activities.userId, userIdsUl)] : []),
  ))

  const costResolved = await resolveCostBatch(rawRows.map((r) => ({
    userId: r.userId, teamId: r.teamId, asOf: new Date(r.startDatetime),
  })))
  const fx = await loadFxByCurrency()
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, fx)

  // Max ACV per Opp (so a chatty opp doesn't multi-count its ACV).
  const oppMaxAcv = new Map<string, { acv: number; isWon: boolean }>()
  for (const r of rawRows) {
    if (r.crmWhatType !== 'Opportunity' || !r.crmWhatId) continue
    const v = Number(r.acv ?? 0)
    const cur = oppMaxAcv.get(r.crmWhatId) ?? { acv: 0, isWon: false }
    if (v > cur.acv) cur.acv = v
    if (r.crmIsWon) cur.isWon = true
    oppMaxAcv.set(r.crmWhatId, cur)
  }

  interface UserAgg { userId: string; totalAcv: number; closedAcv: number; totalCost: number; activityCount: number; oppsTouched: Set<string> }
  const perUser = new Map<string, UserAgg>()
  const seenOppByUser = new Map<string, Set<string>>()
  for (const r of rawRows) {
    // Filter check identical to /most-expensive.
    if (r.crmWhatType === 'Opportunity') {
      if (stages.length > 0 && (!r.salesStage || !stages.includes(r.salesStage))) continue
      if (forecast.length > 0 && (!r.forecastCategory || !forecast.includes(r.forecastCategory))) continue
      if (acvRanges.length > 0 && !amountInRanges(Number(r.acv), usdAcvRanges)) continue
    } else if (stages.length > 0 || forecast.length > 0 || acvRanges.length > 0) {
      continue
    }
    const cur = perUser.get(r.userId) ?? { userId: r.userId, totalAcv: 0, closedAcv: 0, totalCost: 0, activityCount: 0, oppsTouched: new Set<string>() }
    const rc = costResolved.get(`${r.userId}::${r.teamId}`)
    cur.totalCost += toUsd(Number(r.effortHours) * (rc?.rate ?? 0), rc?.currency, fx) + directCostUsd(r, fx)
    cur.activityCount += 1
    if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
      cur.oppsTouched.add(r.crmWhatId)
      const seen = seenOppByUser.get(r.userId) ?? new Set<string>()
      if (!seen.has(r.crmWhatId)) {
        seen.add(r.crmWhatId)
        seenOppByUser.set(r.userId, seen)
        const om = oppMaxAcv.get(r.crmWhatId)
        if (om) {
          cur.totalAcv += om.acv
          if (om.isWon) cur.closedAcv += om.acv
        }
      }
    }
    perUser.set(r.userId, cur)
  }

  const userIds = Array.from(perUser.keys())
  const nameRows = userIds.length > 0
    ? await db.select({ id: users.id, displayName: users.displayName, defaultTeamId: users.defaultTeamId }).from(users).where(inArray(users.id, userIds))
    : []
  const nameById = new Map(nameRows.map((r) => [r.id, r.displayName ?? ''] as const))
  const teamOfById = new Map(nameRows.map((r) => [r.id, r.defaultTeamId ?? ''] as const))
  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamScope))
  const teamNameById = new Map(teamRows.map((r) => [r.id, r.name] as const))
  // v1.267.0: "Main Subteam" column — same deepest-subteam attribution rule
  // as Team Activity Deep-Dive, resolved against the user's own team (their
  // defaultTeamId, matching teamName above) rather than every team in scope.
  const attribution = await loadSubteamAttribution(teamScope)
  const subteamNameOf = (userId: string): string | null => {
    const uTeamId = teamOfById.get(userId)
    if (!uTeamId) return null
    return attribution.bestSubteamOf(userId, uTeamId)?.name ?? null
  }

  const data = Array.from(perUser.values()).map((u) => ({
    userId: u.userId,
    displayName: nameById.get(u.userId) ?? u.userId,
    teamName: teamNameById.get(teamOfById.get(u.userId) ?? '') ?? '',
    subteamName: subteamNameOf(u.userId),
    totalAcv: u.totalAcv,
    closedAcv: u.closedAcv,
    totalCost: u.totalCost,
    netDealMargin: u.totalAcv - u.totalCost,
    efficiencyRatio: u.totalCost > 0 ? u.closedAcv / u.totalCost : null,
    activityCount: u.activityCount,
    oppsTouched: u.oppsTouched.size,
  })).sort((a, b) => b.totalAcv - a.totalAcv)

  res.json({ data, error: null, meta: { weeks: weeksBack } })
})
