// pglite-backed regression test for the "stale announcement notification never
// disappears" bug: syncAnnouncementNotifications() used to only ever
// insert/refresh rows for CURRENTLY active announcements, and never removed a
// row once the underlying announcement was deleted, deactivated, or its date
// range changed to no longer cover today — so a banner/bell entry outlived
// the announcement it came from indefinitely, self-healing being wrongly
// assumed to happen from the (unrelated) dismiss action.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { format } from 'date-fns'
import type { TestDb } from '../db/testDb.js'

let testDb: TestDb
vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let syncAnnouncementNotifications: typeof import('./notifications.js')['syncAnnouncementNotifications']
let schema: typeof import('../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ syncAnnouncementNotifications } = await import('./notifications.js'))
  schema = await import('../../../drizzle/schema.js')
  const dbModule = await import('../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

function todayIso(): string { return format(new Date(), 'yyyy-MM-dd') }

async function makeTeamWithUser() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Test User',
  }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: user!.id, role: 'contributor' })
  return { team: team!, user: user! }
}

async function announcementNotificationRows(userId: string) {
  return testDb.select().from(schema.notifications).where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.kind, 'announcement')))
}

describe('syncAnnouncementNotifications — stale row cleanup', () => {
  it('a notification row disappears on the next sync once its announcement is deleted', async () => {
    const { team, user } = await makeTeamWithUser()
    const [a] = await testDb.insert(schema.announcements).values({
      teamId: team.id, targetType: 'team', message: 'Hello', startDate: todayIso(), isActive: true,
    }).returning()

    await syncAnnouncementNotifications(user.id)
    expect(await announcementNotificationRows(user.id)).toHaveLength(1)

    await testDb.delete(schema.announcements).where(eq(schema.announcements.id, a!.id))
    await syncAnnouncementNotifications(user.id)
    expect(await announcementNotificationRows(user.id)).toHaveLength(0)
  })

  it('a notification row disappears once the announcement is set inactive', async () => {
    const { team, user } = await makeTeamWithUser()
    const [a] = await testDb.insert(schema.announcements).values({
      teamId: team.id, targetType: 'team', message: 'Hello', startDate: todayIso(), isActive: true,
    }).returning()

    await syncAnnouncementNotifications(user.id)
    expect(await announcementNotificationRows(user.id)).toHaveLength(1)

    await testDb.update(schema.announcements).set({ isActive: false }).where(eq(schema.announcements.id, a!.id))
    await syncAnnouncementNotifications(user.id)
    expect(await announcementNotificationRows(user.id)).toHaveLength(0)
  })

  it('a notification row disappears once the announcement\'s start date is edited into the future', async () => {
    const { team, user } = await makeTeamWithUser()
    const [a] = await testDb.insert(schema.announcements).values({
      teamId: team.id, targetType: 'team', message: 'Hello', startDate: todayIso(), isActive: true,
    }).returning()

    await syncAnnouncementNotifications(user.id)
    expect(await announcementNotificationRows(user.id)).toHaveLength(1)

    await testDb.update(schema.announcements).set({ startDate: format(new Date(Date.now() + 7 * 86400000), 'yyyy-MM-dd') }).where(eq(schema.announcements.id, a!.id))
    await syncAnnouncementNotifications(user.id)
    expect(await announcementNotificationRows(user.id)).toHaveLength(0)
  })

  it('a still-active announcement is left untouched by cleanup, including after re-sync', async () => {
    const { team, user } = await makeTeamWithUser()
    await testDb.insert(schema.announcements).values({
      teamId: team.id, targetType: 'team', message: 'Hello', startDate: todayIso(), isActive: true,
    })
    await syncAnnouncementNotifications(user.id)
    await syncAnnouncementNotifications(user.id)
    expect(await announcementNotificationRows(user.id)).toHaveLength(1)
  })

  it('carries icon + light/dark colors onto the synced notification row', async () => {
    const { team, user } = await makeTeamWithUser()
    await testDb.insert(schema.announcements).values({
      teamId: team.id, targetType: 'team', message: 'Hello', startDate: todayIso(), isActive: true,
      icon: 'Rocket', iconColorLight: '#4f46e5', iconColorDark: '#818cf8',
    })
    await syncAnnouncementNotifications(user.id)
    const [row] = await announcementNotificationRows(user.id)
    expect(row).toMatchObject({ icon: 'Rocket', iconColorLight: '#4f46e5', iconColorDark: '#818cf8' })
  })

  it('a still-active announcement does NOT accumulate a duplicate row on a later day\'s sync — the reported "duplicate banner" bug', async () => {
    // A never-dismissed announcement active across multiple consecutive days
    // used to leave BOTH days' rows in place: the id-only cleanup check only
    // ever asked "is this announcement still active?" (yes), never "is this
    // SPECIFIC dedupeKey — which embeds the day — still today's?" so
    // yesterday's now-superseded row survived right alongside today's fresh
    // one, rendering as two identical banners for one announcement. Simulate
    // that directly: sync once (mints "today's" row), then hand-edit that
    // row's own dedupeKey to look like it was minted on a previous day
    // (mirroring how engine.test.ts simulates day changes elsewhere in this
    // codebase), then sync again as if today's real sync is happening.
    const { team, user } = await makeTeamWithUser()
    const [a] = await testDb.insert(schema.announcements).values({
      teamId: team.id, targetType: 'team', message: 'Still going', startDate: todayIso(), isActive: true,
    }).returning()

    await syncAnnouncementNotifications(user.id)
    const rowsAfterDay1 = await announcementNotificationRows(user.id)
    expect(rowsAfterDay1).toHaveLength(1)

    // Backdate the row's dedupeKey to simulate it having been written on a
    // previous day, without touching the announcement itself — it's still
    // active today, exactly like the reported symptom.
    await testDb
      .update(schema.notifications)
      .set({ dedupeKey: `announcement:${a!.id}:2020-01-01` })
      .where(eq(schema.notifications.id, rowsAfterDay1[0]!.id))

    await syncAnnouncementNotifications(user.id)
    const rowsAfterDay2 = await announcementNotificationRows(user.id)
    expect(rowsAfterDay2).toHaveLength(1)
    expect(rowsAfterDay2[0]!.dedupeKey).toBe(`announcement:${a!.id}:${todayIso()}`)
  })
})
