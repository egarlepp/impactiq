// POST /api/v1/activities/log (v1.481.0): another tool (DemoIQ, after a demo)
// logs an activity for a user it names by email. GET /api/v1/activities/subtypes
// (v1.482.0) lists the Subtypes it may name for that person. Contract in
// docs/activity-log-api.md.
//
// Only an iqk_ key with the activities:log scope gets in: no session cookie,
// and a rest:full, mcp:read or effort:read key is refused. Logging for anyone
// by email is an App Admin power, so the key's owner must still be an App
// Admin on every call, not only when the key was made. The activity is always
// a draft for the named person to confirm; nothing reaches the CRM until they
// approve it. Mounted before the session-authenticated /api router.
import { Router, type Request, type Response } from 'express'
import { eq } from 'drizzle-orm'
import { verifyApiKey } from '../services/auth/apiKeys.js'
import { db } from '../db/index.js'
import { users } from '../../../drizzle/schema.js'
import { mcpRateCheck } from '../middleware/mcp-rate-limit.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { logAudit } from '../services/audit/log.js'
import { getPublicBaseUrl } from '../services/config/integrations.js'
import { externalLogRequestSchema, externalSubtypesQuerySchema, listExternalSubtypes, logExternalActivity } from '../services/activities/externalLog.js'

export const ACTIVITY_LOG_SCOPE = 'activities:log'
// Bearer keys only, so the CSRF check is skipped for this path (csrf.ts).
export const ACTIVITY_LOG_PATH = '/api/v1/activities/log'

export const activityLogApiRouter = Router()

interface KeyOwner { userId: string; email: string; apiKeyId: string }

async function activityLogKeyOwner(req: Request, res: Response): Promise<KeyOwner | null> {
  const authHeader = req.headers['authorization']
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer iqk_')) {
    res.status(401).json({ data: null, error: 'errors.apikey.missing', meta: {} })
    return null
  }
  const verified = await verifyApiKey(authHeader.slice('Bearer '.length))
  if (!verified) {
    res.status(401).json({ data: null, error: 'errors.apikey.invalid', meta: {} })
    return null
  }
  if (!verified.scopes.includes(ACTIVITY_LOG_SCOPE)) {
    res.status(403).json({ data: null, error: 'errors.apikey.wrong_scope', meta: { required: ACTIVITY_LOG_SCOPE } })
    return null
  }
  const [owner] = await db
    .select({ email: users.email, isAppAdmin: users.isAppAdmin, mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, verified.userId))
    .limit(1)
  if (!owner) { res.status(401).json({ data: null, error: 'errors.apikey.invalid', meta: {} }); return null }
  if (owner.mustChangePassword) { res.status(428).json({ data: null, error: 'errors.must_change_password', meta: {} }); return null }
  if (!owner.isAppAdmin) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return null
  }
  const gate = await mcpRateCheck(verified.apiKeyId)
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfterSec ?? 60))
    res.status(429).json({ data: null, error: 'errors.rate_limited', meta: { reason: gate.reason ?? null } })
    return null
  }
  return { userId: verified.userId, email: owner.email, apiKeyId: verified.apiKeyId }
}

// Per address, before the key is even checked, so guessing keys is slow too.
// The per-key limit (mcpRateCheck) still applies after a key is accepted.
const perIpLimit = rateLimit({ windowMs: 60_000, max: 120 })

activityLogApiRouter.post('/activities/log', perIpLimit, async (req, res) => {
  try {
    // The key is checked before the body, so a caller without one learns nothing.
    const keyOwner = await activityLogKeyOwner(req, res)
    if (!keyOwner) return
    const parsed = externalLogRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: 'errors.activity_log.invalid_request',
        meta: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      })
      return
    }
    const outcome = await logExternalActivity(parsed.data)
    if (!outcome.ok) {
      res.status(outcome.status).json({ data: null, error: outcome.error, meta: {} })
      return
    }
    const { result } = outcome
    if (outcome.created) {
      void logAudit(req, {
        action: 'activity.log_via_api',
        targetType: 'activity',
        targetId: result.activityId,
        actor: { id: keyOwner.userId, email: keyOwner.email },
        meta: { apiKeyId: keyOwner.apiKeyId, ownerEmail: result.ownerEmail, activityType: result.activityType, externalRef: parsed.data.externalRef },
      })
    }
    const base = await getPublicBaseUrl().catch(() => null)
    const url = base
      ? `${base}/?openActivityId=${encodeURIComponent(result.activityId)}&startDate=${result.startDatetime.slice(0, 10)}`
      : null
    res.set('Cache-Control', 'private, no-store')
    res.status(outcome.created ? 201 : 200).json({ data: { ...result, url }, error: null, meta: { deduped: result.deduped } })
  } catch (err) {
    console.error('[activity-log-api] Could not log activity:', err instanceof Error ? err.message : err)
    res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})

activityLogApiRouter.get('/activities/subtypes', perIpLimit, async (req, res) => {
  try {
    const keyOwner = await activityLogKeyOwner(req, res)
    if (!keyOwner) return
    const parsed = externalSubtypesQuerySchema.safeParse({
      ownerEmail: typeof req.query.ownerEmail === 'string' ? req.query.ownerEmail : undefined,
      activityType: typeof req.query.activityType === 'string' ? req.query.activityType : undefined,
    })
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: 'errors.activity_log.invalid_request',
        meta: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      })
      return
    }
    const outcome = await listExternalSubtypes(parsed.data)
    if (!outcome.ok) {
      res.status(outcome.status).json({ data: null, error: outcome.error, meta: {} })
      return
    }
    res.set('Cache-Control', 'private, no-store')
    res.json({ data: outcome.result, error: null, meta: {} })
  } catch (err) {
    console.error('[activity-log-api] Could not list subtypes:', err instanceof Error ? err.message : err)
    res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})
