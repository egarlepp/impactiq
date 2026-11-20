import { describe, it, expect } from 'vitest'
import { summarizeAssessmentScores, type DashboardScoreRow } from './dashboard.js'

const row = (over: Partial<DashboardScoreRow>): DashboardScoreRow => ({
  activityId: crypto.randomUUID(), title: 'Call', startDatetime: new Date('2026-10-01T15:00:00Z'),
  ownerId: 'u1', ownerName: 'Ann', assessmentId: 'a1', assessmentName: 'Discovery', assessmentVersion: 1,
  currentVersion: 1, zeroed: 50, observed: 50, notObservedCount: 0, criteriaCount: 1,
  criteria: [{ criterionId: 'k1', name: 'Pain', weight: 10, level: 3, rationale: null, citations: [] }],
  runAt: new Date('2026-10-02T00:00:00Z'), ...over,
})

describe('summarizeAssessmentScores', () => {
  it('keeps a deleted assessment under its stored name, apart from a live one', () => {
    const out = summarizeAssessmentScores([
      row({}),
      row({ assessmentId: null, assessmentName: 'Old rubric', currentVersion: null }),
    ])
    expect(out.map((a) => [a.assessmentId, a.name, a.scoredCount, a.olderVersionCount])).toEqual([
      ['a1', 'Discovery', 1, 0],
      [null, 'Old rubric', 1, 0],
    ])
  })

  it('takes criterion names from the newest score and groups criteria with no id by name', () => {
    const out = summarizeAssessmentScores([
      row({ runAt: new Date('2026-10-01T00:00:00Z'), criteria: [{ criterionId: 'k1', name: 'Pain (old)', weight: 10, level: 2, rationale: null, citations: [] }] }),
      row({ runAt: new Date('2026-10-05T00:00:00Z'), criteria: [{ criterionId: 'k1', name: 'Pain', weight: 10, level: 4, rationale: null, citations: [] }] }),
      row({ criteria: [{ criterionId: null, name: 'Gone', weight: 5, level: null, rationale: null, citations: [] }], observed: null, notObservedCount: 1 }),
    ])
    expect(out[0]!.criteria).toEqual([
      { criterionId: 'k1', name: 'Pain', weight: 10, scoredCount: 2, observedCount: 2, avgLevel: 3 },
      { criterionId: 'name:Gone', name: 'Gone', weight: 5, scoredCount: 1, observedCount: 0, avgLevel: null },
    ])
    expect(out[0]!.avgObserved).toBe(50)
  })

  it('handles junk in the criteria snapshot', () => {
    expect(summarizeAssessmentScores([row({ criteria: null })])[0]!.criteria).toEqual([])
  })
})
