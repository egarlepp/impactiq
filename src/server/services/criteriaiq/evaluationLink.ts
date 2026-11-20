import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { criteriaiqEvaluationLinks } from '../../../../drizzle/schema.js'
import { getEvaluationSourceSetting } from './evaluationSource.js'
import {
  CriteriaIqError,
  findCriteriaIqProjectsByCrmRecord,
  findCriteriaIqProjectsForOpportunity,
  getCriteriaIqProject,
  type CriteriaIqErrorCode,
  type CriteriaIqProject,
} from './client.js'

// CriteriaIQ as the secondary Project source (CLAUDE.md §9): for a CRM
// Evaluation record, which CriteriaIQ project goes with it.
//
// The link is found, not picked, whenever it can be:
//   1. Exactly one CriteriaIQ project whose Evaluation link holds this record
//      id links on its own.
//   2. Otherwise a choice a person stored earlier (criteriaiq_evaluation_links)
//      wins, as long as that project still exists.
//   3. Otherwise several Evaluation-link matches, or projects on the same
//      Opportunity (by the CRM id CriteriaIQ stores, else by name), are
//      offered for a person to choose from.
//   4. Otherwise nothing.
// CriteriaIQ being down or the key being revoked yields 'unavailable', so the
// drawer shows a short notice and everything the CRM drives keeps working.

// What the drawer shows. Engineer notes are left out on purpose: the drawer
// reads them from the CRM, and this summary goes to any signed-in user.
export interface CriteriaIqProjectSummary {
  id: number
  name: string
  status: string | null
  type: string | null
  startDate: string | null
  endDate: string | null
  primaryEngineerName: string | null
  criteriaTotal: number | null
  criteriaMet: number | null
  mapTasksTotal: number | null
  mapTasksCompleted: number | null
  url: string
}

export type CriteriaIqEvaluationLink =
  | { state: 'off' }
  | { state: 'linked'; how: 'auto' | 'picked'; project: CriteriaIqProjectSummary; candidates: CriteriaIqProjectSummary[] }
  | { state: 'choose'; matchedBy: 'evaluation' | 'opportunity'; candidates: CriteriaIqProjectSummary[] }
  | { state: 'none' }
  | { state: 'unavailable'; error: CriteriaIqErrorCode }

export function toSummary(p: CriteriaIqProject): CriteriaIqProjectSummary {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    type: p.type,
    startDate: p.startDate,
    endDate: p.endDate,
    primaryEngineerName: p.primaryEngineerName,
    criteriaTotal: p.criteriaTotal,
    criteriaMet: p.criteriaMet,
    mapTasksTotal: p.mapTasksTotal,
    mapTasksCompleted: p.mapTasksCompleted,
    url: p.url,
  }
}

export async function isCriteriaIqSecondaryOn(): Promise<boolean> {
  const setting = await getEvaluationSourceSetting()
  return setting.primary === 'crm' && setting.criteriaiqSecondary
}

async function storedProjectId(recordId: string): Promise<number | null> {
  const [row] = await db.select({ id: criteriaiqEvaluationLinks.criteriaiqProjectId })
    .from(criteriaiqEvaluationLinks)
    .where(eq(criteriaiqEvaluationLinks.crmRecordId, recordId))
    .limit(1)
  return row?.id ?? null
}

interface Candidates {
  byEvaluation: CriteriaIqProject[]
  byOpportunity: CriteriaIqProject[]
}

// The linked Opportunity: its CRM id and name, either of which may be unknown.
export interface LinkedOpportunity {
  id: string | null
  name: string | null
}

async function findCandidates(recordId: string, opp: LinkedOpportunity): Promise<Candidates> {
  const byEvaluation = await findCriteriaIqProjectsByCrmRecord(recordId)
  // The Opportunity fallback only runs when the Evaluation id found nothing,
  // so a project already pointing at the Evaluation is never drowned out by
  // other projects on the same Opportunity.
  const byOpportunity = byEvaluation.length === 0 && (opp.id || opp.name)
    ? (await findCriteriaIqProjectsForOpportunity(opp)).projects
    : []
  return { byEvaluation, byOpportunity }
}

export async function resolveCriteriaIqEvaluationLink(recordId: string, opp: LinkedOpportunity): Promise<CriteriaIqEvaluationLink> {
  if (!(await isCriteriaIqSecondaryOn())) return { state: 'off' }
  try {
    const { byEvaluation, byOpportunity } = await findCandidates(recordId, opp)
    if (byEvaluation.length === 1) {
      return { state: 'linked', how: 'auto', project: toSummary(byEvaluation[0]!), candidates: [] }
    }
    const offered = byEvaluation.length > 1 ? byEvaluation : byOpportunity
    const storedId = await storedProjectId(recordId)
    if (storedId !== null) {
      const stored = offered.find((p) => p.id === storedId) ?? await getCriteriaIqProject(storedId)
      if (stored) return { state: 'linked', how: 'picked', project: toSummary(stored), candidates: offered.map(toSummary) }
    }
    if (offered.length > 0) {
      return { state: 'choose', matchedBy: byEvaluation.length > 1 ? 'evaluation' : 'opportunity', candidates: offered.map(toSummary) }
    }
    return { state: 'none' }
  } catch (err) {
    if (err instanceof CriteriaIqError) return { state: 'unavailable', error: err.code }
    throw err
  }
}

export type SetCriteriaIqLinkResult =
  | { ok: true; project: CriteriaIqProjectSummary; previousProjectId: number | null }
  | { ok: false; status: 400 | 409 | 502; error: 'errors.criteriaiq.secondary_off' | 'errors.criteriaiq.not_a_candidate' | CriteriaIqErrorCode }

// Stores a person's choice. The project must be one of the candidates this
// Evaluation is offered right now, so the drawer can't be used to attach an
// arbitrary CriteriaIQ project to a record.
export async function setCriteriaIqEvaluationLink(recordId: string, projectId: number, opp: LinkedOpportunity, userId: string | null): Promise<SetCriteriaIqLinkResult> {
  if (!(await isCriteriaIqSecondaryOn())) return { ok: false, status: 409, error: 'errors.criteriaiq.secondary_off' }
  let candidates: Candidates
  try {
    candidates = await findCandidates(recordId, opp)
  } catch (err) {
    if (err instanceof CriteriaIqError) return { ok: false, status: 502, error: err.code }
    throw err
  }
  const project = [...candidates.byEvaluation, ...candidates.byOpportunity].find((p) => p.id === projectId)
  if (!project) return { ok: false, status: 400, error: 'errors.criteriaiq.not_a_candidate' }
  const previousProjectId = await storedProjectId(recordId)
  await db.insert(criteriaiqEvaluationLinks)
    .values({ crmRecordId: recordId, criteriaiqProjectId: projectId, linkedBy: userId })
    .onConflictDoUpdate({
      target: criteriaiqEvaluationLinks.crmRecordId,
      set: { criteriaiqProjectId: projectId, linkedBy: userId, linkedAt: new Date() },
    })
  return { ok: true, project: toSummary(project), previousProjectId }
}

// Forgets a stored choice; returns the project id it held, or null when
// there was none.
export async function clearCriteriaIqEvaluationLink(recordId: string): Promise<number | null> {
  const removed = await db.delete(criteriaiqEvaluationLinks)
    .where(eq(criteriaiqEvaluationLinks.crmRecordId, recordId))
    .returning({ id: criteriaiqEvaluationLinks.criteriaiqProjectId })
  return removed[0]?.id ?? null
}
