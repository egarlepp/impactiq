// Security audit L6 and L7 (v1.425.0). L6: the install-wide CriteriaIQ link
// for an Evaluation can only be changed by an App Admin, someone with their
// own activity on it, or a leader/admin on a team that has one. L7: the
// record preview's local snapshot only comes from activities the viewer may
// read. pglite; CriteriaIQ itself mocked.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let currentUserId = ''
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js')
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { user: { id: string } }).user = { id: currentUserId }
      next()
    },
  }
})

vi.mock('../services/criteriaiq/evaluationLink.js', async () => {
  const actual = await vi.importActual<typeof import('../services/criteriaiq/evaluationLink.js')>('../services/criteriaiq/evaluationLink.js')
  return {
    ...actual,
    isCriteriaIqSecondaryOn: async () => true,
    resolveCriteriaIqEvaluationLink: async () => ({ state: 'none' }),
    setCriteriaIqEvaluationLink: async () => ({ ok: true, previousProjectId: null }),
    clearCriteriaIqEvaluationLink: async () => null,
  }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let app: express.Express
let readSnapshot: typeof import('../services/salesforce/preview.js')['readSnapshot']

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  readSnapshot = (await import('../services/salesforce/preview.js')).readSnapshot
  const { requireAuth } = await import('../middleware/auth.js')
  const { criteriaiqRouter } = await import('./criteriaiq.js')
  app = express()
  app.use(express.json())
  app.use('/api/criteriaiq', requireAuth, criteriaiqRouter)
})

async function makeUser(isAppAdmin = false) {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `o-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@acme.example`, displayName: 'P', isAppAdmin }).returning()
  return u!
}

async function makeTeam() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  return { teamId: team!.id, typeId: type!.id }
}

async function member(teamId: string, userId: string, role: 'contributor' | 'leader' | 'admin') {
  await testDb.insert(schema.teamMembers).values({ teamId, userId, role })
}

async function activity(userId: string, team: { teamId: string; typeId: string }, extra: Record<string, unknown>) {
  await testDb.insert(schema.activities).values({
    userId, teamId: team.teamId, activityTypeId: team.typeId, title: 'A',
    startDatetime: new Date(), endDatetime: new Date(), effortHours: '1', ...extra,
  })
}

async function call(method: string, path: string, userId: string, body?: unknown): Promise<{ status: number; error: string | null }> {
  currentUserId = userId
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) })
    return { status: res.status, error: ((await res.json()) as { error: string | null }).error }
  } finally {
    server.close()
  }
}

describe('CriteriaIQ evaluation link (L6)', () => {
  it('lets only an owner, a leader/admin on a team with an activity on it, or an App Admin change it', async () => {
    const team = await makeTeam()
    const otherTeam = await makeTeam()
    const owner = await makeUser()
    const leader = await makeUser()
    const contributor = await makeUser()
    const otherLeader = await makeUser()
    const appAdmin = await makeUser(true)
    await member(team.teamId, owner.id, 'contributor')
    await member(team.teamId, leader.id, 'leader')
    await member(team.teamId, contributor.id, 'contributor')
    await member(otherTeam.teamId, otherLeader.id, 'leader')
    await activity(owner.id, team, { crmRelatedId: 'EVAL001', status: 'draft' })

    const put = (u: string) => call('PUT', '/api/criteriaiq/evaluation-link', u, { recordId: 'EVAL001', projectId: 7 })
    const del = (u: string) => call('DELETE', '/api/criteriaiq/evaluation-link?recordId=EVAL001', u)
    for (const u of [owner, leader, appAdmin]) {
      expect((await put(u.id)).status).toBe(200)
      expect((await del(u.id)).status).toBe(200)
    }
    for (const u of [contributor, otherLeader]) {
      expect(await put(u.id)).toEqual({ status: 403, error: 'errors.criteriaiq.link_not_allowed' })
      expect(await del(u.id)).toEqual({ status: 403, error: 'errors.criteriaiq.link_not_allowed' })
    }
    // Reading stays open.
    expect((await call('GET', '/api/criteriaiq/evaluation-link?recordId=EVAL001', contributor.id)).status).toBe(200)
  })
})

describe('record preview snapshot (L7)', () => {
  it('reads only the viewer\'s own activities or submitted ones on teams they can see', async () => {
    const mine = await makeTeam()
    const theirs = await makeTeam()
    const viewer = await makeUser()
    const teammate = await makeUser()
    const outsider = await makeUser()
    await activity(outsider.id, theirs, { crmWhatId: 'OPP1', crmWhatType: 'Opportunity', salesStage: 'Secret stage', status: 'submitted' })
    const view = { userId: viewer.id, teamIds: [mine.teamId] }
    expect((await readSnapshot('OPP1', 'Opportunity', view)).stageName).toBeNull()

    // A teammate's draft is still private.
    await activity(teammate.id, mine, { crmWhatId: 'OPP1', crmWhatType: 'Opportunity', salesStage: 'Draft stage', status: 'draft' })
    expect((await readSnapshot('OPP1', 'Opportunity', view)).stageName).toBeNull()

    await activity(teammate.id, mine, { crmWhatId: 'OPP1', crmWhatType: 'Opportunity', salesStage: 'Team stage', status: 'submitted' })
    expect((await readSnapshot('OPP1', 'Opportunity', view)).stageName).toBe('Team stage')

    // The viewer's own draft counts, even with no teams.
    await activity(viewer.id, mine, { crmWhatId: 'OPP2', crmWhatType: 'Opportunity', salesStage: 'My stage', status: 'draft' })
    expect((await readSnapshot('OPP2', 'Opportunity', { userId: viewer.id, teamIds: [] })).stageName).toBe('My stage')
  })
})
