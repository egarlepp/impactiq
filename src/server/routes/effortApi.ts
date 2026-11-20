// GET /api/v1/effort?crmOpportunityId= (v1.448.0): logged effort on one CRM
// Opportunity, read by CriteriaIQ for its project page. Contract in
// docs/effort-api.md.
//
// v1.454.0: GET /api/v1/effort/activity-types (the type names CriteriaIQ's
// admin chooses from) and POST /api/v1/effort/project-counts (activity counts
// for up to 200 CriteriaIQ projects in one call, for its project table).
//
// Only an iqk_ key with the effort:read scope gets in: no session cookie, and a
// rest:full or MCP key is refused, so the key CriteriaIQ stores can read these
// totals and nothing else. The key acts with its owner's current access: the
// owner must still lead or administer a team (checked on every call, not only
// when the key was made), and only teams the owner can see count. Mounted
// before the session-authenticated /api router.
import { Router, type Request, type Response } from 'express'
import { verifyApiKey } from '../services/auth/apiKeys.js'
import { db } from '../db/index.js'
import { users } from '../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { getAccessibleTeamIds, hasAnyLeaderOrAdminRole } from '../middleware/rbac.js'
import { mcpRateCheck } from '../middleware/mcp-rate-limit.js'
import { getOpportunityEffort, parseCrmOpportunityId } from '../services/activities/opportunityEffort.js'
import {
  getProjectActivityCounts,
  listActivityTypeOptions,
  MAX_PROJECTS_PER_REQUEST,
  listProjectActivities,
  projectActivitiesRequestSchema,
  projectCountsRequestSchema,
} from '../services/activities/projectActivityCounts.js'

export const EFFORT_SCOPE = 'effort:read'

export const effortApiRouter = Router()

async function effortKeyOwner(req: Request, res: Response, cost = 1): Promise<string | null> {
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
  if (!verified.scopes.includes(EFFORT_SCOPE)) {
    res.status(403).json({ data: null, error: 'errors.apikey.wrong_scope', meta: { required: EFFORT_SCOPE } })
    return null
  }
  const [owner] = await db.select({ mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, verified.userId)).limit(1)
  if (!owner) { res.status(401).json({ data: null, error: 'errors.apikey.invalid', meta: {} }); return null }
  if (owner.mustChangePassword) { res.status(428).json({ data: null, error: 'errors.must_change_password', meta: {} }); return null }
  if (!(await hasAnyLeaderOrAdminRole(verified.userId))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return null
  }
  // A batch of N projects costs ceil(N / 50) calls, so the per-key and daily
  // limits still mean roughly what they meant for one call per Opportunity.
  const gate = await mcpRateCheck(verified.apiKeyId, cost)
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfterSec ?? 60))
    res.status(429).json({ data: null, error: 'errors.rate_limited', meta: { reason: gate.reason ?? null } })
    return null
  }
  return verified.userId
}

effortApiRouter.get('/effort', async (req, res) => {
  try {
    const userId = await effortKeyOwner(req, res)
    if (!userId) return
    const crmOpportunityId = parseCrmOpportunityId(req.query['crmOpportunityId'])
    if (!crmOpportunityId) {
      res.status(400).json({ data: null, error: 'errors.effort.invalid_opportunity_id', meta: {} })
      return
    }
    const effort = await getOpportunityEffort(crmOpportunityId, await getAccessibleTeamIds(userId))
    res.set('Cache-Control', 'private, no-store')
    res.json({ data: effort, error: null, meta: {} })
  } catch (err) {
    console.error('[effort-api] Could not load effort:', err instanceof Error ? err.message : err)
    res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})

effortApiRouter.get('/effort/activity-types', async (req, res) => {
  try {
    const userId = await effortKeyOwner(req, res)
    if (!userId) return
    const types = await listActivityTypeOptions(await getAccessibleTeamIds(userId))
    res.set('Cache-Control', 'private, no-store')
    res.json({ data: { version: 1, activityTypes: types }, error: null, meta: {} })
  } catch (err) {
    console.error('[effort-api] Could not list activity types:', err instanceof Error ? err.message : err)
    res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})

// Read-only, though it is a POST: 200 projects don't fit in a query string.
// Bearer keys only, so the CSRF check is skipped for this path (csrf.ts).
export const PROJECT_COUNTS_PATH = '/api/v1/effort/project-counts'

effortApiRouter.post('/effort/project-counts', async (req, res) => {
  try {
    // The key is checked before the body, so a caller without one learns nothing.
    const body: unknown = req.body
    const listed = body && typeof body === 'object' && Array.isArray((body as { projects?: unknown }).projects)
      ? Math.min((body as { projects: unknown[] }).projects.length, MAX_PROJECTS_PER_REQUEST)
      : 1
    const userId = await effortKeyOwner(req, res, Math.ceil(Math.max(1, listed) / 50))
    if (!userId) return
    const parsed = projectCountsRequestSchema.safeParse(body)
    if (!parsed.success) {
      res.status(400).json({ data: null, error: 'errors.effort.invalid_project_counts', meta: { maxProjects: MAX_PROJECTS_PER_REQUEST } })
      return
    }
    const counts = await getProjectActivityCounts(parsed.data, await getAccessibleTeamIds(userId))
    res.set('Cache-Control', 'private, no-store')
    res.json({ data: counts, error: null, meta: {} })
  } catch (err) {
    console.error('[effort-api] Could not count project activities:', err instanceof Error ? err.message : err)
    res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})

// The activities behind one project's count (v1.479.0), for CriteriaIQ's
// Activities drawer. Same key, same rules, same matching as project-counts.
export const PROJECT_ACTIVITIES_PATH = '/api/v1/effort/project-activities'

effortApiRouter.post('/effort/project-activities', async (req, res) => {
  try {
    const userId = await effortKeyOwner(req, res)
    if (!userId) return
    const parsed = projectActivitiesRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ data: null, error: 'errors.effort.invalid_project_activities', meta: {} })
      return
    }
    const list = await listProjectActivities(parsed.data, await getAccessibleTeamIds(userId))
    res.set('Cache-Control', 'private, no-store')
    res.json({ data: list, error: null, meta: {} })
  } catch (err) {
    console.error('[effort-api] Could not list project activities:', err instanceof Error ? err.message : err)
    res.status(500).json({ data: null, error: 'errors.internal', meta: {} })
  }
})
