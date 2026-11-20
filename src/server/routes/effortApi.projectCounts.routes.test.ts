// v1.454.0: GET /api/v1/effort/activity-types and POST
// /api/v1/effort/project-counts, for CriteriaIQ's project table. Only
// effort:read keys, only chosen activity types, only activities linked to the
// project's record (plus the Opportunity-within-dates fallback when asked).
// Real routes against pglite.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let app: express.Express
let apiKeysLib: typeof import('../services/auth/apiKeys.js')

const EVAL_18 = 'a0X5e00000AbCdEFGH'
const EVAL_15 = EVAL_18.slice(0, 15)
const OPP_18 = '006Ab00000XyZ12AAB'
const HUBSPOT_PROJECT = '987654321'

let leaderKey = ''
let restKey = ''

async function makeUser(name: string) {
  const [u] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: name,
  }).returning()
  return u!
}

async function makeKey(userId: string, scopes: string[]): Promise<string> {
  const raw = apiKeysLib.newRawApiKey()
  const { salt, hash } = apiKeysLib.hashRawKey(raw)
  await testDb.insert(schema.apiKeys).values({ userId, name: 'k', keyHash: hash, keySalt: salt, keyPrefix: apiKeysLib.keyPrefix(raw), scopes })
  return raw
}

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  apiKeysLib = await import('../services/auth/apiKeys.js')
  const { effortApiRouter } = await import('./effortApi.js')
  app = express()
  app.use(express.json())
  app.use('/api/v1', effortApiRouter)

  const [team] = await testDb.insert(schema.teams).values({ name: 'SE', slug: `se-${crypto.randomUUID()}` }).returning()
  const [other] = await testDb.insert(schema.teams).values({ name: 'Other', slug: `o-${crypto.randomUUID()}` }).returning()
  const [pox] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'POx Work', sortOrder: 1, icon: 'FlaskConical', color: '#7C3AED' }).returning()
  const [demo] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 2 }).returning()
  const [meeting] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Meeting', sortOrder: 3 }).returning()
  await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'None', sortOrder: 999, isActive: false })
  const [otherPox] = await testDb.insert(schema.teamActivityTypes).values({ teamId: other!.id, name: 'POx Work', sortOrder: 1 }).returning()
  await testDb.insert(schema.teamActivityTypeCrmExtras).values({ teamActivityTypeId: pox!.id, kind: 'related_object_picker', config: { sobject: 'Evaluations__c' } })

  const leader = await makeUser('Lee Leader')
  const ana = await makeUser('Ana SE')
  const outsider = await makeUser('Out Sider')
  await testDb.insert(schema.teamMembers).values([
    { teamId: team!.id, userId: leader.id, role: 'leader' },
    { teamId: team!.id, userId: ana.id, role: 'contributor' },
    { teamId: other!.id, userId: outsider.id, role: 'contributor' },
  ])
  leaderKey = await makeKey(leader.id, ['effort:read'])
  restKey = await makeKey(leader.id, ['rest:full'])

  const base = {
    teamId: team!.id, userId: ana.id, status: 'submitted' as const, title: 'Private: secret',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'),
  }
  await testDb.insert(schema.activities).values([
    // Project 1: the Salesforce Evaluation, saved with either id length.
    { ...base, activityTypeId: pox!.id, effortHours: '2.00', crmRelatedType: 'Evaluations__c', crmRelatedId: EVAL_18, crmWhatType: 'Opportunity' as const, crmWhatId: OPP_18 },
    { ...base, activityTypeId: pox!.id, effortHours: '1.50', crmRelatedType: 'Evaluations__c', crmRelatedId: EVAL_15, startDatetime: new Date('2026-10-25T15:00:00Z') },
    // A Meeting on the same Evaluation: not a chosen type.
    { ...base, activityTypeId: meeting!.id, effortHours: '9.00', crmRelatedType: 'Evaluations__c', crmRelatedId: EVAL_18 },
    // Draft and archived rows never count.
    { ...base, activityTypeId: pox!.id, effortHours: '9.00', crmRelatedType: 'Evaluations__c', crmRelatedId: EVAL_18, status: 'draft' as const },
    { ...base, activityTypeId: pox!.id, effortHours: '9.00', crmRelatedType: 'Evaluations__c', crmRelatedId: EVAL_18, isArchived: true },
    // Another team the owner can't see.
    { ...base, teamId: other!.id, userId: outsider.id, activityTypeId: otherPox!.id, effortHours: '9.00', crmRelatedType: 'Evaluations__c', crmRelatedId: EVAL_18 },
    // Demos on the Opportunity with no Project link: only the fallback counts them, and only inside the dates.
    { ...base, activityTypeId: demo!.id, effortHours: '1.00', crmWhatType: 'Opportunity' as const, crmWhatId: OPP_18, startDatetime: new Date('2026-10-21T15:00:00Z') },
    { ...base, activityTypeId: demo!.id, effortHours: '1.00', crmWhatType: 'Opportunity' as const, crmWhatId: OPP_18, startDatetime: new Date('2026-12-21T15:00:00Z') },
    // Project 2: CriteriaIQ itself as the Project source.
    { ...base, activityTypeId: demo!.id, effortHours: '0.75', crmRelatedType: 'CriteriaIQ', crmRelatedId: '42' },
    // Project 3: a HubSpot project object, matched exactly.
    { ...base, activityTypeId: pox!.id, effortHours: '4.00', crmRelatedType: '0-970', crmRelatedId: HUBSPOT_PROJECT },
    { ...base, activityTypeId: pox!.id, effortHours: '4.00', crmRelatedType: '0-970', crmRelatedId: `${HUBSPOT_PROJECT}0` },
  ])
})

async function call(method: 'GET' | 'POST', path: string, key?: string, body?: unknown) {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (key) headers['authorization'] = `Bearer ${key}`
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> | null; error: string | null } }
  } finally {
    server.close()
  }
}

const PROJECTS = [
  { criteriaiqProjectId: 1, crmProjectId: EVAL_18, crmOpportunityId: OPP_18, startDate: '2026-10-01', endDate: '2026-11-30' },
  { criteriaiqProjectId: 42 },
  { criteriaiqProjectId: 3, crmProjectId: HUBSPOT_PROJECT },
  { criteriaiqProjectId: 4, crmProjectId: '000000000000000' },
]

function byId(data: Record<string, unknown> | null): Map<number, Record<string, unknown>> {
  return new Map((data!['projects'] as Array<Record<string, unknown>>).map((p) => [p['criteriaiqProjectId'] as number, p]))
}

describe('GET /api/v1/effort/activity-types', () => {
  it('needs an effort:read key', async () => {
    expect((await call('GET', '/api/v1/effort/activity-types')).status).toBe(401)
    expect((await call('GET', '/api/v1/effort/activity-types', restKey)).status).toBe(403)
  })

  it('lists active type names on the owner\'s teams and which have a Project picker', async () => {
    const res = await call('GET', '/api/v1/effort/activity-types', leaderKey)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      version: 1,
      activityTypes: [
        { name: 'Demo', hasProjectPicker: false },
        { name: 'Meeting', hasProjectPicker: false },
        { name: 'POx Work', hasProjectPicker: true },
      ],
    })
  })
})

describe('POST /api/v1/effort/project-counts', () => {
  it('needs an effort:read key before it reads the body', async () => {
    expect((await call('POST', '/api/v1/effort/project-counts', undefined, { nope: true })).status).toBe(401)
    expect((await call('POST', '/api/v1/effort/project-counts', restKey, { nope: true })).status).toBe(403)
  })

  it('refuses a malformed request', async () => {
    const bad = [
      { activityTypes: [], projects: PROJECTS },
      { activityTypes: ['POx Work'], projects: [] },
      { activityTypes: ['POx Work'], projects: [{ criteriaiqProjectId: 1, crmProjectId: "a0X' OR 1=1" }] },
      { activityTypes: ['POx Work'], projects: Array.from({ length: 201 }, (_, i) => ({ criteriaiqProjectId: i + 1 })) },
      { activityTypes: ['POx Work'], projects: [{ criteriaiqProjectId: 1, startDate: '2026-13-45' }] },
    ]
    for (const body of bad) expect((await call('POST', '/api/v1/effort/project-counts', leaderKey, body)).status).toBe(400)
  })

  it('counts chosen types linked to each project\'s record', async () => {
    const res = await call('POST', '/api/v1/effort/project-counts', leaderKey, { activityTypes: ['pox work', 'Demo'], projects: PROJECTS })
    expect(res.status).toBe(200)
    const p = byId(res.body.data)
    expect(p.get(1)).toEqual({ criteriaiqProjectId: 1, activityCount: 2, totalHours: 3.5, lastActivityAt: '2026-10-25T15:00:00.000Z', viaOpportunity: 0 })
    expect(p.get(42)).toMatchObject({ activityCount: 1, totalHours: 0.75 })
    expect(p.get(3)).toMatchObject({ activityCount: 1, totalHours: 4 })
    expect(p.get(4)).toEqual({ criteriaiqProjectId: 4, activityCount: 0, totalHours: 0, lastActivityAt: null, viaOpportunity: 0 })
    expect(JSON.stringify(res.body)).not.toContain('secret')
  })

  it('leaves out types that were not chosen', async () => {
    const p = byId((await call('POST', '/api/v1/effort/project-counts', leaderKey, { activityTypes: ['Demo'], projects: PROJECTS })).body.data)
    expect(p.get(1)).toMatchObject({ activityCount: 0 })
    expect(p.get(42)).toMatchObject({ activityCount: 1 })
  })

  it('adds unlinked Opportunity activities inside the project dates only when the fallback is on', async () => {
    const p = byId((await call('POST', '/api/v1/effort/project-counts', leaderKey, { activityTypes: ['POx Work', 'Demo'], opportunityFallback: true, projects: PROJECTS })).body.data)
    // The Demo on 21 Oct counts; the one on 21 Dec is after the end date; the linked POx Work isn't counted twice.
    expect(p.get(1)).toMatchObject({ activityCount: 3, totalHours: 4.5, viaOpportunity: 1 })
  })
})

describe('POST /api/v1/effort/project-activities', () => {
  const P1 = PROJECTS[0]!

  it('needs an effort:read key before it reads the body', async () => {
    expect((await call('POST', '/api/v1/effort/project-activities', undefined, { nope: true })).status).toBe(401)
    expect((await call('POST', '/api/v1/effort/project-activities', restKey, { nope: true })).status).toBe(403)
  })

  it('refuses a malformed request', async () => {
    const bad = [
      { activityTypes: [], project: P1 },
      { activityTypes: ['POx Work'] },
      { activityTypes: ['POx Work'], project: { criteriaiqProjectId: 1, crmProjectId: "a0X' OR 1=1" } },
      { activityTypes: ['POx Work'], projects: PROJECTS },
    ]
    for (const body of bad) expect((await call('POST', '/api/v1/effort/project-activities', leaderKey, body)).status).toBe(400)
  })

  it('lists the same activities the count counts, newest first, with type, person, hours and dates', async () => {
    const body = { activityTypes: ['POx Work', 'Demo'], opportunityFallback: true, project: P1 }
    const res = await call('POST', '/api/v1/effort/project-activities', leaderKey, body)
    expect(res.status).toBe(200)
    const data = res.body.data!
    expect(data).toMatchObject({ version: 1, criteriaiqProjectId: 1, activityCount: 3, totalHours: 4.5, truncated: false })
    const list = data['activities'] as Array<Record<string, unknown>>
    expect(list.map((a) => [a['type'], a['ownerName'], a['hours'], a['startAt'], a['viaOpportunity']])).toEqual([
      ['POx Work', 'Ana SE', 1.5, '2026-10-25T15:00:00.000Z', false],
      ['Demo', 'Ana SE', 1, '2026-10-21T15:00:00.000Z', true],
      ['POx Work', 'Ana SE', 2, '2026-10-20T15:00:00.000Z', false],
    ])
    expect(list[2]!['endAt']).toBe('2026-10-20T16:00:00.000Z')
    expect(list[0]).toMatchObject({ typeIcon: 'FlaskConical', typeColor: '#7C3AED' })
    expect(list[1]).toMatchObject({ typeIcon: null, typeColor: null })
    expect(JSON.stringify(res.body)).not.toContain('secret')

    const counts = byId((await call('POST', '/api/v1/effort/project-counts', leaderKey, { activityTypes: body.activityTypes, opportunityFallback: true, projects: [P1] })).body.data)
    expect(counts.get(1)).toMatchObject({ activityCount: data['activityCount'], totalHours: data['totalHours'] })
  })

  it('lists nothing for a project with no linked activity', async () => {
    const res = await call('POST', '/api/v1/effort/project-activities', leaderKey, { activityTypes: ['POx Work'], project: PROJECTS[3] })
    expect(res.body.data).toMatchObject({ activityCount: 0, totalHours: 0, activities: [] })
  })
})
