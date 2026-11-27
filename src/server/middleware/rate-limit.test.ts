import { describe, it, expect } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { rateLimit, rateLimitDynamic } from './rate-limit.js'

async function withApp(
  limiter: express.RequestHandler,
  run: (get: (path?: string) => Promise<Response>) => Promise<void>,
): Promise<void> {
  const app = express()
  app.use(limiter)
  app.get('/{*any}', (_req, res) => { res.json({ data: { ok: true }, error: null, meta: {} }) })
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    await run((path = '/x') => fetch(`http://127.0.0.1:${port}${path}`))
  } finally {
    server.close()
  }
}

describe('rateLimit', () => {
  it('allows max requests per window, then answers 429 with Retry-After and the app envelope', async () => {
    await withApp(rateLimit({ windowMs: 60_000, max: 2 }), async (get) => {
      expect((await get()).status).toBe(200)
      expect((await get()).status).toBe(200)
      const blocked = await get()
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
      const body = await blocked.json() as { data: unknown; error: string; meta: { retryAfter: number } }
      expect(body.data).toBeNull()
      expect(body.error).toBe('errors.rate_limited')
      expect(body.meta.retryAfter).toBeGreaterThan(0)
      expect(blocked.headers.get('ratelimit-limit')).toBeNull()
      expect(blocked.headers.get('x-ratelimit-limit')).toBeNull()
    })
  })

  it('counts each key separately', async () => {
    let n = 0
    await withApp(rateLimit({ windowMs: 60_000, max: 1, keyFn: () => `k${n++}` }), async (get) => {
      expect((await get()).status).toBe(200)
      expect((await get()).status).toBe(200)
    })
  })

  it('starts a new window once the old one ends', async () => {
    await withApp(rateLimit({ windowMs: 50, max: 1 }), async (get) => {
      expect((await get()).status).toBe(200)
      expect((await get()).status).toBe(429)
      await new Promise((r) => setTimeout(r, 80))
      expect((await get()).status).toBe(200)
    })
  })
})

describe('rateLimitDynamic', () => {
  it('reads the settings on every request', async () => {
    const settings = { enabled: true, windowMs: 60_000, max: 1 }
    await withApp(rateLimitDynamic(() => settings), async (get) => {
      expect((await get()).status).toBe(200)
      expect((await get()).status).toBe(429)
      settings.max = 5
      expect((await get()).status).toBe(200)
      settings.enabled = false
      settings.max = 1
      expect((await get()).status).toBe(200)
    })
  })

  it('treats a max of 0 as off', async () => {
    await withApp(rateLimitDynamic(() => ({ enabled: true, windowMs: 60_000, max: 0 })), async (get) => {
      expect((await get()).status).toBe(200)
      expect((await get()).status).toBe(200)
    })
  })

  it('lets the skip predicate bypass the limit', async () => {
    const limiter = rateLimitDynamic(
      () => ({ enabled: true, windowMs: 60_000, max: 1 }),
      undefined,
      (req) => req.path.startsWith('/static'),
    )
    await withApp(limiter, async (get) => {
      expect((await get('/static/a.js')).status).toBe(200)
      expect((await get('/static/b.js')).status).toBe(200)
      expect((await get('/api/x')).status).toBe(200)
      expect((await get('/api/x')).status).toBe(429)
    })
  })
})
