// v1.145.0: fixed-window rate counter keyed by MCP API key id.
// In-memory, single-process — matches every other limiter in this app.
// Multi-instance deploys should move to Redis, but v1 is single-node.

const PER_MIN = Number(process.env['MCP_RATE_PER_MIN'] ?? 60)
const PER_HOUR = Number(process.env['MCP_RATE_PER_HOUR'] ?? 1000)
const TENANT_DAILY = Number(process.env['MCP_RATE_TENANT_DAILY'] ?? 5000)

interface Bucket { count: number; windowStart: number }
const perKeyMin = new Map<string, Bucket>()
const perKeyHour = new Map<string, Bucket>()
const tenantDay: Bucket = { count: 0, windowStart: Date.now() }

function bump(map: Map<string, Bucket>, key: string, windowMs: number, cap: number, weight: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now()
  const cur = map.get(key) ?? { count: 0, windowStart: now }
  if (now - cur.windowStart > windowMs) { cur.count = 0; cur.windowStart = now }
  if (cur.count + weight > cap) {
    map.set(key, cur)
    return { ok: false, retryAfterSec: Math.ceil((cur.windowStart + windowMs - now) / 1000) }
  }
  cur.count += weight
  map.set(key, cur)
  return { ok: true, retryAfterSec: 0 }
}

export interface RateCheckResult { ok: boolean; retryAfterSec?: number; reason?: string }

// `weight` (v1.454.0) lets one request count as several calls: the effort
// API's project-counts batch costs one call per 50 projects. Default 1.
export async function mcpRateCheck(apiKeyId: string, weight = 1): Promise<RateCheckResult> {
  const w = Math.max(1, Math.floor(weight))
  // Tenant-wide daily cap first — cheapest to short-circuit on.
  const now = Date.now()
  if (now - tenantDay.windowStart > 24 * 60 * 60 * 1000) {
    tenantDay.count = 0
    tenantDay.windowStart = now
  }
  if (tenantDay.count + w > TENANT_DAILY) {
    return { ok: false, retryAfterSec: Math.ceil((tenantDay.windowStart + 86400_000 - now) / 1000), reason: 'tenant_daily_cap' }
  }

  const min = bump(perKeyMin, apiKeyId, 60_000, PER_MIN, w)
  if (!min.ok) return { ok: false, retryAfterSec: min.retryAfterSec, reason: 'per_minute_cap' }

  const hour = bump(perKeyHour, apiKeyId, 60 * 60_000, PER_HOUR, w)
  if (!hour.ok) return { ok: false, retryAfterSec: hour.retryAfterSec, reason: 'per_hour_cap' }

  tenantDay.count += w
  return { ok: true }
}
