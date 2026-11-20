// Activity Types export / import (Admin → Activity Types).
//
// Export writes one versioned JSON document holding every activity type
// assigned to a team, exactly as configured: icon, color, SF object, SF
// picklist override + its sf_event_type_config row (active / fallback /
// typical duration), Default-suggestion star, the three Classify Activity
// Guide fields, every Subtype, and every Salesforce Extra (kind + config,
// verbatim). Team-level settings that live on the same admin page ride
// along too: the Guide Distinctions text and the Enable Subtypes toggle.
//
// Import is preview-then-apply, the same shape as the SF Field Mappings
// import (admin.ts): the preview diffs the file against the team's CURRENT
// state, and apply re-diffs (never trusts a diff computed at preview time)
// and writes everything inside one transaction, so a failure part-way
// leaves the team untouched.
//
// Matching and what import never does:
//  - Types are matched by name (trimmed, case-insensitive). Unmatched rows
//    are created; matched rows are updated in place. A team type that the
//    file doesn't mention is left alone — import never deletes a type.
//  - Subtypes are matched by name and only ever added or re-ordered, never
//    deleted, because activities and templates point at them by id
//    (subtype_id, onDelete: set null) and deleting would silently blank
//    what contributors already picked.
//  - Salesforce Extras have no natural key and nothing references them, so
//    for a matched type the file's set REPLACES the existing set whenever
//    the two differ — that's what "exactly how they are" means for config
//    blobs. The preview says so before anything is written.
//  - A name match against a type the team only sees through the junction
//    table but doesn't own (a shared type, teams.id != team_activity_types
//    .team_id) is skipped rather than edited, since writing to it would
//    change it for every other team it's assigned to.
//  - The SF Field Mappings an Extra relies on (e.g. a ticket picker's
//    ticket_* fields) are NOT part of this file — they have their own
//    Export / Import on Admin → SF Field Mappings.
import { z } from 'zod'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { renameLegacyKeys, LEGACY_ACTIVITY_TYPE_KEYS } from '../../../shared/legacyKeys.js'
import {
  teams,
  teamActivityTypes,
  activityTypeTeams,
  teamActivityTypeSubtypes,
  teamActivityTypeCrmExtras,
  sfEventTypeConfig,
} from '../../../../drizzle/schema.js'
import {
  AssessmentTransferSchema,
  applyAssessmentsImport,
  buildAssessmentsExport,
  planAssessmentsImport,
  type AssessmentsImportDiff,
} from '../aiAssessments/transfer.js'

export const ACTIVITY_TYPES_EXPORT_KIND = 'impactiq.activity_types'
export const ACTIVITY_TYPES_FORMAT_VERSION = 1

const SfExtraSchema = z.object({
  kind: z.enum(['opp_field_display', 'related_object_picker', 'ticket_picker']),
  config: z.record(z.string(), z.unknown()),
})

const SubtypeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sortOrder: z.number().int(),
})

const ActivityTypeRowSchema = z.preprocess((v) => renameLegacyKeys(v, LEGACY_ACTIVITY_TYPE_KEYS), z.object({
  name: z.string().trim().min(1).max(200),
  crmObjectType: z.enum(['Event', 'Task']),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
  icon: z.string().max(64).nullable(),
  crmPicklistValue: z.string().max(200).nullable(),
  typicalDurationMinutes: z.number().int().nullable(),
  isDefaultSuggestion: z.boolean(),
  useThisWhen: z.string().max(4000).nullable(),
  usuallyAttachTo: z.string().max(4000).nullable(),
  examples: z.string().max(4000).nullable(),
  // sf_event_type_config row keyed by (team, crmPicklistValue ?? name).
  // null = no config row existed at export time.
  sfPicklistConfig: z.object({
    isActive: z.boolean(),
    fallbackValue: z.string().nullable(),
  }).nullable(),
  subtypes: z.array(SubtypeSchema).max(200),
  sfExtras: z.array(SfExtraSchema).max(50),
}))

export const ActivityTypesDocumentSchema = z.object({
  kind: z.literal(ACTIVITY_TYPES_EXPORT_KIND),
  formatVersion: z.literal(ACTIVITY_TYPES_FORMAT_VERSION),
  exportedAt: z.string(),
  exportedByEmail: z.string().nullable().optional(),
  sourceTeamSlug: z.string().optional(),
  sourceTeamName: z.string().optional(),
  team: z.object({
    guideDistinctions: z.string().max(20000).nullable(),
    subtypesEnabled: z.boolean(),
  }),
  activityTypes: z.array(ActivityTypeRowSchema).max(500),
  // v1.464.0: the team's AI Assessments and their assignments. Optional, so
  // files exported before v1.464.0 still import (and leave assessments alone).
  aiAssessments: z.array(AssessmentTransferSchema).max(200).optional(),
})

export type ActivityTypesDocument = z.infer<typeof ActivityTypesDocumentSchema>
type ActivityTypeRow = z.infer<typeof ActivityTypeRowSchema>
type TxOrDb = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

const nameKey = (s: string) => s.trim().toLowerCase()
const resolvedPicklistValue = (t: { name: string; crmPicklistValue: string | null }) =>
  t.crmPicklistValue && t.crmPicklistValue.trim().length > 0 ? t.crmPicklistValue.trim() : t.name.trim()

// Stable JSON (sorted keys) so two config blobs that differ only in key
// order compare equal.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}
const extrasSignature = (rows: Array<{ kind: string; config: unknown }>) =>
  rows.map((r) => `${r.kind}|${canonical(r.config)}`).sort().join('\n')

interface LoadedType {
  row: typeof teamActivityTypes.$inferSelect
  // false = owned by this team (team_id column) but missing its junction
  // row, so it's invisible on the admin page. Still matched by name —
  // creating a new row would collide with the (team_id, name) unique key —
  // and apply re-adds the junction row.
  assigned: boolean
  subtypes: Array<typeof teamActivityTypeSubtypes.$inferSelect>
  extras: Array<typeof teamActivityTypeCrmExtras.$inferSelect>
}

async function loadTeamState(conn: TxOrDb, teamId: string) {
  const [team] = await conn.select().from(teams).where(eq(teams.id, teamId)).limit(1)
  const typeRows = await conn
    .select({ type: teamActivityTypes })
    .from(teamActivityTypes)
    .innerJoin(activityTypeTeams, and(
      eq(activityTypeTeams.activityTypeId, teamActivityTypes.id),
      eq(activityTypeTeams.teamId, teamId),
    ))
    .orderBy(teamActivityTypes.sortOrder, teamActivityTypes.name)
  const assignedIds = typeRows.map((r) => r.type.id)
  const unassigned = await conn.select().from(teamActivityTypes).where(
    assignedIds.length > 0
      ? and(eq(teamActivityTypes.teamId, teamId), notInArray(teamActivityTypes.id, assignedIds))
      : eq(teamActivityTypes.teamId, teamId),
  )
  const allRows = [
    ...typeRows.map((r) => ({ type: r.type, assigned: true })),
    ...unassigned.map((type) => ({ type, assigned: false })),
  ]
  const ids = allRows.map((r) => r.type.id)
  const subtypes = ids.length > 0
    ? await conn.select().from(teamActivityTypeSubtypes).where(inArray(teamActivityTypeSubtypes.teamActivityTypeId, ids))
      .orderBy(teamActivityTypeSubtypes.sortOrder, teamActivityTypeSubtypes.createdAt)
    : []
  const extras = ids.length > 0
    ? await conn.select().from(teamActivityTypeCrmExtras).where(inArray(teamActivityTypeCrmExtras.teamActivityTypeId, ids))
      .orderBy(teamActivityTypeCrmExtras.createdAt)
    : []
  const picklist = await conn.select().from(sfEventTypeConfig).where(eq(sfEventTypeConfig.teamId, teamId))
  const types: LoadedType[] = allRows.map(({ type, assigned }) => ({
    row: type,
    assigned,
    subtypes: subtypes.filter((s) => s.teamActivityTypeId === type.id),
    extras: extras.filter((e) => e.teamActivityTypeId === type.id),
  }))
  return { team, types, picklistByValue: new Map(picklist.map((p) => [p.sfPicklistValue, p])) }
}

export async function buildActivityTypesExport(teamId: string, exportedByEmail: string | null): Promise<ActivityTypesDocument | null> {
  const { team, types, picklistByValue } = await loadTeamState(db, teamId)
  if (!team) return null
  return {
    kind: ACTIVITY_TYPES_EXPORT_KIND,
    formatVersion: ACTIVITY_TYPES_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedByEmail,
    sourceTeamSlug: team.slug,
    sourceTeamName: team.name,
    team: {
      guideDistinctions: team.guideDistinctions ?? null,
      subtypesEnabled: team.subtypesEnabled,
    },
    activityTypes: types.filter((t) => t.assigned).map(({ row, subtypes, extras }): ActivityTypeRow => {
      const p = picklistByValue.get(resolvedPicklistValue(row))
      return {
        name: row.name,
        crmObjectType: row.crmObjectType,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        color: row.color,
        icon: row.icon,
        crmPicklistValue: row.crmPicklistValue,
        typicalDurationMinutes: row.typicalDurationMinutes,
        isDefaultSuggestion: row.isDefaultSuggestion,
        useThisWhen: row.useThisWhen,
        usuallyAttachTo: row.usuallyAttachTo,
        examples: row.examples,
        sfPicklistConfig: p ? { isActive: p.isActive, fallbackValue: p.fallbackValue } : null,
        subtypes: subtypes.map((s) => ({ name: s.name, sortOrder: s.sortOrder })),
        sfExtras: extras.map((e) => ({ kind: e.kind as ActivityTypeRow['sfExtras'][number]['kind'], config: (e.config ?? {}) as Record<string, unknown> })),
      }
    }),
    aiAssessments: await buildAssessmentsExport(db, teamId),
  }
}

export interface ActivityTypeDiffRow {
  name: string
  changes?: Array<{ field: string; from: unknown; to: unknown }>
  subtypesAdded?: string[]
  extrasReplaced?: { from: number; to: number }
}
export interface ActivityTypesImportDiff {
  toCreate: Array<{ name: string; subtypes: number; sfExtras: number }>
  toUpdate: ActivityTypeDiffRow[]
  unchanged: string[]
  skippedShared: string[]
  notInFile: string[]
  duplicateNamesInFile: string[]
  teamChanges: Array<{ field: string; from: unknown; to: unknown }>
  /** Null when the file has no AI Assessments section. */
  aiAssessments: AssessmentsImportDiff | null
}

export interface ImportOptions { canEditLocked: boolean; userId: string | null }
const NO_LOCK: ImportOptions = { canEditLocked: false, userId: null }

interface Plan {
  diff: ActivityTypesImportDiff
  // matched existing row per file-row index (only for owned matches)
  matches: Map<number, LoadedType>
  createIdx: number[]
  skip: Set<number>
}

async function planImport(conn: TxOrDb, teamId: string, doc: ActivityTypesDocument, opts: ImportOptions): Promise<Plan | null> {
  const { team, types, picklistByValue } = await loadTeamState(conn, teamId)
  if (!team) return null
  const byName = new Map(types.map((t) => [nameKey(t.row.name), t]))
  const diff: ActivityTypesImportDiff = {
    toCreate: [], toUpdate: [], unchanged: [], skippedShared: [], notInFile: [], duplicateNamesInFile: [], teamChanges: [], aiAssessments: null,
  }
  const matches = new Map<number, LoadedType>()
  const createIdx: number[] = []
  const skip = new Set<number>()
  const seen = new Set<string>()

  doc.activityTypes.forEach((row, i) => {
    const key = nameKey(row.name)
    if (seen.has(key)) { diff.duplicateNamesInFile.push(row.name); skip.add(i); return }
    seen.add(key)
    const existing = byName.get(key)
    if (!existing) {
      createIdx.push(i)
      diff.toCreate.push({ name: row.name.trim(), subtypes: row.subtypes.length, sfExtras: row.sfExtras.length })
      return
    }
    if (existing.row.teamId !== teamId) { diff.skippedShared.push(existing.row.name); skip.add(i); return }
    matches.set(i, existing)

    const changes: Array<{ field: string; from: unknown; to: unknown }> = []
    const pairs: Array<[string, unknown, unknown]> = [
      ['crmObjectType', existing.row.crmObjectType, row.crmObjectType],
      ['isActive', existing.row.isActive, row.isActive],
      ['sortOrder', existing.row.sortOrder, row.sortOrder],
      ['color', existing.row.color ?? null, row.color ?? null],
      ['icon', existing.row.icon ?? null, row.icon ?? null],
      ['crmPicklistValue', existing.row.crmPicklistValue ?? null, row.crmPicklistValue ?? null],
      ['typicalDurationMinutes', existing.row.typicalDurationMinutes ?? null, row.typicalDurationMinutes ?? null],
      ['isDefaultSuggestion', existing.row.isDefaultSuggestion, row.isDefaultSuggestion],
      ['useThisWhen', existing.row.useThisWhen ?? null, row.useThisWhen ?? null],
      ['usuallyAttachTo', existing.row.usuallyAttachTo ?? null, row.usuallyAttachTo ?? null],
      ['examples', existing.row.examples ?? null, row.examples ?? null],
    ]
    if (row.sfPicklistConfig) {
      const p = picklistByValue.get(resolvedPicklistValue({ name: row.name, crmPicklistValue: row.crmPicklistValue }))
      pairs.push(['sfPicklistIsActive', p?.isActive ?? true, row.sfPicklistConfig.isActive])
      pairs.push(['fallbackValue', p?.fallbackValue ?? null, row.sfPicklistConfig.fallbackValue ?? null])
    }
    for (const [field, from, to] of pairs) if (from !== to) changes.push({ field, from, to })

    const existingSubtypes = new Map(existing.subtypes.map((s) => [nameKey(s.name), s]))
    const subtypesAdded = row.subtypes.filter((s) => !existingSubtypes.has(nameKey(s.name))).map((s) => s.name.trim())
    const subtypesReordered = row.subtypes.some((s) => {
      const e = existingSubtypes.get(nameKey(s.name))
      return e && e.sortOrder !== s.sortOrder
    })
    if (subtypesReordered) changes.push({ field: 'subtypeOrder', from: null, to: null })

    const extrasDiffer = extrasSignature(existing.extras) !== extrasSignature(row.sfExtras)

    if (!existing.assigned) changes.push({ field: 'assignedToTeam', from: false, to: true })

    if (changes.length > 0 || subtypesAdded.length > 0 || extrasDiffer) {
      diff.toUpdate.push({
        name: existing.row.name,
        ...(changes.length > 0 ? { changes } : {}),
        ...(subtypesAdded.length > 0 ? { subtypesAdded } : {}),
        ...(extrasDiffer ? { extrasReplaced: { from: existing.extras.length, to: row.sfExtras.length } } : {}),
      })
    } else {
      diff.unchanged.push(existing.row.name)
    }
  })

  diff.notInFile = types.filter((t) => t.assigned && !seen.has(nameKey(t.row.name))).map((t) => t.row.name)

  const distinctions = doc.team.guideDistinctions?.trim() || null
  if ((team.guideDistinctions ?? null) !== distinctions) diff.teamChanges.push({ field: 'guideDistinctions', from: team.guideDistinctions ?? null, to: distinctions })
  if (team.subtypesEnabled !== doc.team.subtypesEnabled) diff.teamChanges.push({ field: 'subtypesEnabled', from: team.subtypesEnabled, to: doc.team.subtypesEnabled })

  if (doc.aiAssessments) {
    // Types (and their Subtypes) this same import creates or extends.
    const pending = new Map<string, Set<string>>()
    doc.activityTypes.forEach((row, i) => {
      if (skip.has(i)) return
      pending.set(nameKey(row.name), new Set(row.subtypes.map((st) => nameKey(st.name))))
    })
    diff.aiAssessments = await planAssessmentsImport(conn, teamId, doc.aiAssessments, { canEditLocked: opts.canEditLocked, pending })
  }

  return { diff, matches, createIdx, skip }
}

export async function previewActivityTypesImport(teamId: string, doc: ActivityTypesDocument, opts: ImportOptions = NO_LOCK): Promise<ActivityTypesImportDiff | null> {
  const plan = await planImport(db, teamId, doc, opts)
  return plan?.diff ?? null
}

async function upsertPicklistConfig(conn: TxOrDb, teamId: string, row: ActivityTypeRow) {
  if (!row.sfPicklistConfig) return
  const value = resolvedPicklistValue({ name: row.name, crmPicklistValue: row.crmPicklistValue })
  const [existing] = await conn.select().from(sfEventTypeConfig)
    .where(and(eq(sfEventTypeConfig.teamId, teamId), eq(sfEventTypeConfig.sfPicklistValue, value))).limit(1)
  const patch = {
    isActive: row.sfPicklistConfig.isActive,
    fallbackValue: row.sfPicklistConfig.fallbackValue ?? null,
    typicalDurationMinutes: row.typicalDurationMinutes ?? null,
  }
  if (existing) await conn.update(sfEventTypeConfig).set(patch).where(eq(sfEventTypeConfig.id, existing.id))
  else await conn.insert(sfEventTypeConfig).values({ teamId, sfPicklistValue: value, ...patch })
}

const typeValues = (row: ActivityTypeRow) => ({
  crmObjectType: row.crmObjectType,
  isActive: row.isActive,
  sortOrder: row.sortOrder,
  color: row.color ?? null,
  icon: row.icon ?? null,
  crmPicklistValue: row.crmPicklistValue?.trim() || null,
  typicalDurationMinutes: row.typicalDurationMinutes ?? null,
  isDefaultSuggestion: row.isDefaultSuggestion,
  useThisWhen: row.useThisWhen?.trim() || null,
  usuallyAttachTo: row.usuallyAttachTo?.trim() || null,
  examples: row.examples?.trim() || null,
})

export interface ActivityTypesImportResult {
  created: number
  updated: number
  unchanged: number
  skipped: number
  subtypesAdded: number
  teamSettingsUpdated: boolean
  assessmentsCreated: number
  assessmentsUpdated: number
  assignmentsAdded: number
}

export async function applyActivityTypesImport(teamId: string, doc: ActivityTypesDocument, opts: ImportOptions = NO_LOCK): Promise<ActivityTypesImportResult | null> {
  return db.transaction(async (tx) => {
    const plan = await planImport(tx, teamId, doc, opts)
    if (!plan) return null
    const { diff, matches, createIdx, skip } = plan
    const updatedNames = new Set(diff.toUpdate.map((r) => nameKey(r.name)))
    let subtypesAdded = 0

    // At most one Default-suggestion type per team (§11) — if the file sets
    // one, clear every other row on the team first, then the writes below
    // set the file's choice. Done up front so the order of rows in the file
    // can't leave two stars.
    const fileHasDefault = doc.activityTypes.some((r, i) => !skip.has(i) && r.isDefaultSuggestion)
    if (fileHasDefault) {
      await tx.update(teamActivityTypes).set({ isDefaultSuggestion: false }).where(eq(teamActivityTypes.teamId, teamId))
    }

    for (const i of createIdx) {
      const row = doc.activityTypes[i]!
      const [inserted] = await tx.insert(teamActivityTypes).values({ teamId, name: row.name.trim(), ...typeValues(row) }).returning()
      if (!inserted) throw new Error('errors.database.insert_failed')
      await tx.insert(activityTypeTeams).values({ activityTypeId: inserted.id, teamId }).onConflictDoNothing()
      if (row.subtypes.length > 0) {
        await tx.insert(teamActivityTypeSubtypes).values(row.subtypes.map((s) => ({ teamActivityTypeId: inserted.id, name: s.name.trim(), sortOrder: s.sortOrder })))
        subtypesAdded += row.subtypes.length
      }
      if (row.sfExtras.length > 0) {
        await tx.insert(teamActivityTypeCrmExtras).values(row.sfExtras.map((e) => ({ teamActivityTypeId: inserted.id, kind: e.kind, config: e.config })))
      }
      await upsertPicklistConfig(tx, teamId, row)
    }

    for (const [i, existing] of matches) {
      if (!updatedNames.has(nameKey(existing.row.name))) {
        // Unchanged, but the default-star reset above may have cleared it.
        if (fileHasDefault && doc.activityTypes[i]!.isDefaultSuggestion) {
          await tx.update(teamActivityTypes).set({ isDefaultSuggestion: true }).where(eq(teamActivityTypes.id, existing.row.id))
        }
        continue
      }
      const row = doc.activityTypes[i]!
      await tx.update(teamActivityTypes).set(typeValues(row)).where(eq(teamActivityTypes.id, existing.row.id))
      if (!existing.assigned) {
        await tx.insert(activityTypeTeams).values({ activityTypeId: existing.row.id, teamId }).onConflictDoNothing()
      }

      const existingSubtypes = new Map(existing.subtypes.map((s) => [nameKey(s.name), s]))
      for (const s of row.subtypes) {
        const e = existingSubtypes.get(nameKey(s.name))
        if (!e) {
          await tx.insert(teamActivityTypeSubtypes).values({ teamActivityTypeId: existing.row.id, name: s.name.trim(), sortOrder: s.sortOrder })
          subtypesAdded++
        } else if (e.sortOrder !== s.sortOrder) {
          await tx.update(teamActivityTypeSubtypes).set({ sortOrder: s.sortOrder }).where(eq(teamActivityTypeSubtypes.id, e.id))
        }
      }

      if (extrasSignature(existing.extras) !== extrasSignature(row.sfExtras)) {
        await tx.delete(teamActivityTypeCrmExtras).where(eq(teamActivityTypeCrmExtras.teamActivityTypeId, existing.row.id))
        if (row.sfExtras.length > 0) {
          await tx.insert(teamActivityTypeCrmExtras).values(row.sfExtras.map((e) => ({ teamActivityTypeId: existing.row.id, kind: e.kind, config: e.config })))
        }
      }
      await upsertPicklistConfig(tx, teamId, row)
    }

    let teamSettingsUpdated = false
    if (diff.teamChanges.length > 0) {
      await tx.update(teams).set({
        guideDistinctions: doc.team.guideDistinctions?.trim() || null,
        subtypesEnabled: doc.team.subtypesEnabled,
      }).where(eq(teams.id, teamId))
      teamSettingsUpdated = true
    }

    // After the types, so an assignment can name a type this file created.
    const assessments = doc.aiAssessments && diff.aiAssessments
      ? await applyAssessmentsImport(tx, teamId, doc.aiAssessments, diff.aiAssessments, opts.userId)
      : { created: 0, updated: 0, assignmentsAdded: 0 }

    return {
      created: createIdx.length,
      updated: diff.toUpdate.length,
      unchanged: diff.unchanged.length,
      skipped: diff.skippedShared.length + diff.duplicateNamesInFile.length,
      subtypesAdded,
      teamSettingsUpdated,
      assessmentsCreated: assessments.created,
      assessmentsUpdated: assessments.updated,
      assignmentsAdded: assessments.assignmentsAdded,
    }
  })
}

// Exported only so tests can assert the canonical comparison directly.
export const __test = { canonical, extrasSignature }
