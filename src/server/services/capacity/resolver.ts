// Single source of truth for "what is X's capacity or cost rate on team Y
// at time T?" — every dashboard and admin surface routes through here.
// Ordering: dated user override → group-via-team → fallback.
//
// Batching: dashboards typically resolve a whole team × N weeks; the
// `-Batch` variants issue two queries total and merge in memory, so the
// hot paths stay O(1) SQL calls.

import { and, eq, inArray, isNull, lte, or, sql, gt } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  capacityGroups,
  capacityGroupTeams,
  capacityUserOverrides,
  costGroups,
  costGroupTeams,
  costUserOverrides,
  users,
} from '../../../../drizzle/schema.js'
import {
  trailingRealMeetingLoad,
  CALENDAR_DERIVED_MIN_WEEKS,
  type TrailingMeetingLoad,
} from './meetingLoad.js'

// Gross weekly hours a user's own work-week implies, BEFORE PTO/holiday —
// counted the same way the Activities page does (set work-day bits ×
// hours/day). Downstream dashboards subtract PTO/holiday separately, so this
// must stay the pre-exception figure to avoid double-counting.
export function workWeekHours(workDays: number, startHour: number, endHour: number): number {
  let days = 0
  for (let i = 0; i < 7; i++) if ((workDays & (1 << i)) !== 0) days++
  return days * Math.max(0, endHour - startHour)
}

const DEFAULT_CAPACITY_HOURS = 30

export interface CapacityLookup { userId: string; teamId: string; asOf: Date }
export interface CapacityResult { hours: number; source: string }

export interface CostLookup { userId: string; teamId: string; asOf: Date }
export interface CostResult { rate: number | null; currency: string | null; source: string }

function keyOf(userId: string, teamId: string): string {
  return `${userId}::${teamId}`
}

// ─── Capacity ────────────────────────────────────────────────────────────

export async function resolveCapacityBatch(lookups: CapacityLookup[]): Promise<Map<string, CapacityResult>> {
  const out = new Map<string, CapacityResult>()
  if (lookups.length === 0) return out

  const userIds = Array.from(new Set(lookups.map((l) => l.userId)))
  const teamIds = Array.from(new Set(lookups.map((l) => l.teamId)))

  // 1. Pull every override that could conceivably match one of the lookup
  //    users AND teams. We over-fetch on purpose — filtering by exact
  //    (user, team, asOf) tuples is cheaper in-process than a big
  //    OR-of-tuples SQL query.
  const overrideRows = await db
    .select({
      userId: capacityUserOverrides.userId,
      teamId: capacityUserOverrides.teamId,
      hours: capacityUserOverrides.targetHoursPerWeek,
      reason: capacityUserOverrides.reason,
      from: capacityUserOverrides.effectiveFrom,
      to: capacityUserOverrides.effectiveTo,
    })
    .from(capacityUserOverrides)
    .where(and(
      inArray(capacityUserOverrides.userId, userIds),
      inArray(capacityUserOverrides.teamId, teamIds),
    ))

  // 2. Group targets + method, keyed by team (a team maps to ≤1 group).
  const groupRows = await db
    .select({
      teamId: capacityGroupTeams.teamId,
      groupName: capacityGroups.name,
      hours: capacityGroups.targetHoursPerWeek,
      method: capacityGroups.capacityMethod,
    })
    .from(capacityGroupTeams)
    .innerJoin(capacityGroups, eq(capacityGroups.id, capacityGroupTeams.groupId))
    .where(inArray(capacityGroupTeams.teamId, teamIds))

  const groupByTeam = new Map<string, { name: string; hours: string | null; method: string }>()
  for (const r of groupRows) groupByTeam.set(r.teamId, { name: r.groupName, hours: r.hours, method: r.method })

  // 3. Each user's own work-week — only needed for self_declared /
  //    exception_adjusted groups, where the target follows the contributor's
  //    configured hours (floored at the group target). Fetched once for all
  //    lookup users.
  const userRows = await db
    .select({
      id: users.id,
      workDays: users.workDays,
      startHour: users.workDayStartHour,
      endHour: users.workDayEndHour,
    })
    .from(users)
    .where(inArray(users.id, userIds))
  const workWeekByUser = new Map<string, number>()
  for (const u of userRows) workWeekByUser.set(u.id, workWeekHours(u.workDays, u.startHour, u.endHour))

  // 4. Trailing real-meeting-load average — only needed for lookups whose
  //    team's group uses 'calendar_derived'. Batched per distinct `asOf`
  //    (usually just one across a whole call), since the trailing window is
  //    computed relative to it. See services/capacity/meetingLoad.ts for the
  //    "measures load, not availability" caveat this method carries.
  const calendarDerivedByUserAsOf = new Map<string, TrailingMeetingLoad>()
  const asOfGroups = new Map<string, { asOf: Date; userIds: Set<string> }>()
  for (const l of lookups) {
    const g = groupByTeam.get(l.teamId)
    if (g?.method !== 'calendar_derived') continue
    const asOfKey = asOfIsoDate(l.asOf)
    const entry = asOfGroups.get(asOfKey) ?? { asOf: l.asOf, userIds: new Set<string>() }
    entry.userIds.add(l.userId)
    asOfGroups.set(asOfKey, entry)
  }
  for (const [asOfKey, { asOf, userIds: uids }] of asOfGroups) {
    const trailing = await trailingRealMeetingLoad(Array.from(uids), asOf)
    for (const [userId, result] of trailing) calendarDerivedByUserAsOf.set(`${userId}::${asOfKey}`, result)
  }

  for (const l of lookups) {
    const asOfDay = asOfIsoDate(l.asOf)
    // (a) Dated per-user override always wins — this is the admin's explicit
    //     exception and is the only way to set a user BELOW the group floor.
    const active = overrideRows.find(
      (r) => r.userId === l.userId && r.teamId === l.teamId
        && r.from <= asOfDay
        && (r.to === null || asOfDay < r.to),
    )
    if (active) {
      out.set(keyOf(l.userId, l.teamId), {
        hours: Number(active.hours),
        source: `override:${active.reason}`,
      })
      continue
    }
    // (b) The team's capacity group + its method decides the base target.
    const g = groupByTeam.get(l.teamId)
    if (g && (g.hours != null || g.method !== 'fixed_hours')) {
      const groupTarget = g.hours != null ? Number(g.hours) : 0
      if (g.method === 'fixed_hours') {
        out.set(keyOf(l.userId, l.teamId), { hours: groupTarget, source: `group:${g.name}:fixed` })
      } else if (g.method === 'calendar_derived') {
        // The target IS the user's own trailing real meeting load — not
        // floored at groupTarget, unlike self_declared/exception_adjusted,
        // because the whole point is that it's genuinely auto-detected and
        // can legitimately sit above or below a flat number. groupTarget
        // instead serves as the FALLBACK when there isn't enough calendar
        // history to trust an average (see meetingLoad.ts).
        const trailing = calendarDerivedByUserAsOf.get(`${l.userId}::${asOfDay}`)
        if (trailing && trailing.weeksWithData >= CALENDAR_DERIVED_MIN_WEEKS) {
          out.set(keyOf(l.userId, l.teamId), {
            hours: trailing.averageHours,
            source: `group:${g.name}:calendar_derived`,
          })
        } else {
          out.set(keyOf(l.userId, l.teamId), {
            hours: groupTarget,
            source: `group:${g.name}:calendar_derived:insufficient_history`,
          })
        }
      } else {
        // self_declared / exception_adjusted: follow the user's own work-week,
        // but never below the group's minimum. (PTO/holiday reductions for
        // exception_adjusted are applied downstream, not here, so the base
        // stays gross and exceptions aren't double-counted.)
        const declared = workWeekByUser.get(l.userId) ?? 0
        out.set(keyOf(l.userId, l.teamId), {
          hours: Math.max(groupTarget, declared),
          source: `group:${g.name}:${g.method}`,
        })
      }
      continue
    }
    // (c) No group configured for the team.
    out.set(keyOf(l.userId, l.teamId), { hours: DEFAULT_CAPACITY_HOURS, source: 'default' })
  }
  return out
}

export async function resolveCapacityOne(userId: string, teamId: string, asOf: Date): Promise<CapacityResult> {
  const m = await resolveCapacityBatch([{ userId, teamId, asOf }])
  return m.get(keyOf(userId, teamId)) ?? { hours: DEFAULT_CAPACITY_HOURS, source: 'default' }
}

// ─── Cost ────────────────────────────────────────────────────────────────

export async function resolveCostBatch(lookups: CostLookup[]): Promise<Map<string, CostResult>> {
  const out = new Map<string, CostResult>()
  if (lookups.length === 0) return out

  const userIds = Array.from(new Set(lookups.map((l) => l.userId)))
  const teamIds = Array.from(new Set(lookups.map((l) => l.teamId)))

  const overrideRows = await db
    .select({
      userId: costUserOverrides.userId,
      teamId: costUserOverrides.teamId,
      rate: costUserOverrides.hourlyCostRate,
      currency: costUserOverrides.currency,
      reason: costUserOverrides.reason,
      from: costUserOverrides.effectiveFrom,
      to: costUserOverrides.effectiveTo,
    })
    .from(costUserOverrides)
    .where(and(
      inArray(costUserOverrides.userId, userIds),
      inArray(costUserOverrides.teamId, teamIds),
    ))

  const groupRows = await db
    .select({
      teamId: costGroupTeams.teamId,
      groupName: costGroups.name,
      rate: costGroups.hourlyCostRate,
      currency: costGroups.currency,
    })
    .from(costGroupTeams)
    .innerJoin(costGroups, eq(costGroups.id, costGroupTeams.groupId))
    .where(inArray(costGroupTeams.teamId, teamIds))

  const groupByTeam = new Map<string, { name: string; rate: string; currency: string }>()
  for (const r of groupRows) groupByTeam.set(r.teamId, { name: r.groupName, rate: r.rate, currency: r.currency })

  for (const l of lookups) {
    const asOfDay = asOfIsoDate(l.asOf)
    const active = overrideRows.find(
      (r) => r.userId === l.userId && r.teamId === l.teamId
        && r.from <= asOfDay
        && (r.to === null || asOfDay < r.to),
    )
    if (active) {
      out.set(keyOf(l.userId, l.teamId), {
        rate: Number(active.rate),
        currency: active.currency,
        source: `override:${active.reason}`,
      })
      continue
    }
    const g = groupByTeam.get(l.teamId)
    if (g) {
      out.set(keyOf(l.userId, l.teamId), {
        rate: Number(g.rate),
        currency: g.currency,
        source: `group:${g.name}`,
      })
      continue
    }
    out.set(keyOf(l.userId, l.teamId), { rate: null, currency: null, source: 'unset' })
  }
  return out
}

export async function resolveCostOne(userId: string, teamId: string, asOf: Date): Promise<CostResult> {
  const m = await resolveCostBatch([{ userId, teamId, asOf }])
  return m.get(keyOf(userId, teamId)) ?? { rate: null, currency: null, source: 'unset' }
}

// ─── Overlap detection (used by admin write endpoints) ───────────────────

interface OverlapCheck {
  table: 'capacity' | 'cost'
  userId: string
  teamId: string
  effectiveFrom: string // yyyy-mm-dd
  effectiveTo: string | null
  excludeId?: string
}

// Return the ID of any existing override that overlaps [from, to). Null
// if the range is free. `[from, to)` intervals with either side open are
// handled: NULL upper bound means "forever forward".
export async function findOverridesConflict(check: OverlapCheck): Promise<string | null> {
  const tbl = check.table === 'capacity' ? capacityUserOverrides : costUserOverrides
  const conds = [
    eq(tbl.userId, check.userId),
    eq(tbl.teamId, check.teamId),
  ]
  // Existing.from < candidate.to  (or candidate.to is NULL → open forward)
  if (check.effectiveTo) {
    conds.push(sql`${tbl.effectiveFrom} < ${check.effectiveTo}::date`)
  }
  // Existing.to > candidate.from OR existing.to IS NULL
  conds.push(or(
    isNull(tbl.effectiveTo),
    gt(tbl.effectiveTo, check.effectiveFrom),
  )!)
  if (check.excludeId) {
    conds.push(sql`${tbl.id} <> ${check.excludeId}`)
  }
  const rows = await db.select({ id: tbl.id }).from(tbl).where(and(...conds)).limit(1)
  return rows[0]?.id ?? null
}

// silence unused imports when the file is used strictly for reads
void lte

function asOfIsoDate(d: Date): string {
  // Compare in UTC-YYYY-MM-DD. The API stores effective_from/to as DATE
  // (no timezone), and we treat the "asOf" instant as the day it falls
  // in for that comparison — good enough for weekly resolution.
  return d.toISOString().slice(0, 10)
}
