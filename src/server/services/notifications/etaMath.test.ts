import { describe, it, expect } from 'vitest'
import { computeNextDigestDeltaMinutes } from './digest.js'
import { computeNextWeeklyRecapDeltaMinutes } from './weekly-recap.js'

// Pure minutes-from-now math backing the Run Now "next possible send" ETA
// (v1.329.0) — no DB needed, since both functions take already-resolved
// local-time inputs. See CLAUDE.md §14/§18 (v1.329) for why this exists:
// the send-window check is per-user/per-timezone, so "when will it run" has
// no single global answer — this is the arithmetic for one user's own next
// occurrence, and the exported async wrappers just take the minimum across
// every enabled user.

describe('computeNextDigestDeltaMinutes', () => {
  const targetMinutes = 8 * 60 // 08:00

  it('counts down to today\'s target when the window hasn\'t arrived yet', () => {
    const nowMinutes = 6 * 60 // 06:00
    expect(computeNextDigestDeltaMinutes(nowMinutes, targetMinutes, false)).toBe(120)
  })

  it('is imminent (0) when the window has passed today and this user has not been sent yet', () => {
    const nowMinutes = 10 * 60 // 10:00, past 08:00
    expect(computeNextDigestDeltaMinutes(nowMinutes, targetMinutes, false)).toBe(0)
  })

  it('rolls over to tomorrow when already sent today', () => {
    const nowMinutes = 10 * 60 // 10:00
    // 14h remaining today (to midnight) + 8h into tomorrow = 22h = 1320m
    expect(computeNextDigestDeltaMinutes(nowMinutes, targetMinutes, true)).toBe(22 * 60)
  })

  it('returns exactly 0 minutes when now is exactly the target minute', () => {
    expect(computeNextDigestDeltaMinutes(targetMinutes, targetMinutes, false)).toBe(0)
  })
})

describe('computeNextWeeklyRecapDeltaMinutes', () => {
  const FRI = 5
  const targetMinutes = 17 * 60 // 17:00

  it('counts down within the same target day when still ahead of the time', () => {
    // Friday 10:00 -> Friday 17:00 = 7h
    expect(computeNextWeeklyRecapDeltaMinutes(FRI, 10 * 60, FRI, targetMinutes, false)).toBe(7 * 60)
  })

  it('counts forward across days when today is not the target day', () => {
    const MON = 1
    // Monday 10:00 -> Friday 17:00 = 4 days + 7h = 4*1440 + 420
    expect(computeNextWeeklyRecapDeltaMinutes(MON, 10 * 60, FRI, targetMinutes, false)).toBe(4 * 1440 + 420)
  })

  it('is imminent (0) when today is the target day, past the time, and not yet sent this week', () => {
    expect(computeNextWeeklyRecapDeltaMinutes(FRI, 18 * 60, FRI, targetMinutes, false)).toBe(0)
  })

  it('rolls over a full week when today is the target day, past the time, and already sent', () => {
    // Friday 18:20 (1100m), target 17:00 (1020m) already passed by 80m and
    // already sent -> next Friday 17:00 is a full week minus that 80m late.
    expect(computeNextWeeklyRecapDeltaMinutes(FRI, 18 * 60 + 20, FRI, targetMinutes, true)).toBe(7 * 1440 - 80)
  })

  it('wraps correctly when the target day is earlier in the week than today', () => {
    const SAT = 6
    const MON = 1
    // Saturday -> next Monday 17:00 = 2 days + 17h
    expect(computeNextWeeklyRecapDeltaMinutes(SAT, 9 * 60, MON, targetMinutes, false)).toBe(2 * 1440 + targetMinutes - 9 * 60)
  })
})
