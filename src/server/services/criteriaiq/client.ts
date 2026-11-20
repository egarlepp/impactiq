import { assertCriteriaIqUrl } from '../net/ssrfGuard.js'
import { safeFetch } from '../net/safeFetch.js'
import { getCriteriaIqConfig, type CriteriaIqConfig } from './config.js'
import { recordIntegrationCall } from '../health/integrationStatus.js'

// Read-only client for CriteriaIQ's REST API, authenticated with the
// install's CriteriaIQ API key (config.ts). Everything here needs only the
// key's projects:read scope.
//
// Failures throw CriteriaIqError with an i18n key, never CriteriaIQ's own
// response text, so callers can show it as-is and an unreachable or revoked
// CriteriaIQ degrades to a short notice rather than a stack trace.

export type CriteriaIqErrorCode =
  | 'errors.criteriaiq.not_configured'
  | 'errors.criteriaiq.url_blocked'
  | 'errors.criteriaiq.unauthorized'
  | 'errors.criteriaiq.forbidden'
  | 'errors.criteriaiq.unreachable'
  | 'errors.criteriaiq.bad_response'

export class CriteriaIqError extends Error {
  constructor(public readonly code: CriteriaIqErrorCode, public readonly status?: number) {
    super(code)
    this.name = 'CriteriaIqError'
  }
}

// The fields ImpactIQ uses from a CriteriaIQ project. They line up with the
// eval_* fields ImpactIQ reads from a CRM Evaluation object.
export interface CriteriaIqProject {
  id: number
  name: string
  customerName: string | null
  opportunityName: string | null
  status: string | null
  type: string | null
  startDate: string | null
  endDate: string | null
  primaryEngineerName: string | null
  engineerNotes: string | null
  evaluationLink: string | null
  // The CRM records the project is on (CriteriaIQ v0.9+, migration 086 there):
  // an Opportunity / Deal id and an Account / Company id. hasCrmIds is false
  // when the response carried neither field, i.e. a CriteriaIQ that predates
  // them, so callers fall back to matching the Opportunity by name.
  crmOpportunityId: string | null
  crmAccountId: string | null
  hasCrmIds: boolean
  // Success criteria progress: active criteria, and how many of them are met.
  // From the summary API these are CriteriaIQ's own counts (met = status
  // "complete"; cancelled and deferred criteria left out of the total). From
  // the older project list they're counted here. Null when the response
  // carried no criteria.
  criteriaTotal: number | null
  criteriaMet: number | null
  // MAP tasks on the project and how many are done. Only the summary API
  // sends them; null from an older CriteriaIQ.
  mapTasksTotal: number | null
  mapTasksCompleted: number | null
  url: string
}

const TIMEOUT_MS = 10_000
// CriteriaIQ's project list is assembled per request and can be slow on a
// large install; the Evaluation lookup reads it at most this often.
const LIST_CACHE_TTL_MS = 5 * 60_000

async function requireConfig(): Promise<CriteriaIqConfig> {
  const cfg = await getCriteriaIqConfig()
  if (!cfg) throw new CriteriaIqError('errors.criteriaiq.not_configured')
  return cfg
}

type FetchResult = { status: number; body: unknown }

// `probe` lets a 403 through as an answer instead of an error: an older
// CriteriaIQ refuses API keys on paths it doesn't know with a 403.
async function request(cfg: CriteriaIqConfig, path: string, opts: { probe?: boolean } = {}): Promise<FetchResult> {
  let url: URL
  try {
    url = await assertCriteriaIqUrl(`${cfg.baseUrl}${path}`, cfg.allowPrivateNetwork)
  } catch {
    throw new CriteriaIqError('errors.criteriaiq.url_blocked')
  }
  let res: Response
  try {
    // safeFetch re-checks the address at connect time and never follows a
    // redirect, which could lead past the URL check above.
    res = await safeFetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, { allowPrivateNetwork: cfg.allowPrivateNetwork })
  } catch {
    recordIntegrationCall('criteriaiq', false, 'errors.criteriaiq.unreachable')
    throw new CriteriaIqError('errors.criteriaiq.unreachable')
  }
  if (res.status === 401 || (res.status === 403 && !opts.probe)) {
    const key = res.status === 401 ? 'errors.criteriaiq.unauthorized' : 'errors.criteriaiq.forbidden'
    recordIntegrationCall('criteriaiq', false, key)
    throw new CriteriaIqError(key, res.status)
  }
  if (res.status >= 500) recordIntegrationCall('criteriaiq', false, `CriteriaIQ answered ${res.status}`)
  else recordIntegrationCall('criteriaiq', true)
  let body: unknown = null
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    try { body = await res.json() } catch { body = null }
  }
  return { status: res.status, body }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function personName(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null
  const u = v as Record<string, unknown>
  const name = [str(u['firstName']), str(u['lastName'])].filter(Boolean).join(' ')
  return name || str(u['email'])
}

// CriteriaIQ marks a met criterion "complete"; pass / passed / met are kept
// for older data.
const MET_CRITERIA_STATUSES = new Set(['complete', 'pass', 'passed', 'met'])

function criteriaProgress(v: unknown): { total: number | null; met: number | null } {
  if (!Array.isArray(v)) return { total: null, met: null }
  const active = v.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && (c as Record<string, unknown>)['isActive'] !== false)
  const met = active.filter((c) => typeof c['status'] === 'string' && MET_CRITERIA_STATUSES.has(c['status'].toLowerCase())).length
  return { total: active.length, met }
}

// Maps one project from CriteriaIQ's GET /api/projects or /api/projects/:id
// response. Null when the row isn't a recognizable project.
export function toCriteriaIqProject(raw: unknown, baseUrl: string): CriteriaIqProject | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const id = typeof p['id'] === 'number' ? p['id'] : Number(p['id'])
  if (!Number.isInteger(id) || id <= 0) return null
  const criteria = criteriaProgress(p['successCriteria'])
  return {
    id,
    name: str(p['name']) ?? str(p['solutionName']) ?? str(p['customerName']) ?? `#${id}`,
    customerName: str(p['customerName']),
    opportunityName: str(p['opportunityName']),
    status: str(p['status']),
    type: str(p['type']),
    startDate: str(p['startDate']),
    endDate: str(p['endDate']),
    primaryEngineerName: personName(p['primarySe']),
    engineerNotes: str(p['engineerNotes']),
    evaluationLink: str(p['salesforceEvaluationLink']),
    crmOpportunityId: str(p['crmOpportunityId']),
    crmAccountId: str(p['crmAccountId']),
    hasCrmIds: 'crmOpportunityId' in p || 'crmAccountId' in p,
    criteriaTotal: criteria.total,
    criteriaMet: criteria.met,
    mapTasksTotal: null,
    mapTasksCompleted: null,
    url: `${baseUrl}/project/${id}`,
  }
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {}
}

// Maps one project from CriteriaIQ's summary API (GET /api/v1/projects/...,
// ProjectSummaryV1 in CriteriaIQ's docs/features/project-summary-api.md).
// The link is built from the configured URL, never taken from the response.
export function fromCriteriaIqSummary(raw: unknown, baseUrl: string): CriteriaIqProject | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const id = p['id']
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null
  const crm = record(p['crm'])
  const criteria = record(p['criteria'])
  const tasks = record(record(p['map'])['tasks'])
  const team = Array.isArray(p['team']) ? p['team'].map(record) : []
  const primary = team.find((m) => m['role'] === 'primary_engineer')
  const total = count(criteria['total'])
  const excluded = count(criteria['excluded']) ?? 0
  return {
    id,
    name: str(p['name']) ?? str(p['solutionName']) ?? str(p['customerName']) ?? `#${id}`,
    customerName: str(p['customerName']),
    opportunityName: str(p['opportunityName']),
    status: str(p['status']),
    type: str(p['type']),
    startDate: str(p['startDate']),
    endDate: str(p['endDate']),
    primaryEngineerName: primary ? str(primary['name']) ?? str(primary['email']) : null,
    // The summary leaves engineer notes out; ImpactIQ reads them from the CRM.
    engineerNotes: null,
    evaluationLink: str(crm['evaluationLink']),
    crmOpportunityId: str(crm['opportunityId']),
    crmAccountId: str(crm['accountId']),
    hasCrmIds: true,
    criteriaTotal: total === null ? null : Math.max(0, total - excluded),
    criteriaMet: count(criteria['met']),
    mapTasksTotal: count(tasks['total']),
    mapTasksCompleted: count(tasks['completed']),
    url: `${baseUrl}/project/${id}`,
  }
}

function summaryList(body: unknown, baseUrl: string): CriteriaIqProject[] | null {
  const data = record(body)['data']
  if (!Array.isArray(data)) return null
  return data.map((row) => fromCriteriaIqSummary(row, baseUrl)).filter((p): p is CriteriaIqProject => p !== null)
}

// Whether this CriteriaIQ serves the summary API (CriteriaIQ v0.11+). Asked
// once per URL and key: the lookup without a filter answers 400 with a JSON
// message on a CriteriaIQ that has it, and an older one answers 403 or 404.
const SUMMARY_PROBE_TTL_MS = 30 * 60_000
let summaryProbe: { key: string; at: number; supported: boolean } | null = null

async function summaryApiSupported(cfg: CriteriaIqConfig): Promise<boolean> {
  const key = connectionKey(cfg)
  if (summaryProbe && summaryProbe.key === key && Date.now() - summaryProbe.at < SUMMARY_PROBE_TTL_MS) return summaryProbe.supported
  const { status, body } = await request(cfg, '/api/v1/projects/summary', { probe: true })
  const supported = status === 400 && typeof record(body)['message'] === 'string'
  summaryProbe = { key, at: Date.now(), supported }
  return supported
}

// Salesforce ids are 15 characters, case-sensitive, or 18 with a 3-character
// checksum suffix. A CRM record matches a project when its id appears in the
// project's Evaluation link as a whole id, in either form.
export function evaluationLinkMatches(link: string | null, recordId: string): boolean {
  if (!link || !/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(recordId)) return false
  const id15 = recordId.slice(0, 15)
  return new RegExp(`(?<![A-Za-z0-9])${id15}([A-Za-z0-9]{3})?(?![A-Za-z0-9])`).test(link)
}

// A CRM record id in the form two ids are compared in: Salesforce ids are
// cut to their case-sensitive 15-character form (the 18-character form only
// adds a checksum); HubSpot's numeric ids are left as they are.
export function normalizeCrmId(id: string): string {
  const v = id.trim()
  return /^[A-Za-z0-9]{18}$/.test(v) && /[A-Za-z]/.test(v) ? v.slice(0, 15) : v
}

export function crmIdsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizeCrmId(a) === normalizeCrmId(b)
}

// Cheap check that the URL is a CriteriaIQ and the key can read projects.
// Asks for project 0, which never exists: CriteriaIQ answers a valid key with
// a JSON 404, a bad key with 401 and a key without projects:read with 403. A
// 404 that isn't CriteriaIQ's JSON means the URL points somewhere else.
export async function testCriteriaIqConnection(): Promise<void> {
  const cfg = await requireConfig()
  const { status, body } = await request(cfg, '/api/projects/0')
  const isCriteriaIq404 = status === 404 && !!body && typeof body === 'object' && 'message' in body
  if (!isCriteriaIq404 && !(status >= 200 && status < 300)) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
}

export async function getCriteriaIqProject(id: number): Promise<CriteriaIqProject | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const cfg = await requireConfig()
  if (await summaryApiSupported(cfg)) {
    const { status, body } = await request(cfg, `/api/v1/projects/${id}/summary`)
    if (status === 404) return null
    if (status < 200 || status >= 300) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
    const project = fromCriteriaIqSummary(record(body)['data'], cfg.baseUrl)
    if (!project) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
    return project
  }
  const { status, body } = await request(cfg, `/api/projects/${id}`)
  if (status === 404) return null
  if (status < 200 || status >= 300) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
  const project = toCriteriaIqProject(body, cfg.baseUrl)
  if (!project) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
  return project
}

let listCache: { key: string; at: number; projects: CriteriaIqProject[] } | null = null
const filterCache = new Map<string, { at: number; projects: CriteriaIqProject[] }>()

function connectionKey(cfg: CriteriaIqConfig): string {
  return `${cfg.baseUrl}|${cfg.apiKey.slice(-8)}`
}

// The epoch moves on every accepted live refresh webhook (config.ts), so a
// change in CriteriaIQ empties these caches on every replica.
function cacheKey(cfg: CriteriaIqConfig): string {
  return `${connectionKey(cfg)}|${cfg.cacheEpoch}`
}

async function listProjects(cfg: CriteriaIqConfig): Promise<CriteriaIqProject[]> {
  const key = cacheKey(cfg)
  if (listCache && listCache.key === key && Date.now() - listCache.at < LIST_CACHE_TTL_MS) return listCache.projects
  const { status, body } = await request(cfg, '/api/projects')
  if (status < 200 || status >= 300 || !Array.isArray(body)) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
  const projects = body.map((row) => toCriteriaIqProject(row, cfg.baseUrl)).filter((p): p is CriteriaIqProject => p !== null)
  listCache = { key, at: Date.now(), projects }
  return projects
}

export function clearCriteriaIqCache(): void {
  listCache = null
  summaryProbe = null
  filterCache.clear()
}

// True when the cached project list shows this CriteriaIQ doesn't send CRM
// ids at all (a version before they existed), so a filtered request would
// only be ignored and return every project.
function knownWithoutCrmIds(cfg: CriteriaIqConfig): boolean {
  return !!listCache && listCache.key === cacheKey(cfg) && listCache.projects.length > 0
    && !listCache.projects.some((p) => p.hasCrmIds)
}

type CrmIdField = 'crmOpportunityId' | 'crmAccountId'

// Projects on one CRM record, through CriteriaIQ's own filter
// (GET /api/projects?crmOpportunityId= / ?crmAccountId=). Each row is checked
// here too: a CriteriaIQ that doesn't know the filter ignores it and returns
// every project, and none of those carry a matching id.
async function projectsByCrmId(cfg: CriteriaIqConfig, field: CrmIdField, id: string): Promise<CriteriaIqProject[]> {
  if (!id.trim() || knownWithoutCrmIds(cfg)) return []
  const key = `${cacheKey(cfg)}|${field}|${normalizeCrmId(id)}`
  const hit = filterCache.get(key)
  let projects: CriteriaIqProject[]
  if (hit && Date.now() - hit.at < LIST_CACHE_TTL_MS) {
    projects = hit.projects
  } else if (await summaryApiSupported(cfg)) {
    const { status, body } = await request(cfg, `/api/v1/projects/summary?${field}=${encodeURIComponent(id.trim())}`)
    // CriteriaIQ answers 400 for an id it can't parse: no project carries it.
    const list = status === 400 ? [] : summaryList(body, cfg.baseUrl)
    if ((status !== 400 && (status < 200 || status >= 300)) || !list) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
    projects = list
    if (filterCache.size > 500) filterCache.clear()
    filterCache.set(key, { at: Date.now(), projects })
  } else {
    const { status, body } = await request(cfg, `/api/projects?${field}=${encodeURIComponent(id.trim())}`)
    if (status < 200 || status >= 300 || !Array.isArray(body)) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
    projects = body.map((row) => toCriteriaIqProject(row, cfg.baseUrl)).filter((p): p is CriteriaIqProject => p !== null)
    if (filterCache.size > 500) filterCache.clear()
    filterCache.set(key, { at: Date.now(), projects })
  }
  return projects.filter((p) => crmIdsEqual(p[field], id))
}

export interface OpportunityProjects {
  projects: CriteriaIqProject[]
  // 'id' when CriteriaIQ holds the Opportunity's own id on the projects,
  // 'name' when they were matched on the Opportunity name instead.
  matchedBy: 'id' | 'name' | null
}

// The CriteriaIQ projects on an Opportunity / Deal. Matches on the CRM id
// CriteriaIQ stores, and only when none match falls back to the Opportunity
// name, skipping projects CriteriaIQ already ties to a different Opportunity.
// Name matches are suggestions a person confirms, never an automatic link.
export async function findCriteriaIqProjectsForOpportunity(opp: { id: string | null; name: string | null }): Promise<OpportunityProjects> {
  const cfg = await requireConfig()
  if (opp.id) {
    const byId = await projectsByCrmId(cfg, 'crmOpportunityId', opp.id)
    if (byId.length > 0) return { projects: byId, matchedBy: 'id' }
  }
  const wanted = opp.name?.trim().toLowerCase()
  if (!wanted) return { projects: [], matchedBy: null }
  const byName = (await listProjects(cfg)).filter((p) =>
    p.opportunityName?.trim().toLowerCase() === wanted
    && !(opp.id && p.crmOpportunityId && !crmIdsEqual(p.crmOpportunityId, opp.id)))
  return { projects: byName, matchedBy: byName.length > 0 ? 'name' : null }
}

// The CriteriaIQ projects on an Account / Company, by the CRM id CriteriaIQ
// stores. Empty on a CriteriaIQ without CRM ids: names can't tell Accounts
// apart reliably enough to suggest from.
export async function findCriteriaIqProjectsForAccount(accountId: string): Promise<CriteriaIqProject[]> {
  const cfg = await requireConfig()
  return projectsByCrmId(cfg, 'crmAccountId', accountId)
}

// Every project the key can read. `fresh` skips the few-minute cache, for the
// nightly snapshot refresh.
export async function listCriteriaIqProjects(opts: { fresh?: boolean } = {}): Promise<CriteriaIqProject[]> {
  const cfg = await requireConfig()
  if (opts.fresh) listCache = null
  return listProjects(cfg)
}

// The project picker's search (CriteriaIQ as primary): projects whose name,
// customer or Opportunity name contains the text, case ignored. CriteriaIQ's
// API has no search endpoint, so this filters the cached list.
export async function searchCriteriaIqProjects(text: string, limit = 25): Promise<CriteriaIqProject[]> {
  const wanted = text.trim().toLowerCase()
  if (!wanted) return []
  const projects = await listCriteriaIqProjects()
  return projects
    .filter((p) => [p.name, p.customerName, p.opportunityName].some((v) => v?.toLowerCase().includes(wanted)))
    .slice(0, limit)
}

// The CriteriaIQ projects that point at a CRM Evaluation record. Matches on
// the project's Salesforce Evaluation link: through the summary API's
// ?evaluationId= lookup when CriteriaIQ has it, else by filtering the cached
// project list. The result is checked here either way.
export async function findCriteriaIqProjectsByCrmRecord(recordId: string): Promise<CriteriaIqProject[]> {
  const cfg = await requireConfig()
  if (!/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(recordId)) return []
  if (await summaryApiSupported(cfg)) {
    const key = `${cacheKey(cfg)}|evaluationId|${recordId.slice(0, 15)}`
    const hit = filterCache.get(key)
    let projects = hit && Date.now() - hit.at < LIST_CACHE_TTL_MS ? hit.projects : null
    if (!projects) {
      const { status, body } = await request(cfg, `/api/v1/projects/summary?evaluationId=${encodeURIComponent(recordId)}`)
      const list = status === 400 ? [] : summaryList(body, cfg.baseUrl)
      if ((status !== 400 && (status < 200 || status >= 300)) || !list) throw new CriteriaIqError('errors.criteriaiq.bad_response', status)
      projects = list
      if (filterCache.size > 500) filterCache.clear()
      filterCache.set(key, { at: Date.now(), projects })
    }
    return projects.filter((p) => evaluationLinkMatches(p.evaluationLink, recordId))
  }
  const projects = await listProjects(cfg)
  return projects.filter((p) => evaluationLinkMatches(p.evaluationLink, recordId))
}
