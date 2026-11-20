// Keyword rules shared across teams (v1.468.0), against pglite. Reproduces the
// report: a rule edited on one team and widened to a second team left that
// team's own rule for the same type beside it, and showed the type as an id.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import { eq } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../../db/testDb.js'

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

interface RuleRow { id: string; keywords: string[]; activityTypeId: string | null; teamIds: string[]; teamActivityTypeId: string | null; activityTypeName: string | null }

async function call<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: T; error: string | null; meta: Record<string, unknown> } }
}

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  const { rulesRoutes } = await import('./rules.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/admin', rulesRoutes)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

async function makeTeam(name: string) {
  const [team] = await testDb.insert(schema.teams).values({ name, slug: `t-${crypto.randomUUID()}` }).returning()
  return team!
}
async function makeType(teamId: string, name: string) {
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId, name, sortOrder: 1 }).returning()
  await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: type!.id, teamId })
  return type!
}
async function makeRule(teamId: string, typeId: string | null, keywords: string[], extra: Partial<typeof schema.keywordRules.$inferInsert> = {}) {
  const [rule] = await testDb.insert(schema.keywordRules).values({
    teamId, keywords, activityTypeId: typeId, matchField: 'both', priority: 10, ...extra,
  }).returning()
  await testDb.insert(schema.keywordRuleTeams).values({ keywordRuleId: rule!.id, teamId })
  return rule!
}
async function makeUser(isAppAdmin: boolean) {
  const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'A', isAppAdmin }).returning()
  return u!
}

async function setup() {
  const demo = await makeTeam('[Demo] Sales Engineering')
  const se = await makeTeam('Solutions Engineering')
  const demoPox = await makeType(demo.id, 'POx Work')
  const sePox = await makeType(se.id, 'POx Work')
  const demoRule = await makeRule(demo.id, demoPox.id, ['eval', 'poc'])
  const seRule = await makeRule(se.id, sePox.id, ['eval', 'evaluation', 'poc', 'proof of concept', 'trial'])
  return { demo, se, demoPox, sePox, demoRule, seRule }
}

const wider = ['eval', 'evaluation', 'poc', 'proof of concept', 'trial', 'pox', 'pov', 'proof of value']

describe('keyword rule scope across teams', () => {
  it('widening a rule to another team replaces that team\'s covered rule and shows the type by name', async () => {
    const { demo, se, sePox, demoRule, seRule } = await setup()
    currentUserId = (await makeUser(true)).id

    const res = await call<RuleRow>('PATCH', `/teams/${demo.id}/keyword-rules/${demoRule.id}`, { keywords: wider, teamIds: [demo.id, se.id] })
    expect(res.status).toBe(200)
    expect(res.json.meta['replaced']).toEqual([{ ruleId: seRule.id, teamId: se.id, teamName: 'Solutions Engineering', deleted: true }])
    expect(await testDb.select().from(schema.keywordRules).where(eq(schema.keywordRules.id, seRule.id))).toHaveLength(0)

    const list = await call<RuleRow[]>('GET', `/teams/${se.id}/keyword-rules`)
    expect(list.json.data).toHaveLength(1)
    expect(list.json.data[0]!.id).toBe(demoRule.id)
    expect(list.json.data[0]!.activityTypeName).toBe('POx Work')
    expect(list.json.data[0]!.teamActivityTypeId).toBe(sePox.id)

    const { matchKeywords } = await import('../../services/ai/classify.js')
    const hit = await matchKeywords(se.id, 'Proof of value kickoff')
    expect(hit?.activityTypeId).toBe(sePox.id)
    expect(hit?.activityTypeName).toBe('POx Work')
  })

  it('leaves a rule alone when the saved rule does not cover all its keywords', async () => {
    const { demo, se, demoRule, seRule } = await setup()
    currentUserId = (await makeUser(true)).id
    const res = await call<RuleRow>('PATCH', `/teams/${demo.id}/keyword-rules/${demoRule.id}`, { keywords: ['eval', 'poc'], teamIds: [demo.id, se.id] })
    expect(res.status).toBe(200)
    expect(res.json.meta['replaced']).toEqual([])
    expect(await testDb.select().from(schema.keywordRules).where(eq(schema.keywordRules.id, seRule.id))).toHaveLength(1)
  })

  it('never replaces a rule on the team the admin is editing from', async () => {
    const { demo, demoPox, demoRule } = await setup()
    const sibling = await makeRule(demo.id, demoPox.id, ['poc'])
    currentUserId = (await makeUser(true)).id
    const res = await call<RuleRow>('PATCH', `/teams/${demo.id}/keyword-rules/${demoRule.id}`, { keywords: wider })
    expect(res.status).toBe(200)
    expect(await testDb.select().from(schema.keywordRules).where(eq(schema.keywordRules.id, sibling.id))).toHaveLength(1)
  })

  it('refuses a scope with a team that has no type of that name', async () => {
    const { demo, demoRule } = await setup()
    const channel = await makeTeam('Channel')
    currentUserId = (await makeUser(true)).id
    const res = await call('PATCH', `/teams/${demo.id}/keyword-rules/${demoRule.id}`, { teamIds: [demo.id, channel.id] })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('errors.keyword_rules.type_missing_in_teams|teams=Channel')
  })

  it('stops a Team Admin adding a team they are not on', async () => {
    const { demo, se, demoRule } = await setup()
    const admin = await makeUser(false)
    await testDb.insert(schema.teamMembers).values({ teamId: demo.id, userId: admin.id, role: 'team_admin' })
    currentUserId = admin.id
    const res = await call('PATCH', `/teams/${demo.id}/keyword-rules/${demoRule.id}`, { teamIds: [demo.id, se.id] })
    expect(res.status).toBe(403)
    // Re-sending the scope it already has is fine.
    expect((await call('PATCH', `/teams/${demo.id}/keyword-rules/${demoRule.id}`, { keywords: ['eval'], teamIds: [demo.id] })).status).toBe(200)
  })

  it('keeps a shared rule on the other team when its home team is deleted', async () => {
    const { demo, se, sePox, demoRule } = await setup()
    currentUserId = (await makeUser(true)).id
    await call('PATCH', `/teams/${demo.id}/keyword-rules/${demoRule.id}`, { keywords: wider, teamIds: [demo.id, se.id] })
    const { deleteTeamCascade } = await import('../../services/teams/deleteTeam.js')
    await deleteTeamCascade(demo.id)
    const [moved] = await testDb.select().from(schema.keywordRules).where(eq(schema.keywordRules.id, demoRule.id))
    expect(moved?.teamId).toBe(se.id)
    expect(moved?.activityTypeId).toBe(sePox.id)
  })
})
