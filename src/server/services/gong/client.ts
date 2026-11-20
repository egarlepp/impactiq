import { recordIntegrationCall } from '../health/integrationStatus.js'
import { SlidingWindowLimiter } from '../hubspot/rateLimiter.js'
import { getGongConfig, saveGongOAuthTokens, type GongConfig, type GongCredentials } from './config.js'
import { refreshGongAccessToken } from './oauth.js'

// Gong REST client (Gong plan, phase 1). Every Gong call in ImpactIQ goes
// through gongRequest(): it adds the credential, keeps to Gong's default
// limit of 3 requests a second, waits out a 429 using Retry-After, refreshes
// an OAuth token that is about to expire (or that Gong refused once), and
// reports each outcome to App Health. Failures throw GongError with an i18n
// key, never Gong's own response text.

export type GongErrorCode =
  | 'errors.gong.not_configured'
  | 'errors.gong.unauthorized'
  | 'errors.gong.forbidden'
  | 'errors.gong.rate_limited'
  | 'errors.gong.unreachable'
  | 'errors.gong.bad_response'

export class GongError extends Error {
  constructor(public readonly code: GongErrorCode, public readonly status?: number) {
    super(code)
    this.name = 'GongError'
  }
}

const TIMEOUT_MS = 20_000
// Gong allows 3 requests a second per tenant by default; a little under it
// leaves room for anything else the customer runs against the same key.
export const gongLimiter = new SlidingWindowLimiter({ max: 3, intervalMs: 1_100 })
const MAX_429_RETRIES = 2
const MAX_RETRY_WAIT_MS = 60_000
// Refresh an OAuth token this long before Gong says it expires.
const REFRESH_EARLY_MS = 2 * 60_000

export interface GongResponse {
  status: number
  body: unknown
}

export function gongAuthHeader(credentials: GongCredentials): string {
  if (credentials.method === 'access_key') {
    return `Basic ${Buffer.from(`${credentials.accessKey}:${credentials.accessKeySecret}`).toString('base64')}`
  }
  return `Bearer ${credentials.accessToken}`
}

export function retryAfterMs(res: Response): number {
  const s = Number(res.headers.get('retry-after'))
  if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, MAX_RETRY_WAIT_MS)
  return 2_000
}

// Swaps an expiring (or refused) OAuth access token for a new one and saves
// it. Returns the config to retry with, or null when there is nothing to
// refresh with.
async function refreshOAuth(cfg: GongConfig): Promise<GongConfig | null> {
  if (cfg.credentials.method !== 'oauth' || !cfg.credentials.refreshToken) return null
  const tokens = await refreshGongAccessToken({
    refreshToken: cfg.credentials.refreshToken,
    clientId: cfg.credentials.clientId,
    clientSecret: cfg.credentials.clientSecret,
  })
  await saveGongOAuthTokens(tokens)
  return getGongConfig()
}

async function requireConfig(): Promise<GongConfig> {
  let cfg = await getGongConfig()
  if (!cfg) throw new GongError('errors.gong.not_configured')
  const c = cfg.credentials
  if (c.method === 'oauth' && c.expiresAt !== null && c.expiresAt - Date.now() < REFRESH_EARLY_MS) {
    cfg = (await refreshOAuth(cfg).catch(() => null)) ?? cfg
  }
  return cfg
}

export interface GongRequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  query?: Record<string, string | undefined>
  // Answer these statuses instead of throwing (the capability check reads a
  // 403 as "scope missing", and Gong answers 404 when no calls match).
  allowStatuses?: number[] | undefined
  // Overrides the saved connection (the check of credentials not saved yet).
  config?: GongConfig
}

export async function gongRequest(path: string, opts: GongRequestOptions = {}): Promise<GongResponse> {
  let cfg = opts.config ?? await requireConfig()
  let refreshed = false
  let rateRetries = 0
  for (;;) {
    const url = new URL(path, cfg.apiBaseUrl)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v)
    await gongLimiter.acquire()
    let res: Response
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: gongAuthHeader(cfg.credentials),
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
        // The host is fixed to *.api.gong.io; never follow a redirect off it.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      recordIntegrationCall('gong', false, 'errors.gong.unreachable')
      throw new GongError('errors.gong.unreachable')
    }

    if (res.status === 429) {
      if (rateRetries >= MAX_429_RETRIES) {
        recordIntegrationCall('gong', false, 'errors.gong.rate_limited')
        throw new GongError('errors.gong.rate_limited', 429)
      }
      const wait = retryAfterMs(res)
      gongLimiter.pause(wait)
      rateRetries += 1
      continue
    }
    if (res.status === 401 && !opts.config && !refreshed && cfg.credentials.method === 'oauth') {
      refreshed = true
      const next = await refreshOAuth(cfg).catch(() => null)
      if (next) { cfg = next; continue }
    }

    const allowed = opts.allowStatuses?.includes(res.status) ?? false
    if (res.status === 401) {
      recordIntegrationCall('gong', false, 'errors.gong.unauthorized')
      throw new GongError('errors.gong.unauthorized', 401)
    }
    if (res.status === 403 && !allowed) {
      recordIntegrationCall('gong', false, 'errors.gong.forbidden')
      throw new GongError('errors.gong.forbidden', 403)
    }
    if (res.status >= 500) {
      recordIntegrationCall('gong', false, `Gong answered ${res.status}`)
      throw new GongError('errors.gong.unreachable', res.status)
    }
    recordIntegrationCall('gong', true)
    let body: unknown = null
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      try { body = await res.json() } catch { body = null }
    }
    if (!res.ok && !allowed) throw new GongError('errors.gong.bad_response', res.status)
    return { status: res.status, body }
  }
}

// Gong pages with a cursor in records.cursor; the next request repeats the
// same input with that cursor. Stops at maxPages so a runaway listing can't
// eat the tenant's daily request allowance.
export async function gongListAll<T>(
  path: string,
  pick: (body: unknown) => T[],
  opts: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; maxPages?: number; allowStatuses?: number[] | undefined } = {},
): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  const maxPages = opts.maxPages ?? 50
  for (let page = 0; page < maxPages; page++) {
    const res = opts.method === 'POST'
      ? await gongRequest(path, { method: 'POST', body: { ...(opts.body ?? {}), ...(cursor ? { cursor } : {}) }, allowStatuses: opts.allowStatuses })
      : await gongRequest(path, { query: { cursor }, allowStatuses: opts.allowStatuses })
    if (!res.body) break
    out.push(...pick(res.body))
    const next = nextCursor(res.body)
    if (!next) break
    cursor = next
  }
  return out
}

export function nextCursor(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const records = (body as Record<string, unknown>)['records']
  if (!records || typeof records !== 'object') return undefined
  const c = (records as Record<string, unknown>)['cursor']
  return typeof c === 'string' && c !== '' ? c : undefined
}
