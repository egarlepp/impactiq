import { Router } from 'express'
import { db } from '../../db/index.js'
import { activities, users } from '../../../../drizzle/schema.js'
import { getCrmProviderId } from '../../services/crm/index.js'
import { and, eq, sql, inArray } from 'drizzle-orm'
import { resolveCostBatch } from '../../services/capacity/resolver.js'
import { requireDashboardAccess } from '../../middleware/rbac.js'

import {
  resolveTeamScope,
  rangeFor,
  parseDateBasis,
  dateWindow,
  parseWeekShift,
  parseProductIds,
  parseMemberIds,
  productFilterCond,
  parseAcvRanges,
  amountInRanges,
  acvRangesInUsd,
  loadFxByCurrency,
  directCostUsd,
  aggregateCostByGroup,
} from './shared.js'

export const revenueDashRoutes = Router()

// GET /api/dashboards/revenue/opp-roi?teamId=&weeks=
// Per-Opportunity aggregation: hours, cost, ACV, activity count. Cost is
// resolved per-activity via the capacity resolver, which picks the rate
// that was effective on the activity's start date (override → cost
// group → unset). Activities with an unresolved rate contribute 0 to
// cost and are counted but skipped in the ROI math.
revenueDashRoutes.get('/revenue/opp-roi', requireDashboardAccess('oppRoi'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string
  const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const acvRanges = parseAcvRanges(req.query['acv'])
  // v1.274.0: this route was Opportunity-only (`crmWhatType = 'Opportunity'`)
  // from the start, so Stage/Forecast/Products can be pushed straight into
  // the SQL WHERE clause — unlike mixed Account+Opp routes, there's no
  // non-Opp row here that could wrongly be excluded.
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)

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
      oppId: activities.crmWhatId,
      oppName: activities.crmWhatName,
    })
    .from(activities)
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      sql`${activities.crmWhatId} IS NOT NULL`,
      eq(activities.crmWhatType, 'Opportunity'),
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
      ...(productCond ? [productCond] : []),
      ...(stages.length > 0 ? [inArray(activities.salesStage, stages)] : []),
      ...(forecast.length > 0 ? [inArray(activities.forecastCategory, forecast)] : []),
    ))

  const perOpp = await aggregateCostByGroup(rawRows, (r) => `${r.oppId}::${r.oppName}`)
  // ACV range: filter on the per-Opp (max) ACV the scatter plots. Cost tab, so
  // the buckets are nominal in the display currency — map them back to USD.
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, await loadFxByCurrency())
  const out = perOpp
    .filter(([, agg]) => amountInRanges(agg.acv, usdAcvRanges))
    .map(([key, agg]) => {
      const [oppId, oppName] = key.split('::')
      return { oppId, oppName, ...agg }
    })

  res.json({ data: out, error: null, meta: {} })
})

// GET /api/dashboards/revenue/cost-per-acv?teamId=&weeks=&groupBy=opp|account
// Ranked list of Opportunities or Accounts by cost-of-engagement.
//   groupBy=opp     — one row per Opportunity, ranked by cost / ACV %.
//   groupBy=account — one row per Account. Rolls up every Opportunity
//                     under that account plus any activities linked
//                     directly to the account. Returns numOpportunities
//                     + avgCostPerOpp instead of ACV / cost-per-ACV.
revenueDashRoutes.get('/revenue/cost-per-acv', requireDashboardAccess('costPerAcv'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string
  const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const acvRanges = parseAcvRanges(req.query['acv'])
  // v1.274.0: Stage/Forecast are a per-row denormalized snapshot (not an
  // aggregate like ACV), so they can go straight into the SQL WHERE clause —
  // a non-Opp row (Account-direct, in groupBy=account mode) has NULL
  // salesStage/forecastCategory and is correctly excluded by IN(), matching
  // the "non-Opp rows drop out when a filter is active" convention used
  // elsewhere (Most Expensive, Manager Rollup, Burn, Account Concentration).
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const productIds = parseProductIds(req.query['productIds'])
  const productCond = productFilterCond(productIds)
  const groupBy = req.query['groupBy'] === 'account' ? 'account' : 'opp'
  const userId = req.query['userId'] as string | undefined
  const memberIds = parseMemberIds(req.query['userIds'])
  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)

  // For account mode we pull Opportunity-linked activities too so we can
  // roll them up under the parent account (and count distinct opps).
  const whatTypeCondition = groupBy === 'account'
    ? inArray(activities.crmWhatType, ['Opportunity', 'Account'] as const)
    : eq(activities.crmWhatType, 'Opportunity')

  const rawRows = await db
    .select({
      userId: activities.userId,
      userName: users.displayName,
      teamId: activities.teamId,
      startDatetime: activities.startDatetime,
      effortHours: activities.effortHours,
      costTransportation: activities.costTransportation,
      costLodging: activities.costLodging,
      costFood: activities.costFood,
      incidentalCurrency: activities.incidentalCurrency,
      acv: activities.acv,
      id: activities.crmWhatId,
      name: activities.crmWhatName,
      whatType: activities.crmWhatType,
      accountId: activities.crmAccountId,
      accountName: activities.crmAccountName,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.userId))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      sql`${activities.crmWhatId} IS NOT NULL`,
      whatTypeCondition,
      ...(userId ? [eq(activities.userId, userId)] : []),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
      ...(productCond ? [productCond] : []),
      ...(stages.length > 0 ? [inArray(activities.salesStage, stages)] : []),
      ...(forecast.length > 0 ? [inArray(activities.forecastCategory, forecast)] : []),
    ))

  // In account mode, resolve each unique opportunity id to its parent
  // account via Salesforce. Best-effort — if the caller has no SF
  // connection, opp-linked activities can't be rolled up under an
  // account and we skip them (still surface directly-linked account
  // activities). The stub SF branch inside getSfConnection returns
  // deterministic fake accounts in dev.
  const oppToAccount = new Map<string, { accountId: string; accountName: string | null }>()
  // HubSpot (phase 3): the Deal's Company is stored on the activity at save
  // time and kept current by the nightly refresh, so no live read.
  const accountFromSnapshot = groupBy === 'account' && (await getCrmProviderId()) === 'hubspot'
  if (accountFromSnapshot) {
    for (const r of rawRows) {
      if (r.whatType === 'Opportunity' && r.id && r.accountId && !oppToAccount.has(r.id)) {
        oppToAccount.set(r.id, { accountId: r.accountId, accountName: r.accountName ?? null })
      }
    }
  }
  if (groupBy === 'account' && !accountFromSnapshot) {
    const oppIds = Array.from(new Set(rawRows.filter((r) => r.whatType === 'Opportunity' && r.id).map((r) => r.id as string)))
    if (oppIds.length > 0) {
      try {
        const { getSfConnection } = await import('../../services/salesforce/client.js')
        const { safeSoqlLiteral } = await import('../../services/salesforce/soql.js')
        const conn = await getSfConnection(req.user!.id)
        if (conn) {
          // Batch in ~200-id chunks — SOQL IN() has a 20k character cap.
          const chunkSize = 200
          for (let i = 0; i < oppIds.length; i += chunkSize) {
            const chunk = oppIds.slice(i, i + chunkSize)
            const escaped = chunk.map((id) => `'${safeSoqlLiteral(id)}'`).join(',')
            const soql = `SELECT Id, AccountId, Account.Name FROM Opportunity WHERE Id IN (${escaped})`
            const q = await conn.query<{ Id: string; AccountId: string | null; Account: { Name: string } | null }>(soql)
            for (const r of q.records) {
              if (r.AccountId) oppToAccount.set(r.Id, { accountId: r.AccountId, accountName: r.Account?.Name ?? null })
            }
          }
        }
      } catch {
        // Ignore — best effort; opp rows without a resolved account are
        // dropped from the account grouping.
      }
    }
  }

  // Resolve each activity's cost + currency. Then convert to USD using
  // the freshest cached FX rate so we can sum across mixed currencies.
  // Also assemble a per-user breakdown so the client can render the
  // "who contributed at which rate" popover.
  const costResolved = await resolveCostBatch(rawRows.map((r) => ({
    userId: r.userId, teamId: r.teamId, asOf: new Date(r.startDatetime),
  })))
  // Reuse the cached FX map (this endpoint previously ran a second fx_rates
  // query here in addition to the one via acvRangesInUsd above).
  const fxByCurrency = await loadFxByCurrency()

  interface UserBreakdown {
    userId: string
    userName: string
    hours: number
    currency: string | null
    ratePerHour: number | null
    localCost: number
    costUsd: number
    directCostsUsd: number
    fxRatePerUsd: number | null
    fxAsOf: string | null
    fxMissing: boolean
  }
  interface Agg {
    id: string
    name: string | null
    whatType: string
    hours: number
    costUsd: number
    directCostsUsd: number
    acv: number
    activityCount: number
    // Only populated for account mode — set of opp ids rolled up into
    // this account so we can report numOpportunities + avgCostPerOpp.
    oppIds: Set<string>
    byUser: Map<string, UserBreakdown>
  }
  const byGroup = new Map<string, Agg>()

  // ACV range: exclude Opps whose (max) ACV is out of range, and drop
  // Account-direct rows when a range is active, BEFORE rollup so a filtered
  // Opp never inflates its parent account. Cost tab → buckets are nominal in
  // the display currency, mapped back to USD.
  const usdAcvRanges = acvRangesInUsd(req, acvRanges, fxByCurrency)
  const oppMaxAcvTce = new Map<string, number>()
  if (acvRanges.length > 0) {
    for (const r of rawRows) {
      if (r.whatType === 'Opportunity' && r.id) {
        const v = Number(r.acv ?? 0)
        if (v > (oppMaxAcvTce.get(r.id) ?? 0)) oppMaxAcvTce.set(r.id, v)
      }
    }
  }

  for (const r of rawRows) {
    if (acvRanges.length > 0) {
      if (r.whatType === 'Opportunity' && r.id) {
        if (!amountInRanges(oppMaxAcvTce.get(r.id) ?? 0, usdAcvRanges)) continue
      } else {
        continue // non-Opp rows excluded while an ACV range is active
      }
    }
    // Resolve grouping key. In account mode:
    //   * Account-linked activities key on the crmWhatId directly.
    //   * Opportunity-linked activities key on the opp's parent
    //     account (from SF). If we couldn't resolve the account,
    //     skip — we don't want an orphaned "unknown account" row.
    let key: string
    let entityId: string
    let entityName: string | null
    if (groupBy === 'account') {
      if (r.whatType === 'Account') {
        entityId = r.id!
        entityName = r.name ?? null
      } else {
        const acct = oppToAccount.get(r.id!)
        if (!acct) continue
        entityId = acct.accountId
        entityName = acct.accountName
      }
      key = `${entityId}::${entityName ?? ''}::Account`
    } else {
      entityId = r.id!
      entityName = r.name ?? null
      key = `${entityId}::${entityName ?? ''}::Opportunity`
    }

    let agg = byGroup.get(key)
    if (!agg) {
      agg = { id: entityId, name: entityName, whatType: groupBy === 'account' ? 'Account' : 'Opportunity', hours: 0, costUsd: 0, directCostsUsd: 0, acv: 0, activityCount: 0, oppIds: new Set(), byUser: new Map() }
      byGroup.set(key, agg)
    }
    const effort = Number(r.effortHours)
    agg.hours += effort
    agg.activityCount += 1
    agg.acv = Math.max(agg.acv, Number(r.acv ?? 0))
    if (groupBy === 'account' && r.whatType === 'Opportunity' && r.id) agg.oppIds.add(r.id)

    const cost = costResolved.get(`${r.userId}::${r.teamId}`)
    const currency = cost?.currency ?? null
    const rate = cost?.rate ?? null
    const fx = currency ? fxByCurrency.get(currency) ?? null : null

    let costUsd = 0
    if (rate != null && currency) {
      const localCost = effort * rate
      if (currency === 'USD') costUsd = localCost
      else if (fx && fx.ratePerUsd > 0) costUsd = localCost / fx.ratePerUsd
    }
    agg.costUsd += costUsd
    // Direct (incidental/travel) costs on this activity, converted from the
    // currency they were entered in — folded into TCE and the breakdown.
    const directUsd = directCostUsd(r, fxByCurrency)
    agg.directCostsUsd += directUsd

    const ub = agg.byUser.get(r.userId) ?? {
      userId: r.userId,
      userName: r.userName,
      hours: 0,
      currency,
      ratePerHour: rate,
      localCost: 0,
      costUsd: 0,
      directCostsUsd: 0,
      fxRatePerUsd: fx?.ratePerUsd ?? (currency === 'USD' ? 1 : null),
      fxAsOf: fx?.asOf ?? null,
      fxMissing: currency !== null && currency !== 'USD' && !fx,
    }
    ub.hours += effort
    if (rate != null) ub.localCost += effort * rate
    ub.costUsd += costUsd
    ub.directCostsUsd += directUsd
    agg.byUser.set(r.userId, ub)
  }

  const enriched = Array.from(byGroup.values()).map((a) => {
    const numOpps = a.oppIds.size
    // Total Cost of Engagement = labor (USD) + direct costs (USD).
    const tceUsd = a.costUsd + a.directCostsUsd
    return {
      id: a.id,
      name: a.name,
      whatType: a.whatType,
      hours: String(a.hours),
      // Amounts are always in USD; client uses meta.fxRates to reformat if
      // the user chooses a different display currency. costDollars = labor
      // only; directCostsUsd is separate so the client can show both columns
      // and compute TCE = labor + direct.
      costDollars: String(a.costUsd),
      directCostsUsd: String(a.directCostsUsd),
      acv: groupBy === 'account' ? null : String(a.acv),
      activityCount: a.activityCount,
      numOpportunities: groupBy === 'account' ? numOpps : null,
      avgCostPerOpp: groupBy === 'account' && numOpps > 0 ? tceUsd / numOpps : null,
      costPerAcvPct: groupBy === 'opp' && a.acv > 0 ? (tceUsd / a.acv) * 100 : null,
      breakdown: Array.from(a.byUser.values()).sort((u1, u2) => u2.hours - u1.hours),
    }
  })
  enriched.sort((a, b) => {
    if (groupBy === 'account') {
      // Sort by TCE (labor + direct) desc so the costliest engagements float up.
      return (Number(b.costDollars) + Number(b.directCostsUsd)) - (Number(a.costDollars) + Number(a.directCostsUsd))
    }
    if (a.costPerAcvPct === null && b.costPerAcvPct === null) return 0
    if (a.costPerAcvPct === null) return 1
    if (b.costPerAcvPct === null) return -1
    return b.costPerAcvPct - a.costPerAcvPct
  })

  const availableCurrencies = Array.from(new Set(['USD', ...Array.from(fxByCurrency.keys())])).sort()

  res.json({
    data: enriched,
    error: null,
    meta: {
      availableCurrencies,
      fxRates: Object.fromEntries(Array.from(fxByCurrency.entries()).map(([c, v]) => [c, { ratePerUsd: v.ratePerUsd, asOf: v.asOf }])),
    },
  })
})
