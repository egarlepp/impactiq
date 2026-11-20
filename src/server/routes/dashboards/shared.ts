import { db } from '../../db/index.js'
import {
  activities,
  teams,
  users,
  teamMembers,
  subteams,
  subteamUsers,
  userPtoDays,
  userHolidayCalendars,
  holidayDates,
  teamHolidayCalendars,
  outlookEvents,
  fxRates,
  capacityGroups,
  capacityGroupTeams,
} from '../../../../drizzle/schema.js'
import { and, eq, gte, lte, sql, inArray, or, isNotNull } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { resolveCapacityBatch, resolveCostBatch } from '../../services/capacity/resolver.js'
import type { Request } from 'express'
import { startOfWeek, addWeeks, subWeeks, endOfWeek, format, subDays } from 'date-fns'

// v1.416.0: helpers shared by the dashboard route modules in this folder:
// team scope checks, date windows, filter parsing, FX and cost roll-ups.
// Moved here unchanged from routes/dashboards.ts.

// Resolve the requested teamId into a concrete list of team IDs the
// current user can see. Passing 'all' (or no teamId for All-Teams users)
// unions across every team the user has a membership on; passing a
// specific UUID returns just that team. Returns null when the user has
// no accessible teams at all.
// Returns per-user, per-ISO-week hours to subtract from that user's weekly
// capacity target, covering both PTO days the user marked and holiday-calendar
// dates from the user's picks (falling back to their teams' picks).
// Assumes an 8-hour work day for the exclusion — the leader dashboards do not
// currently model per-day working hours per contributor.
export async function excludedHoursByUserWeek(
  userIds: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<{ total: Record<string, Record<string, number>>; pto: Record<string, Record<string, number>> }> {
  if (userIds.length === 0) return { total: {}, pto: {} }
  const startStr = rangeStart.toISOString().slice(0, 10)
  const endStr = rangeEnd.toISOString().slice(0, 10)
  // Each PTO/holiday day removes one of the user's OWN working days, so use
  // their configured hours/day (end − start), not a flat 8 — otherwise a 9h/day
  // contributor's dashboard capacity drifts 1h/day from the Activities page on
  // any week with PTO or a holiday. Falls back to 8 if a user row is missing.
  const hoursDayRows = await db
    .select({ id: users.id, startHour: users.workDayStartHour, endHour: users.workDayEndHour })
    .from(users)
    .where(inArray(users.id, userIds))
  const hoursPerDayByUser = new Map<string, number>()
  for (const u of hoursDayRows) hoursPerDayByUser.set(u.id, Math.max(0, u.endHour - u.startHour) || 8)
  const hoursForUser = (uid: string) => hoursPerDayByUser.get(uid) ?? 8

  const ptoRows = await db.select({ userId: userPtoDays.userId, date: userPtoDays.date })
    .from(userPtoDays)
    .where(and(
      inArray(userPtoDays.userId, userIds),
      gte(userPtoDays.date, startStr),
      lte(userPtoDays.date, endStr),
    ))

  // Resolve each user's effective holiday calendar set (user picks take
  // precedence over team assignments).
  const userCals = await db.select({ userId: userHolidayCalendars.userId, calendarId: userHolidayCalendars.calendarId })
    .from(userHolidayCalendars)
    .where(inArray(userHolidayCalendars.userId, userIds))
  const userCalMap = new Map<string, Set<string>>()
  for (const r of userCals) {
    if (!userCalMap.has(r.userId)) userCalMap.set(r.userId, new Set())
    userCalMap.get(r.userId)!.add(r.calendarId)
  }
  // Team fallback: for users with no personal picks, union their teams' picks.
  const noPersonal = userIds.filter((u) => !userCalMap.has(u))
  if (noPersonal.length > 0) {
    const memberships = await db.select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
      .from(teamMembers).where(inArray(teamMembers.userId, noPersonal))
    const teamIds = Array.from(new Set(memberships.map((m) => m.teamId)))
    if (teamIds.length > 0) {
      const teamCals = await db.select({ teamId: teamHolidayCalendars.teamId, calendarId: teamHolidayCalendars.calendarId })
        .from(teamHolidayCalendars).where(inArray(teamHolidayCalendars.teamId, teamIds))
      const teamCalMap = new Map<string, string[]>()
      for (const r of teamCals) {
        if (!teamCalMap.has(r.teamId)) teamCalMap.set(r.teamId, [])
        teamCalMap.get(r.teamId)!.push(r.calendarId)
      }
      for (const uid of noPersonal) {
        const ms = memberships.filter((m) => m.userId === uid)
        const cs = new Set<string>()
        for (const m of ms) for (const cid of teamCalMap.get(m.teamId) ?? []) cs.add(cid)
        if (cs.size > 0) userCalMap.set(uid, cs)
      }
    }
  }

  const allCalIds = Array.from(new Set([...userCalMap.values()].flatMap((s) => Array.from(s))))
  const holidayRows = allCalIds.length > 0
    ? await db.select({ calendarId: holidayDates.calendarId, date: holidayDates.date })
        .from(holidayDates)
        .where(and(
          inArray(holidayDates.calendarId, allCalIds),
          gte(holidayDates.date, startStr),
          lte(holidayDates.date, endStr),
        ))
    : []
  const holidayByCal = new Map<string, string[]>()
  for (const r of holidayRows) {
    if (!holidayByCal.has(r.calendarId)) holidayByCal.set(r.calendarId, [])
    holidayByCal.get(r.calendarId)!.push(r.date)
  }

  function isoWeekOfDateStr(s: string): string {
    const d = new Date(s + 'T00:00:00Z')
    const dow = d.getUTCDay() // 0 Sun
    const monShift = dow === 0 ? -6 : 1 - dow
    d.setUTCDate(d.getUTCDate() + monShift)
    return d.toISOString().slice(0, 10)
  }

  // `total` = PTO + holiday (drives capacity-target reduction). `pto` =
  // PTO only, so the heatmap can label a reduced-capacity cell as PTO vs a
  // company holiday — otherwise every holiday reads as "PTO" on every user.
  const out: Record<string, Record<string, number>> = {}
  const ptoOut: Record<string, Record<string, number>> = {}
  const bump = (target: Record<string, Record<string, number>>, uid: string, iso: string, hours: number) => {
    const weekIso = isoWeekOfDateStr(iso)
    target[uid] ??= {}
    target[uid][weekIso] = (target[uid][weekIso] ?? 0) + hours
  }
  for (const p of ptoRows) {
    bump(out, p.userId, p.date, hoursForUser(p.userId))
    bump(ptoOut, p.userId, p.date, hoursForUser(p.userId))
  }
  for (const uid of userIds) {
    const cals = userCalMap.get(uid) ?? new Set()
    const seenPerUserWeek = new Map<string, Set<string>>() // dedupe overlapping cals
    for (const cid of cals) {
      for (const d of holidayByCal.get(cid) ?? []) {
        const wk = isoWeekOfDateStr(d)
        if (!seenPerUserWeek.has(wk)) seenPerUserWeek.set(wk, new Set())
        const set = seenPerUserWeek.get(wk)!
        if (set.has(d)) continue
        set.add(d)
        bump(out, uid, d, hoursForUser(uid))
      }
    }
  }
  return { total: out, pto: ptoOut }
}

// Monday (UTC) of the ISO week containing a yyyy-MM-dd date — matches the
// weekStart keys the dashboards emit (date_trunc('week') / startOfWeek Mon).
export function mondayIsoUtc(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const dow = d.getUTCDay()
  const monShift = dow === 0 ? -6 : 1 - dow
  d.setUTCDate(d.getUTCDate() + monShift)
  return d.toISOString().slice(0, 10)
}

// Per-user, per-ISO-week hours from Outlook meetings that are NOT logged as
// ImpactIQ activities (and not all-day). This is "non-activity" capacity —
// meeting time that still consumes the contributor's day even though it wasn't
// captured as an activity, shown in dark grey on the capacity dashboards.
//
// Data-availability caveat: outlook_events is populated only for users who
// synced their own calendar (or whom a leader refreshed), so for teams where
// not everyone connected Outlook this is a lower bound, never an over-count.
export async function nonActivityHoursByUserWeek(
  userIds: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Record<string, Record<string, number>>> {
  if (userIds.length === 0) return {}
  const events = await db
    .select({
      id: outlookEvents.id,
      userId: outlookEvents.userId,
      start: outlookEvents.startDatetime,
      end: outlookEvents.endDatetime,
    })
    .from(outlookEvents)
    .where(and(
      inArray(outlookEvents.userId, userIds),
      eq(outlookEvents.isAllDay, false),
      gte(outlookEvents.startDatetime, rangeStart),
      lte(outlookEvents.startDatetime, rangeEnd),
    ))
  if (events.length === 0) return {}
  // Exclude events already captured as an activity — matched on either the
  // inbound link (outlookEventId) or a write-back id (outlookWritebackEventId),
  // the same pair used everywhere else to decide "already logged".
  const logged = await db
    .select({ a: activities.outlookEventId, b: activities.outlookWritebackEventId })
    .from(activities)
    .where(and(
      inArray(activities.userId, userIds),
      eq(activities.isArchived, false),
      or(isNotNull(activities.outlookEventId), isNotNull(activities.outlookWritebackEventId)),
    ))
  const loggedIds = new Set<string>()
  for (const r of logged) { if (r.a) loggedIds.add(r.a); if (r.b) loggedIds.add(r.b) }

  const out: Record<string, Record<string, number>> = {}
  for (const e of events) {
    if (loggedIds.has(e.id)) continue
    const hrs = (e.end.getTime() - e.start.getTime()) / 3_600_000
    if (!(hrs > 0)) continue
    const weekIso = mondayIsoUtc(e.start.toISOString().slice(0, 10))
    out[e.userId] ??= {}
    out[e.userId]![weekIso] = (out[e.userId]![weekIso] ?? 0) + hrs
  }
  return out
}

// v1.225.0: admin opt-in check for the calendar-derived "Meeting Load"
// figure. Gated per capacity group (CLAUDE.md §12), not per user — if any
// team in scope has it enabled on its attached group, the dashboard shows
// the figure for its whole population. A leader dashboard is already scoped
// to a team (or "all teams", the rarer case), so this deliberately doesn't
// try to mask the figure per-user within a mixed multi-team view.
export async function anyTeamHasRealMeetingLoadEnabled(teamIds: string[]): Promise<boolean> {
  if (teamIds.length === 0) return false
  const [row] = await db
    .select({ teamId: capacityGroupTeams.teamId })
    .from(capacityGroupTeams)
    .innerJoin(capacityGroups, eq(capacityGroups.id, capacityGroupTeams.groupId))
    .where(and(
      inArray(capacityGroupTeams.teamId, teamIds),
      eq(capacityGroups.showRealMeetingLoad, true),
    ))
    .limit(1)
  return !!row
}

export async function resolveTeamScope(req: Request, teamIdParam: string | undefined): Promise<string[] | null> {
  const userId = req.user?.id
  if (!userId) return null
  const accessible = await accessibleDashboardTeamIds(userId)
  // A specific team is only in scope when the caller can see it. The route's
  // role check should already guarantee that; this is the second line, so a
  // mistake in a gate can't hand back another team's data (audit H1, v1.422.0).
  if (teamIdParam && teamIdParam !== 'all') return accessible?.includes(teamIdParam) ? [teamIdParam] : null
  return accessible
}

async function accessibleDashboardTeamIds(userId: string): Promise<string[] | null> {
  // App admins AND leaders/team_admins with the canSeeAllTeams flag see every
  // active team — matches how getAccessibleTeamIds() (rbac.ts, used for admin
  // config screens) already treats them.
  //
  // v1.245.0: this previously checked ONLY isAppAdmin, which meant a Team
  // Leader granted canSeeAllTeams (Admin -> User Management's global-teams
  // flag) got full cross-team visibility on admin screens but NOT on any
  // dashboard that scans "every team I can see" — Team-of-Teams Rollup, Most
  // Expensive, User Leaderboard, and the History dashboards all silently
  // under-scoped that user relative to what the flag promises them.
  const [caller] = await db
    .select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (caller?.isAppAdmin || caller?.canSeeAllTeams) {
    const allTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.isActive, true))
    const ids = allTeams.map((r) => r.id)
    return ids.length === 0 ? null : ids
  }
  const rows = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId))
  const idSet = new Set(rows.map((r) => r.teamId))
  // v1.126.0: also include teams that host a subteam this user belongs
  // to. Previously a user with only subteam membership (no team_members
  // row) had an empty team scope on cross-team dashboards, which is why
  // Team-of-Teams Rollup renders "No data in this period" for them even
  // when other dashboards under the same team have data.
  const subRows = await db
    .select({ teamId: subteams.teamId })
    .from(subteamUsers)
    .innerJoin(subteams, eq(subteams.id, subteamUsers.subteamId))
    .where(eq(subteamUsers.userId, userId))
  for (const r of subRows) idSet.add(r.teamId)
  const ids = Array.from(idSet)
  return ids.length === 0 ? null : ids
}

// Verify a target user id is actually a member of one of the caller-accessible
// teams. Used to gate every dashboard endpoint that accepts `?userId=` so a
// leader can't probe activity existence for arbitrary user ids.
// App admins bypass this check — they can drill into any user, consistent
// with resolveTeamScope granting them all-teams scope.
export async function assertUserInTeams(userId: string, teamIds: string[], callerId?: string): Promise<boolean> {
  if (callerId) {
    const [caller] = await db
      .select({ isAppAdmin: users.isAppAdmin })
      .from(users)
      .where(eq(users.id, callerId))
      .limit(1)
    if (caller?.isAppAdmin) return true
  }
  if (teamIds.length === 0) return false
  const [m] = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, teamIds)))
    .limit(1)
  return !!m
}

// Every other resolveTeamScope(req, teamIdParam) call site sits behind
// requireRole('leader'|'admin')(teamId) — that middleware already verified
// the caller belongs to teamIdParam specifically before the handler runs, so
// resolveTeamScope trusting a set teamIdParam is safe there. The three
// history-* routes below are gated by requireAnyLeaderOrAdmin instead
// (leader/admin on ANY team, not necessarily this one), so an explicit check
// is needed here or a client-supplied ?teamId= lets a leader read another
// team's data. Security audit finding B3.
export async function assertTeamIdAccessible(req: Request, teamIdParam: string | undefined): Promise<boolean> {
  if (!teamIdParam || teamIdParam === 'all') return true
  const own = await resolveTeamScope(req, undefined)
  return !!own && own.includes(teamIdParam)
}


// ─── Helpers shared by new dashboards ───────────────────────────────────────
// weekShift is negative for prior-period comparisons: rangeFor(4, -4) yields
// the four-week window ending four weeks ago (i.e. the immediately preceding
// four-week block). Used by the client's Compare toggle to pull MoM/QoQ/YoY
// baselines against the same dashboard.
// "All time" is capped to the retention window so a weeks=0 request can't
// devolve into an unbounded sequential scan as history grows. Nothing older
// than retention is meant to exist, so this is a safety backstop rather than
// a visible change. Tunable via DASH_MAX_WINDOW_DAYS (default ~3 years).
export const DASH_MAX_WINDOW_DAYS = Number(process.env['DASH_MAX_WINDOW_DAYS']) || 1095
export function rangeFor(weeksBack: number, weekShift = 0): { rangeStart: Date; rangeEnd: Date } {
  const now = new Date()
  const anchor = subWeeks(now, -weekShift)
  // weeksBack=0 is the "All time" sentinel. Upper bound still snaps to the end
  // of the anchor week so compare-mode shifts line up when combined with All;
  // lower bound is clamped to the retention window (see DASH_MAX_WINDOW_DAYS).
  if (weeksBack <= 0) {
    const rangeEnd = endOfWeek(anchor, { weekStartsOn: 1 })
    return { rangeStart: startOfWeek(subDays(rangeEnd, DASH_MAX_WINDOW_DAYS), { weekStartsOn: 1 }), rangeEnd }
  }
  return {
    rangeStart: startOfWeek(subWeeks(anchor, weeksBack - 1), { weekStartsOn: 1 }),
    rangeEnd: endOfWeek(anchor, { weekStartsOn: 1 }),
  }
}

// v1.195.0: which date column the dashboard window filters against.
//   activity = activities.start_datetime (the activity's date; default)
//   created  = activities.created_at    (when it was logged)
//   close    = activities.crm_opp_close_date (linked opportunity's Close Date;
//              non-opp rows drop out)
export type DashDateBasis = 'activity' | 'created' | 'close'
export function parseDateBasis(v: unknown): DashDateBasis {
  const s = String(v ?? 'activity')
  return s === 'created' ? 'created' : s === 'close' ? 'close' : 'activity'
}
// Resolve the window: an explicit start/end (yyyy-MM-dd, from a custom range
// or a FY/FQ pick) overrides the weeks/weekShift presets.
export function resolveRange(req: Request): { rangeStart: Date; rangeEnd: Date } {
  const start = req.query['start']; const end = req.query['end']
  if (typeof start === 'string' && start && typeof end === 'string' && end && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { rangeStart: new Date(`${start}T00:00:00`), rangeEnd: new Date(`${end}T23:59:59`) }
  }
  return rangeFor(Number(req.query['weeks'] ?? 8), parseWeekShift(req.query['weekShift']))
}
// Hard cap on how many Monday-aligned week columns a bounded window can
// produce, so an over-wide custom range (or a stray FY pick) can't blow up
// the grid. ~3 fiscal years of weeks.
export const MAX_WEEK_COLUMNS = 160
// Resolve the window AND the Monday-aligned week labels a week-grid dashboard
// (heatmap, capacity-trend, plan-vs-actual) should render. When an explicit
// start/end is present it drives both the data filter and the columns —
// otherwise we fall back to the weeksBack-from-now behaviour. The prior-period
// Compare fetch (weekShift != 0) always uses weeksBack so its window lines up
// with the baseline it's compared against.
export function windowFor(req: Request, weeksBack: number, weekShift: number): { rangeStart: Date; rangeEnd: Date; weeks: string[] } {
  const start = req.query['start']; const end = req.query['end']
  const hasExplicit = weekShift === 0
    && typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start)
    && typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end)
  if (hasExplicit) {
    const rangeStart = new Date(`${start as string}T00:00:00`)
    const rangeEnd = new Date(`${end as string}T23:59:59`)
    const weeks: string[] = []
    let cur = startOfWeek(rangeStart, { weekStartsOn: 1 })
    const last = startOfWeek(rangeEnd, { weekStartsOn: 1 })
    while (cur <= last && weeks.length < MAX_WEEK_COLUMNS) {
      weeks.push(format(cur, 'yyyy-MM-dd'))
      cur = addWeeks(cur, 1)
    }
    return { rangeStart, rangeEnd, weeks }
  }
  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)
  const anchor = subWeeks(new Date(), -weekShift)
  const weeks: string[] = []
  for (let i = 0; i < weeksBack; i++) {
    weeks.push(format(startOfWeek(subWeeks(anchor, weeksBack - 1 - i), { weekStartsOn: 1 }), 'yyyy-MM-dd'))
  }
  return { rangeStart, rangeEnd, weeks }
}
// Conditions restricting the activity row to the window on the chosen basis.
export function dateWindow(basis: DashDateBasis, rangeStart: Date, rangeEnd: Date) {
  if (basis === 'created') return [gte(activities.createdAt, rangeStart), lte(activities.createdAt, rangeEnd)]
  if (basis === 'close') {
    const lo = format(rangeStart, 'yyyy-MM-dd'); const hi = format(rangeEnd, 'yyyy-MM-dd')
    return [isNotNull(activities.crmOppCloseDate), gte(activities.crmOppCloseDate, lo), lte(activities.crmOppCloseDate, hi)]
  }
  return [gte(activities.startDatetime, rangeStart), lte(activities.startDatetime, rangeEnd)]
}

export function parseWeekShift(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function parseProductIds(v: unknown): string[] {
  if (typeof v !== 'string' || v.length === 0) return []
  return v.split(',').filter(Boolean)
}

// v1.265.0: Subtype dimension/filter (PRD §7 "Dashboard - SubActivity
// additions"). Unlike products, activities.subtypeId is a direct column —
// no join table needed, so this is a plain inArray condition.
export function parseSubtypeIds(v: unknown): string[] {
  if (typeof v !== 'string' || v.length === 0) return []
  return v.split(',').filter(Boolean)
}

export function subtypeFilterCond(subtypeIds: string[]) {
  if (subtypeIds.length === 0) return null
  return inArray(activities.subtypeId, subtypeIds)
}

// v1.265.0: multi-person filter — same `userIds` CSV param and
// inArray(activities.userId, …) condition ManagerRollup/SalesTeamBreakdown/
// ProjectCosting/UserLeaderboard/AttachRate already used, now shared so every
// dashboard route can support it. Dashboard.tsx sends the union of every
// individually-picked person and every member of every checked subteam here
// (see SubteamFilter mode="multi") — a plain multi-value equivalent of the
// legacy singular `userId` param, which routes keep accepting separately for
// callers that only ever narrow to one person.
export function parseMemberIds(v: unknown): string[] {
  if (typeof v !== 'string' || v.length === 0) return []
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

export function memberFilterCond(memberIds: string[]) {
  if (memberIds.length === 0) return null
  return inArray(activities.userId, memberIds)
}

// Returns a SQL condition that restricts activities.id to those linked to at
// least one of the given product ids (via the activity_products join table).
// Returns null when productIds is empty so callers can skip the join.
export function productFilterCond(productIds: string[]) {
  if (productIds.length === 0) return null
  return sql`EXISTS (SELECT 1 FROM activity_products ap WHERE ap.activity_id = ${activities.id} AND ap.product_id IN (${sql.join(productIds.map((id) => sql`${id}`), sql.raw(', '))}))`
}

// ─── ACV-range (opportunity size) filter ─────────────────────────────────
// The dashboard filter bar can restrict every opportunity-scoped dashboard to
// deals whose ACV (activities.acv — the app's Total_Acv__c value) falls in one
// or more fixed buckets. Values arrive as a comma-joined list of slugs (e.g.
// "25000-50000,500000+"). Each slug maps to a half-open [min, max) range;
// "<n>+" has no upper bound.
export type AcvRange = { min: number; max: number | null }
export function parseAcvRanges(v: unknown): AcvRange[] {
  if (typeof v !== 'string' || v.length === 0) return []
  const out: AcvRange[] = []
  for (const slug of v.split(',')) {
    if (!slug) continue
    if (slug.endsWith('+')) {
      const min = Number(slug.slice(0, -1))
      if (Number.isFinite(min)) out.push({ min, max: null })
      continue
    }
    const [a, b] = slug.split('-')
    const min = Number(a)
    const max = Number(b)
    if (Number.isFinite(min) && Number.isFinite(max)) out.push({ min, max })
  }
  return out
}

// SQL condition: the given (decimal) amount column falls in any of the ranges
// (union). Built as raw SQL so Postgres compares numerically regardless of the
// column's JS string mapping. Returns undefined when no ranges are active.
export function acvRangeCond(col: AnyPgColumn | SQL, ranges: AcvRange[]) {
  if (ranges.length === 0) return undefined
  const parts = ranges.map((r) =>
    r.max === null
      ? sql`${col} >= ${r.min}`
      : sql`(${col} >= ${r.min} AND ${col} < ${r.max})`,
  )
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql.raw(' OR '))})`
}

// JS predicate mirror of acvRangeCond, for handlers that post-filter rows.
export function amountInRanges(amount: number | null | undefined, ranges: AcvRange[]): boolean {
  if (ranges.length === 0) return true
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return false
  return ranges.some((r) => amount >= r.min && (r.max === null || amount < r.max))
}

// The ACV stored in `activities.acv` is treated as USD, but cost dashboards
// display ACV converted to the user's "Show Costs In" currency (displayed =
// usd × ratePerUsd). The bucket bounds the user picks are nominal in that
// display currency, so to compare against the raw USD amount we map each bound
// back to USD: usdBound = bound / ratePerUsd. Non-cost dashboards never send a
// displayCurrency and keep the bounds as-is (USD). Returns the ranges unchanged
// for USD / rate 1 / missing rate.
export function acvRangesInUsd(req: Request, ranges: AcvRange[], fx: FxByCurrency): AcvRange[] {
  if (ranges.length === 0) return ranges
  const cur = String(req.query['displayCurrency'] ?? 'USD') || 'USD'
  if (cur === 'USD') return ranges
  const rate = fx.get(cur)?.ratePerUsd
  if (!rate || !(rate > 0) || rate === 1) return ranges
  return ranges.map((r) => ({ min: r.min / rate, max: r.max === null ? null : r.max / rate }))
}

// ─── Shared cost/FX helpers (used by every cost dashboard) ───────────────
export type FxByCurrency = Map<string, { ratePerUsd: number; asOf: string }>

// Freshest ratePerUsd per currency from fx_rates. FX changes ~daily, but this
// runs on nearly every cost dashboard request (often several times per
// request), so cache the map process-wide with a short TTL. `_fxCache` is
// invalidated implicitly by expiry; a manual FX update is visible within the
// TTL window.
let _fxCache: { at: number; map: FxByCurrency } | null = null
export const FX_CACHE_TTL_MS = 5 * 60_000
export async function loadFxByCurrency(): Promise<FxByCurrency> {
  if (_fxCache && Date.now() - _fxCache.at < FX_CACHE_TTL_MS) return _fxCache.map
  const fxRows = await db
    .select({ currency: fxRates.currency, ratePerUsd: fxRates.ratePerUsd, asOf: fxRates.asOf })
    .from(fxRates)
  const m: FxByCurrency = new Map()
  for (const r of fxRows) {
    const cur = m.get(r.currency)
    if (!cur || r.asOf > cur.asOf) m.set(r.currency, { ratePerUsd: Number(r.ratePerUsd), asOf: r.asOf })
  }
  _fxCache = { at: Date.now(), map: m }
  return m
}

// Convert a local amount to USD. Unknown currency / missing FX row → treat as
// USD (never silently drop money). fx_rates convention: value = usd × ratePerUsd.
export function toUsd(local: number, currency: string | null | undefined, fx: FxByCurrency): number {
  if (!(local > 0)) return 0
  const cur = currency || 'USD'
  if (cur === 'USD') return local
  const r = fx.get(cur)
  return r && r.ratePerUsd > 0 ? local / r.ratePerUsd : local
}

// USD value of an activity's direct (incidental/travel) costs.
export interface DirectCostRow {
  costTransportation?: string | null
  costLodging?: string | null
  costFood?: string | null
  incidentalCurrency?: string | null
}
export function directCostUsd(row: DirectCostRow, fx: FxByCurrency): number {
  const local = Number(row.costTransportation ?? 0) + Number(row.costLodging ?? 0) + Number(row.costFood ?? 0)
  return toUsd(local, row.incidentalCurrency ?? 'USD', fx)
}

// Shared helper for the revenue dashboards: given raw per-activity rows
// (must carry userId, teamId, startDatetime, effortHours, acv), resolve
// each activity's cost via the capacity resolver, then aggregate by the
// caller-supplied key. Labor + direct costs are both FX-normalized to USD.
// Returns [[groupKey, {hours, costDollars, directCostsUsd, acv, activityCount,
// lastActivityAt}], ...].
export interface CostRowRaw extends DirectCostRow {
  userId: string
  teamId: string
  startDatetime: Date
  effortHours: string
  acv: string | null
}
export async function aggregateCostByGroup<T extends CostRowRaw>(
  rows: T[],
  keyFn: (r: T) => string,
): Promise<Array<[string, { hours: number; costDollars: number; directCostsUsd: number; acv: number; activityCount: number; lastActivityAt: string | null }]>> {
  if (rows.length === 0) return []
  const resolved = await resolveCostBatch(rows.map((r) => ({
    userId: r.userId,
    teamId: r.teamId,
    asOf: new Date(r.startDatetime),
  })))
  const fx = await loadFxByCurrency()
  const agg = new Map<string, { hours: number; costDollars: number; directCostsUsd: number; acv: number; activityCount: number; lastActivityAt: string | null }>()
  for (const r of rows) {
    const k = keyFn(r)
    const cur = agg.get(k) ?? { hours: 0, costDollars: 0, directCostsUsd: 0, acv: 0, activityCount: 0, lastActivityAt: null }
    const resolvedCost = resolved.get(`${r.userId}::${r.teamId}`)
    const rate = resolvedCost?.rate ?? 0
    const effort = Number(r.effortHours)
    const direct = directCostUsd(r, fx)
    cur.hours += effort
    // costDollars = labor (FX→USD) + direct costs (FX→USD).
    cur.costDollars += toUsd(effort * rate, resolvedCost?.currency, fx) + direct
    cur.directCostsUsd += direct
    cur.acv = Math.max(cur.acv, Number(r.acv ?? 0))
    cur.activityCount += 1
    const iso = new Date(r.startDatetime).toISOString()
    if (!cur.lastActivityAt || iso > cur.lastActivityAt) cur.lastActivityAt = iso
    agg.set(k, cur)
  }
  return Array.from(agg.entries())
}

export async function getTeamCapacityTotal(teamIds: string[], asOf: Date = new Date(), memberFilter?: string[]): Promise<number> {
  // Sum resolved capacity across every team member of every team in
  // scope (or just `memberFilter`, when the dashboard is narrowed to
  // specific people). The resolver defaults missing users to 30h.
  let members = await db
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(inArray(teamMembers.teamId, teamIds))
  if (memberFilter && memberFilter.length > 0) {
    const allowed = new Set(memberFilter)
    members = members.filter((m) => allowed.has(m.userId))
  }
  if (members.length === 0) return 0
  const resolved = await resolveCapacityBatch(members.map((m) => ({ userId: m.userId, teamId: m.teamId, asOf })))
  let total = 0
  for (const m of members) {
    total += resolved.get(`${m.userId}::${m.teamId}`)?.hours ?? 30
  }
  return total
}
