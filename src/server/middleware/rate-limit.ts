import type { Request, Response } from 'express'
import expressRateLimit, { type AugmentedRequest, type ClientRateLimitInfo, type RateLimitRequestHandler, type Store } from 'express-rate-limit'

// Rate limiters, built on express-rate-limit (v1.481+) so code scanning
// recognizes them as rate limiting. The counting itself is our own small
// in-memory fixed-window store, so the behavior is unchanged from the
// hand-rolled limiter this replaced: one window per key, starting at the key's
// first request, and a window length that can change live (the global limiter
// reads it from Admin → Integrations → Rate Limiting on every request).
//
// In-memory and per process. With more than one replica each one counts on its
// own (CLAUDE.md §17); a shared store (Redis) would go here.

// Expired buckets are dropped on a sweep at most this often, so keys that never
// come back (one-off IPs, old sessions) don't pile up.
const SWEEP_EVERY_MS = 10 * 60 * 1000

export class FixedWindowStore implements Store {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()
  private nextSweepAt = Date.now() + SWEEP_EVERY_MS
  readonly localKeys = true

  constructor(private readonly windowMs: () => number) {}

  get(key: string): ClientRateLimitInfo | undefined {
    const entry = this.buckets.get(key)
    if (!entry || entry.resetAt < Date.now()) return undefined
    return { totalHits: entry.count, resetTime: new Date(entry.resetAt) }
  }

  increment(key: string): ClientRateLimitInfo {
    const now = Date.now()
    this.sweep(now)
    const entry = this.buckets.get(key)
    if (!entry || entry.resetAt < now) {
      const fresh = { count: 1, resetAt: now + Math.max(1, this.windowMs()) }
      this.buckets.set(key, fresh)
      return { totalHits: 1, resetTime: new Date(fresh.resetAt) }
    }
    entry.count += 1
    return { totalHits: entry.count, resetTime: new Date(entry.resetAt) }
  }

  decrement(key: string): void {
    const entry = this.buckets.get(key)
    if (entry && entry.count > 0) entry.count -= 1
  }

  resetKey(key: string): void {
    this.buckets.delete(key)
  }

  resetAll(): void {
    this.buckets.clear()
  }

  private sweep(now: number): void {
    if (now < this.nextSweepAt) return
    this.nextSweepAt = now + SWEEP_EVERY_MS
    for (const [key, entry] of this.buckets) {
      if (entry.resetAt < now) this.buckets.delete(key)
    }
  }
}

function defaultKey(req: Request): string {
  return req.ip ?? 'unknown'
}

// The app's 429: the `{ data, error, meta }` envelope plus Retry-After, as the
// client already expects.
function tooManyRequests(req: Request, res: Response): void {
  const resetTime = (req as AugmentedRequest)['rateLimit']?.resetTime
  const retryAfter = Math.max(1, Math.ceil(((resetTime?.getTime() ?? Date.now()) - Date.now()) / 1000))
  res.setHeader('Retry-After', String(retryAfter))
  res.status(429).json({ data: null, error: 'errors.rate_limited', meta: { retryAfter } })
}

// Fixed limits for one route or router.
export function rateLimit(opts: { windowMs: number; max: number; keyFn?: (req: Request) => string }): RateLimitRequestHandler {
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) throw new Error('rateLimit: windowMs must be a positive number')
  if (!Number.isFinite(opts.max) || opts.max < 0) throw new Error('rateLimit: max must be zero or more')
  return expressRateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    keyGenerator: opts.keyFn ?? defaultKey,
    store: new FixedWindowStore(() => opts.windowMs),
    handler: tooManyRequests,
    standardHeaders: false,
    legacyHeaders: false,
    // Our keys are deliberate (session hash, user id, IP + token), and the
    // proxy setting is the admin's trustProxyHops; skip the library's
    // start-up advice about default keys and proxies.
    validate: false,
  })
}

// Config-backed variant: reads {enabled, windowMs, max} from a getter on every
// request so an admin can change limits (or turn it off) live without a restart.
// Used as the global limiter; per-route limiters use rateLimit() with fixed values.
export function rateLimitDynamic(
  getSettings: () => { enabled: boolean; windowMs: number; max: number },
  keyFn?: (req: Request) => string,
  // Optional predicate to bypass the limiter for specific requests — e.g.
  // heavy endpoints that carry their own per-user throttle and shouldn't be
  // gated by the general per-IP request cap.
  skip?: (req: Request) => boolean,
): RateLimitRequestHandler {
  return expressRateLimit({
    // Only the default for headers we don't send; the store reads the live value.
    windowMs: Math.max(1, getSettings().windowMs),
    limit: () => getSettings().max,
    keyGenerator: keyFn ?? defaultKey,
    skip: (req) => {
      if (skip?.(req)) return true
      const { enabled, max } = getSettings()
      return !enabled || max <= 0
    },
    store: new FixedWindowStore(() => getSettings().windowMs),
    handler: tooManyRequests,
    standardHeaders: false,
    legacyHeaders: false,
    validate: false,
  })
}
