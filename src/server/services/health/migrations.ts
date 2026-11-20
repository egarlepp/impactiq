import fs from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db, findMigrationsFolder } from '../../db/index.js'

export interface MigrationStatus {
  appliedCount: number
  totalCount: number
  pending: number
  latestAppliedAt: string | null
  error: string | null
}

// v1.255.2: migration status — how many of the migration files on disk have
// actually been recorded as applied against THIS database. Exists because
// runMigrations() already runs automatically on every server boot (see
// src/server/index.ts's start()), but a long-running dev process never
// reboots on its own just because a new .sql file landed on disk — the
// server has to actually restart for drizzle-orm's migrate() to see it.
// Surfaced on App Health so "my new feature isn't showing" has a concrete
// answer instead of a guess, with a one-click fix below.
export async function getMigrationStatus(): Promise<MigrationStatus> {
  let totalCount = 0
  try {
    const journalPath = path.join(findMigrationsFolder(), 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries?: unknown[] }
    totalCount = journal.entries?.length ?? 0
  } catch {
    // Journal unreadable in this deployment shape — pending will read 0
    // rather than a hard error; the applied count below is still accurate.
  }
  try {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS applied, max(created_at) AS latest
      FROM drizzle.__drizzle_migrations
    `)) as unknown as Array<{ applied: number; latest: string | null }>
    const appliedCount = rows[0]?.applied ?? 0
    const latestRaw = rows[0]?.latest ?? null
    const latestAppliedAt = latestRaw ? new Date(Number(latestRaw)).toISOString() : null
    return { appliedCount, totalCount, pending: Math.max(0, totalCount - appliedCount), latestAppliedAt, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { appliedCount: 0, totalCount, pending: 0, latestAppliedAt: null, error: msg }
  }
}
