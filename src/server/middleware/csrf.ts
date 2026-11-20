import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

const CSRF_COOKIE = 'impactiq_csrf'
const CSRF_HEADER = 'x-csrf-token'

function readCsrfCookie(req: Request): string | null {
  const header = req.headers['cookie']
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${CSRF_COOKIE}=`)) return decodeURIComponent(trimmed.slice(CSRF_COOKIE.length + 1))
  }
  return null
}

// Middleware: on any request without the CSRF cookie, mint one (readable by
// JS so the client can copy it into the X-CSRF-Token header). On mutating
// requests, require the header to match the cookie via timing-safe compare.
// GET/HEAD/OPTIONS and the /auth login endpoints (which have no session yet)
// are exempt — login gets its own bootstrap via the cookie set here.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function csrf(req: Request, res: Response, next: NextFunction): void {
  let token = readCsrfCookie(req)
  if (!token) {
    token = randomBytes(24).toString('hex')
    const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : ''
    res.setHeader('Set-Cookie', `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; Max-Age=86400${secure}`)
  }
  if (SAFE_METHODS.has(req.method)) { next(); return }
  // Public routes that MUST accept POST without a prior GET are exempt by
  // path prefix. Login/setup are pre-session flows; the server has no way
  // to bind CSRF state to a non-existent session there.
  if (
    req.path.startsWith('/api/setup') ||
    req.path === '/auth/login' ||
    req.path === '/auth/mfa/enroll' ||
    req.path === '/auth/mfa/verify-enrollment' ||
    req.path === '/auth/mfa/verify' ||
    req.path === '/auth/okta/callback' ||
    req.path === '/auth/salesforce/callback' ||
    req.path === '/auth/microsoft/callback' ||
    // Server-to-server, authenticated by CriteriaIQ's signature (v1.450.0).
    req.path === '/api/webhooks/criteriaiq' ||
    // Server-to-server, authenticated by Gong's signed token (v1.456.0).
    req.path === '/api/webhooks/gong' ||
    // Read-only POST for effort:read Bearer keys only (v1.454.0, routes/effortApi.ts);
    // it never reads a session cookie, so there is no session to forge.
    req.path === '/api/v1/effort/project-counts' ||
    req.path === '/api/v1/effort/project-activities'
  ) {
    next(); return
  }
  const headerToken = req.headers[CSRF_HEADER]
  if (typeof headerToken !== 'string' || headerToken.length === 0) {
    res.status(403).json({ data: null, error: 'errors.csrf_missing', meta: {} })
    return
  }
  const a = Buffer.from(token)
  const b = Buffer.from(headerToken)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ data: null, error: 'errors.csrf_invalid', meta: {} })
    return
  }
  next()
}
