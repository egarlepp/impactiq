// Security audit fixes (v1.423.0): the Salesforce and Microsoft connect
// callbacks only accept a callback that comes back to the browser that
// started the flow (encrypted binding cookie, same nonce as the signed
// state), signed in as the same user. And the old HMAC session cookie format
// is no longer accepted. Runs the real routes against pglite; only the token
// exchange with Salesforce/Microsoft is stubbed.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { createHmac } from 'node:crypto'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

// The exchange is the first thing after the binding check, so reaching it
// (and failing with this message) proves the check passed.
const EXCHANGE_REACHED = 'exchange-reached'
vi.mock('../../services/auth/salesforce.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/auth/salesforce.js')>('../../services/auth/salesforce.js')
  return { ...actual, exchangeAuthorizationCode: async () => { throw new Error(EXCHANGE_REACHED) } }
})
vi.mock('../../services/auth/microsoft.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/auth/microsoft.js')>('../../services/auth/microsoft.js')
  return {
    ...actual,
    isMicrosoftConfigured: () => true,
    getMicrosoftAuthUrl: (state: string) => `https://login.example.test/authorize?state=${encodeURIComponent(state)}`,
    exchangeAuthorizationCode: async () => { throw new Error(EXCHANGE_REACHED) },
  }
})

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let app: express.Express
let issueSession: typeof import('../../services/auth/session.js')['issueSession']
let verifySession: typeof import('../../services/auth/session.js')['verifySession']
let signSfState: typeof import('../../services/auth/salesforce.js')['signOAuthState']
let signMsState: typeof import('../../services/auth/microsoft.js')['signOAuthState']
let encryptToken: typeof import('../../services/config/crypto.js')['encryptToken']
let SF_PREFIX = ''
let MS_PREFIX = ''

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  const session = await import('../../services/auth/session.js')
  issueSession = session.issueSession
  verifySession = session.verifySession
  signSfState = (await import('../../services/auth/salesforce.js')).signOAuthState
  signMsState = (await import('../../services/auth/microsoft.js')).signOAuthState
  encryptToken = (await import('../../services/config/crypto.js')).encryptToken
  const binding = await import('./oauthBinding.js')
  SF_PREFIX = binding.SF_BINDING_COOKIE_PREFIX
  MS_PREFIX = binding.MS_BINDING_COOKIE_PREFIX
  const { salesforceAuthRoutes } = await import('./salesforce.js')
  const { microsoftAuthRoutes } = await import('./microsoft.js')
  app = express()
  app.use('/auth', salesforceAuthRoutes)
  app.use('/auth', microsoftAuthRoutes)
})

async function makeUser(): Promise<string> {
  const [u] = await testDb.insert(schema.users).values({
    oktaId: `local-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Pat',
  }).returning()
  return u!.id
}

function bindingCookie(prefix: string, state: string, payload: Record<string, string>): string {
  return `${prefix}${state.slice(-24)}=${encodeURIComponent(encryptToken(JSON.stringify(payload)))}`
}

async function get(path: string, cookies: string[]): Promise<{ status: number; location: string | null; setCookie: string[] }> {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'manual',
      headers: cookies.length ? { cookie: cookies.join('; ') } : {},
    })
    return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.getSetCookie() }
  } finally {
    server.close()
  }
}

function reasonOf(location: string | null): string | null {
  if (!location) return null
  return new URL(location, 'http://x').searchParams.get('reason')
}

describe('Salesforce connect callback', () => {
  it('reaches the token exchange with the right cookie and session', async () => {
    const userId = await makeUser()
    const session = `impactiq_session=${await issueSession(userId)}`
    const state = signSfState(userId, 'nonce-a')
    const res = await get(`/auth/salesforce/callback?code=c&state=${encodeURIComponent(state)}`, [
      session,
      bindingCookie(SF_PREFIX, state, { nonce: 'nonce-a', userId, verifier: 'v' }),
    ])
    expect(res.status).toBe(302)
    expect(reasonOf(res.location)).toBe(EXCHANGE_REACHED)
  })

  it('refuses a callback without the binding cookie (link opened in another browser)', async () => {
    const userId = await makeUser()
    const session = `impactiq_session=${await issueSession(userId)}`
    const state = signSfState(userId, 'nonce-b')
    const res = await get(`/auth/salesforce/callback?code=c&state=${encodeURIComponent(state)}`, [session])
    expect(reasonOf(res.location)).toBe('errors.oauth.session_mismatch')
  })

  it('refuses a callback when the browser is signed in as someone else', async () => {
    const attacker = await makeUser()
    const victim = await makeUser()
    const victimSession = `impactiq_session=${await issueSession(victim)}`
    const state = signSfState(attacker, 'nonce-c')
    const res = await get(`/auth/salesforce/callback?code=c&state=${encodeURIComponent(state)}`, [
      victimSession,
      bindingCookie(SF_PREFIX, state, { nonce: 'nonce-c', userId: attacker, verifier: 'v' }),
    ])
    expect(reasonOf(res.location)).toBe('errors.oauth.session_mismatch')
  })

  it('refuses a cookie whose nonce does not match the state', async () => {
    const userId = await makeUser()
    const session = `impactiq_session=${await issueSession(userId)}`
    const state = signSfState(userId, 'nonce-d')
    const res = await get(`/auth/salesforce/callback?code=c&state=${encodeURIComponent(state)}`, [
      session,
      bindingCookie(SF_PREFIX, state, { nonce: 'other', userId, verifier: 'v' }),
    ])
    expect(reasonOf(res.location)).toBe('errors.oauth.session_mismatch')
  })

  it('accepts the admin flow for the signed-in admin', async () => {
    const adminId = await makeUser()
    const session = `impactiq_session=${await issueSession(adminId)}`
    const state = signSfState(`admin:${adminId}`, 'nonce-e')
    const res = await get(`/auth/salesforce/callback?code=c&state=${encodeURIComponent(state)}`, [
      session,
      bindingCookie(SF_PREFIX, state, { nonce: 'nonce-e', userId: adminId, verifier: 'v' }),
    ])
    expect(res.location).toContain('/admin?sfAdminConnect=error')
    expect(reasonOf(res.location)).toBe(EXCHANGE_REACHED)
  })
})

describe('Microsoft connect', () => {
  it('sets a binding cookie when the flow starts, and the callback accepts it', async () => {
    const userId = await makeUser()
    const session = `impactiq_session=${await issueSession(userId)}`
    const start = await get('/auth/microsoft?interactive=1', [session])
    expect(start.status).toBe(302)
    const state = new URL(start.location!).searchParams.get('state')!
    const binding = start.setCookie.find((c) => c.startsWith(MS_PREFIX))
    expect(binding).toBeDefined()
    expect(binding).toContain('HttpOnly')
    const cookiePair = binding!.split(';')[0]!

    const cb = await get(`/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`, [session, cookiePair])
    expect(reasonOf(cb.location)).toBe(EXCHANGE_REACHED)
    // The binding cookie is single-use.
    expect(cb.setCookie.some((c) => c.startsWith(cookiePair.split('=')[0]! + '=;') && c.includes('Max-Age=0'))).toBe(true)
  })

  it('refuses a callback opened in a browser signed in as someone else', async () => {
    const attacker = await makeUser()
    const victim = await makeUser()
    const state = signMsState(attacker, 'nonce-f')
    const res = await get(`/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`, [
      `impactiq_session=${await issueSession(victim)}`,
      bindingCookie(MS_PREFIX, state, { nonce: 'nonce-f', userId: attacker }),
    ])
    expect(reasonOf(res.location)).toBe('errors.oauth.session_mismatch')
  })

  it('refuses a callback with no session at all', async () => {
    const userId = await makeUser()
    const state = signMsState(userId, 'nonce-g')
    const res = await get(`/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`, [
      bindingCookie(MS_PREFIX, state, { nonce: 'nonce-g', userId }),
    ])
    expect(reasonOf(res.location)).toBe('errors.oauth.session_mismatch')
  })
})

describe('session cookies', () => {
  it('no longer accepts the old HMAC-signed cookie format', async () => {
    const userId = await makeUser()
    const expires = String(Date.now() + 60 * 60 * 1000)
    const secret = process.env['SESSION_SECRET'] ?? process.env['TOKEN_ENCRYPTION_KEY'] ?? ''
    const sig = createHmac('sha256', secret).update(`${userId}.${expires}`).digest('hex')
    expect(await verifySession(`${userId}.${expires}.${sig}`)).toBeNull()
  })

  it('still accepts a current session', async () => {
    const userId = await makeUser()
    const raw = await issueSession(userId)
    expect((await verifySession(raw))?.userId).toBe(userId)
  })
})
