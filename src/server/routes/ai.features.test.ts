// GET /api/ai/features: which AI features can run right now, so My Notes
// hides AI Organize and Ask My Notes when an App Admin turned them off.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { AI_FEATURES, type AiFeature } from '../../shared/ai.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js')
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { user: { id: string } }).user = { id: crypto.randomUUID() }
      next()
    },
  }
})

const off = new Set<AiFeature>(['note_organize', 'notes_chat'])
const runAi = vi.fn()
vi.mock('../services/ai/gateway.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai/gateway.js')>('../services/ai/gateway.js')
  return {
    ...actual,
    aiAvailability: async (f: AiFeature) => off.has(f) ? { ok: false, reason: 'disabled' } : { ok: true, provider: { id: 'p' } },
    runAi: (...args: unknown[]) => runAi(...args),
  }
})

let base = ''
beforeAll(async () => {
  const { aiRouter } = await import('./ai.js')
  const app = express()
  app.use(express.json())
  app.use('/api/ai', aiRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

describe('GET /api/ai/features', () => {
  it('answers each feature\'s availability without calling a provider', async () => {
    const res = await fetch(`${base}/api/ai/features`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Record<AiFeature, boolean> }
    expect(Object.keys(body.data).sort()).toEqual([...AI_FEATURES].sort())
    expect(body.data.note_organize).toBe(false)
    expect(body.data.notes_chat).toBe(false)
    expect(body.data.activity_classify).toBe(true)
    expect(runAi).not.toHaveBeenCalled()
  })
})
