// pglite-backed: CriteriaIQ as the primary Project source. The CriteriaIQ API
// and the source setting are mocked; links live in the real activities table.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'
import type { CriteriaIqProject } from './client.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const setting = vi.fn(async () => ({ primary: 'criteriaiq', dataSource: 'criteriaiq', criteriaiqSecondary: false }))
vi.mock('./evaluationSource.js', () => ({ getEvaluationSourceSetting: () => setting() }))

const byId = vi.fn(async (_id: number): Promise<CriteriaIqProject | null> => null)
const list = vi.fn(async (_opts?: { fresh?: boolean }): Promise<CriteriaIqProject[]> => [])
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return {
    ...actual,
    getCriteriaIqProject: (id: number) => byId(id),
    listCriteriaIqProjects: (opts?: { fresh?: boolean }) => list(opts),
  }
})

let svc: typeof import('./primaryProjects.js')
let client: typeof import('./client.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

function project(id: number, extra: Partial<CriteriaIqProject> = {}): CriteriaIqProject {
  return {
    id, name: `Project ${id}`, customerName: 'Acme', opportunityName: 'Acme Renewal', status: 'Active', type: 'POC',
    startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-10-15', primaryEngineerName: 'Robin PE', engineerNotes: null,
    evaluationLink: null, crmOpportunityId: null, crmAccountId: null, hasCrmIds: false, criteriaTotal: 3, criteriaMet: 1, mapTasksTotal: null, mapTasksCompleted: null, url: `https://ciq.example.com/project/${id}`, ...extra,
  }
}

beforeAll(async () => {
  svc = await import('./primaryProjects.js')
  client = await import('./client.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.activities)
  await testDb.delete(schema.jobRuns)
  setting.mockImplementation(async () => ({ primary: 'criteriaiq', dataSource: 'criteriaiq', criteriaiqSecondary: false }))
  byId.mockReset().mockResolvedValue(null)
  list.mockReset().mockResolvedValue([])
})

async function addActivity(fields: Partial<typeof schema.activities.$inferInsert>) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U',
  }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Eval Work', sortOrder: 1 }).returning()
  const [row] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'A', activityTypeId: type!.id, status: 'submitted',
    startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00', ...fields,
  }).returning()
  return row!
}

describe('toProjectSnapshot', () => {
  it('maps a CriteriaIQ project to the snapshot columns, dates as plain days, no stage', () => {
    expect(svc.toProjectSnapshot(project(7))).toEqual({
      crmRelatedName: 'Project 7', crmEvalStatus: 'Active', crmEvalStage: null, crmEvalType: 'POC',
      crmEvalStartDate: '2026-09-01', crmEvalEndDate: '2026-10-15', crmEvalPrimaryEngineer: 'Robin PE', crmRelatedDeleted: false,
    })
  })
})

describe('checkProjectLink', () => {
  it('reads the project on a new link and returns its snapshot', async () => {
    byId.mockResolvedValue(project(7))
    const r = await svc.checkProjectLink({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ' }, null)
    expect(r).toMatchObject({ ok: true, snapshot: { crmRelatedName: 'Project 7' } })
    expect(byId).toHaveBeenCalledWith(7)
  })

  it('does not call CriteriaIQ when the link is unchanged', async () => {
    const r = await svc.checkProjectLink({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ' }, { crmRelatedId: '7' })
    expect(r).toEqual({ ok: true, snapshot: null })
    expect(byId).not.toHaveBeenCalled()
  })

  it('refuses a CRM Evaluation link, or a non-numeric id, under CriteriaIQ', async () => {
    expect(await svc.checkProjectLink({ crmRelatedId: 'a0X000000000001', crmRelatedType: 'Evaluations__c' }, null))
      .toEqual({ ok: false, status: 400, error: 'errors.evaluation_source.wrong_project_source' })
    expect(await svc.checkProjectLink({ crmRelatedId: 'abc', crmRelatedType: 'CriteriaIQ' }, null))
      .toEqual({ ok: false, status: 400, error: 'errors.evaluation_source.wrong_project_source' })
  })

  it('refuses a project CriteriaIQ does not have', async () => {
    byId.mockResolvedValue(null)
    expect(await svc.checkProjectLink({ crmRelatedId: '99', crmRelatedType: 'CriteriaIQ' }, null))
      .toEqual({ ok: false, status: 400, error: 'errors.criteriaiq.project_not_found' })
  })

  it('keeps the link without a snapshot when CriteriaIQ is unreachable', async () => {
    byId.mockRejectedValue(new client.CriteriaIqError('errors.criteriaiq.unreachable'))
    expect(await svc.checkProjectLink({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ' }, null)).toEqual({ ok: true, snapshot: null })
  })

  it('refuses a CriteriaIQ link under the CRM object, and any new link while off', async () => {
    setting.mockImplementation(async () => ({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: false }))
    expect(await svc.checkProjectLink({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ' }, null))
      .toMatchObject({ ok: false, error: 'errors.evaluation_source.wrong_project_source' })
    expect(await svc.checkProjectLink({ crmRelatedId: 'a0X000000000001', crmRelatedType: 'Evaluations__c' }, null)).toEqual({ ok: true, snapshot: null })
    setting.mockImplementation(async () => ({ primary: 'off', dataSource: 'crm', criteriaiqSecondary: false }))
    expect(await svc.checkProjectLink({ crmRelatedId: 'a0X000000000001', crmRelatedType: 'Evaluations__c' }, null))
      .toEqual({ ok: false, status: 403, error: 'errors.evaluation_source.projects_off' })
  })
})

describe('refreshCriteriaIqProjects', () => {
  it('does nothing, and records no run, when nothing links to CriteriaIQ or it is not primary', async () => {
    expect(await svc.refreshCriteriaIqProjects()).toBeNull()
    await addActivity({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ' })
    setting.mockImplementation(async () => ({ primary: 'crm', dataSource: 'criteriaiq', criteriaiqSecondary: false }))
    expect(await svc.refreshCriteriaIqProjects()).toBeNull()
    expect(await testDb.select().from(schema.jobRuns)).toHaveLength(0)
  })

  it('refreshes snapshots, marks only a confirmed-missing project disconnected, and leaves CRM links alone', async () => {
    const a = await addActivity({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'Old name', crmRelatedDeleted: true })
    const b = await addActivity({ crmRelatedId: '8', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'Gone' })
    const c = await addActivity({ crmRelatedId: '9', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'Flaky' })
    const crm = await addActivity({ crmRelatedId: 'a0X000000000001', crmRelatedType: 'Evaluations__c', crmRelatedName: 'CRM eval' })
    list.mockResolvedValue([project(7, { name: 'New name' })])
    byId.mockImplementation(async (id: number) => {
      if (id === 9) throw new client.CriteriaIqError('errors.criteriaiq.unreachable')
      return null
    })

    const r = await svc.refreshCriteriaIqProjects({ source: 'manual' })
    expect(r).toMatchObject({ projects: 3, updated: 1, notFound: 1, source: 'manual' })
    expect(r!.errors).toHaveLength(1)
    expect(list).toHaveBeenCalledWith({ fresh: true })

    const read = async (id: string) => (await testDb.select().from(schema.activities).where(eq(schema.activities.id, id)))[0]!
    expect(await read(a.id)).toMatchObject({ crmRelatedName: 'New name', crmRelatedDeleted: false, crmEvalStatus: 'Active' })
    expect(await read(b.id)).toMatchObject({ crmRelatedName: 'Gone', crmRelatedDeleted: true })
    expect(await read(c.id)).toMatchObject({ crmRelatedName: 'Flaky', crmRelatedDeleted: false })
    expect(await read(crm.id)).toMatchObject({ crmRelatedName: 'CRM eval', crmRelatedDeleted: false })
    const runs = await testDb.select().from(schema.jobRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ jobKey: 'refresh_criteriaiq_projects', status: 'error' })
  })

  it('records an error run and changes nothing when the project list cannot be read', async () => {
    const a = await addActivity({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'Keep' })
    list.mockRejectedValue(new client.CriteriaIqError('errors.criteriaiq.unauthorized'))
    const r = await svc.refreshCriteriaIqProjects()
    expect(r).toMatchObject({ updated: 0, errors: ['errors.criteriaiq.unauthorized'] })
    expect((await testDb.select().from(schema.activities).where(eq(schema.activities.id, a.id)))[0]).toMatchObject({ crmRelatedName: 'Keep', crmRelatedDeleted: false })
  })
})

describe('refreshCriteriaIqProject', () => {
  it('refreshes one linked project without reading the list', async () => {
    const a = await addActivity({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'Old name' })
    const other = await addActivity({ crmRelatedId: '8', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'Untouched' })
    byId.mockResolvedValue(project(7, { name: 'New name' }))
    expect(await svc.refreshCriteriaIqProject(7)).toBe('updated')
    expect(list).not.toHaveBeenCalled()
    const read = async (id: string) => (await testDb.select().from(schema.activities).where(eq(schema.activities.id, id)))[0]!
    expect(await read(a.id)).toMatchObject({ crmRelatedName: 'New name', crmEvalStatus: 'Active' })
    expect(await read(other.id)).toMatchObject({ crmRelatedName: 'Untouched' })
  })

  it('marks a confirmed-missing project disconnected', async () => {
    const a = await addActivity({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'Gone' })
    expect(await svc.refreshCriteriaIqProject(7)).toBe('not_found')
    expect((await testDb.select().from(schema.activities).where(eq(schema.activities.id, a.id)))[0]).toMatchObject({ crmRelatedDeleted: true })
  })

  it('calls nothing when no activity links the project, or CriteriaIQ is not primary', async () => {
    expect(await svc.refreshCriteriaIqProject(7)).toBeNull()
    await addActivity({ crmRelatedId: '7', crmRelatedType: 'CriteriaIQ', crmRelatedName: 'X' })
    setting.mockImplementation(async () => ({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: true }))
    expect(await svc.refreshCriteriaIqProject(7)).toBeNull()
    expect(byId).not.toHaveBeenCalled()
  })
})

describe('opportunitiesWithCriteriaIqProject', () => {
  it('counts an Opportunity with a linked CriteriaIQ project or one named for it', async () => {
    await addActivity({ crmWhatId: '006A', crmWhatType: 'Opportunity', crmRelatedId: '7', crmRelatedType: 'CriteriaIQ' })
    await addActivity({ crmWhatId: '006C', crmWhatType: 'Opportunity', crmRelatedId: 'a0X000000000001', crmRelatedType: 'Evaluations__c' })
    list.mockResolvedValue([project(8, { opportunityName: '  beta deal ' })])
    const has = await svc.opportunitiesWithCriteriaIqProject([
      { oppId: '006A', name: 'Alpha' }, { oppId: '006B', name: 'Beta Deal' }, { oppId: '006C', name: 'Gamma' },
    ])
    expect([...has].sort()).toEqual(['006A', '006B'])
  })

  it('counts an Opportunity whose id a CriteriaIQ project holds, and ignores the name of a project tied to another one', async () => {
    list.mockResolvedValue([
      project(8, { opportunityName: 'Renamed in CRM', crmOpportunityId: '006D00000001AbCEAK', hasCrmIds: true }),
      project(9, { opportunityName: 'Epsilon', crmOpportunityId: '006Z00000009ZzZ', hasCrmIds: true }),
    ])
    const has = await svc.opportunitiesWithCriteriaIqProject([
      { oppId: '006D00000001AbC', name: 'Delta' }, { oppId: '006E00000002XyZ', name: 'Epsilon' },
    ])
    expect([...has]).toEqual(['006D00000001AbC'])
  })

  it('throws when CriteriaIQ cannot be read, rather than reporting every Opportunity as missing a POC', async () => {
    list.mockRejectedValue(new client.CriteriaIqError('errors.criteriaiq.unreachable'))
    await expect(svc.opportunitiesWithCriteriaIqProject([{ oppId: '006A', name: 'Alpha' }])).rejects.toBeInstanceOf(client.CriteriaIqError)
  })
})
