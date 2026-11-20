import type {
  AiAssessmentCriterionResult,
  AiAssessmentDashboardActivity,
  AiAssessmentDashboardAssessment,
  AiAssessmentDashboardCriterion,
  AiAssessmentDashboardPerson,
} from '../../../shared/aiAssessments.js'
import { AI_ASSESSMENT_DASHBOARD_MAX_ACTIVITIES } from '../../../shared/aiAssessments.js'

// Pure aggregation for the AI Assessment Scores dashboard (v1.463.0). The
// route reads the score rows (submitted, in scope, never the caller's own)
// and this turns them into one block per assessment.

export interface DashboardScoreRow {
  activityId: string
  title: string
  startDatetime: Date
  ownerId: string
  ownerName: string
  assessmentId: string | null
  assessmentName: string
  assessmentVersion: number
  currentVersion: number | null
  zeroed: number
  observed: number | null
  notObservedCount: number
  criteriaCount: number
  criteria: unknown
  runAt: Date
}

const round0 = (n: number) => Math.round(n)
const round1 = (n: number) => Math.round(n * 10) / 10

function avg(values: readonly number[], round: (n: number) => number): number | null {
  if (values.length === 0) return null
  return round(values.reduce((a, b) => a + b, 0) / values.length)
}

function criteriaOf(row: DashboardScoreRow): AiAssessmentCriterionResult[] {
  return Array.isArray(row.criteria) ? (row.criteria as AiAssessmentCriterionResult[]) : []
}

function summarizeRows(rows: DashboardScoreRow[]): Pick<AiAssessmentDashboardPerson, 'scoredCount' | 'avgZeroed' | 'avgObserved' | 'avgNotObserved'> {
  return {
    scoredCount: rows.length,
    avgZeroed: avg(rows.map((r) => r.zeroed), round0),
    avgObserved: avg(rows.flatMap((r) => (r.observed === null ? [] : [r.observed])), round0),
    avgNotObserved: avg(rows.map((r) => r.notObservedCount), round1) ?? 0,
  }
}

export function summarizeAssessmentScores(input: readonly DashboardScoreRow[]): AiAssessmentDashboardAssessment[] {
  // Newest score first, so names (assessment and criterion) come from the latest snapshot.
  const rows = [...input].sort((a, b) => b.runAt.getTime() - a.runAt.getTime())
  const groups = new Map<string, DashboardScoreRow[]>()
  for (const r of rows) {
    const key = r.assessmentId ?? `name:${r.assessmentName}`
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }

  const out: AiAssessmentDashboardAssessment[] = []
  for (const group of groups.values()) {
    const head = group[0]!
    const byPerson = new Map<string, DashboardScoreRow[]>()
    for (const r of group) {
      const list = byPerson.get(r.ownerId)
      if (list) list.push(r)
      else byPerson.set(r.ownerId, [r])
    }
    const people: AiAssessmentDashboardPerson[] = [...byPerson.entries()].map(([userId, own]) => ({
      userId,
      name: own[0]!.ownerName,
      ...summarizeRows(own),
    }))
    people.sort((a, b) => (b.avgZeroed ?? -1) - (a.avgZeroed ?? -1) || a.name.localeCompare(b.name))

    const criteria = new Map<string, AiAssessmentDashboardCriterion & { levels: number[] }>()
    for (const r of group) {
      for (const c of criteriaOf(r)) {
        const key = c.criterionId ?? `name:${c.name}`
        let entry = criteria.get(key)
        if (!entry) {
          entry = { criterionId: key, name: c.name, weight: c.weight, scoredCount: 0, observedCount: 0, avgLevel: null, levels: [] }
          criteria.set(key, entry)
        }
        entry.scoredCount += 1
        if (typeof c.level === 'number') {
          entry.observedCount += 1
          entry.levels.push(c.level)
        }
      }
    }

    const activities: AiAssessmentDashboardActivity[] = [...group]
      .sort((a, b) => b.startDatetime.getTime() - a.startDatetime.getTime())
      .slice(0, AI_ASSESSMENT_DASHBOARD_MAX_ACTIVITIES)
      .map((r) => ({
        activityId: r.activityId,
        title: r.title,
        startDatetime: r.startDatetime.toISOString(),
        ownerName: r.ownerName,
        zeroed: r.zeroed,
        observed: r.observed,
        notObservedCount: r.notObservedCount,
        criteriaCount: r.criteriaCount,
        assessmentVersion: r.assessmentVersion,
      }))

    out.push({
      assessmentId: head.assessmentId,
      name: head.assessmentName,
      currentVersion: head.currentVersion,
      ...summarizeRows(group),
      olderVersionCount: head.currentVersion === null ? 0 : group.filter((r) => r.assessmentVersion < head.currentVersion!).length,
      people,
      criteria: [...criteria.values()].map(({ levels, ...c }) => ({ ...c, avgLevel: avg(levels, round1) })),
      activities,
    })
  }
  out.sort((a, b) => b.scoredCount - a.scoredCount || a.name.localeCompare(b.name))
  return out
}
