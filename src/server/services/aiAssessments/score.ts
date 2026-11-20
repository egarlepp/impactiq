import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activities,
  activityAiAssessmentScores,
  aiAssessmentAssignments,
  aiAssessmentCriteria,
  aiAssessmentTeams,
  aiAssessments,
  teams,
} from '../../../../drizzle/schema.js'
import { cleanAnchors, resolveAssessmentIds, type AiAssessmentAnchors } from '../../../shared/aiAssessments.js'
import type { AiResult } from '../ai/gateway.js'
import type { PromptCall } from '../aiNotes/prompt.js'
// Type only: generate.ts imports this file.
import type { AskAi } from '../aiNotes/generate.js'
import {
  ASSESSMENT_JSON_SCHEMA,
  ASSESSMENT_SYSTEM_PROMPT,
  assessmentUserPrompt,
  parseAssessmentAnswer,
  type PromptRubric,
} from './prompt.js'

// Scores an activity against the AI Assessments assigned to its Activity
// Type / Subtype (v1.462.0). Runs from AI Notes Generate when a transcript
// was read, and from a Leader's Run assessment. One AI call scores every
// assigned rubric (at most AI_ASSESSMENT_MAX_PER_ACTIVITY); ImpactIQ
// computes both scores from the levels. A rerun replaces the activity's
// score for that rubric.

export interface ScoringActivity { id: string; teamId: string; title: string; activityTypeId: string | null; subtypeId: string | null }

export async function loadScoringActivity(activityId: string): Promise<ScoringActivity | null> {
  const [row] = await db.select({
    id: activities.id,
    teamId: activities.teamId,
    title: activities.title,
    activityTypeId: activities.activityTypeId,
    subtypeId: activities.subtypeId,
  }).from(activities).where(eq(activities.id, activityId)).limit(1)
  return row ?? null
}

/**
 * The active rubrics that run on this activity: its team's assignments for
 * its Activity Type (Subtype rows win, else type-wide rows), limited to
 * rubrics still shared with the team. In assignment order.
 */
export async function assessmentsForActivity(act: Pick<ScoringActivity, 'teamId' | 'activityTypeId' | 'subtypeId'>): Promise<PromptRubric[]> {
  if (!act.activityTypeId) return []
  const rows = await db.select({ subtypeId: aiAssessmentAssignments.subtypeId, assessmentId: aiAssessmentAssignments.assessmentId })
    .from(aiAssessmentAssignments)
    .innerJoin(aiAssessments, eq(aiAssessments.id, aiAssessmentAssignments.assessmentId))
    .innerJoin(aiAssessmentTeams, and(eq(aiAssessmentTeams.assessmentId, aiAssessments.id), eq(aiAssessmentTeams.teamId, act.teamId)))
    .where(and(
      eq(aiAssessmentAssignments.teamId, act.teamId),
      eq(aiAssessmentAssignments.activityTypeId, act.activityTypeId),
      eq(aiAssessments.isActive, true),
    ))
    .orderBy(asc(aiAssessmentAssignments.createdAt))
  if (rows.length === 0) return []
  const [team] = await db.select({ subtypesEnabled: teams.subtypesEnabled }).from(teams).where(eq(teams.id, act.teamId)).limit(1)
  const ids = resolveAssessmentIds(rows, act.subtypeId, !!team?.subtypesEnabled)
  if (ids.length === 0) return []
  const heads = await db.select().from(aiAssessments).where(inArray(aiAssessments.id, ids))
  const criteria = await db.select().from(aiAssessmentCriteria)
    .where(inArray(aiAssessmentCriteria.assessmentId, ids))
    .orderBy(asc(aiAssessmentCriteria.sortOrder))
  const byId = new Map(heads.map((h) => [h.id, h]))
  const out: PromptRubric[] = []
  for (const id of ids) {
    const head = byId.get(id)
    if (!head) continue
    const own = criteria.filter((c) => c.assessmentId === id)
    if (own.length === 0) continue
    out.push({
      id,
      name: head.name,
      description: head.description,
      version: head.version,
      criteria: own.map((c) => ({
        id: c.id,
        name: c.name,
        lookFor: c.lookFor,
        weight: c.weight,
        anchors: cleanAnchors(c.anchors as AiAssessmentAnchors),
      })),
    })
  }
  return out
}

export type ScoreResult =
  | { ok: true; scored: number }
  | { ok: false; reason: 'nothing_assigned' | 'bad_answer' }
  | { ok: false; reason: 'ai'; result: Extract<AiResult, { ok: false }> }

export async function scoreActivity(opts: {
  activity: ScoringActivity
  rubrics: PromptRubric[]
  calls: PromptCall[]
  sourceText: string
  sourceIsSummary: boolean
  callerId: string
  ask: AskAi
}): Promise<ScoreResult> {
  if (opts.rubrics.length === 0) return { ok: false, reason: 'nothing_assigned' }
  const result = await opts.ask({
    feature: 'activity_ai_assessments',
    system: ASSESSMENT_SYSTEM_PROMPT,
    user: assessmentUserPrompt({
      activityTitle: opts.activity.title,
      sourceText: opts.sourceText,
      sourceIsSummary: opts.sourceIsSummary,
      rubrics: opts.rubrics,
    }),
    maxTokens: 8000,
    requestedBy: opts.callerId,
    teamId: opts.activity.teamId,
    json: { name: 'ai_assessment', schema: ASSESSMENT_JSON_SCHEMA },
  })
  if (!result.ok) return { ok: false, reason: 'ai', result }
  const scored = parseAssessmentAnswer(result.text, opts.rubrics, new Map(opts.calls.map((c) => [c.label, c.callId])))
  if (!scored) return { ok: false, reason: 'bad_answer' }

  const gongCallIds = opts.calls.map((c) => c.callId)
  await db.transaction(async (tx) => {
    await tx.delete(activityAiAssessmentScores).where(and(
      eq(activityAiAssessmentScores.activityId, opts.activity.id),
      inArray(activityAiAssessmentScores.assessmentId, scored.map((s) => s.rubric.id)),
    ))
    await tx.insert(activityAiAssessmentScores).values(scored.map((s) => ({
      activityId: opts.activity.id,
      teamId: opts.activity.teamId,
      assessmentId: s.rubric.id,
      assessmentName: s.rubric.name,
      assessmentVersion: s.rubric.version,
      zeroedScore: s.scores.zeroed,
      observedScore: s.scores.observed,
      notObservedCount: s.scores.notObservedCount,
      criteriaCount: s.scores.criteriaCount,
      criteria: s.criteria,
      gongCallIds,
      providerId: result.providerId,
      model: result.model,
      runBy: opts.callerId,
    })))
  })
  return { ok: true, scored: scored.length }
}
