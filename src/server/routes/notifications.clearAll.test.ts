// pglite-backed tests for the bell's "Clear all" (v1.426.0). The two things
// that matter: it only clears the team in view (plus announcements), and it
// mutes today's nudges for the day instead of closing their rules out
// forever, which is what the bell's per-row X does.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../db/testDb.js'

let testDb: TestDb
vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let clearNotificationsForUser: typeof import('./notifications.js')['clearNotificationsForUser']
let schema: typeof import('../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ clearNotificationsForUser } = await import('./notifications.js'))
  schema = await import('../../../drizzle/schema.js')
  const dbModule = await import('../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

const today = () => new Date().toISOString().slice(0, 10)

async function setup() {
  const [teamA] = await testDb.insert(schema.teams).values({ name: 'A', slug: `a-${crypto.randomUUID()}` }).returning()
  const [teamB] = await testDb.insert(schema.teams).values({ name: 'B', slug: `b-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Test User',
  }).returning()
  const [rule] = await testDb.insert(schema.nudgeRules).values({
    teamId: teamA!.id,
    name: 'No Activity Days',
    triggerType: 'no_activity_days',
    triggerConfig: { days: 5 },
    messageTemplate: 'Nothing logged',
  }).returning()
  return { teamA: teamA!, teamB: teamB!, user: user!, rule: rule! }
}

describe('clearNotificationsForUser', () => {
  it('clears only the team in view, and mutes today\'s nudge until tomorrow rather than forever', async () => {
    const { teamA, teamB, user, rule } = await setup()
    await testDb.insert(schema.notifications).values([
      { userId: user.id, teamId: teamA.id, kind: 'nudge', message: 'today', dedupeKey: `nudge:${rule.id}:${today()}` },
      { userId: user.id, teamId: teamA.id, kind: 'nudge', message: 'older', dedupeKey: `nudge:${rule.id}:2026-01-05` },
      { userId: user.id, teamId: teamB.id, kind: 'nudge', message: 'other team', dedupeKey: `nudge:${rule.id}:2026-01-06` },
    ])

    const cleared = await clearNotificationsForUser(user.id, teamA.id)
    expect(cleared).toBe(2)

    const left = await testDb.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id))
    expect(left.map((n) => n.message)).toEqual(['other team'])

    const dismissals = await testDb.select().from(schema.nudgeDismissals).where(eq(schema.nudgeDismissals.userId, user.id))
    expect(dismissals).toHaveLength(1)
    // A day mute, never the permanent close-out (expiresAt NULL).
    expect(dismissals[0]!.expiresAt).not.toBeNull()
    expect(dismissals[0]!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000)
  })

  it('with no team (All Teams) clears every row and dismisses announcements', async () => {
    const { teamA, teamB, user, rule } = await setup()
    const [a] = await testDb.insert(schema.announcements).values({
      teamId: teamA.id, targetType: 'team', message: 'Hello', startDate: today(), isActive: true,
    }).returning()
    await testDb.insert(schema.notifications).values([
      { userId: user.id, teamId: teamB.id, kind: 'nudge', message: 'b', dedupeKey: `nudge:${rule.id}:2026-01-06` },
      { userId: user.id, teamId: null, kind: 'announcement', message: 'Hello', dedupeKey: `announcement:${a!.id}:${today()}` },
    ])

    expect(await clearNotificationsForUser(user.id, null)).toBe(2)
    expect(await testDb.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id))).toHaveLength(0)
    const dismissed = await testDb.select().from(schema.announcementDismissals).where(eq(schema.announcementDismissals.userId, user.id))
    expect(dismissed.map((d) => d.announcementId)).toEqual([a!.id])
    // An older day's nudge row is never re-synced, so no mute is recorded for it.
    expect(await testDb.select().from(schema.nudgeDismissals).where(eq(schema.nudgeDismissals.userId, user.id))).toHaveLength(0)
  })
})
