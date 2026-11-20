// pglite-backed tests for getActiveAnnouncementsForUser()/dismissAnnouncementForUser().
// Mirrors nudge/engine.test.ts's shared-instance-per-file setup (see that file's own
// header comment for why: a fresh pglite instance replaying 150+ migrations costs
// several seconds, so per-test instances would make the suite prohibitively slow).
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { addDays, format } from 'date-fns'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'

let testDb: TestDb
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let getActiveAnnouncementsForUser: typeof import('./engine.js')['getActiveAnnouncementsForUser']
let dismissAnnouncementForUser: typeof import('./engine.js')['dismissAnnouncementForUser']
let schema: typeof import('../../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ getActiveAnnouncementsForUser, dismissAnnouncementForUser } = await import('./engine.js'))
  schema = await import('../../../../drizzle/schema.js')
  const dbModule = await import('../../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

function todayIso(): string { return format(new Date(), 'yyyy-MM-dd') }
function isoDaysFromNow(n: number): string { return format(addDays(new Date(), n), 'yyyy-MM-dd') }

async function makeTeam() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  return team!
}
async function makeUser(overrides: Partial<typeof schema.users.$inferInsert> = {}) {
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Test User',
    ...overrides,
  }).returning()
  return user!
}
async function addToTeam(teamId: string, userId: string) {
  await testDb.insert(schema.teamMembers).values({ teamId, userId, role: 'contributor' })
}
async function makeSubteam(teamId: string) {
  const [subteam] = await testDb.insert(schema.subteams).values({ teamId, name: `ST-${crypto.randomUUID()}` }).returning()
  return subteam!
}
async function addToSubteam(subteamId: string, userId: string, role = 'member') {
  await testDb.insert(schema.subteamUsers).values({ subteamId, userId, role })
}

async function makeAnnouncement(overrides: Partial<typeof schema.announcements.$inferInsert> & { teamId: string; targetType: 'team' | 'subteam' | 'user' }) {
  const [row] = await testDb.insert(schema.announcements).values({
    message: 'Hello team',
    severity: 'info',
    startDate: todayIso(),
    recurringDaily: false,
    isActive: true,
    ...overrides,
  }).returning()
  return row!
}

describe('getActiveAnnouncementsForUser', () => {
  it('returns a team-targeted announcement to a member of that team', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team' })
    const { items } = await getActiveAnnouncementsForUser(user.id)
    expect(items.some((i) => i.id === a.id)).toBe(true)
  })

  it('does NOT return a team-targeted announcement to a user on a different team', async () => {
    const team = await makeTeam()
    const otherTeam = await makeTeam()
    const user = await makeUser()
    await addToTeam(otherTeam.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team' })
    const { items } = await getActiveAnnouncementsForUser(user.id)
    expect(items.some((i) => i.id === a.id)).toBe(false)
  })

  it('returns a subteam-targeted announcement only to members of that specific subteam', async () => {
    const team = await makeTeam()
    const subteam = await makeSubteam(team.id)
    const otherSubteam = await makeSubteam(team.id)
    const member = await makeUser()
    const outsider = await makeUser()
    await addToTeam(team.id, member.id)
    await addToTeam(team.id, outsider.id)
    await addToSubteam(subteam.id, member.id)
    await addToSubteam(otherSubteam.id, outsider.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'subteam', subteamId: subteam.id })
    const memberResult = await getActiveAnnouncementsForUser(member.id)
    const outsiderResult = await getActiveAnnouncementsForUser(outsider.id)
    expect(memberResult.items.some((i) => i.id === a.id)).toBe(true)
    expect(outsiderResult.items.some((i) => i.id === a.id)).toBe(false)
  })

  it('returns a user-targeted announcement only to that exact user, regardless of team/subteam membership', async () => {
    const team = await makeTeam()
    const target = await makeUser()
    const someoneElse = await makeUser()
    // Deliberately no team_members row for `target` at all — a user-targeted
    // announcement must not depend on any team/subteam membership.
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'user', targetUserId: target.id })
    const targetResult = await getActiveAnnouncementsForUser(target.id)
    const otherResult = await getActiveAnnouncementsForUser(someoneElse.id)
    expect(targetResult.items.some((i) => i.id === a.id)).toBe(true)
    expect(otherResult.items.some((i) => i.id === a.id)).toBe(false)
  })

  it('excludes an announcement whose startDate is in the future', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team', startDate: isoDaysFromNow(1) })
    const { items } = await getActiveAnnouncementsForUser(user.id)
    expect(items.some((i) => i.id === a.id)).toBe(false)
  })

  it('excludes an announcement whose endDate is in the past', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team', startDate: isoDaysFromNow(-10), endDate: isoDaysFromNow(-1) })
    const { items } = await getActiveAnnouncementsForUser(user.id)
    expect(items.some((i) => i.id === a.id)).toBe(false)
  })

  it('includes an announcement whose endDate is today (inclusive boundary)', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team', startDate: isoDaysFromNow(-5), endDate: todayIso() })
    const { items } = await getActiveAnnouncementsForUser(user.id)
    expect(items.some((i) => i.id === a.id)).toBe(true)
  })

  it('excludes an announcement with isActive=false', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team', isActive: false })
    const { items } = await getActiveAnnouncementsForUser(user.id)
    expect(items.some((i) => i.id === a.id)).toBe(false)
  })

  it('a non-recurring announcement is excluded forever once dismissed', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team', recurringDaily: false })
    await dismissAnnouncementForUser(user.id, a.id)
    const { items } = await getActiveAnnouncementsForUser(user.id)
    expect(items.some((i) => i.id === a.id)).toBe(false)
  })

  it('a recurring announcement is excluded only for the local day it was dismissed, and reappears once that day has passed', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const a = await makeAnnouncement({ teamId: team.id, targetType: 'team', recurringDaily: true })
    await dismissAnnouncementForUser(user.id, a.id)
    const sameDay = await getActiveAnnouncementsForUser(user.id)
    expect(sameDay.items.some((i) => i.id === a.id)).toBe(false)

    // Simulate "tomorrow" by directly rewriting the stored dismissal to
    // yesterday's local date, rather than depending on the real system clock.
    await testDb.update(schema.announcementDismissals)
      .set({ dismissedLocalDate: isoDaysFromNow(-1) })
      .where(eq(schema.announcementDismissals.announcementId, a.id))
    const nextDay = await getActiveAnnouncementsForUser(user.id)
    expect(nextDay.items.some((i) => i.id === a.id)).toBe(true)
  })

  it('carries icon + light/dark colors through unchanged when set, and null when unset', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await addToTeam(team.id, user.id)
    const withIcon = await makeAnnouncement({
      teamId: team.id, targetType: 'team', icon: 'Rocket', iconColorLight: '#4f46e5', iconColorDark: '#818cf8',
    })
    const withoutIcon = await makeAnnouncement({ teamId: team.id, targetType: 'team' })
    const { items } = await getActiveAnnouncementsForUser(user.id)
    const withIconItem = items.find((i) => i.id === withIcon.id)
    const withoutIconItem = items.find((i) => i.id === withoutIcon.id)
    expect(withIconItem).toMatchObject({ icon: 'Rocket', iconColorLight: '#4f46e5', iconColorDark: '#818cf8' })
    expect(withoutIconItem).toMatchObject({ icon: null, iconColorLight: null, iconColorDark: null })
  })
})
