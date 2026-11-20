import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { startOfWeek, endOfWeek, subWeeks, format } from 'date-fns'
import { db } from '../../db/index.js'
import { activities, teamActivityTypes, teamMembers, users } from '../../../../drizzle/schema.js'
import { resolveCapacityBatch } from '../capacity/resolver.js'

// v1.220.0: anomaly detection for the leader dashboards.
//
// The dashboards answer questions a leader already knows to ask. This answers
// the one they don't: "is anything off this week?" — surfaced as a small set
// of callouts above the dashboard, rather than something they have to go
// hunting for across thirteen tabs.
//
// Two design rules drive everything below, because the failure mode of a
// panel like this is not being wrong — it's being noisy. A callout box that
// lights up every week is wallpaper within a month, and then it's worse than
// nothing, because a real signal arrives in a place nobody reads.
//
//   1. Every detector has a VOLUME FLOOR as well as a ratio threshold. "3×
//      last week" on two hours of work is arithmetic, not a finding.
//   2. The output is HARD CAPPED. Past the cap we report how many were
//      suppressed rather than printing them, so a genuinely chaotic week
//      still yields a readable panel.
//
// The comparison window is deliberately NOT the dashboard's date filter. The
// last completed week is measured against a fixed trailing baseline, because
// "normal" is a property of the team, not of whatever range the leader
// happens to have selected. Switching the dashboard to "All time" should not
// change what counts as unusual. The panel says which window it used.

export type Severity = 'high' | 'medium' | 'low'
export type SubjectType = 'account' | 'opportunity' | 'user' | 'activity_type' | 'team'

export interface Anomaly {
  /** i18n key suffix under `leader.anomalies.codes.*`. */
  code: string
  severity: Severity
  subjectType: SubjectType
  subjectId: string | null
  subjectName: string | null
  /** Interpolation values for the message. */
  params: Record<string, string | number>
  /** Sort key within a severity band — bigger is more unusual. */
  magnitude: number
}

export interface AnomalyResult {
  weekStart: string
  weekEnd: string
  baselineWeeks: number
  /** Baseline weeks that actually had any team activity. */
  baselineWeeksWithData: number
  anomalies: Anomaly[]
  suppressed: number
  /** True when there wasn't enough history to run baseline-relative checks. */
  insufficientHistory: boolean
}

const BASELINE_WEEKS = 8
const MIN_BASELINE_WEEKS = 4
const MAX_ANOMALIES = 6

// Per-detector floors. Tuned to stay quiet: each one is "enough work that a
// leader would care", not "enough rows to compute a ratio".
const ACCOUNT_MIN_WEEK_HOURS = 8
const ACCOUNT_MIN_ACTIVE_BASELINE_WEEKS = 3
const ACCOUNT_SPIKE_RATIO = 2.5
const CAPACITY_OVER_RATIO = 1.25
const TYPE_MIN_BASELINE_HOURS = 5
const TYPE_SURGE_RATIO = 2.5
const TYPE_COLLAPSE_RATIO = 0.4
const UNLINKED_MIN_COUNT = 5
const UNLINKED_MIN_SHARE = 0.25
const UNLINKED_MIN_SHARE_JUMP = 0.15
const SYNC_FAILURE_MIN = 3
const STOPPED_MIN_ACTIVE_BASELINE_WEEKS = 4

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

function round1(n: number): number { return Math.round(n * 10) / 10 }

/**
 * Runs every detector for a team scope. Never throws on an individual
 * detector — a failure in one returns no findings for that check rather than
 * blanking the whole panel.
 */
export async function detectAnomalies(opts: {
  teamIds: string[]
  productCond: SQL | null
  /**
   * Signed week offset, matching the rest of the dashboard routes: NEGATIVE
   * moves into the past. 0 = the last completed week.
   */
  weekShift?: number
}): Promise<AnomalyResult> {
  const { teamIds, productCond } = opts
  const shift = opts.weekShift ?? 0

  // "Last completed week" — the week that ended before the current one.
  // Evaluating the in-progress week would flag every team as under capacity
  // every Monday morning.
  const anchor = subWeeks(new Date(), 1 - shift)
  const weekStart = startOfWeek(anchor, { weekStartsOn: 1 })
  const weekEnd = endOfWeek(anchor, { weekStartsOn: 1 })
  const baseStart = startOfWeek(subWeeks(weekStart, BASELINE_WEEKS), { weekStartsOn: 1 })
  const baseEnd = endOfWeek(subWeeks(weekStart, 1), { weekStartsOn: 1 })

  const base = () => and(
    inArray(activities.teamId, teamIds),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    ...(productCond ? [productCond] : []),
  )

  // One pass over the baseline range, bucketed by ISO week, feeds every
  // baseline-relative detector. Doing this per-detector would be four scans
  // of the same rows.
  const weekExpr = sql<string>`to_char(date_trunc('week', ${activities.startDatetime}), 'YYYY-MM-DD')`

  const anomalies: Anomaly[] = []
  const push = (a: Anomaly) => { anomalies.push(a) }

  // ── How much history do we actually have? ─────────────────────────────
  let baselineWeeksWithData = 0
  try {
    const rows = await db
      .select({ wk: weekExpr.as('wk') })
      .from(activities)
      .where(and(base(), gte(activities.startDatetime, baseStart), lte(activities.startDatetime, baseEnd)))
      .groupBy(weekExpr)
    baselineWeeksWithData = rows.length
  } catch { /* leave at 0 — treated as insufficient history below */ }

  const insufficientHistory = baselineWeeksWithData < MIN_BASELINE_WEEKS

  // ── Account / Opportunity burn spike ──────────────────────────────────
  // Baseline is the mean over weeks the account was ACTUALLY touched, not
  // over all 8. SE engagement is lumpy by nature; dividing by 8 would make
  // every normal burst look like a spike.
  if (!insufficientHistory) {
    try {
      const cur = await db
        .select({
          whatId: activities.crmWhatId,
          whatName: activities.crmWhatName,
          whatType: activities.crmWhatType,
          hours: sql<string>`sum(${activities.effortHours})`.as('hours'),
        })
        .from(activities)
        .where(and(
          base(),
          gte(activities.startDatetime, weekStart),
          lte(activities.startDatetime, weekEnd),
          sql`${activities.crmWhatId} is not null`,
        ))
        .groupBy(activities.crmWhatId, activities.crmWhatName, activities.crmWhatType)

      const candidates = cur.filter((r) => Number(r.hours ?? 0) >= ACCOUNT_MIN_WEEK_HOURS)
      if (candidates.length > 0) {
        const ids = candidates.map((r) => r.whatId!).filter(Boolean)
        const hist = await db
          .select({
            whatId: activities.crmWhatId,
            wk: weekExpr.as('wk'),
            hours: sql<string>`sum(${activities.effortHours})`.as('hours'),
          })
          .from(activities)
          .where(and(
            base(),
            gte(activities.startDatetime, baseStart),
            lte(activities.startDatetime, baseEnd),
            inArray(activities.crmWhatId, ids),
          ))
          .groupBy(activities.crmWhatId, weekExpr)

        const byId = new Map<string, number[]>()
        for (const r of hist) {
          const h = Number(r.hours ?? 0)
          if (h <= 0) continue
          const list = byId.get(r.whatId!) ?? []
          list.push(h)
          byId.set(r.whatId!, list)
        }
        for (const c of candidates) {
          const weeks = byId.get(c.whatId!) ?? []
          if (weeks.length < ACCOUNT_MIN_ACTIVE_BASELINE_WEEKS) continue
          const mean = weeks.reduce((a, b) => a + b, 0) / weeks.length
          if (mean <= 0) continue
          const hours = Number(c.hours ?? 0)
          const ratio = hours / mean
          if (ratio < ACCOUNT_SPIKE_RATIO) continue
          push({
            code: 'account_burn_spike',
            severity: ratio >= 4 ? 'high' : 'medium',
            subjectType: c.whatType === 'Opportunity' ? 'opportunity' : 'account',
            subjectId: c.whatId,
            subjectName: c.whatName,
            params: { name: c.whatName ?? '', hours: round1(hours), average: round1(mean), ratio: round1(ratio) },
            magnitude: ratio,
          })
        }
      }
    } catch { /* skip this detector */ }
  }

  // ── Contributor over capacity ─────────────────────────────────────────
  // Not baseline-relative — it's measured against the configured target, so
  // it runs even on a brand-new team with no history.
  try {
    const members = await db
      .select({ userId: teamMembers.userId, teamId: teamMembers.teamId, displayName: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(inArray(teamMembers.teamId, teamIds))
    const primaryTeam = new Map<string, string>()
    const nameById = new Map<string, string>()
    for (const m of members) {
      if (!primaryTeam.has(m.userId)) primaryTeam.set(m.userId, m.teamId)
      nameById.set(m.userId, m.displayName)
    }
    const userIds = Array.from(primaryTeam.keys())
    if (userIds.length > 0) {
      const hoursRows = await db
        .select({ userId: activities.userId, hours: sql<string>`sum(${activities.effortHours})`.as('hours') })
        .from(activities)
        .where(and(base(), gte(activities.startDatetime, weekStart), lte(activities.startDatetime, weekEnd)))
        .groupBy(activities.userId)
      const hoursBy = new Map(hoursRows.map((r) => [r.userId, Number(r.hours ?? 0)]))
      const resolved = await resolveCapacityBatch(
        userIds.map((uid) => ({ userId: uid, teamId: primaryTeam.get(uid)!, asOf: weekStart })),
      )
      for (const uid of userIds) {
        const target = resolved.get(`${uid}::${primaryTeam.get(uid)!}`)?.hours ?? 0
        if (target <= 0) continue
        const hours = hoursBy.get(uid) ?? 0
        const ratio = hours / target
        if (ratio < CAPACITY_OVER_RATIO) continue
        push({
          code: 'contributor_over_capacity',
          severity: ratio >= 1.5 ? 'high' : 'medium',
          subjectType: 'user',
          subjectId: uid,
          subjectName: nameById.get(uid) ?? null,
          params: {
            name: nameById.get(uid) ?? '',
            hours: round1(hours),
            target: round1(target),
            pct: Math.round(ratio * 100),
          },
          magnitude: ratio,
        })
      }

      // ── Contributor stopped logging ─────────────────────────────────
      // Only for people who had an established pattern — a contributor who
      // logs sporadically isn't "stopped", they're sporadic, and saying
      // otherwise is how a panel loses credibility.
      if (!insufficientHistory) {
        const histRows = await db
          .select({ userId: activities.userId, wk: weekExpr.as('wk') })
          .from(activities)
          .where(and(base(), gte(activities.startDatetime, baseStart), lte(activities.startDatetime, baseEnd)))
          .groupBy(activities.userId, weekExpr)
        const activeWeeks = new Map<string, number>()
        for (const r of histRows) activeWeeks.set(r.userId, (activeWeeks.get(r.userId) ?? 0) + 1)
        for (const uid of userIds) {
          if ((hoursBy.get(uid) ?? 0) > 0) continue
          const weeks = activeWeeks.get(uid) ?? 0
          if (weeks < STOPPED_MIN_ACTIVE_BASELINE_WEEKS) continue
          push({
            code: 'contributor_logging_stopped',
            severity: weeks >= BASELINE_WEEKS ? 'medium' : 'low',
            subjectType: 'user',
            subjectId: uid,
            subjectName: nameById.get(uid) ?? null,
            params: { name: nameById.get(uid) ?? '', weeks },
            magnitude: weeks,
          })
        }
      }
    }
  } catch { /* skip this detector */ }

  // ── Activity-type surge / collapse ────────────────────────────────────
  if (!insufficientHistory) {
    try {
      const curRows = await db
        .select({ name: teamActivityTypes.name, hours: sql<string>`sum(${activities.effortHours})`.as('hours') })
        .from(activities)
        .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
        .where(and(base(), gte(activities.startDatetime, weekStart), lte(activities.startDatetime, weekEnd)))
        .groupBy(teamActivityTypes.name)
      const histRows = await db
        .select({
          name: teamActivityTypes.name,
          wk: weekExpr.as('wk'),
          hours: sql<string>`sum(${activities.effortHours})`.as('hours'),
        })
        .from(activities)
        .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
        .where(and(base(), gte(activities.startDatetime, baseStart), lte(activities.startDatetime, baseEnd)))
        .groupBy(teamActivityTypes.name, weekExpr)

      const curBy = new Map(curRows.map((r) => [r.name, Number(r.hours ?? 0)]))
      const histBy = new Map<string, number[]>()
      for (const r of histRows) {
        const list = histBy.get(r.name) ?? []
        list.push(Number(r.hours ?? 0))
        histBy.set(r.name, list)
      }
      for (const [name, weeks] of histBy) {
        // Divide by the full baseline length, not by active weeks: for an
        // activity type, a zero week IS part of the normal rhythm, and
        // treating it as absent would understate the baseline.
        const mean = weeks.reduce((a, b) => a + b, 0) / BASELINE_WEEKS
        if (mean < TYPE_MIN_BASELINE_HOURS) continue
        const hours = curBy.get(name) ?? 0
        const ratio = hours / mean
        if (ratio >= TYPE_SURGE_RATIO) {
          push({
            code: 'activity_type_surge',
            severity: 'low',
            subjectType: 'activity_type',
            subjectId: null,
            subjectName: name,
            params: { name, hours: round1(hours), average: round1(mean), ratio: round1(ratio) },
            magnitude: ratio,
          })
        } else if (ratio <= TYPE_COLLAPSE_RATIO) {
          push({
            code: 'activity_type_collapse',
            severity: ratio === 0 ? 'medium' : 'low',
            subjectType: 'activity_type',
            subjectId: null,
            subjectName: name,
            params: { name, hours: round1(hours), average: round1(mean), pct: Math.round((1 - ratio) * 100) },
            magnitude: 1 - ratio,
          })
        }
      }
    } catch { /* skip this detector */ }
  }

  // ── Unlinked activity spike ───────────────────────────────────────────
  // Submitted work with no Salesforce What or Who never reaches the CRM, so
  // it's invisible to everyone outside ImpactIQ. A jump here usually means a
  // broken habit or a broken SF connection, and both are worth a nudge.
  try {
    const shareFor = async (start: Date, end: Date) => {
      const [row] = await db
        .select({
          total: sql<string>`count(*)`.as('total'),
          unlinked: sql<string>`count(*) filter (where ${activities.crmWhatId} is null and ${activities.crmWhoId} is null)`.as('unlinked'),
        })
        .from(activities)
        .where(and(base(), gte(activities.startDatetime, start), lte(activities.startDatetime, end)))
      const total = Number(row?.total ?? 0)
      const unlinked = Number(row?.unlinked ?? 0)
      return { total, unlinked, share: total > 0 ? unlinked / total : 0 }
    }
    const cur = await shareFor(weekStart, weekEnd)
    if (cur.unlinked >= UNLINKED_MIN_COUNT && cur.share >= UNLINKED_MIN_SHARE) {
      const prior = insufficientHistory ? { share: 0 } : await shareFor(baseStart, baseEnd)
      if (cur.share - prior.share >= UNLINKED_MIN_SHARE_JUMP) {
        push({
          code: 'unlinked_spike',
          severity: cur.share >= 0.5 ? 'medium' : 'low',
          subjectType: 'team',
          subjectId: null,
          subjectName: null,
          params: {
            count: cur.unlinked,
            total: cur.total,
            pct: Math.round(cur.share * 100),
            baselinePct: Math.round(prior.share * 100),
          },
          magnitude: cur.share,
        })
      }
    }
  } catch { /* skip this detector */ }

  // ── Salesforce write-back failures ────────────────────────────────────
  // Visible in Admin → CRM Sync, but a leader never goes there. If their
  // team's work isn't reaching Salesforce, they should hear it here.
  try {
    const [row] = await db
      .select({ n: sql<string>`count(*)`.as('n') })
      .from(activities)
      .where(and(
        inArray(activities.teamId, teamIds),
        eq(activities.isArchived, false),
        eq(activities.crmSyncStatus, 'failed'),
        gte(activities.startDatetime, weekStart),
        lte(activities.startDatetime, weekEnd),
      ))
    const n = Number(row?.n ?? 0)
    if (n >= SYNC_FAILURE_MIN) {
      push({
        code: 'sync_failures',
        severity: n >= 10 ? 'high' : 'medium',
        subjectType: 'team',
        subjectId: null,
        subjectName: null,
        params: { count: n },
        magnitude: n,
      })
    }
  } catch { /* skip this detector */ }

  anomalies.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.magnitude - a.magnitude,
  )
  const shown = anomalies.slice(0, MAX_ANOMALIES)

  return {
    // v1.226.0: plain calendar-date strings, not toISOString() instants —
    // matching the convention every other week-bucketed dashboards.ts
    // endpoint already uses (e.g. the heatmap/trend `weeks` arrays). An
    // instant string rendered client-side via `new Date(...)` resolves
    // calendar fields in the BROWSER's local timezone, so a UTC-midnight
    // Monday shifts back to "Sunday" for anyone west of UTC. A date-only
    // string parsed with date-fns `parseISO` has no such shift.
    weekStart: format(weekStart, 'yyyy-MM-dd'),
    weekEnd: format(weekEnd, 'yyyy-MM-dd'),
    baselineWeeks: BASELINE_WEEKS,
    baselineWeeksWithData,
    anomalies: shown,
    suppressed: Math.max(0, anomalies.length - shown.length),
    insufficientHistory,
  }
}
