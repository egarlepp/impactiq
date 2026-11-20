// Security audit fixes (v1.422.0): a request can't name one team for the role
// check and another for the data, a single activity is only readable by
// people allowed to see it, an activity type must belong to the activity's
// team, team config reads need team access, and teammates' drafts (and their
// notes) stay private.
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

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let app: express.Express

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  const { activitiesRouter } = await import('./activities.js')
  const { teamsRouter } = await import('./teams.js')
  const { notesRouter } = await import('./notes.js')
  const { defaultJsonBody } = await import('../middleware/json-body.js')
  const { requireRole } = await import('../middleware/rbac.js')
  const { resolveTeamScope } = await import('./dashboards/shared.js')
  app = express()
  app.use(defaultJsonBody())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  // Stand-in for a dashboard route: role check on the request's team, data
  // read from the query, the way every dashboard handler reads it.
  app.all('/probe', requireRole('leader', 'admin'), async (req, res) => {
    const scope = await resolveTeamScope(req, req.query['teamId'] as string | undefined)
    res.json({ data: { teamId: req.query['teamId'], scope }, error: null, meta: {} })
  })
  app.use('/api/activities', activitiesRouter)
  app.use('/api/teams', teamsRouter)
  app.use('/api/notes', notesRouter)
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: { data: unknown; error: string | null } }> {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const { request } = await import('node:http')
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  } finally {
    server.close()
  }
}

async function user(name: string) {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: name }).returning()
  return u!
}

async function world() {
  const [teamA] = await testDb.insert(schema.teams).values({ name: 'A', slug: `a-${crypto.randomUUID()}` }).returning()
  const [teamB] = await testDb.insert(schema.teams).values({ name: 'B', slug: `b-${crypto.randomUUID()}` }).returning()
  const leaderA = await user('Leader A')
  const contribA = await user('Contributor A')
  const contribA2 = await user('Contributor A2')
  const contribB = await user('Contributor B')
  await testDb.insert(schema.teamMembers).values([
    { teamId: teamA!.id, userId: leaderA.id, role: 'leader' },
    { teamId: teamA!.id, userId: contribA.id, role: 'contributor' },
    { teamId: teamA!.id, userId: contribA2.id, role: 'contributor' },
    { teamId: teamB!.id, userId: contribB.id, role: 'contributor' },
  ])
  const [typeA] = await testDb.insert(schema.teamActivityTypes).values({ teamId: teamA!.id, name: 'Demo', sortOrder: 1 }).returning()
  const [typeB] = await testDb.insert(schema.teamActivityTypes).values({ teamId: teamB!.id, name: 'Demo', sortOrder: 1 }).returning()
  await testDb.insert(schema.teamActivityTypeCrmExtras).values({ teamActivityTypeId: typeB!.id, kind: 'ticket_picker', config: {} })
  const base = {
    teamId: teamA!.id, activityTypeId: typeA!.id, crmWhatType: 'Opportunity' as const, crmWhatId: '006X',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
  }
  const [submitted] = await testDb.insert(schema.activities).values({ ...base, userId: contribA.id, title: 'Submitted', status: 'submitted' }).returning()
  const [draft] = await testDb.insert(schema.activities).values({ ...base, userId: contribA.id, title: 'Draft', status: 'draft' }).returning()
  const [onB] = await testDb.insert(schema.activities).values({ ...base, teamId: teamB!.id, activityTypeId: typeB!.id, userId: contribB.id, title: 'On B', status: 'submitted' }).returning()
  await testDb.insert(schema.activityNotes).values([
    { activityId: submitted!.id, body: 'note on submitted', createdBy: contribA.id },
    { activityId: draft!.id, body: 'note on draft', createdBy: contribA.id },
  ])
  const [subB] = await testDb.insert(schema.subteams).values({ teamId: teamB!.id, name: 'Sub B' }).returning()
  await testDb.insert(schema.subteamUsers).values({ subteamId: subB!.id, userId: contribB.id, role: 'member' })
  return { teamA: teamA!, teamB: teamB!, leaderA, contribA, contribA2, contribB, typeA: typeA!, typeB: typeB!, submitted: submitted!, draft: draft!, onB: onB!, subB: subB! }
}

describe('team named twice (H1)', () => {
  it('ignores a GET body, so the role check and the data read agree', async () => {
    const w = await world()
    currentUserId = w.leaderA.id
    const res = await call('GET', `/probe?teamId=${w.teamB.id}`, { teamId: w.teamA.id })
    expect(res.status).toBe(403)
  })

  it('refuses a body and query that name different teams', async () => {
    const w = await world()
    currentUserId = w.leaderA.id
    const res = await call('POST', `/probe?teamId=${w.teamB.id}`, { teamId: w.teamA.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('errors.teams.conflicting_team_ids')
  })

  it('still answers for the leader\'s own team', async () => {
    const w = await world()
    currentUserId = w.leaderA.id
    const res = await call('GET', `/probe?teamId=${w.teamA.id}`)
    expect(res.status).toBe(200)
    expect((res.body.data as { scope: string[] }).scope).toEqual([w.teamA.id])
  })

  it('resolveTeamScope gives nothing for a team the caller can\'t see', async () => {
    const w = await world()
    currentUserId = w.leaderA.id
    const { resolveTeamScope } = await import('./dashboards/shared.js')
    const req = { user: { id: w.leaderA.id } } as unknown as express.Request
    expect(await resolveTeamScope(req, w.teamB.id)).toBeNull()
    expect(await resolveTeamScope(req, w.teamA.id)).toEqual([w.teamA.id])
  })
})

describe('GET /api/activities/:id (H2)', () => {
  it('lets the owner read their own draft', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    expect((await call('GET', `/api/activities/${w.draft.id}`)).status).toBe(200)
  })

  it('lets a teammate read a submitted activity but not a draft', async () => {
    const w = await world()
    currentUserId = w.contribA2.id
    expect((await call('GET', `/api/activities/${w.submitted.id}`)).status).toBe(200)
    expect((await call('GET', `/api/activities/${w.draft.id}`)).status).toBe(404)
  })

  it('hides another team\'s activity', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    expect((await call('GET', `/api/activities/${w.onB.id}`)).status).toBe(404)
  })
})

describe('other activity reads (H3, L1)', () => {
  it('refuses by-sf for a team the caller isn\'t on', async () => {
    const w = await world()
    currentUserId = w.contribB.id
    expect((await call('GET', `/api/activities/by-sf?teamId=${w.teamA.id}&whatId=006X`)).status).toBe(403)
    currentUserId = w.contribA2.id
    const own = await call('GET', `/api/activities/by-sf?teamId=${w.teamA.id}&whatId=006X`)
    expect(own.status).toBe(200)
    expect((own.body.data as Array<{ title: string }>).map((r) => r.title)).toEqual(['Submitted'])
  })

  it('refuses eval-fields and sf-extras outside the caller\'s teams', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    expect((await call('GET', `/api/activities/eval-fields?teamId=${w.teamB.id}&relatedId=a0X`)).status).toBe(403)
    expect((await call('GET', `/api/activities/sf-extras/${w.typeB.id}`)).status).toBe(404)
    currentUserId = w.contribB.id
    const res = await call('GET', `/api/activities/sf-extras/${w.typeB.id}`)
    expect(res.status).toBe(200)
    expect((res.body.data as unknown[]).length).toBe(1)
  })
})

describe('activity type must belong to the team (M1)', () => {
  it('refuses a new activity using another team\'s type', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    const res = await call('POST', '/api/activities', {
      teamId: w.teamA.id, title: 'x', activityTypeId: w.typeB.id,
      startDatetime: '2026-10-21T15:00:00.000Z', endDatetime: '2026-10-21T16:00:00.000Z', effortHours: 1,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('errors.activities.type_not_on_team')
  })

  it('refuses switching an activity to another team\'s type', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    const res = await call('PATCH', `/api/activities/${w.draft.id}`, { teamId: w.teamA.id, activityTypeId: w.typeB.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('errors.activities.type_not_on_team')
  })
})

describe('team reads (L2, L3)', () => {
  it('refuses another team\'s config', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    expect((await call('GET', `/api/teams/${w.teamB.id}/activity-types`)).status).toBe(403)
    expect((await call('GET', `/api/teams/${w.teamB.id}/products`)).status).toBe(403)
    expect((await call('GET', `/api/teams/${w.teamA.id}/activity-types`)).status).toBe(200)
  })

  it('returns no members for a subteam that isn\'t on the team in the URL', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    const res = await call('GET', `/api/teams/${w.teamA.id}/subteams/${w.subB.id}/members`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

describe('notes on teammates\' drafts (L4)', () => {
  it('shows teammates only notes on submitted activities', async () => {
    const w = await world()
    currentUserId = w.contribA2.id
    const mine = await call('GET', '/api/notes?scope=mine&allUsers=1')
    expect((mine.body.data as Array<{ body: string }>).map((n) => n.body)).toEqual(['note on submitted'])
    const opp = await call('GET', `/api/notes?scope=opportunity&teamId=${w.teamA.id}&crmWhatId=006X`)
    expect((opp.body.data as Array<{ body: string }>).map((n) => n.body)).toEqual(['note on submitted'])
    expect((await call('GET', `/api/notes?scope=activity&activityId=${w.draft.id}`)).status).toBe(403)
  })

  it('still shows the owner their own draft notes', async () => {
    const w = await world()
    currentUserId = w.contribA.id
    const opp = await call('GET', `/api/notes?scope=opportunity&teamId=${w.teamA.id}&crmWhatId=006X`)
    expect((opp.body.data as Array<{ body: string }>).map((n) => n.body).sort()).toEqual(['note on draft', 'note on submitted'])
  })
})
