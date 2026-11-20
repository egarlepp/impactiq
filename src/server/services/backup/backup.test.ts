// Round-trip tests for the full-database backup/restore (CLAUDE.md §14d),
// against two independent pglite instances that each replay the real
// migration history — the same "export from one install, restore into a
// fresh one" shape an admin actually uses.
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { createTestDb, type TestDb } from '../../db/testDb.js'
import {
  writeBackup, previewBackup, restoreBackup, listAppTables, BackupFormatError,
  type BackupDb, type SchemaVersion,
} from './backup.js'

const SCHEMA: SchemaVersion = { lastMigration: '0152_generic_default_theme_name', migrationCount: 153 }
const KEY = 'abc123'

function rowsOf<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows)
}

async function seedSource(db: TestDb): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, okta_id, email, display_name, is_app_admin, non_activity_keywords)
    VALUES ('11111111-1111-1111-1111-111111111111', 'okta-1', 'admin@example.com', 'Admin Person', true, ARRAY['1:1', 'lunch, break']),
           ('22222222-2222-2222-2222-222222222222', 'okta-2', 'user@example.com', E'Tab\there\nnewline "quote"', false, NULL)
  `)
  await db.execute(sql`INSERT INTO teams (id, name, slug) VALUES ('33333333-3333-3333-3333-333333333333', 'Team A', 'team-a')`)
  await db.execute(sql`
    INSERT INTO team_members (team_id, user_id, role)
    VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'contributor')
  `)
  await db.execute(sql`
    INSERT INTO capacity_groups (name, target_hours_per_week, capacity_method) VALUES ('EMEA', 32.5, 'fixed_hours')
  `)
  await db.execute(sql`UPDATE app_themes SET logo_light = 'data:image/png;base64,iVBORw0KGgo='`)
  await db.execute(sql`INSERT INTO system_settings (key, value) VALUES ('support_email', '"help@example.com"'::jsonb)`)
  await db.execute(sql`INSERT INTO system_settings (key, value) VALUES ('app_public_base_url', '"https://source.example.com"'::jsonb)`)
  await db.execute(sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES ('11111111-1111-1111-1111-111111111111', 'source-session', now() + interval '1 day')
  `)
}

async function exportToFile(db: TestDb, schema = SCHEMA, keyCheck = KEY): Promise<string> {
  let text = ''
  await writeBackup(db as unknown as BackupDb, { appVersion: '1.0.0', schema, keyCheck }, async (c) => { text += c })
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iq-backup-test-')), 'b.iqbackup')
  fs.writeFileSync(file, gzipSync(text))
  return file
}

async function snapshot(db: TestDb, table: string): Promise<string[]> {
  const rows = rowsOf<{ r: string }>(await db.execute(sql`SELECT row_to_json(t)::text AS r FROM ${sql.identifier(table)} t`))
  return rows.map((x) => x.r).sort()
}

const importer = { userId: '11111111-1111-1111-1111-111111111111', email: 'admin@example.com', ip: null, userAgent: null }

describe('database backup / restore', () => {
  it('round-trips every table into a fresh install exactly, and signs everyone out', async () => {
    const source = await createTestDb()
    await seedSource(source)
    const file = await exportToFile(source)

    const target = await createTestDb()
    await target.execute(sql`INSERT INTO teams (name, slug) VALUES ('Will be replaced', 'gone')`)
    await target.execute(sql`INSERT INTO system_settings (key, value) VALUES ('app_public_base_url', '"https://target.example.com"'::jsonb)`)

    const preview = await previewBackup(target, file, { schema: SCHEMA, keyCheck: KEY, importerEmail: 'ADMIN@example.com' })
    expect(preview.errors).toEqual([])
    expect(preview.importerInBackup).toBe(true)
    expect(preview.keyMatches).toBe(true)
    expect(preview.adminsInBackup.map((a) => a.email)).toEqual(['admin@example.com'])
    expect(preview.tables.find((t) => t.table === 'teams')).toEqual({ table: 'teams', backupRows: 1, currentRows: 1 })
    expect(preview.tables.some((t) => t.table === 'sessions')).toBe(false)

    await restoreBackup(target as unknown as BackupDb, file, importer, { source: 'test' })

    for (const table of await listAppTables(source)) {
      if (['sessions', 'audit_events', 'system_settings'].includes(table)) continue
      expect(await snapshot(target, table), table).toEqual(await snapshot(source, table))
    }
    // Deployment-specific setting keeps the TARGET's value; app data comes from the backup.
    const settings = rowsOf<{ key: string; value: unknown }>(await target.execute(sql`SELECT key, value FROM system_settings ORDER BY key`))
    expect(settings.find((s) => s.key === 'app_public_base_url')?.value).toBe('https://target.example.com')
    expect(settings.find((s) => s.key === 'support_email')?.value).toBe('help@example.com')
    // Sessions are never carried over.
    expect(await snapshot(target, 'sessions')).toEqual([])
    // The restore is audited inside the restored audit log, attributed to the importer.
    const audit = rowsOf<{ action: string; actor_user_id: string | null }>(await target.execute(sql`SELECT action, actor_user_id FROM audit_events`))
    expect(audit).toEqual([{ action: 'system_backup.restore', actor_user_id: importer.userId }])
    // Foreign keys were re-created.
    const fkCount = rowsOf<{ n: number }>(await target.execute(sql`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`))
    const srcFk = rowsOf<{ n: number }>(await source.execute(sql`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`))
    expect(fkCount[0]!.n).toBe(srcFk[0]!.n)
  })

  it('refuses a backup from a different schema version and flags a different encryption key', async () => {
    const source = await createTestDb()
    await seedSource(source)
    const file = await exportToFile(source, { lastMigration: '0100_old', migrationCount: 101 }, 'other-key')
    const target = await createTestDb()
    const preview = await previewBackup(target, file, { schema: SCHEMA, keyCheck: KEY, importerEmail: 'someone@else.com' })
    expect(preview.errors).toContainEqual({ code: 'schema_mismatch', params: { backupSchema: '0100_old', backupVersion: '1.0.0', localSchema: SCHEMA.lastMigration } })
    expect(preview.keyMatches).toBe(false)
    expect(preview.importerInBackup).toBe(false)
    expect(preview.warnings.map((w) => w.code).sort()).toEqual(['importer_missing', 'key_mismatch'])
  })

  it('refuses a backup with no App Admin', async () => {
    const source = await createTestDb()
    await source.execute(sql`INSERT INTO users (okta_id, email, display_name) VALUES ('okta-u', 'u@example.com', 'U')`)
    const file = await exportToFile(source)
    const preview = await previewBackup(await createTestDb(), file, { schema: SCHEMA, keyCheck: KEY, importerEmail: null })
    expect(preview.errors).toContainEqual({ code: 'no_admin' })
  })

  it('rejects a truncated file', async () => {
    const source = await createTestDb()
    await seedSource(source)
    const file = await exportToFile(source)
    const text = (await import('node:zlib')).gunzipSync(fs.readFileSync(file)).toString('utf8')
    const cut = text.slice(0, text.lastIndexOf('\nE\t') + 1)
    fs.writeFileSync(file, gzipSync(cut))
    await expect(previewBackup(await createTestDb(), file, { schema: SCHEMA, keyCheck: KEY, importerEmail: null }))
      .rejects.toBeInstanceOf(BackupFormatError)
  })

  it('rolls everything back when a row fails to restore', async () => {
    const source = await createTestDb()
    await seedSource(source)
    const file = await exportToFile(source)
    // Corrupt a foreign key: point the team membership at a user that doesn't exist.
    const text = (await import('node:zlib')).gunzipSync(fs.readFileSync(file)).toString('utf8')
      .replace('"user_id":"22222222-2222-2222-2222-222222222222"', '"user_id":"99999999-9999-9999-9999-999999999999"')
    fs.writeFileSync(file, gzipSync(text))

    const target = await createTestDb()
    await target.execute(sql`INSERT INTO teams (name, slug) VALUES ('Keep me', 'keep')`)
    const before = await snapshot(target, 'teams')
    await expect(restoreBackup(target as unknown as BackupDb, file, importer, {})).rejects.toThrow()
    expect(await snapshot(target, 'teams')).toEqual(before)
  })
})
