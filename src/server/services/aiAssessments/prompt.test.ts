import { describe, it, expect } from 'vitest'
import { assessmentUserPrompt, parseAssessmentAnswer, type PromptRubric } from './prompt.js'
import { decideAssessmentAccess } from './access.js'

const rubric = (id: string, weights: number[]): PromptRubric => ({
  id,
  name: `R ${id}`,
  description: null,
  version: 3,
  criteria: weights.map((w, i) => ({ id: `${id}-c${i}`, name: `Crit ${i}`, lookFor: null, weight: w, anchors: i === 0 ? { '1': 'Low', '5': 'High' } : {} })),
})

describe('AI Assessment prompt', () => {
  it('labels rubrics and criteria and lists only described levels', () => {
    const text = assessmentUserPrompt({ activityTitle: 'Acme', sourceText: '[C1 00:05] x', sourceIsSummary: false, rubrics: [rubric('a', [1, 2]), rubric('b', [1])] })
    expect(text).toContain('## Rubric A1: R a')
    expect(text).toContain('### A1.K2: Crit 1')
    expect(text).toContain('### A2.K1: Crit 0')
    expect(text).toContain('- Level 1: Low')
    expect(text).not.toContain('Level 3')
  })

  it('reads levels per rubric, treats missing or out-of-range levels as not observed, and keeps only known calls', () => {
    const calls = new Map([['C1', 'call-1']])
    const answer = JSON.stringify({
      criteria: [
        { criterion: 'a1.k1', level: 5, rationale: ' Clear figure. ', cites: ['C1@00:05', 'C1@00:05', 'C9@00:01', 'N1'] },
        { criterion: 'A1.K2', level: 9, rationale: 'Off scale', cites: ['C1@00:10'] },
        { criterion: 'A2.K1', level: '3', rationale: null, cites: [] },
      ],
    })
    const out = parseAssessmentAnswer(answer, [rubric('a', [3, 1]), rubric('b', [2])], calls)!
    expect(out[0]!.criteria.map((c) => c.level)).toEqual([5, null])
    expect(out[0]!.criteria[0]).toMatchObject({ criterionId: 'a-c0', weight: 3, rationale: 'Clear figure.', citations: [{ kind: 'transcript', callId: 'call-1', startMs: 5000 }] })
    expect(out[0]!.criteria[1]!.citations).toEqual([])
    expect(out[0]!.scores).toEqual({ zeroed: 75, observed: 100, notObservedCount: 1, criteriaCount: 2 })
    expect(out[1]!.scores).toMatchObject({ zeroed: 60, observed: 60 })
    expect(parseAssessmentAnswer('nope', [rubric('a', [1])], calls)).toBeNull()
  })
})

describe('decideAssessmentAccess', () => {
  const base = { isOwner: false, canView: true, isAppAdmin: false, leadsTeam: false, leadsAllTeams: false, hasGrant: true }
  it('never shows the owner their own scores, even an App Admin', () => {
    expect(decideAssessmentAccess({ ...base, isOwner: true, isAppAdmin: true })).toBe(false)
  })
  it('needs a Leader role on the team (or across all teams) plus the grant', () => {
    expect(decideAssessmentAccess(base)).toBe(false)
    expect(decideAssessmentAccess({ ...base, leadsTeam: true })).toBe(true)
    expect(decideAssessmentAccess({ ...base, leadsAllTeams: true })).toBe(true)
    expect(decideAssessmentAccess({ ...base, leadsTeam: true, hasGrant: false })).toBe(false)
    expect(decideAssessmentAccess({ ...base, leadsTeam: true, canView: false })).toBe(false)
    expect(decideAssessmentAccess({ ...base, isAppAdmin: true })).toBe(true)
  })
})
