import { Router } from 'express'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { activityTemplates, teamActivityTypeSubtypes } from '../../../drizzle/schema.js'
import { requireAuth } from '../middleware/auth.js'

export const templatesRouter = Router()
templatesRouter.use(requireAuth)

// v1.256.0: same server-resolved denormalization convention as
// activities.ts's resolveSubtypeName — Subtypes are ImpactIQ's own
// admin-managed list, so subtypeName is looked up from subtypeId rather
// than trusted from the client.
async function resolveSubtypeName(subtypeId: string | null | undefined): Promise<string | null> {
  if (!subtypeId) return null
  const [row] = await db.select({ name: teamActivityTypeSubtypes.name }).from(teamActivityTypeSubtypes).where(eq(teamActivityTypeSubtypes.id, subtypeId)).limit(1)
  return row?.name ?? null
}

const UpsertSchema = z.object({
  name: z.string().min(1).max(120),
  teamId: z.string().uuid().nullable().optional(),
  activityTypeId: z.string().uuid().nullable().optional(),
  // v1.256.0: pre-fills the Log Activity form's Subtype picker when this
  // template is applied. Never written to Salesforce.
  subtypeId: z.string().uuid().nullable().optional(),
  titleTemplate: z.string().min(1).max(500),
  notesTemplate: z.string().max(4000).nullable().optional(),
  effortHoursDefault: z.number().min(0).max(24).nullable().optional(),
  locationModeDefault: z.enum(['remote', 'onsite']).nullable().optional(),
  productIds: z.array(z.string().uuid()).nullable().optional(),
})

// GET /api/templates — list the caller's templates.
templatesRouter.get('/', async (req, res) => {
  const rows = await db
    .select()
    .from(activityTemplates)
    .where(eq(activityTemplates.userId, req.user!.id))
    .orderBy(desc(activityTemplates.updatedAt))
  res.json({ data: rows, error: null, meta: {} })
})

// POST /api/templates — create a new one.
templatesRouter.post('/', async (req, res) => {
  const parsed = UpsertSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [row] = await db.insert(activityTemplates).values({
    userId: req.user!.id,
    teamId: parsed.data.teamId ?? null,
    activityTypeId: parsed.data.activityTypeId ?? null,
    subtypeId: parsed.data.subtypeId ?? null,
    subtypeName: await resolveSubtypeName(parsed.data.subtypeId),
    name: parsed.data.name,
    titleTemplate: parsed.data.titleTemplate,
    notesTemplate: parsed.data.notesTemplate ?? null,
    effortHoursDefault: parsed.data.effortHoursDefault !== undefined && parsed.data.effortHoursDefault !== null
      ? parsed.data.effortHoursDefault.toFixed(2)
      : null,
    locationModeDefault: parsed.data.locationModeDefault ?? null,
    productIds: parsed.data.productIds ?? null,
  }).returning()
  res.status(201).json({ data: row, error: null, meta: {} })
})

// PATCH /api/templates/:id — update.
templatesRouter.patch('/:id', async (req, res) => {
  const { id } = req.params as { id: string }
  const parsed = UpsertSchema.partial().safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const patch: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() }
  if (parsed.data.effortHoursDefault !== undefined) {
    patch['effortHoursDefault'] = parsed.data.effortHoursDefault === null ? null : parsed.data.effortHoursDefault.toFixed(2)
  }
  if (parsed.data.subtypeId !== undefined) {
    patch['subtypeName'] = await resolveSubtypeName(parsed.data.subtypeId)
  }
  const [row] = await db.update(activityTemplates).set(patch)
    .where(and(eq(activityTemplates.id, id), eq(activityTemplates.userId, req.user!.id)))
    .returning()
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: row, error: null, meta: {} })
})

// DELETE /api/templates/:id — remove.
templatesRouter.delete('/:id', async (req, res) => {
  const { id } = req.params as { id: string }
  const result = await db.delete(activityTemplates)
    .where(and(eq(activityTemplates.id, id), eq(activityTemplates.userId, req.user!.id)))
    .returning({ id: activityTemplates.id })
  if (result.length === 0) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: { id }, error: null, meta: {} })
})
