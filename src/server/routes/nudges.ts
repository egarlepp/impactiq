import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { evaluateNudges } from '../services/nudge/engine.js'
import { z } from 'zod'
import { muteNudgeRuleUntilNextUtcMidnight, snoozeNudgeRuleForDays } from '../services/nudge/dismissals.js'

export const nudgesRouter = Router()

nudgesRouter.use(requireAuth)

// GET /api/nudges?teamId=[&locale=en|es|de|fr|ja|pt]
// v1.125.0: locale, when set, swaps in the nudge_rule_translations
// row for that locale (if present) before token substitution. Falls
// back to the base messageTemplate on the rule.
nudgesRouter.get('/', async (req, res) => {
  // Coerce query values to strings — Express can hand back arrays/objects.
  const q = req.query as Record<string, unknown>
  const teamId = typeof q['teamId'] === 'string' ? q['teamId'] : undefined
  const locale = typeof q['locale'] === 'string' ? q['locale'].slice(0, 8) : null
  if (!teamId) {
    res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} })
    return
  }

  const nudges = await evaluateNudges(req.user!.id, teamId, locale)
  res.json({ data: nudges, error: null, meta: {} })
})

// POST /api/nudges/dismiss — the caller snoozes a rule for `days` days. Days
// defaults to 7 to preserve the pre-v1.63.0 behavior; the bell's snooze menu,
// the weekly-view nudge card's snooze menu, and the bottom toast's snooze
// menu all send 1, 7, or 30 explicitly so users can pick a duration.
//
// v1.292.0: this route used to also accept `permanent: true` for a
// never-re-fires close-out (v1.287.0). That capability moved exclusively to
// the notification bell's Dismiss (X), which now hits
// `DELETE /api/notifications/:id` instead — see closeOutNudgeRuleForever in
// services/nudge/dismissals.ts. The weekly-view card and the toast
// deliberately never offer a permanent close-out, so this route no longer
// needs to support one.
nudgesRouter.post('/dismiss', async (req, res) => {
  const schema = z.object({
    ruleId: z.string().uuid(),
    days: z.number().int().min(1).max(365).default(7),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.message, meta: {} })
    return
  }
  await snoozeNudgeRuleForDays(req.user!.id, parsed.data.ruleId, parsed.data.days)
  res.json({ data: { dismissed: true, days: parsed.data.days }, error: null, meta: {} })
})

// POST /api/nudges/mark-read — the weekly-view nudge card's and the bottom
// toast's checkmark. Same "mute until next UTC midnight" semantic as the
// notification bell's checkmark (PATCH /api/notifications/:id/read), just
// addressed by ruleId directly since neither of those two surfaces has a
// notifications-table row to key off — see CLAUDE.md §11.
nudgesRouter.post('/mark-read', async (req, res) => {
  const schema = z.object({ ruleId: z.string().uuid() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.message, meta: {} })
    return
  }
  await muteNudgeRuleUntilNextUtcMidnight(req.user!.id, parsed.data.ruleId)
  res.json({ data: { markedRead: true }, error: null, meta: {} })
})
