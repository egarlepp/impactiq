// GET /api/activities?weekStart= (v1.456.2): the window is the 7 days from the
// week start the client sends. The Activities page sends a Sunday when its weeks
// start on Sunday; endOfWeek(Monday-anchored) used to end that window on the
// same Sunday, so the list showed nothing for the rest of the week.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let currentUserId = ''
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js')
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { user: { id: string } }).user = { id: currentUserId }
      next()
    },
  }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let mod: typeof import('./activities.js')

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  mod = await import('./activities.js')
})

async function list(teamId: string, weekStart: string): Promise<string[]> {
  const app = express()
  app.use('/api/activities', mod.activitiesRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const qs = new URLSearchParams({ teamId, weekStart })
    const res = await fetch(`http://127.0.0.1:${port}/api/activities?${qs.toString()}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { title: string }[] }
    return body.data.map((a) => a.title).sort()
  } finally {
    server.close()
  }
}

describe('GET /api/activities week window', () => {
  it('covers the 7 days from the given week start, Sunday or Monday', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
    await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: user!.id, role: 'contributor' })
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    currentUserId = user!.id
    // US Eastern (UTC-4 in October): local times written as UTC instants.
    const add = (title: string, startIso: string) => testDb.insert(schema.activities).values({
      userId: user!.id, teamId: team!.id, activityTypeId: type!.id, title,
      startDatetime: new Date(startIso), endDatetime: new Date(new Date(startIso).getTime() + 3600_000), effortHours: '1.00',
    })
    await add('sat-before', '2026-10-17T14:00:00Z')
    await add('sun-first', '2026-10-18T14:00:00Z')    // Sun Oct 18, 10:00 local
    await add('wed', '2026-10-21T14:00:00Z')
    await add('sat-last', '2026-10-24T14:00:00Z')
    await add('sun-evening', '2026-10-25T22:00:00Z')  // Sun Oct 25, 18:00 local
    await add('mon-next', '2026-10-26T14:00:00Z')

    // Sunday-first week Sun Oct 18 – Sat Oct 24, local midnight in UTC-4.
    expect(await list(team!.id, '2026-10-18T00:00:00-04:00')).toEqual(['sat-last', 'sun-first', 'wed'])
    // Monday-first week Mon Oct 19 – Sun Oct 25 keeps the Sunday evening.
    expect(await list(team!.id, '2026-10-19T00:00:00-04:00')).toEqual(['sat-last', 'sun-evening', 'wed'])
  })
})
