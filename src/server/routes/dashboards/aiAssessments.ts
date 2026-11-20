import { Router } from 'express'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activityAiAssessmentScores, aiAssessments, users } from '../../../../drizzle/schema.js'
import { requireDashboardAccess } from '../../middleware/rbac.js'
import { assessmentScoreTeamIds } from '../../services/aiAssessments/access.js'
import { summarizeAssessmentScores } from '../../services/aiAssessments/dashboard.js'
import {
  dateWindow,
  parseDateBasis,
  parseMemberIds,
  parseProductIds,
  parseWeekShift,
  productFilterCond,
  resolveTeamScope,
  windowFor,
} from './shared.js'

export const aiAssessmentsDashRoutes = Router()

// GET /api/dashboards/ai-assessments?teamId=&weeks=&userIds=&productIds=
// AI Assessment Scores (v1.463.0): the scores Generate and Run assessment
// wrote, for submitted activities in scope, by the activity's date. Same
// visibility as the drawer's Assessments tab: Leaders with the
// activities.ai_assessments grant, and never the caller's own activities.
aiAssessmentsDashRoutes.get('/ai-assessments', requireDashboardAccess('aiAssessments'), async (req, res) => {
  const callerId = req.user!.id
  const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : undefined
  const inScope = (await resolveTeamScope(req, teamId)) ?? []
  if (inScope.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const teamIds = await assessmentScoreTeamIds(callerId, inScope)
  if (teamIds.length === 0) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }

  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const weeksBack = Number(req.query['weeks'] ?? 12)
  const { rangeStart, rangeEnd } = windowFor(req, Number.isFinite(weeksBack) ? weeksBack : 12, parseWeekShift(req.query['weekShift']))
  const memberIds = parseMemberIds(req.query['userIds'])
  const productCond = productFilterCond(parseProductIds(req.query['productIds']))

  const rows = await db
    .select({
      activityId: activities.id,
      title: activities.title,
      startDatetime: activities.startDatetime,
      ownerId: activities.userId,
      ownerName: users.displayName,
      assessmentId: activityAiAssessmentScores.assessmentId,
      assessmentName: activityAiAssessmentScores.assessmentName,
      assessmentVersion: activityAiAssessmentScores.assessmentVersion,
      currentVersion: aiAssessments.version,
      zeroed: activityAiAssessmentScores.zeroedScore,
      observed: activityAiAssessmentScores.observedScore,
      notObservedCount: activityAiAssessmentScores.notObservedCount,
      criteriaCount: activityAiAssessmentScores.criteriaCount,
      criteria: activityAiAssessmentScores.criteria,
      runAt: activityAiAssessmentScores.runAt,
    })
    .from(activityAiAssessmentScores)
    .innerJoin(activities, eq(activities.id, activityAiAssessmentScores.activityId))
    .innerJoin(users, eq(users.id, activities.userId))
    .leftJoin(aiAssessments, eq(aiAssessments.id, activityAiAssessmentScores.assessmentId))
    .where(and(
      inArray(activities.teamId, teamIds),
      eq(activities.status, 'submitted'), // CLAUDE.md §21: never draft on a leader dashboard
      eq(activities.isArchived, false),
      ne(activities.userId, callerId), // nobody sees scores on their own calls
      ...dateWindow(dateBasis, rangeStart, rangeEnd),
      ...(memberIds.length > 0 ? [inArray(activities.userId, memberIds)] : []),
      ...(productCond ? [productCond] : []),
    ))

  const assessments = summarizeAssessmentScores(rows.map((r) => ({ ...r, ownerName: r.ownerName ?? '—', currentVersion: r.currentVersion ?? null })))
  res.json({ data: assessments, error: null, meta: { scoredCount: rows.length } })
})
