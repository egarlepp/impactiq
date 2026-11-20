// GET/PATCH /auth/me/timezone (v1.469.0): a user can pick their CRM's timezone
// or any timezone by hand, and that pick is recorded as timezone_source so the
// hourly Outlook check leaves it alone. Picking Outlook ('auto') puts the
// stored mailbox timezone back.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
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

let routes: typeof import('./profile.js')['profileAuthRoutes']
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  routes = (await import('./profile.js')).profileAuthRoutes
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.users)
  const [u] = await testDb.insert(schema.users)
    .values({ oktaId: `okta-${crypto.randomUUID()}`, email: 'jane@acme.com', displayName: 'Jane Doe' }).returning()
  userId = u!.id
})

async function call(method: 'GET' | 'PATCH', body?: unknown) {
  const app = express()
  app.use(express.json())
  app.use('/auth', routes)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/auth/me/timezone`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> | null; error: string | null } }
  } finally {
    server.close()
  }
}

async function stored() {
  const { eq } = await import('drizzle-orm')
  const [row] = await testDb.select({ timezone: schema.users.timezone, source: schema.users.timezoneSource })
    .from(schema.users).where(eq(schema.users.id, userId))
  return row
}

describe('/auth/me/timezone', () => {
  it('starts on UTC, following Outlook, with no mailbox timezone', async () => {
    const { status, body } = await call('GET')
    expect(status).toBe(200)
    expect(body.data).toEqual({ timezone: 'UTC', source: 'auto', outlookTimezone: null })
  })

  it('saves a manual timezone without Outlook or a CRM', async () => {
    const { status, body } = await call('PATCH', { source: 'manual', timezone: 'Europe/Berlin' })
    expect(status).toBe(200)
    expect(body.data).toEqual({ timezone: 'Europe/Berlin', source: 'manual' })
    expect(await stored()).toEqual({ timezone: 'Europe/Berlin', source: 'manual' })
  })

  it('reads a body with only a timezone as manual', async () => {
    await call('PATCH', { timezone: 'America/Chicago' })
    expect(await stored()).toEqual({ timezone: 'America/Chicago', source: 'manual' })
  })

  it('refuses a timezone the runtime does not know', async () => {
    const { status, body } = await call('PATCH', { source: 'manual', timezone: 'Mars/Olympus' })
    expect(status).toBe(400)
    expect(body.error).toBe('errors.timezone.invalid')
    expect(await stored()).toEqual({ timezone: 'UTC', source: 'auto' })
  })

  it('saves the CRM timezone as crm', async () => {
    await call('PATCH', { source: 'crm', timezone: 'US/Eastern' })
    expect(await stored()).toEqual({ timezone: 'US/Eastern', source: 'crm' })
  })

  it('goes back to the stored Outlook timezone on auto', async () => {
    const { eq } = await import('drizzle-orm')
    await testDb.update(schema.users)
      .set({ timezone: 'Europe/Berlin', timezoneSource: 'manual', outlookTimezone: 'Pacific Standard Time' })
      .where(eq(schema.users.id, userId))
    const { status } = await call('PATCH', { source: 'auto' })
    expect(status).toBe(200)
    expect(await stored()).toEqual({ timezone: 'Pacific Standard Time', source: 'auto' })
  })

  it('refuses auto when no mailbox timezone is known', async () => {
    const { status, body } = await call('PATCH', { source: 'auto' })
    expect(status).toBe(409)
    expect(body.error).toBe('errors.timezone.outlook_unknown')
  })
})
