import { Router, type Request } from 'express'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activityTypeTeams,
  aiAssessmentAssignments,
  aiAssessmentCriteria,
  aiAssessmentTeams,
  aiAssessments,
  aiNoteProfiles,
  teamActivityTypeSubtypes,
  teamMembers,
  users,
} from '../../../../drizzle/schema.js'
import {
  AI_ASSESSMENT_MAX_PER_ACTIVITY,
  aiAssessmentAssignmentInputSchema,
  aiAssessmentInputSchema,
  aiAssessmentPatchSchema,
  cleanAnchors,
  type AiAssessment,
  type AiAssessmentAnchors,
  type AiAssessmentCriterionInput,
  type AiAssessmentsAdminView,
} from '../../../shared/aiAssessments.js'
import { isAppAdmin, requireRole } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'

// Admin → Activities & Rules → AI Assessments (v1.461.0). Team Admins define
// scored rubrics for their team (shareable with other teams they admin, like
// Keyword Rules) and assign them to Activity Types and Subtypes. App Admins
// can lock a rubric so teams use it as is.

export const aiAssessmentsAdminRoutes = Router()

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function fail(res: import('express').Response, status: number, error: string) {
  res.status(status).json({ data: null, error, meta: {} })
}

/** Teams on which the caller may manage AI Assessments (every team for an App Admin). */
async function adminTeamIds(userId: string): Promise<Set<string> | 'all'> {
  if (await isAppAdmin(userId)) return 'all'
  const rows = await db.select({ teamId: teamMembers.teamId }).from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.role, ['admin', 'team_admin'])))
  return new Set(rows.map((r) => r.teamId))
}

/** Whether a rubric is shared with a team (ai_assessment_teams is the only source of truth). */
export async function isAssessmentVisibleToTeam(assessmentId: string, teamId: string): Promise<boolean> {
  const [row] = await db.select({ id: aiAssessmentTeams.assessmentId }).from(aiAssessmentTeams)
    .where(and(eq(aiAssessmentTeams.assessmentId, assessmentId), eq(aiAssessmentTeams.teamId, teamId)))
    .limit(1)
  return !!row
}

/** An AI Note profile can be attached only from the team that owns it (v1.466.0). */
async function profileError(profileId: string | null | undefined, teamId: string): Promise<string | null> {
  if (!profileId) return null
  const [row] = await db.select({ id: aiNoteProfiles.id }).from(aiNoteProfiles)
    .where(and(eq(aiNoteProfiles.id, profileId), eq(aiNoteProfiles.teamId, teamId))).limit(1)
  return row ? null : 'errors.ai_assessments.profile_not_found'
}

async function listForTeam(teamId: string, callerId: string): Promise<AiAssessmentsAdminView> {
  const rows = await db
    .select({ a: aiAssessments, updatedByName: users.displayName, profileName: aiNoteProfiles.name })
    .from(aiAssessments)
    .innerJoin(aiAssessmentTeams, and(eq(aiAssessmentTeams.assessmentId, aiAssessments.id), eq(aiAssessmentTeams.teamId, teamId)))
    .leftJoin(users, eq(users.id, aiAssessments.updatedBy))
    .leftJoin(aiNoteProfiles, eq(aiNoteProfiles.id, aiAssessments.aiNoteProfileId))
    .orderBy(asc(aiAssessments.name))
  const ids = rows.map((r) => r.a.id)
  const [criteria, teamRows, assignments] = ids.length === 0
    ? [[], [], []]
    : await Promise.all([
        db.select().from(aiAssessmentCriteria).where(inArray(aiAssessmentCriteria.assessmentId, ids)).orderBy(asc(aiAssessmentCriteria.sortOrder)),
        db.select().from(aiAssessmentTeams).where(inArray(aiAssessmentTeams.assessmentId, ids)),
        db.select().from(aiAssessmentAssignments).where(and(eq(aiAssessmentAssignments.teamId, teamId), inArray(aiAssessmentAssignments.assessmentId, ids))),
      ])
  const assessments: AiAssessment[] = rows.map(({ a, updatedByName, profileName }) => ({
    id: a.id,
    homeTeamId: a.teamId,
    name: a.name,
    description: a.description,
    icon: a.icon,
    iconColor: a.iconColor,
    aiNoteProfileId: a.aiNoteProfileId,
    aiNoteProfileName: profileName ?? null,
    isActive: a.isActive,
    isLocked: a.isLocked,
    version: a.version,
    teamIds: teamRows.filter((t) => t.assessmentId === a.id).map((t) => t.teamId),
    criteria: criteria.filter((c) => c.assessmentId === a.id).map((c) => ({
      id: c.id,
      name: c.name,
      lookFor: c.lookFor,
      weight: c.weight,
      anchors: (c.anchors ?? {}) as AiAssessmentAnchors,
      sortOrder: c.sortOrder,
    })),
    assignmentCount: assignments.filter((x) => x.assessmentId === a.id).length,
    updatedAt: a.updatedAt.toISOString(),
    updatedByName: updatedByName ?? null,
  }))
  return {
    assessments,
    assignments: assignments.map((x) => ({ id: x.id, activityTypeId: x.activityTypeId, subtypeId: x.subtypeId, assessmentId: x.assessmentId })),
    canLock: await isAppAdmin(callerId),
  }
}

async function writeCriteria(tx: Tx, assessmentId: string, criteria: AiAssessmentCriterionInput[]) {
  await tx.delete(aiAssessmentCriteria).where(eq(aiAssessmentCriteria.assessmentId, assessmentId))
  await tx.insert(aiAssessmentCriteria).values(criteria.map((c, i) => ({
    assessmentId,
    name: c.name,
    lookFor: c.lookFor ? c.lookFor : null,
    weight: c.weight,
    anchors: cleanAnchors(c.anchors),
    sortOrder: i,
  })))
}

/** The requested sharing list, or an error key when the caller can't share with one of them. */
async function checkTeamIds(req: Request, teamIds: string[]): Promise<string | null> {
  const allowed = await adminTeamIds(req.user!.id)
  if (allowed === 'all') return null
  return teamIds.every((id) => allowed.has(id)) ? null : 'errors.ai_assessments.team_not_allowed'
}

aiAssessmentsAdminRoutes.get('/teams/:teamId/ai-assessments', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  res.json({ data: await listForTeam(teamId, req.user!.id), error: null, meta: {} })
})

aiAssessmentsAdminRoutes.post('/teams/:teamId/ai-assessments', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const parsed = aiAssessmentInputSchema.safeParse(req.body)
  if (!parsed.success) { fail(res, 400, 'errors.validation_failed'); return }
  const { teamIds: requested, criteria, isLocked, ...rest } = parsed.data
  const teamIds = [...new Set(requested ?? [teamId])]
  const teamError = await checkTeamIds(req, teamIds)
  if (teamError) { fail(res, 403, teamError); return }
  if (isLocked && !(await isAppAdmin(req.user!.id))) { fail(res, 403, 'errors.ai_assessments.lock_app_admin_only'); return }
  const badProfile = await profileError(rest.aiNoteProfileId, teamId)
  if (badProfile) { fail(res, 400, badProfile); return }
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(aiAssessments).values({
      teamId,
      name: rest.name,
      description: rest.description ? rest.description : null,
      icon: rest.icon ?? null,
      iconColor: rest.iconColor ?? null,
      aiNoteProfileId: rest.aiNoteProfileId ?? null,
      isActive: rest.isActive ?? true,
      isLocked: isLocked ?? false,
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
    }).returning({ id: aiAssessments.id })
    await writeCriteria(tx, row!.id, criteria)
    await tx.insert(aiAssessmentTeams).values(teamIds.map((t) => ({ assessmentId: row!.id, teamId: t }))).onConflictDoNothing()
    return row!.id
  })
  await logAudit(req, { action: 'ai_assessment.create', targetType: 'ai_assessment', targetId: id, meta: { name: rest.name, teamIds, criteria: criteria.length } })
  res.status(201).json({ data: await listForTeam(teamId, req.user!.id), error: null, meta: { id } })
})

aiAssessmentsAdminRoutes.patch('/teams/:teamId/ai-assessments/:assessmentId', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const assessmentId = req.params['assessmentId'] as string
  const parsed = aiAssessmentPatchSchema.safeParse(req.body)
  if (!parsed.success) { fail(res, 400, 'errors.validation_failed'); return }
  const [existing] = await db.select().from(aiAssessments).where(eq(aiAssessments.id, assessmentId)).limit(1)
  if (!existing || !(await isAssessmentVisibleToTeam(assessmentId, teamId))) { fail(res, 404, 'errors.not_found'); return }
  const appAdmin = await isAppAdmin(req.user!.id)
  if ((existing.isLocked || parsed.data.isLocked !== undefined) && !appAdmin) { fail(res, 403, 'errors.ai_assessments.locked'); return }
  const { teamIds: requested, criteria, isLocked, ...rest } = parsed.data
  // Keeping the profile it already has is fine from any team that sees it.
  if (rest.aiNoteProfileId !== undefined && rest.aiNoteProfileId !== existing.aiNoteProfileId) {
    const badProfile = await profileError(rest.aiNoteProfileId, teamId)
    if (badProfile) { fail(res, 400, badProfile); return }
  }
  let removedTeams: string[] = []
  let teamIds: string[] | undefined
  if (requested) {
    teamIds = [...new Set(requested)]
    const current = (await db.select({ teamId: aiAssessmentTeams.teamId }).from(aiAssessmentTeams).where(eq(aiAssessmentTeams.assessmentId, assessmentId))).map((r) => r.teamId)
    removedTeams = current.filter((t) => !teamIds!.includes(t))
    const added = teamIds.filter((t) => !current.includes(t))
    // Adding or removing a team takes admin rights on that team.
    const teamError = await checkTeamIds(req, [...added, ...removedTeams])
    if (teamError) { fail(res, 403, teamError); return }
  }
  const rubricChanged = criteria !== undefined || rest.name !== undefined || rest.description !== undefined
  await db.transaction(async (tx) => {
    const set: Partial<typeof aiAssessments.$inferInsert> = { updatedBy: req.user!.id, updatedAt: new Date() }
    if (rest.name !== undefined) set.name = rest.name
    if (rest.description !== undefined) set.description = rest.description ? rest.description : null
    if (rest.icon !== undefined) set.icon = rest.icon
    if (rest.iconColor !== undefined) set.iconColor = rest.iconColor
    if (rest.aiNoteProfileId !== undefined) set.aiNoteProfileId = rest.aiNoteProfileId
    if (rest.isActive !== undefined) set.isActive = rest.isActive
    if (isLocked !== undefined) set.isLocked = isLocked
    if (rubricChanged) set.version = existing.version + 1
    await tx.update(aiAssessments).set(set).where(eq(aiAssessments.id, assessmentId))
    if (criteria) await writeCriteria(tx, assessmentId, criteria)
    if (teamIds) {
      await tx.delete(aiAssessmentTeams).where(eq(aiAssessmentTeams.assessmentId, assessmentId))
      if (teamIds.length > 0) await tx.insert(aiAssessmentTeams).values(teamIds.map((t) => ({ assessmentId, teamId: t }))).onConflictDoNothing()
      // A team that no longer has the rubric loses its assignments of it.
      if (removedTeams.length > 0) {
        await tx.delete(aiAssessmentAssignments).where(and(eq(aiAssessmentAssignments.assessmentId, assessmentId), inArray(aiAssessmentAssignments.teamId, removedTeams)))
      }
    }
  })
  await logAudit(req, {
    action: 'ai_assessment.update',
    targetType: 'ai_assessment',
    targetId: assessmentId,
    meta: {
      name: rest.name ?? existing.name,
      fields: Object.keys(parsed.data),
      version: rubricChanged ? existing.version + 1 : existing.version,
      removedTeams,
    },
  })
  res.json({ data: await listForTeam(teamId, req.user!.id), error: null, meta: {} })
})

aiAssessmentsAdminRoutes.delete('/teams/:teamId/ai-assessments/:assessmentId', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const assessmentId = req.params['assessmentId'] as string
  const [existing] = await db.select().from(aiAssessments).where(eq(aiAssessments.id, assessmentId)).limit(1)
  if (!existing || !(await isAssessmentVisibleToTeam(assessmentId, teamId))) { fail(res, 404, 'errors.not_found'); return }
  const appAdmin = await isAppAdmin(req.user!.id)
  if (existing.isLocked && !appAdmin) { fail(res, 403, 'errors.ai_assessments.locked'); return }
  // A rubric shared with other teams is deleted for all of them, so the
  // caller must be able to manage every one of those teams.
  const shared = (await db.select({ teamId: aiAssessmentTeams.teamId }).from(aiAssessmentTeams).where(eq(aiAssessmentTeams.assessmentId, assessmentId))).map((r) => r.teamId)
  const teamError = await checkTeamIds(req, shared)
  if (teamError) { fail(res, 403, 'errors.ai_assessments.shared_delete'); return }
  await db.delete(aiAssessments).where(eq(aiAssessments.id, assessmentId))
  await logAudit(req, { action: 'ai_assessment.delete', targetType: 'ai_assessment', targetId: assessmentId, meta: { name: existing.name, teamIds: shared } })
  res.json({ data: await listForTeam(teamId, req.user!.id), error: null, meta: {} })
})

aiAssessmentsAdminRoutes.post('/teams/:teamId/ai-assessment-assignments', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const parsed = aiAssessmentAssignmentInputSchema.safeParse(req.body)
  if (!parsed.success) { fail(res, 400, 'errors.validation_failed'); return }
  const { activityTypeId, subtypeId, assessmentId } = parsed.data
  const [typeOnTeam] = await db.select({ id: activityTypeTeams.activityTypeId }).from(activityTypeTeams)
    .where(and(eq(activityTypeTeams.activityTypeId, activityTypeId), eq(activityTypeTeams.teamId, teamId))).limit(1)
  if (!typeOnTeam) { fail(res, 404, 'errors.not_found'); return }
  if (subtypeId) {
    const [sub] = await db.select({ id: teamActivityTypeSubtypes.id }).from(teamActivityTypeSubtypes)
      .where(and(eq(teamActivityTypeSubtypes.id, subtypeId), eq(teamActivityTypeSubtypes.teamActivityTypeId, activityTypeId))).limit(1)
    if (!sub) { fail(res, 404, 'errors.not_found'); return }
  }
  if (!(await isAssessmentVisibleToTeam(assessmentId, teamId))) { fail(res, 404, 'errors.not_found'); return }
  const sameSlot = and(
    eq(aiAssessmentAssignments.teamId, teamId),
    eq(aiAssessmentAssignments.activityTypeId, activityTypeId),
    subtypeId ? eq(aiAssessmentAssignments.subtypeId, subtypeId) : isNull(aiAssessmentAssignments.subtypeId),
  )
  const inSlot = await db.select({ assessmentId: aiAssessmentAssignments.assessmentId }).from(aiAssessmentAssignments).where(sameSlot)
  if (inSlot.some((r) => r.assessmentId === assessmentId)) { fail(res, 409, 'errors.ai_assessments.already_assigned'); return }
  if (inSlot.length >= AI_ASSESSMENT_MAX_PER_ACTIVITY) { fail(res, 400, 'errors.ai_assessments.too_many'); return }
  const [row] = await db.insert(aiAssessmentAssignments).values({ teamId, activityTypeId, subtypeId, assessmentId, createdBy: req.user!.id })
    .onConflictDoNothing().returning({ id: aiAssessmentAssignments.id })
  if (!row) { fail(res, 409, 'errors.ai_assessments.already_assigned'); return }
  await logAudit(req, { action: 'ai_assessment.assign', targetType: 'ai_assessment', targetId: assessmentId, meta: { teamId, activityTypeId, subtypeId } })
  res.status(201).json({ data: await listForTeam(teamId, req.user!.id), error: null, meta: { id: row.id } })
})

aiAssessmentsAdminRoutes.delete('/teams/:teamId/ai-assessment-assignments/:assignmentId', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const assignmentId = req.params['assignmentId'] as string
  const [row] = await db.delete(aiAssessmentAssignments)
    .where(and(eq(aiAssessmentAssignments.id, assignmentId), eq(aiAssessmentAssignments.teamId, teamId)))
    .returning()
  if (!row) { fail(res, 404, 'errors.not_found'); return }
  await logAudit(req, { action: 'ai_assessment.unassign', targetType: 'ai_assessment', targetId: row.assessmentId, meta: { teamId, activityTypeId: row.activityTypeId, subtypeId: row.subtypeId } })
  res.json({ data: await listForTeam(teamId, req.user!.id), error: null, meta: {} })
})
