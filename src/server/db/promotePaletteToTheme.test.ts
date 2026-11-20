// Verifies migration 0149_promote_palette_to_theme.sql — the backfill that
// retired the separate brand-palette system_settings singleton in
// favor of always guaranteeing a real, Active app_themes row (CLAUDE.md §14).
// createTestDb() replays the ENTIRE real migration history against pglite
// (see testDb.ts), so this exercises the actual SQL file byte-for-byte, not
// a re-typed copy of its logic.
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDb } from './testDb.js'
import { appThemes } from '../../../drizzle/schema.js'

function readMigrationSql(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return fs.readFileSync(path.resolve(dir, '../../../drizzle/migrations/0149_promote_palette_to_theme.sql'), 'utf8')
}

describe('migration 0149: promote palette to theme', () => {
  it('a fresh database (no prior system_settings) ends up with exactly one Active theme, seeded from the hardcoded defaults', async () => {
    const db = await createTestDb()
    const rows = await db.select().from(appThemes)
    expect(rows).toHaveLength(1)

    const theme = rows[0]!
    // 0149 seeds the fresh-install theme as 'Default'.
    expect(theme.name).toBe('Default')
    expect(theme.isActive).toBe(true)
    // A genuinely fresh pglite instance has no system_settings rows at all,
    // so the migration's COALESCE must have fallen through to the hardcoded
    // default color JSON embedded in the migration itself — matching
    // ThemingConfig.tsx's own HARD_DEFAULTS constant.
    const colors = theme.colors as Record<string, string>
    expect(colors['primaryLight']).toBe('#2563EB')
    expect(colors['primaryDark']).toBe('#3B82F6')
    expect(colors['sidebarBgLightFrom']).toBe('#FFFFFF')
    expect(colors['headerTextDark']).toBe('#F3F4F6')
    // No palette logos existed to carry forward.
    expect(theme.logoLight).toBeNull()
    expect(theme.logoDark).toBeNull()
  })

  it('re-running the migration SQL against an install that already has a theme is a no-op', async () => {
    const db = await createTestDb()
    // The migration already ran once during createTestDb(). Manually
    // re-execute the exact same file's raw SQL against this same DB — the
    // real proof that WHERE NOT EXISTS (SELECT 1 FROM app_themes) guards
    // against ever creating a second row on an install that already has one
    // (including, per the real report this shipped for, an install where an
    // admin already manually cloned a theme themselves).
    const before = await db.select().from(appThemes)
    expect(before).toHaveLength(1)

    await db.execute(sql.raw(readMigrationSql()))

    const after = await db.select().from(appThemes)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(before[0]!.id)
  })

  it('leaves an install alone that already has its own named themes', async () => {
    const db = await createTestDb()
    // Delete the auto-seeded theme and insert two admin-created ones instead
    // (mirroring the reporting org's real "Channel" + branded-theme state)
    // before re-running the migration — it must not touch or add to them.
    await db.delete(appThemes)
    await db.insert(appThemes).values([
      { name: 'Channel', colors: { primaryLight: '#1D4ED8' }, isActive: false },
      { name: 'Acme Brand', colors: { primaryLight: '#7C3AED' }, isActive: true },
    ])

    await db.execute(sql.raw(readMigrationSql()))

    const rows = await db.select().from(appThemes)
    expect(rows).toHaveLength(2)
    const active = rows.filter((r) => r.isActive)
    expect(active).toHaveLength(1)
    expect(active[0]!.name).toBe('Acme Brand')
  })
})

describe('migration 0152: generic default theme name', () => {
  function read0152(): string {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    return fs.readFileSync(path.resolve(dir, '../../../drizzle/migrations/0152_generic_default_theme_name.sql'), 'utf8')
  }

  // 0149 now seeds 'Default' directly, so 0152 only holds its journal slot.
  it('is a no-op that leaves every theme name alone', async () => {
    const db = await createTestDb()
    await db.delete(appThemes)
    await db.insert(appThemes).values([
      { name: 'Acme Brand', colors: { primaryLight: '#7C3AED' }, isActive: true },
      { name: 'Channel', colors: { primaryLight: '#1D4ED8' }, isActive: false },
    ])

    await db.execute(sql.raw(read0152()))

    const names = (await db.select().from(appThemes)).map((r) => r.name).sort()
    expect(names).toEqual(['Acme Brand', 'Channel'])
  })
})
