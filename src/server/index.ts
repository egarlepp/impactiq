import express from 'express'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readSessionCookie } from './services/auth/session.js'
import { authRouter } from './routes/auth.js'
import { apiRouter } from './routes/index.js'
import { getOrCreateSetupToken, setupRouter } from './routes/setup.js'
import { firstRunRouter } from './routes/firstRun.js'
import { needsFirstAdmin } from './services/auth/firstRun.js'
import { themesRouter } from './routes/themes.js'
import { mcpRouter } from './routes/mcp.js'
import { effortApiRouter } from './routes/effortApi.js'
import { activityLogApiRouter } from './routes/activityLogApi.js'
import { CRITERIAIQ_WEBHOOK_PATH, criteriaIqWebhookRouter } from './routes/criteriaiqWebhook.js'
import { gongWebhookRouter } from './routes/gongWebhook.js'
import { GONG_WEBHOOK_PATH } from '../shared/gong.js'
import { isDbConfigured, runMigrations } from './db/index.js'
import { startWriteBackWorker, startSyncAuditCull } from './services/salesforce/writeback.js'
import { startOutlookWriteBackWorker } from './services/outlook/writeback.js'
import { startNotesPushWorker } from './services/salesforce/notesPush.js'
import { startEventWebhookWorker } from './services/webhooks/delivery.js'
import { startAnomalyWebhookScan } from './services/webhooks/anomalyScan.js'
import { startNotificationSweep } from './services/nudge/sweep.js'
import { startOppSnapshotWorker } from './services/salesforce/refreshOppSnapshots.js'
import { startDisconnectedLinksWorker } from './services/salesforce/detectDisconnectedLinks.js'
import { startCriteriaIqProjectsWorker } from './services/criteriaiq/primaryProjects.js'
import { startHubspotOwnerSyncWorker } from './services/hubspot/owners.js'
import { startGongUserSyncWorker } from './services/gong/users.js'
import { startGongCallIndexWorker } from './services/gong/calls.js'
import { startGongAutoLinkWorker } from './services/gong/autoLink.js'
import { startSfUserSyncWorker } from './services/salesforce/users.js'
import { startHubspotWriteBackWorker } from './services/hubspot/writeback.js'
import { startHubspotSnapshotWorker } from './services/hubspot/refreshSnapshots.js'
import { startHubspotOppCoverageWorker } from './services/hubspot/attachCoverage.js'
import { startHubspotLinkHealthWorker } from './services/hubspot/linkHealth.js'
import { startHubspotNotesPushWorker } from './services/hubspot/notesPush.js'
import { startOppCoverageWorker } from './services/salesforce/refreshOppCoverage.js'
import { startHistoricalOppWorker } from './services/salesforce/historical/refreshHistoricalOpps.js'
import { startPasswordExpiryWorker } from './services/auth/passwordExpiry.js'
import { startUpdateCheckWorker } from './services/updates/checkForUpdates.js'
import { startRestartScheduler } from './services/updates/restartScheduler.js'
import { startDigestWorker } from './services/notifications/digest.js'
import { startWeeklyRecapWorker } from './services/notifications/weekly-recap.js'
import { loadIntegrationConfigs } from './services/config/integrations.js'
import { loadAuthPolicy } from './services/config/auth-policy.js'
// Import env early so missing SESSION_SECRET / TOKEN_ENCRYPTION_KEY throws
// at import time in production before any request is handled.
import './services/config/env.js'
import { securityHeaders } from './middleware/security.js'
import { csrf } from './middleware/csrf.js'
import { defaultJsonBody } from './middleware/json-body.js'
import { rateLimitDynamic } from './middleware/rate-limit.js'
import { loadRateLimitSettings, getRateLimitForMiddleware, trustProxyHops } from './services/config/rate-limit-config.js'
import { normalizeStoredTimezones } from './services/outlook/normalizeStoredTimezones.js'
import { initErrorTracking, errorTrackingMiddleware } from './services/observability/errorTracking.js'
import { holdJobsUntil } from './services/jobs/scheduler.js'
import { noteReadyCall } from './services/health/readiness.js'

// v1.414.0: optional, off unless SENTRY_DSN is set (CLAUDE.md §17). Started
// before the app so errors thrown while wiring routes are caught too.
await initErrorTracking()

const app = express()
const port = Number(process.env['PORT'] ?? 3000)

// v1.84.0: honor X-Forwarded-* headers set by a TLS-terminating proxy so
// req.protocol reflects the outer scheme (the Microsoft OAuth redirect_uri
// needs it). v1.424.0 (security audit M5): only as many hops as Admin →
// Integrations → Rate Limiting says sit in front of the app (default 0, or
// TRUSTED_PROXY_HOPS). Trusting every hop let a client choose its own IP for
// the per-IP login and reset limits by sending X-Forwarded-For.
app.set('trust proxy', trustProxyHops)

// Baseline security headers on every response.
app.use(securityHeaders)

// Lightweight request timing. Logs any request slower than SLOW_REQUEST_MS
// (default 1500ms), or every request when REQUEST_TIMING_LOG=1 — a cheap way
// to spot slow endpoints (dashboards, SF-backed reads) without a full APM.
// Runs on 'finish' so it never blocks the response.
const SLOW_REQUEST_MS = Number(process.env['SLOW_REQUEST_MS']) || 1500
const REQUEST_TIMING_LOG = process.env['REQUEST_TIMING_LOG'] === '1'
app.use((req, res, next) => {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    if (REQUEST_TIMING_LOG || ms >= SLOW_REQUEST_MS) {
      console.log(`[req] ${res.statusCode} ${req.method} ${req.originalUrl.split('?')[0]} ${ms.toFixed(0)}ms`)
    }
  })
  next()
})

// Default 256 KB JSON parser; skips routers that mount their own larger
// one (see middleware/json-body.ts).
app.use(defaultJsonBody())

// CSRF: double-submit cookie for state-changing requests. Exempts pre-session
// endpoints (login, OAuth callbacks, setup).
app.use(csrf)

// Global rate limiter — admin-configurable (Admin → Integrations → Rate
// Limiting), read live per request so changes/disable apply without a restart.
// Per-route limiters (auth, MCP, scheduling refresh) stack tighter limits on top.
//
// v1.221.0 — two keying fixes for spurious 429s that appeared to fire at
// random:
//
//   1. Bucket per SESSION, not per IP. Everyone behind the corporate proxy or
//      the Dokploy reverse proxy presents the same `req.ip`, so the whole
//      tenant shared one bucket and a busy colleague could 429 you. The
//      session token is hashed before it's used as a key so a raw credential
//      never sits in an in-memory map. Unauthenticated requests still fall
//      back to IP, which is the right unit for login-endpoint abuse.
//   2. Count only /api and /auth. The limiter sits ahead of express.static,
//      so every JS chunk, font and image on a hard reload was spending
//      budget — dozens of requests before the app had rendered anything.
//      Rate-limiting our own cacheable bundle protects nothing.
app.use(rateLimitDynamic(
  getRateLimitForMiddleware,
  (req) => {
    const token = readSessionCookie(req)
    if (token) return `s:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
    return `ip:${req.ip ?? 'unknown'}`
  },
  (req) => {
    // Static assets and the SPA shell — not a meaningful abuse surface, and
    // counting them made the configured max mean something much smaller than
    // it looked.
    if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) return true
    // Manual SF refreshes do heavy work but carry their own 10-minute
    // per-user throttle; leave them out of the general cap so a deliberate
    // click isn't blocked by unrelated dashboard traffic.
    return req.method === 'POST'
      && (/\/dashboards\/refresh-opp-snapshots$/.test(req.path) || /\/scheduling\/refresh$/.test(req.path))
  },
))

// Setup mode: when DATABASE_URL is missing, only setup endpoints are reachable.
const SETUP_MODE = !isDbConfigured()

// v1.247.0: DATABASE_URL being *set* (checked above) and DATABASE_URL being
// *reachable* are different conditions — a wrong password, wrong host, or a
// database that doesn't exist yet all leave SETUP_MODE false (the var IS
// set) while migrations still fail. This used to call process.exit(1) in
// start() below, which — combined with a restart policy like Docker's
// `unless-stopped` or Dokploy's equivalent — crash-loops the container
// forever with no live listener. Every request in front of it (Traefik,
// nginx, whatever) then shows a permanent Bad Gateway, and the only way to
// see WHY is container logs, which isn't obvious to check when the browser
// just says "Bad Gateway". Tracked here instead so the guard middleware
// below (registered before the real routers, checked at request time) can
// serve the actual error over HTTP — same graceful-degradation shape as
// SETUP_MODE, for "configured, but broken" instead of "not configured".
let dbConnectionError: string | null = null

// v1.443.0: settles once start() has tried the migrations; background jobs
// wait on it (holdJobsUntil, below) so none queries a table not created yet.
let settleMigrations: () => void = () => {}
const migrationsSettled = new Promise<void>((resolve) => { settleMigrations = resolve })

app.use('/api/setup', setupRouter)

if (SETUP_MODE) {
  console.log('[setup] DATABASE_URL not set — running in SETUP MODE. Visit /setup to configure.')
  // Security audit L9 (v1.425.0): the wizard asks for this token first.
  const setup = getOrCreateSetupToken()
  console.log(setup.fromEnv
    ? '[setup] Setup token: the value of SETUP_TOKEN.'
    : `[setup] Setup token (enter it on the first screen of /setup): ${setup.token}`)
  app.use('/api', (_req, res) => {
    res.status(503).json({
      data: null,
      error: 'App is in setup mode. Configure DATABASE_URL via /setup.',
      meta: { setupMode: true },
    })
  })
  app.use('/auth', (_req, res) => {
    res.status(503).json({ data: null, error: 'Setup required', meta: { setupMode: true } })
  })
} else {
  // Registered BEFORE the real routers below so it's checked first at
  // request time — by then dbConnectionError reflects whatever start()
  // determined, regardless of the fact this whole branch (and the routers
  // it mounts) ran synchronously before start()'s migration attempt even
  // began. /api/setup above is unaffected (matched first, already
  // registered) — it deliberately stays reachable so an admin can use the
  // wizard's own DB test to diagnose the real problem without a redeploy.
  app.use(['/auth', '/api'], (_req, res, next) => {
    if (!dbConnectionError) { next(); return }
    res.status(503).json({
      data: null,
      error: `Database is configured but unreachable: ${dbConnectionError}`,
      meta: { dbError: true },
    })
  })
  // v1.475.0: first-admin bootstrap while the users table is empty (public
  // status check; creating the account needs the setup token).
  app.use('/api/first-run', firstRunRouter)
  app.use('/auth', authRouter)
  // Public: active theme is needed before authentication to style the login screen.
  app.use('/api/themes', themesRouter)
  // v1.145.0: MCP mounted BEFORE /api so it can own its own transport
  // (StreamableHTTP writes raw SSE + JSON, incompatible with the
  // envelope middleware).
  app.use('/api/mcp', mcpRouter)
  // v1.448.0: effort:read keys only (CriteriaIQ), so it sits before the
  // session-authenticated /api router.
  app.use('/api/v1', effortApiRouter)
  // v1.481.0: activities:log keys only (DemoIQ logs demos as drafts), same reason.
  app.use('/api/v1', activityLogApiRouter)
  // v1.450.0: CriteriaIQ live refresh, signed by CriteriaIQ, no session.
  app.use(CRITERIAIQ_WEBHOOK_PATH, criteriaIqWebhookRouter)
  // v1.456.0: Gong's "Fire webhook" rule, signed by Gong, no session.
  app.use(GONG_WEBHOOK_PATH, gongWebhookRouter)
  app.use('/api', apiRouter)
  // v1.443.0: no job ticks until start() has applied migrations (scheduler.ts).
  holdJobsUntil(migrationsSettled)
  // Salesforce write-back worker — polls every 30s for pending submitted activities.
  startWriteBackWorker()
  startSyncAuditCull()
  // v1.156.0: Outlook calendar write-back worker (per-user opt-in).
  startOutlookWriteBackWorker()
  // Notes → Salesforce ContentNote push worker.
  startNotesPushWorker()
  // v1.427.0: outbound event webhook deliveries (docs/event-webhooks.md).
  startEventWebhookWorker()
  startAnomalyWebhookScan()
  // v1.433.0: evaluates nudges for every user in their working hours and
  // sends due announcements to Slack, so neither waits for a login.
  startNotificationSweep()
  // Daily morning notification digest — ticks every minute, sends per-user
  // when local time crosses 08:00 and a digest hasn't been sent today.
  startDigestWorker()
  // Friday-afternoon weekly recap email — opt-in via user notification prefs.
  startWeeklyRecapWorker()
  // v1.138.0: nightly refresh of activities.salesStage / forecastCategory /
  // isWon etc. Kicks 60s after boot then every 24h.
  startOppSnapshotWorker()
  // v1.344.0: nightly scan for activities whose linked SF What/Who/Related
  // record has been deleted. Kicks ~90s after boot then every 24h.
  startDisconnectedLinksWorker()
  startCriteriaIqProjectsWorker()
  startHubspotOwnerSyncWorker()
  startGongUserSyncWorker()
  startGongCallIndexWorker()
  startGongAutoLinkWorker()
  // v1.437.0: nightly Salesforce user directory refresh (pairs with the
  // HubSpot owner sync above; each runs only on its own CRM).
  startSfUserSyncWorker()
  startHubspotWriteBackWorker()
  startHubspotSnapshotWorker()
  startHubspotOppCoverageWorker()
  startHubspotLinkHealthWorker()
  startHubspotNotesPushWorker()
  // v1.188.0: nightly refill of the Attach Rate opportunity coverage
  // snapshot. Kicks ~90s after boot then every 24h.
  startOppCoverageWorker()
  // v1.214.0: nightly refresh of the historical-import Opportunity mirror,
  // open (non-closed) opps only. Kicks ~150s after boot to stagger behind
  // the two refreshers above, then every 24h.
  startHistoricalOppWorker()
  // v1.323.0: daily 90-day password-expiry sweep for authMethod='password'
  // accounts. See CLAUDE.md §4/§5 and services/auth/passwordExpiry.ts.
  startPasswordExpiryWorker()
  // v1.332.0: App Update check (Admin → Integrations → App Updates, sidebar
  // Update pill). No-op tick until an admin configures a GitHub PAT/repo —
  // see services/updates/checkForUpdates.ts.
  startUpdateCheckWorker()
  // v1.333.0: scheduled-maintenance-window restart trigger. No-op tick until
  // a default admin schedules one — see services/updates/restartScheduler.ts.
  startRestartScheduler()
}

app.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok', setupMode: SETUP_MODE, dbError: dbConnectionError }, error: null, meta: {} })
})

// v1.440.0: readiness, as opposed to /health's liveness. /health answers "is
// the process serving?" and is what the Dockerfile HEALTHCHECK uses, so a
// database outage never makes Docker restart the app in a loop. /ready also
// runs a query, so a load balancer or uptime monitor can stop sending
// traffic (or alert) while Postgres is unreachable. 503 until it can.
const READY_TIMEOUT_MS = 3000
app.get('/ready', async (req, res) => {
  const notReady = (reason: string) => {
    noteReadyCall(req.get('user-agent'), false)
    res.status(503).json({ data: { status: 'not_ready', reason }, error: null, meta: {} })
  }
  if (SETUP_MODE) { notReady('setup_mode'); return }
  if (dbConnectionError) { notReady('database_unreachable'); return }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { db } = await import('./db/index.js')
    const { sql } = await import('drizzle-orm')
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS) }),
    ])
    noteReadyCall(req.get('user-agent'), true)
    res.json({ data: { status: 'ready' }, error: null, meta: {} })
  } catch {
    notReady('database_unreachable')
  } finally {
    if (timer) clearTimeout(timer)
  }
})

// v1.106.0: dynamic email asset routes — theme logos are stored as
// data URIs in app_themes / systemSettings, so we decode + serve them
// as real image bytes over HTTP. Registered BEFORE the /public static
// handler so /public/theme-logo/:themeId/:variant.png doesn't fall
// through to the file system.
app.get('/public/theme-logo/:themeId/:variant.png', async (req, res) => {
  try {
    const { serveThemeLogo } = await import('./services/email/logo.js')
    await serveThemeLogo(req.params.themeId, req.params.variant as 'light' | 'dark', res)
  } catch (err) {
    res.status(500).send('logo error')
  }
})

// v1.106.0: /public serves logo assets referenced by outbound emails as
// hosted HTTPS URLs (Outlook renders them without a "Download pictures"
// prompt when the app URL is on a domain the recipient's org trusts).
// Long cache-control since these change rarely; cache-bust via
// ?v=<version> if you swap the file.
const publicDir = path.resolve(process.cwd(), 'public')
app.use('/public', express.static(publicDir, { maxAge: '7d', fallthrough: true }))

// Serve client bundle (production). In dev the client is served by Vite on a separate port.
const clientDist = path.resolve(process.cwd(), 'src/client/dist')
app.use(express.static(clientDist))
app.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path === '/health' || req.path === '/ready') return next()
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next()
  })
})

// Reports errors that reach Express, then passes them on unchanged.
app.use(errorTrackingMiddleware)

async function start() {
  if (isDbConfigured()) {
    try {
      await runMigrations()
      console.log('Database migrations applied')
      await loadIntegrationConfigs()
      await loadAuthPolicy()
      await loadRateLimitSettings()
      // v1.475.0: an install started with DATABASE_URL already set never sees
      // the /setup wizard, so with no account yet it prints the setup token
      // for the sign-in page's "Create the first admin" form.
      if (await needsFirstAdmin()) {
        const setup = getOrCreateSetupToken()
        console.log('[first-run] No accounts yet. Open the app and choose "Create the first admin".')
        console.log(setup.fromEnv
          ? '[first-run] Setup token: the value of SETUP_TOKEN.'
          : `[first-run] Setup token: ${setup.token}`)
      }
      // v1.471.1: stored Outlook Windows timezone names → IANA ids. Non-fatal.
      try {
        const { updated } = await normalizeStoredTimezones()
        if (updated > 0) console.log(`Converted ${updated} stored Windows timezone name(s) to IANA ids`)
      } catch (tzErr) {
        console.error('Timezone normalization failed (non-fatal):', tzErr)
      }
    } catch (err) {
      // v1.247.0: was process.exit(1) — see dbConnectionError's comment
      // above for why that's worse than staying up and reporting the real
      // error. loadIntegrationConfigs/loadAuthPolicy/loadRateLimitSettings
      // also need a working DB, so they're skipped too rather than thrown
      // separately once migrate() has already failed.
      //
      // Drizzle wraps the real connection error (DNS failure, auth
      // rejection, wrong database name, ...) in a generic "Failed query:
      // CREATE SCHEMA..." message via `cause` — surface that instead when
      // present, since it's the part that actually tells an admin what to
      // fix in their DATABASE_URL.
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null
      const reported: unknown = cause ?? err
      dbConnectionError = reported instanceof Error ? reported.message : String(reported)
      console.error('Database migrations failed — server will keep listening and report this on /api and /auth instead of exiting:', err)
    }
  }
  settleMigrations()
  app.listen(port, () => {
    console.log(`ImpactIQ server running on port ${port}${SETUP_MODE ? ' (setup mode)' : ''}${dbConnectionError ? ' (DB unreachable)' : ''}`)
  })
}

void start()

export default app
