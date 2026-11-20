// Activity counts per CriteriaIQ project, for POST /api/v1/effort/project-counts
// (v1.454.0). CriteriaIQ shows them in an Activities column on its project
// table; the contract is in docs/effort-api.md.
//
// An activity counts toward a project when it is submitted, unarchived, on a
// team the key's owner can see, of one of the activity types CriteriaIQ's
// admin chose (matched by name, case-insensitive, since every team has its own
// copy of a type), and linked to the project's record:
//
//   - crm_related_type 'CriteriaIQ' with the CriteriaIQ project id (CriteriaIQ
//     as the Project source), or
//   - crm_related_id equal to the project's CRM record (the Salesforce
//     Evaluation or the HubSpot project object), Salesforce ids matched on
//     their 15-char form.
//
// With opportunityFallback on, an activity of a chosen type that carries no
// Project link at all also counts when it is on the project's Opportunity and
// dated inside the project's start and end dates. That can count one activity
// on two projects that share an Opportunity and overlapping dates; CriteriaIQ
// warns its admin about that before the switch can be turned on.
//
// Totals only, like the effort API: no titles, notes, people or cost.
// listProjectActivities() (POST /api/v1/effort/project-activities, v1.479.0)
// lists the same matches for one project, through the same matchProjects(), so
// the list always agrees with the count. It adds the type, the person who
// logged it, hours and dates; still no titles, notes or cost.
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/index.js'
import { activities, activityTypeTeams, users, teamActivityTypeCrmExtras, teamActivityTypes } from '../../../../drizzle/schema.js'
import { CRITERIAIQ_RELATED_TYPE } from '../../../shared/evaluationSource.js'
import { EFFORT_API_VERSION } from './opportunityEffort.js'

export const MAX_PROJECTS_PER_REQUEST = 200
export const MAX_ACTIVITY_TYPES_PER_REQUEST = 50

const SF_ID_RX = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/
const DIGITS_RX = /^\d+$/
const CRM_ID = z.string().trim().regex(/^[A-Za-z0-9]{1,40}$/)
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)))

export const projectCountsRequestSchema = z.object({
  activityTypes: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_ACTIVITY_TYPES_PER_REQUEST),
  opportunityFallback: z.boolean().default(false),
  projects: z.array(z.object({
    criteriaiqProjectId: z.number().int().positive().max(2_147_483_647),
    crmProjectId: CRM_ID.nullish(),
    crmOpportunityId: CRM_ID.nullish(),
    startDate: DATE.nullish(),
    endDate: DATE.nullish(),
  }).strict()).min(1).max(MAX_PROJECTS_PER_REQUEST),
}).strict()

export type ProjectCountsRequest = z.infer<typeof projectCountsRequestSchema>

export interface ProjectActivityCount {
  criteriaiqProjectId: number
  activityCount: number
  totalHours: number
  lastActivityAt: string | null
  /** How many of activityCount came in only through the Opportunity fallback. */
  viaOpportunity: number
}

export interface ProjectActivityCounts {
  version: typeof EFFORT_API_VERSION
  projects: ProjectActivityCount[]
}

/** A Salesforce id compares on its case-sensitive 15-char form; anything else (HubSpot) exactly. */
export function crmMatchKey(id: string): { sf15: string } | { exact: string } {
  return SF_ID_RX.test(id) && !DIGITS_RX.test(id) ? { sf15: id.slice(0, 15) } : { exact: id }
}

function keyOf(id: string | null): string | null {
  if (!id) return null
  const k = crmMatchKey(id)
  return 'sf15' in k ? `sf:${k.sf15}` : `x:${k.exact}`
}

function collect(ids: Array<string | null | undefined>): { sf15: string[]; exact: string[] } {
  const sf15 = new Set<string>()
  const exact = new Set<string>()
  for (const id of ids) {
    if (!id) continue
    const k = crmMatchKey(id)
    if ('sf15' in k) sf15.add(k.sf15)
    else exact.add(k.exact)
  }
  return { sf15: [...sf15], exact: [...exact] }
}

function idMatch(column: typeof activities.crmRelatedId | typeof activities.crmWhatId, ids: { sf15: string[]; exact: string[] }): SQL | null {
  const parts: SQL[] = []
  if (ids.sf15.length > 0) parts.push(inArray(sql`left(${column}, 15)`, ids.sf15))
  if (ids.exact.length > 0) parts.push(inArray(column, ids.exact))
  if (parts.length === 0) return null
  return parts.length === 1 ? parts[0]! : or(...parts)!
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10)
}

interface CandidateRow {
  id: string
  typeName: string
  typeIcon: string | null
  typeColor: string | null
  ownerName: string
  end: Date | string
  relatedType: string | null
  relatedId: string | null
  whatType: string | null
  whatId: string | null
  start: Date | string
  hours: string
}

type ProjectRef = ProjectCountsRequest['projects'][number]

interface ProjectMatch { row: CandidateRow; start: Date; viaOpportunity: boolean }

/**
 * Every activity that counts toward each project, keyed by CriteriaIQ project
 * id. Shared by the counts and the per-project list so they never disagree.
 */
async function matchProjects(
  activityTypes: string[],
  opportunityFallback: boolean,
  projects: ProjectRef[],
  teamIds: string[],
): Promise<Map<number, ProjectMatch[]>> {
  const out = new Map<number, ProjectMatch[]>(projects.map((p) => [p.criteriaiqProjectId, []]))
  if (teamIds.length === 0 || projects.length === 0) return out

  const typeNames = [...new Set(activityTypes.map((n) => n.toLowerCase()))]
  const ciqIds = projects.map((p) => String(p.criteriaiqProjectId))
  const crmProjects = collect(projects.map((p) => p.crmProjectId))
  const fallbackProjects = opportunityFallback ? projects.filter((p) => p.crmOpportunityId && p.startDate && p.endDate) : []
  const opps = collect(fallbackProjects.map((p) => p.crmOpportunityId))

  const links: SQL[] = [and(eq(activities.crmRelatedType, CRITERIAIQ_RELATED_TYPE), inArray(activities.crmRelatedId, ciqIds))!]
  const crmLink = idMatch(activities.crmRelatedId, crmProjects)
  if (crmLink) links.push(and(sql`coalesce(${activities.crmRelatedType}, '') <> ${CRITERIAIQ_RELATED_TYPE}`, crmLink)!)
  const oppLink = idMatch(activities.crmWhatId, opps)
  if (oppLink) links.push(and(isNull(activities.crmRelatedId), eq(activities.crmWhatType, 'Opportunity'), oppLink)!)

  const rows: CandidateRow[] = await db.select({
    id: activities.id,
    typeName: teamActivityTypes.name,
    typeIcon: teamActivityTypes.icon,
    typeColor: teamActivityTypes.color,
    ownerName: users.displayName,
    relatedType: activities.crmRelatedType,
    relatedId: activities.crmRelatedId,
    whatType: activities.crmWhatType,
    whatId: activities.crmWhatId,
    start: activities.startDatetime,
    end: activities.endDatetime,
    hours: activities.effortHours,
  }).from(activities)
    .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .innerJoin(users, eq(users.id, activities.userId))
    .where(and(
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      inArray(activities.teamId, teamIds),
      inArray(sql`lower(${teamActivityTypes.name})`, typeNames),
      or(...links),
    ))

  // Index the projects by every way an activity can point at them.
  const byCiq = new Map<string, number[]>()
  const byCrm = new Map<string, number[]>()
  const byOpp = new Map<string, Array<{ id: number; start: string; end: string }>>()
  const push = <T>(m: Map<string, T[]>, k: string | null, v: T) => { if (k) m.set(k, [...(m.get(k) ?? []), v]) }
  for (const p of projects) {
    push(byCiq, String(p.criteriaiqProjectId), p.criteriaiqProjectId)
    push(byCrm, keyOf(p.crmProjectId ?? null), p.criteriaiqProjectId)
  }
  for (const p of fallbackProjects) push(byOpp, keyOf(p.crmOpportunityId ?? null), { id: p.criteriaiqProjectId, start: p.startDate!, end: p.endDate! })

  const add = (projectId: number, row: CandidateRow, start: Date, viaOpportunity: boolean) => {
    out.get(projectId)?.push({ row, start, viaOpportunity })
  }
  for (const row of rows) {
    const start = row.start instanceof Date ? row.start : new Date(row.start)
    if (row.relatedId) {
      const targets = row.relatedType === CRITERIAIQ_RELATED_TYPE ? byCiq.get(row.relatedId) : byCrm.get(keyOf(row.relatedId) ?? '')
      for (const id of new Set(targets ?? [])) add(id, row, start, false)
      continue
    }
    if (row.whatType !== 'Opportunity') continue
    const day = dayOf(start)
    for (const p of byOpp.get(keyOf(row.whatId) ?? '') ?? []) {
      if (day >= p.start && day <= p.end) add(p.id, row, start, true)
    }
  }
  return out
}

export async function getProjectActivityCounts(input: ProjectCountsRequest, teamIds: string[]): Promise<ProjectActivityCounts> {
  // A project listed twice is answered once.
  const projects = [...new Map(input.projects.map((p) => [p.criteriaiqProjectId, p])).values()]
  const matches = await matchProjects(input.activityTypes, input.opportunityFallback, projects, teamIds)
  return {
    version: EFFORT_API_VERSION,
    projects: projects.map((p) => {
      const t: ProjectActivityCount = { criteriaiqProjectId: p.criteriaiqProjectId, activityCount: 0, totalHours: 0, lastActivityAt: null, viaOpportunity: 0 }
      for (const m of matches.get(p.criteriaiqProjectId) ?? []) {
        t.activityCount += 1
        t.totalHours = round2(t.totalHours + Number(m.row.hours))
        if (m.viaOpportunity) t.viaOpportunity += 1
        const iso = m.start.toISOString()
        if (!t.lastActivityAt || iso > t.lastActivityAt) t.lastActivityAt = iso
      }
      return t
    }),
  }
}

export const MAX_PROJECT_ACTIVITIES = 500

export const projectActivitiesRequestSchema = z.object({
  activityTypes: projectCountsRequestSchema.shape.activityTypes,
  opportunityFallback: z.boolean().default(false),
  project: projectCountsRequestSchema.shape.projects.element,
}).strict()

export type ProjectActivitiesRequest = z.infer<typeof projectActivitiesRequestSchema>

export interface ProjectActivityItem {
  id: string
  type: string
  /** The activity type's lucide icon name and hex color, as set in Admin → Activity Types (null when unset). */
  typeIcon: string | null
  typeColor: string | null
  ownerName: string
  hours: number
  startAt: string
  endAt: string | null
  /** Counted only through the Opportunity fallback. */
  viaOpportunity: boolean
}

export interface ProjectActivityList {
  version: typeof EFFORT_API_VERSION
  criteriaiqProjectId: number
  activityCount: number
  totalHours: number
  /** True when activityCount is above MAX_PROJECT_ACTIVITIES and only the newest are listed. */
  truncated: boolean
  activities: ProjectActivityItem[]
}

/** The activities behind one project's count, newest first, at most MAX_PROJECT_ACTIVITIES. */
export async function listProjectActivities(input: ProjectActivitiesRequest, teamIds: string[]): Promise<ProjectActivityList> {
  const id = input.project.criteriaiqProjectId
  const matches = (await matchProjects(input.activityTypes, input.opportunityFallback, [input.project], teamIds)).get(id) ?? []
  matches.sort((a, b) => b.start.getTime() - a.start.getTime() || (a.row.id < b.row.id ? -1 : 1))
  let totalHours = 0
  for (const m of matches) totalHours = round2(totalHours + Number(m.row.hours))
  return {
    version: EFFORT_API_VERSION,
    criteriaiqProjectId: id,
    activityCount: matches.length,
    totalHours,
    truncated: matches.length > MAX_PROJECT_ACTIVITIES,
    activities: matches.slice(0, MAX_PROJECT_ACTIVITIES).map((m) => {
      const end = m.row.end instanceof Date ? m.row.end : m.row.end ? new Date(m.row.end) : null
      return {
        id: m.row.id,
        type: m.row.typeName.trim(),
        typeIcon: m.row.typeIcon || null,
        typeColor: m.row.typeColor || null,
        ownerName: m.row.ownerName,
        hours: round2(Number(m.row.hours)),
        startAt: m.start.toISOString(),
        endAt: end ? end.toISOString() : null,
        viaOpportunity: m.viaOpportunity,
      }
    }),
  }
}

export interface ActivityTypeOption {
  name: string
  /** Whether this type has a Project (related record) picker on at least one of the owner's teams. */
  hasProjectPicker: boolean
}

/** Active activity type names the owner's teams use, one row per name. */
export async function listActivityTypeOptions(teamIds: string[]): Promise<ActivityTypeOption[]> {
  if (teamIds.length === 0) return []
  const rows = await db.select({
    name: teamActivityTypes.name,
    pickers: sql<string>`count(${teamActivityTypeCrmExtras.id})`,
  }).from(teamActivityTypes)
    .leftJoin(teamActivityTypeCrmExtras, and(
      eq(teamActivityTypeCrmExtras.teamActivityTypeId, teamActivityTypes.id),
      eq(teamActivityTypeCrmExtras.kind, 'related_object_picker'),
    ))
    .where(and(
      eq(teamActivityTypes.isActive, true),
      // Owned by one of the teams, or assigned to one through the junction table.
      or(
        inArray(teamActivityTypes.teamId, teamIds),
        inArray(teamActivityTypes.id, db.select({ id: activityTypeTeams.activityTypeId }).from(activityTypeTeams).where(inArray(activityTypeTeams.teamId, teamIds))),
      ),
    ))
    .groupBy(teamActivityTypes.name)

  const byName = new Map<string, ActivityTypeOption>()
  for (const r of rows) {
    const key = r.name.trim().toLowerCase()
    const prev = byName.get(key)
    const hasPicker = Number(r.pickers) > 0
    byName.set(key, { name: prev?.name ?? r.name.trim(), hasProjectPicker: (prev?.hasProjectPicker ?? false) || hasPicker })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
