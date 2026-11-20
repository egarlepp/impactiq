import { Router, type Response } from 'express'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { activities, teamMembers } from '../../../drizzle/schema.js'
import { isAppAdmin } from '../middleware/rbac.js'
import { logAudit } from '../services/audit/log.js'
import {
  clearCriteriaIqEvaluationLink,
  isCriteriaIqSecondaryOn,
  resolveCriteriaIqEvaluationLink,
  setCriteriaIqEvaluationLink,
  toSummary,
} from '../services/criteriaiq/evaluationLink.js'
import {
  CriteriaIqError,
  findCriteriaIqProjectsForAccount,
  findCriteriaIqProjectsForOpportunity,
  getCriteriaIqProject,
  searchCriteriaIqProjects,
} from '../services/criteriaiq/client.js'
import { getEvaluationSourceSetting } from '../services/criteriaiq/evaluationSource.js'

// CriteriaIQ as the secondary Project source, for the activity drawer
// (CLAUDE.md §9). Mounted under apiRouter, which already applies
// requireAuth. Every route answers quietly ({state:'off'} or 409) when an
// App Admin hasn't turned the secondary on, so the drawer can call it
// unconditionally.
export const criteriaiqRouter = Router()

// CRM record ids are short and alphanumeric (Salesforce's 15/18-character
// ids, HubSpot's numeric ids).
const RecordId = z.string().regex(/^[A-Za-z0-9]{1,64}$/)
const OpportunityName = z.string().max(255)

function query(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// The linked Opportunity from ?oppId=&oppName= (or the same keys in a body).
// Undefined when either is malformed.
function linkedOpp(rawId: unknown, rawName: unknown): { id: string | null; name: string | null } | undefined {
  const id = RecordId.optional().safeParse(typeof rawId === 'string' && rawId !== '' ? rawId : undefined)
  const name = OpportunityName.optional().safeParse(typeof rawName === 'string' ? rawName : undefined)
  if (!id.success || !name.success) return undefined
  return { id: id.data ?? null, name: name.data?.trim() || null }
}

criteriaiqRouter.get('/evaluation-link', async (req, res) => {
  const recordId = RecordId.safeParse(query(req.query['recordId']))
  const opp = linkedOpp(req.query['oppId'], req.query['oppName'])
  if (!recordId.success || !opp) {
    res.status(400).json({ data: null, error: 'errors.criteriaiq.invalid_request', meta: {} })
    return
  }
  const data = await resolveCriteriaIqEvaluationLink(recordId.data, opp)
  res.json({ data, error: null, meta: {} })
})

// Security audit L6 (v1.425.0): the link is install-wide, so changing it
// needs a stake in the record: an App Admin, someone with their own activity
// on this Evaluation, or a leader or admin on a team that has one. Reading it
// stays open to anyone signed in.
async function canChangeEvaluationLink(userId: string, recordId: string): Promise<boolean> {
  if (await isAppAdmin(userId)) return true
  const linked = await db
    .selectDistinct({ userId: activities.userId, teamId: activities.teamId })
    .from(activities)
    .where(eq(activities.crmRelatedId, recordId))
  if (linked.some((a) => a.userId === userId)) return true
  const teamIds = [...new Set(linked.map((a) => a.teamId))]
  if (teamIds.length === 0) return false
  const [lead] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, teamIds), inArray(teamMembers.role, ['leader', 'admin', 'team_admin'])))
    .limit(1)
  return !!lead
}

function refuseLinkChange(res: Response): void {
  res.status(403).json({ data: null, error: 'errors.criteriaiq.link_not_allowed', meta: {} })
}

const SetBody = z.object({
  recordId: RecordId,
  projectId: z.number().int().positive(),
  oppId: RecordId.optional(),
  oppName: OpportunityName.optional(),
})

criteriaiqRouter.put('/evaluation-link', async (req, res) => {
  const body = SetBody.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ data: null, error: 'errors.criteriaiq.invalid_request', meta: {} })
    return
  }
  const { recordId, projectId, oppId, oppName } = body.data
  if (!(await canChangeEvaluationLink(req.user!.id, recordId))) { refuseLinkChange(res); return }
  const opp = { id: oppId ?? null, name: oppName?.trim() || null }
  const result = await setCriteriaIqEvaluationLink(recordId, projectId, opp, req.user?.id ?? null)
  if (!result.ok) {
    res.status(result.status).json({ data: null, error: result.error, meta: {} })
    return
  }
  await logAudit(req, {
    action: 'criteriaiq.evaluation_link.set',
    targetType: 'crm_record',
    targetId: recordId,
    meta: { before: { criteriaiqProjectId: result.previousProjectId }, after: { criteriaiqProjectId: projectId } },
  })
  res.json({ data: await resolveCriteriaIqEvaluationLink(recordId, opp), error: null, meta: {} })
})

criteriaiqRouter.delete('/evaluation-link', async (req, res) => {
  const recordId = RecordId.safeParse(query(req.query['recordId']))
  const opp = linkedOpp(req.query['oppId'], req.query['oppName'])
  if (!recordId.success || !opp) {
    res.status(400).json({ data: null, error: 'errors.criteriaiq.invalid_request', meta: {} })
    return
  }
  if (!(await isCriteriaIqSecondaryOn())) {
    res.status(409).json({ data: null, error: 'errors.criteriaiq.secondary_off', meta: {} })
    return
  }
  if (!(await canChangeEvaluationLink(req.user!.id, recordId.data))) { refuseLinkChange(res); return }
  const previous = await clearCriteriaIqEvaluationLink(recordId.data)
  if (previous !== null) {
    await logAudit(req, {
      action: 'criteriaiq.evaluation_link.clear',
      targetType: 'crm_record',
      targetId: recordId.data,
      meta: { before: { criteriaiqProjectId: previous }, after: { criteriaiqProjectId: null } },
    })
  }
  res.json({ data: await resolveCriteriaIqEvaluationLink(recordId.data, opp), error: null, meta: {} })
})

// ── CriteriaIQ as the primary Project source (v1.388.0) ───────────────────
// The activity form's Project picker. Both routes answer 409 unless CriteriaIQ
// is the primary source, and a CriteriaIQ outage comes back as a 502 with the
// client's i18n error key so the picker can show it.

async function requireCriteriaIqPrimary(res: Response): Promise<boolean> {
  const { primary } = await getEvaluationSourceSetting()
  if (primary === 'criteriaiq') return true
  res.status(409).json({ data: null, error: primary === 'off' ? 'errors.evaluation_source.projects_off' : 'errors.evaluation_source.not_criteriaiq', meta: {} })
  return false
}

const SearchText = z.string().max(120)

// GET /api/criteriaiq/projects?oppId=&oppName=&accountId=&q=
// `suggested`: projects on the linked Opportunity, by the CRM id CriteriaIQ
//   stores, else by Opportunity name (`matchedBy` says which).
// `accountSuggested`: other projects on the linked Account (by CRM id).
// `results`: projects whose name, customer or Opportunity contains `q`.
criteriaiqRouter.get('/projects', async (req, res) => {
  if (!(await requireCriteriaIqPrimary(res))) return
  const opp = linkedOpp(req.query['oppId'], req.query['oppName'])
  const accountId = RecordId.optional().safeParse(query(req.query['accountId']) || undefined)
  const q = SearchText.optional().safeParse(query(req.query['q']))
  if (!opp || !accountId.success || !q.success) {
    res.status(400).json({ data: null, error: 'errors.criteriaiq.invalid_request', meta: {} })
    return
  }
  try {
    const text = q.data?.trim()
    const suggested = opp.id || opp.name ? await findCriteriaIqProjectsForOpportunity(opp) : { projects: [], matchedBy: null }
    const shown = new Set(suggested.projects.map((p) => p.id))
    const accountSuggested = accountId.data
      ? (await findCriteriaIqProjectsForAccount(accountId.data)).filter((p) => !shown.has(p.id))
      : []
    const results = text ? await searchCriteriaIqProjects(text) : []
    res.json({
      data: {
        suggested: suggested.projects.map(toSummary),
        matchedBy: suggested.matchedBy,
        accountSuggested: accountSuggested.map(toSummary),
        results: results.map(toSummary),
      },
      error: null,
      meta: {},
    })
  } catch (err) {
    if (!(err instanceof CriteriaIqError)) throw err
    res.status(502).json({ data: null, error: err.code, meta: {} })
  }
})

// GET /api/criteriaiq/projects/:id — one project's summary, for the form's
// Project box and the Project drill-in.
criteriaiqRouter.get('/projects/:id', async (req, res) => {
  if (!(await requireCriteriaIqPrimary(res))) return
  const id = Number((req.params as { id: string }).id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ data: null, error: 'errors.criteriaiq.invalid_request', meta: {} })
    return
  }
  try {
    const project = await getCriteriaIqProject(id)
    if (!project) {
      res.status(404).json({ data: null, error: 'errors.criteriaiq.project_not_found', meta: {} })
      return
    }
    res.json({ data: toSummary(project), error: null, meta: {} })
  } catch (err) {
    if (!(err instanceof CriteriaIqError)) throw err
    res.status(502).json({ data: null, error: err.code, meta: {} })
  }
})
