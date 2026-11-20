import type { NextFunction, Request, Response } from 'express'

// Baseline security headers. Kept hand-rolled (rather than depending on
// helmet) so the header set is explicit and reviewable. CSP is intentionally
// tight: same-origin scripts only, no eval, images/media from self+data:,
// and connect-src limited to same-origin + the two SaaS providers the client
// legitimately talks to indirectly (via our API — but the tokens live
// server-side so no direct cross-origin fetch is needed today).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Tailwind emits inline styles at build time; keep 'unsafe-inline' for now.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
  res.setHeader('Content-Security-Policy', CSP)
  if (process.env['NODE_ENV'] === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}
