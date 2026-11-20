// v1.471.1: stored Outlook Windows timezone names are rewritten to IANA ids
// at boot; IANA, UTC and unknown values are left alone.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let normalizeStoredTimezones: typeof import('./normalizeStoredTimezones.js')['normalizeStoredTimezones']
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  normalizeStoredTimezones = (await import('./normalizeStoredTimezones.js')).normalizeStoredTimezones
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.users)
})

async function addUser(timezone: string | null, outlookTimezone: string | null): Promise<string> {
  const [u] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@acme.com`,
    displayName: 'Test User',
    ...(timezone === null ? {} : { timezone }),
    outlookTimezone,
  }).returning()
  return u!.id
}

async function read(id: string) {
  const [u] = await testDb.select({ tz: schema.users.timezone, outlookTz: schema.users.outlookTimezone })
    .from(schema.users).where(eq(schema.users.id, id))
  return u!
}

describe('normalizeStoredTimezones', () => {
  it('rewrites Windows names in both columns', async () => {
    const a = await addUser('Pacific Standard Time', 'Pacific Standard Time')
    const b = await addUser('Europe/Berlin', 'W. Europe Standard Time')
    const { updated } = await normalizeStoredTimezones()
    expect(updated).toBe(2)
    expect(await read(a)).toEqual({ tz: 'America/Los_Angeles', outlookTz: 'America/Los_Angeles' })
    expect(await read(b)).toEqual({ tz: 'Europe/Berlin', outlookTz: 'Europe/Berlin' })
  })

  it('leaves IANA, UTC and unknown values alone and is idempotent', async () => {
    const a = await addUser('UTC', null)
    const b = await addUser('America/Chicago', 'Mystery Zone')
    expect((await normalizeStoredTimezones()).updated).toBe(0)
    expect(await read(a)).toEqual({ tz: 'UTC', outlookTz: null })
    expect(await read(b)).toEqual({ tz: 'America/Chicago', outlookTz: 'Mystery Zone' })

    await addUser('Tokyo Standard Time', null)
    expect((await normalizeStoredTimezones()).updated).toBe(1)
    expect((await normalizeStoredTimezones()).updated).toBe(0)
  })
})
