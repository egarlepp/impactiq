import { Router } from 'express'
import { db } from '../../db/index.js'
import { teams, crmFieldMappings, crmFieldMappingTeams, users } from '../../../../drizzle/schema.js'
import { and, eq, inArray, or } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { z } from 'zod'
import { renameLegacyKeys, LEGACY_FIELD_MAPPING_KEYS } from '../../../shared/legacyKeys.js'
import { validateTeamMappings, sampleObjectRecord } from '../../services/salesforce/mappingValidation.js'
import { logSafe } from '../../lib/logSafe.js'

export const fieldMappingsRoutes = Router()

// --- SF Field Mappings ---
async function loadMappingsForTeams(teamIds: string[]) {
  if (teamIds.length === 0) return []
  const rows = await db
    .select({ m: crmFieldMappings, teamId: crmFieldMappingTeams.teamId })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(inArray(crmFieldMappingTeams.teamId, teamIds))
  const byId = new Map<string, typeof crmFieldMappings.$inferSelect & { teamIds: string[] }>()
  for (const row of rows) {
    const existing = byId.get(row.m.id)
    if (existing) {
      existing.teamIds.push(row.teamId)
    } else {
      byId.set(row.m.id, { ...row.m, teamIds: [row.teamId] })
    }
  }
  return Array.from(byId.values())
}

fieldMappingsRoutes.get('/teams/:teamId/sf-field-mappings', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const result = await loadMappingsForTeams([teamId])
  res.json({ data: result, error: null, meta: {} })
})

fieldMappingsRoutes.get('/sf-field-mappings', requireAppAdmin, async (_req, res) => {
  const allMappings = await db.select().from(crmFieldMappings)
  const allTeamLinks = await db.select().from(crmFieldMappingTeams)
  const teamsByMapping = new Map<string, string[]>()
  for (const link of allTeamLinks) {
    ;(teamsByMapping.get(link.crmFieldMappingId) ?? teamsByMapping.set(link.crmFieldMappingId, []).get(link.crmFieldMappingId)!).push(link.teamId)
  }
  const result = allMappings.map((m) => ({ ...m, teamIds: teamsByMapping.get(m.id) ?? [] }))
  res.json({ data: result, error: null, meta: {} })
})

fieldMappingsRoutes.patch('/teams/:teamId/sf-field-mappings/:mappingId', requireAppAdmin, async (req, res) => {
  const { teamId, mappingId } = req.params as { teamId: string; mappingId: string }
  const user = req.user!
  // Security fix (F-03, pentest 2026-09): verify the mapping is actually
  // visible from :teamId before mutating it — a mapping's "home" team_id is
  // just where it was created; real team assignment (and thus who may
  // legitimately manage it) lives in the crm_field_mapping_teams junction
  // (CLAUDE.md §9 v1.298), so both are checked here rather than team_id
  // alone, which would 404 a mapping validly multi-assigned to this team.
  const [owned] = await db.select({ id: crmFieldMappings.id }).from(crmFieldMappings)
    .leftJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(eq(crmFieldMappings.id, mappingId), or(eq(crmFieldMappings.teamId, teamId), eq(crmFieldMappingTeams.teamId, teamId))))
    .limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const schema = z.object({
    appField: z.string().min(1).optional(),
    crmFieldApi: z.string().min(1).optional(),
    crmObject: z.string().min(1).max(80).optional(),
    direction: z.enum(['read', 'write', 'read_write']).optional(),
    referenceTo: z.string().max(80).nullable().optional(),
    constantValue: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
    backgroundRefresh: z.boolean().optional(),
    refreshOnlyForReports: z.boolean().optional(),
    teamIds: z.array(z.string().uuid()).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamIds, ...mappingPatch } = parsed.data
  const [before] = await db.select().from(crmFieldMappings).where(eq(crmFieldMappings.id, mappingId))
  if (Object.keys(mappingPatch).length > 0) {
    await db.update(crmFieldMappings).set({ ...mappingPatch, updatedBy: user.id, updatedAt: new Date() }).where(eq(crmFieldMappings.id, mappingId))
  }
  if (teamIds) {
    await db.delete(crmFieldMappingTeams).where(eq(crmFieldMappingTeams.crmFieldMappingId, mappingId))
    if (teamIds.length > 0) {
      await db.insert(crmFieldMappingTeams).values(teamIds.map((tid) => ({ crmFieldMappingId: mappingId, teamId: tid })))
    }
  }
  const [updated] = await db.select().from(crmFieldMappings).where(eq(crmFieldMappings.id, mappingId))
  const links = await db.select({ teamId: crmFieldMappingTeams.teamId }).from(crmFieldMappingTeams).where(eq(crmFieldMappingTeams.crmFieldMappingId, mappingId))
  // v1.289.0: security audit finding E1 — a bad field mapping can silently
  // misdirect or blank a Salesforce write with no sync-time error, so
  // "who changed what, from what" matters more here than on most config.
  await logAudit(req, { action: 'sf_field_mapping.update', targetType: 'sf_field_mapping', targetId: mappingId, meta: { before, after: updated, teamIds: links.map((l) => l.teamId) } })
  res.json({ data: { ...updated, teamIds: links.map((l) => l.teamId) }, error: null, meta: {} })
})

fieldMappingsRoutes.post('/teams/:teamId/sf-field-mappings', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const user = req.user!
  const schema = z.object({
    appField: z.string().min(1),
    crmFieldApi: z.string().min(1),
    crmObject: z.string().min(1).max(80),
    direction: z.enum(['read', 'write', 'read_write']).default('read_write'),
    referenceTo: z.string().max(80).nullable().optional(),
    constantValue: z.string().nullable().optional(),
    backgroundRefresh: z.boolean().optional(),
    refreshOnlyForReports: z.boolean().optional(),
    teamIds: z.array(z.string().uuid()).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamIds, ...mappingData } = parsed.data
  try {
    const [inserted] = await db.insert(crmFieldMappings).values({ teamId, ...mappingData, isActive: true, updatedBy: user.id, updatedAt: new Date() }).returning()
    if (!inserted) { res.status(500).json({ data: null, error: 'errors.database.insert_failed', meta: {} }); return }
    const assignments = (teamIds && teamIds.length > 0) ? teamIds : [teamId]
    await db.insert(crmFieldMappingTeams).values(assignments.map((tid) => ({ crmFieldMappingId: inserted.id, teamId: tid }))).onConflictDoNothing()
    await logAudit(req, { action: 'sf_field_mapping.create', targetType: 'sf_field_mapping', targetId: inserted.id, meta: { ...inserted, teamIds: assignments } })
    res.status(201).json({ data: { ...inserted, teamIds: assignments }, error: null, meta: {} })
  } catch (err) {
    const dbErr = err as { message?: string; cause?: { message?: string; detail?: string; hint?: string } }
    const cause = dbErr.cause
    const summary = [cause?.message, cause?.detail, cause?.hint].filter(Boolean).join(' | ') || dbErr.message || String(err)
    console.error('[/api/admin/teams/:teamId/sf-field-mappings POST] insert failed:', summary, dbErr.cause ?? '')
    res.status(500).json({ data: null, error: `sf field mapping insert failed: ${summary}`, meta: {} })
  }
})

// POST /api/admin/teams/:teamId/sf-field-mappings/validate
// Pre-flight check + dry run. Read-only in every sense — no SF writes, no DB
// writes. Answers 200 even when Salesforce is unreachable, degrading to the
// static checks, because a page whose job is telling admins what's broken
// shouldn't itself go blank when the integration is the broken thing.
fieldMappingsRoutes.post('/teams/:teamId/sf-field-mappings/validate', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  try {
    // HubSpot mappings are checked against the portal's properties
    // (services/hubspot/mappingValidation.ts), Salesforce mappings against the
    // org. The page can check either CRM's mappings (body.crm, from its CRM
    // toggle); without one, the active CRM's.
    const body = (req.body ?? {}) as { crm?: unknown }
    const { getCrmProviderId } = await import('../../services/crm/providerSetting.js')
    const crm = body.crm === 'hubspot' || body.crm === 'salesforce' ? body.crm : await getCrmProviderId()
    const result = crm === 'hubspot'
      ? await (await import('../../services/hubspot/mappingValidation.js')).validateHubspotTeamMappings(teamId)
      : await validateTeamMappings(teamId)
    res.json({ data: result, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/admin/teams/:teamId/sf-field-mappings/validate] failed:', message)
    res.status(500).json({ data: null, error: 'errors.sf_mappings.validate_failed', meta: {} })
  }
})

// GET /api/admin/teams/:teamId/sf-field-mappings/sample?sobject=
// On-demand "show me one real record" — deliberately separate from Run
// Check above (which stays static + describe only) so this live SOQL query
// only ever fires when an admin explicitly clicks it, not on every check.
// Answers "what does this actually look like" for any object, including
// ones the dry-run payload preview can't build a payload for at all
// (Opportunity, Evaluations__c, and any read-only-mapped object like the
// Ticket picker's object) — see CLAUDE.md §9.
fieldMappingsRoutes.get('/teams/:teamId/sf-field-mappings/sample', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const sobject = req.query['sobject']
  if (typeof sobject !== 'string' || !sobject) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }
  try {
    const { isHubspotMappingTarget } = await import('../../../shared/hubspot.js')
    const result = isHubspotMappingTarget(sobject)
      ? await (await import('../../services/hubspot/mappingValidation.js')).sampleHubspotRecord(teamId, sobject)
      : await sampleObjectRecord(teamId, sobject)
    res.json({ data: result, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/admin/teams/:teamId/sf-field-mappings/sample] failed:', logSafe(message))
    res.status(500).json({ data: null, error: 'errors.sf_mappings.sample_failed', meta: {} })
  }
})

fieldMappingsRoutes.delete('/teams/:teamId/sf-field-mappings/:mappingId', requireAppAdmin, async (req, res) => {
  const { teamId, mappingId } = req.params as { teamId: string; mappingId: string }
  // Security fix (F-03, pentest 2026-09): see the PATCH handler above.
  const [owned] = await db.select({ id: crmFieldMappings.id }).from(crmFieldMappings)
    .leftJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(eq(crmFieldMappings.id, mappingId), or(eq(crmFieldMappings.teamId, teamId), eq(crmFieldMappingTeams.teamId, teamId))))
    .limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [before] = await db.select().from(crmFieldMappings).where(eq(crmFieldMappings.id, mappingId))
  await db.delete(crmFieldMappings).where(eq(crmFieldMappings.id, mappingId))
  if (before) await logAudit(req, { action: 'sf_field_mapping.delete', targetType: 'sf_field_mapping', targetId: mappingId, meta: { deleted: before } })
  res.json({ data: { id: mappingId }, error: null, meta: {} })
})

// --- SF Field Mappings: Export / Import (v1.299.0) ---
// A bad mapping never errors at save time and most mistakes don't error at
// sync time either (§9's Validate & Dry Run exists for exactly that reason).
// Export/Import exists for a different problem: reproducing a team's EXACT
// mapping configuration — every checkbox, R/W direction, constant value, and
// team assignment — elsewhere, without hand-re-entering 20+ rows or baking
// one team's org-specific field names into the seed every install gets.
//
// Team assignment is exported as portable slugs (`teamSlugs`), never raw
// UUIDs — a different install has different team ids for "the same" team.
// `updatedByEmail` captures who last configured each row (the export's
// provenance / "linkage to Users" — who set this up and can answer for it),
// independent of whichever admin happens to run the export/import.
interface SfFieldMappingExportRow {
  appField: string
  crmFieldApi: string
  crmObject: string
  direction: 'read' | 'write' | 'read_write'
  referenceTo: string | null
  isActive: boolean
  constantValue: string | null
  backgroundRefresh: boolean
  refreshOnlyForReports: boolean
  teamSlugs: string[]
  updatedByEmail: string | null
  updatedAt: string | null
}
interface SfFieldMappingExportDocument {
  formatVersion: 1
  exportedAt: string
  exportedByEmail: string | null
  sourceTeamSlug: string
  sourceTeamName: string
  mappings: SfFieldMappingExportRow[]
}

const SfFieldMappingImportRowSchema = z.preprocess((v) => renameLegacyKeys(v, LEGACY_FIELD_MAPPING_KEYS), z.object({
  appField: z.string().min(1),
  crmFieldApi: z.string().min(1),
  crmObject: z.string().min(1).max(80),
  direction: z.enum(['read', 'write', 'read_write']),
  referenceTo: z.string().max(80).nullable().optional(),
  isActive: z.boolean(),
  constantValue: z.string().nullable().optional(),
  backgroundRefresh: z.boolean().optional(),
  refreshOnlyForReports: z.boolean().optional(),
  teamSlugs: z.array(z.string()).optional(),
  updatedByEmail: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
}))
const SfFieldMappingImportDocumentSchema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  exportedByEmail: z.string().nullable().optional(),
  sourceTeamSlug: z.string().optional(),
  sourceTeamName: z.string().optional(),
  mappings: z.array(SfFieldMappingImportRowSchema).max(2000),
})

// GET /api/admin/teams/:teamId/sf-field-mappings/export
// Read-only. Every mapping currently assigned to this team, in full detail.
fieldMappingsRoutes.get('/teams/:teamId/sf-field-mappings/export', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const user = req.user!
  const [team] = await db.select({ name: teams.name, slug: teams.slug }).from(teams).where(eq(teams.id, teamId)).limit(1)
  if (!team) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const mappings = await loadMappingsForTeams([teamId])

  // Resolve every distinct team a mapping is ALSO assigned to (beyond this
  // one), and every distinct updatedBy user, in one batched pass rather
  // than N+1 per-mapping queries.
  const allTeamIds = Array.from(new Set(mappings.flatMap((m) => m.teamIds)))
  const teamRows = allTeamIds.length > 0
    ? await db.select({ id: teams.id, slug: teams.slug }).from(teams).where(inArray(teams.id, allTeamIds))
    : []
  const slugByTeamId = new Map(teamRows.map((t) => [t.id, t.slug]))
  const updaterIds = Array.from(new Set(mappings.map((m) => m.updatedBy).filter((v): v is string => !!v)))
  const userRows = updaterIds.length > 0
    ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, updaterIds))
    : []
  const emailByUserId = new Map(userRows.map((u) => [u.id, u.email]))

  const doc: SfFieldMappingExportDocument = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedByEmail: user.email ?? null,
    sourceTeamSlug: team.slug,
    sourceTeamName: team.name,
    mappings: mappings.map((m) => ({
      appField: m.appField,
      crmFieldApi: m.crmFieldApi,
      crmObject: m.crmObject,
      direction: m.direction as 'read' | 'write' | 'read_write',
      referenceTo: m.referenceTo,
      isActive: m.isActive,
      constantValue: m.constantValue,
      backgroundRefresh: m.backgroundRefresh,
      refreshOnlyForReports: m.refreshOnlyForReports,
      teamSlugs: m.teamIds.map((tid) => slugByTeamId.get(tid)).filter((v): v is string => !!v),
      updatedByEmail: m.updatedBy ? (emailByUserId.get(m.updatedBy) ?? null) : null,
      updatedAt: m.updatedAt ? m.updatedAt.toISOString() : null,
    })),
  }
  res.json({ data: doc, error: null, meta: { count: doc.mappings.length } })
})

interface SfFieldMappingImportDiffRow {
  appField: string
  crmObject: string
  changes?: Array<{ field: string; from: unknown; to: unknown }>
  unresolvedTeamSlugs?: string[]
}
async function diffSfFieldMappingImport(teamId: string, doc: z.infer<typeof SfFieldMappingImportDocumentSchema>) {
  const current = await loadMappingsForTeams([teamId])
  const currentByKey = new Map(current.map((m) => [`${m.appField} ${m.crmObject}`, m]))
  const seenKeys = new Set<string>()

  // Resolve every team slug referenced anywhere in the file up front so
  // toCreate/toUpdate rows can report which ones didn't resolve in THIS
  // install — a slug from the exporting install that doesn't exist here
  // (different team names/slugs) is reported, never silently dropped or
  // treated as fatal, since the row still imports (always at least into
  // the target team).
  const allSlugs = Array.from(new Set(doc.mappings.flatMap((m) => m.teamSlugs ?? [])))
  const slugRows = allSlugs.length > 0 ? await db.select({ id: teams.id, slug: teams.slug }).from(teams).where(inArray(teams.slug, allSlugs)) : []
  const teamIdBySlug = new Map(slugRows.map((t) => [t.slug, t.id]))

  const toCreate: SfFieldMappingImportDiffRow[] = []
  const toUpdate: SfFieldMappingImportDiffRow[] = []
  const unchanged: SfFieldMappingImportDiffRow[] = []

  for (const row of doc.mappings) {
    const key = `${row.appField} ${row.crmObject}`
    seenKeys.add(key)
    const unresolvedTeamSlugs = (row.teamSlugs ?? []).filter((s) => !teamIdBySlug.has(s))
    const existing = currentByKey.get(key)
    if (!existing) {
      toCreate.push({ appField: row.appField, crmObject: row.crmObject, ...(unresolvedTeamSlugs.length > 0 ? { unresolvedTeamSlugs } : {}) })
      continue
    }
    const existingSlugs = new Set(existing.teamIds.map((tid) => slugRows.find((t) => t.id === tid)?.slug).filter((v): v is string => !!v))
    const importSlugs = new Set(row.teamSlugs ?? [])
    const teamAssignmentChanged = Array.from(importSlugs).some((s) => !existingSlugs.has(s))
    const changes: Array<{ field: string; from: unknown; to: unknown }> = []
    const fieldPairs: Array<[string, unknown, unknown]> = [
      ['crmFieldApi', existing.crmFieldApi, row.crmFieldApi],
      ['direction', existing.direction, row.direction],
      ['referenceTo', existing.referenceTo ?? null, row.referenceTo ?? null],
      ['isActive', existing.isActive, row.isActive],
      ['constantValue', existing.constantValue ?? null, row.constantValue ?? null],
      ['backgroundRefresh', !!existing.backgroundRefresh, !!row.backgroundRefresh],
      ['refreshOnlyForReports', !!existing.refreshOnlyForReports, !!row.refreshOnlyForReports],
    ]
    for (const [field, from, to] of fieldPairs) {
      if (from !== to) changes.push({ field, from, to })
    }
    if (teamAssignmentChanged) changes.push({ field: 'teamSlugs (additions only on apply)', from: Array.from(existingSlugs), to: Array.from(importSlugs) })
    if (changes.length > 0) {
      toUpdate.push({ appField: row.appField, crmObject: row.crmObject, changes, ...(unresolvedTeamSlugs.length > 0 ? { unresolvedTeamSlugs } : {}) })
    } else {
      unchanged.push({ appField: row.appField, crmObject: row.crmObject })
    }
  }

  // Rows the target team currently has but the import file doesn't mention
  // at all — informational only. Import never deletes; an admin who wants
  // these gone removes them by hand.
  const notInFile = current
    .filter((m) => !seenKeys.has(`${m.appField} ${m.crmObject}`))
    .map((m) => ({ appField: m.appField, crmObject: m.crmObject }))

  return { toCreate, toUpdate, unchanged, notInFile, teamIdBySlug }
}

// POST /api/admin/teams/:teamId/sf-field-mappings/import/preview
// Read-only — diffs the uploaded export against this team's CURRENT live
// mappings and reports exactly what would change, so an admin never
// blind-overwrites a colleague's more recent edit just because their
// export file is stale. This is the answer to "call out any issues when
// there's been a change since it was exported."
fieldMappingsRoutes.post('/teams/:teamId/sf-field-mappings/import/preview', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const parsed = z.object({ document: SfFieldMappingImportDocumentSchema }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamIdBySlug, ...diff } = await diffSfFieldMappingImport(teamId, parsed.data.document)
  res.json({ data: diff, error: null, meta: { resolvableTeamSlugs: Array.from(teamIdBySlug.keys()) } })
})

// POST /api/admin/teams/:teamId/sf-field-mappings/import/apply
// Re-diffs against CURRENT state (never trusts a diff computed at preview
// time — the DB may have moved since) and applies toCreate + toUpdate.
// Never deletes: rows only in the current team (not in the file) are left
// untouched, and team assignment is only ever ADDED to, never removed, so
// importing can't silently un-assign a mapping from a team the file simply
// didn't happen to mention.
fieldMappingsRoutes.post('/teams/:teamId/sf-field-mappings/import/apply', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const user = req.user!
  const parsed = z.object({ document: SfFieldMappingImportDocumentSchema }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const doc = parsed.data.document
  const { toCreate, toUpdate, teamIdBySlug } = await diffSfFieldMappingImport(teamId, doc)
  const rowsByKey = new Map(doc.mappings.map((r) => [`${r.appField} ${r.crmObject}`, r]))
  let created = 0
  let updated = 0

  for (const plan of toCreate) {
    const row = rowsByKey.get(`${plan.appField} ${plan.crmObject}`)
    if (!row) continue
    const resolvedTeamIds = Array.from(new Set([teamId, ...(row.teamSlugs ?? []).map((s) => teamIdBySlug.get(s)).filter((v): v is string => !!v)]))
    const [inserted] = await db.insert(crmFieldMappings).values({
      teamId,
      appField: row.appField,
      crmFieldApi: row.crmFieldApi,
      crmObject: row.crmObject,
      direction: row.direction,
      referenceTo: row.referenceTo ?? null,
      isActive: row.isActive,
      constantValue: row.constantValue ?? null,
      backgroundRefresh: !!row.backgroundRefresh,
      refreshOnlyForReports: !!row.refreshOnlyForReports,
      updatedBy: user.id,
      updatedAt: new Date(),
    }).returning()
    if (!inserted) continue
    await db.insert(crmFieldMappingTeams).values(resolvedTeamIds.map((tid) => ({ crmFieldMappingId: inserted.id, teamId: tid }))).onConflictDoNothing()
    await logAudit(req, {
      action: 'sf_field_mapping.create', targetType: 'sf_field_mapping', targetId: inserted.id,
      meta: { ...inserted, teamIds: resolvedTeamIds, source: 'import', importedFromEmail: doc.exportedByEmail ?? null, importedFromExportedAt: doc.exportedAt },
    })
    created++
  }

  for (const plan of toUpdate) {
    const row = rowsByKey.get(`${plan.appField} ${plan.crmObject}`)
    const key = `${plan.appField} ${plan.crmObject}`
    const existing = (await loadMappingsForTeams([teamId])).find((m) => `${m.appField} ${m.crmObject}` === key)
    if (!row || !existing) continue
    const [before] = await db.select().from(crmFieldMappings).where(eq(crmFieldMappings.id, existing.id))
    await db.update(crmFieldMappings).set({
      crmFieldApi: row.crmFieldApi,
      direction: row.direction,
      referenceTo: row.referenceTo ?? null,
      isActive: row.isActive,
      constantValue: row.constantValue ?? null,
      backgroundRefresh: !!row.backgroundRefresh,
      refreshOnlyForReports: !!row.refreshOnlyForReports,
      updatedBy: user.id,
      updatedAt: new Date(),
    }).where(eq(crmFieldMappings.id, existing.id))
    const additionalTeamIds = (row.teamSlugs ?? []).map((s) => teamIdBySlug.get(s)).filter((v): v is string => !!v)
    const resolvedTeamIds = Array.from(new Set([teamId, ...additionalTeamIds]))
    await db.insert(crmFieldMappingTeams).values(resolvedTeamIds.map((tid) => ({ crmFieldMappingId: existing.id, teamId: tid }))).onConflictDoNothing()
    const [after] = await db.select().from(crmFieldMappings).where(eq(crmFieldMappings.id, existing.id))
    await logAudit(req, {
      action: 'sf_field_mapping.update', targetType: 'sf_field_mapping', targetId: existing.id,
      meta: { before, after, source: 'import', importedFromEmail: doc.exportedByEmail ?? null, importedFromExportedAt: doc.exportedAt },
    })
    updated++
  }

  res.json({ data: { created, updated, skipped: toCreate.length + toUpdate.length - created - updated }, error: null, meta: {} })
})
