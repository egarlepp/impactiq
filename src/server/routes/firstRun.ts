// v1.475.0: first-admin bootstrap routes, mounted only when DATABASE_URL is set
// (the /setup wizard covers the case where it isn't). See
// services/auth/firstRun.ts for the model.
import { Router } from 'express'
import { z } from 'zod'
import { createFirstAdmin, needsFirstAdmin } from '../services/auth/firstRun.js'
import { setupTokenMatches } from './setup.js'
import { logAudit } from '../services/audit/log.js'

export const firstRunRouter = Router()

// GET /api/first-run/status: public, so the sign-in page can show the form.
// Says only whether an account exists yet.
firstRunRouter.get('/status', async (_req, res) => {
  try {
    res.json({ data: { needsAdmin: await needsFirstAdmin() }, error: null, meta: {} })
  } catch {
    res.status(500).json({ data: null, error: 'errors.first_run.status_failed', meta: {} })
  }
})

const FirstAdminSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(256),
})

// POST /api/first-run/admin: needs the setup token from the server log.
// Refused for good once any user exists.
firstRunRouter.post('/admin', async (req, res) => {
  if (!(await needsFirstAdmin())) {
    res.status(409).json({ data: null, error: 'errors.first_run.already_done', meta: {} })
    return
  }
  if (!setupTokenMatches(req.headers['x-setup-token'])) {
    res.status(401).json({ data: null, error: 'errors.setup.token_invalid', meta: {} })
    return
  }
  const parsed = FirstAdminSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.first_run.invalid_input', meta: {} })
    return
  }
  try {
    const result = await createFirstAdmin(parsed.data)
    if (!result.ok) {
      res.status(result.status).json({ data: null, error: result.error, meta: result.detail ? { failed: result.detail } : {} })
      return
    }
    await logAudit(req, {
      action: 'user.create',
      targetType: 'user',
      targetId: result.userId,
      meta: { source: 'first_run', isAppAdmin: true, isDefaultAdmin: true },
      actor: { id: result.userId, email: parsed.data.email.toLowerCase() },
    })
    console.log('[first-run] First admin account created. The setup token no longer does anything.')
    res.json({ data: { ok: true }, error: null, meta: {} })
  } catch (err) {
    console.error('[first-run] Creating the first admin failed:', err)
    res.status(500).json({ data: null, error: 'errors.first_run.create_failed', meta: {} })
  }
})
