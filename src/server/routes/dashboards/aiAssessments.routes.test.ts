// AI Assessment Scores dashboard (routes/dashboards/aiAssessments.ts) against
// pglite: submitted activities only, never the caller's own, Leaders with the
// activities.ai_assessments grant only, and both averages per assessment.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import { and, eq } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../../db/testDb.js'
import type { AiAssessmentDashboardAssessment } from '../../../shared/aiAssessments.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let base = ''
let currentUserId = ''

async function get(query: string) {
  const res = await fetch(`${base}/api/dashboards/ai-assessments?${query}`)
  return { status: res.status, json: await res.json() as { data: AiAssessmentDashboardAssessment[] | null; error: string | null; meta: Record<string, unknown> } }
}

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  const { aiAssessmentsDashRoutes } = await import('./aiAssessments.js')
  const app = express()
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/dashboards', aiAssessmentsDashRoutes)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

async function seed() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const mkUser = async (name: string, role: 'contributor' | 'leader') => {
    const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: name }).returning()
    await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: u!.id, role })
    return u!
  }
  const ann = await mkUser('Ann', 'contributor')
  const bob = await mkUser('Bob', 'contributor')
  const lee = await mkUser('Lee Leader', 'leader')
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Discovery', sortOrder: 1 }).returning()
  const [assessment] = await testDb.insert(schema.aiAssessments).values({ teamId: team!.id, name: 'Technical Discovery', version: 2 }).returning()
  const [k1] = await testDb.insert(schema.aiAssessmentCriteria).values({ assessmentId: assessment!.id, name: 'Pain quantified', weight: 25, sortOrder: 0 }).returning()
  const [k2] = await testDb.insert(schema.aiAssessmentCriteria).values({ assessmentId: assessment!.id, name: 'Next step', weight: 10, sortOrder: 1 }).returning()

  let day = 1
  const score = async (owner: { id: string }, opts: { zeroed: number; observed: number | null; levels: [number | null, number | null]; status?: 'draft' | 'submitted'; version?: number }) => {
    const start = new Date(`2026-10-${String(day++).padStart(2, '0')}T15:00:00Z`)
    const [act] = await testDb.insert(schema.activities).values({
      userId: owner.id, teamId: team!.id, title: `Call ${day}`, activityTypeId: type!.id, status: opts.status ?? 'submitted',
      startDatetime: start, endDatetime: new Date(start.getTime() + 3600_000), effortHours: '1.00',
    }).returning()
    const notObserved = opts.levels.filter((l) => l === null).length
    await testDb.insert(schema.activityAiAssessmentScores).values({
      activityId: act!.id, teamId: team!.id, assessmentId: assessment!.id, assessmentName: 'Technical Discovery',
      assessmentVersion: opts.version ?? 2, zeroedScore: opts.zeroed, observedScore: opts.observed,
      notObservedCount: notObserved, criteriaCount: 2,
      criteria: [
        { criterionId: k1!.id, name: 'Pain quantified', weight: 25, level: opts.levels[0], rationale: null, citations: [] },
        { criterionId: k2!.id, name: 'Next step', weight: 10, level: opts.levels[1], rationale: null, citations: [] },
      ],
      gongCallIds: [],
    })
    return act!
  }
  await score(ann, { zeroed: 57, observed: 80, levels: [4, null], version: 1 })
  await score(ann, { zeroed: 100, observed: 100, levels: [5, 5] })
  await score(bob, { zeroed: 40, observed: 40, levels: [2, 2] })
  await score(ann, { zeroed: 0, observed: null, levels: [null, null], status: 'draft' })
  await score(lee, { zeroed: 90, observed: 90, levels: [5, 4] })
  return { team: team!, ann, bob, lee }
}

describe('AI Assessment Scores dashboard', () => {
  it("averages submitted scores per assessment, leaving out drafts and the Leader's own", async () => {
    const { team, ann, bob, lee } = await seed()
    currentUserId = lee.id
    const r = await get(`teamId=${team.id}&weeks=0`)
    expect(r.status).toBe(200)
    expect(r.json.meta['scoredCount']).toBe(3)
    expect(r.json.data).toHaveLength(1)
    const a = r.json.data![0]!
    expect(a).toMatchObject({
      name: 'Technical Discovery', currentVersion: 2, scoredCount: 3,
      avgZeroed: 66, avgObserved: 73, avgNotObserved: 0.3, olderVersionCount: 1,
    })
    expect(a.people).toEqual([
      { userId: ann.id, name: 'Ann', scoredCount: 2, avgZeroed: 79, avgObserved: 90, avgNotObserved: 0.5 },
      { userId: bob.id, name: 'Bob', scoredCount: 1, avgZeroed: 40, avgObserved: 40, avgNotObserved: 0 },
    ])
    expect(a.criteria.map((c) => [c.name, c.scoredCount, c.observedCount, c.avgLevel])).toEqual([
      ['Pain quantified', 3, 3, 3.7],
      ['Next step', 3, 2, 3.5],
    ])
    expect(a.activities.map((x) => x.ownerName)).toEqual(['Bob', 'Ann', 'Ann'])

    const onlyBob = await get(`teamId=${team.id}&weeks=0&userIds=${bob.id}`)
    expect(onlyBob.json.data![0]!.scoredCount).toBe(1)
  })

  it('refuses Contributors, and Leaders without the Assessments grant', async () => {
    const { team, ann, lee } = await seed()
    currentUserId = ann.id
    expect((await get(`teamId=${team.id}&weeks=0`)).status).toBe(403)

    currentUserId = lee.id
    const grant = and(eq(schema.rolePermissions.role, 'leader'), eq(schema.rolePermissions.pageKey, 'activities.ai_assessments'))
    await testDb.update(schema.rolePermissions).set({ hasAccess: false }).where(grant)
    try {
      const r = await get(`teamId=${team.id}&weeks=0`)
      expect(r.status).toBe(403)
      expect(r.json.error).toBe('errors.forbidden')
    } finally {
      await testDb.update(schema.rolePermissions).set({ hasAccess: true }).where(grant)
    }
  })
})
