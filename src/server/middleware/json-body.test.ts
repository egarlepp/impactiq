import { describe, it, expect } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { defaultJsonBody } from './json-body.js'

// Mirrors index.ts + admin.ts: app-wide default parser, then an admin router
// with its own 8 MB parser. Regression for theme logos failing with HTTP 413.
async function post(path: string, bytes: number): Promise<number> {
  const app = express()
  app.use(defaultJsonBody())
  const admin = express.Router()
  admin.use(express.json({ limit: '8mb' }))
  admin.patch('/themes/x', (req, res) => { res.json({ size: JSON.stringify(req.body).length }) })
  app.use('/api/admin', admin)
  app.patch('/api/other', (req, res) => { res.json({ ok: !!req.body }) })
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const body = JSON.stringify({ logoLight: 'data:image/png;base64,' + 'A'.repeat(bytes) })
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body,
    })
    return res.status
  } finally {
    server.close()
  }
}

describe('defaultJsonBody', () => {
  it('lets /api/admin use its own larger limit (a 2 MB logo base64s to ~2.7 MB)', async () => {
    expect(await post('/api/admin/themes/x', 2_800_000)).toBe(200)
  })
  it('still rejects oversized bodies everywhere else', async () => {
    expect(await post('/api/other', 300_000)).toBe(413)
  })
  it('still parses small bodies everywhere else', async () => {
    expect(await post('/api/other', 1_000)).toBe(200)
  })
})
