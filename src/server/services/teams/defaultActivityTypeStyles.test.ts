// v1.376.0: new teams get the default icon + icon color on each seeded
// Activity Type, and every default icon name is a real lucide icon.
import { describe, it, expect } from 'vitest'
import * as LucideIcons from 'lucide-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import { createTestDb } from '../../db/testDb.js'
import * as schema from '../../../../drizzle/schema.js'
import { applyDefaultTeamConfig } from './defaults.js'
import { DEFAULT_ACTIVITY_TYPE_STYLES } from '../../../shared/defaultActivityTypeStyles.js'
import { defaultTypeKey } from '../../../shared/terminology.js'

describe('default Activity Type styles', () => {
  it('uses icon names that exist in lucide-react', () => {
    for (const { icon } of Object.values(DEFAULT_ACTIVITY_TYPE_STYLES)) {
      expect((LucideIcons as Record<string, unknown>)[icon], icon).toBeTruthy()
    }
  })

  it('applyDefaultTeamConfig sets icon and color on every seeded type', async () => {
    const db = await createTestDb()
    const [team] = await db.insert(schema.teams).values({ name: 'T', slug: 't' }).returning()
    await applyDefaultTeamConfig(db as never, team!.id)
    const types = await db.select().from(schema.teamActivityTypes).where(eq(schema.teamActivityTypes.teamId, team!.id))
    expect(types).toHaveLength(10)
    for (const t of types) {
      // No Terminology setting stored: the evaluation type is "POx Work".
      const key = defaultTypeKey(t.name, 'POx Work')
      expect(t.icon).toBe(DEFAULT_ACTIVITY_TYPE_STYLES[key]!.icon)
      expect(t.color).toBe(DEFAULT_ACTIVITY_TYPE_STYLES[key]!.color)
    }
  })

  // v1.377.0: migration 0153 backfills existing installs, blanks only.
  it('migration 0153 fills blank icons/colors and keeps an admin pick', async () => {
    const db = await createTestDb()
    const [team] = await db.insert(schema.teams).values({ name: 'M', slug: 'm' }).returning()
    await db.insert(schema.teamActivityTypes).values([
      { teamId: team!.id, name: 'Demo', crmObjectType: 'Event', sortOrder: 1 },
      { teamId: team!.id, name: 'Support', crmObjectType: 'Event', sortOrder: 2, icon: 'Wrench', color: '#000000' },
      { teamId: team!.id, name: 'Custom Thing', crmObjectType: 'Event', sortOrder: 3 },
    ])
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const file = fs.readFileSync(path.resolve(dir, '../../../../drizzle/migrations/0153_default_activity_type_styles.sql'), 'utf8')
    for (const stmt of file.split('--> statement-breakpoint')) await db.execute(sql.raw(stmt))
    const rows = await db.select().from(schema.teamActivityTypes).where(eq(schema.teamActivityTypes.teamId, team!.id))
    const by = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(by['Demo']!.icon).toBe('Presentation')
    expect(by['Demo']!.color).toBe('#4F46E5')
    expect(by['Support']!.icon).toBe('Wrench')
    expect(by['Support']!.color).toBe('#000000')
    expect(by['Custom Thing']!.icon).toBeNull()
  })
})
