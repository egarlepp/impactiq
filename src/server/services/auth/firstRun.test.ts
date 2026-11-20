// pglite-backed: the first-admin bootstrap. Only an empty users table lets an
// account through, the account is a full App Admin and the default admin, and
// a database with no team gets the seed first.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let svc: typeof import('./firstRun.js')
let dbm: typeof import('../../db/index.js')
let schema: typeof import('../../../../drizzle/schema.js')

const STRONG = 'Correct-Horse-9-Battery'

beforeAll(async () => {
  svc = await import('./firstRun.js')
  dbm = await import('../../db/index.js')
  schema = await import('../../../../drizzle/schema.js')
})

beforeEach(async () => {
  await dbm.db.delete(schema.teamMembers)
  await dbm.db.delete(schema.users)
  svc.resetFirstRunCacheForTests()
})

describe('first-admin bootstrap', () => {
  it('creates an App Admin who is the default admin, seeding a team when there is none', async () => {
    const seed = vi.fn(async () => {
      await dbm.db.insert(schema.teams).values({ name: 'Seeded', slug: `seeded-${crypto.randomUUID()}` })
    })
    expect(await dbm.db.select({ id: schema.teams.id }).from(schema.teams)).toEqual([])
    expect(await svc.needsFirstAdmin()).toBe(true)
    const r = await svc.createFirstAdmin({ email: ' Admin@Example.com ', displayName: ' Ada ', password: STRONG }, seed)
    expect(seed).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.teamId).not.toBeNull()

    const [u] = await dbm.db.select().from(schema.users).where(eq(schema.users.id, r.userId))
    expect(u).toMatchObject({ email: 'admin@example.com', displayName: 'Ada', isAppAdmin: true, canSeeAllTeams: true, isDefaultAdmin: true, defaultTeamId: r.teamId })
    expect(u!.passwordHash).toMatch(/^scrypt\$/)
    expect(u!.passwordChangedAt).not.toBeNull()
    const members = await dbm.db.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, r.userId))
    expect(members).toEqual([expect.objectContaining({ teamId: r.teamId, role: 'admin' })])
    expect(await svc.needsFirstAdmin()).toBe(false)
  })

  it('refuses once any user exists, even with a stale cache', async () => {
    await dbm.db.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: 'someone@example.com', displayName: 'Someone' })
    const r = await svc.createFirstAdmin({ email: 'attacker@example.com', displayName: 'X', password: STRONG }, async () => {})
    expect(r).toMatchObject({ ok: false, status: 409, error: 'errors.first_run.already_done' })
    const rows = await dbm.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'attacker@example.com'))
    expect(rows).toEqual([])
  })

  it('lets only one of two racing requests through', async () => {
    const results = await Promise.all([
      svc.createFirstAdmin({ email: 'a@example.com', displayName: 'A', password: STRONG }, async () => {}),
      svc.createFirstAdmin({ email: 'b@example.com', displayName: 'B', password: STRONG }, async () => {}),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await dbm.db.select({ id: schema.users.id }).from(schema.users)).toHaveLength(1)
  })

  it('rejects a weak password without writing anything', async () => {
    const r = await svc.createFirstAdmin({ email: 'a@example.com', displayName: 'A', password: 'short' }, async () => {})
    expect(r).toMatchObject({ ok: false, status: 400, error: 'errors.first_run.weak_password' })
    expect(await dbm.db.select({ id: schema.users.id }).from(schema.users)).toEqual([])
  })

  it('still creates the account when seeding fails', async () => {
    await dbm.db.delete(schema.teams)
    const r = await svc.createFirstAdmin({ email: 'a@example.com', displayName: 'A', password: STRONG }, async () => { throw new Error('seed broke') })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.teamId).toBeNull()
  })
})
