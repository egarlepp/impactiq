import { Router } from 'express'
import { db } from '../../db/index.js'
import {
  activities,
  teams,
  users,
  teamMembers,
  subteams,
  subteamUsers,
  attachRateFields,
  crmOpportunityCoverage,
  attachRateHistory,
  sfUserNames,
  crmUserAlignments,
  systemSettings,
  crmFieldMappings,
  crmFieldMappingTeams,
} from '../../../../drizzle/schema.js'
import { getCrmProviderId } from '../../services/crm/index.js'
import { hubspotPrimaryAttachKey } from '../../services/hubspot/attachCoverage.js'
import { ADMIN_SF_SETTINGS_KEY } from '../../services/salesforce/client.js'
import { and, eq, gte, lte, sql, inArray, isNotNull } from 'drizzle-orm'
import { requireDashboardAccess } from '../../middleware/rbac.js'
import { demoCoverageCond } from '../../services/demo/ids.js'
import { startOfWeek, addWeeks, endOfWeek, format } from 'date-fns'

import { resolveTeamScope, resolveRange, parseWeekShift, parseProductIds, parseAcvRanges, acvRangeCond } from './shared.js'

export const attachRateDashRoutes = Router()

// ─── Attach Rate ────────────────────────────────────────────────────────
// v1.188.0: share of opportunities that have a Solutions Engineer
// "attached". Reads from the local crm_opportunity_coverage snapshot
// (refreshed by the refresh_opp_coverage job) so the dashboard, its Compare
// modes, and its weekly trend are all fast local aggregations with no live
// Salesforce call per view. "Attached" = any of the active team's
// attach_rate_fields present on the opp (computed here so each team can
// define coverage its own way). dateBasis selects how opps are cohorted:
//   created → CreatedDate window · close → CloseDate window · open → all
//   currently-open opps (IsClosed = false), ignoring the date window.
// v1.277.0: matched=false means this credited SE has no ImpactIQ account
// (the SF User Id on the Assigned SE / secondary field, or the activity
// logger, resolves only via the sf_user_names cache, not users.crmUserId) —
// the client renders these in red so a leader can tell "someone outside
// ImpactIQ is covering this deal" from "our own SE hasn't logged it yet".
interface AttachRateUser { userId: string; displayName: string; oppsAttached: number; acv: number; matched: boolean }
interface AttachRateWeek { weekStart: string; total: number; attached: number; pct: number }
interface AttachRateRole { role: string; opps: number; acv: number }
interface AttachRateCallout { oppId: string; name: string; acv: number; ownerName: string | null; suggestedSe: string | null }
interface AttachRateResp {
  total: number
  attached: number
  pct: number
  // v1.192.0: ACV-weighted attach rate (Opportunity Amount over the cohort).
  totalAcv: number
  attachedAcv: number
  pctAcv: number
  // v1.193.0: tiered attachment. Primary = Assigned SE present; Secondary =
  // no Assigned SE but an eval engineer field or an opp-linked activity.
  primaryCount: number
  secondaryCount: number
  primaryAcv: number
  secondaryAcv: number
  // v1.193.0: opps attached only via secondary signals (no Assigned SE) —
  // the "someone forgot to set the Assigned SE" worklist.
  callouts: AttachRateCallout[]
  calloutCount: number
  // SF instance base URL (admin connection) so the client can deep-link each
  // missing-SE opportunity to `${instanceUrl}/${oppId}`. Null when unknown.
  instanceUrl: string | null
  weekly: AttachRateWeek[]
  breakdown: AttachRateUser[]
  // v1.192.0: attached opps + ACV per configured field's role label.
  roles: AttachRateRole[]
  dateBasis: 'created' | 'close' | 'open'
  notConfigured: boolean
  stale: boolean
  snapshotAt: string | null
  // v1.190.0: true when the Open Pipeline basis had recorded history to draw
  // its trend / Compare from (client shows those only when true).
  hasHistory: boolean
  // v1.190.0: a coverage snapshot exists but no opportunities matched the
  // current cohort/filters (distinct from "no snapshot built yet").
  noMatch: boolean
}

// Humanize an SF field API name into a default role label:
// Assigned_SE__c → "Assigned SE", Primary_Engineer__c → "Primary Engineer".
function humanizeField(api: string): string {
  const base = api.split('.').pop() ?? api
  return base.replace(/__c$/i, '').replace(/_/g, ' ').trim()
    .split(/\s+/).map((w) => /^[A-Z]{2,}$/.test(w) ? w : (w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
}
export const SF_FIELD_PATH = /^[A-Za-z0-9_.]{1,80}$/
export const SF_ID_RX = /^[A-Za-z0-9]{15}$|^[A-Za-z0-9]{18}$/

// Attach Rate's "Primary" tier: on Salesforce the Opportunity field a scope
// team maps as its Assigned SE (assigned_se_write, v1.474.0), else a field
// named Assigned_SE__c; on HubSpot the Deal property a scope team maps as
// Assigned SE.
async function attachPrimaryKey(teamIds: readonly string[], keys: readonly string[]): Promise<string | null> {
  if ((await getCrmProviderId()) === 'hubspot') return hubspotPrimaryAttachKey(teamIds, keys)
  if (teamIds.length > 0) {
    const mapped = await db.select({ api: crmFieldMappings.crmFieldApi }).from(crmFieldMappings)
      .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
      .where(and(
        inArray(crmFieldMappingTeams.teamId, [...teamIds]),
        eq(crmFieldMappings.appField, 'assigned_se_write'),
        eq(crmFieldMappings.crmObject, 'Opportunity'),
        eq(crmFieldMappings.isActive, true),
      ))
    for (const m of mapped) {
      const key = keys.find((k) => k.toLowerCase() === `opportunity::${m.api.trim().toLowerCase()}`)
      if (key) return key
    }
  }
  return keys.find((k) => k.toLowerCase().endsWith('::assigned_se__c')) ?? null
}
const COVERAGE_STALE_MS = 26 * 60 * 60 * 1000 // older than a day+ = stale

attachRateDashRoutes.get('/attach-rate', requireDashboardAccess('attachRate'), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const scopeTeams = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const weekShift = parseWeekShift(req.query['weekShift'])
  // Honor an explicit start/end (custom range or FY/FQ pick) so the trend and
  // cohort window track the chosen fiscal period rather than weeksBack-from-now.
  const { rangeStart, rangeEnd } = resolveRange(req)
  const allTime = weeksBack <= 0 && !(typeof req.query['start'] === 'string' && req.query['start'])
  const dbRaw = String(req.query['dateBasis'] ?? 'created')
  const dateBasis: 'created' | 'close' | 'open' = dbRaw === 'close' ? 'close' : dbRaw === 'open' ? 'open' : 'created'
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  const userId = typeof req.query['userId'] === 'string' && req.query['userId'] ? req.query['userId'] : null
  const userIds = String(req.query['userIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const productIds = parseProductIds(req.query['productIds'])

  const empty = (over: Partial<AttachRateResp>): AttachRateResp => ({
    total: 0, attached: 0, pct: 0, totalAcv: 0, attachedAcv: 0, pctAcv: 0,
    primaryCount: 0, secondaryCount: 0, primaryAcv: 0, secondaryAcv: 0, callouts: [], calloutCount: 0, instanceUrl: null,
    weekly: [], breakdown: [], roles: [], dateBasis,
    notConfigured: false, stale: false, snapshotAt: null, hasHistory: false, noMatch: false, ...over,
  })
  if (scopeTeams.length === 0) { res.json({ data: empty({}), error: null }); return }

  // Which fields define "attached" for the active team(s). Fields may live
  // on Opportunity or a related object (e.g. Evaluations__c); the snapshot
  // stores their values keyed by `${crmObject}::${fieldApi}`. resolveUsers
  // marks values that are SF User Ids (→ resolve to names) vs already-name
  // multi-selects (shown as-is).
  const cfgRows = await db
    .select({ fieldApi: attachRateFields.fieldApi, crmObject: attachRateFields.crmObject, roleLabel: attachRateFields.roleLabel })
    .from(attachRateFields)
    .where(and(inArray(attachRateFields.teamId, scopeTeams), eq(attachRateFields.isActive, true)))
  const teamFieldMap = new Map<string, { key: string; role: string }>()
  for (const r of cfgRows) {
    if (!r.crmObject || !SF_FIELD_PATH.test(r.fieldApi)) continue
    const key = `${r.crmObject}::${r.fieldApi}`
    if (!teamFieldMap.has(key)) teamFieldMap.set(key, { key, role: (r.roleLabel && r.roleLabel.trim()) || humanizeField(r.fieldApi) })
  }
  const teamFields = Array.from(teamFieldMap.values())
  if (teamFields.length === 0) { res.json({ data: empty({ notConfigured: true }), error: null }); return }

  // Primary = the Assigned_SE__c field on Opportunity (inferred by name).
  // Everything else configured — plus opp-linked activities — is Secondary.
  const primaryKey = await attachPrimaryKey(scopeTeams, teamFields.map((f) => f.key))
  const secondaryKeys = teamFields.filter((f) => f.key !== primaryKey).map((f) => f.key)

  // Push the cohort + slice filters into SQL; aggregate the rest in JS.
  const startStr = format(rangeStart, 'yyyy-MM-dd')
  const endStr = format(rangeEnd, 'yyyy-MM-dd')
  const conds = [] as ReturnType<typeof eq>[]
  if (dateBasis === 'open') {
    conds.push(eq(crmOpportunityCoverage.isClosed, false))
  } else if (!allTime) {
    const col = dateBasis === 'close' ? crmOpportunityCoverage.closeDate : crmOpportunityCoverage.createdDate
    conds.push(isNotNull(col), gte(col, startStr), lte(col, endStr))
  } else {
    const col = dateBasis === 'close' ? crmOpportunityCoverage.closeDate : crmOpportunityCoverage.createdDate
    conds.push(isNotNull(col))
  }
  if (stages.length > 0) conds.push(inArray(crmOpportunityCoverage.stageName, stages))
  if (forecast.length > 0) conds.push(inArray(crmOpportunityCoverage.forecastCategory, forecast))
  // ACV weighting + range filter use Total_Acv__c (total_acv), falling back to
  // the standard Amount for opps whose snapshot predates that column.
  const acvExpr = sql`coalesce(${crmOpportunityCoverage.totalAcv}, ${crmOpportunityCoverage.amount})`
  const acvCond = acvRangeCond(acvExpr, acvRanges)
  if (acvCond) conds.push(acvCond)
  const demoCond = await demoCoverageCond(crmOpportunityCoverage.oppId, scopeTeams)
  if (demoCond) conds.push(demoCond)

  let rows = await db
    .select({
      oppId: crmOpportunityCoverage.oppId,
      oppName: crmOpportunityCoverage.oppName,
      ownerId: crmOpportunityCoverage.ownerId,
      ownerName: crmOpportunityCoverage.ownerName,
      createdDate: crmOpportunityCoverage.createdDate,
      closeDate: crmOpportunityCoverage.closeDate,
      amount: crmOpportunityCoverage.amount,
      totalAcv: crmOpportunityCoverage.totalAcv,
      fieldValues: crmOpportunityCoverage.fieldValues,
      snapshotAt: crmOpportunityCoverage.snapshotAt,
    })
    .from(crmOpportunityCoverage)
    .where(and(...conds))

  // v1.274.0: Products has no column on crm_opportunity_coverage (it's a
  // per-activity tag, not an Opportunity field), so "Products" narrows the
  // cohort to Opportunities that have at least one submitted, opp-linked,
  // product-tagged ImpactIQ activity — same Opp-only-filter convention as
  // Stage/Forecast/ACV above, just resolved via a side query instead of a
  // WHERE clause on this table.
  if (productIds.length > 0) {
    const { activityProducts } = await import('../../../../drizzle/schema.js')
    const prows = await db.selectDistinct({ id: activities.crmWhatId })
      .from(activities)
      .innerJoin(activityProducts, eq(activityProducts.activityId, activities.id))
      .where(and(
        inArray(activities.teamId, scopeTeams),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        eq(activities.crmWhatType, 'Opportunity'),
        isNotNull(activities.crmWhatId),
        inArray(activityProducts.productId, productIds),
      ))
    const productOppIds = new Set(prows.map((r) => r.id).filter((x): x is string => !!x))
    rows = rows.filter((r) => productOppIds.has(r.oppId))
  }

  // v1.276.0: Team-member/Subteam selection previously only narrowed the
  // "by SE" breakdown card further down (entries.filter by credited-SE
  // identity) while the headline total/attached/pct/weekly kept counting
  // the WHOLE team's cohort — selecting a person changed nothing about the
  // rate itself. Narrowing the cohort by "opps this SE is credited on" would
  // be circular (being credited literally IS the attach signal, so pct
  // would trivially read ~100%), so instead this narrows to the REPS that
  // selected ImpactIQ user(s) are aligned to cover (Sales Team Alignment —
  // the same crm_user_alignments source /attach-rate-breakdown's "Rep
  // Coverage" table uses), then recomputes the rate over just that book:
  // "of the Opportunities owned by the reps I'm responsible for, what % are
  // SE-covered (by anyone)?" — a real, non-circular number.
  if (userId || userIds.length > 0) {
    const targetUserIds = userId ? [userId] : userIds
    const alignRows = await db.select({ crmUserId: crmUserAlignments.crmUserId })
      .from(crmUserAlignments)
      .where(inArray(crmUserAlignments.userId, targetUserIds))
    const ownerIds = new Set(alignRows.map((r) => r.crmUserId))
    rows = rows.filter((r) => r.ownerId != null && ownerIds.has(r.ownerId))
  }

  // Opps with a qualifying secondary-signal activity: a submitted, opp-linked
  // ImpactIQ activity in the cohort window (all-time for the open basis).
  const activityOppSet = new Set<string>()
  {
    const aconds = [
      inArray(activities.teamId, scopeTeams),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      eq(activities.crmWhatType, 'Opportunity'),
      isNotNull(activities.crmWhatId),
    ]
    if (dateBasis !== 'open' && !allTime) aconds.push(gte(activities.startDatetime, rangeStart), lte(activities.startDatetime, rangeEnd))
    const arows = await db.selectDistinct({ id: activities.crmWhatId }).from(activities).where(and(...aconds))
    for (const a of arows) if (a.id) activityOppSet.add(a.id)
  }

  let snapshotAt: Date | null = null
  let total = 0
  let attached = 0
  // Weekly buckets (skip for open basis — no date cohort — and for all-time).
  const doWeekly = dateBasis !== 'open' && !allTime
  const weeklyMap = new Map<string, { total: number; attached: number }>()
  // Per-SE (Assigned-SE / Primary) breakdown: value → opps + acv.
  const perUserOpps = new Map<string, Set<string>>()
  const perUserAcv = new Map<string, number>()
  const perNameOpps = new Map<string, Set<string>>()
  const perNameAcv = new Map<string, number>()
  const creditSe = (vals: string[], oppId: string, amt: number) => {
    const seen = new Set<string>()
    for (const val of vals) {
      const isId = SF_ID_RX.test(val)
      const m = isId ? perUserOpps : perNameOpps
      const acvM = isId ? perUserAcv : perNameAcv
      let s = m.get(val); if (!s) { s = new Set(); m.set(val, s) }
      if (!s.has(oppId)) { s.add(oppId); if (!seen.has(val)) acvM.set(val, (acvM.get(val) ?? 0) + amt) }
      seen.add(val)
    }
  }
  // ACV (Opportunity Amount) weighted attach rate + per-role tallies + tiers.
  let totalAcv = 0
  let attachedAcv = 0
  let primaryCount = 0, secondaryCount = 0, primaryAcv = 0, secondaryAcv = 0
  const callouts: AttachRateCallout[] = []
  const roleAgg = new Map<string, { opps: number; acv: number }>()
  for (const f of teamFields) roleAgg.set(f.role, { opps: 0, acv: 0 })

  for (const r of rows) {
    if (r.snapshotAt && (!snapshotAt || r.snapshotAt > snapshotAt)) snapshotAt = r.snapshotAt
    total += 1
    const amt = Number(r.totalAcv ?? r.amount ?? 0) || 0
    totalAcv += amt
    const fv = (r.fieldValues ?? {}) as Record<string, string[]>
    // Per-role coverage counts (every configured field that's populated).
    for (const f of teamFields) {
      const v = fv[f.key]
      if (Array.isArray(v) && v.length > 0) { const agg = roleAgg.get(f.role)!; agg.opps += 1; agg.acv += amt }
    }
    const primaryVals = primaryKey ? (Array.isArray(fv[primaryKey]) ? fv[primaryKey] : []) : []
    const hasPrimary = primaryVals.length > 0
    const hasSecondaryField = secondaryKeys.some((k) => Array.isArray(fv[k]) && fv[k].length > 0)
    const hasActivity = activityOppSet.has(r.oppId)
    const tier: 'primary' | 'secondary' | 'none' = hasPrimary ? 'primary' : (hasSecondaryField || hasActivity) ? 'secondary' : 'none'
    const isAttached = tier !== 'none'
    if (tier === 'primary') { primaryCount += 1; primaryAcv += amt; creditSe(primaryVals, r.oppId, amt) }
    else if (tier === 'secondary') {
      secondaryCount += 1; secondaryAcv += amt
      if (callouts.length < 500) callouts.push({ oppId: r.oppId, name: r.oppName ?? r.oppId, acv: Math.round(amt), ownerName: r.ownerName ?? null, suggestedSe: null, ownerId: r.ownerId ?? null } as AttachRateCallout & { ownerId: string | null })
    }
    if (isAttached) { attached += 1; attachedAcv += amt }
    if (doWeekly) {
      const dateStr = dateBasis === 'close' ? r.closeDate : r.createdDate
      if (dateStr) {
        const ws = format(startOfWeek(new Date(`${dateStr}T00:00:00`), { weekStartsOn: 1 }), 'yyyy-MM-dd')
        const b = weeklyMap.get(ws) ?? { total: 0, attached: 0 }
        b.total += 1
        if (isAttached) b.attached += 1
        weeklyMap.set(ws, b)
      }
    }
  }
  const calloutCount = secondaryCount
  callouts.sort((a, b) => b.acv - a.acv)
  // Suggest an SE for each call-out from Sales Team Alignment on its owner:
  // the ImpactIQ user(s) covering that rep are who *should* be the Assigned SE.
  {
    const topCallouts = callouts as Array<AttachRateCallout & { ownerId?: string | null }>
    const ownerIds = Array.from(new Set(topCallouts.map((c) => c.ownerId).filter((x): x is string => !!x)))
    if (ownerIds.length > 0) {
      const al = await db
        .select({ crmUserId: crmUserAlignments.crmUserId, displayName: users.displayName })
        .from(crmUserAlignments)
        .innerJoin(users, eq(users.id, crmUserAlignments.userId))
        .where(inArray(crmUserAlignments.crmUserId, ownerIds))
      const byOwner = new Map<string, string>()
      for (const r of al) if (r.crmUserId && !byOwner.has(r.crmUserId)) byOwner.set(r.crmUserId, r.displayName ?? '')
      for (const c of topCallouts) if (c.ownerId) c.suggestedSe = byOwner.get(c.ownerId) ?? null
    }
  }
  const roles: AttachRateRole[] = teamFields
    .map((f) => ({ role: f.role, opps: roleAgg.get(f.role)!.opps, acv: Math.round(roleAgg.get(f.role)!.acv) }))
    .filter((r) => r.opps > 0)
    .sort((a, b) => b.opps - a.opps)

  // Emit a dense weekly series across the window so the trend has no gaps.
  const weekly: AttachRateWeek[] = []
  if (doWeekly) {
    let cursor = startOfWeek(rangeStart, { weekStartsOn: 1 })
    const last = startOfWeek(rangeEnd, { weekStartsOn: 1 })
    while (cursor <= last) {
      const ws = format(cursor, 'yyyy-MM-dd')
      const b = weeklyMap.get(ws) ?? { total: 0, attached: 0 }
      weekly.push({ weekStart: ws, total: b.total, attached: b.attached, pct: b.total > 0 ? Math.round((b.attached / b.total) * 1000) / 10 : 0 })
      cursor = addWeeks(cursor, 1)
    }
  }

  // Build the per-SE breakdown. Lookup-field user ids resolve to a name via
  // ImpactIQ users (carrying an app userId for drill-in) or the SF User-name
  // cache; name-valued fields are used as-is. Entries are then merged by
  // resolved name and their opp sets unioned, so the same person credited on
  // one opp through several fields counts once.
  const sfUids = Array.from(perUserOpps.keys())
  const appBySf = new Map<string, { userId: string; displayName: string }>()
  if (sfUids.length > 0) {
    const memberRows = await db
      .select({ userId: users.id, displayName: users.displayName, crmUserId: users.crmUserId })
      .from(users)
      .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
      .where(and(inArray(teamMembers.teamId, scopeTeams), isNotNull(users.crmUserId), inArray(users.crmUserId, sfUids)))
    for (const m of memberRows) {
      if (m.crmUserId && !appBySf.has(m.crmUserId)) appBySf.set(m.crmUserId, { userId: m.userId, displayName: m.displayName ?? m.userId })
    }
  }
  const unresolved = sfUids.filter((id) => !appBySf.has(id))
  const cacheBySf = new Map<string, string | null>()
  if (unresolved.length > 0) {
    const nameRows = await db.select({ crmUserId: sfUserNames.sfUserId, name: sfUserNames.name }).from(sfUserNames).where(inArray(sfUserNames.sfUserId, unresolved))
    for (const r of nameRows) cacheBySf.set(r.crmUserId, r.name)
  }

  interface Ident { display: string; userId: string | null; opps: Set<string>; acv: number }
  const identities = new Map<string, Ident>()
  const merge = (display: string, appUserId: string | null, opps: Set<string>, acv: number) => {
    const key = display.toLowerCase()
    const cur = identities.get(key) ?? { display, userId: appUserId, opps: new Set<string>(), acv: 0 }
    if (!cur.userId && appUserId) cur.userId = appUserId
    for (const o of opps) cur.opps.add(o)
    cur.acv += acv
    identities.set(key, cur)
  }
  for (const [sfId, opps] of perUserOpps) {
    const app = appBySf.get(sfId)
    const display = app?.displayName ?? cacheBySf.get(sfId) ?? sfId
    merge(display, app?.userId ?? null, opps, perUserAcv.get(sfId) ?? 0)
  }
  // v1.278.0: a name-valued field (the configured SF field is a literal-
  // string picklist, e.g. "Karim Azzouzi", rather than a User lookup) never
  // goes through perUserOpps's SF-ID matching above, so it used to always
  // merge with appUserId hardcoded to null — treating every name-valued
  // credit as "not in ImpactIQ" even when that exact person has an account,
  // just linked via a different field. Resolve these by display name
  // against the team roster instead of assuming unmatched.
  const rawNames = Array.from(perNameOpps.keys())
  const appByName = new Map<string, { userId: string; displayName: string }>()
  if (rawNames.length > 0) {
    const rosterRows = await db
      .select({ userId: users.id, displayName: users.displayName })
      .from(users)
      .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
      .where(inArray(teamMembers.teamId, scopeTeams))
    for (const m of rosterRows) {
      if (m.displayName) appByName.set(m.displayName.toLowerCase(), { userId: m.userId, displayName: m.displayName })
    }
  }
  for (const [name, opps] of perNameOpps) {
    const app = appByName.get(name.toLowerCase())
    merge(app?.displayName ?? name, app?.userId ?? null, opps, perNameAcv.get(name) ?? 0)
  }

  // v1.276.0 note: this used to also filter entries down to `e.userId ===
  // userId` here as "drill-in to a specific member" — that's now wrong.
  // userId/userIds already narrowed the COHORT itself above (to the reps
  // that ImpactIQ user is aligned to cover), so this breakdown should show
  // EVERY SE credited within that narrowed book, not hide all but the
  // selected person — otherwise selecting a rep would hide the very
  // coverage-by-others story the recompute was meant to surface.
  const entries = Array.from(identities.values())
  let breakdown: AttachRateUser[] = entries
    .map((e) => ({ userId: e.userId ?? `name:${e.display}`, displayName: e.display, oppsAttached: e.opps.size, acv: Math.round(e.acv), matched: e.userId != null }))
    .filter((b) => b.oppsAttached > 0)
    .sort((a, b) => b.oppsAttached - a.oppsAttached)

  let pct = total > 0 ? Math.round((attached / total) * 1000) / 10 : 0

  // "Snapshot exists?" must be judged globally, not from the filtered rows —
  // an empty cohort (e.g. no opps closing in the window) is NOT "no snapshot".
  const [latest] = await db.select({ at: sql<string | null>`max(${crmOpportunityCoverage.snapshotAt})` }).from(crmOpportunityCoverage)
  const globalSnapshotAt = latest?.at ? new Date(latest.at) : null
  const noMatch = total === 0 && globalSnapshotAt !== null

  // Open Pipeline trend + Compare come from recorded history (the live
  // snapshot has no past). Overall per team only — skipped when Stage /
  // Forecast / Products / Team-member filters are applied (the recorded
  // history is always team-wide, so it can't be compared against a
  // narrowed live cohort), and for the all-time window.
  let hasHistory = false
  const openHistoryEligible = dateBasis === 'open' && stages.length === 0 && forecast.length === 0 && acvRanges.length === 0
    && productIds.length === 0 && !userId && userIds.length === 0 && !allTime
  if (openHistoryEligible) {
    const hist = await db
      .select({ snapshotDate: attachRateHistory.snapshotDate, total: attachRateHistory.total, attached: attachRateHistory.attached })
      .from(attachRateHistory)
      .where(inArray(attachRateHistory.teamId, scopeTeams))
    const byDate = new Map<string, { total: number; attached: number }>()
    for (const h of hist) {
      const agg = byDate.get(h.snapshotDate) ?? { total: 0, attached: 0 }
      agg.total += h.total; agg.attached += h.attached
      byDate.set(h.snapshotDate, agg)
    }
    const dates = Array.from(byDate.keys()).sort()
    hasHistory = dates.length > 0
    // Value as-of a date = the most recent snapshot on or before it.
    const asOf = (dateStr: string): { total: number; attached: number } | null => {
      let pick: string | null = null
      for (const d of dates) { if (d <= dateStr) pick = d; else break }
      return pick ? byDate.get(pick)! : null
    }
    if (hasHistory && weekShift !== 0) {
      // Compare request — headline reflects the open-pipeline rate as of the
      // shifted week, so the client's TrendChip compares like-for-like.
      const v = asOf(format(rangeEnd, 'yyyy-MM-dd'))
      if (v) { total = v.total; attached = v.attached; pct = total > 0 ? Math.round((attached / total) * 1000) / 10 : 0 }
    } else if (hasHistory) {
      // Main request — build a weekly trend from history (as-of each week end).
      let cursor = startOfWeek(rangeStart, { weekStartsOn: 1 })
      const lastW = startOfWeek(rangeEnd, { weekStartsOn: 1 })
      while (cursor <= lastW) {
        const v = asOf(format(endOfWeek(cursor, { weekStartsOn: 1 }), 'yyyy-MM-dd'))
        weekly.push({ weekStart: format(cursor, 'yyyy-MM-dd'), total: v?.total ?? 0, attached: v?.attached ?? 0, pct: v && v.total > 0 ? Math.round((v.attached / v.total) * 1000) / 10 : 0 })
        cursor = addWeeks(cursor, 1)
      }
    }
  }

  const stale = !globalSnapshotAt || (Date.now() - globalSnapshotAt.getTime() > COVERAGE_STALE_MS)
  // SF base URL for deep-linking each missing-SE opportunity. Read from the
  // admin connection record (metadata connection all coverage is built from).
  let instanceUrl: string | null = null
  try {
    const [sfRow] = await db.select().from(systemSettings).where(eq(systemSettings.key, ADMIN_SF_SETTINGS_KEY)).limit(1)
    const rec = (sfRow?.value as { instanceUrl?: string } | undefined) ?? null
    instanceUrl = rec?.instanceUrl ? rec.instanceUrl.replace(/\/+$/, '') : null
  } catch { /* leave null — client hides the link */ }
  res.json({
    data: empty({
      total,
      attached,
      pct,
      totalAcv: Math.round(totalAcv),
      attachedAcv: Math.round(attachedAcv),
      pctAcv: totalAcv > 0 ? Math.round((attachedAcv / totalAcv) * 1000) / 10 : 0,
      primaryCount,
      secondaryCount,
      primaryAcv: Math.round(primaryAcv),
      secondaryAcv: Math.round(secondaryAcv),
      callouts,
      calloutCount,
      instanceUrl,
      weekly,
      breakdown,
      roles,
      stale,
      snapshotAt: globalSnapshotAt ? globalSnapshotAt.toISOString() : null,
      hasHistory,
      noMatch,
    }),
    error: null,
  })
})

// ─── Attach Rate breakdown by Team / Sub-team / User ────────────────────
// v1.192.0: two models, each grouped team → sub-team → user.
//   repOwned  — denominator = opps whose Owner is a Salesforce user aligned
//               (Admin → Sales Team Alignment) to the ImpactIQ user; rate =
//               attached ÷ owned. "How much of this rep/team's pipeline has
//               an SE."
//   seCentric — attached opps + ACV credited to each SE (from the attach
//               fields), grouped by the SE's team/sub-team. No denominator
//               (count-based).
// ─── Attach Rate breakdown by Team / Sub-team / User ────────────────────
// v1.193.0: two models, each grouped team → sub-team → user.
//   seCredit — Assigned SE (Primary) credit: opps + ACV where each user is
//              the Assigned SE, as a share of ALL attached opps / ACV.
//   repOwned — Sales-Team-Alignment coverage: for the opps each aligned rep
//              OWNS, how many the user is Primary-connected (Assigned SE) vs
//              Secondary-connected (an eval field or an opp activity, not the
//              Assigned SE), as a % of the rep's owned opps.
async function groupBreakdown<M extends Record<string, number>>(
  stats: Map<string, { name: string; m: M }>,
  scopeTeams: string[],
  zero: () => M,
): Promise<Array<{ key: string; level: 0 | 1 | 2; name: string; m: M }>> {
  const uids = Array.from(stats.keys())
  if (uids.length === 0) return []
  const tmRows = await db.select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers).where(and(inArray(teamMembers.userId, uids), inArray(teamMembers.teamId, scopeTeams)))
  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, scopeTeams))
  const teamName = new Map(teamRows.map((r) => [r.id, r.name]))
  const suRows = await db.select({ userId: subteamUsers.userId, subteamId: subteams.id, subName: subteams.name, subTeamId: subteams.teamId })
    .from(subteamUsers).innerJoin(subteams, eq(subteams.id, subteamUsers.subteamId))
    .where(and(inArray(subteamUsers.userId, uids), inArray(subteams.teamId, scopeTeams)))
  const userTeam = new Map<string, string>()
  for (const r of tmRows) if (!userTeam.has(r.userId)) userTeam.set(r.userId, r.teamId)
  const userSub = new Map<string, { id: string; name: string }>()
  for (const r of suRows) if (userTeam.get(r.userId) === r.subTeamId && !userSub.has(r.userId)) userSub.set(r.userId, { id: r.subteamId, name: r.subName })

  const addM = (a: M, b: M) => { for (const k of Object.keys(b) as Array<keyof M>) (a[k] as number) += (b[k] as number) }
  interface Node { name: string; m: M }
  const teamAgg = new Map<string, Node>()
  const subAgg = new Map<string, Node & { teamId: string }>()
  const userAgg: Array<{ uid: string; subKey: string; name: string; m: M }> = []
  for (const [uid, s] of stats) {
    const tId = userTeam.get(uid)
    if (!tId) continue
    const sub = userSub.get(uid)
    const subKey = sub ? `${tId}::${sub.id}` : `${tId}::_none`
    const subName = sub ? sub.name : '(No sub-team)'
    const tn = teamAgg.get(tId) ?? { name: teamName.get(tId) ?? tId, m: zero() }; addM(tn.m, s.m); teamAgg.set(tId, tn)
    const sn = subAgg.get(subKey) ?? { name: subName, teamId: tId, m: zero() }; addM(sn.m, s.m); subAgg.set(subKey, sn)
    userAgg.push({ uid, subKey, name: s.name, m: s.m })
  }
  const sortKey = (m: M) => (m['attached'] ?? m['opps'] ?? m['owned'] ?? 0) as number
  const rows: Array<{ key: string; level: 0 | 1 | 2; name: string; m: M }> = []
  const teamIds = Array.from(teamAgg.keys()).sort((a, b) => sortKey(teamAgg.get(b)!.m) - sortKey(teamAgg.get(a)!.m))
  for (const tId of teamIds) {
    rows.push({ key: `t:${tId}`, level: 0, name: teamAgg.get(tId)!.name, m: teamAgg.get(tId)!.m })
    const subKeys = Array.from(subAgg.keys()).filter((k) => subAgg.get(k)!.teamId === tId).sort((a, b) => sortKey(subAgg.get(b)!.m) - sortKey(subAgg.get(a)!.m))
    for (const sk of subKeys) {
      rows.push({ key: `s:${sk}`, level: 1, name: subAgg.get(sk)!.name, m: subAgg.get(sk)!.m })
      for (const u of userAgg.filter((x) => x.subKey === sk).sort((a, b) => sortKey(b.m) - sortKey(a.m))) {
        rows.push({ key: `u:${u.uid}:${sk}`, level: 2, name: u.name, m: u.m })
      }
    }
  }
  return rows
}

attachRateDashRoutes.get('/attach-rate-breakdown', requireDashboardAccess('attachRate'), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const scopeTeams = (await resolveTeamScope(req, teamId)) ?? []
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const { rangeStart, rangeEnd } = resolveRange(req)
  const allTime = weeksBack <= 0 && !(typeof req.query['start'] === 'string' && req.query['start'])
  const dbRaw = String(req.query['dateBasis'] ?? 'created')
  const dateBasis: 'created' | 'close' | 'open' = dbRaw === 'close' ? 'close' : dbRaw === 'open' ? 'open' : 'created'
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const acvRanges = parseAcvRanges(req.query['acv'])
  // v1.274.0: previously never read at all, so the Subteam/Team-member and
  // Products chips silently did nothing on this tab — SE Credit / Rep
  // Coverage always showed every rep team-wide regardless of selection.
  const userId = typeof req.query['userId'] === 'string' && req.query['userId'] ? req.query['userId'] : null
  const userIds = String(req.query['userIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const productIds = parseProductIds(req.query['productIds'])
  const emptyOut = { seCredit: [], repOwned: [], dateBasis }
  if (scopeTeams.length === 0) { res.json({ data: emptyOut, error: null }); return }

  const cfgRows = await db
    .select({ fieldApi: attachRateFields.fieldApi, crmObject: attachRateFields.crmObject })
    .from(attachRateFields)
    .where(and(inArray(attachRateFields.teamId, scopeTeams), eq(attachRateFields.isActive, true)))
  const allKeys = Array.from(new Set(cfgRows.filter((r) => r.crmObject && SF_FIELD_PATH.test(r.fieldApi)).map((r) => `${r.crmObject}::${r.fieldApi}`)))
  if (allKeys.length === 0) { res.json({ data: emptyOut, error: null }); return }
  const primaryKey = await attachPrimaryKey(scopeTeams, allKeys)
  const secondaryKeys = allKeys.filter((k) => k !== primaryKey)

  const conds = [] as ReturnType<typeof eq>[]
  if (dateBasis === 'open') conds.push(eq(crmOpportunityCoverage.isClosed, false))
  else {
    const col = dateBasis === 'close' ? crmOpportunityCoverage.closeDate : crmOpportunityCoverage.createdDate
    conds.push(isNotNull(col))
    if (!allTime) conds.push(gte(col, format(rangeStart, 'yyyy-MM-dd')), lte(col, format(rangeEnd, 'yyyy-MM-dd')))
  }
  if (stages.length > 0) conds.push(inArray(crmOpportunityCoverage.stageName, stages))
  if (forecast.length > 0) conds.push(inArray(crmOpportunityCoverage.forecastCategory, forecast))
  const acvExpr = sql`coalesce(${crmOpportunityCoverage.totalAcv}, ${crmOpportunityCoverage.amount})`
  const acvCond = acvRangeCond(acvExpr, acvRanges)
  if (acvCond) conds.push(acvCond)
  const demoCond = await demoCoverageCond(crmOpportunityCoverage.oppId, scopeTeams)
  if (demoCond) conds.push(demoCond)
  let rows = await db.select({
    oppId: crmOpportunityCoverage.oppId,
    ownerId: crmOpportunityCoverage.ownerId,
    amount: crmOpportunityCoverage.amount,
    totalAcv: crmOpportunityCoverage.totalAcv,
    fieldValues: crmOpportunityCoverage.fieldValues,
  }).from(crmOpportunityCoverage).where(and(...conds))

  // Products has no column on crm_opportunity_coverage — narrow to
  // Opportunities with a submitted, opp-linked, product-tagged activity,
  // same convention as /attach-rate above.
  if (productIds.length > 0) {
    const { activityProducts } = await import('../../../../drizzle/schema.js')
    const prows = await db.selectDistinct({ id: activities.crmWhatId })
      .from(activities)
      .innerJoin(activityProducts, eq(activityProducts.activityId, activities.id))
      .where(and(
        inArray(activities.teamId, scopeTeams),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        eq(activities.crmWhatType, 'Opportunity'),
        isNotNull(activities.crmWhatId),
        inArray(activityProducts.productId, productIds),
      ))
    const productOppIds = new Set(prows.map((r) => r.id).filter((x): x is string => !!x))
    rows = rows.filter((r) => productOppIds.has(r.oppId))
  }

  // v1.276.0: same reinterpretation as /attach-rate above — Team-member/
  // Subteam selection narrows the cohort to the REPS that ImpactIQ user(s)
  // are aligned to cover (crm_user_alignments), not to opps a specific SE
  // happens to be credited on (which would be circular here too). SE
  // Credit / Rep Coverage are then computed over just that narrowed book.
  if (userId || userIds.length > 0) {
    const targetUserIds = userId ? [userId] : userIds
    const alignRows = await db.select({ crmUserId: crmUserAlignments.crmUserId })
      .from(crmUserAlignments)
      .where(inArray(crmUserAlignments.userId, targetUserIds))
    const ownerIds = new Set(alignRows.map((r) => r.crmUserId))
    rows = rows.filter((r) => r.ownerId != null && ownerIds.has(r.ownerId))
  }

  // Opp → app users who logged a qualifying activity (secondary signal).
  const activityByOpp = new Map<string, Set<string>>()
  {
    const aconds = [
      inArray(activities.teamId, scopeTeams), eq(activities.status, 'submitted'), eq(activities.isArchived, false),
      eq(activities.crmWhatType, 'Opportunity'), isNotNull(activities.crmWhatId),
    ]
    if (dateBasis !== 'open' && !allTime) aconds.push(gte(activities.startDatetime, rangeStart), lte(activities.startDatetime, rangeEnd))
    const arows = await db.select({ oppId: activities.crmWhatId, userId: activities.userId }).from(activities).where(and(...aconds))
    for (const a of arows) { if (!a.oppId) continue; const s = activityByOpp.get(a.oppId) ?? new Set<string>(); s.add(a.userId); activityByOpp.set(a.oppId, s) }
  }

  // Resolve every SF-id-shaped attach value to an app user in scope.
  const sfIds = new Set<string>()
  for (const r of rows) { const fv = (r.fieldValues ?? {}) as Record<string, string[]>; for (const k of allKeys) for (const v of (fv[k] ?? [])) if (SF_ID_RX.test(v)) sfIds.add(v) }
  const appBySf = new Map<string, { uid: string; name: string }>()
  if (sfIds.size > 0) {
    const ur = await db.select({ uid: users.id, name: users.displayName, crmUserId: users.crmUserId })
      .from(users).innerJoin(teamMembers, eq(teamMembers.userId, users.id))
      .where(and(inArray(teamMembers.teamId, scopeTeams), isNotNull(users.crmUserId), inArray(users.crmUserId, Array.from(sfIds))))
    for (const r of ur) if (r.crmUserId && !appBySf.has(r.crmUserId)) appBySf.set(r.crmUserId, { uid: r.uid, name: r.name ?? r.uid })
  }
  // v1.278.0: a field configured as a literal-string picklist (not a User
  // lookup) never matches SF_ID_RX, so its values used to be silently
  // dropped here — an ImpactIQ user credited only through a name-valued
  // field (e.g. "Karim Azzouzi" as text) got no SE Credit at all, same root
  // cause as the "Attached by SE" fix above. Resolve non-Id values by
  // display name against the team roster too.
  const appByName = new Map<string, { uid: string; name: string }>()
  {
    const rosterRows = await db.select({ uid: users.id, name: users.displayName })
      .from(users).innerJoin(teamMembers, eq(teamMembers.userId, users.id))
      .where(inArray(teamMembers.teamId, scopeTeams))
    for (const r of rosterRows) if (r.name) appByName.set(r.name.toLowerCase(), { uid: r.uid, name: r.name })
  }
  const resolveApp = (vals: string[]): Set<string> => {
    const out = new Set<string>()
    for (const v of vals) {
      const a = SF_ID_RX.test(v) ? appBySf.get(v) : appByName.get(v.toLowerCase())
      if (a) out.add(a.uid)
    }
    return out
  }

  // Alignments: SF owner id → ImpactIQ users covering that rep.
  const alignRows = await db.select({ userId: crmUserAlignments.userId, crmUserId: crmUserAlignments.crmUserId }).from(crmUserAlignments)
  const impactBySf = new Map<string, Set<string>>()
  for (const a of alignRows) { const s = impactBySf.get(a.crmUserId) ?? new Set<string>(); s.add(a.userId); impactBySf.set(a.crmUserId, s) }

  // Per-opp classification + overall attached totals (for SE-credit shares).
  let allAttached = 0, allAttachedAcv = 0
  interface Se { name: string; m: { opps: number; acv: number } }
  interface Rep { name: string; m: { owned: number; primary: number; secondary: number; ownedAcv: number; primaryAcv: number; secondaryAcv: number } }
  const seStats = new Map<string, Se>()
  const repStats = new Map<string, Rep>()
  // v1.280.0: nameCache used to only be seeded from appBySf (the SF-ID
  // matches), so a name-valued credit resolved via appByName (v1.278.0)
  // still fell back to the raw ImpactIQ user id as its display "name" here
  // — the fix that made resolveApp() find these people never taught this
  // cache about them.
  const nameCache = new Map<string, string>()
  for (const [, a] of appBySf) nameCache.set(a.uid, a.name)
  for (const [, a] of appByName) nameCache.set(a.uid, a.name)

  for (const r of rows) {
    const amt = Number(r.totalAcv ?? r.amount ?? 0) || 0
    const fv = (r.fieldValues ?? {}) as Record<string, string[]>
    const primaryVals = primaryKey ? (Array.isArray(fv[primaryKey]) ? fv[primaryKey] : []) : []
    const hasPrimary = primaryVals.length > 0
    const secFieldVals: string[] = []
    for (const k of secondaryKeys) for (const v of (fv[k] ?? [])) secFieldVals.push(v)
    const activityUsers = activityByOpp.get(r.oppId) ?? new Set<string>()
    const hasSecondary = secFieldVals.length > 0 || activityUsers.size > 0
    const tier: 'primary' | 'secondary' | 'none' = hasPrimary ? 'primary' : hasSecondary ? 'secondary' : 'none'
    if (tier === 'none') continue
    allAttached += 1; allAttachedAcv += amt

    const assignedApp = resolveApp(primaryVals)
    // SE credit — Assigned SE only, on primary-tier opps.
    if (tier === 'primary') {
      for (const uid of assignedApp) {
        const s = seStats.get(uid) ?? { name: nameCache.get(uid) ?? uid, m: { opps: 0, acv: 0 } }
        s.m.opps += 1; s.m.acv += amt; seStats.set(uid, s)
      }
    }

    // Rep coverage — attribute the opp to the ImpactIQ users aligned to its owner.
    if (r.ownerId) {
      const ius = impactBySf.get(r.ownerId)
      if (ius) {
        const secondaryApp = new Set<string>([...resolveApp(secFieldVals), ...activityUsers])
        for (const a of assignedApp) secondaryApp.delete(a)
        for (const iu of ius) {
          const s = repStats.get(iu) ?? { name: iu, m: { owned: 0, primary: 0, secondary: 0, ownedAcv: 0, primaryAcv: 0, secondaryAcv: 0 } }
          s.m.owned += 1; s.m.ownedAcv += amt
          if (assignedApp.has(iu)) { s.m.primary += 1; s.m.primaryAcv += amt }
          else if (secondaryApp.has(iu)) { s.m.secondary += 1; s.m.secondaryAcv += amt }
          repStats.set(iu, s)
        }
      }
    }
  }

  // Fill display names for rep users (aligned ImpactIQ users).
  const repUids = Array.from(repStats.keys())
  if (repUids.length > 0) {
    const nr = await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, repUids))
    const byId = new Map(nr.map((r) => [r.id, r.name]))
    for (const [uid, s] of repStats) s.name = byId.get(uid) ?? uid
  }

  const [seGroups, repGroups] = await Promise.all([
    groupBreakdown(new Map(Array.from(seStats, ([uid, s]) => [uid, { name: s.name, m: s.m }])), scopeTeams, () => ({ opps: 0, acv: 0 })),
    groupBreakdown(new Map(Array.from(repStats, ([uid, s]) => [uid, { name: s.name, m: s.m }])), scopeTeams, () => ({ owned: 0, primary: 0, secondary: 0, ownedAcv: 0, primaryAcv: 0, secondaryAcv: 0 })),
  ])
  const pctOf = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0
  const seCredit = seGroups.map((g) => ({
    key: g.key, level: g.level, name: g.name,
    opps: g.m.opps, acv: Math.round(g.m.acv),
    oppsPct: pctOf(g.m.opps, allAttached), acvPct: pctOf(g.m.acv, allAttachedAcv),
  }))
  const repOwned = repGroups.map((g) => ({
    key: g.key, level: g.level, name: g.name,
    owned: g.m.owned, primary: g.m.primary, secondary: g.m.secondary,
    primaryPct: pctOf(g.m.primary, g.m.owned), secondaryPct: pctOf(g.m.secondary, g.m.owned),
    ownedAcv: Math.round(g.m.ownedAcv), primaryAcv: Math.round(g.m.primaryAcv), secondaryAcv: Math.round(g.m.secondaryAcv),
  }))
  res.json({ data: { seCredit, repOwned, dateBasis }, error: null })
})
