// /api/first-run (v1.475.0): the first-admin bootstrap for an install started
// with DATABASE_URL already set. Real routes against pglite.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const TOKEN = 'first-run-route-test-token'
let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let firstRun: typeof import('../services/auth/firstRun.js')
let base = ''

async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/first-run${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json() as { data: Record<string, unknown> | null; error: string | null } }
}

const admin = { email: 'admin@example.com', displayName: 'Admin', password: 'Correct-Horse-9-Battery' }

beforeAll(async () => {
  process.env['SETUP_TOKEN'] = TOKEN
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  firstRun = await import('../services/auth/firstRun.js')
  const { firstRunRouter } = await import('./firstRun.js')
  const app = express()
  app.use(express.json())
  app.use('/api/first-run', firstRunRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // A team already exists, so the real seed is never called.
  await testDb.insert(schema.teams).values({ name: 'Existing', slug: 'existing-first-run' })
})

beforeEach(async () => {
  await testDb.delete(schema.auditEvents)
  await testDb.delete(schema.teamMembers)
  await testDb.delete(schema.users)
  firstRun.resetFirstRunCacheForTests()
})

describe('/api/first-run', () => {
  it('reports that an admin is needed, then not once one exists', async () => {
    expect((await call('GET', '/status')).json.data).toEqual({ needsAdmin: true })
    expect((await call('POST', '/admin', admin, { 'X-Setup-Token': TOKEN })).status).toBe(200)
    expect((await call('GET', '/status')).json.data).toEqual({ needsAdmin: false })
  })

  it('needs the setup token', async () => {
    expect((await call('POST', '/admin', admin)).status).toBe(401)
    expect((await call('POST', '/admin', admin, { 'X-Setup-Token': 'wrong-token-wrong-token' })).status).toBe(401)
    expect(await testDb.select().from(schema.users)).toEqual([])
  })

  it('creates the admin, audits it, and refuses every later attempt', async () => {
    const r = await call('POST', '/admin', admin, { 'X-Setup-Token': TOKEN })
    expect(r.status).toBe(200)
    const audit = await testDb.select().from(schema.auditEvents)
    expect(audit).toEqual([expect.objectContaining({ action: 'user.create', actorEmail: 'admin@example.com' })])

    const again = await call('POST', '/admin', { ...admin, email: 'second@example.com' }, { 'X-Setup-Token': TOKEN })
    expect(again).toMatchObject({ status: 409, json: { error: 'errors.first_run.already_done' } })
    expect(await testDb.select().from(schema.users)).toHaveLength(1)
  })

  it('rejects bad input and weak passwords', async () => {
    expect((await call('POST', '/admin', { ...admin, email: 'nope' }, { 'X-Setup-Token': TOKEN })).status).toBe(400)
    const weak = await call('POST', '/admin', { ...admin, password: 'password' }, { 'X-Setup-Token': TOKEN })
    expect(weak).toMatchObject({ status: 400, json: { error: 'errors.first_run.weak_password' } })
    expect(await testDb.select().from(schema.users)).toEqual([])
  })
})
