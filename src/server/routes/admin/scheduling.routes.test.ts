// Admin → Scheduling's Recent runs (v1.441.0): paged, and Clear deletes every
// job run (v1.443.0), including runs of jobs the page doesn't list.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../../middleware/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/rbac.js')>('../../middleware/rbac.js')
  const pass = (_req: unknown, _res: unknown, next: () => void) => next()
  return { ...actual, requireAppAdmin: pass }
})

interface Payload { recent: Array<{ jobKey: string }>; recentTotal: number; recentPage: number; failedRuns7d: number }

let app: express.Express
beforeAll(async () => {
  const { db } = await import('../../db/index.js')
  const { jobRuns } = await import('../../../../drizzle/schema.js')
  const now = Date.now()
  await db.insert(jobRuns).values(Array.from({ length: 25 }, (_, i) => ({
    jobKey: 'sync_audit_cull',
    startedAt: new Date(now - (i + 1) * 60_000),
    status: i === 0 ? 'error' : 'ok',
  })))
  // A run of a HubSpot job, not listed while Salesforce is the CRM.
  await db.insert(jobRuns).values({ jobKey: 'hubspot_owner_sync', startedAt: new Date(now), status: 'ok' })
  const { schedulingRoutes } = await import('./scheduling.js')
  app = express()
  app.use(express.json())
  app.use('/api/admin', schedulingRoutes)
})

async function call(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: { data: unknown } }> {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/admin${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : null })
    return { status: res.status, body: await res.json() as { data: unknown } }
  } finally {
    server.close()
  }
}

describe('GET /scheduling recent runs', () => {
  it('pages 20 at a time with the total', async () => {
    const first = (await call('GET', '/scheduling')).body.data as Payload
    expect(first.recent).toHaveLength(20)
    expect(first.recentTotal).toBe(25)
    const second = (await call('GET', '/scheduling?recentPage=2')).body.data as Payload
    expect(second.recentPage).toBe(2)
    expect(second.recent).toHaveLength(5)
  })

  it('Clear deletes every job run', async () => {
    const before = (await call('GET', '/scheduling')).body.data as Payload
    expect(before.failedRuns7d).toBe(1)
    const cleared = await call('POST', '/scheduling/recent-runs/clear')
    expect(cleared.status).toBe(200)
    expect(cleared.body.data).toEqual({ deleted: 26 })
    const after = (await call('GET', '/scheduling')).body.data as Payload
    expect(after.recent).toHaveLength(0)
    expect(after.recentTotal).toBe(0)
    expect(after.failedRuns7d).toBe(0)
    const { db } = await import('../../db/index.js')
    const { jobRuns } = await import('../../../../drizzle/schema.js')
    expect(await db.select().from(jobRuns)).toHaveLength(0)
  })
})
