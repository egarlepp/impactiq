// pglite-backed tests for evaluateNudges()/matchesTrigger(). One shared
// in-memory DB per file (beforeAll) rather than per-test — a fresh pglite
// instance replays the full migration history (140+ files) and costs
// several seconds, which would make a per-test suite prohibitively slow.
// Each test creates its own team/user/rule fixtures so they don't interfere.
//
// IMPORTANT: pglite's own type parser returns count(*) as a real JS number,
// unlike the `postgres` driver production uses (which returns bigint as a
// string — see testDb.test.ts). That means these tests verify FUNCTIONAL
// correctness (trigger dispatch, joins, combinator/cooldown/dismissal
// semantics) but cannot serve as a regression guard for the bigint-as-string
// bug class itself — see engine.aggregateCoercion.test.ts for that.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { subDays } from 'date-fns'
import type { TestDb } from '../../db/testDb.js'

let testDb: TestDb
// Spread the real module's exports (runMigrations/isDbConfigured/etc.) so
// only `db` is swapped for the pglite-backed instance — testDb.ts itself is
// deliberately independent of db/index.ts (see its own file header) so
// building the pglite instance here can't recurse into this same mock.
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let evaluateNudges: typeof import('./engine.js')['evaluateNudges']
let schema: typeof import('../../../../drizzle/schema.js')

beforeAll(async () => {
  // Import AFTER the mock is registered so engine.ts's own `import { db }`
  // resolves to the pglite-backed instance, not the real Proxy.
  ;({ evaluateNudges } = await import('./engine.js'))
  schema = await import('../../../../drizzle/schema.js')
  // vi.mock's factory runs once and its own createTestDb() call is what
  // engine.ts actually queries against — grab a second handle to the SAME
  // underlying pglite instance for fixture setup by re-importing db/index.js
  // (already mocked, so this returns the identical mocked object).
  const dbModule = await import('../../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

async function makeTeamWithUser(opts: { role?: 'contributor' | 'leader' | 'admin' } = {}) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Test User',
  }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: user!.id, role: opts.role ?? 'contributor' })
  const [activityType] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  return { team: team!, user: user!, activityType: activityType! }
}

async function makeRule(teamId: string, overrides: Partial<typeof schema.nudgeRules.$inferInsert> = {}) {
  const [rule] = await testDb.insert(schema.nudgeRules).values({
    teamId,
    name: 'Test Rule',
    triggerType: 'no_activity_days',
    triggerConfig: { days: 5 },
    messageTemplate: 'Nudge!',
    isActive: true,
    ...overrides,
  }).returning()
  await testDb.insert(schema.nudgeRuleTeams).values({ nudgeRuleId: rule!.id, teamId })
  return rule!
}

async function logActivity(userId: string, teamId: string, activityTypeId: string, daysAgo: number) {
  await testDb.insert(schema.activities).values({
    userId,
    teamId,
    title: 'A',
    activityTypeId,
    startDatetime: subDays(new Date(), daysAgo),
    endDatetime: subDays(new Date(), daysAgo),
    effortHours: '1.00',
    createdAt: subDays(new Date(), daysAgo),
  })
}

describe('evaluateNudges — no_activity_days', () => {
  it('fires when the user has no activity within the configured window', async () => {
    const { team, user } = await makeTeamWithUser()
    const rule = await makeRule(team.id, { triggerConfig: { days: 5 } })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(true)
  })

  it('does not fire when the user logged activity within the window', async () => {
    const { team, user, activityType } = await makeTeamWithUser()
    const rule = await makeRule(team.id, { triggerConfig: { days: 5 } })
    await logActivity(user.id, team.id, activityType.id, 1)
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(false)
  })

  it('treats the configured days as a floor, not an exact match — activity 38 days ago still counts as stale for a 5-day rule', async () => {
    const { team, user, activityType } = await makeTeamWithUser()
    const rule = await makeRule(team.id, { triggerConfig: { days: 5 } })
    await logActivity(user.id, team.id, activityType.id, 38)
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(true)
  })

  it('substitutes {days} in the message template with the configured threshold', async () => {
    // Regression test: unlike every other trigger type in this file,
    // no_activity_days called emit() with the raw template, so the seeded
    // default ("...in the last {days} yet...") rendered the literal token.
    const { team, user } = await makeTeamWithUser()
    const rule = await makeRule(team.id, {
      triggerConfig: { days: 5 },
      messageTemplate: 'Nothing logged in the last {days} yet — catch up before Friday?',
    })
    const notifications = await evaluateNudges(user.id, team.id)
    const n = notifications.find((x) => x.ruleId === rule.id)
    expect(n?.message).toBe('Nothing logged in the last 5 yet — catch up before Friday?')
    expect(n?.message).not.toContain('{days}')
  })
})

describe('evaluateNudges — repeated tokens in a template all get substituted', () => {
  // Regression test: every trigger type's token substitution used a plain
  // string .replace('{token}', value), which only replaces the FIRST match —
  // a template using the same token twice left the second occurrence as a
  // literal "{token}". Fixed alongside the no_activity_days {days} bug by
  // switching every one of these to a global regex, matching how
  // {days_overdue} already worked. Covered here via sf_sync_failed's {count}
  // since it's the simplest trigger to set up two matching activities for.
  it('substitutes every occurrence of {count}, not just the first', async () => {
    const { team, user, activityType } = await makeTeamWithUser()
    const rule = await makeRule(team.id, {
      triggerType: 'sf_sync_failed',
      triggerConfig: { count: 1 },
      messageTemplate: '{count} activities failed to sync ({count} total)',
    })
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'A', activityTypeId: activityType.id,
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmSyncStatus: 'failed',
    })
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'B', activityTypeId: activityType.id,
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmSyncStatus: 'failed',
    })
    const notifications = await evaluateNudges(user.id, team.id)
    const n = notifications.find((x) => x.ruleId === rule.id)
    expect(n?.message).toBe('2 activities failed to sync (2 total)')
    expect(n?.message).not.toContain('{count}')
  })
})

describe('evaluateNudges — team assignment resolves via the nudge_rule_teams junction', () => {
  it('fires for a rule whose home team_id differs from the team being evaluated, as long as the junction row exists', async () => {
    // Regression test for the v1.297.0 bug: evaluateNudges() used to filter
    // by the base nudgeRules.teamId column directly, so a rule reassigned
    // to a different/additional team after creation silently never fired
    // there even though the admin UI (junction-backed) showed it as assigned.
    const homeTeam = await makeTeamWithUser()
    const otherTeam = await makeTeamWithUser()
    const [rule] = await testDb.insert(schema.nudgeRules).values({
      teamId: homeTeam.team.id, // home team — deliberately NOT otherTeam's id
      name: 'Test Rule',
      triggerType: 'no_activity_days',
      triggerConfig: { days: 5 },
      messageTemplate: 'Nudge!',
      isActive: true,
    }).returning()
    // Assigned to otherTeam via the junction only.
    await testDb.insert(schema.nudgeRuleTeams).values({ nudgeRuleId: rule!.id, teamId: otherTeam.team.id })

    const notifications = await evaluateNudges(otherTeam.user.id, otherTeam.team.id)
    expect(notifications.some((n) => n.ruleId === rule!.id)).toBe(true)
  })

  it('does not fire for a team the rule was never junction-assigned to', async () => {
    const { team, user } = await makeTeamWithUser()
    const unrelatedTeam = await makeTeamWithUser()
    const rule = await makeRule(unrelatedTeam.team.id)
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(false)
  })
})

describe('evaluateNudges — dismissals', () => {
  it('suppresses a rule with a permanent (NULL expiresAt) dismissal', async () => {
    const { team, user } = await makeTeamWithUser()
    const rule = await makeRule(team.id)
    await testDb.insert(schema.nudgeDismissals).values({ userId: user.id, nudgeRuleId: rule.id, expiresAt: null })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(false)
  })

  it('suppresses a rule with an active (future) snooze', async () => {
    const { team, user } = await makeTeamWithUser()
    const rule = await makeRule(team.id)
    await testDb.insert(schema.nudgeDismissals).values({ userId: user.id, nudgeRuleId: rule.id, expiresAt: subDays(new Date(), -3) })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(false)
  })

  it('does not suppress a rule whose snooze has already expired', async () => {
    const { team, user } = await makeTeamWithUser()
    const rule = await makeRule(team.id)
    await testDb.insert(schema.nudgeDismissals).values({ userId: user.id, nudgeRuleId: rule.id, expiresAt: subDays(new Date(), 1) })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(true)
  })
})

describe('evaluateNudges — cooldown', () => {
  it('suppresses a rule delivered within its cooldown window', async () => {
    const { team, user } = await makeTeamWithUser()
    const rule = await makeRule(team.id, { cooldownHours: 24 })
    await testDb.insert(schema.nudgeEvents).values({
      userId: user.id, teamId: team.id, nudgeRuleId: rule.id, triggerType: 'no_activity_days', message: 'x', deliveredAt: subDays(new Date(), 0),
    })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(false)
  })

  it('fires again once the cooldown window has passed', async () => {
    const { team, user } = await makeTeamWithUser()
    const rule = await makeRule(team.id, { cooldownHours: 24 })
    await testDb.insert(schema.nudgeEvents).values({
      userId: user.id, teamId: team.id, nudgeRuleId: rule.id, triggerType: 'no_activity_days', message: 'x', deliveredAt: subDays(new Date(), 2),
    })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(true)
  })
})

describe('evaluateNudges — AND/OR combinator', () => {
  it('AND: blocks emission when the extra clause does not hold, even though the base trigger does', async () => {
    const { team, user, activityType } = await makeTeamWithUser()
    await logActivity(user.id, team.id, activityType.id, 10)
    const rule = await makeRule(team.id, {
      triggerConfig: { days: 5 }, // last activity 10 days ago -> base trigger true (stale for a 5-day rule)
      conditions: { op: 'AND', clauses: [{ triggerType: 'no_activity_days', config: { days: 15 } }] }, // NOT stale for a 15-day window -> clause false
    })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(false)
  })

  it('AND: emits when both the base trigger and the extra clause hold', async () => {
    const { team, user, activityType } = await makeTeamWithUser()
    await logActivity(user.id, team.id, activityType.id, 10)
    const rule = await makeRule(team.id, {
      triggerConfig: { days: 5 },
      conditions: { op: 'AND', clauses: [{ triggerType: 'no_activity_days', config: { days: 8 } }] }, // also stale for an 8-day window -> clause true
    })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(true)
  })

  it('OR: the combinator gate opening does not override the base trigger\'s own emit decision', async () => {
    // A subtle, easy-to-misread behavior: the combinator only ever GATES
    // whether the base trigger's own check runs at all — it can never
    // substitute for that check. An OR clause that's true opens the gate,
    // but if the base trigger itself then evaluates false, nothing emits.
    const { team, user, activityType } = await makeTeamWithUser()
    await logActivity(user.id, team.id, activityType.id, 1) // recent -> base (5-day) trigger is false
    const rule = await makeRule(team.id, {
      triggerConfig: { days: 5 },
      conditions: { op: 'OR', clauses: [{ triggerType: 'no_activity_days', config: { days: 0 } }] }, // trivially true, opens the OR gate
    })
    const notifications = await evaluateNudges(user.id, team.id)
    expect(notifications.some((n) => n.ruleId === rule.id)).toBe(false)
  })
})
