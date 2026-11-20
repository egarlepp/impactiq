// User Management's Subteams picker (v1.470.0), against pglite. Reproduces the
// report: a user only on [Demo] Sales Engineering was offered Solutions
// Engineering's Leadership subteam.
import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'
import express from 'express'
import { and, eq } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../../services/audit/log.js', () => ({ logAudit: async () => {} }))

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let base = ''
let adminId = ''

interface SubteamRow { id: string; name: string; teamId: string; teamName: string; outsideTeams?: boolean }

async function call<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: T; error: string | null; meta: Record<string, unknown> } }
}

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  const { teamsAdminRoutes } = await import('./teams.js')
  const { teamMembersRoutes } = await import('./teamMembers.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: adminId }; next() })
  app.use('/api/admin', teamsAdminRoutes)
  app.use('/api/admin', teamMembersRoutes)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const [admin] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'Admin', isAppAdmin: true }).returning()
  adminId = admin!.id
})

async function setup() {
  const [demo] = await testDb.insert(schema.teams).values({ name: '[Demo] Sales Engineering', slug: `t-${crypto.randomUUID()}` }).returning()
  const [se] = await testDb.insert(schema.teams).values({ name: 'Solutions Engineering', slug: `t-${crypto.randomUUID()}` }).returning()
  const [east] = await testDb.insert(schema.subteams).values({ teamId: demo!.id, name: '[Demo] East', kind: 'region' }).returning()
  const [west] = await testDb.insert(schema.subteams).values({ teamId: demo!.id, name: '[Demo] West', kind: 'region' }).returning()
  const [leadership] = await testDb.insert(schema.subteams).values({ teamId: se!.id, name: 'Leadership', kind: 'leader' }).returning()
  const [jordan] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'Jordan Demo', defaultTeamId: demo!.id }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId: demo!.id, userId: jordan!.id, role: 'contributor' })
  return { demo: demo!, se: se!, east: east!, west: west!, leadership: leadership!, jordan: jordan! }
}

async function memberSubteamIds(userId: string) {
  const rows = await testDb.select({ id: schema.subteamUsers.subteamId }).from(schema.subteamUsers)
    .where(and(eq(schema.subteamUsers.userId, userId), eq(schema.subteamUsers.role, 'member')))
  return rows.map((r) => r.id).sort()
}

describe('user subteam picker', () => {
  it('offers only subteams of the user\'s own teams', async () => {
    const { jordan, east, west } = await setup()
    const res = await call<SubteamRow[]>('GET', `/users/${jordan.id}/subteam-options`)
    expect(res.status).toBe(200)
    expect(res.json.data.map((r) => r.id).sort()).toEqual([east.id, west.id].sort())
  })

  it('refuses a subteam on a team the user is not part of', async () => {
    const { jordan, east, leadership } = await setup()
    const res = await call('PUT', `/users/${jordan.id}/subteams`, { subteamIds: [east.id, leadership.id] })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('errors.subteams.not_user_team')
    expect(res.json.meta['subteamIds']).toEqual([leadership.id])
    expect(await memberSubteamIds(jordan.id)).toEqual([])
    const ok = await call('PUT', `/users/${jordan.id}/subteams`, { subteamIds: [east.id] })
    expect(ok.status).toBe(200)
    expect(await memberSubteamIds(jordan.id)).toEqual([east.id])
  })

  it('flags an existing stale assignment, lets it be kept or removed, never re-added', async () => {
    const { jordan, east, leadership } = await setup()
    await testDb.insert(schema.subteamUsers).values({ subteamId: leadership.id, userId: jordan.id, role: 'member' })
    const mine = await call<SubteamRow[]>('GET', `/users/${jordan.id}/subteams`)
    expect(mine.json.data).toEqual([expect.objectContaining({ id: leadership.id, teamName: 'Solutions Engineering', outsideTeams: true })])
    // Changing another subteam keeps the stale one.
    expect((await call('PUT', `/users/${jordan.id}/subteams`, { subteamIds: [leadership.id, east.id] })).status).toBe(200)
    // Removing it works; adding it back is refused.
    expect((await call('PUT', `/users/${jordan.id}/subteams`, { subteamIds: [east.id] })).status).toBe(200)
    expect((await call('PUT', `/users/${jordan.id}/subteams`, { subteamIds: [east.id, leadership.id] })).status).toBe(400)
    expect(await memberSubteamIds(jordan.id)).toEqual([east.id])
  })

  it('removing someone from a team drops that team\'s subteams only', async () => {
    const { se, jordan, east, leadership } = await setup()
    await testDb.insert(schema.teamMembers).values({ teamId: se.id, userId: jordan.id, role: 'contributor' })
    await testDb.insert(schema.subteamUsers).values([
      { subteamId: east.id, userId: jordan.id, role: 'member' },
      { subteamId: leadership.id, userId: jordan.id, role: 'member' },
      { subteamId: leadership.id, userId: jordan.id, role: 'leader' },
    ])
    const res = await call('DELETE', `/teams/${se.id}/users/${jordan.id}`)
    expect(res.status).toBe(200)
    expect(await memberSubteamIds(jordan.id)).toEqual([east.id])
    // Subteam leader rows are Team Management's, so they stay.
    const leaderRows = await testDb.select().from(schema.subteamUsers)
      .where(and(eq(schema.subteamUsers.userId, jordan.id), eq(schema.subteamUsers.role, 'leader')))
    expect(leaderRows).toHaveLength(1)
  })
})
