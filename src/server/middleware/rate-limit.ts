import type { NextFunction, Request, Response } from 'express'

// Small in-memory fixed-window rate limiter. Fine for a single-process
// internal tool. If we ever scale horizontally, swap the map for Redis.
export function rateLimit(opts: { windowMs: number; max: number; keyFn?: (req: Request) => string }) {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = opts.keyFn ? opts.keyFn(req) : (req.ip ?? 'unknown')
    const now = Date.now()
    const entry = buckets.get(key)
    if (!entry || entry.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
      next()
      return
    }
    entry.count += 1
    if (entry.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ data: null, error: 'errors.rate_limited', meta: { retryAfter } })
      return
    }
    next()
  }
}

// Config-backed variant: reads {enabled, windowMs, max} from a getter on every
// request so an admin can change limits (or turn it off) live without a restart.
// Buckets persist across requests in the outer closure. Used as the global
// limiter; per-route limiters keep using rateLimit() with fixed values.
export function rateLimitDynamic(
  getSettings: () => { enabled: boolean; windowMs: number; max: number },
  keyFn?: (req: Request) => string,
  // Optional predicate to bypass the limiter for specific requests — e.g.
  // heavy endpoints that carry their own per-user throttle and shouldn't be
  // gated by the general per-IP request cap.
  skip?: (req: Request) => boolean,
) {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip?.(req)) { next(); return }
    const { enabled, windowMs, max } = getSettings()
    if (!enabled || max <= 0) { next(); return }
    const key = keyFn ? keyFn(req) : (req.ip ?? 'unknown')
    const now = Date.now()
    const entry = buckets.get(key)
    if (!entry || entry.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }
    entry.count += 1
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ data: null, error: 'errors.rate_limited', meta: { retryAfter } })
      return
    }
    next()
  }
}
