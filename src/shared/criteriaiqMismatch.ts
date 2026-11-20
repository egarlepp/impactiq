// Where the CRM Evaluation (primary) and its CriteriaIQ project (secondary)
// disagree on a field they both carry. The primary's value is the one ImpactIQ
// shows and stores; a mismatch is flagged on the drawer, never resolved
// silently (CLAUDE.md §9). A field either side leaves blank isn't a mismatch.

export type CriteriaIqMismatchField = 'status' | 'startDate' | 'endDate' | 'primaryEngineer'

export interface ProjectComparable {
  status: string | null
  startDate: string | null
  endDate: string | null
  primaryEngineer: string | null
}

export interface CriteriaIqMismatch {
  field: CriteriaIqMismatchField
  primary: string
  criteriaiq: string
}

// "In Progress", "in_progress" and "in-progress" are the same status.
function normalizeText(v: string): string {
  return v.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
}

// Both sides send dates as ISO strings, sometimes with a time part.
function normalizeDate(v: string): string {
  return v.trim().slice(0, 10)
}

export function findCriteriaIqMismatches(primary: ProjectComparable, criteriaiq: ProjectComparable): CriteriaIqMismatch[] {
  // [field, how to compare, how to show]: dates are shown as the day only.
  const fields: Array<[CriteriaIqMismatchField, (v: string) => string, (v: string) => string]> = [
    ['status', normalizeText, (v) => v.trim()],
    ['startDate', normalizeDate, normalizeDate],
    ['endDate', normalizeDate, normalizeDate],
    ['primaryEngineer', normalizeText, (v) => v.trim()],
  ]
  const out: CriteriaIqMismatch[] = []
  for (const [field, norm, show] of fields) {
    const a = primary[field]
    const b = criteriaiq[field]
    if (!a?.trim() || !b?.trim()) continue
    if (norm(a) !== norm(b)) out.push({ field, primary: show(a), criteriaiq: show(b) })
  }
  return out
}
