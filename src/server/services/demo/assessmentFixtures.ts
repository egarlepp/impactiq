import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activityAiAssessmentScores,
  aiAssessmentAssignments,
  aiAssessmentCriteria,
  aiAssessments,
  aiAssessmentTeams,
} from '../../../../drizzle/schema.js'
import {
  AI_ASSESSMENT_MAX_LEVEL,
  computeAssessmentScores,
  type AiAssessmentAnchors,
  type AiAssessmentCriterionResult,
} from '../../../shared/aiAssessments.js'
import type { AiNoteCitation } from '../../../shared/aiNotes.js'

// Demo AI Assessments (v1.464.0): three sample rubrics on the demo team,
// assigned to Discovery, Demo and the evaluation type, and scores on the
// demo activities that have a linked Gong call, written as if the owner had
// generated AI Notes or a Leader had clicked Run assessment. Nothing here
// calls the AI, and the demo team still refuses a real run (demo_data).

interface CriterionFixture {
  name: string
  lookFor: string
  weight: number
  anchors: AiAssessmentAnchors
}

interface RubricFixture {
  name: string
  description: string
  icon: string
  iconColor: string
  // Activity type names; 'EVAL' stands for the evaluation type's current name.
  typeNames: string[]
  criteria: CriterionFixture[]
}

const RUBRICS: RubricFixture[] = [
  {
    name: 'Discovery Quality',
    icon: 'Search',
    iconColor: '#2563EB',
    description: 'How well a discovery call uncovered the customer’s situation and set up the next step.',
    typeNames: ['Discovery'],
    criteria: [
      { name: 'Business pain uncovered', lookFor: 'Questions that get to the cost or risk of the current situation.', weight: 30, anchors: { '1': 'No pain discussed.', '3': 'Pain named but not quantified.', '5': 'Pain quantified in the customer’s own terms.' } },
      { name: 'Current setup understood', lookFor: 'How they work today: tools, teams, volumes.', weight: 20, anchors: { '1': 'Current setup not explored.', '5': 'Clear picture of tools, teams and volumes.' } },
      { name: 'Decision process mapped', lookFor: 'Who decides, who signs, and when.', weight: 25, anchors: { '1': 'Decision process not raised.', '3': 'Decision maker named, steps unclear.', '5': 'People, steps and dates confirmed.' } },
      { name: 'Clear next step agreed', lookFor: 'A dated next step both sides accepted.', weight: 25, anchors: { '1': 'Call ended with no next step.', '5': 'Dated next step agreed by the customer.' } },
    ],
  },
  {
    name: 'Demo Effectiveness',
    icon: 'Presentation',
    iconColor: '#7C3AED',
    description: 'Whether a demo stayed on the customer’s needs and moved the deal forward.',
    typeNames: ['Demo'],
    criteria: [
      { name: 'Tailored to stated needs', lookFor: 'The demo follows the requirements raised in discovery.', weight: 30, anchors: { '1': 'Generic tour of features.', '5': 'Every section maps to a stated need.' } },
      { name: 'Value tied to outcomes', lookFor: 'Features linked to the customer’s business results.', weight: 25, anchors: { '1': 'Features only, no outcomes.', '5': 'Each feature tied to a result they care about.' } },
      { name: 'Questions handled well', lookFor: 'Clear, accurate answers to technical questions.', weight: 20, anchors: { '1': 'Questions dodged or answered wrongly.', '5': 'Questions answered clearly, with follow-ups noted.' } },
      { name: 'Next step agreed', lookFor: 'An agreed path to evaluation or decision.', weight: 25, anchors: { '1': 'No next step.', '5': 'Evaluation or decision step agreed with a date.' } },
    ],
  },
  {
    name: 'Evaluation Progress',
    icon: 'FlaskConical',
    iconColor: '#059669',
    description: 'How well an evaluation call tracked success criteria and risks.',
    typeNames: ['EVAL'],
    criteria: [
      { name: 'Success criteria tracked', lookFor: 'Progress against each agreed success criterion.', weight: 35, anchors: { '1': 'Success criteria not mentioned.', '5': 'Each criterion reviewed with its status.' } },
      { name: 'Risks raised early', lookFor: 'Blockers named with an owner and a date.', weight: 25, anchors: { '1': 'Risks not discussed.', '5': 'Each risk has an owner and a date.' } },
      { name: 'Stakeholders engaged', lookFor: 'The right people on the call or briefed after it.', weight: 20, anchors: { '1': 'Only one contact involved.', '5': 'Technical and business stakeholders engaged.' } },
      { name: 'Clear next step', lookFor: 'A dated next step toward a decision.', weight: 20, anchors: { '1': 'No next step.', '5': 'Dated next step toward a decision.' } },
    ],
  },
]

const RATIONALE: Record<number, string> = {
  1: 'Barely came up on the call.',
  2: 'Touched on briefly, without follow-through.',
  3: 'Covered, with some gaps left open.',
  4: 'Covered well, with one small gap.',
  5: 'Covered fully and confirmed by the customer.',
}

export interface DemoAssessmentRubric {
  id: string
  name: string
  version: number
  typeNames: string[]
  criteria: Array<{ id: string; name: string; weight: number }>
}

/** Creates the sample rubrics on the demo team and assigns them by type name. */
export async function seedDemoAssessments(opts: {
  teamId: string
  adminUserId: string
  types: Array<{ id: string; name: string }>
  evalWork: string
  // Settings Profile id by assessment name (profileFixtures.ts).
  profileIdByName?: Map<string, string>
}): Promise<DemoAssessmentRubric[]> {
  const typeIdByName = new Map(opts.types.map((t) => [t.name, t.id]))
  const out: DemoAssessmentRubric[] = []
  for (const r of RUBRICS) {
    const typeNames = r.typeNames.map((n) => (n === 'EVAL' ? opts.evalWork : n)).filter((n) => typeIdByName.has(n))
    if (typeNames.length === 0) continue
    const [row] = await db.insert(aiAssessments).values({
      teamId: opts.teamId,
      name: r.name,
      description: r.description,
      icon: r.icon,
      iconColor: r.iconColor,
      aiNoteProfileId: opts.profileIdByName?.get(r.name) ?? null,
      createdBy: opts.adminUserId,
      updatedBy: opts.adminUserId,
    }).returning({ id: aiAssessments.id, version: aiAssessments.version })
    if (!row) continue
    await db.insert(aiAssessmentTeams).values({ assessmentId: row.id, teamId: opts.teamId })
    const criteria = await db.insert(aiAssessmentCriteria).values(r.criteria.map((c, i) => ({
      assessmentId: row.id,
      name: c.name,
      lookFor: c.lookFor,
      weight: c.weight,
      anchors: c.anchors,
      sortOrder: i,
    }))).returning({ id: aiAssessmentCriteria.id, name: aiAssessmentCriteria.name, weight: aiAssessmentCriteria.weight, sortOrder: aiAssessmentCriteria.sortOrder })
    await db.insert(aiAssessmentAssignments).values(typeNames.map((n) => ({
      teamId: opts.teamId,
      activityTypeId: typeIdByName.get(n)!,
      subtypeId: null,
      assessmentId: row.id,
      createdBy: opts.adminUserId,
    })))
    out.push({
      id: row.id,
      name: r.name,
      version: row.version,
      typeNames,
      criteria: criteria.sort((a, b) => a.sortOrder - b.sortOrder).map((c) => ({ id: c.id, name: c.name, weight: c.weight })),
    })
  }
  return out
}

export interface DemoScoreTarget {
  activityId: string
  userId: string
  typeName: string
  callId: string
  // Transcript offsets (ms) the citations can point at.
  citeMs: number[]
  // The owner when AI Notes scored it, else the Leader who clicked Run.
  runBy: string
  runAt: Date
}

export type DemoScoreRow = typeof activityAiAssessmentScores.$inferInsert

/**
 * One score per scored activity and rubric. Each person gets a steady skill
 * level, so the dashboard's per-person rows differ in a believable way, and
 * about one criterion in eight is left not observed.
 */
export function buildDemoAssessmentScores(opts: {
  teamId: string
  rubrics: DemoAssessmentRubric[]
  targets: DemoScoreTarget[]
  model: string
  rnd: () => number
}): DemoScoreRow[] {
  const { rnd } = opts
  const skill = new Map<string, number>()
  const rows: DemoScoreRow[] = []
  for (const t of opts.targets) {
    const rubric = opts.rubrics.find((r) => r.typeNames.includes(t.typeName))
    if (!rubric) continue
    if (!skill.has(t.userId)) skill.set(t.userId, rnd() * 2 - 1)
    const bias = skill.get(t.userId)!
    const criteria: AiAssessmentCriterionResult[] = rubric.criteria.map((c) => {
      const observed = rnd() >= 0.12
      const level = observed
        ? Math.min(AI_ASSESSMENT_MAX_LEVEL, Math.max(1, Math.round(3.2 + bias * 1.3 + (rnd() * 2 - 1))))
        : null
      const at = t.citeMs.length > 0 ? t.citeMs[Math.floor(rnd() * t.citeMs.length)]! : 0
      const citations: AiNoteCitation[] = level === null ? [] : [{ kind: 'transcript', callId: t.callId, startMs: at }]
      return {
        criterionId: c.id,
        name: c.name,
        weight: c.weight,
        level,
        rationale: level === null ? null : RATIONALE[level]!,
        citations,
      }
    })
    const scores = computeAssessmentScores(criteria)
    rows.push({
      activityId: t.activityId,
      teamId: opts.teamId,
      assessmentId: rubric.id,
      assessmentName: rubric.name,
      assessmentVersion: rubric.version,
      zeroedScore: scores.zeroed,
      observedScore: scores.observed,
      notObservedCount: scores.notObservedCount,
      criteriaCount: scores.criteriaCount,
      criteria,
      gongCallIds: [t.callId],
      providerId: null,
      model: opts.model,
      runBy: t.runBy,
      runAt: t.runAt,
    })
  }
  return rows
}

export async function seedDemoAssessmentScores(rows: DemoScoreRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(activityAiAssessmentScores).values(rows.slice(i, i + 500)).onConflictDoNothing()
  }
}

/** Rubrics created on the demo team (scores and assignments go with them). */
export async function removeDemoAssessments(demoTeamId: string): Promise<void> {
  await db.delete(aiAssessments).where(eq(aiAssessments.teamId, demoTeamId))
}
