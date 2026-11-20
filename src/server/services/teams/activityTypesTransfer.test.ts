// pglite-backed tests for Activity Types export / import: round-trip into a
// fresh team, upsert-by-name on an existing team, subtypes never deleted,
// SF Extras replaced as a set, shared types skipped, one default star.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let testDb: TestDb
let schema: typeof import('../../../../drizzle/schema.js')
let mod: typeof import('./activityTypesTransfer.js')

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  mod = await import('./activityTypesTransfer.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

async function makeTeam(extra: Partial<typeof schema.teams.$inferInsert> = {}) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}`, ...extra }).returning()
  return team!
}

async function addType(teamId: string, values: Partial<typeof schema.teamActivityTypes.$inferInsert> & { name: string }) {
  const [row] = await testDb.insert(schema.teamActivityTypes).values({ teamId, sortOrder: 10, ...values }).returning()
  await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: row!.id, teamId })
  return row!
}

async function typesFor(teamId: string) {
  return testDb.select().from(schema.teamActivityTypes).where(eq(schema.teamActivityTypes.teamId, teamId))
}

async function seedSource() {
  const team = await makeTeam({ guideDistinctions: 'Discovery vs Demo', subtypesEnabled: true })
  const demo = await addType(team.id, {
    name: 'Demo', icon: 'presentation', color: '#112233', sortOrder: 1, isDefaultSuggestion: true,
    useThisWhen: 'Showing the product', usuallyAttachTo: 'Opportunity', examples: 'A tailored demo', crmPicklistValue: 'Demo',
  })
  await testDb.insert(schema.teamActivityTypeSubtypes).values([
    { teamActivityTypeId: demo.id, name: 'Technical Demo', sortOrder: 10 },
    { teamActivityTypeId: demo.id, name: 'Executive Demo', sortOrder: 20 },
  ])
  await testDb.insert(schema.teamActivityTypeCrmExtras).values({
    teamActivityTypeId: demo.id, kind: 'related_object_picker',
    config: { sobject: 'Evaluations__c', parentField: 'Opportunity__c', labelField: 'Name', mode: 'read' },
  })
  await testDb.insert(schema.sfEventTypeConfig).values({ teamId: team.id, sfPicklistValue: 'Demo', isActive: true, fallbackValue: 'Meeting' })
  await addType(team.id, { name: 'Support', crmObjectType: 'Task', sortOrder: 2, isActive: false })
  return team
}

describe('activity types export / import', () => {
  it('exports every field, subtype and SF Extra for the team', async () => {
    const team = await seedSource()
    const doc = (await mod.buildActivityTypesExport(team.id, 'a@example.com'))!
    expect(mod.ActivityTypesDocumentSchema.safeParse(doc).success).toBe(true)
    expect(doc.team).toEqual({ guideDistinctions: 'Discovery vs Demo', subtypesEnabled: true })
    const demo = doc.activityTypes.find((t) => t.name === 'Demo')!
    expect(demo.icon).toBe('presentation')
    expect(demo.isDefaultSuggestion).toBe(true)
    expect(demo.subtypes.map((s) => s.name)).toEqual(['Technical Demo', 'Executive Demo'])
    expect(demo.sfExtras[0]!.config).toMatchObject({ sobject: 'Evaluations__c' })
    expect(demo.sfPicklistConfig).toEqual({ isActive: true, fallbackValue: 'Meeting' })
    expect(doc.activityTypes.find((t) => t.name === 'Support')!.crmObjectType).toBe('Task')
  })

  it('still reads a file exported before the crm_* rename (sfObjectType / sfPicklistValue keys)', async () => {
    const team = await seedSource()
    const doc = (await mod.buildActivityTypesExport(team.id, 'a@example.com'))!
    const legacy = {
      ...doc,
      activityTypes: doc.activityTypes.map(({ crmObjectType, crmPicklistValue, ...rest }) => ({ ...rest, sfObjectType: crmObjectType, sfPicklistValue: crmPicklistValue })),
    }
    const parsed = mod.ActivityTypesDocumentSchema.safeParse(legacy)
    expect(parsed.success).toBe(true)
    expect(parsed.data!.activityTypes.find((t) => t.name === 'Support')!.crmObjectType).toBe('Task')
  })

  it('round-trips into an empty team, and a second import is a no-op', async () => {
    const src = await seedSource()
    const doc = (await mod.buildActivityTypesExport(src.id, null))!
    const dest = await makeTeam()

    const preview = (await mod.previewActivityTypesImport(dest.id, doc))!
    expect(preview.toCreate.map((r) => r.name).sort()).toEqual(['Demo', 'Support'])

    const result = (await mod.applyActivityTypesImport(dest.id, doc))!
    expect(result.created).toBe(2)
    expect(result.teamSettingsUpdated).toBe(true)

    const again = (await mod.buildActivityTypesExport(dest.id, null))!
    expect(again.activityTypes).toEqual(doc.activityTypes)
    expect(again.team).toEqual(doc.team)

    const second = (await mod.previewActivityTypesImport(dest.id, doc))!
    expect(second.toCreate).toHaveLength(0)
    expect(second.toUpdate).toHaveLength(0)
    expect(second.teamChanges).toHaveLength(0)
  })

  it('updates by name (case-insensitive), adds subtypes without deleting, replaces SF Extras, leaves other types alone', async () => {
    const src = await seedSource()
    const doc = (await mod.buildActivityTypesExport(src.id, null))!

    const dest = await makeTeam()
    const demo = await addType(dest.id, { name: 'demo', icon: 'old', sortOrder: 5 })
    await testDb.insert(schema.teamActivityTypeSubtypes).values({ teamActivityTypeId: demo.id, name: 'Local Only', sortOrder: 5 })
    await testDb.insert(schema.teamActivityTypeCrmExtras).values({ teamActivityTypeId: demo.id, kind: 'opp_field_display', config: { sobject: 'Opportunity', field: 'X__c' } })
    const other = await addType(dest.id, { name: 'Internal', isDefaultSuggestion: true })

    const preview = (await mod.previewActivityTypesImport(dest.id, doc))!
    const upd = preview.toUpdate.find((r) => r.name === 'demo')!
    expect(upd.subtypesAdded).toEqual(['Technical Demo', 'Executive Demo'])
    expect(upd.extrasReplaced).toEqual({ from: 1, to: 1 })
    expect(preview.notInFile).toEqual(['Internal'])

    await mod.applyActivityTypesImport(dest.id, doc)
    const rows = await typesFor(dest.id)
    expect(rows).toHaveLength(3) // demo updated in place, Support created, Internal untouched
    const demoAfter = rows.find((r) => r.id === demo.id)!
    expect(demoAfter.icon).toBe('presentation')
    expect(demoAfter.isDefaultSuggestion).toBe(true)
    expect(rows.find((r) => r.id === other.id)!.isDefaultSuggestion).toBe(false) // one star per team

    const subs = await testDb.select().from(schema.teamActivityTypeSubtypes).where(eq(schema.teamActivityTypeSubtypes.teamActivityTypeId, demo.id))
    expect(subs.map((s) => s.name).sort()).toEqual(['Executive Demo', 'Local Only', 'Technical Demo'])
    const extras = await testDb.select().from(schema.teamActivityTypeCrmExtras).where(eq(schema.teamActivityTypeCrmExtras.teamActivityTypeId, demo.id))
    expect(extras).toHaveLength(1)
    expect(extras[0]!.kind).toBe('related_object_picker')
  })

  it('skips a name match against a shared type the team does not own', async () => {
    const src = await seedSource()
    const doc = (await mod.buildActivityTypesExport(src.id, null))!
    const owner = await makeTeam()
    const dest = await makeTeam()
    const shared = await addType(owner.id, { name: 'Demo', icon: 'shared' })
    await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: shared.id, teamId: dest.id })

    const preview = (await mod.previewActivityTypesImport(dest.id, doc))!
    expect(preview.skippedShared).toEqual(['Demo'])
    await mod.applyActivityTypesImport(dest.id, doc)
    const [sharedAfter] = await testDb.select().from(schema.teamActivityTypes).where(eq(schema.teamActivityTypes.id, shared.id))
    expect(sharedAfter!.icon).toBe('shared')
  })

  it('rolls back everything when a write fails part-way', async () => {
    const src = await seedSource()
    const doc = (await mod.buildActivityTypesExport(src.id, null))!
    const dest = await makeTeam()
    // A config value Postgres jsonb can't store (\u0000) makes the SF
    // Extras insert fail after the type row was already inserted.
    const bad = structuredClone(doc)
    bad.activityTypes[0]!.sfExtras = [{ kind: 'opp_field_display', config: { field: 'a\u0000b' } }]
    await expect(mod.applyActivityTypesImport(dest.id, bad)).rejects.toThrow()
    expect(await typesFor(dest.id)).toHaveLength(0)
    const [destTeam] = await testDb.select().from(schema.teams).where(eq(schema.teams.id, dest.id))
    expect(destTeam!.guideDistinctions).toBeNull()
  })
})

describe('AI Assessments in the activity types file', () => {
  async function seedAssessment(teamId: string, demoId: string, subtypeId: string | null, opts: { locked?: boolean } = {}) {
    const [a] = await testDb.insert(schema.aiAssessments).values({ teamId, name: 'Technical Discovery', description: 'Rubric', isLocked: opts.locked ?? false }).returning()
    await testDb.insert(schema.aiAssessmentTeams).values({ assessmentId: a!.id, teamId })
    await testDb.insert(schema.aiAssessmentCriteria).values([
      { assessmentId: a!.id, name: 'Pain quantified', lookFor: 'A number', weight: 25, anchors: { '1': 'None', '5': 'A figure' }, sortOrder: 0 },
      { assessmentId: a!.id, name: 'Next step', weight: 10, sortOrder: 1 },
    ])
    await testDb.insert(schema.aiAssessmentAssignments).values({ teamId, activityTypeId: demoId, subtypeId, assessmentId: a!.id })
    return a!
  }

  it('round-trips assessments and their Type / Subtype assignments into a fresh team', async () => {
    const source = await seedSource()
    const [demo] = (await typesFor(source.id)).filter((t) => t.name === 'Demo')
    const tech = (await testDb.select().from(schema.teamActivityTypeSubtypes).where(eq(schema.teamActivityTypeSubtypes.teamActivityTypeId, demo!.id))).find((st) => st.name === 'Technical Demo')
    await seedAssessment(source.id, demo!.id, tech!.id)
    const doc = (await mod.buildActivityTypesExport(source.id, null))!
    expect(doc.aiAssessments).toEqual([{
      name: 'Technical Discovery', description: 'Rubric', icon: null, iconColor: null, isActive: true,
      criteria: [
        { name: 'Pain quantified', lookFor: 'A number', weight: 25, anchors: { '1': 'None', '5': 'A figure' } },
        { name: 'Next step', lookFor: null, weight: 10, anchors: {} },
      ],
      assignments: [{ activityType: 'Demo', subtype: 'Technical Demo' }],
    }])

    const dest = await makeTeam()
    const preview = (await mod.previewActivityTypesImport(dest.id, doc))!
    expect(preview.aiAssessments).toMatchObject({
      toCreate: ['Technical Discovery'],
      assignmentsToAdd: [{ assessment: 'Technical Discovery', activityType: 'Demo', subtype: 'Technical Demo' }],
      assignmentsSkipped: [],
    })
    const result = (await mod.applyActivityTypesImport(dest.id, doc))!
    expect(result).toMatchObject({ assessmentsCreated: 1, assignmentsAdded: 1 })
    const again = (await mod.previewActivityTypesImport(dest.id, doc))!
    expect(again.aiAssessments).toMatchObject({ toCreate: [], toUpdate: [], unchanged: ['Technical Discovery'], assignmentsToAdd: [] })
  })

  it('updates criteria with a version bump, skips locked ones, and reports assignments it cannot place', async () => {
    const team = await seedSource()
    const [demo] = (await typesFor(team.id)).filter((t) => t.name === 'Demo')
    const a = await seedAssessment(team.id, demo!.id, null)
    const doc = (await mod.buildActivityTypesExport(team.id, null))!
    const edited = {
      ...doc,
      aiAssessments: [{
        ...doc.aiAssessments![0]!,
        icon: 'Search',
        iconColor: '#2563EB',
        criteria: [{ name: 'Pain quantified', lookFor: null, weight: 40, anchors: {} }],
        assignments: [{ activityType: 'Demo', subtype: null }, { activityType: 'Nope', subtype: null }, { activityType: 'Demo', subtype: 'Ghost' }],
      }],
    }
    const preview = (await mod.previewActivityTypesImport(team.id, edited))!
    expect(preview.aiAssessments!.toUpdate).toEqual([{ name: 'Technical Discovery', fields: ['icon', 'iconColor', 'criteria'] }])
    expect(preview.aiAssessments!.assignmentsSkipped.map((s) => s.reason)).toEqual(['missing_type', 'missing_subtype'])
    await mod.applyActivityTypesImport(team.id, edited)
    const [after] = await testDb.select().from(schema.aiAssessments).where(eq(schema.aiAssessments.id, a.id))
    expect(after!.version).toBe(2)
    expect([after!.icon, after!.iconColor]).toEqual(['Search', '#2563EB'])
    const crit = await testDb.select().from(schema.aiAssessmentCriteria).where(eq(schema.aiAssessmentCriteria.assessmentId, a.id))
    expect(crit.map((c) => [c.name, c.weight])).toEqual([['Pain quantified', 40]])

    await testDb.update(schema.aiAssessments).set({ isLocked: true }).where(eq(schema.aiAssessments.id, a.id))
    const locked = (await mod.previewActivityTypesImport(team.id, doc))!
    expect(locked.aiAssessments!.skipped).toEqual([{ name: 'Technical Discovery', reason: 'locked' }])
    const asAdmin = (await mod.previewActivityTypesImport(team.id, doc, { canEditLocked: true, userId: null }))!
    expect(asAdmin.aiAssessments!.toUpdate[0]!.fields).toContain('criteria')
  })

  it('leaves assessments alone for a file without the section', async () => {
    const team = await seedSource()
    const doc = (await mod.buildActivityTypesExport(team.id, null))!
    const { aiAssessments: _drop, ...old } = doc
    const preview = (await mod.previewActivityTypesImport(team.id, old))!
    expect(preview.aiAssessments).toBeNull()
  })
})
