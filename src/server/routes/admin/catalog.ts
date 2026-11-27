import { Router } from 'express'
import { db } from '../../db/index.js'
import { teams, teamMembers, users } from '../../../../drizzle/schema.js'
import { and, eq, inArray } from 'drizzle-orm'
import { requireAuth } from '../../middleware/auth.js'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { validateProductIconDataUrl } from './themes.js'
import { definedEntries } from '../../lib/records.js'

export const catalogRoutes = Router()

// Enforce max 3 on the admin per-user assignment endpoint too. Note the earlier
// endpoint didn't cap the array; this wrapper is intentionally a small guard.

// --- Products (app-owned catalog surfaced on the Log Activity form) ---
// v1.93.0: relaxed from requireAppAdmin to accept team_admin too, then
// filter the result to products linked to teams the caller admins. Previously
// a team_admin (or an app admin viewing under a specific team) landed on
// an empty Products page even though products existed — the endpoint 403'd
// on non-app-admins and the client silently showed "0 product(s)". App
// admins still see the full unfiltered list.
catalogRoutes.get('/products', requireAuth, async (req, res) => {
  const { products: productsTbl, productTeams } = await import('../../../../drizzle/schema.js')
  const callerId = req.user!.id
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  const isAppAdmin = !!caller?.isAppAdmin
  if (!isAppAdmin) {
    // Team-admin fallback: caller must hold role=admin or team_admin on
    // at least one team; return only products linked to those teams.
    const adminMemberships = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, callerId), inArray(teamMembers.role, ['admin', 'team_admin'])))
    if (adminMemberships.length === 0) {
      res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
      return
    }
    const adminTeamIds = adminMemberships.map((m) => m.teamId)
    const productIdsForTeams = await db.select({ productId: productTeams.productId, teamId: productTeams.teamId })
      .from(productTeams).where(inArray(productTeams.teamId, adminTeamIds))
    const allowedIds = Array.from(new Set(productIdsForTeams.map((r) => r.productId)))
    if (allowedIds.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
    const rows = await db.select().from(productsTbl).where(inArray(productsTbl.id, allowedIds)).orderBy(productsTbl.name)
    const teamLinks = await db.select().from(productTeams).where(inArray(productTeams.productId, allowedIds))
    const teamMap = new Map<string, string[]>()
    for (const l of teamLinks) {
      if (!teamMap.has(l.productId)) teamMap.set(l.productId, [])
      teamMap.get(l.productId)!.push(l.teamId)
    }
    res.json({ data: rows.map((p) => ({ ...p, teamIds: teamMap.get(p.id) ?? [] })), error: null, meta: {} })
    return
  }
  const rows = await db.select().from(productsTbl).orderBy(productsTbl.name)
  const teamLinks = await db.select().from(productTeams)
  const teamMap = new Map<string, string[]>()
  for (const l of teamLinks) {
    if (!teamMap.has(l.productId)) teamMap.set(l.productId, [])
    teamMap.get(l.productId)!.push(l.teamId)
  }
  res.json({ data: rows.map((p) => ({ ...p, teamIds: teamMap.get(p.id) ?? [] })), error: null, meta: {} })
})

catalogRoutes.post('/products', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(200),
    space: z.string().max(100).optional(),
    abbreviation: z.string().max(20).optional(),
    isActive: z.boolean().optional(),
    teamIds: z.array(z.string().uuid()).default([]),
    iconDataUrl: z.string().optional().nullable(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const iconDataUrl = validateProductIconDataUrl(parsed.data.iconDataUrl)
  const { products: productsTbl, productTeams } = await import('../../../../drizzle/schema.js')
  const [inserted] = await db.insert(productsTbl).values({
    name: parsed.data.name,
    space: parsed.data.space ?? null,
    abbreviation: parsed.data.abbreviation ?? null,
    isActive: parsed.data.isActive ?? true,
    iconDataUrl,
  }).returning()
  if (inserted && parsed.data.teamIds.length > 0) {
    await db.insert(productTeams).values(parsed.data.teamIds.map((tid) => ({ productId: inserted.id, teamId: tid })))
  }
  res.status(201).json({ data: { ...inserted, teamIds: parsed.data.teamIds }, error: null, meta: {} })
})

catalogRoutes.patch('/products/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({
    name: z.string().min(1).max(200).optional(),
    space: z.string().max(100).nullable().optional(),
    abbreviation: z.string().max(20).nullable().optional(),
    isActive: z.boolean().optional(),
    teamIds: z.array(z.string().uuid()).optional(),
    iconDataUrl: z.string().nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { products: productsTbl, productTeams } = await import('../../../../drizzle/schema.js')
  const { teamIds, iconDataUrl: rawIcon, ...rest } = parsed.data
  const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() }
  if (rawIcon !== undefined) patch['iconDataUrl'] = validateProductIconDataUrl(rawIcon)
  const [updated] = await db.update(productsTbl).set(patch).where(eq(productsTbl.id, id)).returning()
  if (teamIds !== undefined) {
    await db.delete(productTeams).where(eq(productTeams.productId, id))
    if (teamIds.length > 0) {
      await db.insert(productTeams).values(teamIds.map((tid) => ({ productId: id, teamId: tid })))
    }
  }
  res.json({ data: updated, error: null, meta: {} })
})

catalogRoutes.delete('/products/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const { products: productsTbl } = await import('../../../../drizzle/schema.js')
  await db.delete(productsTbl).where(eq(productsTbl.id, id))
  res.json({ data: { id }, error: null, meta: {} })
})

// v1.93.0: cross-user Activity Templates admin. Lists every template in
// the system with owner + team + timestamps so admins can see the shared
// state. Delete + Clone are app-admin only; per-user Edit lives on the
// user's own templates via /api/templates (unchanged).
catalogRoutes.get('/activity-templates', requireAppAdmin, async (_req, res) => {
  const { activityTemplates } = await import('../../../../drizzle/schema.js')
  const rows = await db.select({
    id: activityTemplates.id,
    name: activityTemplates.name,
    titleTemplate: activityTemplates.titleTemplate,
    notesTemplate: activityTemplates.notesTemplate,
    effortHoursDefault: activityTemplates.effortHoursDefault,
    locationModeDefault: activityTemplates.locationModeDefault,
    activityTypeId: activityTemplates.activityTypeId,
    userId: activityTemplates.userId,
    teamId: activityTemplates.teamId,
    createdAt: activityTemplates.createdAt,
    updatedAt: activityTemplates.updatedAt,
    userDisplayName: users.displayName,
    userEmail: users.email,
    teamName: teams.name,
  })
    .from(activityTemplates)
    .innerJoin(users, eq(activityTemplates.userId, users.id))
    .leftJoin(teams, eq(activityTemplates.teamId, teams.id))
    .orderBy(desc(activityTemplates.updatedAt))
  res.json({ data: rows, error: null, meta: {} })
})

catalogRoutes.delete('/activity-templates/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const { activityTemplates } = await import('../../../../drizzle/schema.js')
  await db.delete(activityTemplates).where(eq(activityTemplates.id, id))
  res.json({ data: { id }, error: null, meta: {} })
})

// Clone a template into another user's account. `targetUserId` defaults
// to the caller, so an admin can also just duplicate for themselves.
catalogRoutes.post('/activity-templates/:id/clone', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({ targetUserId: z.string().uuid().optional(), teamId: z.string().uuid().nullable().optional(), name: z.string().min(1).max(200).optional() })
  const parsed = schema.safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { activityTemplates } = await import('../../../../drizzle/schema.js')
  const [src] = await db.select().from(activityTemplates).where(eq(activityTemplates.id, id)).limit(1)
  if (!src) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [created] = await db.insert(activityTemplates).values({
    userId: parsed.data.targetUserId ?? src.userId,
    teamId: parsed.data.teamId === undefined ? src.teamId : parsed.data.teamId,
    name: parsed.data.name ?? `${src.name} (copy)`,
    titleTemplate: src.titleTemplate,
    notesTemplate: src.notesTemplate,
    effortHoursDefault: src.effortHoursDefault,
    locationModeDefault: src.locationModeDefault,
    activityTypeId: src.activityTypeId,
    // v1.256.0: carried through on clone so an existing Subtype isn't
    // silently dropped — no admin UI to set one here, but a template
    // created via the per-user form (src/server/routes/templates.ts) may
    // already have one.
    subtypeId: src.subtypeId,
    subtypeName: src.subtypeName,
    productIds: src.productIds,
  }).returning()
  res.status(201).json({ data: created, error: null, meta: {} })
})

// v1.96.0: admin PATCH + POST on activity templates so app admins can
// edit any user's template in place and create new templates on behalf
// of a target user + team without leaving the admin console.
catalogRoutes.patch('/activity-templates/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({
    name: z.string().min(1).max(200).optional(),
    titleTemplate: z.string().min(1).max(500).optional(),
    notesTemplate: z.string().nullable().optional(),
    effortHoursDefault: z.string().nullable().optional(),
    locationModeDefault: z.string().nullable().optional(),
    activityTypeId: z.string().uuid().nullable().optional(),
    userId: z.string().uuid().optional(),
    teamId: z.string().uuid().nullable().optional(),
    productIds: z.array(z.string().uuid()).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { activityTemplates } = await import('../../../../drizzle/schema.js')
  const patch: Record<string, unknown> = { ...definedEntries(parsed.data), updatedAt: new Date() }
  const [updated] = await db.update(activityTemplates).set(patch).where(eq(activityTemplates.id, id)).returning()
  if (!updated) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: updated, error: null, meta: {} })
})

catalogRoutes.post('/activity-templates', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    userId: z.string().uuid(),
    teamId: z.string().uuid().nullable().optional(),
    name: z.string().min(1).max(200),
    titleTemplate: z.string().min(1).max(500),
    notesTemplate: z.string().nullable().optional(),
    effortHoursDefault: z.string().nullable().optional(),
    locationModeDefault: z.string().nullable().optional(),
    activityTypeId: z.string().uuid().nullable().optional(),
    productIds: z.array(z.string().uuid()).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { activityTemplates } = await import('../../../../drizzle/schema.js')
  const [created] = await db.insert(activityTemplates).values({
    userId: parsed.data.userId,
    teamId: parsed.data.teamId ?? null,
    name: parsed.data.name,
    titleTemplate: parsed.data.titleTemplate,
    notesTemplate: parsed.data.notesTemplate ?? null,
    effortHoursDefault: parsed.data.effortHoursDefault ?? null,
    locationModeDefault: parsed.data.locationModeDefault ?? null,
    activityTypeId: parsed.data.activityTypeId ?? null,
    productIds: parsed.data.productIds ?? null,
  }).returning()
  res.status(201).json({ data: created, error: null, meta: {} })
})

// Fiscal year / calendar display configuration. Drives how quarters and
// years are labelled in dashboards, trend chips, and analytics.
// GET is registered near the top of this file (before the blanket
// requireGlobalAdmin gate) since every signed-in user needs to read it.
catalogRoutes.patch('/fiscal-year', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    mode: z.enum(['calendar', 'fiscal']),
    startMonth: z.number().int().min(1).max(12),
    yearNaming: z.enum(['same', 'next']),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { setFiscalConfig, getFiscalConfig } = await import('../../services/config/fiscal.js')
  await setFiscalConfig(parsed.data)
  res.json({ data: await getFiscalConfig(), error: null, meta: {} })
})
