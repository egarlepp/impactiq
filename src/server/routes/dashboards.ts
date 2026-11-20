import { Router } from 'express'
import { db } from '../db/index.js'
import { dashboardPresets } from '../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth.js'
import { capacityDashRoutes } from './dashboards/capacity.js'
import { healthDashRoutes } from './dashboards/health.js'
import { activityDashRoutes } from './dashboards/activity.js'
import { revenueDashRoutes } from './dashboards/revenue.js'
import { managerDashRoutes } from './dashboards/manager.js'
import { salesTeamDashRoutes } from './dashboards/salesTeam.js'
import { costsDashRoutes } from './dashboards/costs.js'
import { opportunityDataDashRoutes } from './dashboards/opportunityData.js'
import { attachRateDashRoutes } from './dashboards/attachRate.js'
import { historyDashRoutes } from './dashboards/history.js'
import { aiAssessmentsDashRoutes } from './dashboards/aiAssessments.js'

// Kept importable from here for services/dashboards/closedLostReview.ts.
export { dateWindow, productFilterCond, amountInRanges } from './dashboards/shared.js'
export type { DashDateBasis, AcvRange } from './dashboards/shared.js'

export const dashboardsRouter = Router()

dashboardsRouter.use(requireAuth)

// ─── FX rate status ─────────────────────────────────────────────────────
// Public (any signed-in user) — returns the most-recent asOf + source
// across all cached FX rows so cost dashboards can show a small
// "rates as of X" indicator without exposing every rate.
dashboardsRouter.get('/fx-status', async (_req, res) => {
  const { listLatestRates } = await import('../services/fx/rates.js')
  const rows = await listLatestRates()
  if (rows.length === 0) {
    res.json({ data: { asOf: null, source: null, count: 0, fxRates: {}, availableCurrencies: ['USD'] }, error: null, meta: {} })
    return
  }
  // listLatestRates already returns most-recent per currency; the newest
  // asOf across the set is the effective "last refresh" instant.
  let newest = rows[0]!
  for (const r of rows) if (r.asOf > newest.asOf) newest = r
  // Expose the full rate map + available currencies so the shared page-level
  // "Show Costs In" selector can convert USD→display for every dashboard
  // without each endpoint re-shipping FX data.
  const fxRatesMap: Record<string, { ratePerUsd: number; asOf: string }> = {}
  for (const r of rows) fxRatesMap[r.currency] = { ratePerUsd: r.ratePerUsd, asOf: r.asOf }
  const availableCurrencies = Array.from(new Set(['USD', ...rows.map((r) => r.currency)])).sort()
  res.json({ data: { asOf: newest.asOf, source: newest.source, count: rows.length, fxRates: fxRatesMap, availableCurrencies }, error: null, meta: {} })
})

// ─── Dashboard filter presets ──────────────────────────────────────────
// Per-user saved filter configurations for the leader dashboard. Filters
// is an opaque jsonb blob — the client owns its shape (tab, weeksBack,
// userId, productIds, custom date range, compareMode, etc.).
dashboardsRouter.get('/presets', async (req, res) => {
  const userId = req.user?.id
  if (!userId) { res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} }); return }
  const rows = await db
    .select({ id: dashboardPresets.id, name: dashboardPresets.name, filters: dashboardPresets.filters, updatedAt: dashboardPresets.updatedAt })
    .from(dashboardPresets)
    .where(eq(dashboardPresets.userId, userId))
    .orderBy(dashboardPresets.name)
  res.json({ data: rows, error: null, meta: {} })
})

dashboardsRouter.post('/presets', async (req, res) => {
  const userId = req.user?.id
  if (!userId) { res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} }); return }
  const name = String(req.body?.name ?? '').trim()
  const filters = req.body?.filters
  if (!name || filters == null || typeof filters !== 'object') {
    res.status(400).json({ data: null, error: 'errors.validation.name_and_filters_required', meta: {} }); return
  }
  if (name.length > 80) { res.status(400).json({ data: null, error: 'errors.validation.name_too_long', meta: {} }); return }
  // Upsert by (userId, name).
  const [existing] = await db.select({ id: dashboardPresets.id }).from(dashboardPresets)
    .where(and(eq(dashboardPresets.userId, userId), eq(dashboardPresets.name, name)))
  let row
  if (existing) {
    ;[row] = await db.update(dashboardPresets)
      .set({ filters, updatedAt: new Date() })
      .where(eq(dashboardPresets.id, existing.id))
      .returning()
  } else {
    ;[row] = await db.insert(dashboardPresets).values({ userId, name, filters }).returning()
  }
  res.json({ data: row, error: null, meta: {} })
})

dashboardsRouter.delete('/presets/:id', async (req, res) => {
  const userId = req.user?.id
  if (!userId) { res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} }); return }
  const id = req.params['id']
  if (!id) { res.status(400).json({ data: null, error: 'errors.validation.id_required', meta: {} }); return }
  const deleted = await db.delete(dashboardPresets)
    .where(and(eq(dashboardPresets.id, id), eq(dashboardPresets.userId, userId)))
    .returning({ id: dashboardPresets.id })
  if (deleted.length === 0) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: { id }, error: null, meta: {} })
})

// v1.416.0: the dashboard routes live in ./dashboards/, one module per
// dashboard group, with shared helpers in ./dashboards/shared.ts. Mounted in
// the order they used to appear in this file, so route matching is unchanged.
dashboardsRouter.use(capacityDashRoutes)
dashboardsRouter.use(healthDashRoutes)
dashboardsRouter.use(activityDashRoutes)
dashboardsRouter.use(revenueDashRoutes)
dashboardsRouter.use(managerDashRoutes)
dashboardsRouter.use(salesTeamDashRoutes)
dashboardsRouter.use(costsDashRoutes)
dashboardsRouter.use(opportunityDataDashRoutes)
dashboardsRouter.use(attachRateDashRoutes)
dashboardsRouter.use(historyDashRoutes)
dashboardsRouter.use(aiAssessmentsDashRoutes)
