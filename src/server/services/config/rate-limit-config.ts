import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'

// Admin-configurable global rate limit, stored in system_settings and cached
// in-memory so the global middleware can read it synchronously per request.
// Mirrors the load/get/set + cache pattern in config/integrations.ts.

const KEY_RATE_LIMIT = 'rate_limit_settings'

export interface RateLimitSettings {
  enabled: boolean
  windowSeconds: number
  max: number
  // v1.424.0 (security audit M5): how many reverse proxies sit in front of
  // the app. Express takes the client IP from X-Forwarded-For by skipping
  // exactly this many hops, so a client can't pick its own IP for the per-IP
  // login and reset limits by sending the header. 0 = the app is reached
  // directly and the header is ignored. Saving takes effect at once.
  trustedProxyHops: number
}

// Default: 600 API requests / 5 minutes per SESSION. Generous for a real
// user, still shuts down abuse/scraping loops. Admin can change or disable it.
//
// v1.221.0 raised this from 300 alongside two keying fixes (see index.ts).
// 300 was chosen when the limiter was per-IP and covered static assets too,
// which made the real per-user headroom far smaller than the number implied —
// a single hard reload spends dozens of requests on JS chunks alone. Now that
// the limiter counts only /api and /auth and buckets per session, 600 is what
// 300 was always meant to mean.
const DEFAULT_RATE_LIMIT: RateLimitSettings = { enabled: true, windowSeconds: 300, max: 600, trustedProxyHops: 0 }

const MIN_WINDOW = 10
const MAX_WINDOW = 3600
const MIN_MAX = 1
const MAX_MAX = 1_000_000
export const MAX_TRUSTED_PROXY_HOPS = 3

// TRUSTED_PROXY_HOPS in the environment wins over the admin setting and
// locks it, for the case where a wrong setting has to be fixed without
// signing in (every user behind one proxy IP sharing one login limit).
export function trustedProxyHopsFromEnv(): number | null {
  const raw = process.env['TRUSTED_PROXY_HOPS']
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > MAX_TRUSTED_PROXY_HOPS) {
    console.warn(`[rate-limit] ignoring TRUSTED_PROXY_HOPS=${raw}: expected a whole number from 0 to ${MAX_TRUSTED_PROXY_HOPS}`)
    return null
  }
  return n
}

let cached: RateLimitSettings = { ...DEFAULT_RATE_LIMIT }

function clamp(v: RateLimitSettings): RateLimitSettings {
  return {
    enabled: Boolean(v.enabled),
    windowSeconds: Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round(v.windowSeconds))),
    max: Math.max(MIN_MAX, Math.min(MAX_MAX, Math.round(v.max))),
    trustedProxyHops: Number.isFinite(v.trustedProxyHops) ? Math.max(0, Math.min(MAX_TRUSTED_PROXY_HOPS, Math.round(v.trustedProxyHops))) : 0,
  }
}

async function upsert(value: RateLimitSettings): Promise<void> {
  const existing = await db.select({ key: systemSettings.key }).from(systemSettings).where(eq(systemSettings.key, KEY_RATE_LIMIT)).limit(1)
  if (existing.length > 0) {
    await db.update(systemSettings).set({ value: value as unknown as Record<string, unknown> }).where(eq(systemSettings.key, KEY_RATE_LIMIT))
  } else {
    await db.insert(systemSettings).values({ key: KEY_RATE_LIMIT, value: value as unknown as Record<string, unknown> })
  }
}

// Called once at boot (from index.ts start()) so the cache is warm before the
// server starts accepting requests.
export async function loadRateLimitSettings(): Promise<void> {
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY_RATE_LIMIT)).limit(1)
    if (row?.value) {
      const v = row.value as Partial<RateLimitSettings>
      cached = clamp({
        enabled: v.enabled ?? DEFAULT_RATE_LIMIT.enabled,
        windowSeconds: Number(v.windowSeconds ?? DEFAULT_RATE_LIMIT.windowSeconds),
        max: Number(v.max ?? DEFAULT_RATE_LIMIT.max),
        trustedProxyHops: Number(v.trustedProxyHops ?? DEFAULT_RATE_LIMIT.trustedProxyHops),
      })
    }
  } catch (err) {
    console.warn('[rate-limit] failed to load settings, using defaults:', err)
  }
}

// Synchronous read for the middleware (window in ms). Never hits the DB.
export function getRateLimitSettings(): RateLimitSettings {
  return cached
}
// The hop count in force: the env var when set, else the saved setting.
export function getTrustedProxyHops(): number {
  return trustedProxyHopsFromEnv() ?? cached.trustedProxyHops
}

// Express 'trust proxy' as a function, so a saved change applies without a
// restart. Same rule as a numeric setting: trust the closest N hops.
export function trustProxyHops(_addr: string, hopIndex: number): boolean {
  return hopIndex < getTrustedProxyHops()
}

export function getRateLimitForMiddleware(): { enabled: boolean; windowMs: number; max: number } {
  return { enabled: cached.enabled, windowMs: cached.windowSeconds * 1000, max: cached.max }
}

export async function saveRateLimitSettings(v: RateLimitSettings): Promise<RateLimitSettings> {
  const next = clamp(v)
  await upsert(next)
  cached = next // hot-reload the live limiter
  return next
}
