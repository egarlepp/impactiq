// Security audit L9 (v1.425.0): before DATABASE_URL is set, every setup route
// but /status needs the one-time setup token from the server log (or
// SETUP_TOKEN), so nobody else can run the wizard or use its database test to
// probe internal hosts.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  return { ...actual, isDbConfigured: () => false }
})

let setup: typeof import('./setup.js')
let app: express.Express

beforeAll(async () => {
  setup = await import('./setup.js')
  app = express()
  app.use(express.json())
  app.use('/api/setup', setup.setupRouter)
})

afterEach(() => {
  delete process.env['SETUP_TOKEN']
})

async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; error: string | null }> {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token !== undefined) headers['x-setup-token'] = token
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
    return { status: res.status, error: ((await res.json()) as { error: string | null }).error }
  } finally {
    server.close()
  }
}

describe('setup token', () => {
  it('leaves /status open and refuses everything else without the token', async () => {
    expect((await call('GET', '/api/setup/status')).status).toBe(200)
    for (const [method, path] of [['POST', '/api/setup/verify-token'], ['GET', '/api/setup/generate-key'], ['POST', '/api/setup/test-db'], ['POST', '/api/setup/create-admin']] as const) {
      expect(await call(method, path)).toEqual({ status: 401, error: 'errors.setup.token_invalid' })
      expect(await call(method, path, 'wrong-token')).toEqual({ status: 401, error: 'errors.setup.token_invalid' })
    }
  })

  it('accepts the generated token, which stays the same for the process', async () => {
    const { token, fromEnv } = setup.getOrCreateSetupToken()
    expect(fromEnv).toBe(false)
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(setup.getOrCreateSetupToken().token).toBe(token)
    expect((await call('POST', '/api/setup/verify-token', token)).status).toBe(200)
    expect((await call('GET', '/api/setup/generate-key', ` ${token} `)).status).toBe(200)
  })

  it('uses SETUP_TOKEN when it is long enough', async () => {
    process.env['SETUP_TOKEN'] = 'short'
    expect(setup.getOrCreateSetupToken().fromEnv).toBe(false)
    process.env['SETUP_TOKEN'] = 'a-long-operator-chosen-token'
    expect(setup.getOrCreateSetupToken()).toEqual({ token: 'a-long-operator-chosen-token', fromEnv: true })
    expect((await call('POST', '/api/setup/verify-token', 'a-long-operator-chosen-token')).status).toBe(200)
  })
})
