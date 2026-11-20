// Test-only helper. Spins up an in-memory, wire-protocol-compatible Postgres
// (pglite) and runs the real migration history against it, so tests exercise
// the same query-building code as production — including genuinely reproducing
// Postgres's bigint-as-string behavior (see engine.ts's no_activity_days fix)
// that a hand-built mock would only catch if someone remembered to mock it.
//
// Wiring: db/index.ts exports `db` as a plain object (a Proxy, but that's an
// implementation detail) — every service file does
// `import { db } from '../../db/index.js'` and calls query-builder methods on
// it directly. drizzle-orm/pglite's `drizzle()` implements the identical
// query-builder API against the same drizzle/schema.ts, so a test file can
// `vi.mock('../../db/index.js', async () => ({ ...actual, db: await createTestDb() }))`
// and the service file under test runs completely unmodified against pglite.
//
// Deliberately does NOT import anything from db/index.ts (not even
// findMigrationsFolder) — a test file that mocks db/index.js would otherwise
// intercept that import too, since vi.mock applies to every import of the
// resolved path in the whole module graph, including this file's own,
// creating a circular mock-resolution problem while the factory itself is
// still executing. The migrations-folder walk is duplicated here instead;
// it's a few lines with no other dependencies.
//
// Migrations are applied by hand (reading meta/_journal.json + each .sql
// file, in the same order the real migrator uses) rather than via
// drizzle-orm/pglite/migrator's migrate() — that helper executes each
// migration statement through pglite's extended/prepared-statement protocol,
// which (like real Postgres) rejects a single prepared statement containing
// more than one SQL command. Several migration files in this repo have two
// statements back to back with no `--> statement-breakpoint` marker between
// them, which the `postgres` driver's simple-query execution in production
// tolerates fine but pglite's extended-protocol session does not. PGlite's
// own `.exec()` uses the simple query protocol instead — the same thing
// production effectively relies on — so migration files run byte-for-byte
// as authored, with no per-file editing required.
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '../../../drizzle/schema.js'

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

interface JournalEntry {
  idx: number
  tag: string
}

// Same walk-up-from-this-file's-own-location approach as
// db/index.ts's findMigrationsFolder(), duplicated rather than imported —
// see the file header comment for why.
function findMigrationsFolder(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'drizzle', 'migrations')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(process.cwd(), 'drizzle/migrations')
}

async function applyMigrations(pg: PGlite): Promise<void> {
  const migrationsFolder = findMigrationsFolder()
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] }
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)
  for (const entry of entries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`)
    const sqlText = fs.readFileSync(sqlPath, 'utf8')
    await pg.exec(sqlText)
  }
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite()
  await applyMigrations(pg)
  return drizzle(pg, { schema })
}
