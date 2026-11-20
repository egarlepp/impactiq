// pglite-backed: which CriteriaIQ project goes with a CRM Evaluation when
// CriteriaIQ is the secondary Project source. The CriteriaIQ API is mocked;
// the stored choices live in the real criteriaiq_evaluation_links table.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'
import type { CriteriaIqProject } from './client.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const setting = vi.fn(async () => ({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: true }))
vi.mock('./evaluationSource.js', () => ({ getEvaluationSourceSetting: () => setting() }))

const byRecord = vi.fn(async (_id: string): Promise<CriteriaIqProject[]> => [])
const byOpp = vi.fn(async (_opp: { id: string | null; name: string | null }): Promise<CriteriaIqProject[]> => [])
const byId = vi.fn(async (_id: number): Promise<CriteriaIqProject | null> => null)
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  return {
    ...actual,
    findCriteriaIqProjectsByCrmRecord: (id: string) => byRecord(id),
    findCriteriaIqProjectsForOpportunity: async (opp: { id: string | null; name: string | null }) => {
      const projects = await byOpp(opp)
      return { projects, matchedBy: projects.length > 0 ? 'name' : null }
    },
    getCriteriaIqProject: (id: number) => byId(id),
  }
})

let svc: typeof import('./evaluationLink.js')
let client: typeof import('./client.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

const EVAL = 'a0B5g00000AbCdE'
const NO_OPP = { id: null, name: null }
const ACME = { id: '006A0000004kzLq', name: 'Acme Renewal' }

function project(id: number, extra: Partial<CriteriaIqProject> = {}): CriteriaIqProject {
  return {
    id, name: `Project ${id}`, customerName: null, opportunityName: 'Acme Renewal', status: 'Active', type: null,
    startDate: null, endDate: null, primaryEngineerName: null, engineerNotes: 'secret', evaluationLink: null,
    crmOpportunityId: null, crmAccountId: null, hasCrmIds: false,
    criteriaTotal: 4, criteriaMet: 1, mapTasksTotal: null, mapTasksCompleted: null, url: `https://ciq.example.com/project/${id}`, ...extra,
  }
}

beforeAll(async () => {
  svc = await import('./evaluationLink.js')
  client = await import('./client.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.criteriaiqEvaluationLinks)
  setting.mockImplementation(async () => ({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: true }))
  byRecord.mockReset().mockResolvedValue([])
  byOpp.mockReset().mockResolvedValue([])
  byId.mockReset().mockResolvedValue(null)
})

describe('resolveCriteriaIqEvaluationLink', () => {
  it('is off, without calling CriteriaIQ, while the secondary is off', async () => {
    setting.mockImplementation(async () => ({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: false }))
    expect(await svc.resolveCriteriaIqEvaluationLink(EVAL, NO_OPP)).toEqual({ state: 'off' })
    expect(byRecord).not.toHaveBeenCalled()
  })

  it('links a single Evaluation match on its own and leaves engineer notes out', async () => {
    byRecord.mockResolvedValue([project(7)])
    const r = await svc.resolveCriteriaIqEvaluationLink(EVAL, ACME)
    expect(r).toMatchObject({ state: 'linked', how: 'auto', project: { id: 7, criteriaMet: 1, criteriaTotal: 4 }, candidates: [] })
    expect(JSON.stringify(r)).not.toContain('secret')
    expect(byOpp).not.toHaveBeenCalled()
  })

  it('offers several Evaluation matches to choose from, then honors the stored choice', async () => {
    byRecord.mockResolvedValue([project(7), project(8)])
    expect(await svc.resolveCriteriaIqEvaluationLink(EVAL, NO_OPP)).toMatchObject({ state: 'choose', matchedBy: 'evaluation' })
    const set = await svc.setCriteriaIqEvaluationLink(EVAL, 8, NO_OPP, null)
    expect(set).toMatchObject({ ok: true, previousProjectId: null })
    const r = await svc.resolveCriteriaIqEvaluationLink(EVAL, NO_OPP)
    expect(r).toMatchObject({ state: 'linked', how: 'picked', project: { id: 8 } })
    expect(r.state === 'linked' && r.candidates.map((c) => c.id)).toEqual([7, 8])
  })

  it('falls back to suggestions on the same Opportunity, never linking them on its own', async () => {
    byOpp.mockResolvedValue([project(9)])
    expect(await svc.resolveCriteriaIqEvaluationLink(EVAL, ACME)).toMatchObject({ state: 'choose', matchedBy: 'opportunity', candidates: [{ id: 9 }] })
    expect(byOpp).toHaveBeenCalledWith(ACME)
  })

  it('keeps a stored choice whose project is no longer a candidate, and drops one that was deleted', async () => {
    byRecord.mockResolvedValue([project(7), project(8)])
    await svc.setCriteriaIqEvaluationLink(EVAL, 7, NO_OPP, null)
    byRecord.mockResolvedValue([])
    byId.mockResolvedValue(project(7))
    expect(await svc.resolveCriteriaIqEvaluationLink(EVAL, NO_OPP)).toMatchObject({ state: 'linked', how: 'picked', project: { id: 7 } })
    byId.mockResolvedValue(null)
    expect(await svc.resolveCriteriaIqEvaluationLink(EVAL, NO_OPP)).toEqual({ state: 'none' })
  })

  it('reports CriteriaIQ outages as unavailable instead of throwing', async () => {
    byRecord.mockRejectedValue(new client.CriteriaIqError('errors.criteriaiq.unreachable'))
    expect(await svc.resolveCriteriaIqEvaluationLink(EVAL, NO_OPP)).toEqual({ state: 'unavailable', error: 'errors.criteriaiq.unreachable' })
  })
})

describe('setCriteriaIqEvaluationLink / clearCriteriaIqEvaluationLink', () => {
  it('refuses a project that is not on offer for the Evaluation', async () => {
    byRecord.mockResolvedValue([project(7), project(8)])
    expect(await svc.setCriteriaIqEvaluationLink(EVAL, 99, NO_OPP, null)).toEqual({ ok: false, status: 400, error: 'errors.criteriaiq.not_a_candidate' })
  })

  it('refuses while the secondary is off', async () => {
    setting.mockImplementation(async () => ({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: false }))
    expect(await svc.setCriteriaIqEvaluationLink(EVAL, 7, NO_OPP, null)).toMatchObject({ ok: false, status: 409 })
  })

  it('replaces a previous choice and reports it, and clearing returns what was stored', async () => {
    byRecord.mockResolvedValue([project(7), project(8)])
    await svc.setCriteriaIqEvaluationLink(EVAL, 7, NO_OPP, null)
    expect(await svc.setCriteriaIqEvaluationLink(EVAL, 8, NO_OPP, null)).toMatchObject({ ok: true, previousProjectId: 7 })
    expect(await svc.clearCriteriaIqEvaluationLink(EVAL)).toBe(8)
    expect(await svc.clearCriteriaIqEvaluationLink(EVAL)).toBeNull()
    expect(await svc.resolveCriteriaIqEvaluationLink(EVAL, NO_OPP)).toMatchObject({ state: 'choose' })
  })
})
