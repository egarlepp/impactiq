import { ymdInTZ, wallClockInTZ } from './tz.js'
import type { SchedUser, SchedBlock } from '../hooks/useSchedulingWeek.js'

export interface PositionedBlock {
  startMin: number
  endMin: number
  color: string | null
  subject?: string
  key: string
  // v1.263.0: see SchedBlock — passed through so the grid can render the
  // lock icon / masked title and the tentative hatch pattern.
  isPrivate?: boolean
  isTentative?: boolean
}

// Minutes-from-midnight range of a block in the viewer's timezone,
// clamped to a single day (blocks are bucketed per day by start).
export function blockMinutes(b: SchedBlock, tz: string | null): { startMin: number; endMin: number } {
  const s = wallClockInTZ(b.start, tz)
  const e = wallClockInTZ(b.end, tz)
  const startMin = s.hour * 60 + s.minute
  let endMin = e.hour * 60 + e.minute
  // All-day or cross-midnight → clamp to end of day for display.
  if (b.isAllDay || endMin <= startMin) endMin = Math.min(24 * 60, startMin + 60)
  return { startMin, endMin }
}

// Free intervals (in minutes) for one user on one day within [dayStart,
// dayEnd], given their busy blocks that day. PTO days return no free time.
export function freeIntervals(busy: Array<{ startMin: number; endMin: number }>, dayStartMin: number, dayEndMin: number): Array<{ startMin: number; endMin: number }> {
  const sorted = [...busy].sort((a, b) => a.startMin - b.startMin)
  const free: Array<{ startMin: number; endMin: number }> = []
  let cursor = dayStartMin
  for (const blk of sorted) {
    const s = Math.max(blk.startMin, dayStartMin)
    const e = Math.min(blk.endMin, dayEndMin)
    if (e <= cursor) continue
    if (s > cursor) free.push({ startMin: cursor, endMin: Math.min(s, dayEndMin) })
    cursor = Math.max(cursor, e)
    if (cursor >= dayEndMin) break
  }
  if (cursor < dayEndMin) free.push({ startMin: cursor, endMin: dayEndMin })
  return free.filter((f) => f.endMin > f.startMin)
}

// Intersection of many users' free intervals for a day.
export function intersectFree(perUser: Array<Array<{ startMin: number; endMin: number }>>, dayStartMin: number, dayEndMin: number): Array<{ startMin: number; endMin: number }> {
  if (perUser.length === 0) return []
  let acc: Array<{ startMin: number; endMin: number }> = [{ startMin: dayStartMin, endMin: dayEndMin }]
  for (const free of perUser) {
    const next: Array<{ startMin: number; endMin: number }> = []
    for (const a of acc) {
      for (const f of free) {
        const s = Math.max(a.startMin, f.startMin)
        const e = Math.min(a.endMin, f.endMin)
        if (e > s) next.push({ startMin: s, endMin: e })
      }
    }
    acc = next
    if (acc.length === 0) break
  }
  return acc
}

// Sum of busy-block hours for a user across the loaded week. Shared by the
// capacity panel and the header capacity chips.
export function busyHours(u: SchedUser): number {
  let mins = 0
  for (const b of u.blocks) {
    const s = new Date(b.start).getTime()
    const e = new Date(b.end).getTime()
    if (e > s) mins += (e - s) / 60000
  }
  return mins / 60
}

export function minutesToLabel(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

// Group a user's blocks into per-day-index positioned lists (tz-aware).
export function bucketBlocksByDay(user: SchedUser, days: string[], tz: string | null): PositionedBlock[][] {
  const out: PositionedBlock[][] = days.map(() => [])
  user.blocks.forEach((b, i) => {
    const ymd = ymdInTZ(b.start, tz)
    const idx = days.indexOf(ymd)
    if (idx < 0) return
    const { startMin, endMin } = blockMinutes(b, tz)
    out[idx]!.push({
      startMin,
      endMin,
      color: b.color,
      ...(b.subject ? { subject: b.subject } : {}),
      ...(b.isPrivate ? { isPrivate: true } : {}),
      ...(b.isTentative ? { isTentative: true } : {}),
      key: b.id ?? `${user.userId}-${i}`,
    })
  })
  return out
}
