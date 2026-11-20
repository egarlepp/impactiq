// Smoke test for the pglite test-DB wiring itself — proves createTestDb()
// actually runs the real migration history and that the returned instance
// behaves like a real Postgres connection (including the bigint-as-string
// behavior every DB-backed test suite in this repo depends on being real,
// not a hand-mocked assumption). If this test ever fails, every other
// pglite-backed suite is suspect too.
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from './testDb.js'
import { teams } from '../../../drizzle/schema.js'

describe('createTestDb', () => {
  it('runs migrations and supports insert/select against a real table', async () => {
    const db = await createTestDb()
    const [inserted] = await db.insert(teams).values({ name: 'Test Team', slug: 'test-team' }).returning()
    expect(inserted?.name).toBe('Test Team')
    const rows = await db.select().from(teams)
    expect(rows).toHaveLength(1)
  })

  // IMPORTANT — documents a real, load-bearing limitation, not a bonus
  // check: unlike the `postgres` driver this app uses in production
  // (which returns bigint/OID 20 columns as a JS *string*, the exact
  // behavior behind the no_activity_days bug), pglite's own default type
  // parser hands back count(*) as a real JS *number*. drizzle-orm's pglite
  // session builds its query config internally with no hook to override
  // that per column, so this cannot be patched away from createTestDb().
  // Practical consequence: a pglite-backed test of engine.ts's
  // no_activity_days branch would pass identically whether or not the
  // `Number(...)` wrap is present — it CANNOT serve as a regression guard
  // for that specific bug class. The actual guard for that lives in
  // engine.aggregateCoercion.test.ts (a static source check), not here.
  // pglite is still genuinely useful for everything else engine.ts does —
  // trigger dispatch, joins, date-boundary logic, combinator/cooldown/
  // dismissal semantics — none of which depend on this distinction.
  it('returns count(*) as a number (documented divergence from the postgres driver)', async () => {
    const db = await createTestDb()
    await db.insert(teams).values({ name: 'A', slug: 'a' })
    await db.insert(teams).values({ name: 'B', slug: 'b' })
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(teams)
    expect(typeof row?.n).toBe('number')
    expect(row?.n).toBe(2)
  })
})
