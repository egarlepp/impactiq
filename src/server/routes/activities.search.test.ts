// GET /api/activities/search (v1.420.0, the header's global search): only the
// caller's own, non-archived activities, matched on title and linked CRM
// names, with LIKE wildcards in the query taken literally.
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

interface Hit { id: string; title: string }

async function search(q: string): Promise<Hit[]> {
  const app = express()
  app.use('/api/activities', mod.activitiesRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/activities/search?q=${encodeURIComponent(q)}`)
    const body = await res.json() as { data: Hit[] }
    return body.data
  } finally {
    server.close()
  }
}

async function seedUser(): Promise<{ userId: string; teamId: string; typeId: string }> {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  return { userId: user!.id, teamId: team!.id, typeId: type!.id }
}

async function addActivity(owner: { userId: string; teamId: string; typeId: string }, title: string, extra: Record<string, unknown> = {}) {
  await testDb.insert(schema.activities).values({
    userId: owner.userId,
    teamId: owner.teamId,
    activityTypeId: owner.typeId,
    title,
    startDatetime: new Date('2026-10-20T15:00:00Z'),
    endDatetime: new Date('2026-10-20T16:00:00Z'),
    effortHours: '1.00',
    ...extra,
  })
}

describe('likeContains', () => {
  it('escapes LIKE wildcards and backslashes', () => {
    expect(mod.likeContains('50%_off\\x')).toBe('%50\\%\\_off\\\\x%')
  })
})

describe('GET /api/activities/search', () => {
  it("returns only the caller's own, non-archived matches", async () => {
    const me = await seedUser()
    const other = await seedUser()
    await addActivity(me, 'Demo for Acme Corp')
    await addActivity(me, 'Discovery', { crmWhatName: 'Acme Renewal' })
    await addActivity(me, 'Old Acme call', { isArchived: true })
    await addActivity(other, 'Acme for someone else')
    currentUserId = me.userId
    const titles = (await search('acme')).map((h) => h.title).sort()
    expect(titles).toEqual(['Demo for Acme Corp', 'Discovery'])
  })

  it('ignores queries shorter than the minimum', async () => {
    const me = await seedUser()
    await addActivity(me, 'A')
    currentUserId = me.userId
    expect(await search('a')).toEqual([])
  })

  it('takes a typed % literally', async () => {
    const me = await seedUser()
    await addActivity(me, 'Pricing 50% review')
    await addActivity(me, 'Pricing 500 review')
    currentUserId = me.userId
    expect((await search('50%')).map((h) => h.title)).toEqual(['Pricing 50% review'])
  })
})
