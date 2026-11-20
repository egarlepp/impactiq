import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import type { db } from '../../db/index.js'
import {
  aiAssessmentAssignments,
  aiAssessmentCriteria,
  aiAssessmentTeams,
  aiAssessments,
  activityTypeTeams,
  teamActivityTypeSubtypes,
  teamActivityTypes,
} from '../../../../drizzle/schema.js'
import {
  AI_ASSESSMENT_MAX_CRITERIA,
  AI_ASSESSMENT_MAX_PER_ACTIVITY,
  AI_ASSESSMENT_MAX_WEIGHT,
  aiAssessmentAnchorsSchema,
  cleanAnchors,
  type AiAssessmentAnchors,
} from '../../../shared/aiAssessments.js'

// AI Assessments in the Activity Types export / import file (v1.464.0).
// The section is optional, so files from before v1.464.0 still import.
// Same rules as the rest of that file: matched by name, never deleted, and
// assignments are only ever added. A rubric owned by another team, or a
// locked one when the importer isn't an App Admin, is left as it is (its
// assignments can still be added). Assignments name their Activity Type and
// Subtype, so they resolve on any install.

export const AssessmentTransferSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullable(),
  // Added in v1.465.0; a file without them leaves the icon as it is.
  icon: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/).nullable().optional(),
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  isActive: z.boolean(),
  criteria: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    lookFor: z.string().max(2000).nullable(),
    weight: z.number().int().min(1).max(AI_ASSESSMENT_MAX_WEIGHT),
    anchors: aiAssessmentAnchorsSchema,
  })).min(1).max(AI_ASSESSMENT_MAX_CRITERIA),
  assignments: z.array(z.object({
    activityType: z.string().trim().min(1).max(200),
    subtype: z.string().trim().min(1).max(200).nullable(),
  })).max(500),
})
export type AssessmentTransfer = z.infer<typeof AssessmentTransferSchema>

export interface AssessmentAssignmentRef { assessment: string; activityType: string; subtype: string | null }
export type AssessmentAssignmentSkipReason = 'missing_type' | 'missing_subtype' | 'slot_full'

export interface AssessmentsImportDiff {
  toCreate: string[]
  toUpdate: Array<{ name: string; fields: string[] }>
  unchanged: string[]
  skipped: Array<{ name: string; reason: 'shared' | 'locked' }>
  duplicateNamesInFile: string[]
  assignmentsToAdd: AssessmentAssignmentRef[]
  assignmentsSkipped: Array<AssessmentAssignmentRef & { reason: AssessmentAssignmentSkipReason }>
}

export interface AssessmentsImportResult { created: number; updated: number; assignmentsAdded: number }

type TxOrDb = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
const key = (s: string) => s.trim().toLowerCase()
const slotKey = (typeId: string, subtypeId: string | null) => `${typeId}|${subtypeId ?? ''}`

function criteriaSignature(rows: Array<{ name: string; lookFor: string | null; weight: number; anchors: unknown }>): string {
  return JSON.stringify(rows.map((c) => {
    const anchors = cleanAnchors(c.anchors as AiAssessmentAnchors)
    return [c.name.trim(), c.lookFor?.trim() || null, c.weight, (['1', '2', '3', '4', '5'] as const).map((l) => anchors[l] ?? null)]
  }))
}

interface LoadedAssessment {
  row: typeof aiAssessments.$inferSelect
  criteria: Array<typeof aiAssessmentCriteria.$inferSelect>
}

/** Assessments shared with the team, with their criteria in order. */
async function loadTeamAssessments(conn: TxOrDb, teamId: string): Promise<LoadedAssessment[]> {
  const heads = await conn.select({ a: aiAssessments }).from(aiAssessments)
    .innerJoin(aiAssessmentTeams, and(eq(aiAssessmentTeams.assessmentId, aiAssessments.id), eq(aiAssessmentTeams.teamId, teamId)))
    .orderBy(aiAssessments.name)
  const ids = heads.map((h) => h.a.id)
  const criteria = ids.length === 0 ? [] : await conn.select().from(aiAssessmentCriteria)
    .where(inArray(aiAssessmentCriteria.assessmentId, ids)).orderBy(aiAssessmentCriteria.sortOrder)
  return heads.map(({ a }) => ({ row: a, criteria: criteria.filter((c) => c.assessmentId === a.id) }))
}

/** The team's Activity Types (by name) and their Subtypes (by name), with ids. */
async function loadTypeIndex(conn: TxOrDb, teamId: string) {
  const types = await conn.select({ id: teamActivityTypes.id, name: teamActivityTypes.name }).from(teamActivityTypes)
    .innerJoin(activityTypeTeams, and(eq(activityTypeTeams.activityTypeId, teamActivityTypes.id), eq(activityTypeTeams.teamId, teamId)))
  const subtypes = types.length === 0 ? [] : await conn.select({ id: teamActivityTypeSubtypes.id, typeId: teamActivityTypeSubtypes.teamActivityTypeId, name: teamActivityTypeSubtypes.name })
    .from(teamActivityTypeSubtypes).where(inArray(teamActivityTypeSubtypes.teamActivityTypeId, types.map((t) => t.id)))
  const index = new Map<string, { id: string; name: string; subtypes: Map<string, { id: string; name: string }> }>()
  for (const t of types) index.set(key(t.name), { id: t.id, name: t.name, subtypes: new Map() })
  for (const s of subtypes) {
    const type = types.find((t) => t.id === s.typeId)
    if (type) index.get(key(type.name))!.subtypes.set(key(s.name), { id: s.id, name: s.name })
  }
  return index
}

export async function buildAssessmentsExport(conn: TxOrDb, teamId: string): Promise<AssessmentTransfer[]> {
  const loaded = await loadTeamAssessments(conn, teamId)
  if (loaded.length === 0) return []
  const assignments = await conn.select({
    assessmentId: aiAssessmentAssignments.assessmentId,
    typeName: teamActivityTypes.name,
    subtypeName: teamActivityTypeSubtypes.name,
  }).from(aiAssessmentAssignments)
    .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, aiAssessmentAssignments.activityTypeId))
    .leftJoin(teamActivityTypeSubtypes, eq(teamActivityTypeSubtypes.id, aiAssessmentAssignments.subtypeId))
    .where(eq(aiAssessmentAssignments.teamId, teamId))
    .orderBy(aiAssessmentAssignments.createdAt)
  return loaded.map(({ row, criteria }) => ({
    name: row.name,
    description: row.description,
    icon: row.icon,
    iconColor: row.iconColor,
    isActive: row.isActive,
    criteria: criteria.map((c) => ({ name: c.name, lookFor: c.lookFor, weight: c.weight, anchors: cleanAnchors(c.anchors as AiAssessmentAnchors) })),
    assignments: assignments.filter((a) => a.assessmentId === row.id).map((a) => ({ activityType: a.typeName, subtype: a.subtypeName ?? null })),
  }))
}

/**
 * What the file would do to the team's assessments. `pending` lists the
 * Activity Types (and their Subtypes) the same import creates or adds, so an
 * assignment to a type the file is about to create is not reported missing.
 */
export async function planAssessmentsImport(
  conn: TxOrDb,
  teamId: string,
  file: readonly AssessmentTransfer[],
  opts: { canEditLocked: boolean; pending: Map<string, Set<string>> },
): Promise<AssessmentsImportDiff> {
  const loaded = await loadTeamAssessments(conn, teamId)
  const byName = new Map(loaded.map((a) => [key(a.row.name), a]))
  const typeIndex = await loadTypeIndex(conn, teamId)
  const existingSlots = await conn.select({ assessmentId: aiAssessmentAssignments.assessmentId, typeId: aiAssessmentAssignments.activityTypeId, subtypeId: aiAssessmentAssignments.subtypeId })
    .from(aiAssessmentAssignments).where(eq(aiAssessmentAssignments.teamId, teamId))

  const diff: AssessmentsImportDiff = { toCreate: [], toUpdate: [], unchanged: [], skipped: [], duplicateNamesInFile: [], assignmentsToAdd: [], assignmentsSkipped: [] }
  // Slot occupancy by type/subtype NAME so pending types count too.
  const slotCount = new Map<string, number>()
  const slotHas = new Set<string>()
  const nameSlot = (type: string, subtype: string | null) => `${key(type)}|${subtype ? key(subtype) : ''}`
  for (const s of existingSlots) {
    const type = [...typeIndex.values()].find((t) => t.id === s.typeId)
    if (!type) continue
    const sub = s.subtypeId ? [...type.subtypes.values()].find((x) => x.id === s.subtypeId)?.name ?? null : null
    if (s.subtypeId && !sub) continue
    const k = nameSlot(type.name, sub)
    slotCount.set(k, (slotCount.get(k) ?? 0) + 1)
    slotHas.add(`${k}|${s.assessmentId}`)
  }

  const seen = new Set<string>()
  for (const a of file) {
    const k = key(a.name)
    if (seen.has(k)) { diff.duplicateNamesInFile.push(a.name); continue }
    seen.add(k)
    const existing = byName.get(k)
    if (!existing) diff.toCreate.push(a.name.trim())
    else if (existing.row.teamId !== teamId) diff.skipped.push({ name: existing.row.name, reason: 'shared' })
    else if (existing.row.isLocked && !opts.canEditLocked) diff.skipped.push({ name: existing.row.name, reason: 'locked' })
    else {
      const fields: string[] = []
      if ((existing.row.description ?? null) !== (a.description?.trim() || null)) fields.push('description')
      if (existing.row.isActive !== a.isActive) fields.push('isActive')
      if (a.icon !== undefined && (existing.row.icon ?? null) !== a.icon) fields.push('icon')
      if (a.iconColor !== undefined && (existing.row.iconColor ?? null) !== a.iconColor) fields.push('iconColor')
      if (criteriaSignature(existing.criteria) !== criteriaSignature(a.criteria)) fields.push('criteria')
      if (fields.length > 0) diff.toUpdate.push({ name: existing.row.name, fields })
      else diff.unchanged.push(existing.row.name)
    }

    for (const asg of a.assignments) {
      const ref: AssessmentAssignmentRef = { assessment: existing?.row.name ?? a.name.trim(), activityType: asg.activityType, subtype: asg.subtype }
      const type = typeIndex.get(key(asg.activityType))
      const pendingSubs = opts.pending.get(key(asg.activityType))
      if (!type && !pendingSubs) { diff.assignmentsSkipped.push({ ...ref, reason: 'missing_type' }); continue }
      if (asg.subtype && !type?.subtypes.has(key(asg.subtype)) && !pendingSubs?.has(key(asg.subtype))) {
        diff.assignmentsSkipped.push({ ...ref, reason: 'missing_subtype' }); continue
      }
      const slot = nameSlot(asg.activityType, asg.subtype)
      if (existing && slotHas.has(`${slot}|${existing.row.id}`)) continue // already assigned
      if (slotHas.has(`${slot}|file:${k}`)) continue // listed twice in the file
      if ((slotCount.get(slot) ?? 0) >= AI_ASSESSMENT_MAX_PER_ACTIVITY) { diff.assignmentsSkipped.push({ ...ref, reason: 'slot_full' }); continue }
      slotCount.set(slot, (slotCount.get(slot) ?? 0) + 1)
      slotHas.add(`${slot}|file:${k}`)
      diff.assignmentsToAdd.push(ref)
    }
  }
  return diff
}

/** Applies a plan made with planAssessmentsImport() inside the same transaction. */
export async function applyAssessmentsImport(
  tx: TxOrDb,
  teamId: string,
  file: readonly AssessmentTransfer[],
  diff: AssessmentsImportDiff,
  userId: string | null,
): Promise<AssessmentsImportResult> {
  const fileByName = new Map<string, AssessmentTransfer>()
  for (const a of file) if (!fileByName.has(key(a.name))) fileByName.set(key(a.name), a)
  const ids = new Map((await loadTeamAssessments(tx, teamId)).map((a) => [key(a.row.name), a.row]))

  const writeCriteria = async (assessmentId: string, a: AssessmentTransfer) => {
    await tx.delete(aiAssessmentCriteria).where(eq(aiAssessmentCriteria.assessmentId, assessmentId))
    await tx.insert(aiAssessmentCriteria).values(a.criteria.map((c, i) => ({
      assessmentId, name: c.name.trim(), lookFor: c.lookFor?.trim() || null, weight: c.weight, anchors: cleanAnchors(c.anchors), sortOrder: i,
    })))
  }

  for (const name of diff.toCreate) {
    const a = fileByName.get(key(name))!
    const [row] = await tx.insert(aiAssessments).values({
      teamId, name: a.name.trim(), description: a.description?.trim() || null, icon: a.icon ?? null, iconColor: a.iconColor ?? null,
      isActive: a.isActive, createdBy: userId, updatedBy: userId,
    }).returning()
    if (!row) throw new Error('errors.database.insert_failed')
    await writeCriteria(row.id, a)
    await tx.insert(aiAssessmentTeams).values({ assessmentId: row.id, teamId }).onConflictDoNothing()
    ids.set(key(name), row)
  }

  for (const u of diff.toUpdate) {
    const a = fileByName.get(key(u.name))!
    const row = ids.get(key(u.name))!
    const rubricChanged = u.fields.includes('criteria') || u.fields.includes('description')
    await tx.update(aiAssessments).set({
      description: a.description?.trim() || null,
      ...(a.icon !== undefined ? { icon: a.icon } : {}),
      ...(a.iconColor !== undefined ? { iconColor: a.iconColor } : {}),
      isActive: a.isActive,
      updatedBy: userId,
      updatedAt: new Date(),
      ...(rubricChanged ? { version: row.version + 1 } : {}),
    }).where(eq(aiAssessments.id, row.id))
    if (u.fields.includes('criteria')) await writeCriteria(row.id, a)
  }

  const typeIndex = await loadTypeIndex(tx, teamId)
  let assignmentsAdded = 0
  const done = new Set<string>()
  for (const ref of diff.assignmentsToAdd) {
    const assessment = ids.get(key(ref.assessment))
    const type = typeIndex.get(key(ref.activityType))
    const subtype = ref.subtype ? type?.subtypes.get(key(ref.subtype)) : null
    if (!assessment || !type || (ref.subtype && !subtype)) continue
    const slot = `${slotKey(type.id, subtype?.id ?? null)}|${assessment.id}`
    if (done.has(slot)) continue
    done.add(slot)
    const [row] = await tx.insert(aiAssessmentAssignments).values({
      teamId, activityTypeId: type.id, subtypeId: subtype?.id ?? null, assessmentId: assessment.id, createdBy: userId,
    }).onConflictDoNothing().returning({ id: aiAssessmentAssignments.id })
    if (row) assignmentsAdded++
  }
  return { created: diff.toCreate.length, updated: diff.toUpdate.length, assignmentsAdded }
}
