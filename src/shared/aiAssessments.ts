import { z } from 'zod'
import type { AiNoteCitation } from './aiNotes.js'

// AI Assessments (v1.461.0): scored rubrics a team defines on Admin →
// Activities & Rules → AI Assessments and assigns to Activity Types and
// Subtypes. AI Notes scores the assigned rubrics when a Gong transcript was
// read, and only Leaders see the scores. Shared by the admin page, the
// server routes and (next) AI Notes generation and the leader dashboard.

// Every criterion is scored on the same 1-5 scale.
export const AI_ASSESSMENT_LEVELS = [1, 2, 3, 4, 5] as const
export type AiAssessmentLevel = typeof AI_ASSESSMENT_LEVELS[number]
export const AI_ASSESSMENT_MAX_LEVEL = 5

// Limits that keep a rubric, and the AI call that scores it, bounded.
export const AI_ASSESSMENT_MAX_CRITERIA = 20
export const AI_ASSESSMENT_MAX_WEIGHT = 100
// At most this many rubrics run on one activity.
export const AI_ASSESSMENT_MAX_PER_ACTIVITY = 3

// What each score level means for one criterion. Any level may be blank;
// levels 1 and 5 are the ones the admin page asks for first.
export type AiAssessmentAnchors = Partial<Record<'1' | '2' | '3' | '4' | '5', string>>

export interface AiAssessmentCriterion {
  id: string
  name: string
  lookFor: string | null
  weight: number
  anchors: AiAssessmentAnchors
  sortOrder: number
}

export interface AiAssessment {
  id: string
  // The team that created it (null when that team was deleted).
  homeTeamId: string | null
  name: string
  description: string | null
  // Lucide icon name and #rrggbb color (v1.465.0); null = defaults.
  icon: string | null
  iconColor: string | null
  // AI Note profile whose sections this assessment adds (v1.466.0).
  aiNoteProfileId: string | null
  aiNoteProfileName: string | null
  isActive: boolean
  isLocked: boolean
  version: number
  teamIds: string[]
  criteria: AiAssessmentCriterion[]
  // Assignments on the team the list was read for.
  assignmentCount: number
  updatedAt: string
  updatedByName: string | null
}

export interface AiAssessmentAssignment {
  id: string
  activityTypeId: string
  // null = every Subtype of the type that has no row of its own.
  subtypeId: string | null
  assessmentId: string
}

// Admin list response: rubrics visible to the team, plus whether the caller
// may lock/unlock (App Admins only).
export interface AiAssessmentsAdminView {
  assessments: AiAssessment[]
  assignments: AiAssessmentAssignment[]
  canLock: boolean
}

const anchorText = z.string().trim().max(300)

export const aiAssessmentAnchorsSchema = z.object({
  '1': anchorText.optional(),
  '2': anchorText.optional(),
  '3': anchorText.optional(),
  '4': anchorText.optional(),
  '5': anchorText.optional(),
}).strict()

export const aiAssessmentCriterionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  lookFor: z.string().trim().max(1000).nullable().optional(),
  weight: z.number().int().min(1).max(AI_ASSESSMENT_MAX_WEIGHT),
  anchors: aiAssessmentAnchorsSchema.default({}),
}).strict()
export type AiAssessmentCriterionInput = z.infer<typeof aiAssessmentCriterionInputSchema>

export const aiAssessmentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  icon: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/).nullable().optional(),
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  aiNoteProfileId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  isLocked: z.boolean().optional(),
  teamIds: z.array(z.string().uuid()).min(1).max(200).optional(),
  criteria: z.array(aiAssessmentCriterionInputSchema).min(1).max(AI_ASSESSMENT_MAX_CRITERIA),
}).strict()
export type AiAssessmentInput = z.infer<typeof aiAssessmentInputSchema>

export const aiAssessmentPatchSchema = aiAssessmentInputSchema.partial().strict()
export type AiAssessmentPatch = z.infer<typeof aiAssessmentPatchSchema>

export const aiAssessmentAssignmentInputSchema = z.object({
  activityTypeId: z.string().uuid(),
  subtypeId: z.string().uuid().nullable(),
  assessmentId: z.string().uuid(),
}).strict()

/** Drops blank anchors so a stored rubric only carries levels with text. */
export function cleanAnchors(anchors: Readonly<Partial<Record<keyof AiAssessmentAnchors, string | undefined>>> | null | undefined): AiAssessmentAnchors {
  const out: AiAssessmentAnchors = {}
  if (!anchors) return out
  for (const level of AI_ASSESSMENT_LEVELS) {
    const key = String(level) as keyof AiAssessmentAnchors
    const text = anchors[key]?.trim()
    if (text) out[key] = text
  }
  return out
}

// ---- Scoring ----------------------------------------------------------------

export interface CriterionScoreInput {
  weight: number
  // null = not observed on the call.
  level: number | null
}

export interface AssessmentScores {
  // 0-100. Not-observed criteria count as zero.
  zeroed: number
  // 0-100 over the observed criteria only; null when nothing was observed.
  observed: number | null
  notObservedCount: number
  criteriaCount: number
}

function isLevel(level: number | null): level is number {
  return level !== null && Number.isInteger(level) && level >= 1 && level <= AI_ASSESSMENT_MAX_LEVEL
}

/**
 * The two scores Leaders see for one rubric. ImpactIQ computes them from the
 * AI's per-criterion levels, never asks the AI for a total. A level outside
 * 1-5 is treated as not observed.
 */
export function computeAssessmentScores(criteria: readonly CriterionScoreInput[]): AssessmentScores {
  let earned = 0
  let possibleAll = 0
  let possibleObserved = 0
  let notObserved = 0
  for (const c of criteria) {
    const weight = Math.max(0, c.weight)
    possibleAll += weight * AI_ASSESSMENT_MAX_LEVEL
    if (isLevel(c.level)) {
      earned += weight * c.level
      possibleObserved += weight * AI_ASSESSMENT_MAX_LEVEL
    } else {
      notObserved += 1
    }
  }
  return {
    zeroed: possibleAll > 0 ? Math.round((earned / possibleAll) * 100) : 0,
    observed: possibleObserved > 0 ? Math.round((earned / possibleObserved) * 100) : null,
    notObservedCount: notObserved,
    criteriaCount: criteria.length,
  }
}

// ---- Which rubrics run on an activity ---------------------------------------

export interface AssignmentRow {
  subtypeId: string | null
  assessmentId: string
}

/**
 * Rubrics for one activity, from its team's assignments for its Activity
 * Type: rows for the activity's own Subtype win; otherwise the type-wide
 * rows (subtype null). Subtype rows are ignored when the team has Subtypes
 * off. Capped at AI_ASSESSMENT_MAX_PER_ACTIVITY, in the order given.
 */
export function resolveAssessmentIds(
  rows: readonly AssignmentRow[],
  activitySubtypeId: string | null,
  subtypesEnabled: boolean,
): string[] {
  const own = subtypesEnabled && activitySubtypeId
    ? rows.filter((r) => r.subtypeId === activitySubtypeId)
    : []
  const chosen = own.length > 0 ? own : rows.filter((r) => r.subtypeId === null)
  const ids: string[] = []
  for (const r of chosen) {
    if (!ids.includes(r.assessmentId)) ids.push(r.assessmentId)
    if (ids.length >= AI_ASSESSMENT_MAX_PER_ACTIVITY) break
  }
  return ids
}

// ---- Scores on an activity (v1.462.0) ---------------------------------------

/** One criterion as scored on one activity, from the rubric snapshot. */
export interface AiAssessmentCriterionResult {
  // The criterion's id when it was scored (gone if the rubric was edited since).
  criterionId: string | null
  name: string
  weight: number
  // null = not observed on the call.
  level: number | null
  rationale: string | null
  citations: AiNoteCitation[]
}

export interface AiAssessmentScore {
  id: string
  assessmentId: string | null
  assessmentName: string
  assessmentVersion: number
  // The rubric's version now; null once it was deleted. Differs from
  // assessmentVersion when the rubric changed after this score.
  currentVersion: number | null
  zeroed: number
  observed: number | null
  notObservedCount: number
  criteriaCount: number
  criteria: AiAssessmentCriterionResult[]
  runAt: string
  runByName: string | null
  model: string | null
}

export const AI_ASSESSMENT_BLOCKED_REASONS = [
  'none_assigned',
  'no_transcript',
  'unavailable',
  'over_budget',
  'team_over_budget',
  'demo_data',
] as const
export type AiAssessmentBlockedReason = typeof AI_ASSESSMENT_BLOCKED_REASONS[number]

/** The Assessments tab on the activity drawer (Leaders only). */
export interface AiAssessmentsActivityView {
  // false hides the tab.
  visible: boolean
  canRun: boolean
  blockedReason: AiAssessmentBlockedReason | null
  // Rubrics that run on this activity now (by its Type and Subtype).
  assigned: Array<{ assessmentId: string; name: string }>
  scores: AiAssessmentScore[]
  // Gong links for the calls the scores cite.
  calls: Array<{ id: string; url: string | null }>
}

// ─── AI Assessment Scores dashboard (v1.463.0) ───────────────────────────
// Leader dashboard over activity_ai_assessment_scores: one block per
// assessment, with the team's averages, a row per person, the average level
// per criterion and the scored activities. The caller's own activities are
// never included (nobody sees scores on their own calls).

export interface AiAssessmentDashboardPerson {
  userId: string
  name: string
  scoredCount: number
  avgZeroed: number | null
  avgObserved: number | null
  avgNotObserved: number
}

export interface AiAssessmentDashboardCriterion {
  criterionId: string
  name: string
  weight: number
  /** Scored activities whose rubric snapshot had this criterion. */
  scoredCount: number
  /** Of those, how many were observed (got a level). */
  observedCount: number
  /** Average level (1–5) over observed only; null when never observed. */
  avgLevel: number | null
}

export interface AiAssessmentDashboardActivity {
  activityId: string
  title: string
  startDatetime: string
  ownerName: string
  zeroed: number
  observed: number | null
  notObservedCount: number
  criteriaCount: number
  assessmentVersion: number
}

export interface AiAssessmentDashboardAssessment {
  /** Null once the assessment was deleted; its scores still show under the stored name. */
  assessmentId: string | null
  name: string
  currentVersion: number | null
  scoredCount: number
  avgZeroed: number | null
  avgObserved: number | null
  avgNotObserved: number
  /** Scores taken on an earlier version of the rubric than the current one. */
  olderVersionCount: number
  people: AiAssessmentDashboardPerson[]
  criteria: AiAssessmentDashboardCriterion[]
  activities: AiAssessmentDashboardActivity[]
}

export const AI_ASSESSMENT_DASHBOARD_MAX_ACTIVITIES = 100
