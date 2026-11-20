import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activityAiAssessmentScores, aiAssessments, gongCalls, users } from '../../../../drizzle/schema.js'
import type {
  AiAssessmentBlockedReason,
  AiAssessmentCriterionResult,
  AiAssessmentScore,
  AiAssessmentsActivityView,
} from '../../../shared/aiAssessments.js'
import { aiAvailability, runAi } from '../ai/gateway.js'
import {
  aiNotesSwitchedOn,
  condenseTranscripts,
  getAiNotesTeam,
  linkedCallIds,
  loadTranscriptCalls,
  teamOverLimit,
  type AskAi,
} from '../aiNotes/generate.js'
import { gongReadinessForTeam } from '../gong/demo.js'
import { canSeeAssessmentScores } from './access.js'
import { assessmentsForActivity, loadScoringActivity, scoreActivity, type ScoringActivity } from './score.js'

// The Assessments tab on the activity drawer and a Leader's Run assessment
// (v1.462.0). Both go through canSeeAssessmentScores(): Leaders only, never
// the activity's owner.

export interface AssessedActivity { id: string; userId: string; teamId: string; status: string; title: string }

const HIDDEN: AiAssessmentsActivityView = { visible: false, canRun: false, blockedReason: null, assigned: [], scores: [], calls: [] }

export async function activityScores(activityId: string): Promise<AiAssessmentScore[]> {
  const rows = await db.select({ score: activityAiAssessmentScores, runByName: users.displayName, currentVersion: aiAssessments.version })
    .from(activityAiAssessmentScores)
    .leftJoin(users, eq(users.id, activityAiAssessmentScores.runBy))
    .leftJoin(aiAssessments, eq(aiAssessments.id, activityAiAssessmentScores.assessmentId))
    .where(eq(activityAiAssessmentScores.activityId, activityId))
    .orderBy(desc(activityAiAssessmentScores.runAt))
  return rows.map(({ score, runByName, currentVersion }) => ({
    id: score.id,
    assessmentId: score.assessmentId,
    assessmentName: score.assessmentName,
    assessmentVersion: score.assessmentVersion,
    currentVersion: currentVersion ?? null,
    zeroed: score.zeroedScore,
    observed: score.observedScore,
    notObservedCount: score.notObservedCount,
    criteriaCount: score.criteriaCount,
    criteria: (Array.isArray(score.criteria) ? score.criteria : []) as AiAssessmentCriterionResult[],
    runAt: score.runAt.toISOString(),
    runByName: runByName ?? null,
    model: score.model,
  }))
}

// Why Run assessment can't run right now, or null. Cheap checks only (no
// Gong or AI call).
async function runBlockedReason(scoring: ScoringActivity, assignedCount: number, switchedOn: boolean, isDemo: boolean): Promise<AiAssessmentBlockedReason | null> {
  if (isDemo) return 'demo_data'
  if (assignedCount === 0) return 'none_assigned'
  if (!switchedOn) return 'unavailable'
  const availability = await aiAvailability('activity_ai_assessments')
  if (!availability.ok) return availability.reason === 'over_budget' ? 'over_budget' : 'unavailable'
  const team = await getAiNotesTeam(scoring.teamId)
  if (team && (await teamOverLimit(team))) return 'team_over_budget'
  const gongOn = (await gongReadinessForTeam(scoring.teamId)).ready
  if (!gongOn || (await linkedCallIds(scoring.id)).length === 0) return 'no_transcript'
  return null
}

/** The tab's state for this caller; HIDDEN for anyone who isn't a Leader of it. */
export async function buildAssessmentsView(callerId: string, act: AssessedActivity): Promise<AiAssessmentsActivityView> {
  if (!(await canSeeAssessmentScores(callerId, act))) return HIDDEN
  const scoring = await loadScoringActivity(act.id)
  if (!scoring) return HIDDEN
  const team = await getAiNotesTeam(act.teamId)
  const switchedOn = await aiNotesSwitchedOn(team)
  const rubrics = await assessmentsForActivity(scoring)
  const scores = await activityScores(act.id)
  if (scores.length === 0 && (rubrics.length === 0 || !switchedOn)) return HIDDEN
  const blockedReason = await runBlockedReason(scoring, rubrics.length, switchedOn, !!team?.isDemo)
  const citedIds = [...new Set(scores.flatMap((s) => s.criteria.flatMap((c) => c.citations.map((cite) => cite.kind === 'transcript' ? cite.callId : null))))]
    .filter((id): id is string => !!id)
  const calls = citedIds.length === 0 ? [] : await db.select({ id: gongCalls.id, url: gongCalls.url }).from(gongCalls).where(inArray(gongCalls.id, citedIds))
  return {
    visible: true,
    canRun: blockedReason === null,
    blockedReason,
    assigned: rubrics.map((r) => ({ assessmentId: r.id, name: r.name })),
    scores,
    calls,
  }
}

export type RunResult =
  | { ok: true; scored: number }
  | { ok: false; status: number; error: string }

const BLOCKED_ERROR: Record<AiAssessmentBlockedReason, { status: number; error: string }> = {
  demo_data: { status: 409, error: 'errors.ai_assessments.demo_data' },
  none_assigned: { status: 409, error: 'errors.ai_assessments.none_assigned' },
  unavailable: { status: 503, error: 'errors.ai_assessments.unavailable' },
  over_budget: { status: 503, error: 'errors.ai_assessments.over_budget' },
  team_over_budget: { status: 409, error: 'errors.ai_assessments.team_over_budget' },
  no_transcript: { status: 409, error: 'errors.ai_assessments.no_transcript' },
}

function aiError(result: Extract<Awaited<ReturnType<AskAi>>, { ok: false }>): { status: number; error: string } {
  if (result.reason === 'error' && result.message === 'team_over_budget') return BLOCKED_ERROR.team_over_budget
  if (result.reason === 'over_budget') return BLOCKED_ERROR.over_budget
  if (result.reason === 'disabled' || result.reason === 'no_provider') return BLOCKED_ERROR.unavailable
  return { status: 502, error: 'errors.ai_assessments.failed' }
}

/**
 * Run assessment: scores the activity against its assigned rubrics now.
 * Leaders only; the activity must have a linked Gong call with a transcript.
 * Thrown Gong errors (GongError) are left to the caller, which answers 502.
 */
export async function runAssessments(callerId: string, act: AssessedActivity): Promise<RunResult> {
  const view = await buildAssessmentsView(callerId, act)
  if (!view.visible) return { ok: false, status: 404, error: 'errors.not_found' }
  if (view.blockedReason) return { ok: false, ...BLOCKED_ERROR[view.blockedReason] }

  const scoring = await loadScoringActivity(act.id)
  const team = await getAiNotesTeam(act.teamId)
  if (!scoring || !team) return { ok: false, status: 404, error: 'errors.not_found' }
  const rubrics = await assessmentsForActivity(scoring)
  const calls = await loadTranscriptCalls(act.id)
  if (calls.length === 0) return { ok: false, ...BLOCKED_ERROR.no_transcript }

  const ask: AskAi = async (req) => {
    if (await teamOverLimit(team)) return { ok: false, reason: 'error', message: 'team_over_budget' }
    return runAi(req)
  }
  const source = await condenseTranscripts(calls, { feature: 'activity_ai_assessments', callerId, teamId: team.id, ask })
  if (!source.ok) return { ok: false, ...aiError(source.result) }
  const result = await scoreActivity({ activity: scoring, rubrics, calls, sourceText: source.sourceText, sourceIsSummary: source.sourceIsSummary, callerId, ask })
  if (result.ok) return { ok: true, scored: result.scored }
  if (result.reason === 'ai') return { ok: false, ...aiError(result.result) }
  if (result.reason === 'nothing_assigned') return { ok: false, ...BLOCKED_ERROR.none_assigned }
  return { ok: false, status: 502, error: 'errors.ai_assessments.failed' }
}

