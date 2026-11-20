import { Router } from 'express'
import { db } from '../../db/index.js'
import { teams, teamActivityTypes, activityTypeTeams, sfEventTypeConfig } from '../../../../drizzle/schema.js'
import { and, eq, inArray, sql, or } from 'drizzle-orm'
import { requireRole, requireAppAdmin, isAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { z } from 'zod'

export const activityTypesRoutes = Router()

// --- Activity Types ---
// GET for a specific team: returns types assigned to that team via junction.
// GET for all (app admin, no teamId filter): returns all types with their assigned team IDs.
activityTypesRoutes.get('/activity-types', requireAppAdmin, async (_req, res) => {
  const types = await db.select().from(teamActivityTypes).orderBy(teamActivityTypes.sortOrder)
  const assignments = await db.select().from(activityTypeTeams)
  const teamIds = assignments.reduce<Record<string, string[]>>((acc, row) => {
    ;(acc[row.activityTypeId] ??= []).push(row.teamId)
    return acc
  }, {})
  res.json({ data: types.map((t) => ({ ...t, teamIds: teamIds[t.id] ?? [] })), error: null, meta: {} })
})

activityTypesRoutes.get('/teams/:teamId/activity-types', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  // Join through junction table — only return types explicitly assigned to this team.
  const rows = await db
    .select({ type: teamActivityTypes })
    .from(teamActivityTypes)
    .innerJoin(activityTypeTeams, and(
      eq(activityTypeTeams.activityTypeId, teamActivityTypes.id),
      eq(activityTypeTeams.teamId, teamId),
    ))
    .orderBy(teamActivityTypes.sortOrder)
  // Include assigned teamIds for display in the UI.
  const typeIds = rows.map((r) => r.type.id)
  const assignments = typeIds.length > 0
    ? await db.select().from(activityTypeTeams).where(inArray(activityTypeTeams.activityTypeId, typeIds))
    : []
  const teamIdsMap = assignments.reduce<Record<string, string[]>>((acc, row) => {
    ;(acc[row.activityTypeId] ??= []).push(row.teamId)
    return acc
  }, {})
  // Merge in the sf_event_type_config row keyed by (teamId, crmPicklistValue = type.name).
  // Consolidates the old standalone "Salesforce Type Mapping" page into this one.
  const picklistRows = await db.select().from(sfEventTypeConfig).where(eq(sfEventTypeConfig.teamId, teamId))
  const picklistByValue = new Map(picklistRows.map((p) => [p.sfPicklistValue, p]))
  // v1.70.0: also count Salesforce Extras per activity type so the list
  // row can show a small marker when a type has extras attached (RFP
  // checkbox, Evaluation picker, …) without an extra roundtrip per row.
  const { teamActivityTypeCrmExtras } = await import('../../../../drizzle/schema.js')
  const extrasCounts = typeIds.length > 0
    ? await db
        .select({ id: teamActivityTypeCrmExtras.teamActivityTypeId, n: sql<number>`count(*)::int` })
        .from(teamActivityTypeCrmExtras)
        .where(inArray(teamActivityTypeCrmExtras.teamActivityTypeId, typeIds))
        .groupBy(teamActivityTypeCrmExtras.teamActivityTypeId)
    : []
  const extrasByTypeId = new Map(extrasCounts.map((r) => [r.id, Number(r.n)]))
  const data = rows.map((r) => {
    const resolved = (r.type.crmPicklistValue && r.type.crmPicklistValue.trim().length > 0)
      ? r.type.crmPicklistValue
      : r.type.name
    const p = picklistByValue.get(resolved)
    return {
      ...r.type,
      teamIds: teamIdsMap[r.type.id] ?? [],
      sfPicklistIsActive: p?.isActive ?? true,
      fallbackValue: p?.fallbackValue ?? null,
      typicalDurationMinutes: p?.typicalDurationMinutes ?? null,
      sfExtrasCount: extrasByTypeId.get(r.type.id) ?? 0,
    }
  })
  res.json({ data, error: null, meta: {} })
})

activityTypesRoutes.post('/activity-types', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    crmObjectType: z.enum(['Event', 'Task']).default('Event'),
    sortOrder: z.number().int().default(100),
    teamIds: z.array(z.string().uuid()).default([]),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    icon: z.string().max(64).optional(),
    crmPicklistValue: z.string().max(200).nullable().optional(),
    // v1.255.0: Guide fields — see ActivityTypesConfig.tsx's "Classify
    // Activity" section.
    useThisWhen: z.string().max(4000).nullable().optional(),
    usuallyAttachTo: z.string().max(4000).nullable().optional(),
    examples: z.string().max(4000).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [inserted] = await db
    .insert(teamActivityTypes)
    .values({
      teamId: null, name: parsed.data.name, crmObjectType: parsed.data.crmObjectType, sortOrder: parsed.data.sortOrder, isActive: true, color: parsed.data.color ?? null, icon: parsed.data.icon ?? null, crmPicklistValue: parsed.data.crmPicklistValue?.trim() || null,
      useThisWhen: parsed.data.useThisWhen?.trim() || null,
      usuallyAttachTo: parsed.data.usuallyAttachTo?.trim() || null,
      examples: parsed.data.examples?.trim() || null,
    })
    .returning()
  if (!inserted) { res.status(500).json({ data: null, error: 'errors.database.insert_failed', meta: {} }); return }
  if (parsed.data.teamIds.length > 0) {
    await db.insert(activityTypeTeams).values(parsed.data.teamIds.map((tid) => ({ activityTypeId: inserted.id, teamId: tid }))).onConflictDoNothing()
  }
  res.status(201).json({ data: { ...inserted, teamIds: parsed.data.teamIds }, error: null, meta: {} })
})

activityTypesRoutes.post('/teams/:teamId/activity-types', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({
    name: z.string().min(1),
    crmObjectType: z.enum(['Event', 'Task']).default('Event'),
    sortOrder: z.number().int().default(100),
    teamIds: z.array(z.string().uuid()).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    icon: z.string().max(64).optional(),
    crmPicklistValue: z.string().max(200).nullable().optional(),
    useThisWhen: z.string().max(4000).nullable().optional(),
    usuallyAttachTo: z.string().max(4000).nullable().optional(),
    examples: z.string().max(4000).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [inserted] = await db
    .insert(teamActivityTypes)
    .values({
      teamId, name: parsed.data.name, crmObjectType: parsed.data.crmObjectType, sortOrder: parsed.data.sortOrder, isActive: true, color: parsed.data.color ?? null, icon: parsed.data.icon ?? null, crmPicklistValue: parsed.data.crmPicklistValue?.trim() || null,
      useThisWhen: parsed.data.useThisWhen?.trim() || null,
      usuallyAttachTo: parsed.data.usuallyAttachTo?.trim() || null,
      examples: parsed.data.examples?.trim() || null,
    })
    .returning()
  if (!inserted) { res.status(500).json({ data: null, error: 'errors.database.insert_failed', meta: {} }); return }
  // Assign to explicitly requested teams, or default to the creating team.
  const assignTeams = parsed.data.teamIds ?? [teamId]
  await db.insert(activityTypeTeams).values(assignTeams.map((tid) => ({ activityTypeId: inserted.id, teamId: tid }))).onConflictDoNothing()
  res.status(201).json({ data: { ...inserted, teamIds: assignTeams }, error: null, meta: {} })
})

activityTypesRoutes.patch('/activity-types/:typeId', requireAppAdmin, async (req, res) => {
  const { typeId } = req.params as { typeId: string }
  const schema = z.object({
    name: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
    crmObjectType: z.enum(['Event', 'Task']).optional(),
    sortOrder: z.number().int().optional(),
    teamIds: z.array(z.string().uuid()).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    icon: z.string().max(64).optional(),
    crmPicklistValue: z.string().max(200).nullable().optional(),
    useThisWhen: z.string().max(4000).nullable().optional(),
    usuallyAttachTo: z.string().max(4000).nullable().optional(),
    examples: z.string().max(4000).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamIds, ...rest } = parsed.data
  const [updated] = await db.update(teamActivityTypes).set(rest).where(eq(teamActivityTypes.id, typeId)).returning()
  if (teamIds !== undefined) {
    await db.delete(activityTypeTeams).where(eq(activityTypeTeams.activityTypeId, typeId))
    if (teamIds.length > 0) {
      await db.insert(activityTypeTeams).values(teamIds.map((tid) => ({ activityTypeId: typeId, teamId: tid }))).onConflictDoNothing()
    }
  }
  const assignments = await db.select().from(activityTypeTeams).where(eq(activityTypeTeams.activityTypeId, typeId))
  res.json({ data: { ...updated, teamIds: assignments.map((a) => a.teamId) }, error: null, meta: {} })
})

activityTypesRoutes.patch('/teams/:teamId/activity-types/:typeId', requireRole('admin'), async (req, res) => {
  const { teamId, typeId } = req.params as { teamId: string; typeId: string }
  const schema = z.object({
    name: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
    crmObjectType: z.enum(['Event', 'Task']).optional(),
    sortOrder: z.number().int().optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    icon: z.string().max(64).optional(),
    crmPicklistValue: z.string().max(200).nullable().optional(),
    // Merged from the old Salesforce Type Mapping page:
    sfPicklistIsActive: z.boolean().optional(),
    fallbackValue: z.string().nullable().optional(),
    typicalDurationMinutes: z.number().int().nullable().optional(),
    // v1.240.0: the type the Outlook suggestion fallback uses when nothing
    // matched. At most one per team.
    isDefaultSuggestion: z.boolean().optional(),
    useThisWhen: z.string().max(4000).nullable().optional(),
    usuallyAttachTo: z.string().max(4000).nullable().optional(),
    examples: z.string().max(4000).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): verify the activity type actually
  // belongs to :teamId before mutating it — requireRole('admin') only
  // checks the caller's role ON the claimed teamId, never that this
  // resource is really in that team, which let a team_admin of one team
  // pair their own teamId with another team's activity-type id.
  const [ownedType] = await db.select({ id: teamActivityTypes.id }).from(teamActivityTypes).where(and(eq(teamActivityTypes.id, typeId), eq(teamActivityTypes.teamId, teamId))).limit(1)
  if (!ownedType) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const { sfPicklistIsActive, fallbackValue, typicalDurationMinutes, crmPicklistValue: sfPicklistValueOverride, isDefaultSuggestion, ...rest } = parsed.data
  const typePatch: Record<string, unknown> = { ...rest }
  if (sfPicklistValueOverride !== undefined) {
    typePatch['crmPicklistValue'] = sfPicklistValueOverride?.trim() || null
  }
  // v1.125.0: also persist typicalDurationMinutes onto team_activity_types
  // itself so the Estimated vs Logged dashboard can read it directly
  // without depending on sf_event_type_config being populated.
  if (typicalDurationMinutes !== undefined) {
    typePatch['typicalDurationMinutes'] = typicalDurationMinutes
  }
  // v1.240.0: teamId is a plain column here (not the many-to-many
  // activityTypeTeams junction), so "at most one default per team" is just
  // "unset any other row with this same teamId column" — done in the same
  // transaction as the rest of this patch so two concurrent requests can't
  // both land true.
  if (isDefaultSuggestion !== undefined) typePatch['isDefaultSuggestion'] = isDefaultSuggestion
  let updated: typeof teamActivityTypes.$inferSelect | undefined
  if (isDefaultSuggestion) {
    updated = await db.transaction(async (tx) => {
      await tx.update(teamActivityTypes).set({ isDefaultSuggestion: false })
        .where(and(eq(teamActivityTypes.teamId, teamId), sql`${teamActivityTypes.id} != ${typeId}`))
      const [row] = await tx.update(teamActivityTypes).set(typePatch).where(eq(teamActivityTypes.id, typeId)).returning()
      return row
    })
  } else {
    ;[updated] = await db.update(teamActivityTypes).set(typePatch).where(eq(teamActivityTypes.id, typeId)).returning()
  }
  if (!updated) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  // Upsert the matching sf_event_type_config row keyed by (teamId, resolved
  // picklist value). Multiple activity types sharing the same SF value
  // therefore share one config row — last write wins on fallback/duration.
  const hasPicklistFields = sfPicklistIsActive !== undefined || fallbackValue !== undefined || typicalDurationMinutes !== undefined
  if (hasPicklistFields) {
    const resolvedPicklistValue = (updated.crmPicklistValue && updated.crmPicklistValue.trim().length > 0)
      ? updated.crmPicklistValue
      : updated.name
    const [existing] = await db.select().from(sfEventTypeConfig)
      .where(and(eq(sfEventTypeConfig.teamId, teamId), eq(sfEventTypeConfig.sfPicklistValue, resolvedPicklistValue)))
      .limit(1)
    const picklistPatch = {
      ...(sfPicklistIsActive !== undefined && { isActive: sfPicklistIsActive }),
      ...(fallbackValue !== undefined && { fallbackValue }),
      ...(typicalDurationMinutes !== undefined && { typicalDurationMinutes }),
    }
    if (existing) {
      await db.update(sfEventTypeConfig).set(picklistPatch).where(eq(sfEventTypeConfig.id, existing.id))
    } else {
      await db.insert(sfEventTypeConfig).values({
        teamId,
        sfPicklistValue: resolvedPicklistValue,
        isActive: sfPicklistIsActive ?? true,
        fallbackValue: fallbackValue ?? null,
        typicalDurationMinutes: typicalDurationMinutes ?? null,
      })
    }
  }
  res.json({ data: updated, error: null, meta: {} })
})

async function deleteActivityType(typeId: string, res: import('express').Response) {
  try {
    await db.delete(teamActivityTypes).where(eq(teamActivityTypes.id, typeId))
    res.json({ data: { id: typeId }, error: null, meta: {} })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Postgres FK violation when activities or keyword rules reference this type.
    if (msg.includes('foreign key') || msg.includes('violates')) {
      res.status(409).json({
        data: null,
        error: 'in_use',
        meta: { hint: 'This activity type is referenced by existing activities or rules. Deactivate it instead, or reassign the dependent records first.' },
      })
      return
    }
    res.status(500).json({ data: null, error: msg, meta: {} })
  }
}

activityTypesRoutes.delete('/activity-types/:typeId', requireAppAdmin, async (req, res) => {
  const { typeId } = req.params as { typeId: string }
  await deleteActivityType(typeId, res)
})

activityTypesRoutes.delete('/teams/:teamId/activity-types/:typeId', requireRole('admin'), async (req, res) => {
  const { teamId, typeId } = req.params as { teamId: string; typeId: string }
  // Security fix (F-03, pentest 2026-09): confirmed exploitable by the
  // pentest report (a Channel-only team_admin deleted/modified a Sales
  // activity type). See the PATCH handler above for the full rationale.
  const [ownedType] = await db.select({ id: teamActivityTypes.id }).from(teamActivityTypes).where(and(eq(teamActivityTypes.id, typeId), eq(teamActivityTypes.teamId, teamId))).limit(1)
  if (!ownedType) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await deleteActivityType(typeId, res)
})

// v1.67.0: per-activity-type SF Extras CRUD. Kind is one of
// 'opp_field_display', 'related_object_picker', or (v1.337.0)
// 'ticket_picker'; config is jsonb whose expected shape depends on kind
// (see schema.ts comment on the table).
// The type belongs to the team in the URL: it's the type's home team or
// it's assigned there through activity_type_teams (the Activity Types list
// reads the junction). Same IDOR class as the pentest F-03 fixes below.
async function activityTypeVisibleToTeam(typeId: string, teamId: string): Promise<boolean> {
  const [row] = await db.select({ id: teamActivityTypes.id }).from(teamActivityTypes)
    .leftJoin(activityTypeTeams, and(eq(activityTypeTeams.activityTypeId, teamActivityTypes.id), eq(activityTypeTeams.teamId, teamId)))
    .where(and(eq(teamActivityTypes.id, typeId), or(eq(teamActivityTypes.teamId, teamId), eq(activityTypeTeams.teamId, teamId))))
    .limit(1)
  return !!row
}

activityTypesRoutes.get('/teams/:teamId/activity-types/:typeId/sf-extras', requireRole('admin'), async (req, res) => {
  const { teamId, typeId } = req.params as { teamId: string; typeId: string }
  if (!(await activityTypeVisibleToTeam(typeId, teamId))) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const { teamActivityTypeCrmExtras } = await import('../../../../drizzle/schema.js')
  const rows = await db.select().from(teamActivityTypeCrmExtras).where(eq(teamActivityTypeCrmExtras.teamActivityTypeId, typeId)).orderBy(teamActivityTypeCrmExtras.createdAt)
  res.json({ data: rows, error: null, meta: {} })
})

activityTypesRoutes.post('/teams/:teamId/activity-types/:typeId/sf-extras', requireRole('admin'), async (req, res) => {
  const { teamId, typeId } = req.params as { teamId: string; typeId: string }
  if (!(await activityTypeVisibleToTeam(typeId, teamId))) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const schema = z.object({
    kind: z.enum(['opp_field_display', 'related_object_picker', 'ticket_picker']),
    config: z.record(z.string(), z.unknown()),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamActivityTypeCrmExtras } = await import('../../../../drizzle/schema.js')
  const [row] = await db.insert(teamActivityTypeCrmExtras).values({ teamActivityTypeId: typeId, kind: parsed.data.kind, config: parsed.data.config }).returning()
  res.status(201).json({ data: row, error: null, meta: {} })
})

activityTypesRoutes.patch('/teams/:teamId/activity-types/:typeId/sf-extras/:extraId', requireRole('admin'), async (req, res) => {
  const { teamId, typeId, extraId } = req.params as { teamId: string; typeId: string; extraId: string }
  const schema = z.object({
    kind: z.enum(['opp_field_display', 'related_object_picker', 'ticket_picker']).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamActivityTypeCrmExtras } = await import('../../../../drizzle/schema.js')
  // Security fix (F-03, pentest 2026-09): verify the full ownership chain
  // (extra -> activity type -> team) before mutating — previously this
  // looked up the row by extraId alone, not even checking it belongs to
  // :typeId, let alone :teamId.
  const [owned] = await db.select({ id: teamActivityTypeCrmExtras.id }).from(teamActivityTypeCrmExtras)
    .innerJoin(teamActivityTypes, eq(teamActivityTypeCrmExtras.teamActivityTypeId, teamActivityTypes.id))
    .where(and(eq(teamActivityTypeCrmExtras.id, extraId), eq(teamActivityTypeCrmExtras.teamActivityTypeId, typeId), eq(teamActivityTypes.teamId, teamId)))
    .limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [row] = await db.update(teamActivityTypeCrmExtras).set({ ...parsed.data, updatedAt: new Date() }).where(eq(teamActivityTypeCrmExtras.id, extraId)).returning()
  res.json({ data: row, error: null, meta: {} })
})

activityTypesRoutes.delete('/teams/:teamId/activity-types/:typeId/sf-extras/:extraId', requireRole('admin'), async (req, res) => {
  const { teamId, typeId, extraId } = req.params as { teamId: string; typeId: string; extraId: string }
  const { teamActivityTypeCrmExtras } = await import('../../../../drizzle/schema.js')
  // Security fix (F-03, pentest 2026-09): see the PATCH handler above.
  const [owned] = await db.select({ id: teamActivityTypeCrmExtras.id }).from(teamActivityTypeCrmExtras)
    .innerJoin(teamActivityTypes, eq(teamActivityTypeCrmExtras.teamActivityTypeId, teamActivityTypes.id))
    .where(and(eq(teamActivityTypeCrmExtras.id, extraId), eq(teamActivityTypeCrmExtras.teamActivityTypeId, typeId), eq(teamActivityTypes.teamId, teamId)))
    .limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await db.delete(teamActivityTypeCrmExtras).where(eq(teamActivityTypeCrmExtras.id, extraId))
  res.json({ data: { id: extraId }, error: null, meta: {} })
})

// v1.255.0: per-activity-type Subtype labels — display-only for now (see
// Guide page), not wired into classification or the Log Activity form.
// CRUD shape mirrors the SF Extras block above.
activityTypesRoutes.get('/teams/:teamId/activity-types/:typeId/subtypes', requireRole('admin'), async (req, res) => {
  const { typeId } = req.params as { typeId: string }
  const { teamActivityTypeSubtypes } = await import('../../../../drizzle/schema.js')
  const rows = await db.select().from(teamActivityTypeSubtypes).where(eq(teamActivityTypeSubtypes.teamActivityTypeId, typeId)).orderBy(teamActivityTypeSubtypes.sortOrder, teamActivityTypeSubtypes.createdAt)
  res.json({ data: rows, error: null, meta: {} })
})

activityTypesRoutes.post('/teams/:teamId/activity-types/:typeId/subtypes', requireRole('admin'), async (req, res) => {
  const { typeId } = req.params as { typeId: string }
  const schema = z.object({
    name: z.string().min(1).max(200),
    sortOrder: z.number().int().default(100),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamActivityTypeSubtypes } = await import('../../../../drizzle/schema.js')
  const [row] = await db.insert(teamActivityTypeSubtypes).values({ teamActivityTypeId: typeId, name: parsed.data.name, sortOrder: parsed.data.sortOrder }).returning()
  res.status(201).json({ data: row, error: null, meta: {} })
})

activityTypesRoutes.patch('/teams/:teamId/activity-types/:typeId/subtypes/:subtypeId', requireRole('admin'), async (req, res) => {
  const { teamId, typeId, subtypeId } = req.params as { teamId: string; typeId: string; subtypeId: string }
  const schema = z.object({
    name: z.string().min(1).max(200).optional(),
    sortOrder: z.number().int().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamActivityTypeSubtypes } = await import('../../../../drizzle/schema.js')
  // Security fix (F-03, pentest 2026-09): verify the full ownership chain
  // (subtype -> activity type -> team) before mutating — same pattern as
  // the sf-extras routes above.
  const [owned] = await db.select({ id: teamActivityTypeSubtypes.id }).from(teamActivityTypeSubtypes)
    .innerJoin(teamActivityTypes, eq(teamActivityTypeSubtypes.teamActivityTypeId, teamActivityTypes.id))
    .where(and(eq(teamActivityTypeSubtypes.id, subtypeId), eq(teamActivityTypeSubtypes.teamActivityTypeId, typeId), eq(teamActivityTypes.teamId, teamId)))
    .limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [row] = await db.update(teamActivityTypeSubtypes).set(parsed.data).where(eq(teamActivityTypeSubtypes.id, subtypeId)).returning()
  res.json({ data: row, error: null, meta: {} })
})

activityTypesRoutes.delete('/teams/:teamId/activity-types/:typeId/subtypes/:subtypeId', requireRole('admin'), async (req, res) => {
  const { teamId, typeId, subtypeId } = req.params as { teamId: string; typeId: string; subtypeId: string }
  const { teamActivityTypeSubtypes } = await import('../../../../drizzle/schema.js')
  // Security fix (F-03, pentest 2026-09): see the PATCH handler above.
  const [owned] = await db.select({ id: teamActivityTypeSubtypes.id }).from(teamActivityTypeSubtypes)
    .innerJoin(teamActivityTypes, eq(teamActivityTypeSubtypes.teamActivityTypeId, teamActivityTypes.id))
    .where(and(eq(teamActivityTypeSubtypes.id, subtypeId), eq(teamActivityTypeSubtypes.teamActivityTypeId, typeId), eq(teamActivityTypes.teamId, teamId)))
    .limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await db.delete(teamActivityTypeSubtypes).where(eq(teamActivityTypeSubtypes.id, subtypeId))
  res.json({ data: { id: subtypeId }, error: null, meta: {} })
})

// v1.255.0: team-scoped "Distinctions" free text — rendered at the bottom
// of the Guide page. Not per-activity-type, so it lives on `teams` rather
// than in the sf-extras-style child tables above.
activityTypesRoutes.patch('/teams/:teamId/guide-distinctions', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({ guideDistinctions: z.string().max(20000).nullable() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [updated] = await db.update(teams).set({ guideDistinctions: parsed.data.guideDistinctions?.trim() || null }).where(eq(teams.id, teamId)).returning()
  res.json({ data: { guideDistinctions: updated?.guideDistinctions ?? null }, error: null, meta: {} })
})

// v1.256.0: team-wide toggle for the Subtype picker on the Log Activity
// form and Activity Templates (see teamActivityTypeSubtypes and
// activities.subtype_id / activity_templates.subtype_id). Team-admin
// gated (not app-admin) since it lives on the same Admin → Activity Types
// page as SubtypesEditor, right next to the "Seed Default Content" button
// — same permission level as guideDistinctions above, not the app-admin-
// only general team-settings PATCH.
activityTypesRoutes.patch('/teams/:teamId/subtypes-enabled', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({ subtypesEnabled: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [updated] = await db.update(teams).set({ subtypesEnabled: parsed.data.subtypesEnabled }).where(eq(teams.id, teamId)).returning()
  res.json({ data: { subtypesEnabled: updated?.subtypesEnabled ?? false }, error: null, meta: {} })
})

// v1.255.4: admin-triggered fallback for the SE example Guide content.
// The additive-only rules live in services/teams/seedGuideContent.ts, which
// the Demo Data generator also uses — safe to click more than once, and safe
// to click on the wrong team by mistake (worst case: a few blank fields gain
// SE-flavored example text, editable/clearable like any other field).
activityTypesRoutes.post('/teams/:teamId/seed-guide-content', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { seedGuideContent } = await import('../../services/teams/seedGuideContent.js')
  const result = await seedGuideContent(teamId)
  res.json({ data: result, error: null, meta: {} })
})

// v1.374.0: Activity Types export / import — see
// services/teams/activityTypesTransfer.ts for the matching rules. Same
// team-admin gate as every other route on this page.
activityTypesRoutes.get('/teams/:teamId/activity-types/export', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { buildActivityTypesExport } = await import('../../services/teams/activityTypesTransfer.js')
  const doc = await buildActivityTypesExport(teamId, req.user?.email ?? null)
  if (!doc) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: doc, error: null, meta: { count: doc.activityTypes.length } })
})

activityTypesRoutes.post('/teams/:teamId/activity-types/import/preview', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { ActivityTypesDocumentSchema, previewActivityTypesImport } = await import('../../services/teams/activityTypesTransfer.js')
  const parsed = z.object({ document: ActivityTypesDocumentSchema }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.activity_types.import_invalid', meta: { detail: parsed.error.message } }); return }
  const diff = await previewActivityTypesImport(teamId, parsed.data.document, { canEditLocked: await isAppAdmin(req.user!.id), userId: req.user!.id })
  if (!diff) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: diff, error: null, meta: {} })
})

activityTypesRoutes.post('/teams/:teamId/activity-types/import/apply', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { ActivityTypesDocumentSchema, applyActivityTypesImport } = await import('../../services/teams/activityTypesTransfer.js')
  const parsed = z.object({ document: ActivityTypesDocumentSchema }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.activity_types.import_invalid', meta: { detail: parsed.error.message } }); return }
  const doc = parsed.data.document
  try {
    const result = await applyActivityTypesImport(teamId, doc, { canEditLocked: await isAppAdmin(req.user!.id), userId: req.user!.id })
    if (!result) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
    await logAudit(req, {
      action: 'activity_type.import', targetType: 'team', targetId: teamId,
      meta: { ...result, sourceTeamSlug: doc.sourceTeamSlug ?? null, importedFromEmail: doc.exportedByEmail ?? null, importedFromExportedAt: doc.exportedAt },
    })
    res.json({ data: result, error: null, meta: {} })
  } catch (err) {
    console.error('[activity-types import] apply failed', err)
    res.status(500).json({ data: null, error: 'errors.activity_types.import_failed', meta: {} })
  }
})
