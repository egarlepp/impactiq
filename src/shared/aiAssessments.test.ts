import { describe, it, expect } from 'vitest'
import { cleanAnchors, computeAssessmentScores, resolveAssessmentIds, AI_ASSESSMENT_MAX_PER_ACTIVITY } from './aiAssessments.js'

describe('computeAssessmentScores', () => {
  it('matches the worked example: 59 with not-observed zeroed, 74 over observed only', () => {
    const scores = computeAssessmentScores([
      { weight: 25, level: 4 },
      { weight: 25, level: 3 },
      { weight: 20, level: 5 },
      { weight: 20, level: null },
      { weight: 10, level: 2 },
    ])
    expect(scores).toEqual({ zeroed: 59, observed: 74, notObservedCount: 1, criteriaCount: 5 })
  })

  it('gives both scores 100 when every criterion is a 5', () => {
    expect(computeAssessmentScores([{ weight: 3, level: 5 }, { weight: 7, level: 5 }]))
      .toEqual({ zeroed: 100, observed: 100, notObservedCount: 0, criteriaCount: 2 })
  })

  it('has no observed score when nothing was observed', () => {
    expect(computeAssessmentScores([{ weight: 10, level: null }]))
      .toEqual({ zeroed: 0, observed: null, notObservedCount: 1, criteriaCount: 1 })
  })

  it('treats an out-of-range level as not observed', () => {
    const s = computeAssessmentScores([{ weight: 10, level: 7 }, { weight: 10, level: 0 }, { weight: 10, level: 2.5 }, { weight: 10, level: 5 }])
    expect(s.notObservedCount).toBe(3)
    expect(s.observed).toBe(100)
    expect(s.zeroed).toBe(25)
  })

  it('handles an empty rubric', () => {
    expect(computeAssessmentScores([])).toEqual({ zeroed: 0, observed: null, notObservedCount: 0, criteriaCount: 0 })
  })
})

describe('resolveAssessmentIds', () => {
  const rows = [
    { subtypeId: null, assessmentId: 'type-wide' },
    { subtypeId: 'sub-a', assessmentId: 'a-only' },
    { subtypeId: 'sub-a', assessmentId: 'a-second' },
  ]

  it('uses the Subtype rows when the activity has that Subtype', () => {
    expect(resolveAssessmentIds(rows, 'sub-a', true)).toEqual(['a-only', 'a-second'])
  })

  it('falls back to the type-wide rows for another Subtype or none', () => {
    expect(resolveAssessmentIds(rows, 'sub-b', true)).toEqual(['type-wide'])
    expect(resolveAssessmentIds(rows, null, true)).toEqual(['type-wide'])
  })

  it('ignores Subtype rows when the team has Subtypes off', () => {
    expect(resolveAssessmentIds(rows, 'sub-a', false)).toEqual(['type-wide'])
  })

  it('caps the number of rubrics and drops duplicates', () => {
    const many = ['x', 'x', 'y', 'z', 'w'].map((id) => ({ subtypeId: null, assessmentId: id }))
    const ids = resolveAssessmentIds(many, null, true)
    expect(ids).toEqual(['x', 'y', 'z'])
    expect(ids.length).toBe(AI_ASSESSMENT_MAX_PER_ACTIVITY)
  })

  it('returns nothing when the type has no assignment', () => {
    expect(resolveAssessmentIds([], 'sub-a', true)).toEqual([])
  })
})

describe('cleanAnchors', () => {
  it('keeps only levels with text', () => {
    expect(cleanAnchors({ '1': '  none ', '3': '', '5': 'full' })).toEqual({ '1': 'none', '5': 'full' })
    expect(cleanAnchors(null)).toEqual({})
  })
})
