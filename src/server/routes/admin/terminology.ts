import { Router } from 'express'
import { z } from 'zod'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { getTerminology, planTerminologyRename, saveTerminology } from '../../services/config/terminology.js'
import { CUSTOM_EVAL_TERM_MAX, EVAL_TERM_OPTIONS, cleanCustomEvalTerm, normalizeTerminology, type Terminology } from '../../../shared/terminology.js'

// Admin → Workplace → Terminology (services/config/terminology.ts). App Admin
// only: the term names Activity Types on every team. Everyone reads it via
// GET /api/terminology.
export const terminologyRoutes = Router()

const bodySchema = z.object({
  evalTerm: z.enum(EVAL_TERM_OPTIONS),
  customEvalTerm: z.string().max(CUSTOM_EVAL_TERM_MAX * 2).nullable().optional(),
})

function parseTerminology(body: unknown): { value: Terminology } | { error: string } {
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return { error: 'errors.terminology.invalid' }
  if (parsed.data.evalTerm !== 'custom') return { value: { evalTerm: parsed.data.evalTerm, customEvalTerm: null } }
  const custom = cleanCustomEvalTerm(parsed.data.customEvalTerm)
  if (!custom) return { error: `errors.terminology.custom_invalid|max=${CUSTOM_EVAL_TERM_MAX}` }
  return { value: normalizeTerminology({ evalTerm: 'custom', customEvalTerm: custom }) }
}

terminologyRoutes.get('/terminology', requireAppAdmin, async (_req, res) => {
  res.json({ data: await getTerminology(), error: null, meta: {} })
})

// What a save would rename, so the page can ask first.
terminologyRoutes.post('/terminology/preview', requireAppAdmin, async (req, res) => {
  const parsed = parseTerminology(req.body)
  if ('error' in parsed) { res.status(400).json({ data: null, error: parsed.error, meta: {} }); return }
  const plan = await planTerminologyRename(await getTerminology(), parsed.value)
  res.json({ data: plan, error: null, meta: {} })
})

terminologyRoutes.put('/terminology', requireAppAdmin, async (req, res) => {
  const parsed = parseTerminology(req.body)
  if ('error' in parsed) { res.status(400).json({ data: null, error: parsed.error, meta: {} }); return }
  const renameTypes = (req.body as { renameTypes?: unknown } | undefined)?.renameTypes !== false
  const { before, after, plan, result } = await saveTerminology(parsed.value, { renameTypes })
  await logAudit(req, {
    action: 'terminology.update',
    targetType: 'system_setting',
    targetId: 'terminology',
    meta: { before, after, from: plan.from, to: plan.to, renameTypes, ...result },
  })
  res.json({ data: after, error: null, meta: { result } })
})
