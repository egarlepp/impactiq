import { Router } from 'express'
import { db } from '../../db/index.js'
import {
  capacityGroups,
  capacityGroupTeams,
  capacityUserOverrides,
  costGroups,
  costGroupTeams,
  costUserOverrides,
  users,
} from '../../../../drizzle/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { desc } from 'drizzle-orm'
import { z } from 'zod'

export const capacityCostRoutes = Router()

// ─── Capacity + Cost Groups (unified model) ─────────────────────────────
// Groups are top-level policies. `capacity_group_teams` / `cost_group_teams`
// attach them to any number of teams (each team belongs to at most one
// group per policy — DB-enforced). Per-user, dated overrides live in
// `capacity_user_overrides` / `cost_user_overrides` and beat the group.
// All reads run through src/server/services/capacity/resolver.ts.

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')

// --- Capacity Groups (top-level) ---
capacityCostRoutes.get('/capacity-groups', requireAppAdmin, async (_req, res) => {
  const groups = await db.select().from(capacityGroups).orderBy(capacityGroups.name)
  const teamsAttached = await db.select().from(capacityGroupTeams)
  res.json({
    data: groups.map((g) => ({
      ...g,
      teamIds: teamsAttached.filter((t) => t.groupId === g.id).map((t) => t.teamId),
    })),
    error: null,
    meta: {},
  })
})

capacityCostRoutes.post('/capacity-groups', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(120),
    targetHoursPerWeek: z.number().positive().optional(),
    capacityMethod: z.enum(['fixed_hours', 'self_declared', 'exception_adjusted', 'calendar_derived']),
    region: z.string().max(120).optional(),
    roleType: z.string().max(120).optional(),
    // v1.225.0: admin opt-in for the calendar-derived "Meeting Load" figure;
    // independent of capacityMethod. See CLAUDE.md §12.
    showRealMeetingLoad: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { targetHoursPerWeek, ...rest } = parsed.data
  const [inserted] = await db.insert(capacityGroups).values({
    ...rest,
    ...(targetHoursPerWeek !== undefined && { targetHoursPerWeek: String(targetHoursPerWeek) }),
  }).returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

capacityCostRoutes.patch('/capacity-groups/:groupId', requireAppAdmin, async (req, res) => {
  const { groupId } = req.params as { groupId: string }
  const schema = z.object({
    name: z.string().optional(),
    targetHoursPerWeek: z.number().nullable().optional(),
    capacityMethod: z.enum(['fixed_hours', 'self_declared', 'exception_adjusted', 'calendar_derived']).optional(),
    region: z.string().nullable().optional(),
    roleType: z.string().nullable().optional(),
    showRealMeetingLoad: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { targetHoursPerWeek, ...rest } = parsed.data
  const updateData = { ...rest, ...(targetHoursPerWeek !== undefined && { targetHoursPerWeek: targetHoursPerWeek === null ? null : String(targetHoursPerWeek) }) }
  const [updated] = await db.update(capacityGroups).set(updateData).where(eq(capacityGroups.id, groupId)).returning()
  res.json({ data: updated, error: null, meta: {} })
})

capacityCostRoutes.delete('/capacity-groups/:groupId', requireAppAdmin, async (req, res) => {
  const { groupId } = req.params as { groupId: string }
  // Cascades handle capacity_group_teams; overrides live at (user, team)
  // so they're independent of the group and survive.
  await db.delete(capacityGroups).where(eq(capacityGroups.id, groupId))
  res.json({ data: { id: groupId }, error: null, meta: {} })
})

// Attach a team to a capacity group. Fails with 409 if the team is
// already attached to another group — surface that so the admin can
// detach + re-attach explicitly.
capacityCostRoutes.post('/capacity-groups/:groupId/teams/:teamId', requireAppAdmin, async (req, res) => {
  const { groupId, teamId } = req.params as { groupId: string; teamId: string }
  const [conflict] = await db.select({ groupId: capacityGroupTeams.groupId }).from(capacityGroupTeams).where(eq(capacityGroupTeams.teamId, teamId)).limit(1)
  if (conflict && conflict.groupId !== groupId) {
    res.status(409).json({ data: null, error: 'errors.capacity_group.team_already_attached', meta: { existingGroupId: conflict.groupId } })
    return
  }
  if (conflict && conflict.groupId === groupId) { res.status(200).json({ data: { groupId, teamId }, error: null, meta: {} }); return }
  await db.insert(capacityGroupTeams).values({ groupId, teamId })
  res.status(201).json({ data: { groupId, teamId }, error: null, meta: {} })
})

capacityCostRoutes.delete('/capacity-groups/:groupId/teams/:teamId', requireAppAdmin, async (req, res) => {
  const { groupId, teamId } = req.params as { groupId: string; teamId: string }
  await db.delete(capacityGroupTeams).where(and(eq(capacityGroupTeams.groupId, groupId), eq(capacityGroupTeams.teamId, teamId)))
  res.json({ data: { groupId, teamId }, error: null, meta: {} })
})

// --- Capacity user overrides ---
capacityCostRoutes.get('/capacity-user-overrides', requireAppAdmin, async (req, res) => {
  const userId = req.query['userId'] as string | undefined
  const teamId = req.query['teamId'] as string | undefined
  const conds = []
  if (userId) conds.push(eq(capacityUserOverrides.userId, userId))
  if (teamId) conds.push(eq(capacityUserOverrides.teamId, teamId))
  const rows = await db
    .select({
      id: capacityUserOverrides.id,
      userId: capacityUserOverrides.userId,
      teamId: capacityUserOverrides.teamId,
      targetHoursPerWeek: capacityUserOverrides.targetHoursPerWeek,
      reason: capacityUserOverrides.reason,
      effectiveFrom: capacityUserOverrides.effectiveFrom,
      effectiveTo: capacityUserOverrides.effectiveTo,
      createdAt: capacityUserOverrides.createdAt,
      userEmail: users.email,
      userDisplayName: users.displayName,
    })
    .from(capacityUserOverrides)
    .innerJoin(users, eq(users.id, capacityUserOverrides.userId))
    .where(conds.length > 0 ? and(...conds) : sql`true`)
    .orderBy(desc(capacityUserOverrides.effectiveFrom))
  res.json({ data: rows, error: null, meta: {} })
})

capacityCostRoutes.post('/capacity-user-overrides', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    userId: z.string().uuid(),
    teamId: z.string().uuid(),
    targetHoursPerWeek: z.number().positive().max(200),
    reason: z.string().min(1).max(80),
    effectiveFrom: dateStr,
    effectiveTo: dateStr.nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { findOverridesConflict } = await import('../../services/capacity/resolver.js')
  const conflictId = await findOverridesConflict({
    table: 'capacity',
    userId: parsed.data.userId,
    teamId: parsed.data.teamId,
    effectiveFrom: parsed.data.effectiveFrom,
    effectiveTo: parsed.data.effectiveTo ?? null,
  })
  if (conflictId) { res.status(400).json({ data: null, error: 'errors.override.overlap', meta: { conflictId } }); return }
  const [inserted] = await db.insert(capacityUserOverrides).values({
    userId: parsed.data.userId,
    teamId: parsed.data.teamId,
    targetHoursPerWeek: String(parsed.data.targetHoursPerWeek),
    reason: parsed.data.reason,
    effectiveFrom: parsed.data.effectiveFrom,
    effectiveTo: parsed.data.effectiveTo ?? null,
    createdBy: req.user!.id,
  }).returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

capacityCostRoutes.patch('/capacity-user-overrides/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({
    targetHoursPerWeek: z.number().positive().max(200).optional(),
    reason: z.string().min(1).max(80).optional(),
    effectiveFrom: dateStr.optional(),
    effectiveTo: dateStr.nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [existing] = await db.select().from(capacityUserOverrides).where(eq(capacityUserOverrides.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const from = parsed.data.effectiveFrom ?? existing.effectiveFrom
  const to = parsed.data.effectiveTo === undefined ? existing.effectiveTo : parsed.data.effectiveTo
  const { findOverridesConflict } = await import('../../services/capacity/resolver.js')
  const conflictId = await findOverridesConflict({
    table: 'capacity',
    userId: existing.userId,
    teamId: existing.teamId,
    effectiveFrom: from,
    effectiveTo: to,
    excludeId: id,
  })
  if (conflictId) { res.status(400).json({ data: null, error: 'errors.override.overlap', meta: { conflictId } }); return }
  const patch: Record<string, unknown> = {}
  if (parsed.data.targetHoursPerWeek !== undefined) patch['targetHoursPerWeek'] = String(parsed.data.targetHoursPerWeek)
  if (parsed.data.reason !== undefined) patch['reason'] = parsed.data.reason
  if (parsed.data.effectiveFrom !== undefined) patch['effectiveFrom'] = parsed.data.effectiveFrom
  if (parsed.data.effectiveTo !== undefined) patch['effectiveTo'] = parsed.data.effectiveTo
  const [updated] = await db.update(capacityUserOverrides).set(patch).where(eq(capacityUserOverrides.id, id)).returning()
  res.json({ data: updated, error: null, meta: {} })
})

capacityCostRoutes.delete('/capacity-user-overrides/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  await db.delete(capacityUserOverrides).where(eq(capacityUserOverrides.id, id))
  res.json({ data: { id }, error: null, meta: {} })
})

// --- Cost Groups (mirror of capacity) ---
capacityCostRoutes.get('/cost-groups', requireAppAdmin, async (_req, res) => {
  const groups = await db.select().from(costGroups).orderBy(costGroups.name)
  const teamsAttached = await db.select().from(costGroupTeams)
  res.json({
    data: groups.map((g) => ({
      ...g,
      teamIds: teamsAttached.filter((t) => t.groupId === g.id).map((t) => t.teamId),
    })),
    error: null,
    meta: {},
  })
})

capacityCostRoutes.post('/cost-groups', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(120),
    hourlyCostRate: z.number().nonnegative().max(99999999.99),
    currency: z.string().length(3).default('USD'),
    region: z.string().max(120).optional(),
    roleType: z.string().max(120).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [inserted] = await db.insert(costGroups).values({
    name: parsed.data.name,
    hourlyCostRate: parsed.data.hourlyCostRate.toFixed(2),
    currency: parsed.data.currency,
    region: parsed.data.region ?? null,
    roleType: parsed.data.roleType ?? null,
  }).returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

capacityCostRoutes.patch('/cost-groups/:groupId', requireAppAdmin, async (req, res) => {
  const { groupId } = req.params as { groupId: string }
  const schema = z.object({
    name: z.string().optional(),
    hourlyCostRate: z.number().nonnegative().max(99999999.99).optional(),
    currency: z.string().length(3).optional(),
    region: z.string().nullable().optional(),
    roleType: z.string().nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const patch: Record<string, unknown> = { ...parsed.data }
  if (parsed.data.hourlyCostRate !== undefined) patch['hourlyCostRate'] = parsed.data.hourlyCostRate.toFixed(2)
  const [updated] = await db.update(costGroups).set(patch).where(eq(costGroups.id, groupId)).returning()
  res.json({ data: updated, error: null, meta: {} })
})

capacityCostRoutes.delete('/cost-groups/:groupId', requireAppAdmin, async (req, res) => {
  const { groupId } = req.params as { groupId: string }
  await db.delete(costGroups).where(eq(costGroups.id, groupId))
  res.json({ data: { id: groupId }, error: null, meta: {} })
})

capacityCostRoutes.post('/cost-groups/:groupId/teams/:teamId', requireAppAdmin, async (req, res) => {
  const { groupId, teamId } = req.params as { groupId: string; teamId: string }
  const [conflict] = await db.select({ groupId: costGroupTeams.groupId }).from(costGroupTeams).where(eq(costGroupTeams.teamId, teamId)).limit(1)
  if (conflict && conflict.groupId !== groupId) {
    res.status(409).json({ data: null, error: 'errors.cost_group.team_already_attached', meta: { existingGroupId: conflict.groupId } })
    return
  }
  if (conflict && conflict.groupId === groupId) { res.status(200).json({ data: { groupId, teamId }, error: null, meta: {} }); return }
  await db.insert(costGroupTeams).values({ groupId, teamId })
  res.status(201).json({ data: { groupId, teamId }, error: null, meta: {} })
})

capacityCostRoutes.delete('/cost-groups/:groupId/teams/:teamId', requireAppAdmin, async (req, res) => {
  const { groupId, teamId } = req.params as { groupId: string; teamId: string }
  await db.delete(costGroupTeams).where(and(eq(costGroupTeams.groupId, groupId), eq(costGroupTeams.teamId, teamId)))
  res.json({ data: { groupId, teamId }, error: null, meta: {} })
})

// --- Cost user overrides ---
capacityCostRoutes.get('/cost-user-overrides', requireAppAdmin, async (req, res) => {
  const userId = req.query['userId'] as string | undefined
  const teamId = req.query['teamId'] as string | undefined
  const conds = []
  if (userId) conds.push(eq(costUserOverrides.userId, userId))
  if (teamId) conds.push(eq(costUserOverrides.teamId, teamId))
  const rows = await db
    .select({
      id: costUserOverrides.id,
      userId: costUserOverrides.userId,
      teamId: costUserOverrides.teamId,
      hourlyCostRate: costUserOverrides.hourlyCostRate,
      currency: costUserOverrides.currency,
      reason: costUserOverrides.reason,
      effectiveFrom: costUserOverrides.effectiveFrom,
      effectiveTo: costUserOverrides.effectiveTo,
      createdAt: costUserOverrides.createdAt,
      userEmail: users.email,
      userDisplayName: users.displayName,
    })
    .from(costUserOverrides)
    .innerJoin(users, eq(users.id, costUserOverrides.userId))
    .where(conds.length > 0 ? and(...conds) : sql`true`)
    .orderBy(desc(costUserOverrides.effectiveFrom))
  res.json({ data: rows, error: null, meta: {} })
})

capacityCostRoutes.post('/cost-user-overrides', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    userId: z.string().uuid(),
    teamId: z.string().uuid(),
    hourlyCostRate: z.number().nonnegative().max(99999999.99),
    currency: z.string().length(3).default('USD'),
    reason: z.string().min(1).max(80),
    effectiveFrom: dateStr,
    effectiveTo: dateStr.nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { findOverridesConflict } = await import('../../services/capacity/resolver.js')
  const conflictId = await findOverridesConflict({
    table: 'cost',
    userId: parsed.data.userId,
    teamId: parsed.data.teamId,
    effectiveFrom: parsed.data.effectiveFrom,
    effectiveTo: parsed.data.effectiveTo ?? null,
  })
  if (conflictId) { res.status(400).json({ data: null, error: 'errors.override.overlap', meta: { conflictId } }); return }
  const [inserted] = await db.insert(costUserOverrides).values({
    userId: parsed.data.userId,
    teamId: parsed.data.teamId,
    hourlyCostRate: parsed.data.hourlyCostRate.toFixed(2),
    currency: parsed.data.currency,
    reason: parsed.data.reason,
    effectiveFrom: parsed.data.effectiveFrom,
    effectiveTo: parsed.data.effectiveTo ?? null,
    createdBy: req.user!.id,
  }).returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

capacityCostRoutes.patch('/cost-user-overrides/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({
    hourlyCostRate: z.number().nonnegative().max(99999999.99).optional(),
    currency: z.string().length(3).optional(),
    reason: z.string().min(1).max(80).optional(),
    effectiveFrom: dateStr.optional(),
    effectiveTo: dateStr.nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [existing] = await db.select().from(costUserOverrides).where(eq(costUserOverrides.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const from = parsed.data.effectiveFrom ?? existing.effectiveFrom
  const to = parsed.data.effectiveTo === undefined ? existing.effectiveTo : parsed.data.effectiveTo
  const { findOverridesConflict } = await import('../../services/capacity/resolver.js')
  const conflictId = await findOverridesConflict({
    table: 'cost',
    userId: existing.userId,
    teamId: existing.teamId,
    effectiveFrom: from,
    effectiveTo: to,
    excludeId: id,
  })
  if (conflictId) { res.status(400).json({ data: null, error: 'errors.override.overlap', meta: { conflictId } }); return }
  const patch: Record<string, unknown> = {}
  if (parsed.data.hourlyCostRate !== undefined) patch['hourlyCostRate'] = parsed.data.hourlyCostRate.toFixed(2)
  if (parsed.data.currency !== undefined) patch['currency'] = parsed.data.currency
  if (parsed.data.reason !== undefined) patch['reason'] = parsed.data.reason
  if (parsed.data.effectiveFrom !== undefined) patch['effectiveFrom'] = parsed.data.effectiveFrom
  if (parsed.data.effectiveTo !== undefined) patch['effectiveTo'] = parsed.data.effectiveTo
  const [updated] = await db.update(costUserOverrides).set(patch).where(eq(costUserOverrides.id, id)).returning()
  res.json({ data: updated, error: null, meta: {} })
})

capacityCostRoutes.delete('/cost-user-overrides/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  await db.delete(costUserOverrides).where(eq(costUserOverrides.id, id))
  res.json({ data: { id }, error: null, meta: {} })
})

// --- Debug: resolve effective policy for (user, team, asOf) ---
capacityCostRoutes.get('/capacity/effective', requireAppAdmin, async (req, res) => {
  const userId = req.query['userId'] as string
  const teamId = req.query['teamId'] as string
  const asOfIso = (req.query['asOf'] as string | undefined) ?? new Date().toISOString().slice(0, 10)
  if (!userId || !teamId) { res.status(400).json({ data: null, error: 'userId and teamId required', meta: {} }); return }
  const { resolveCapacityOne } = await import('../../services/capacity/resolver.js')
  const r = await resolveCapacityOne(userId, teamId, new Date(asOfIso))
  res.json({ data: { value: r.hours, source: r.source, asOf: asOfIso }, error: null, meta: {} })
})

capacityCostRoutes.get('/cost/effective', requireAppAdmin, async (req, res) => {
  const userId = req.query['userId'] as string
  const teamId = req.query['teamId'] as string
  const asOfIso = (req.query['asOf'] as string | undefined) ?? new Date().toISOString().slice(0, 10)
  if (!userId || !teamId) { res.status(400).json({ data: null, error: 'userId and teamId required', meta: {} }); return }
  const { resolveCostOne } = await import('../../services/capacity/resolver.js')
  const r = await resolveCostOne(userId, teamId, new Date(asOfIso))
  res.json({ data: { value: r.rate, currency: r.currency, source: r.source, asOf: asOfIso }, error: null, meta: {} })
})

// --- FX rates ---
// Admins hit "Refresh rates" to pull the ECB feed and re-anchor everything
// to USD, then the client renders converted totals on cost dashboards.
capacityCostRoutes.get('/fx-rates', requireAppAdmin, async (_req, res) => {
  const { listLatestRates } = await import('../../services/fx/rates.js')
  const rows = await listLatestRates()
  res.json({ data: rows, error: null, meta: {} })
})

capacityCostRoutes.post('/fx-rates/refresh', requireAppAdmin, async (req, res) => {
  const { refreshFxRates } = await import('../../services/fx/rates.js')
  try {
    const result = await refreshFxRates()
    await logAudit(req, { action: 'fx_rates.refresh', targetType: 'fx_rates', targetId: null, meta: result })
    res.json({ data: result, error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof Error ? err.message : 'FX refresh failed', meta: {} })
  }
})
