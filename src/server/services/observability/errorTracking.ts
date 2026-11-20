import type { ErrorRequestHandler } from 'express'
import type { ErrorEvent } from '@sentry/node'
import { APP_VERSION } from '../../../shared/appVersion.js'

// v1.414.0: optional error tracking. Off unless SENTRY_DSN is set, and the
// SDK is only loaded when it is, so an install without it pays nothing.
// Any Sentry-protocol server works: Sentry itself or a self-hosted
// GlitchTip (same DSN format). Errors only, no performance tracing.
//
// Privacy: dataCollection turns off everything the SDK would gather by
// itself (user info, cookies, headers other than user-agent, bodies, query
// strings, SQL text, local variables), and scrubEvent() drops the same
// fields again before anything leaves the process, so tokens and activity
// text never reach the tracker (CLAUDE.md §4: never log tokens).

type SentryModule = typeof import('@sentry/node')

let sentry: SentryModule | null = null

export function isErrorTrackingEnabled(): boolean {
  return sentry !== null
}

const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-csrf-token', 'proxy-authorization'])

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const req = event.request
  if (req) {
    delete req.data
    delete req.cookies
    delete req.query_string
    if (req.url) req.url = req.url.split('?')[0] ?? req.url
    if (req.headers) {
      for (const name of Object.keys(req.headers)) {
        if (DROPPED_HEADERS.has(name.toLowerCase())) delete req.headers[name]
      }
    }
  }
  if (event.user) {
    if (event.user.id) event.user = { id: event.user.id }
    else delete event.user
  }
  return event
}

export async function initErrorTracking(): Promise<void> {
  const dsn = process.env['SENTRY_DSN']?.trim()
  if (!dsn || sentry) return
  try {
    const mod = await import('@sentry/node')
    mod.init({
      dsn,
      release: `impactiq@${APP_VERSION}`,
      environment: process.env['SENTRY_ENVIRONMENT']?.trim() || process.env['NODE_ENV'] || 'development',
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: { allow: ['user-agent'] }, response: false },
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        genAI: { inputs: false, outputs: false },
        stackFrameVariables: false,
      },
      beforeSend: scrubEvent,
    })
    sentry = mod
    console.log('[error-tracking] enabled')
  } catch (err) {
    // A bad DSN or a missing module must never stop the app from starting.
    console.error('[error-tracking] could not start:', err instanceof Error ? err.message : err)
  }
}

// Tags are short identifiers only (job key, source), never user data.
export function reportError(err: unknown, tags: Record<string, string> = {}): void {
  if (!sentry) return
  try {
    sentry.captureException(err, { tags })
  } catch {
    // Reporting is best effort.
  }
}

export function reportMessage(message: string, tags: Record<string, string> = {}): void {
  if (!sentry) return
  try {
    sentry.captureMessage(message, { level: 'error', tags })
  } catch {
    // Reporting is best effort.
  }
}

// Registered after every route. Reports the error, then hands it on to
// Express's own handler so responses are unchanged.
export const errorTrackingMiddleware: ErrorRequestHandler = (err, req, _res, next) => {
  reportError(err, { source: 'http', method: req.method, route: req.route?.path ? String(req.route.path) : 'unmatched' })
  next(err)
}
