import { Router } from 'express'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { activities } from '../../../drizzle/schema.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { buildAssessmentsView, runAssessments, type AssessedActivity } from '../services/aiAssessments/run.js'
import { GongError } from '../services/gong/client.js'

// The Assessments tab on the activity drawer (v1.462.0), mounted at
// /api/ai-assessments behind requireAuth. Leaders only, never the activity's
// owner (services/aiAssessments/access.ts); everyone else gets visible: false
// and a 404 on Run.

export const aiAssessmentsRouter = Router()

// Run costs money at the AI provider.
const runLimit = rateLimit({ windowMs: 60_000, max: 6, keyFn: (req) => req.user!.id })

async function loadActivity(id: string): Promise<AssessedActivity | null> {
  if (!z.string().uuid().safeParse(id).success) return null
  const [act] = await db.select({
    id: activities.id,
    userId: activities.userId,
    teamId: activities.teamId,
    status: activities.status,
    title: activities.title,
  }).from(activities).where(eq(activities.id, id)).limit(1)
  return act ?? null
}

// GET /activities/:id: the tab's state (visible: false hides the tab).
aiAssessmentsRouter.get('/activities/:id', async (req, res) => {
  const act = await loadActivity(String(req.params['id']))
  if (!act) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: await buildAssessmentsView(req.user!.id, act), error: null, meta: {} })
})

// POST /activities/:id/run: Run assessment (Leaders only).
aiAssessmentsRouter.post('/activities/:id/run', runLimit, async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(String(req.params['id']))
  if (!act) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  let result
  try {
    result = await runAssessments(callerId, act)
  } catch (err) {
    if (err instanceof GongError) { res.status(502).json({ data: null, error: err.code, meta: {} }); return }
    throw err
  }
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: {} }); return }
  res.json({ data: await buildAssessmentsView(callerId, act), error: null, meta: { scored: result.scored } })
})
