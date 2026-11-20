import { Router } from 'express'
import { db } from '../../db/index.js'
import {
  activities,
  users,
  teamMembers,
  crmSnapshotState,
  attachRateFields,
  crmOpportunityCoverage,
} from '../../../../drizzle/schema.js'
import { getActiveCrmProvider, getCrmProviderId, type CrmProvider } from '../../services/crm/index.js'
import { getDealFilterOptions } from '../../services/hubspot/metadata.js'
import { refreshOppCoverage } from '../../services/salesforce/refreshOppCoverage.js'
import { refreshHubspotOppCoverage } from '../../services/hubspot/attachCoverage.js'
import { getSfConnection } from '../../services/salesforce/client.js'
import { and, eq, gte, lte, inArray, isNotNull } from 'drizzle-orm'
import { getFiscalConfig, type FiscalConfig } from '../../services/config/fiscal.js'
import { detectAnomalies } from '../../services/dashboards/anomalies.js'
import { requireRole, requireAnyLeaderOrAdmin } from '../../middleware/rbac.js'

import { resolveTeamScope, parseWeekShift, parseProductIds, productFilterCond } from './shared.js'

import { SF_FIELD_PATH, SF_ID_RX } from './attachRate.js'

export const opportunityDataDashRoutes = Router()

// ─── v1.137.0: Manual SF Opp snapshot refresh ──────────────────────────
// Throttled to one call per user per 30 minutes (raised from 10min in
// v1.273.0 — a leader clicking it repeatedly hammered Salesforce with no
// benefit, since the SOQL cost is the same regardless of how much actually
// changed since the watermark).
const REFRESH_THROTTLE_MS = 30 * 60 * 1000

// GET status so the client can render a live countdown on the button BEFORE
// the user clicks (rather than only learning the wait time from a 429 after
// clicking) — v1.273.0.
opportunityDataDashRoutes.get('/refresh-opp-snapshots/status', requireAnyLeaderOrAdmin, async (req, res) => {
  const userId = req.user!.id
  const [u] = await db.select({ last: users.snapshotRefreshLastAt }).from(users).where(eq(users.id, userId)).limit(1)
  const nowMs = Date.now()
  const elapsed = u?.last ? nowMs - u.last.getTime() : null
  const retryAfterSec = elapsed != null && elapsed < REFRESH_THROTTLE_MS ? Math.ceil((REFRESH_THROTTLE_MS - elapsed) / 1000) : 0
  res.json({ data: { lastClickedAt: u?.last ?? null, retryAfterSec }, error: null, meta: {} })
})

opportunityDataDashRoutes.post('/refresh-opp-snapshots', requireAnyLeaderOrAdmin, async (req, res) => {
  const userId = req.user!.id
  // Checked before the throttle so a click on an install with no CRM
  // doesn't start the 30-minute wait.
  const provider = await getActiveCrmProvider()
  if (!provider) {
    res.json({ data: null, error: 'errors.crm.provider_mismatch', meta: {} })
    return
  }
  const [u] = await db.select({ last: users.snapshotRefreshLastAt }).from(users).where(eq(users.id, userId)).limit(1)
  const nowMs = Date.now()
  if (u?.last) {
    const elapsed = nowMs - u.last.getTime()
    if (elapsed < REFRESH_THROTTLE_MS) {
      const remainingSec = Math.ceil((REFRESH_THROTTLE_MS - elapsed) / 1000)
      res.status(429).json({ data: null, error: 'throttled', meta: { retryAfterSec: remainingSec } })
      return
    }
  }
  await db.update(users).set({ snapshotRefreshLastAt: new Date() }).where(eq(users.id, userId))
  let result: Awaited<ReturnType<CrmProvider['refreshSnapshots']>>
  try {
    result = await provider.refreshSnapshots({ source: 'manual' })
  } catch (e) {
    res.json({ data: null, error: e instanceof Error ? e.message : 'refresh_failed', meta: {} })
    return
  }
  // v1.188.0: the manual refresh also refills the Attach Rate coverage
  // snapshot so the two SF-derived datasets stay in step. Errors here are
  // captured in its own job_runs row and never fail the primary refresh.
  if (provider.id === 'salesforce') await refreshOppCoverage().catch(() => {})
  else if (provider.id === 'hubspot') await refreshHubspotOppCoverage().catch(() => {})
  const [state] = await db.select().from(crmSnapshotState).where(eq(crmSnapshotState.key, 'opp_snapshot')).limit(1)
  // v1.271.0: refreshSnapshots() never throws on a soft failure (e.g. no
  // admin SF connection configured) — it just pushes onto result.errors and
  // returns normally. Previously that meant this route always answered
  // { error: null } even when nothing actually ran, so the button's reload
  // showed the same stale data with no indication anything had failed.
  if (result.errors.length > 0) {
    res.json({ data: result, error: result.errors[0], meta: { refreshedAt: state?.refreshedAt ?? null, retryAfterSec: Math.ceil(REFRESH_THROTTLE_MS / 1000) } })
    return
  }
  res.json({ data: result, error: null, meta: { refreshedAt: state?.refreshedAt ?? null, retryAfterSec: Math.ceil(REFRESH_THROTTLE_MS / 1000) } })
})

// ─── v1.137.0: Distinct Stage + Forecast values for filter chips ────────
// v1.192.0: the filter options now come from the live Salesforce
// Opportunity picklists (StageName / ForecastCategoryName) so every valid
// choice shows — not just values that happen to appear on logged
// activities. Cached ~1h; falls back to the activities-distinct set when SF
// isn't connected or describe fails.
let sfPicklistCache: { at: number; stages: string[]; forecast: string[] } | null = null
const SF_PICKLIST_TTL_MS = 60 * 60 * 1000
// GET /api/dashboards/anomalies?teamId=&productIds=&weekShift=
// Callouts for the leader dashboard banner. Evaluates the LAST COMPLETED week
// against a fixed 8-week trailing baseline — deliberately not the dashboard's
// date filter, because "normal" is a property of the team, not of whatever
// range the leader happens to have selected.
opportunityDataDashRoutes.get('/anomalies', requireRole('leader', 'admin'), async (req, res) => {
  const teamId = req.query['teamId'] as string
  const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const productIds = parseProductIds(req.query['productIds'])
  const weekShift = parseWeekShift(req.query['weekShift'])
  try {
    const data = await detectAnomalies({
      teamIds,
      productCond: productFilterCond(productIds),
      weekShift,
    })
    res.json({ data, error: null, meta: {} })
  } catch (err) {
    console.error('[/api/dashboards/anomalies] failed:', err instanceof Error ? err.message : String(err))
    res.status(500).json({ data: null, error: 'errors.dashboards.anomalies_failed', meta: {} })
  }
})

opportunityDataDashRoutes.get('/stage-forecast-options', async (req, res) => {
  const teamScope = (await resolveTeamScope(req, req.query['teamId'] as string | undefined)) ?? []
  if (teamScope.length === 0) { res.json({ data: { stages: [], forecast: [] }, error: null }); return }

  // HubSpot (phase 3): the portal's deal pipeline stages and forecast
  // categories, grouped by pipeline when there are several. Falls through
  // to activities-distinct when HubSpot can't be read.
  const crmProvider = await getCrmProviderId()
  if (crmProvider === 'hubspot') {
    try {
      const opts = await getDealFilterOptions()
      if (opts.stages.length > 0 || opts.forecast.length > 0) {
        res.json({ data: opts, error: null })
        return
      }
    } catch { /* fall through to activities-distinct */ }
  }

  if (crmProvider === 'salesforce' && (!sfPicklistCache || Date.now() - sfPicklistCache.at > SF_PICKLIST_TTL_MS)) {
    // Use the requesting leader's own SF connection (this is a user-facing
    // dashboard, not an Admin page — the admin connection is reserved for
    // Admin pages and background sync). The picklist is org-wide, so caching
    // it globally is fine. If the user has no SF connection or its describe
    // returns nothing, we drop to activities-distinct below.
    try {
      const conn = req.user?.id ? await getSfConnection(req.user.id) : null
      if (conn) {
        const meta = await conn.sobject('Opportunity').describe()
        const pick = (name: string) => (meta.fields ?? []).find((f) => (f.name ?? '') === name)?.picklistValues ?? []
        const stages = pick('StageName').filter((v) => v.active !== false).map((v) => String(v.value))
        const forecast = pick('ForecastCategoryName').filter((v) => v.active !== false).map((v) => String(v.value))
        if (stages.length > 0 || forecast.length > 0) sfPicklistCache = { at: Date.now(), stages, forecast }
      }
    } catch { /* fall through to activities-distinct */ }
  }
  if (crmProvider === 'salesforce' && sfPicklistCache && (sfPicklistCache.stages.length > 0 || sfPicklistCache.forecast.length > 0)) {
    res.json({ data: { stages: sfPicklistCache.stages, forecast: sfPicklistCache.forecast }, error: null })
    return
  }

  // Fallback: distinct values seen on this scope's activities.
  const rows = await db.selectDistinct({
    salesStage: activities.salesStage,
    forecastCategory: activities.forecastCategory,
  }).from(activities).where(and(
    inArray(activities.teamId, teamScope),
    eq(activities.isArchived, false),
  ))
  const stages = Array.from(new Set(rows.map((r) => r.salesStage).filter((s): s is string => !!s))).sort()
  const forecast = Array.from(new Set(rows.map((r) => r.forecastCategory).filter((s): s is string => !!s))).sort()
  res.json({ data: { stages, forecast }, error: null })
})

// Start/end (yyyy-MM-dd) of the current fiscal quarter and fiscal year for a
// given "today", honoring the org's fiscal calendar config.
function currentFiscalWindows(cfg: FiscalConfig, today: Date): { cfqStart: string; cfqEnd: string; cfyStart: string; cfyEnd: string } {
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const startMonth = cfg.mode === 'calendar' ? 1 : cfg.startMonth
  const m = today.getMonth() + 1
  const y = today.getFullYear()
  const fyStartYear = m >= startMonth ? y : y - 1
  const fyStart = new Date(fyStartYear, startMonth - 1, 1)
  const fyEnd = new Date(fyStartYear + 1, startMonth - 1, 0)
  const monthsFromStart = (m - startMonth + 12) % 12
  const qIdx = Math.floor(monthsFromStart / 3) // 0..3
  const cfqStart = new Date(fyStartYear, startMonth - 1 + qIdx * 3, 1)
  const cfqEnd = new Date(fyStartYear, startMonth - 1 + qIdx * 3 + 3, 0)
  return { cfqStart: fmt(cfqStart), cfqEnd: fmt(cfqEnd), cfyStart: fmt(fyStart), cfyEnd: fmt(fyEnd) }
}

// GET /api/dashboards/my-acv-impact?basis=close|created
// The signed-in user's ACV impact — Σ Total_Acv__c over every Opportunity
// where they're the Assigned SE or listed on an Evaluation (Primary /
// Supporting / Secondary Engineer), deduplicated across roles, for the
// current fiscal quarter (cfq) and fiscal year (cfy). Reads the local
// crm_opportunity_coverage snapshot — no live Salesforce call, so it's a cheap
// per-request aggregation (one bounded scan). basis selects the date column
// that places an opp in the period: close (CloseDate) or created (CreatedDate).
opportunityDataDashRoutes.get('/my-acv-impact', async (req, res) => {
  const basis: 'close' | 'created' = req.query['basis'] === 'created' ? 'created' : 'close'
  const empty = { cfq: 0, cfy: 0, basis, snapshotAt: null as string | null, configured: false }

  const uid = req.user?.id
  if (!uid) { res.json({ data: empty, error: null }); return }
  const [me] = await db.select({ crmUserId: users.crmUserId, name: users.displayName }).from(users).where(eq(users.id, uid)).limit(1)
  if (!me?.crmUserId && !me?.name) { res.json({ data: empty, error: null }); return }

  // Role fields that count as "touched": every active attach_rate_field on the
  // user's team(s) (Assigned_SE__c on Opportunity + the Evaluation engineer
  // fields). Keyed `${crmObject}::${fieldApi}` to match the snapshot.
  const teamRows = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, uid))
  const teamIds = teamRows.map((r) => r.teamId)
  if (teamIds.length === 0) { res.json({ data: empty, error: null }); return }
  const cfgRows = await db
    .select({ fieldApi: attachRateFields.fieldApi, crmObject: attachRateFields.crmObject })
    .from(attachRateFields)
    .where(and(inArray(attachRateFields.teamId, teamIds), eq(attachRateFields.isActive, true)))
  const roleKeys = Array.from(new Set(cfgRows.filter((r) => r.crmObject && SF_FIELD_PATH.test(r.fieldApi)).map((r) => `${r.crmObject}::${r.fieldApi}`)))
  if (roleKeys.length === 0) { res.json({ data: empty, error: null }); return }

  // The user "matches" a role value when it's their SF User Id, or (for
  // name-based engineer multi-selects) an exact display-name match.
  const myId = me.crmUserId ?? null
  const myName = (me.name ?? '').trim().toLowerCase()
  const matches = (v: string): boolean => {
    if (myId && SF_ID_RX.test(v)) return v === myId
    return !!myName && v.trim().toLowerCase() === myName
  }

  // Compute the fiscal windows first so we can push the (widest) current-FY
  // date window into SQL — otherwise this scanned the ENTIRE coverage table
  // (org-wide) on every weekly-view load. The chosen basis column's index
  // now serves the range; the JS loop only buckets CFQ within the CFY rows
  // and applies the per-user role-membership test.
  const { cfqStart, cfqEnd, cfyStart, cfyEnd } = currentFiscalWindows(await getFiscalConfig(), new Date())
  const dateCol = basis === 'created' ? crmOpportunityCoverage.createdDate : crmOpportunityCoverage.closeDate
  const rows = await db
    .select({
      closeDate: crmOpportunityCoverage.closeDate,
      createdDate: crmOpportunityCoverage.createdDate,
      amount: crmOpportunityCoverage.amount,
      totalAcv: crmOpportunityCoverage.totalAcv,
      fieldValues: crmOpportunityCoverage.fieldValues,
      snapshotAt: crmOpportunityCoverage.snapshotAt,
    })
    .from(crmOpportunityCoverage)
    .where(and(
      isNotNull(dateCol),
      gte(dateCol, cfyStart),
      lte(dateCol, cfyEnd),
      isNotNull(crmOpportunityCoverage.fieldValues),
    ))

  let cfq = 0
  let cfy = 0
  let snapshotAt: string | null = null
  for (const r of rows) {
    if (r.snapshotAt) { const s = r.snapshotAt.toISOString(); if (!snapshotAt || s > snapshotAt) snapshotAt = s }
    const fv = (r.fieldValues ?? {}) as Record<string, string[]>
    let mine = false
    for (const k of roleKeys) {
      const vals = fv[k]
      if (Array.isArray(vals) && vals.some(matches)) { mine = true; break }
    }
    if (!mine) continue
    const date = basis === 'created' ? r.createdDate : r.closeDate
    if (!date) continue
    const acv = Number(r.totalAcv ?? r.amount ?? 0) || 0
    if (date >= cfyStart && date <= cfyEnd) cfy += acv
    if (date >= cfqStart && date <= cfqEnd) cfq += acv
  }

  res.json({ data: { cfq, cfy, basis, snapshotAt, configured: true }, error: null })
})
