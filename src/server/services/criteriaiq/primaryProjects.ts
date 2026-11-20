import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities } from '../../../../drizzle/schema.js'
import {
  CRITERIAIQ_RELATED_TYPE,
  isBlockedProjectLink,
  isWrongSourceProjectLink,
} from '../../../shared/evaluationSource.js'
import { getEvaluationSourceSetting } from './evaluationSource.js'
import {
  CriteriaIqError,
  getCriteriaIqProject,
  listCriteriaIqProjects,
  normalizeCrmId,
  type CriteriaIqProject,
} from './client.js'
import { writeRun } from '../jobs/writeRun.js'
import { getCrmProviderId } from '../crm/providerSetting.js'
import { HubspotError } from '../hubspot/client.js'
import { hubspotProjectSnapshot, type HubspotProjectSnapshot } from '../hubspot/projects.js'
import { isHubspotProjectObject } from '../../../shared/hubspot.js'
import { scheduleJob } from '../jobs/scheduler.js'

// CriteriaIQ as the primary Project source (CLAUDE.md §9). A Project link is
// stored in the same columns a CRM Evaluation link uses, so the Project
// dashboards and the activity card work unchanged:
//   crm_related_type = 'CriteriaIQ', crm_related_id = the CriteriaIQ project id,
//   crm_related_name and the crm_eval_* snapshot from the CriteriaIQ project.
// CriteriaIQ has no Stage, so crm_eval_stage stays empty.

export interface ProjectSnapshot {
  crmRelatedName: string
  crmEvalStatus: string | null
  crmEvalStage: null
  crmEvalType: string | null
  crmEvalStartDate: string | null
  crmEvalEndDate: string | null
  crmEvalPrimaryEngineer: string | null
  // The project was just read, so any "link broken" flag is stale.
  crmRelatedDeleted: false
}

// CriteriaIQ sends dates as ISO strings, sometimes with a time part; the
// snapshot columns are plain dates.
function toDate(v: string | null): string | null {
  const m = v ? /^(\d{4}-\d{2}-\d{2})/.exec(v) : null
  return m ? m[1]! : null
}

export function toProjectSnapshot(p: CriteriaIqProject): ProjectSnapshot {
  return {
    crmRelatedName: p.name,
    crmEvalStatus: p.status,
    crmEvalStage: null,
    crmEvalType: p.type,
    crmEvalStartDate: toDate(p.startDate),
    crmEvalEndDate: toDate(p.endDate),
    crmEvalPrimaryEngineer: p.primaryEngineerName,
    crmRelatedDeleted: false,
  }
}

interface IncomingLink { crmRelatedId?: string | null | undefined; crmRelatedType?: string | null | undefined }

export type ProjectLinkCheck =
  | { ok: true; snapshot: ProjectSnapshot | HubspotProjectSnapshot | null }
  | { ok: false; status: 400 | 403; error: string }

// Every activity save runs this on its Project link. It refuses a new or
// changed link while Projects are off or from the wrong source and, with
// CriteriaIQ as primary, reads the project once to store its snapshot (the
// name and fields the client sent are never trusted for that). CriteriaIQ
// being unreachable doesn't block the save: the link is kept with the name
// the picker showed and the nightly refresh fills the snapshot in.
// On HubSpot with Projects from the CRM, a new link to a HubSpot Project
// record is read the same way (best effort, through the team's mappings);
// HubSpot being unreachable never blocks the save either.
export async function checkProjectLink(incoming: IncomingLink, existing?: { crmRelatedId?: string | null } | null, teamId?: string | null): Promise<ProjectLinkCheck> {
  const { primary } = await getEvaluationSourceSetting()
  if (isBlockedProjectLink(primary, incoming, existing)) return { ok: false, status: 403, error: 'errors.evaluation_source.projects_off' }
  if (isWrongSourceProjectLink(primary, incoming, existing)) return { ok: false, status: 400, error: 'errors.evaluation_source.wrong_project_source' }
  const changed = !!incoming.crmRelatedId && incoming.crmRelatedId !== existing?.crmRelatedId
  if (primary === 'crm' && changed && incoming.crmRelatedType && isHubspotProjectObject(incoming.crmRelatedType)) {
    return { ok: true, snapshot: await hubspotSnapshotForLink(teamId ?? null, incoming.crmRelatedType, incoming.crmRelatedId!) }
  }
  if (primary !== 'criteriaiq' || !changed) return { ok: true, snapshot: null }
  try {
    const project = await getCriteriaIqProject(Number(incoming.crmRelatedId))
    if (!project) return { ok: false, status: 400, error: 'errors.criteriaiq.project_not_found' }
    return { ok: true, snapshot: toProjectSnapshot(project) }
  } catch (err) {
    if (err instanceof CriteriaIqError) return { ok: true, snapshot: null }
    throw err
  }
}

async function hubspotSnapshotForLink(teamId: string | null, objectTypeId: string, recordId: string): Promise<HubspotProjectSnapshot | null> {
  if ((await getCrmProviderId()) !== 'hubspot') return null
  try {
    return await hubspotProjectSnapshot(teamId, objectTypeId, recordId)
  } catch (err) {
    if (err instanceof HubspotError) return null
    throw err
  }
}

function linkedToProject(id: string) {
  return and(eq(activities.crmRelatedType, CRITERIAIQ_RELATED_TYPE), eq(activities.crmRelatedId, id))
}

// A project that was read (null = a confirmed 404) onto every activity linked
// to it.
async function applyProjectSnapshot(id: string, project: CriteriaIqProject | null): Promise<'updated' | 'not_found'> {
  if (!project) {
    await db.update(activities).set({ crmRelatedDeleted: true, crmDisconnectCheckedAt: new Date() }).where(linkedToProject(id))
    return 'not_found'
  }
  await db.update(activities).set({ ...toProjectSnapshot(project), crmDisconnectCheckedAt: new Date() }).where(linkedToProject(id))
  return 'updated'
}

// One project's snapshot, for live refresh (routes/criteriaiqWebhook.ts), by
// the nightly refresh's rules. Null when CriteriaIQ isn't the primary source
// or no activity links the project, so a webhook for a project nobody logged
// against costs no CriteriaIQ call. Throws CriteriaIqError on a failed read,
// which leaves the links as they were.
export async function refreshCriteriaIqProject(projectId: number): Promise<'updated' | 'not_found' | null> {
  if (!Number.isInteger(projectId) || projectId <= 0) return null
  const { primary } = await getEvaluationSourceSetting()
  if (primary !== 'criteriaiq') return null
  const id = String(projectId)
  const [linked] = await db.select({ id: activities.id }).from(activities).where(linkedToProject(id)).limit(1)
  if (!linked) return null
  return applyProjectSnapshot(id, await getCriteriaIqProject(projectId))
}

export interface RefreshResult {
  projects: number
  updated: number
  notFound: number
  errors: string[]
  source: 'scheduled' | 'manual'
}

// Nightly refresh of every linked CriteriaIQ project's snapshot, the
// CriteriaIQ counterpart of refresh_opp_snapshots' Evaluation refresh. One
// list call covers most projects; a project missing from the list is read on
// its own, and only a confirmed 404 marks its links disconnected
// (crm_related_deleted), never a failed read. A project found again clears it.
// Returns null without recording a run when CriteriaIQ isn't the primary
// source or nothing links to a CriteriaIQ project, matching every other
// job's "only log real work" rule.
export async function refreshCriteriaIqProjects(opts: { source?: 'scheduled' | 'manual' } = {}): Promise<RefreshResult | null> {
  const { primary } = await getEvaluationSourceSetting()
  if (primary !== 'criteriaiq') return null
  const rows = await db.selectDistinct({ id: activities.crmRelatedId }).from(activities)
    .where(and(eq(activities.crmRelatedType, CRITERIAIQ_RELATED_TYPE), isNotNull(activities.crmRelatedId)))
  const ids = rows.map((r) => r.id).filter((id): id is string => !!id && /^[1-9][0-9]{0,15}$/.test(id))
  if (ids.length === 0) return null

  const startedAt = new Date()
  const result: RefreshResult = { projects: ids.length, updated: 0, notFound: 0, errors: [], source: opts.source ?? 'scheduled' }
  let byId: Map<number, CriteriaIqProject>
  try {
    byId = new Map((await listCriteriaIqProjects({ fresh: true })).map((p) => [p.id, p]))
  } catch (err) {
    const code = err instanceof CriteriaIqError ? err.code : (err instanceof Error ? err.message : String(err))
    result.errors.push(code)
    await writeRun('refresh_criteriaiq_projects', startedAt, 'error', code, result)
    return result
  }

  for (const id of ids) {
    try {
      const project = byId.get(Number(id)) ?? await getCriteriaIqProject(Number(id))
      if (await applyProjectSnapshot(id, project) === 'not_found') result.notFound += 1
      else result.updated += 1
    } catch (err) {
      // One project's failure leaves its links as they were.
      result.errors.push(`${id}: ${err instanceof CriteriaIqError ? err.code : err instanceof Error ? err.message : String(err)}`)
    }
  }

  const message = `${result.updated}/${result.projects} CriteriaIQ projects refreshed, ${result.notFound} not found`
  await writeRun('refresh_criteriaiq_projects', startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}

// Opportunities (by id) that already have a CriteriaIQ project, for Won w/o
// POC with CriteriaIQ as primary: an Opportunity counts when any activity on
// it links a CriteriaIQ project, or when a CriteriaIQ project is on it. A
// project is on an Opportunity by the CRM id CriteriaIQ stores; a project
// without one (or from a CriteriaIQ that predates the ids) is matched on the
// Opportunity name instead. Throws CriteriaIqError when CriteriaIQ can't be
// read, so the dashboard can say so rather than list every Opportunity as
// missing a POC.
export async function opportunitiesWithCriteriaIqProject(opps: Array<{ oppId: string; name: string }>): Promise<Set<string>> {
  const has = new Set<string>()
  if (opps.length === 0) return has
  const linked = await db.selectDistinct({ id: activities.crmWhatId }).from(activities)
    .where(and(
      eq(activities.crmRelatedType, CRITERIAIQ_RELATED_TYPE),
      isNotNull(activities.crmRelatedId),
      sql`${activities.crmWhatId} IN (${sql.join(opps.map((o) => sql`${o.oppId}`), sql`, `)})`,
    ))
  for (const r of linked) if (r.id) has.add(r.id)
  const projects = await listCriteriaIqProjects()
  const ids = new Set(projects.map((p) => p.crmOpportunityId).filter((v): v is string => !!v).map(normalizeCrmId))
  const names = new Set(projects.filter((p) => !p.crmOpportunityId)
    .map((p) => p.opportunityName?.trim().toLowerCase()).filter((n): n is string => !!n))
  for (const o of opps) {
    if (ids.has(normalizeCrmId(o.oppId)) || names.has(o.name.trim().toLowerCase())) has.add(o.oppId)
  }
  return has
}

let stopFn: (() => void) | null = null
export function startCriteriaIqProjectsWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob('refresh_criteriaiq_projects', 24 * 60 * 60 * 1000, async () => {
    await refreshCriteriaIqProjects().catch(() => {})
  }, { firstRunDelayMs: 2 * 60 * 1000 })
}
