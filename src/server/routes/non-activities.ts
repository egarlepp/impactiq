import { Router } from 'express'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { nonActivityEvents } from '../../../drizzle/schema.js'
import { requireAuth } from '../middleware/auth.js'

export const nonActivitiesRouter = Router()

nonActivitiesRouter.use(requireAuth)

// GET /api/non-activities — outlook_event_ids the caller has marked as
// "not an activity". The Activities page uses the set to filter suggestions
// from the day-grouped list when Show Non-Activities is off.
nonActivitiesRouter.get('/', async (req, res) => {
  const rows = await db
    .select({ outlookEventId: nonActivityEvents.outlookEventId })
    .from(nonActivityEvents)
    .where(eq(nonActivityEvents.userId, req.user!.id))
  res.json({ data: rows.map((r) => r.outlookEventId), error: null, meta: {} })
})

// POST /api/non-activities { outlookEventId }
nonActivitiesRouter.post('/', async (req, res) => {
  const parsed = z.object({ outlookEventId: z.string().min(1).max(400) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await db
    .insert(nonActivityEvents)
    .values({ userId: req.user!.id, outlookEventId: parsed.data.outlookEventId })
    .onConflictDoNothing()
  res.json({ data: parsed.data, error: null, meta: {} })
})

// DELETE /api/non-activities/:outlookEventId — flip an event back to a regular
// suggestion.
nonActivitiesRouter.delete('/:outlookEventId', async (req, res) => {
  const { outlookEventId } = req.params as { outlookEventId: string }
  if (!outlookEventId) { res.status(400).json({ data: null, error: 'errors.validation.required', meta: {} }); return }
  await db
    .delete(nonActivityEvents)
    .where(and(eq(nonActivityEvents.userId, req.user!.id), eq(nonActivityEvents.outlookEventId, outlookEventId)))
  res.json({ data: { outlookEventId }, error: null, meta: {} })
})
