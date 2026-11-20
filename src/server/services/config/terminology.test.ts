// pglite-backed: Admin → Workplace → Terminology. New-team defaults follow the
// term, migration 0171 pins existing installs to Eval, and a change renames
// the old "{term} Work" types without changing what the CRM receives.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'
import {
  DEFAULT_TERMINOLOGY, cleanCustomEvalTerm, evalTermLabel, evalWorkTypeName, normalizeTerminology, replaceTypeName,
} from '../../../shared/terminology.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let terminology: typeof import('./terminology.js')
let defaults: typeof import('../teams/defaults.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let seq = 0

beforeAll(async () => {
  terminology = await import('./terminology.js')
  defaults = await import('../teams/defaults.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.systemSettings).where(eq(schema.systemSettings.key, 'terminology'))
  terminology.clearTerminologyCache()
})

async function newTeam(name: string) {
  seq++
  const [team] = await testDb.insert(schema.teams).values({ name: `${name} ${seq}`, slug: `${name.toLowerCase()}-${seq}` }).returning()
  await defaults.applyDefaultTeamConfig(testDb as never, team!.id)
  return team!
}

async function typesOf(teamId: string) {
  return testDb.select().from(schema.teamActivityTypes).where(eq(schema.teamActivityTypes.teamId, teamId))
}

async function rulesOf(teamId: string) {
  return testDb.select({ rule: schema.nudgeRules }).from(schema.nudgeRules)
    .innerJoin(schema.nudgeRuleTeams, eq(schema.nudgeRuleTeams.nudgeRuleId, schema.nudgeRules.id))
    .where(eq(schema.nudgeRuleTeams.teamId, teamId))
}

describe('terminology helpers', () => {
  it('defaults to POx and names the type "POx Work"', () => {
    expect(normalizeTerminology(undefined)).toEqual(DEFAULT_TERMINOLOGY)
    expect(evalWorkTypeName(DEFAULT_TERMINOLOGY)).toBe('POx Work')
    expect(evalTermLabel({ evalTerm: 'pov', customEvalTerm: 'ignored' })).toBe('POV')
    expect(normalizeTerminology({ evalTerm: 'poc', customEvalTerm: 'x' })).toEqual({ evalTerm: 'poc', customEvalTerm: null })
  })

  it('accepts a clean custom term and falls back when it is unusable', () => {
    expect(normalizeTerminology({ evalTerm: 'custom', customEvalTerm: '  Pilot  ' })).toEqual({ evalTerm: 'custom', customEvalTerm: 'Pilot' })
    expect(evalWorkTypeName({ evalTerm: 'custom', customEvalTerm: 'Pilot' })).toBe('Pilot Work')
    expect(cleanCustomEvalTerm('<b>')).toBeNull()
    expect(cleanCustomEvalTerm('x'.repeat(25))).toBeNull()
    expect(normalizeTerminology({ evalTerm: 'custom', customEvalTerm: '' })).toEqual(DEFAULT_TERMINOLOGY)
  })

  it('replaces whole words only', () => {
    expect(replaceTypeName('Demo vs Eval Work: Eval Workshop, Eval Work.', 'Eval Work', 'POx Work'))
      .toBe('Demo vs POx Work: Eval Workshop, POx Work.')
  })
})

describe('new-team defaults', () => {
  it('seed the "POx Work" type, picklist value, nudge rule and keyword on a fresh install', async () => {
    const team = await newTeam('Fresh')
    const types = await typesOf(team.id)
    expect(types.map((t) => t.name)).toContain('POx Work')
    expect(types.map((t) => t.name)).not.toContain('Eval Work')
    const picklist = await testDb.select().from(schema.sfEventTypeConfig).where(eq(schema.sfEventTypeConfig.teamId, team.id))
    expect(picklist.map((p) => p.sfPicklistValue)).toContain('POx Work')
    const rule = (await rulesOf(team.id)).find((r) => r.rule.triggerType === 'stage_no_type')!.rule
    expect((rule.triggerConfig as { type: string }).type).toBe('POx Work')
    expect(rule.messageTemplate).toContain('No POx Work logged')
    const evalType = types.find((t) => t.name === 'POx Work')!
    const [kw] = await testDb.select().from(schema.keywordRules).where(eq(schema.keywordRules.activityTypeId, evalType.id))
    expect(kw!.keywords).toContain('pox')
  })
})

describe('migration 0171', () => {
  it('pins an install with an "Eval Work" type to Eval, and leaves a stored choice alone', async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const file = fs.readFileSync(path.resolve(dir, '../../../../drizzle/migrations/0171_terminology.sql'), 'utf8')
    await testDb.insert(schema.teamActivityTypes).values({ name: 'Eval Work', crmObjectType: 'Event', sortOrder: 1 })
    await testDb.execute(sql.raw(file))
    expect(await terminology.getTerminology()).toEqual({ evalTerm: 'eval', customEvalTerm: null })

    await testDb.update(schema.systemSettings).set({ value: { evalTerm: 'pov', customEvalTerm: null } }).where(eq(schema.systemSettings.key, 'terminology'))
    await testDb.execute(sql.raw(file))
    terminology.clearTerminologyCache()
    expect((await terminology.getTerminology()).evalTerm).toBe('pov')
    await testDb.delete(schema.teamActivityTypes).where(sql`${schema.teamActivityTypes.teamId} IS NULL`)
  })
})

describe('changing the term', () => {
  it('renames "Eval Work", keeps the CRM picklist value, and follows nudge rules and Distinctions', async () => {
    // Earlier tests' teams stay as they are.
    await terminology.saveTerminology({ evalTerm: 'eval', customEvalTerm: null }, { renameTypes: false }, testDb as never)
    const team = await newTeam('Upgrade')
    await testDb.update(schema.teams).set({ guideDistinctions: 'Demo vs Eval Work:\nEval Work = the proof.' }).where(eq(schema.teams.id, team.id))
    const stageRule = (await rulesOf(team.id)).find((r) => r.rule.triggerType === 'stage_no_type')!.rule
    await testDb.insert(schema.nudgeRuleTranslations).values({ nudgeRuleId: stageRule.id, locale: 'de', messageTemplate: 'Keine Eval Work für {opp_name}' })
    const plan = await terminology.planTerminologyRename({ evalTerm: 'eval', customEvalTerm: null }, DEFAULT_TERMINOLOGY)
    const ownEval = (await typesOf(team.id)).find((x) => x.name === 'Eval Work')!
    expect(plan.types.map((t) => t.id)).toContain(ownEval.id)

    const { result } = await terminology.saveTerminology(DEFAULT_TERMINOLOGY, { renameTypes: true }, testDb as never)
    expect(result.typesRenamed).toBeGreaterThanOrEqual(1)
    const renamed = (await typesOf(team.id)).find((t) => t.name === 'POx Work')!
    expect(renamed.crmPicklistValue).toBe('Eval Work')
    const rule = (await rulesOf(team.id)).find((r) => r.rule.id === stageRule.id)!.rule
    expect((rule.triggerConfig as { type: string }).type).toBe('POx Work')
    expect(rule.messageTemplate).toContain('No POx Work logged')
    const [tr] = await testDb.select().from(schema.nudgeRuleTranslations).where(eq(schema.nudgeRuleTranslations.nudgeRuleId, stageRule.id))
    expect(tr!.messageTemplate).toBe('Keine POx Work für {opp_name}')
    const [t] = await testDb.select().from(schema.teams).where(eq(schema.teams.id, team.id))
    expect(t!.guideDistinctions).toBe('Demo vs POx Work:\nPOx Work = the proof.')
    expect(await terminology.getTerminology()).toEqual(DEFAULT_TERMINOLOGY)

    // A team created afterwards writes the same CRM picklist value.
    const later = await newTeam('Later')
    const laterEval = (await typesOf(later.id)).find((x) => x.name === 'POx Work')!
    expect(laterEval.crmPicklistValue).toBe('Eval Work')
    const picklist = await testDb.select().from(schema.sfEventTypeConfig).where(eq(schema.sfEventTypeConfig.teamId, later.id))
    expect(picklist.map((p) => p.sfPicklistValue)).toContain('Eval Work')
  })

  it('skips a team that already has a type with the new name', async () => {
    // Earlier tests' teams stay as they are.
    await terminology.saveTerminology({ evalTerm: 'eval', customEvalTerm: null }, { renameTypes: false }, testDb as never)
    const team = await newTeam('Clash')
    const [extra] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team.id, name: 'POC Work', crmObjectType: 'Event', sortOrder: 50 }).returning()
    await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: extra!.id, teamId: team.id })
    const { result, plan } = await terminology.saveTerminology({ evalTerm: 'poc', customEvalTerm: null }, { renameTypes: true }, testDb as never)
    expect(plan.conflicts.some((c) => c.teamNames.includes(team.name))).toBe(true)
    expect(result.typesSkipped).toBeGreaterThan(0)
    expect((await typesOf(team.id)).map((x) => x.name)).toContain('Eval Work')
  })

  it('keeps existing types when the admin opts out of the rename', async () => {
    // Earlier tests' teams stay as they are.
    await terminology.saveTerminology({ evalTerm: 'eval', customEvalTerm: null }, { renameTypes: false }, testDb as never)
    const team = await newTeam('Keep')
    const { result } = await terminology.saveTerminology({ evalTerm: 'pov', customEvalTerm: null }, { renameTypes: false }, testDb as never)
    expect(result.typesRenamed).toBe(0)
    expect((await typesOf(team.id)).map((x) => x.name)).toContain('Eval Work')
    expect((await terminology.getTerminology()).evalTerm).toBe('pov')
  })
})
