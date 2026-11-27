import { getHubspotConfig } from './config.js'
import { applyRateLimitHeaders, generalLimiter, searchLimiter } from './rateLimiter.js'
import { recordIntegrationCall } from '../health/integrationStatus.js'

// Low-level client for HubSpot's REST API, authenticated with the install's
// private app token (config.ts). Every request is paced by rateLimiter.ts and
// retries a per-second 429 after HubSpot's suggested wait.
//
// Paths use HubSpot's v3 endpoints, which HubSpot keeps supported alongside
// its date-versioned ones (/crm/objects/2026-09/...). Moving to a date
// version is a path change in the callers, not here.
//
// Failures throw HubspotError with an i18n key, never HubSpot's own message
// text, so callers can show it as-is.

export const HUBSPOT_API_BASE = 'https://api.hubapi.com'

export type HubspotErrorCode =
  | 'errors.hubspot.not_configured'
  | 'errors.hubspot.unauthorized'
  | 'errors.hubspot.forbidden'
  | 'errors.hubspot.rate_limited'
  | 'errors.hubspot.unreachable'
  | 'errors.hubspot.bad_response'

export class HubspotError extends Error {
  constructor(public readonly code: HubspotErrorCode, public readonly status?: number) {
    super(code)
    this.name = 'HubspotError'
  }
}

export interface HubspotRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | undefined
  query?: Record<string, string | number | boolean | undefined> | undefined
  body?: unknown
  // CRM search endpoints have their own, lower limit.
  search?: boolean | undefined
  // Use this token instead of the saved one (checking a token before saving it).
  token?: string | undefined
}

export interface HubspotResponse {
  status: number
  body: unknown
}

const TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 3
const DEFAULT_RETRY_MS = 1_000

async function resolveToken(opts: HubspotRequestOptions): Promise<string> {
  if (opts.token) return opts.token
  const cfg = await getHubspotConfig()
  if (!cfg) throw new HubspotError('errors.hubspot.not_configured')
  return cfg.accessToken
}

export function buildHubspotUrl(path: string, query?: HubspotRequestOptions['query']): URL {
  // Callers pass a path, never a host: the token only ever goes to HubSpot.
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`HubSpot path must be absolute: ${path}`)
  // Joined onto the fixed origin as a string, so the host can never come from the path.
  const url = new URL(`https://api.hubapi.com/${path.slice(1)}`)
  if (url.origin !== HUBSPOT_API_BASE) throw new Error(`HubSpot path must stay on ${HUBSPOT_API_BASE}`)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  return url
}

function retryDelayMs(res: Response): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000)
  const interval = Number(res.headers.get('x-hubspot-ratelimit-interval-milliseconds'))
  if (Number.isFinite(interval) && interval > 0) return Math.min(interval, 30_000)
  return DEFAULT_RETRY_MS
}

async function readBody(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return null
  try { return await res.json() } catch { return null }
}

function isDailyLimit(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as Record<string, unknown>)['policyName'] === 'DAILY'
}

// Sends one request and returns HubSpot's status and JSON body. Throws only
// for what no caller can work around: no token, a rejected token (401), a
// network failure, or a rate limit that outlasted the retries.
export async function hubspotRequest(path: string, opts: HubspotRequestOptions = {}): Promise<HubspotResponse> {
  const token = await resolveToken(opts)
  const url = buildHubspotUrl(path, opts.query)
  const limiter = opts.search ? searchLimiter : generalLimiter
  for (let attempt = 1; ; attempt++) {
    await limiter.acquire()
    // Search calls count toward the general limit too.
    if (opts.search) await generalLimiter.acquire()
    let res: Response
    try {
      // Fixed origin as a literal prefix: only the path and query come from the caller.
      res = await fetch(`https://api.hubapi.com/${url.pathname.slice(1)}${url.search}`, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      recordIntegrationCall('hubspot', false, 'errors.hubspot.unreachable')
      throw new HubspotError('errors.hubspot.unreachable')
    }
    applyRateLimitHeaders(res.headers)
    if (res.status === 401) {
      recordIntegrationCall('hubspot', false, 'errors.hubspot.unauthorized')
      throw new HubspotError('errors.hubspot.unauthorized', 401)
    }
    if (res.status === 429) {
      const body = await readBody(res)
      if (isDailyLimit(body) || attempt >= MAX_ATTEMPTS) {
        recordIntegrationCall('hubspot', false, 'errors.hubspot.rate_limited')
        throw new HubspotError('errors.hubspot.rate_limited', 429)
      }
      limiter.pause(retryDelayMs(res))
      continue
    }
    // App Health: a 5xx means HubSpot itself is failing; any other answer
    // (a 404 or 403 included) means the connection works.
    if (res.status >= 500) recordIntegrationCall('hubspot', false, `HubSpot answered ${res.status}`)
    else recordIntegrationCall('hubspot', true)
    return { status: res.status, body: await readBody(res) }
  }
}

// For callers that need a successful JSON answer: anything other than a 2xx
// becomes a HubspotError (403 → forbidden, a missing scope or tier feature).
export async function hubspotJson<T = unknown>(path: string, opts: HubspotRequestOptions = {}): Promise<T> {
  const { status, body } = await hubspotRequest(path, opts)
  if (status === 403) throw new HubspotError('errors.hubspot.forbidden', 403)
  if (status < 200 || status >= 300 || body === null) throw new HubspotError('errors.hubspot.bad_response', status)
  return body as T
}

// Reads every page of a v3 list endpoint (results + paging.next.after).
export async function hubspotListAll<T>(path: string, query: HubspotRequestOptions['query'] = {}, opts: Omit<HubspotRequestOptions, 'query'> = {}): Promise<T[]> {
  const out: T[] = []
  let after: string | undefined
  // A safety stop far past any real owner list; a looping cursor can't run forever.
  for (let page = 0; page < 1000; page++) {
    const body = await hubspotJson<{ results?: T[]; paging?: { next?: { after?: string } } }>(path, { ...opts, query: { ...query, after } })
    out.push(...(Array.isArray(body.results) ? body.results : []))
    after = body.paging?.next?.after
    if (!after) break
  }
  return out
}
