// Security audit M5 (v1.424.0): the client IP Express works out (and the
// per-IP limits key on) only trusts as many X-Forwarded-For hops as the
// admin says sit in front of the app, and TRUSTED_PROXY_HOPS overrides it.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let cfg: typeof import('./rate-limit-config.js')
let app: express.Express

beforeAll(async () => {
  cfg = await import('./rate-limit-config.js')
  app = express()
  app.set('trust proxy', cfg.trustProxyHops)
  app.get('/ip', (req, res) => { res.json({ ip: req.ip }) })
})

afterEach(() => {
  delete process.env['TRUSTED_PROXY_HOPS']
})

async function ipFor(forwardedFor: string | null): Promise<string> {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} })
    return ((await res.json()) as { ip: string }).ip
  } finally {
    server.close()
  }
}

async function setHops(n: number): Promise<void> {
  await cfg.saveRateLimitSettings({ ...cfg.getRateLimitSettings(), trustedProxyHops: n })
}

describe('trusted proxy hops', () => {
  it('defaults to 0 and ignores X-Forwarded-For', async () => {
    expect(cfg.getRateLimitSettings().trustedProxyHops).toBe(0)
    const ip = await ipFor('203.0.113.9')
    expect(ip).not.toBe('203.0.113.9')
    expect(ip).toMatch(/127\.0\.0\.1/)
  })

  it('with 1 proxy, takes the address the proxy added, not one the client sent', async () => {
    await setHops(1)
    // The client sent "6.6.6.6"; the proxy appended the real address.
    expect(await ipFor('6.6.6.6, 198.51.100.7')).toBe('198.51.100.7')
  })

  it('with 2 proxies, skips both', async () => {
    await setHops(2)
    // Chain: spoofed, real client, first proxy; the socket is the second proxy.
    expect(await ipFor('6.6.6.6, 198.51.100.7, 10.0.0.5')).toBe('198.51.100.7')
  })

  it('applies a saved change without a restart, and clamps out-of-range values', async () => {
    await setHops(1)
    expect(await ipFor('6.6.6.6, 198.51.100.7')).toBe('198.51.100.7')
    await setHops(0)
    expect(await ipFor('6.6.6.6, 198.51.100.7')).toMatch(/127\.0\.0\.1/)
    await setHops(99)
    expect(cfg.getRateLimitSettings().trustedProxyHops).toBe(cfg.MAX_TRUSTED_PROXY_HOPS)
  })

  it('TRUSTED_PROXY_HOPS overrides the saved setting; a bad value is ignored', async () => {
    await setHops(0)
    process.env['TRUSTED_PROXY_HOPS'] = '1'
    expect(cfg.getTrustedProxyHops()).toBe(1)
    expect(await ipFor('6.6.6.6, 198.51.100.7')).toBe('198.51.100.7')
    process.env['TRUSTED_PROXY_HOPS'] = 'lots'
    expect(cfg.getTrustedProxyHops()).toBe(0)
  })
})
