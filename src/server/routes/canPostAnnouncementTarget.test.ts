// pglite-backed tests for canPostAnnouncementTarget() (exported from teams.ts),
// the target-permission narrowing behind the Announcements admin CRUD routes:
// App Admin/Team Admin -> any target; a plain Leader -> only a subteam they
// lead, or a user sharing an accessible team with them, never team-wide.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { TestDb } from '../db/testDb.js'

let testDb: TestDb
vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let canPostAnnouncementTarget: typeof import('./teams.js')['canPostAnnouncementTarget']
let schema: typeof import('../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ canPostAnnouncementTarget } = await import('./teams.js'))
  schema = await import('../../../drizzle/schema.js')
  const dbModule = await import('../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

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
async function addMember(teamId: string, userId: string, role: 'contributor' | 'leader' | 'team_admin' | 'admin') {
  await testDb.insert(schema.teamMembers).values({ teamId, userId, role })
}
async function makeSubteam(teamId: string) {
  const [subteam] = await testDb.insert(schema.subteams).values({ teamId, name: `ST-${crypto.randomUUID()}` }).returning()
  return subteam!
}

describe('canPostAnnouncementTarget', () => {
  it('an App Admin may post any target type', async () => {
    const team = await makeTeam()
    const appAdmin = await makeUser({ isAppAdmin: true })
    // App Admin needs no team_members row at all.
    expect(await canPostAnnouncementTarget(appAdmin.id, team.id, 'team', {})).toBe(true)
    const subteam = await makeSubteam(team.id)
    expect(await canPostAnnouncementTarget(appAdmin.id, team.id, 'subteam', { subteamId: subteam.id })).toBe(true)
    const someone = await makeUser()
    await addMember(team.id, someone.id, 'contributor')
    expect(await canPostAnnouncementTarget(appAdmin.id, team.id, 'user', { targetUserId: someone.id })).toBe(true)
  })

  it('a team_admin on this team may post any target type', async () => {
    const team = await makeTeam()
    const teamAdmin = await makeUser()
    await addMember(team.id, teamAdmin.id, 'team_admin')
    expect(await canPostAnnouncementTarget(teamAdmin.id, team.id, 'team', {})).toBe(true)
    const subteam = await makeSubteam(team.id)
    expect(await canPostAnnouncementTarget(teamAdmin.id, team.id, 'subteam', { subteamId: subteam.id })).toBe(true)
  })

  it('a plain leader is rejected for a team-wide target', async () => {
    const team = await makeTeam()
    const leader = await makeUser()
    await addMember(team.id, leader.id, 'leader')
    expect(await canPostAnnouncementTarget(leader.id, team.id, 'team', {})).toBe(false)
  })

  it('a plain leader is allowed for a subteam they lead, and rejected for one they do not', async () => {
    const team = await makeTeam()
    const leader = await makeUser()
    await addMember(team.id, leader.id, 'leader')
    const ledSubteam = await makeSubteam(team.id)
    const otherSubteam = await makeSubteam(team.id)
    await testDb.insert(schema.subteamUsers).values({ subteamId: ledSubteam.id, userId: leader.id, role: 'leader' })
    expect(await canPostAnnouncementTarget(leader.id, team.id, 'subteam', { subteamId: ledSubteam.id })).toBe(true)
    expect(await canPostAnnouncementTarget(leader.id, team.id, 'subteam', { subteamId: otherSubteam.id })).toBe(false)
  })

  it('a plain leader who is merely a MEMBER (not leader) of a subteam is still rejected for it', async () => {
    const team = await makeTeam()
    const leader = await makeUser()
    await addMember(team.id, leader.id, 'leader')
    const subteam = await makeSubteam(team.id)
    await testDb.insert(schema.subteamUsers).values({ subteamId: subteam.id, userId: leader.id, role: 'member' })
    expect(await canPostAnnouncementTarget(leader.id, team.id, 'subteam', { subteamId: subteam.id })).toBe(false)
  })

  it('a plain leader is allowed for a user sharing an accessible team with them, rejected otherwise', async () => {
    const team = await makeTeam()
    const otherTeam = await makeTeam()
    const leader = await makeUser()
    await addMember(team.id, leader.id, 'leader')
    const sameTeamUser = await makeUser()
    await addMember(team.id, sameTeamUser.id, 'contributor')
    const otherTeamUser = await makeUser()
    await addMember(otherTeam.id, otherTeamUser.id, 'contributor')
    expect(await canPostAnnouncementTarget(leader.id, team.id, 'user', { targetUserId: sameTeamUser.id })).toBe(true)
    expect(await canPostAnnouncementTarget(leader.id, team.id, 'user', { targetUserId: otherTeamUser.id })).toBe(false)
  })

  it('a plain contributor (no leader/admin role at all) is rejected for every target type', async () => {
    const team = await makeTeam()
    const contributor = await makeUser()
    await addMember(team.id, contributor.id, 'contributor')
    expect(await canPostAnnouncementTarget(contributor.id, team.id, 'team', {})).toBe(false)
    const subteam = await makeSubteam(team.id)
    expect(await canPostAnnouncementTarget(contributor.id, team.id, 'subteam', { subteamId: subteam.id })).toBe(false)
  })

  it('a user with no membership on the team at all is rejected', async () => {
    const team = await makeTeam()
    const stranger = await makeUser()
    expect(await canPostAnnouncementTarget(stranger.id, team.id, 'team', {})).toBe(false)
  })
})
