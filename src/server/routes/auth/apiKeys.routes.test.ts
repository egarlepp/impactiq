// POST /auth/api-keys: an activities:log key (v1.481.0) logs draft activities
// for anyone by email, so only an App Admin may mint one.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let userId = ''
vi.mock('../../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth.js')>('../../middleware/auth.js')
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { user: { id: string } }).user = { id: userId }
      next()
    },
  }
})

let routes: typeof import('./apiKeys.js')['apiKeysAuthRoutes']
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let adminId = ''
let plainId = ''

beforeAll(async () => {
  routes = (await import('./apiKeys.js')).apiKeysAuthRoutes
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  const [a] = await testDb.insert(schema.users).values({ oktaId: 'okta-a', email: 'ada@example.com', displayName: 'Ada', isAppAdmin: true }).returning()
  const [p] = await testDb.insert(schema.users).values({ oktaId: 'okta-p', email: 'pat@example.com', displayName: 'Pat' }).returning()
  adminId = a!.id
  plainId = p!.id
})

async function mint(scopes: string[]) {
  const app = express()
  app.use(express.json())
  app.use('/auth', routes)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/auth/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DemoIQ', scopes }),
    })
    return { status: res.status, body: await res.json() as { data: { scopes: string[] } | null; error: string | null } }
  } finally {
    server.close()
  }
}

describe('POST /auth/api-keys activities:log', () => {
  it('refuses a user who is not an App Admin', async () => {
    userId = plainId
    expect((await mint(['activities:log'])).status).toBe(403)
    expect((await mint(['rest:full'])).status).toBe(201)
  })

  it('lets an App Admin mint it', async () => {
    userId = adminId
    const res = await mint(['activities:log'])
    expect(res.status).toBe(201)
    expect(res.body.data!.scopes).toEqual(['activities:log'])
  })
})
