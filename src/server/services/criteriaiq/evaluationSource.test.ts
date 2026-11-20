// pglite-backed: the Evaluation source setting and its lock. Once activities
// link to Projects, the primary source can only move between the links' own
// source and Off; the CriteriaIQ secondary is never locked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

// Pretend every choice is built, so the lock and the connection check (not
// availability) decide.
const sources = vi.fn((): string[] => ['crm', 'criteriaiq', 'off'])
const secondary = vi.fn(() => true)
vi.mock('./availability.js', () => ({
  availableEvaluationSources: () => sources(),
  criteriaIqSecondaryAvailable: () => secondary(),
}))
const configured = vi.fn(async () => true)
vi.mock('./config.js', () => ({ isCriteriaIqConfigured: () => configured() }))

let svc: typeof import('./evaluationSource.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  svc = await import('./evaluationSource.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(async () => {
  await testDb.delete(schema.activities)
  await testDb.delete(schema.systemSettings)
  svc.clearEvaluationSourceCache()
  sources.mockImplementation(() => ['crm', 'criteriaiq', 'off'])
  secondary.mockImplementation(() => true)
  configured.mockImplementation(async () => true)
})

async function addActivity(fields: Partial<typeof schema.activities.$inferInsert>) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U',
  }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Eval Work', sortOrder: 1 }).returning()
  await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'A', activityTypeId: type!.id, status: 'submitted',
    startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00', ...fields,
  })
}

describe('getEvaluationSourceState', () => {
  it('defaults to the CRM object, unlocked, with no secondary', async () => {
    await addActivity({ crmWhatId: '006000000000001' })
    const s = await svc.getEvaluationSourceState()
    expect(s).toMatchObject({ primary: 'crm', dataSource: 'crm', criteriaiqSecondary: false, projectLinks: 0, locked: false })
  })

  it('counts only activities with a Related (Project) link', async () => {
    await addActivity({ crmRelatedId: 'a0X000000000001', crmRelatedType: 'Evaluations__c' })
    await addActivity({ crmWhatId: '006000000000001' })
    expect(await svc.countProjectLinks()).toBe(1)
    expect((await svc.getEvaluationSourceState()).locked).toBe(true)
  })
})

describe('changeEvaluationSource', () => {
  it('moves freely with no Project links, and the data source follows', async () => {
    const r = await svc.changeEvaluationSource({ primary: 'criteriaiq' })
    expect(r).toMatchObject({ ok: true, after: { primary: 'criteriaiq', dataSource: 'criteriaiq' } })
  })

  it('with Project links, refuses another source but allows Off and back', async () => {
    await addActivity({ crmRelatedId: 'a0X000000000001' })
    expect(await svc.changeEvaluationSource({ primary: 'criteriaiq' })).toMatchObject({ ok: false, status: 409, error: 'errors.evaluation_source.locked' })
    expect(await svc.changeEvaluationSource({ primary: 'off' })).toMatchObject({ ok: true, after: { primary: 'off', dataSource: 'crm' } })
    expect(await svc.changeEvaluationSource({ primary: 'criteriaiq' })).toMatchObject({ ok: false, error: 'errors.evaluation_source.locked' })
    expect(await svc.changeEvaluationSource({ primary: 'crm' })).toMatchObject({ ok: true, after: { primary: 'crm' } })
  })

  it('turns the secondary on and off even when locked', async () => {
    await addActivity({ crmRelatedId: 'a0X000000000001' })
    expect(await svc.changeEvaluationSource({ criteriaiqSecondary: true })).toMatchObject({ ok: true, after: { criteriaiqSecondary: true } })
    expect(await svc.changeEvaluationSource({ criteriaiqSecondary: false })).toMatchObject({ ok: true, after: { criteriaiqSecondary: false } })
  })

  it('drops the secondary when the primary moves away from the CRM object', async () => {
    await svc.changeEvaluationSource({ criteriaiqSecondary: true })
    const r = await svc.changeEvaluationSource({ primary: 'off' })
    expect(r).toMatchObject({ ok: true, after: { primary: 'off', criteriaiqSecondary: false } })
    expect(await svc.changeEvaluationSource({ criteriaiqSecondary: true })).toMatchObject({ ok: false, error: 'errors.evaluation_source.secondary_needs_crm' })
  })

  it('needs a CriteriaIQ connection for CriteriaIQ as primary or secondary', async () => {
    configured.mockImplementation(async () => false)
    expect(await svc.changeEvaluationSource({ primary: 'criteriaiq' })).toMatchObject({ ok: false, error: 'errors.criteriaiq.not_configured' })
    expect(await svc.changeEvaluationSource({ criteriaiqSecondary: true })).toMatchObject({ ok: false, error: 'errors.criteriaiq.not_configured' })
    expect(await svc.changeEvaluationSource({ primary: 'off' })).toMatchObject({ ok: true })
  })

  it('refuses a choice this build does not offer yet', async () => {
    sources.mockImplementation(() => ['crm'])
    secondary.mockImplementation(() => false)
    expect(await svc.changeEvaluationSource({ primary: 'off' })).toMatchObject({ ok: false, status: 400, error: 'errors.evaluation_source.not_available' })
    expect(await svc.changeEvaluationSource({ criteriaiqSecondary: true })).toMatchObject({ ok: false, error: 'errors.evaluation_source.not_available' })
  })
})

describe('requireProjectsOn', () => {
  function fakeRes() {
    const res = { statusCode: 200, body: null as unknown }
    return Object.assign(res, {
      status(code: number) { res.statusCode = code; return this },
      json(b: unknown) { res.body = b; return this },
    })
  }

  it('lets the request through while Projects are on', async () => {
    const res = fakeRes()
    const next = vi.fn()
    await svc.requireProjectsOn()({} as Request, res as unknown as Response, next)
    expect(next).toHaveBeenCalledOnce()
    expect(await svc.areProjectsOn()).toBe(true)
  })

  it('answers 409 once Projects are turned off, and lets through again when back on', async () => {
    await svc.changeEvaluationSource({ primary: 'off' })
    const res = fakeRes()
    const next = vi.fn()
    await svc.requireProjectsOn()({} as Request, res as unknown as Response, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(409)
    expect(res.body).toMatchObject({ error: 'errors.evaluation_source.projects_off' })

    await svc.changeEvaluationSource({ primary: 'crm' })
    expect(await svc.areProjectsOn()).toBe(true)
  })
})

describe('requireCrmProjects', () => {
  function fakeRes() {
    const res = { statusCode: 200, body: null as unknown }
    return Object.assign(res, {
      status(code: number) { res.statusCode = code; return this },
      json(b: unknown) { res.body = b; return this },
    })
  }

  async function run() {
    const res = fakeRes()
    const next = vi.fn()
    await svc.requireCrmProjects()({} as Request, res as unknown as Response, next)
    return { res, next }
  }

  it('lets the request through with the CRM object as primary', async () => {
    const { next } = await run()
    expect(next).toHaveBeenCalledOnce()
  })

  it('answers 409 not_crm with CriteriaIQ as primary, and projects_off when off', async () => {
    await svc.changeEvaluationSource({ primary: 'criteriaiq' })
    const a = await run()
    expect(a.next).not.toHaveBeenCalled()
    expect(a.res.statusCode).toBe(409)
    expect(a.res.body).toMatchObject({ error: 'errors.evaluation_source.not_crm' })

    await svc.changeEvaluationSource({ primary: 'off' })
    const b = await run()
    expect(b.res.body).toMatchObject({ error: 'errors.evaluation_source.projects_off' })
  })
})
