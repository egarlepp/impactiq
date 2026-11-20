// pglite-backed regression tests for F-03 (pentest 2026-09): team-scoped
// admin routes weren't verifying a nested resource actually belongs to the
// :teamId in the URL. Covers the three distinct shapes the fix takes across
// admin.ts's ~23 affected routes:
//  - a junction-table-assignable resource (keyword/nudge rules) via the
//    extracted isKeywordRuleVisibleToTeam()/isNudgeRuleVisibleToTeam()
//    helpers, which the real routes now call directly;
//  - a direct-child resource (e.g. activity types, flight deck items),
//    proven here against the identical `and(eq(id,...), eq(teamId,...))`
//    query shape admin.ts now uses for all of them;
//  - a two-level-nested resource (e.g. sf-extras/subtypes under an activity
//    type), proven against the identical ownership-chain join admin.ts uses.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { TestDb } from '../db/testDb.js'

let testDb: TestDb
vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let isKeywordRuleVisibleToTeam: typeof import('./admin.js')['isKeywordRuleVisibleToTeam']
let isNudgeRuleVisibleToTeam: typeof import('./admin.js')['isNudgeRuleVisibleToTeam']
let schema: typeof import('../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ isKeywordRuleVisibleToTeam, isNudgeRuleVisibleToTeam } = await import('./admin.js'))
  schema = await import('../../../drizzle/schema.js')
  const dbModule = await import('../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

async function makeTeam() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  return team!
}

describe('isKeywordRuleVisibleToTeam (F-03)', () => {
  it('is visible to its own home team with no junction row needed', async () => {
    const home = await makeTeam()
    const [rule] = await testDb.insert(schema.keywordRules).values({
      teamId: home.id, keywords: ['demo'], matchField: 'subject', priority: 1,
    }).returning()
    expect(await isKeywordRuleVisibleToTeam(home.id, rule!.id, home.id)).toBe(true)
  })

  it('is visible to a DIFFERENT team it is validly multi-assigned to via the junction table', async () => {
    const home = await makeTeam()
    const other = await makeTeam()
    const [rule] = await testDb.insert(schema.keywordRules).values({
      teamId: home.id, keywords: ['demo'], matchField: 'subject', priority: 1,
    }).returning()
    await testDb.insert(schema.keywordRuleTeams).values({ keywordRuleId: rule!.id, teamId: other.id })
    expect(await isKeywordRuleVisibleToTeam(home.id, rule!.id, other.id)).toBe(true)
  })

  it('is NOT visible to an unrelated team — this is the exact F-03 IDOR the report demonstrated on activity-types', async () => {
    const home = await makeTeam()
    const attacker = await makeTeam()
    const [rule] = await testDb.insert(schema.keywordRules).values({
      teamId: home.id, keywords: ['demo'], matchField: 'subject', priority: 1,
    }).returning()
    expect(await isKeywordRuleVisibleToTeam(home.id, rule!.id, attacker.id)).toBe(false)
  })
})

describe('isNudgeRuleVisibleToTeam (F-03)', () => {
  it('is visible to its own home team, visible to a junction-assigned team, and rejected for an unrelated team', async () => {
    const home = await makeTeam()
    const assigned = await makeTeam()
    const attacker = await makeTeam()
    const [rule] = await testDb.insert(schema.nudgeRules).values({
      teamId: home.id, name: 'Test rule', triggerType: 'no_activity_days', triggerConfig: { days: 5 }, messageTemplate: 'hi',
    }).returning()
    await testDb.insert(schema.nudgeRuleTeams).values({ nudgeRuleId: rule!.id, teamId: assigned.id })
    expect(await isNudgeRuleVisibleToTeam(home.id, rule!.id, home.id)).toBe(true)
    expect(await isNudgeRuleVisibleToTeam(home.id, rule!.id, assigned.id)).toBe(true)
    expect(await isNudgeRuleVisibleToTeam(home.id, rule!.id, attacker.id)).toBe(false)
  })
})

describe('direct-child-table ownership query shape (activity types, flight deck items, etc.)', () => {
  it('the and(eq(id,...), eq(teamId,...)) pattern admin.ts now uses returns the row for the owning team and nothing for another team', async () => {
    const home = await makeTeam()
    const attacker = await makeTeam()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({
      teamId: home.id, name: 'Demo', sortOrder: 1,
    }).returning()

    const ownRow = await testDb.select({ id: schema.teamActivityTypes.id }).from(schema.teamActivityTypes)
      .where(and(eq(schema.teamActivityTypes.id, type!.id), eq(schema.teamActivityTypes.teamId, home.id))).limit(1)
    expect(ownRow).toHaveLength(1)

    // This is the exact pairing the pentest report used: a valid teamId the
    // attacker legitimately administers, paired with another team's resource id.
    const crossTeamRow = await testDb.select({ id: schema.teamActivityTypes.id }).from(schema.teamActivityTypes)
      .where(and(eq(schema.teamActivityTypes.id, type!.id), eq(schema.teamActivityTypes.teamId, attacker.id))).limit(1)
    expect(crossTeamRow).toHaveLength(0)
  })
})

describe('two-level-nested ownership chain (sf-extras / subtypes under an activity type)', () => {
  it('requires the extra to belong to the claimed type AND the type to belong to the claimed team', async () => {
    const home = await makeTeam()
    const attacker = await makeTeam()
    const [homeType] = await testDb.insert(schema.teamActivityTypes).values({ teamId: home.id, name: 'Demo', sortOrder: 1 }).returning()
    const [attackerType] = await testDb.insert(schema.teamActivityTypes).values({ teamId: attacker.id, name: 'Discovery', sortOrder: 1 }).returning()
    const [extra] = await testDb.insert(schema.teamActivityTypeCrmExtras).values({ teamActivityTypeId: homeType!.id, kind: 'opp_field_display', config: {} }).returning()

    async function ownershipChainHolds(typeIdInUrl: string, teamIdInUrl: string) {
      const [row] = await testDb.select({ id: schema.teamActivityTypeCrmExtras.id }).from(schema.teamActivityTypeCrmExtras)
        .innerJoin(schema.teamActivityTypes, eq(schema.teamActivityTypeCrmExtras.teamActivityTypeId, schema.teamActivityTypes.id))
        .where(and(
          eq(schema.teamActivityTypeCrmExtras.id, extra!.id),
          eq(schema.teamActivityTypeCrmExtras.teamActivityTypeId, typeIdInUrl),
          eq(schema.teamActivityTypes.teamId, teamIdInUrl),
        )).limit(1)
      return !!row
    }

    expect(await ownershipChainHolds(homeType!.id, home.id)).toBe(true)
    // Correct team, but the extra doesn't belong to the type named in the
    // URL — the pre-fix code never checked this at all (extraId alone).
    expect(await ownershipChainHolds(attackerType!.id, attacker.id)).toBe(false)
    // Right type, wrong team — the actual F-03 shape.
    expect(await ownershipChainHolds(homeType!.id, attacker.id)).toBe(false)
  })
})
