// POST /api/webhooks/criteriaiq (v1.450.0): CriteriaIQ's signed live refresh
// webhook. Real route against pglite; the single-project refresh is mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const refresh = vi.fn(async (_id: number): Promise<'updated' | 'not_found' | null> => 'updated')
vi.mock('../services/criteriaiq/primaryProjects.js', () => ({ refreshCriteriaIqProject: (id: number) => refresh(id) }))

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let config: typeof import('../services/criteriaiq/config.js')
let base = ''
const SECRET = 'ciqwh_route-test-secret'

function signed(body: string, t = Math.floor(Date.now() / 1000), secret = SECRET): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-CriteriaIQ-Signature-V2': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`,
  }
}

async function post(body: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/webhooks/criteriaiq`, { method: 'POST', headers, body })
  return { status: res.status, json: await res.json() as { data: Record<string, unknown> | null; error: string | null; meta: Record<string, unknown> } }
}

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  config = await import('../services/criteriaiq/config.js')
  const { CRITERIAIQ_WEBHOOK_PATH, criteriaIqWebhookRouter } = await import('./criteriaiqWebhook.js')
  const app = express()
  app.use(CRITERIAIQ_WEBHOOK_PATH, criteriaIqWebhookRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(async () => {
  await testDb.delete(schema.systemSettings)
  await testDb.delete(schema.criteriaiqWebhookReceipts)
  refresh.mockClear()
})

async function turnOn() {
  await config.setCriteriaIqConfig({ baseUrl: 'https://ciq.example.com', apiKey: 'ciq-api-key-0000000000', allowPrivateNetwork: false })
  await config.setCriteriaIqWebhookSecret(SECRET)
}

describe('POST /api/webhooks/criteriaiq', () => {
  const body = JSON.stringify({ event: 'project.updated', projectId: 42 })

  it('answers 404 while live refresh is off', async () => {
    expect((await post(body, signed(body))).status).toBe(404)
    await config.setCriteriaIqConfig({ baseUrl: 'https://ciq.example.com', apiKey: 'ciq-api-key-0000000000', allowPrivateNetwork: false })
    expect((await post(body, signed(body))).status).toBe(404)
  })

  it('accepts a signed delivery, moves the cache epoch and refreshes that project', async () => {
    await turnOn()
    const before = (await config.getCriteriaIqConfig())!.cacheEpoch
    const r = await post(body, signed(body))
    expect(r.status).toBe(202)
    expect(r.json.data).toEqual({ accepted: true, duplicate: false })
    expect((await config.getCriteriaIqConfig())!.cacheEpoch).toBeGreaterThan(before)
    expect((await config.getCriteriaIqConfigSummary()).liveRefresh).toMatchObject({ enabled: true, secretHint: SECRET.slice(-4) })
    expect((await config.getCriteriaIqConfigSummary()).liveRefresh.lastWebhookAt).not.toBeNull()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith(42))
  })

  it('refuses a replay of an accepted delivery without refreshing again', async () => {
    await turnOn()
    const headers = signed(body)
    expect((await post(body, headers)).status).toBe(202)
    const again = await post(body, headers)
    expect(again.status).toBe(200)
    expect(again.json.data).toEqual({ accepted: false, duplicate: true })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('refuses a stale, unsigned, wrong-secret or rotated-away delivery', async () => {
    await turnOn()
    expect((await post(body, signed(body, Math.floor(Date.now() / 1000) - 3600))).json.meta).toEqual({ reason: 'stale' })
    expect((await post(body, { 'Content-Type': 'application/json' })).status).toBe(401)
    expect((await post(body, signed(body, undefined, 'wrong'))).status).toBe(401)
    const old = signed(body)
    await config.setCriteriaIqWebhookSecret('ciqwh_rotated-secret')
    expect((await post(body, old)).status).toBe(401)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps the live refresh secret when the connection is saved again', async () => {
    await turnOn()
    await config.setCriteriaIqConfig({ baseUrl: 'https://ciq2.example.com', apiKey: null, allowPrivateNetwork: false })
    expect(await config.getCriteriaIqWebhookSecret()).toBe(SECRET)
  })
})
