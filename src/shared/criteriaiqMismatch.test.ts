import { describe, expect, it } from 'vitest'
import { findCriteriaIqMismatches, type ProjectComparable } from './criteriaiqMismatch.js'

const blank: ProjectComparable = { status: null, startDate: null, endDate: null, primaryEngineer: null }

describe('findCriteriaIqMismatches', () => {
  it('finds nothing when either side is blank', () => {
    expect(findCriteriaIqMismatches(blank, { status: 'Active', startDate: '2026-01-01', endDate: '2026-02-01', primaryEngineer: 'Ana' })).toEqual([])
    expect(findCriteriaIqMismatches({ ...blank, status: 'Active' }, { ...blank, status: '  ' })).toEqual([])
  })

  it('ignores case, spacing, underscores and hyphens in text fields', () => {
    expect(findCriteriaIqMismatches(
      { ...blank, status: 'In Progress', primaryEngineer: 'Ana Silva' },
      { ...blank, status: 'in_progress', primaryEngineer: ' ana silva ' },
    )).toEqual([])
  })

  it('compares dates by day, ignoring a time part', () => {
    expect(findCriteriaIqMismatches({ ...blank, startDate: '2026-03-04' }, { ...blank, startDate: '2026-03-04T00:00:00.000Z' })).toEqual([])
  })

  it('reports each disagreeing field with both values, primary first, dates as the day', () => {
    expect(findCriteriaIqMismatches(
      { status: 'Active', startDate: '2026-03-04', endDate: '2026-04-01', primaryEngineer: 'Ana' },
      { status: 'Completed', startDate: '2026-03-04', endDate: '2026-04-15T00:00:00.000Z', primaryEngineer: 'Ben' },
    )).toEqual([
      { field: 'status', primary: 'Active', criteriaiq: 'Completed' },
      { field: 'endDate', primary: '2026-04-01', criteriaiq: '2026-04-15' },
      { field: 'primaryEngineer', primary: 'Ana', criteriaiq: 'Ben' },
    ])
  })
})
