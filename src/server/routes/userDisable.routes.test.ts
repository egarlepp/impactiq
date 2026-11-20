// Security audit L8 (v1.425.0): an App Admin can disable an account.
// Disabling revokes the user's sessions and API keys, and requireAuth, API
// keys and password sign-in all refuse a disabled account. API keys also
// respect a pending forced password change. Real routes against pglite.
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
let issueSession: typeof import('../services/auth/session.js')['issueSession']
let SESSION_COOKIE = ''
let apiKeysLib: typeof import('../services/auth/apiKeys.js')
let hashPassword: typeof import('../services/auth/password.js')['hashPassword']

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  const session = await import('../services/auth/session.js')
  issueSession = session.issueSession
  SESSION_COOKIE = session.SESSION_COOKIE
  apiKeysLib = await import('../services/auth/apiKeys.js')
  hashPassword = (await import('../services/auth/password.js')).hashPassword
  const { requireAuth } = await import('../middleware/auth.js')
  const { usersAdminRoutes } = await import('./admin/users.js')
  const { authRouter } = await import('./auth.js')
  app = express()
  app.use(express.json())
  app.use('/auth', authRouter)
  app.get('/api/ping', requireAuth, (req, res) => { res.json({ data: { id: req.user!.id }, error: null, meta: {} }) })
  app.use('/api/admin', requireAuth, usersAdminRoutes)
})

async function makeUser(opts: { isAppAdmin?: boolean; isDefaultAdmin?: boolean; password?: string } = {}) {
  const [u] = await testDb.insert(schema.users).values({
    oktaId: `local-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Pat',
    isAppAdmin: opts.isAppAdmin ?? false,
    isDefaultAdmin: opts.isDefaultAdmin ?? false,
    authMethod: 'password',
    passwordHash: opts.password ? hashPassword(opts.password) : null,
  }).returning()
  return u!
}

async function makeApiKey(userId: string): Promise<string> {
  const raw = apiKeysLib.newRawApiKey()
  const { salt, hash } = apiKeysLib.hashRawKey(raw)
  await testDb.insert(schema.apiKeys).values({ userId, name: 'k', keyHash: hash, keySalt: salt, keyPrefix: apiKeysLib.keyPrefix(raw) })
  return raw
}

async function call(method: string, path: string, opts: { session?: string; apiKey?: string; body?: unknown } = {}) {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.session) headers['cookie'] = `${SESSION_COOKIE}=${encodeURIComponent(opts.session)}`
    if (opts.apiKey) headers['authorization'] = `Bearer ${opts.apiKey}`
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) })
    return { status: res.status, body: await res.json() as { data: unknown; error: string | null } }
  } finally {
    server.close()
  }
}

describe('disabling a user', () => {
  it('revokes sessions and API keys, and blocks requireAuth and password sign-in until re-enabled', async () => {
    const admin = await makeUser({ isAppAdmin: true })
    const adminSession = await issueSession(admin.id)
    const target = await makeUser({ password: 'Correct-Horse-9!' })
    const session = await issueSession(target.id)
    const key = await makeApiKey(target.id)
    expect((await call('GET', '/api/ping', { session })).status).toBe(200)
    expect((await call('GET', '/api/ping', { apiKey: key })).status).toBe(200)

    const res = await call('POST', `/api/admin/users/${target.id}/disable`, { session: adminSession })
    expect(res).toMatchObject({ status: 200, body: { data: { ok: true, sessionsRevoked: 1, apiKeysRevoked: 1 } } })

    expect((await call('GET', '/api/ping', { session })).status).toBe(401)
    expect((await call('GET', '/api/ping', { apiKey: key })).status).toBe(401)
    // A session issued after the disable is still refused.
    expect(await call('GET', '/api/ping', { session: await issueSession(target.id) }))
      .toMatchObject({ status: 401, body: { error: 'errors.auth.account_disabled' } })
    expect(await call('POST', '/auth/login', { body: { email: target.email, password: 'Correct-Horse-9!' } }))
      .toMatchObject({ status: 403, body: { error: 'errors.auth.account_disabled' } })

    expect((await call('POST', `/api/admin/users/${target.id}/enable`, { session: adminSession })).status).toBe(200)
    expect((await call('GET', '/api/ping', { session: await issueSession(target.id) })).status).toBe(200)
    // Revoked keys stay revoked.
    expect((await call('GET', '/api/ping', { apiKey: key })).status).toBe(401)
    expect((await call('POST', '/auth/login', { body: { email: target.email, password: 'Correct-Horse-9!' } })).status).toBe(200)
  })

  it('is App Admin only, and refuses yourself and the default admin', async () => {
    const admin = await makeUser({ isAppAdmin: true })
    const adminSession = await issueSession(admin.id)
    const defaultAdmin = await makeUser({ isAppAdmin: true, isDefaultAdmin: true })
    const plain = await makeUser()
    const other = await makeUser()
    expect((await call('POST', `/api/admin/users/${other.id}/disable`, { session: await issueSession(plain.id) })).status).toBe(403)
    expect(await call('POST', `/api/admin/users/${admin.id}/disable`, { session: adminSession }))
      .toMatchObject({ status: 400, body: { error: 'errors.users.cannot_disable_self' } })
    expect(await call('POST', `/api/admin/users/${defaultAdmin.id}/disable`, { session: adminSession }))
      .toMatchObject({ status: 400, body: { error: 'errors.users.cannot_disable_default_admin' } })
    expect((await call('POST', `/api/admin/users/${crypto.randomUUID()}/disable`, { session: adminSession })).status).toBe(404)
  })
})

describe('API keys', () => {
  it('respect a pending forced password change', async () => {
    const u = await makeUser()
    const key = await makeApiKey(u.id)
    await testDb.update(schema.users).set({ mustChangePassword: true }).where((await import('drizzle-orm')).eq(schema.users.id, u.id))
    expect(await call('GET', '/api/ping', { apiKey: key })).toMatchObject({ status: 428, body: { error: 'errors.must_change_password' } })
  })
})
