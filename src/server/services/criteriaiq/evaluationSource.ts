import { eq, isNotNull, sql } from 'drizzle-orm'
import type { RequestHandler } from 'express'
import { db } from '../../db/index.js'
import { activities, systemSettings } from '../../../../drizzle/schema.js'
import {
  crmProjectsActive,
  evaluationSourceChangeAllowed,
  normalizeEvaluationSourceSetting,
  projectsEnabled,
  secondaryAllowed,
  type EvaluationSourceId,
  type EvaluationSourceSetting,
} from '../../../shared/evaluationSource.js'
import { isCriteriaIqConfigured } from './config.js'
import { availableEvaluationSources, criteriaIqSecondaryAvailable } from './availability.js'

// The install-wide evaluation_source setting (src/shared/evaluationSource.ts).
// Cached briefly like crm_provider: a write from this process clears it, a
// restore or another instance's write is picked up within the TTL.
const KEY = 'evaluation_source'
const CACHE_TTL_MS = 30_000
let cache: { value: EvaluationSourceSetting; at: number } | null = null

export async function getEvaluationSourceSetting(): Promise<EvaluationSourceSetting> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1)
    const value = normalizeEvaluationSourceSetting(row?.value)
    cache = { value, at: Date.now() }
    return value
  } catch {
    // A settings read failure must never turn Project features off.
    return normalizeEvaluationSourceSetting(null)
  }
}

async function writeEvaluationSourceSetting(value: EvaluationSourceSetting): Promise<EvaluationSourceSetting> {
  await db.insert(systemSettings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } })
  cache = { value, at: Date.now() }
  return value
}

export function clearEvaluationSourceCache(): void {
  cache = null
}

// Project links: activities whose Related record is set. Those ids belong to
// whichever source made them, so they pin the primary source.
export async function countProjectLinks(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(activities).where(isNotNull(activities.crmRelatedId))
  // count(*) is bigint, which the postgres driver returns as a string.
  return Number(r?.n ?? 0)
}

export interface EvaluationSourceState extends EvaluationSourceSetting {
  available: EvaluationSourceId[]
  secondaryAvailable: boolean
  criteriaiqConfigured: boolean
  projectLinks: number
  locked: boolean
}

export async function getEvaluationSourceState(): Promise<EvaluationSourceState> {
  const [setting, projectLinks, criteriaiqConfigured] = await Promise.all([
    getEvaluationSourceSetting(), countProjectLinks(), isCriteriaIqConfigured(),
  ])
  return {
    ...setting,
    available: availableEvaluationSources(),
    secondaryAvailable: criteriaIqSecondaryAvailable(),
    criteriaiqConfigured,
    projectLinks,
    locked: projectLinks > 0,
  }
}

export type EvaluationSourceError =
  | 'errors.evaluation_source.not_available'
  | 'errors.evaluation_source.locked'
  | 'errors.evaluation_source.secondary_needs_crm'
  | 'errors.criteriaiq.not_configured'

export type ChangeEvaluationSourceResult =
  | { ok: true; before: EvaluationSourceSetting; after: EvaluationSourceSetting }
  | { ok: false; status: 400 | 409; error: EvaluationSourceError }

export async function changeEvaluationSource(patch: { primary?: EvaluationSourceId; criteriaiqSecondary?: boolean }): Promise<ChangeEvaluationSourceResult> {
  const before = await getEvaluationSourceSetting()
  const primary = patch.primary ?? before.primary
  const secondary = patch.criteriaiqSecondary ?? (secondaryAllowed(primary) && before.criteriaiqSecondary)

  if (primary !== before.primary) {
    if (!availableEvaluationSources().includes(primary)) return { ok: false, status: 400, error: 'errors.evaluation_source.not_available' }
    const linked = (await countProjectLinks()) > 0
    if (!evaluationSourceChangeAllowed(before, primary, linked)) return { ok: false, status: 409, error: 'errors.evaluation_source.locked' }
  }
  if (secondary && !before.criteriaiqSecondary) {
    if (!criteriaIqSecondaryAvailable()) return { ok: false, status: 400, error: 'errors.evaluation_source.not_available' }
    if (!secondaryAllowed(primary)) return { ok: false, status: 400, error: 'errors.evaluation_source.secondary_needs_crm' }
  }
  if ((primary === 'criteriaiq' || secondary) && !(await isCriteriaIqConfigured())) {
    return { ok: false, status: 400, error: 'errors.criteriaiq.not_configured' }
  }

  // With no Project links yet, the links' source follows the new primary;
  // with links, it stays (the only allowed moves keep it valid).
  const dataSource = primary !== before.primary && primary !== 'off' && (await countProjectLinks()) === 0
    ? primary
    : before.dataSource
  const after = await writeEvaluationSourceSetting({
    primary, dataSource, criteriaiqSecondary: secondaryAllowed(primary) && secondary,
  })
  return { ok: true, before, after }
}

// Whether Project features are on (primary is not 'off'). Reads the cached
// setting, so it's cheap enough for every request that needs it.
export async function areProjectsOn(): Promise<boolean> {
  return projectsEnabled((await getEvaluationSourceSetting()).primary)
}

// Guards Project-only routes (the Project picker's search, Evaluation reads
// and edits, Engineer Notes, the two Project dashboards). Hiding the screens
// is never the only guard: with Projects off these answer 409.
export function requireProjectsOn(): RequestHandler {
  return async (_req, res, next) => {
    if (await areProjectsOn()) { next(); return }
    res.status(409).json({ data: null, error: 'errors.evaluation_source.projects_off', meta: {} })
  }
}

// Guards the routes that read or write the CRM's own Evaluation object
// (Salesforce's Evaluation picker, editor and Engineer Notes posting). With
// Projects off they answer like requireProjectsOn; with CriteriaIQ as the
// primary source they answer 409 too, since there is no CRM Evaluation to
// read or write.
export function requireCrmProjects(): RequestHandler {
  return async (_req, res, next) => {
    const { primary } = await getEvaluationSourceSetting()
    if (crmProjectsActive(primary)) { next(); return }
    const error = projectsEnabled(primary) ? 'errors.evaluation_source.not_crm' : 'errors.evaluation_source.projects_off'
    res.status(409).json({ data: null, error, meta: {} })
  }
}
