import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'

// v1.412.1: replaces drizzle-orm's postgres-js `migrate()`, which applies every
// pending migration inside ONE transaction. Postgres refuses to use an enum
// value added by `ALTER TYPE ... ADD VALUE` until that statement's transaction
// commits (error 55P04), and migration 0006 adds 'team_admin' to the `role`
// enum while later migrations insert rows using it. So a database migrating
// from empty (a fresh install, or the Setup wizard) always failed; databases
// that had migrated a few files at a time never noticed. pglite tests replay
// each file separately, which is why the test suite never caught it.
//
// This applies each migration file in its own transaction instead, and writes
// the exact same bookkeeping rows drizzle does (`drizzle.__drizzle_migrations`:
// hash = sha256 of the file, created_at = the journal's `when`), so it picks up
// cleanly on a database drizzle's own migrator already ran against, and the
// other way round. Still all-or-nothing per file: a failing migration rolls
// back alone and stops the run, leaving every earlier one committed.
//
// A session-level advisory lock keeps two app processes booting at once from
// applying the same migration twice. `client` must be a single-connection
// pool (max: 1) so the lock, the reads and the transactions share a session.

const MIGRATIONS_LOCK_KEY = 727_445_301

export async function applyMigrations(
  client: ReturnType<typeof postgres>,
  migrationsFolder: string,
): Promise<{ applied: number }> {
  const migrations = readMigrationFiles({ migrationsFolder })

  await client`SELECT pg_advisory_lock(${MIGRATIONS_LOCK_KEY})`
  try {
    await client.unsafe('CREATE SCHEMA IF NOT EXISTS "drizzle"')
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `)
    const last = await client<{ created_at: string | number | null }[]>`
      SELECT created_at FROM "drizzle"."__drizzle_migrations"
      ORDER BY created_at DESC LIMIT 1
    `
    // bigint comes back as a string from postgres.js — compare as a number.
    const lastMillis = last[0]?.created_at != null ? Number(last[0].created_at) : null

    let applied = 0
    for (const migration of migrations) {
      if (lastMillis !== null && lastMillis >= migration.folderMillis) continue
      await client.begin(async (tx) => {
        for (const stmt of migration.sql) {
          if (stmt.trim()) await tx.unsafe(stmt)
        }
        await tx`
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES (${migration.hash}, ${migration.folderMillis})
        `
      })
      applied++
    }
    return { applied }
  } finally {
    await client`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`.catch(() => {})
  }
}
