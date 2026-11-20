// Shared work-week validation. Used by:
//  - `PATCH /auth/me/work-week` (server) → to reject invalid submissions
//  - `WorkWeekCard` on Settings (client) → to gate the Save button
//  - Admin `POST/PATCH /api/admin/users` (server) → to reject invalid admin edits
//
// Returns null on success or an i18n key on failure. The i18n key must exist in
// every locale under `errors.workweek.*`.

export type WorkerType = 'full_time' | 'part_time' | 'contractor'

export const WORKER_TYPES: readonly WorkerType[] = ['full_time', 'part_time', 'contractor'] as const

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

const DAY_BITS: { key: DayKey; bit: number }[] = [
  { key: 'mon', bit: 1 },
  { key: 'tue', bit: 2 },
  { key: 'wed', bit: 4 },
  { key: 'thu', bit: 8 },
  { key: 'fri', bit: 16 },
  { key: 'sat', bit: 32 },
  { key: 'sun', bit: 64 },
]

export interface WorkWeekInput {
  workerType: WorkerType
  workDays: number
  workDayStartHour: number
  workDayEndHour: number
  workHoursPerDay?: Partial<Record<DayKey, { start: number; end: number }>> | null
}

function popcount(n: number): number {
  let c = 0
  let x = n & 0x7f
  while (x) { c += x & 1; x >>= 1 }
  return c
}

export function validateWorkWeek(w: WorkWeekInput): string | null {
  if (!WORKER_TYPES.includes(w.workerType)) return 'errors.workweek.invalid_worker_type'
  const enabledDays = popcount(w.workDays)
  if (enabledDays === 0) return 'errors.workweek.need_days'
  if (w.workDayEndHour <= w.workDayStartHour) return 'errors.workweek.end_after_start'
  if (w.workHoursPerDay) {
    for (const { key, bit } of DAY_BITS) {
      if ((w.workDays & bit) === 0) continue
      const d = w.workHoursPerDay[key]
      if (d && d.end <= d.start) return 'errors.workweek.end_after_start'
    }
  }

  // Full-time used to require exactly 5 days and 45 total hours. That
  // conflicted with per-user variability (compressed weeks, 4-day full
  // time, region-specific totals). Expected weekly hours are now
  // authoritative in Capacity Groups (§12); worker type is a
  // classification label here — no structural constraint beyond the
  // shared "at least one day" / "end after start" rules above.
  return null
}

export function workWeekEquals(a: WorkWeekInput, b: WorkWeekInput): boolean {
  if (a.workerType !== b.workerType) return false
  if (a.workDays !== b.workDays) return false
  if (a.workDayStartHour !== b.workDayStartHour) return false
  if (a.workDayEndHour !== b.workDayEndHour) return false
  const aH = a.workHoursPerDay ?? null
  const bH = b.workHoursPerDay ?? null
  if (!aH && !bH) return true
  if (!aH || !bH) return false
  const keys = new Set([...Object.keys(aH), ...Object.keys(bH)]) as Set<DayKey>
  for (const k of keys) {
    const av = aH[k]
    const bv = bH[k]
    if (!av || !bv) return false
    if (av.start !== bv.start || av.end !== bv.end) return false
  }
  return true
}
