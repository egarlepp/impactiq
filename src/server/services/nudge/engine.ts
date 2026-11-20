import { db } from '../../db/index.js'
import {
  nudgeRules,
  nudgeRuleTeams,
  nudgeRuleTranslations,
  nudgeDismissals,
  nudgeEvents,
  activities,
  teamActivityTypes,
  activityProducts,
  products as productsTbl,
  users,
  teams,
  teamMembers,
} from '../../../../drizzle/schema.js'
import { resolveCapacityOne } from '../capacity/resolver.js'
import { and, eq, gte, desc, sql, inArray, or, isNull } from 'drizzle-orm'
import { subDays, subBusinessDays, startOfDay, startOfWeek, differenceInCalendarDays } from 'date-fns'

// Boolean form of each trigger — used by the AND/OR combinator on rules
// with `conditions` set. Returns true when the caller currently matches
// the trigger. Kept intentionally simpler than the per-opp emitter: it
// only needs a yes/no signal, not a rendered message.
async function matchesTrigger(triggerType: string, config: Record<string, unknown>, userId: string, teamId: string, now: Date): Promise<boolean> {
  if (triggerType === 'no_activity_days') {
    const days = Number(config['days'] ?? 5)
    const since = startOfDay(subDays(now, days))
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId), gte(activities.createdAt, since)))
    return (Number(row?.n ?? 0)) === 0
  }
  if (triggerType === 'sf_sync_failed') {
    const minCount = Number(config['count'] ?? 1)
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId), eq(activities.crmSyncStatus, 'failed')))
    return Number(row?.n ?? 0) >= minCount
  }
  if (triggerType === 'weekly_hours_below_target') {
    const pctThreshold = Number(config['pctThreshold'] ?? 60)
    const weekStart = startOfWeek(now, { weekStartsOn: 1 })
    const [sumRow] = await db.select({ hours: sql<string>`coalesce(sum(${activities.effortHours}), 0)` }).from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId), eq(activities.isArchived, false), eq(activities.status, 'submitted'), gte(activities.startDatetime, weekStart)))
    const logged = Number(sumRow?.hours ?? 0)
    const resolved = await resolveCapacityOne(userId, teamId, now)
    return resolved.hours > 0 && (logged / resolved.hours) * 100 < pctThreshold
  }
  if (triggerType === 'opportunity_stale') {
    const days = Number(config['days'] ?? 21)
    const since = subDays(now, days)
    const opps = await db.select({ crmWhatId: activities.crmWhatId }).from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId), eq(activities.crmWhatType, 'Opportunity'), sql`${activities.crmWhatId} IS NOT NULL`))
      .groupBy(activities.crmWhatId)
    for (const o of opps) {
      if (!o.crmWhatId) continue
      const [r] = await db.select({ n: sql<number>`count(*)` }).from(activities)
        .where(and(eq(activities.userId, userId), eq(activities.crmWhatId, o.crmWhatId), gte(activities.startDatetime, since)))
      if (Number(r?.n ?? 0) === 0) return true
    }
    return false
  }
  // stage_no_type, type_no_followup, product_gap: for combinator purposes,
  // return true if ANY opp/product currently matches. Full per-opp emission
  // is only used for the base trigger.
  if (triggerType === 'stage_no_type') {
    const typeName = String(config['type'] ?? '')
    const days = Number(config['days'] ?? 14)
    const since = subDays(now, days)
    const [tr] = await db.select().from(teamActivityTypes).where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.name, typeName))).limit(1)
    if (!tr) return false
    const allOpps = await db.select({ crmWhatId: activities.crmWhatId, firstAt: sql<Date>`min(${activities.startDatetime})` })
      .from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId), sql`${activities.crmWhatId} IS NOT NULL`))
      .groupBy(activities.crmWhatId)
    const recentTyped = await db.select({ crmWhatId: activities.crmWhatId }).from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId), eq(activities.activityTypeId, tr.id), gte(activities.startDatetime, since)))
    const recentIds = new Set(recentTyped.map((r) => r.crmWhatId).filter(Boolean))
    return allOpps.some((o) => o.crmWhatId && !recentIds.has(o.crmWhatId) && (!o.firstAt || new Date(o.firstAt).getTime() <= since.getTime()))
  }
  if (triggerType === 'product_gap') {
    const productId = String(config['productId'] ?? '')
    if (!productId) return false
    const days = Number(config['days'] ?? 30)
    const since = subDays(now, days)
    const [row] = await db.select({ n: sql<number>`count(distinct ${activities.id})` })
      .from(activities)
      .innerJoin(activityProducts, eq(activityProducts.activityId, activities.id))
      .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId), eq(activityProducts.productId, productId), gte(activities.startDatetime, since)))
    return Number(row?.n ?? 0) === 0
  }
  return false
}

async function combinatorAllows(rule: { conditions: unknown }, userId: string, teamId: string, now: Date): Promise<boolean> {
  const raw = rule.conditions as { op?: string; clauses?: Array<{ triggerType?: string; config?: Record<string, unknown> }> } | null
  if (!raw || !Array.isArray(raw.clauses) || raw.clauses.length === 0) return true
  const op = raw.op === 'OR' ? 'OR' : 'AND'
  const results = await Promise.all(raw.clauses.map((c) => c.triggerType ? matchesTrigger(c.triggerType, c.config ?? {}, userId, teamId, now) : Promise.resolve(false)))
  return op === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

export interface NudgeNotification {
  ruleId: string
  message: string
  triggerType: string
  severity: string
  icon: string | null
  // v1.112.0: per-rule "Also send by email" toggle propagates from
  // nudge_rules.send_email so the delivery layer can decide whether to
  // additionally send the nudge as an email.
  sendEmail: boolean
  // v1.433.0: nudge_rules.send_slack_dm, same idea for a Slack DM.
  sendSlackDm: boolean
}

export async function evaluateNudges(
  userId: string,
  teamId: string,
  locale?: string | null,
): Promise<NudgeNotification[]> {
  // v1.297.0: resolve applicable rules via the nudge_rule_teams junction
  // table, not nudgeRules.teamId directly. teamId on the base row is only
  // the "home" team set at creation; a rule's actual team assignment(s)
  // live in the junction (same as the admin list/create/update routes in
  // admin.ts already treat it — see GET .../nudge-rules). Filtering here by
  // the stale base column meant any rule whose "Assign to teams" selection
  // was edited after creation silently stopped firing for real users on
  // the newly-assigned team(s), while still showing up fine in the admin
  // list and editor (which both go through the junction) — indistinguishable
  // from a broken trigger from the admin's side. This was the actual root
  // cause of Preview showing "0 of N" for a no_activity_days rule with
  // provably overdue members: the rule simply never made it into `rules`
  // for the team being tested.
  const ruleRows = await db
    .select({ rule: nudgeRules })
    .from(nudgeRules)
    .innerJoin(nudgeRuleTeams, and(eq(nudgeRuleTeams.nudgeRuleId, nudgeRules.id), eq(nudgeRuleTeams.teamId, teamId)))
    .where(eq(nudgeRules.isActive, true))
  const rules = ruleRows.map((r) => r.rule)

  // v1.125.0: swap in the caller-locale translation before rendering,
  // so token substitution downstream sees the localized template. Falls
  // back to the rule's base messageTemplate when no row for `locale`.
  if (locale && rules.length > 0) {
    const trs = await db
      .select({ ruleId: nudgeRuleTranslations.nudgeRuleId, template: nudgeRuleTranslations.messageTemplate })
      .from(nudgeRuleTranslations)
      .where(and(inArray(nudgeRuleTranslations.nudgeRuleId, rules.map((r) => r.id)), eq(nudgeRuleTranslations.locale, locale)))
    const byRule = new Map(trs.map((t) => [t.ruleId, t.template]))
    for (const r of rules) {
      const localized = byRule.get(r.id)
      if (localized) r.messageTemplate = localized
    }
  }

  const now = new Date()

  // Get dismissed nudge rule IDs that haven't expired. NULL expiresAt means
  // "closed out permanently" (v1.287.0's close-out action) rather than
  // muted-until-a-date — treat it as always-active alongside "expires in
  // the future", same as a snooze that just hasn't lapsed yet.
  const dismissals = await db
    .select({ nudgeRuleId: nudgeDismissals.nudgeRuleId })
    .from(nudgeDismissals)
    .where(and(eq(nudgeDismissals.userId, userId), or(isNull(nudgeDismissals.expiresAt), gte(nudgeDismissals.expiresAt, now))))

  const dismissedIds = new Set(dismissals.map((d) => d.nudgeRuleId))

  // Cooldown map: last delivery timestamp per rule for this user. A rule
  // whose last delivery is inside its cooldown window is skipped even if
  // the trigger still holds — prevents "same nudge every poll" spam.
  const cooldownRuleIds = rules.filter((r) => (r.cooldownHours ?? 0) > 0).map((r) => r.id)
  const lastDeliveryByRuleId = new Map<string, Date>()
  if (cooldownRuleIds.length > 0) {
    const recent = await db
      .select({ ruleId: nudgeEvents.nudgeRuleId, deliveredAt: sql<Date>`max(${nudgeEvents.deliveredAt})` })
      .from(nudgeEvents)
      .where(and(eq(nudgeEvents.userId, userId), eq(nudgeEvents.teamId, teamId)))
      .groupBy(nudgeEvents.nudgeRuleId)
    for (const r of recent) {
      if (r.ruleId) lastDeliveryByRuleId.set(r.ruleId, new Date(r.deliveredAt))
    }
  }
  const inCooldown = (rule: typeof rules[number]): boolean => {
    const hrs = rule.cooldownHours ?? 0
    if (hrs <= 0) return false
    const last = lastDeliveryByRuleId.get(rule.id)
    if (!last) return false
    return now.getTime() - last.getTime() < hrs * 3_600_000
  }

  // Resolve tenant-wide context once — {user_name}, {team_name}, and
  // {days_since_activity} are rich tokens the admin can drop into any rule
  // template regardless of trigger type.
  const [userRow] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
  const [teamRow] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1)
  // v1.287.0: {days_since_activity} — mirrors no_activity_days' own
  // createdAt-keyed query for consistency, but computed once here (not
  // per-trigger) so it's available on any rule, the same way user_name/
  // team_name already are. '—' when the user has never logged anything.
  const [lastActivityRow] = await db
    .select({ lastAt: sql<Date | null>`max(${activities.createdAt})` })
    .from(activities)
    .where(and(eq(activities.userId, userId), eq(activities.teamId, teamId)))
  const daysSinceActivity = lastActivityRow?.lastAt != null
    ? String(differenceInCalendarDays(now, new Date(lastActivityRow.lastAt)))
    : '—'
  const richCtx = {
    user_name: userRow?.displayName ?? 'you',
    team_name: teamRow?.name ?? 'your team',
    days_since_activity: daysSinceActivity,
  }

  const notifications: NudgeNotification[] = []
  // Per-notification rich-token overrides collected as we go. Applied in
  // a final pass so every trigger benefits without having to know about
  // every token at the push site.
  const richOverrides: Map<number, { stage_name?: string; count?: number }> = new Map()
  const emit = (rule: typeof rules[number], message: string, extras?: { stage_name?: string; count?: number }) => {
    const idx = notifications.push({
      ruleId: rule.id,
      message,
      triggerType: rule.triggerType,
      severity: rule.severity ?? 'info',
      icon: rule.icon ?? null,
      sendEmail: !!(rule as { sendEmail?: boolean }).sendEmail,
      sendSlackDm: !!(rule as { sendSlackDm?: boolean }).sendSlackDm,
    }) - 1
    if (extras) richOverrides.set(idx, extras)
  }

  for (const rule of rules) {
    if (dismissedIds.has(rule.id)) continue
    if (inCooldown(rule)) continue

    // Leader-rollup rules are evaluated in a separate pass below — they
    // don't fire from the individual-user side of the engine.
    if ((rule as { leaderRollupThreshold?: number | null }).leaderRollupThreshold != null) continue

    // AND/OR combinator on top of the base trigger. When set, the rule
    // only emits if the combinator resolves true for this user right now.
    if ((rule as { conditions?: unknown }).conditions) {
      const ok = await combinatorAllows(rule as { conditions: unknown }, userId, teamId, now)
      if (!ok) continue
    }

    const config = rule.triggerConfig as Record<string, unknown>
    try {
    if (rule.triggerType === 'no_activity_days') {
      const days = Number(config['days'] ?? 5)
      const since = startOfDay(subDays(now, days))

      const [recent] = await db
        .select({ count: sql<number>`count(*)` })
        .from(activities)
        .where(
          and(
            eq(activities.userId, userId),
            eq(activities.teamId, teamId),
            gte(activities.createdAt, since),
          ),
        )

      // v1.308.0: THE actual bug behind this entire investigation (v1.291–
      // v1.306). count(*) returns Postgres bigint (OID 20); the `postgres`
      // driver (no custom type parser configured in db/index.ts) returns
      // bigint columns as a JS STRING at runtime to avoid silent precision
      // loss above Number.MAX_SAFE_INTEGER — sql<number> is a compile-time
      // TypeScript annotation only, it does not coerce the runtime value.
      // `(recent?.count ?? 0) === 0` was therefore comparing the string
      // "0" to the number 0 with strict equality, which is always false —
      // this trigger could never fire, for anyone, ever, regardless of
      // team/rule config. Every other count(*) comparison in this file
      // (matchesTrigger's four, sf_sync_failed's and product_gap's
      // main-loop checks) already wraps in Number(...); this was the one
      // unguarded exception, and no_activity_days was exactly the one
      // trigger type reported broken while everything else worked.
      if (Number(recent?.count ?? 0) === 0) {
        // v1.317.0: unlike every other trigger type in this file, this branch
        // called emit() with the raw template — {days} was never substituted,
        // so the seeded default template ("...in the last {days} yet...")
        // rendered the literal token instead of the configured threshold.
        // Global regex (not a plain string .replace, which only hits the
        // first match) — see the same v1.317.0 fix applied to every other
        // {days}/{opp_name}/{account_name}/etc. token below, all of which
        // had the identical "second occurrence in a template stays literal"
        // gap.
        const msg = rule.messageTemplate.replace(/\{days\}/g, String(days))
        emit(rule, msg)
      }
    }

    if (rule.triggerType === 'stage_no_type') {
      const typeName = String(config['type'] ?? '')
      const days = Number(config['days'] ?? 14)
      const since = subDays(now, days)

      const [typeRow] = await db
        .select()
        .from(teamActivityTypes)
        .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.name, typeName)))
        .limit(1)

      if (typeRow) {
        // Opps this user has ever touched — grouped so each shows once.
        // Also grab the EARLIEST activity date per opp so we can skip
        // opps that haven't been in-flight long enough to reasonably
        // have this activity type on them yet. Previously the trigger
        // fired for brand-new opps ("no Eval Work in 14 days") the
        // moment the first Demo landed, which is misleading.
        const allLinked = await db
          .select({
            crmWhatId: activities.crmWhatId,
            crmWhatName: activities.crmWhatName,
            firstAt: sql<Date>`min(${activities.startDatetime})`,
          })
          .from(activities)
          .where(
            and(
              eq(activities.userId, userId),
              eq(activities.teamId, teamId),
              sql`${activities.crmWhatId} IS NOT NULL`,
            ),
          )
          .groupBy(activities.crmWhatId, activities.crmWhatName)

        const recentTyped = await db
          .select({ crmWhatId: activities.crmWhatId })
          .from(activities)
          .where(
            and(
              eq(activities.userId, userId),
              eq(activities.teamId, teamId),
              eq(activities.activityTypeId, typeRow.id),
              gte(activities.startDatetime, since),
            ),
          )
        const recentTypedIds = new Set(recentTyped.map((r) => r.crmWhatId).filter(Boolean))

        // v1.294.0: {days_overdue} — how long it's ACTUALLY been, not the
        // configured threshold. `{days}` in a template stays the admin's
        // policy number ("no Eval Work in 14 days"); {days_overdue} is the
        // real gap for THIS opp, which can be much larger than 14 if nobody
        // has looked at it since. No date filter here (unlike recentTyped
        // above) — this is the type's last-ever occurrence on the opp,
        // regardless of window.
        const everTyped = await db
          .select({ crmWhatId: activities.crmWhatId, lastAt: sql<Date>`max(${activities.startDatetime})` })
          .from(activities)
          .where(
            and(
              eq(activities.userId, userId),
              eq(activities.teamId, teamId),
              eq(activities.activityTypeId, typeRow.id),
            ),
          )
          .groupBy(activities.crmWhatId)
        const lastTypedAtByOpp = new Map(everTyped.map((r) => [r.crmWhatId, r.lastAt ? new Date(r.lastAt) : null]))

        for (const linked of allLinked) {
          if (!linked.crmWhatId) continue
          if (recentTypedIds.has(linked.crmWhatId)) continue
          // Skip opps whose earliest activity is inside the window —
          // there hasn't been time to log the follow-up type yet.
          const firstAt = linked.firstAt ? new Date(linked.firstAt) : null
          if (firstAt && firstAt.getTime() > since.getTime()) continue
          const stageName = String(config['stage'] ?? '')
          const baseline = lastTypedAtByOpp.get(linked.crmWhatId) ?? firstAt
          const daysOverdue = baseline ? differenceInCalendarDays(now, baseline) : days
          const msg = rule.messageTemplate
            .replace(/\{opp_name\}/g, linked.crmWhatName ?? 'this opportunity')
            .replace(/\{days\}/g, String(days))
            .replace(/\{days_overdue\}/g, String(daysOverdue))
          emit(rule, msg, stageName ? { stage_name: stageName } : undefined)
          break
        }
      }
    }

    if (rule.triggerType === 'weekly_hours_below_target') {
      // Fires when the current week's logged hours are below `pctThreshold`% of
      // the user's capacity target, and today is on/after `checkDay` (0=Mon..6=Sun).
      const pctThreshold = Number(config['pctThreshold'] ?? 60)
      const checkDay = Number(config['checkDay'] ?? 4) // Friday default
      const dow = (now.getDay() + 6) % 7 // Mon=0..Sun=6
      if (dow >= checkDay) {
        const weekStart = startOfWeek(now, { weekStartsOn: 1 })
        const [sumRow] = await db
          .select({ hours: sql<string>`coalesce(sum(${activities.effortHours}), 0)` })
          .from(activities)
          .where(and(
            eq(activities.userId, userId),
            eq(activities.teamId, teamId),
            eq(activities.isArchived, false),
            eq(activities.status, 'submitted'),
            gte(activities.startDatetime, weekStart),
          ))
        const logged = Number(sumRow?.hours ?? 0)
        const resolved = await resolveCapacityOne(userId, teamId, new Date())
        const target = resolved.hours
        if (target > 0 && (logged / target) * 100 < pctThreshold) {
          const msg = rule.messageTemplate
            .replace(/\{pct\}/g, String(Math.round((logged / target) * 100)))
            .replace(/\{hours\}/g, logged.toFixed(1))
            .replace(/\{target\}/g, String(target))
          emit(rule, msg)
        }
      }
    }

    if (rule.triggerType === 'sf_sync_failed') {
      const minCount = Number(config['count'] ?? 1)
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(activities)
        .where(and(
          eq(activities.userId, userId),
          eq(activities.teamId, teamId),
          eq(activities.crmSyncStatus, 'failed'),
        ))
      const n = Number(row?.n ?? 0)
      if (n >= minCount) {
        const msg = rule.messageTemplate.replace(/\{count\}/g, String(n))
        emit(rule, msg, { count: n })
      }
    }

    if (rule.triggerType === 'opportunity_stale') {
      // Any opportunity the user has ever logged against with no activity in the
      // last `days` days fires a single stale-opp nudge.
      const days = Number(config['days'] ?? 21)
      const since = subDays(now, days)
      const linked = await db
        .select({ crmWhatId: activities.crmWhatId, crmWhatName: activities.crmWhatName })
        .from(activities)
        .where(and(
          eq(activities.userId, userId),
          eq(activities.teamId, teamId),
          eq(activities.crmWhatType, 'Opportunity'),
          sql`${activities.crmWhatId} IS NOT NULL`,
        ))
        .groupBy(activities.crmWhatId, activities.crmWhatName)
      for (const opp of linked) {
        if (!opp.crmWhatId) continue
        // v1.294.0: one MAX() query instead of a count query — gives both
        // "is it stale" (lastAt older than the window) and the real
        // {days_overdue} figure for the message, without a second round-trip.
        const [lastRow] = await db
          .select({ lastAt: sql<Date | null>`max(${activities.startDatetime})` })
          .from(activities)
          .where(and(
            eq(activities.userId, userId),
            eq(activities.crmWhatId, opp.crmWhatId),
          ))
        const lastAt = lastRow?.lastAt ? new Date(lastRow.lastAt) : null
        if (!lastAt || lastAt.getTime() < since.getTime()) {
          const daysOverdue = lastAt ? differenceInCalendarDays(now, lastAt) : days
          const msg = rule.messageTemplate
            .replace(/\{opp_name\}/g, opp.crmWhatName ?? 'this opportunity')
            .replace(/\{days\}/g, String(days))
            .replace(/\{days_overdue\}/g, String(daysOverdue))
          emit(rule, msg)
          break
        }
      }
    }

    if (rule.triggerType === 'product_gap') {
      const productId = String(config['productId'] ?? '')
      const days = Number(config['days'] ?? 30)
      if (productId) {
        const since = subDays(now, days)
        const [row] = await db
          .select({ n: sql<number>`count(distinct ${activities.id})` })
          .from(activities)
          .innerJoin(activityProducts, eq(activityProducts.activityId, activities.id))
          .where(and(
            eq(activities.userId, userId),
            eq(activities.teamId, teamId),
            eq(activityProducts.productId, productId),
            gte(activities.startDatetime, since),
          ))
        if (Number(row?.n ?? 0) === 0) {
          const [prod] = await db
            .select({ name: productsTbl.name })
            .from(productsTbl)
            .where(eq(productsTbl.id, productId))
            .limit(1)
          const msg = rule.messageTemplate
            .replace(/\{product_name\}/g, prod?.name ?? 'this product')
            .replace(/\{days\}/g, String(days))
          emit(rule, msg)
        }
      }
    }

    if (rule.triggerType === 'type_no_followup') {
      const fromType = String(config['fromType'] ?? 'Discovery')
      const toType = String(config['toType'] ?? 'Demo')
      const days = Number(config['days'] ?? 21)
      const since = subDays(now, days)

      const [fromTypeRow] = await db
        .select()
        .from(teamActivityTypes)
        .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.name, fromType)))
        .limit(1)

      const [toTypeRow] = await db
        .select()
        .from(teamActivityTypes)
        .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.name, toType)))
        .limit(1)

      if (fromTypeRow && toTypeRow) {
        // Find accounts where fromType was logged but no toType in last N days
        const fromActivities = await db
          .select({ crmWhatId: activities.crmWhatId, crmWhatName: activities.crmWhatName, startDatetime: activities.startDatetime })
          .from(activities)
          .where(
            and(
              eq(activities.userId, userId),
              eq(activities.teamId, teamId),
              eq(activities.activityTypeId, fromTypeRow.id),
              sql`${activities.crmWhatId} IS NOT NULL`,
            ),
          )

        for (const fromAct of fromActivities) {
          if (!fromAct.crmWhatId) continue

          const [toActivity] = await db
            .select()
            .from(activities)
            .where(
              and(
                eq(activities.userId, userId),
                eq(activities.activityTypeId, toTypeRow.id),
                eq(activities.crmWhatId, fromAct.crmWhatId),
                gte(activities.startDatetime, since),
              ),
            )
            .limit(1)

          if (!toActivity) {
            // v1.294.0: {days_overdue} — the toType's actual last occurrence
            // on this account (ever, no window), falling back to the
            // fromType activity's own date if toType has never happened.
            const [lastToRow] = await db
              .select({ lastAt: sql<Date | null>`max(${activities.startDatetime})` })
              .from(activities)
              .where(and(
                eq(activities.userId, userId),
                eq(activities.activityTypeId, toTypeRow.id),
                eq(activities.crmWhatId, fromAct.crmWhatId),
              ))
            const baseline = lastToRow?.lastAt ? new Date(lastToRow.lastAt) : new Date(fromAct.startDatetime)
            const daysOverdue = differenceInCalendarDays(now, baseline)
            const msg = rule.messageTemplate
              .replace(/\{account_name\}/g, fromAct.crmWhatName ?? 'this account')
              .replace(/\{days\}/g, String(days))
              .replace(/\{days_overdue\}/g, String(daysOverdue))
            emit(rule, msg)
            break
          }
        }
      }
    }
    } catch (err) {
      // A single misconfigured rule (missing product, bad SF ref, empty
      // capacity group) shouldn't take out the whole team's nudge
      // stream. Log and continue.
      console.warn(`[nudge] rule ${rule.id} (${rule.triggerType}) failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  // Leader roll-up pass: for rules with leaderRollupThreshold set, we
  // count how many distinct users on this team received an in-app nudge
  // of the same base triggerType in the last 7 days. If the caller is a
  // leader/admin on the team AND the count meets the threshold, emit
  // one rollup nudge. Reads-only against nudge_events (no re-evaluation).
  try {
    const rollupRules = rules.filter((r) => (r as { leaderRollupThreshold?: number | null }).leaderRollupThreshold != null && !dismissedIds.has(r.id) && !inCooldown(r))
    if (rollupRules.length > 0) {
      const [caller] = await db.select({ role: teamMembers.role }).from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
        .limit(1)
      const isLeader = caller?.role === 'leader' || caller?.role === 'admin'
      if (isLeader) {
        const since = subDays(now, 7)
        for (const rule of rollupRules) {
          const threshold = Number((rule as { leaderRollupThreshold: number }).leaderRollupThreshold)
          const [row] = await db
            .select({ n: sql<number>`count(distinct ${nudgeEvents.userId})` })
            .from(nudgeEvents)
            .where(and(
              eq(nudgeEvents.teamId, teamId),
              eq(nudgeEvents.triggerType, rule.triggerType),
              eq(nudgeEvents.channel, 'in_app'),
              gte(nudgeEvents.deliveredAt, since),
            ))
          const count = Number(row?.n ?? 0)
          if (count >= threshold) {
            const msg = rule.messageTemplate.replace(/\{count\}/g, String(count))
            emit(rule, msg, { count })
          }
        }
      }
    }
  } catch (err) {
    console.warn('[nudge-rollup] failed:', err instanceof Error ? err.message : String(err))
  }

  // Final rich-token pass — {user_name}, {team_name}, {days_since_activity}
  // always; {count}, {stage_name} when the trigger stashed them. Unused
  // tokens survive untouched so admins can still preview raw templates in
  // the rules UI.
  return notifications.map((n, i) => {
    const extras = richOverrides.get(i) ?? {}
    let msg = n.message
      .replace(/\{user_name\}/g, richCtx.user_name)
      .replace(/\{team_name\}/g, richCtx.team_name)
      .replace(/\{days_since_activity\}/g, richCtx.days_since_activity)
    if (extras.stage_name != null) msg = msg.replace(/\{stage_name\}/g, extras.stage_name)
    if (extras.count != null) msg = msg.replace(/\{count\}/g, String(extras.count))
    return { ...n, message: msg }
  })
}
