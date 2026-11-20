// Password login and MFA on /auth: wrong credentials, SSO-only accounts,
// no session before MFA, TOTP enrollment, TOTP and backup-code verify, and
// the backup-code lockout. Runs the real routes against pglite.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let authRouter: typeof import('./auth.js')['authRouter']
let hashPassword: typeof import('../services/auth/password.js')['hashPassword']
let base32Decode: typeof import('../services/auth/totp.js')['base32Decode']
let encryptToken: typeof import('../services/config/crypto.js')['encryptToken']
let generateBackupCodes: typeof import('../services/auth/backupCodes.js')['generateBackupCodes']

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  authRouter = (await import('./auth.js')).authRouter
  hashPassword = (await import('../services/auth/password.js')).hashPassword
  base32Decode = (await import('../services/auth/totp.js')).base32Decode
  encryptToken = (await import('../services/config/crypto.js')).encryptToken
  generateBackupCodes = (await import('../services/auth/backupCodes.js')).generateBackupCodes
})

// RFC 6238 TOTP, written out here so the test checks the server against an
// independent copy of the algorithm rather than against itself.
function totpNow(secretBase32: string): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)))
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const bin = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!
  return (bin % 1_000_000).toString().padStart(6, '0')
}

// A code that is never valid right now: shift the real one by a fixed amount.
function wrongCode(secretBase32: string): string {
  return ((Number(totpNow(secretBase32)) + 500_000) % 1_000_000).toString().padStart(6, '0')
}

const PASSWORD = 'Correct-Horse-9-Battery'
// Every test uses its own forwarded IP so the per-IP login limiter (10 per
// 15 minutes) never trips across the suite.
let ipCounter = 1

async function makeUser(overrides: Partial<typeof import('../../../drizzle/schema.js')['users']['$inferInsert']> = {}): Promise<{ id: string; email: string }> {
  const email = `${crypto.randomUUID()}@example.com`
  const [u] = await testDb.insert(schema.users).values({
    oktaId: `local-${crypto.randomUUID()}`,
    email,
    displayName: 'Pat',
    passwordHash: hashPassword(PASSWORD),
    authMethod: 'password',
    ...overrides,
  }).returning()
  return { id: u!.id, email }
}

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> | null; error: string | null; setCookie: string | null }> {
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use('/auth', authRouter)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` },
      body: JSON.stringify(body),
    })
    const json = await res.json() as { data: Record<string, unknown> | null; error: string | null }
    return { status: res.status, data: json.data, error: json.error, setCookie: res.headers.get('set-cookie') }
  } finally {
    server.close()
  }
}

function nextIp(): void { ipCounter++ }

describe('POST /auth/login', () => {
  it('gives the same answer for an unknown email and a wrong password', async () => {
    nextIp()
    const u = await makeUser()
    const unknown = await post('/login', { email: `nobody-${crypto.randomUUID()}@example.com`, password: PASSWORD })
    const wrong = await post('/login', { email: u.email, password: 'not-it' })
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(unknown.error).toBe('errors.invalid_credentials')
    expect(wrong.error).toBe('errors.invalid_credentials')
    expect(wrong.setCookie).toBeNull()
  })

  it('refuses a password login on an SSO-only account even with the right password', async () => {
    nextIp()
    const okta = await makeUser({ authMethod: 'okta' })
    const azure = await makeUser({ authMethod: 'azure' })
    for (const u of [okta, azure]) {
      const res = await post('/login', { email: u.email, password: PASSWORD })
      expect(res.status).toBe(403)
      expect(res.error).toBe('errors.okta_only_account')
    }
  })

  it('a correct password never sets a session: it asks for MFA enrollment first', async () => {
    nextIp()
    const u = await makeUser()
    const res = await post('/login', { email: u.email, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.data?.['needsMfa']).toBe(true)
    expect(res.data?.['mfaIntent']).toBe('enroll')
    expect(typeof res.data?.['mfaToken']).toBe('string')
    expect(res.setCookie).toBeNull()
  })

  it('allows password login on an "All Login Options" account', async () => {
    nextIp()
    const u = await makeUser({ authMethod: 'both' })
    const res = await post('/login', { email: u.email, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.data?.['needsMfa']).toBe(true)
  })
})

describe('MFA enrollment', () => {
  it('stores the secret and sets a session only after a valid first code', async () => {
    nextIp()
    const u = await makeUser()
    const login = await post('/login', { email: u.email, password: PASSWORD })
    const mfaToken = login.data!['mfaToken'] as string

    const enroll = await post('/mfa/enroll', { mfaToken })
    expect(enroll.status).toBe(200)
    const secret = enroll.data!['secret'] as string

    const bad = await post('/mfa/verify-enrollment', { mfaToken, secret, code: wrongCode(secret) })
    expect(bad.status).toBe(401)
    expect(bad.setCookie).toBeNull()
    const [before] = await testDb.select().from(schema.users).where(eq(schema.users.id, u.id))
    expect(before!.totpEnrolledAt).toBeNull()

    const good = await post('/mfa/verify-enrollment', { mfaToken, secret, code: totpNow(secret) })
    expect(good.status).toBe(200)
    expect(Array.isArray(good.data!['backupCodes'])).toBe(true)
    expect((good.data!['backupCodes'] as string[]).length).toBeGreaterThan(0)
    expect(good.setCookie).toContain('impactiq_session=')
    const [after] = await testDb.select().from(schema.users).where(eq(schema.users.id, u.id))
    expect(after!.totpEnrolledAt).not.toBeNull()
    // Stored encrypted, never as the plain secret.
    expect(after!.totpSecretEncrypted).toBeTruthy()
    expect(after!.totpSecretEncrypted).not.toContain(secret)
  })

  it('rejects a forged or wrong-purpose challenge token', async () => {
    nextIp()
    expect((await post('/mfa/enroll', { mfaToken: 'forged.token' })).status).toBe(401)
  })
})

describe('MFA verify', () => {
  async function enrolledUser(): Promise<{ email: string; id: string; secret: string; backupCodes: string[] }> {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    const { plain, hashes } = generateBackupCodes()
    const u = await makeUser({ totpSecretEncrypted: encryptToken(secret), totpEnrolledAt: new Date(), mfaBackupCodesHash: hashes })
    return { ...u, secret, backupCodes: plain }
  }

  async function verifyToken(email: string): Promise<string> {
    const login = await post('/login', { email, password: PASSWORD })
    expect(login.data?.['mfaIntent']).toBe('verify')
    return login.data!['mfaToken'] as string
  }

  it('accepts the current TOTP code and rejects a wrong one', async () => {
    nextIp()
    const u = await enrolledUser()
    const mfaToken = await verifyToken(u.email)
    const bad = await post('/mfa/verify', { mfaToken, code: wrongCode(u.secret) })
    expect(bad.status).toBe(401)
    expect(bad.setCookie).toBeNull()
    const good = await post('/mfa/verify', { mfaToken, code: totpNow(u.secret) })
    expect(good.status).toBe(200)
    expect(good.data?.['mfaMethod']).toBe('totp')
    expect(good.setCookie).toContain('impactiq_session=')
  })

  it('an enrollment token cannot be used to verify', async () => {
    nextIp()
    const fresh = await makeUser()
    const login = await post('/login', { email: fresh.email, password: PASSWORD })
    const res = await post('/mfa/verify', { mfaToken: login.data!['mfaToken'], code: '123456' })
    expect(res.status).toBe(401)
    expect(res.error).toBe('errors.mfa.challenge_invalid')
  })

  it('a backup code works once', async () => {
    nextIp()
    const u = await enrolledUser()
    const mfaToken = await verifyToken(u.email)
    const code = u.backupCodes[0]!
    const first = await post('/mfa/verify', { mfaToken, code })
    expect(first.status).toBe(200)
    expect(first.data?.['mfaMethod']).toBe('backup_code')
    expect(first.data?.['backupCodesRemaining']).toBe(u.backupCodes.length - 1)
    const reuse = await post('/mfa/verify', { mfaToken, code })
    expect(reuse.status).toBe(401)
  })

  it('locks the account once every backup code is used, even for a valid TOTP code', async () => {
    nextIp()
    const u = await enrolledUser()
    await testDb.update(schema.users).set({ mfaBackupCodesHash: [] }).where(eq(schema.users.id, u.id))
    const mfaToken = await verifyToken(u.email)
    const res = await post('/mfa/verify', { mfaToken, code: totpNow(u.secret) })
    expect(res.status).toBe(423)
    expect(res.error).toBe('errors.mfa.backup_codes_depleted')
    expect(res.setCookie).toBeNull()
  })
})
