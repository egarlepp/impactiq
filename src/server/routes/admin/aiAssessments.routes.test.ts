// Admin → Activities & Rules → AI Assessments (routes/admin/aiAssessments.ts)
// against pglite: rubrics, sharing, locking and Type/Subtype assignments.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import { eq } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../../db/testDb.js'
import type { AiAssessmentsAdminView } from '../../../shared/aiAssessments.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../../services/audit/log.js', () => ({ logAudit: async () => {} }))

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let base = ''
let currentUserId = ''

async function call<T = AiAssessmentsAdminView>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: T; error: string | null; meta: { id?: string } } }
}

async function mkTeam() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  return team!
}

async function mkUser(isAppAdmin: boolean, memberships: Array<{ teamId: string; role: 'team_admin' | 'contributor' | 'leader' }>) {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'A', isAppAdmin }).returning()
  for (const m of memberships) await testDb.insert(schema.teamMembers).values({ teamId: m.teamId, userId: u!.id, role: m.role })
  return u!
}

async function mkType(teamId: string, name: string) {
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId, name, sortOrder: 1 }).returning()
  await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: type!.id, teamId })
  const [sub] = await testDb.insert(schema.teamActivityTypeSubtypes).values({ teamActivityTypeId: type!.id, name: `${name} sub` }).returning()
  return { type: type!, sub: sub! }
}

const rubric = {
  name: 'Technical Discovery',
  description: 'How complete the discovery was',
  criteria: [
    { name: 'Pain quantified', lookFor: 'A cost or time figure', weight: 25, anchors: { '1': 'None', '5': 'With a figure', '3': '  ' } },
    { name: 'Next step with a date', weight: 10 },
  ],
}

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  const { aiAssessmentsAdminRoutes } = await import('./aiAssessments.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/admin', aiAssessmentsAdminRoutes)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

describe('AI Assessments admin', () => {
  it('lets a Team Admin create, edit and assign a rubric, and blocks contributors', async () => {
    const team = await mkTeam()
    const admin = await mkUser(false, [{ teamId: team.id, role: 'team_admin' }])
    const contributor = await mkUser(false, [{ teamId: team.id, role: 'contributor' }])
    const { type, sub } = await mkType(team.id, 'Discovery')

    currentUserId = contributor.id
    expect((await call('GET', `/teams/${team.id}/ai-assessments`)).status).toBe(403)

    currentUserId = admin.id
    const created = await call('POST', `/teams/${team.id}/ai-assessments`, rubric)
    expect(created.status).toBe(201)
    const id = created.json.meta.id!
    const a = created.json.data.assessments.find((x) => x.id === id)!
    expect(a).toMatchObject({ name: 'Technical Discovery', version: 1, isLocked: false, teamIds: [team.id] })
    expect(a.criteria.map((c) => [c.name, c.weight, c.sortOrder])).toEqual([['Pain quantified', 25, 0], ['Next step with a date', 10, 1]])
    expect(a.criteria[0]!.anchors).toEqual({ '1': 'None', '5': 'With a figure' })
    expect(created.json.data.canLock).toBe(false)

    // A Team Admin can't lock.
    expect((await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { isLocked: true })).status).toBe(403)

    // Editing the rubric bumps the version; switching it off does not.
    let r = await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { criteria: [{ name: 'Only one', weight: 5 }] })
    expect(r.json.data.assessments[0]).toMatchObject({ version: 2 })
    expect(r.json.data.assessments[0]!.criteria).toHaveLength(1)
    r = await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { isActive: false })
    expect(r.json.data.assessments[0]).toMatchObject({ version: 2, isActive: false })
    // The icon is cosmetic: no version bump, and null clears it.
    r = await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { icon: 'Search', iconColor: '#2563EB' })
    expect(r.json.data.assessments[0]).toMatchObject({ version: 2, icon: 'Search', iconColor: '#2563EB' })
    r = await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { iconColor: null })
    expect(r.json.data.assessments[0]).toMatchObject({ icon: 'Search', iconColor: null })

    // Assign type-wide and to one Subtype.
    r = await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: type.id, subtypeId: null, assessmentId: id })
    expect(r.status).toBe(201)
    r = await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: type.id, subtypeId: sub.id, assessmentId: id })
    expect(r.status).toBe(201)
    expect(r.json.data.assignments).toHaveLength(2)
    expect(r.json.data.assessments[0]!.assignmentCount).toBe(2)
    expect((await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: type.id, subtypeId: null, assessmentId: id })).status).toBe(409)

    // Unassign, then delete the rubric (cascades the remaining assignment).
    const subRow = r.json.data.assignments.find((x) => x.subtypeId === sub.id)!
    r = await call('DELETE', `/teams/${team.id}/ai-assessment-assignments/${subRow.id}`)
    expect(r.json.data.assignments).toHaveLength(1)
    r = await call('DELETE', `/teams/${team.id}/ai-assessments/${id}`)
    expect(r.status).toBe(200)
    expect(r.json.data.assessments).toHaveLength(0)
    expect(await testDb.select().from(schema.aiAssessmentAssignments).where(eq(schema.aiAssessmentAssignments.teamId, team.id))).toHaveLength(0)
  })

  it('rejects a type, Subtype or rubric from another team, and caps rubrics per slot', async () => {
    const team = await mkTeam()
    const other = await mkTeam()
    const admin = await mkUser(false, [{ teamId: team.id, role: 'team_admin' }])
    const otherAdmin = await mkUser(false, [{ teamId: other.id, role: 'team_admin' }])
    const { type } = await mkType(team.id, 'Demo')
    const { type: otherType, sub: otherSub } = await mkType(other.id, 'Demo')

    currentUserId = otherAdmin.id
    const foreign = (await call('POST', `/teams/${other.id}/ai-assessments`, rubric)).json.meta.id!

    currentUserId = admin.id
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await call('POST', `/teams/${team.id}/ai-assessments`, { ...rubric, name: `R${i}` })).json.meta.id!)

    expect((await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: otherType.id, subtypeId: null, assessmentId: ids[0] })).status).toBe(404)
    expect((await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: type.id, subtypeId: otherSub.id, assessmentId: ids[0] })).status).toBe(404)
    expect((await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: type.id, subtypeId: null, assessmentId: foreign })).status).toBe(404)
    expect((await call('PATCH', `/teams/${team.id}/ai-assessments/${foreign}`, { name: 'Mine now' })).status).toBe(404)

    for (let i = 0; i < 3; i++) {
      expect((await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: type.id, subtypeId: null, assessmentId: ids[i] })).status).toBe(201)
    }
    const fourth = await call('POST', `/teams/${team.id}/ai-assessment-assignments`, { activityTypeId: type.id, subtypeId: null, assessmentId: ids[3] })
    expect(fourth.status).toBe(400)
    expect(fourth.json.error).toBe('errors.ai_assessments.too_many')

    // Sharing with a team the caller doesn't admin is refused.
    expect((await call('PATCH', `/teams/${team.id}/ai-assessments/${ids[0]}`, { teamIds: [team.id, other.id] })).status).toBe(403)
  })

  it('lets only an App Admin lock a rubric, and drops assignments on teams it is unshared from', async () => {
    const team = await mkTeam()
    const second = await mkTeam()
    const appAdmin = await mkUser(true, [])
    const teamAdmin = await mkUser(false, [{ teamId: team.id, role: 'team_admin' }, { teamId: second.id, role: 'team_admin' }])
    const { type: secondType } = await mkType(second.id, 'Demo')

    currentUserId = appAdmin.id
    const created = await call('POST', `/teams/${team.id}/ai-assessments`, { ...rubric, teamIds: [team.id, second.id], isLocked: true })
    expect(created.status).toBe(201)
    expect(created.json.data.canLock).toBe(true)
    const id = created.json.meta.id!
    expect((await call('POST', `/teams/${second.id}/ai-assessment-assignments`, { activityTypeId: secondType.id, subtypeId: null, assessmentId: id })).status).toBe(201)

    currentUserId = teamAdmin.id
    expect((await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { name: 'Changed' })).status).toBe(403)
    expect((await call('DELETE', `/teams/${team.id}/ai-assessments/${id}`)).status).toBe(403)

    currentUserId = appAdmin.id
    const r = await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { isLocked: false, teamIds: [team.id] })
    expect(r.status).toBe(200)
    expect(r.json.data.assessments[0]).toMatchObject({ isLocked: false, teamIds: [team.id] })
    expect(await testDb.select().from(schema.aiAssessmentAssignments).where(eq(schema.aiAssessmentAssignments.teamId, second.id))).toHaveLength(0)

    // Unlocked, the Team Admin may edit it.
    currentUserId = teamAdmin.id
    expect((await call('PATCH', `/teams/${team.id}/ai-assessments/${id}`, { name: 'Changed' })).status).toBe(200)
  })

  it('rejects invalid rubrics', async () => {
    const team = await mkTeam()
    const admin = await mkUser(false, [{ teamId: team.id, role: 'team_admin' }])
    currentUserId = admin.id
    expect((await call('POST', `/teams/${team.id}/ai-assessments`, { name: 'Empty', criteria: [] })).status).toBe(400)
    expect((await call('POST', `/teams/${team.id}/ai-assessments`, { name: 'Heavy', criteria: [{ name: 'x', weight: 101 }] })).status).toBe(400)
    expect((await call('POST', `/teams/${team.id}/ai-assessments`, { name: 'Bad color', iconColor: 'red', criteria: [{ name: 'x', weight: 1 }] })).status).toBe(400)
    expect((await call('POST', `/teams/${team.id}/ai-assessments`, { name: 'Bad icon', icon: '<svg>', criteria: [{ name: 'x', weight: 1 }] })).status).toBe(400)
    expect((await call('POST', `/teams/${team.id}/ai-assessments`, { name: 'Bad anchor', criteria: [{ name: 'x', weight: 1, anchors: { '6': 'no' } }] })).status).toBe(400)
  })
})
