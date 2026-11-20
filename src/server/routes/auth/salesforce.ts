import { Router } from 'express'
import { assertSalesforceLoginUrl } from '../../services/net/ssrfGuard.js'
import { safeFetch } from '../../services/net/safeFetch.js'
import { requireCrmProvider, isCrmProviderActive } from '../../services/crm/index.js'
import { safeSoqlLiteral } from '../../services/salesforce/soql.js'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users, userIntegrations, systemSettings } from '../../../../drizzle/schema.js'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { ADMIN_SF_SETTINGS_KEY, type AdminSfConnectionRecord } from '../../services/salesforce/client.js'
import { requireAuth } from '../../middleware/auth.js'
import {
  encryptToken,
  exchangeAuthorizationCode,
  generatePkce,
  getSalesforceAuthUrl,
  isSalesforceConfigured,
  signOAuthState,
  verifyOAuthState,
} from '../../services/auth/salesforce.js'
import {
  SF_BINDING_COOKIE_PREFIX,
  checkOAuthBinding,
  clearOAuthBindingCookie,
  generateBindingNonce,
  setOAuthBindingCookie,
} from './oauthBinding.js'

export const salesforceAuthRoutes = Router()

// --- Salesforce OAuth (authorization-code flow with HMAC-signed state) ---

// GET /auth/salesforce — initiate OAuth: redirect the logged-in user to Salesforce.
salesforceAuthRoutes.get('/salesforce', requireAuth, requireCrmProvider('salesforce'), async (req, res) => {
  if (!isSalesforceConfigured()) {
    res.status(503).json({ data: null, error: 'errors.salesforce.oauth_not_configured', meta: {} })
    return
  }
  const { verifier, challenge } = generatePkce()
  const nonce = generateBindingNonce()
  const state = signOAuthState(req.user!.id, nonce)
  // On a RECONNECT, the tenant's fallback login URL may point at a
  // different environment than the org the user was originally
  // connected to (a common trap: admin-level config was set to
  // test.salesforce.com but this user's org is prod, or vice versa).
  // Use the user's stored instanceUrl if we have one — Salesforce
  // accepts OAuth authorize at any org host (my.salesforce.com or
  // login/test.salesforce.com), and this routes the reconnect back
  // to the same org.
  const [existing] = await db
    .select({ instanceUrl: userIntegrations.instanceUrl })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, req.user!.id), eq(userIntegrations.provider, 'salesforce')))
    .limit(1)
  const url = getSalesforceAuthUrl(state, challenge, existing?.instanceUrl ?? null)
  if (!url) {
    res.status(503).json({ data: null, error: 'errors.salesforce.oauth_not_configured', meta: {} })
    return
  }
  setOAuthBindingCookie(res, SF_BINDING_COOKIE_PREFIX, state, { nonce, userId: req.user!.id, verifier })
  res.redirect(url)
})

// GET /auth/salesforce/callback — exchange code, encrypt + persist tokens, redirect home.
salesforceAuthRoutes.get('/salesforce/callback', async (req, res) => {
  const code = req.query['code']
  const state = req.query['state']
  const errorParam = req.query['error']

  if (typeof errorParam === 'string') {
    res.redirect(`/?sfConnect=error&reason=${encodeURIComponent(errorParam)}`)
    return
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).json({ data: null, error: 'errors.oauth.missing_params', meta: {} })
    return
  }

  const stateData = verifyOAuthState(state)
  if (!stateData) {
    res.status(400).json({ data: null, error: 'errors.oauth.invalid_state', meta: {} })
    return
  }

  const isAdminFlow = stateData.userId.startsWith('admin:')
  const actorUserId = isAdminFlow ? stateData.userId.slice('admin:'.length) : stateData.userId
  const errorRedirect = isAdminFlow ? '/admin?sfAdminConnect=error&reason=' : '/?sfConnect=error&reason='

  // v1.423.0: the callback must land in the browser that started the flow
  // (binding cookie, same nonce) and that browser must still be signed in as
  // the user the state names. Otherwise a crafted callback link could attach
  // one person's Salesforce tokens to someone else's ImpactIQ account.
  const binding = await checkOAuthBinding(req, SF_BINDING_COOKIE_PREFIX, state, { nonce: stateData.nonce, userId: actorUserId })
  clearOAuthBindingCookie(res, SF_BINDING_COOKIE_PREFIX, state)
  if (!binding?.verifier) {
    res.redirect(`${errorRedirect}${encodeURIComponent('errors.oauth.session_mismatch')}`)
    return
  }

  // Token exchange must hit the same host that authorized the code —
  // if we redirected the user to their my.salesforce.com for reconnect,
  // exchange there too. Admin flows read the tenant-wide admin SF
  // record; user flows read the caller's user_integrations row.
  let hostOverride: string | null = null
  try {
    if (isAdminFlow) {
      const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, ADMIN_SF_SETTINGS_KEY)).limit(1)
      const existing = (row?.value as AdminSfConnectionRecord | undefined) ?? null
      hostOverride = existing?.instanceUrl ?? null
    } else {
      const [existing] = await db
        .select({ instanceUrl: userIntegrations.instanceUrl })
        .from(userIntegrations)
        .where(and(eq(userIntegrations.userId, actorUserId), eq(userIntegrations.provider, 'salesforce')))
        .limit(1)
      hostOverride = existing?.instanceUrl ?? null
    }
  } catch { /* fall back to tenant default */ }

  let tokens
  try {
    tokens = await exchangeAuthorizationCode(code, binding.verifier, hostOverride)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.redirect(`${errorRedirect}${encodeURIComponent(message)}`)
    return
  }

  if (isAdminFlow) {
    const record: AdminSfConnectionRecord = {
      userId: actorUserId,
      accessTokenEncrypted: encryptToken(tokens.access_token),
      refreshTokenEncrypted: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
      instanceUrl: tokens.instance_url,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await db
      .insert(systemSettings)
      .values({ key: ADMIN_SF_SETTINGS_KEY, value: record })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: record, updatedAt: new Date() } })
    // The token just came from a fresh OAuth exchange, so it's valid.
    // Overwrite the cached health immediately — otherwise the status probe
    // keeps serving the stale "unhealthy" verdict (recent checkedAt) for up
    // to 60s, leaving the "token not working" banner up until the admin
    // clicks Test Connection.
    setAdminSfHealth(true)
    res.redirect('/admin?sfAdminConnect=success')
    return
  }

  const accessTokenEncrypted = encryptToken(tokens.access_token)
  const refreshTokenEncrypted = tokens.refresh_token ? encryptToken(tokens.refresh_token) : null
  // SF token endpoint does not return expires_in; use a 2h working window. getSfConnection refreshes
  // proactively, and a 401 in jsforce would trigger another refresh on the next call.
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000)

  // Resolve the SF user id from the `id` URL (it's like https://login.salesforce.com/id/<orgId>/<userId>).
  let crmUserId: string | null = null
  try {
    const idParts = new URL(tokens.id).pathname.split('/').filter(Boolean)
    crmUserId = idParts[idParts.length - 1] ?? null
  } catch {
    crmUserId = null
  }

  // Best-effort: fetch identity from SF `id` URL so My Settings can show
  // "Connected as jane@example.com" instead of just "Connected".
  let sfAccountLabel: string | null = null
  try {
    if (tokens.id) {
      // The id URL comes back from Salesforce; only send the access token to
      // a Salesforce host.
      await assertSalesforceLoginUrl(tokens.id)
      const idRes = await safeFetch(tokens.id, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
      if (idRes.ok) {
        const idData = await idRes.json() as { username?: string; email?: string; preferred_username?: string }
        sfAccountLabel = idData.username ?? idData.preferred_username ?? idData.email ?? null
      }
    }
  } catch {
    // Non-fatal: label stays null
  }

  const [existing] = await db
    .select({ id: userIntegrations.id })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, stateData.userId), eq(userIntegrations.provider, 'salesforce')))
    .limit(1)

  if (existing) {
    await db
      .update(userIntegrations)
      .set({
        lastError: null,
        lastErrorAt: null,
        accessTokenEncrypted,
        ...(refreshTokenEncrypted && { refreshTokenEncrypted }),
        instanceUrl: tokens.instance_url,
        ...(sfAccountLabel && { accountLabel: sfAccountLabel }),
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(userIntegrations.id, existing.id))
  } else {
    await db.insert(userIntegrations).values({
      userId: stateData.userId,
      provider: 'salesforce',
      accessTokenEncrypted,
      refreshTokenEncrypted,
      instanceUrl: tokens.instance_url,
      accountLabel: sfAccountLabel,
      expiresAt,
    })
  }

  if (crmUserId) {
    await db.update(users).set({ crmUserId, updatedAt: new Date() }).where(eq(users.id, stateData.userId))
  }

  // If the user has no timezone yet (or it's the "UTC" sentinel), seed it
  // from SF User.TimeZoneSidKey so the app has a sensible default before
  // Outlook has ever been connected. Outlook connect (below) will overwrite
  // it — that's the intended precedence (Outlook > Salesforce > UTC).
  try {
    const [currentUser] = await db
      .select({ timezone: users.timezone, source: users.timezoneSource })
      .from(users)
      .where(eq(users.id, stateData.userId))
      .limit(1)
    // v1.469.0: a timezone the user picked themselves (even UTC) is left alone.
    const needsSeed = currentUser?.source === 'auto' && (!currentUser.timezone || currentUser.timezone === 'UTC')
    if (needsSeed && crmUserId) {
      const jsforce = (await import('jsforce')).default
      const conn = new jsforce.Connection({ accessToken: tokens.access_token, instanceUrl: tokens.instance_url })
      const q = await conn.query(`SELECT TimeZoneSidKey FROM User WHERE Id = '${safeSoqlLiteral(crmUserId)}' LIMIT 1`)
      const first = q.records[0] as { TimeZoneSidKey?: string } | undefined
      if (first?.TimeZoneSidKey) {
        await db.update(users).set({ timezone: first.TimeZoneSidKey, updatedAt: new Date() }).where(eq(users.id, stateData.userId))
      }
    }
  } catch (err) {
    console.warn('[sf-callback] SF timezone seed failed:', err instanceof Error ? err.message : String(err))
  }

  res.redirect('/?sfConnect=success')
})

// GET /auth/salesforce/status — for the frontend to know if SF is connected.
salesforceAuthRoutes.get('/salesforce/status', requireAuth, async (req, res) => {
  const userId = req.user!.id
  // When the install uses another CRM (or none), Salesforce reads as not
  // configured everywhere: the sidebar button, My Settings, banners.
  if (!(await isCrmProviderActive('salesforce'))) {
    res.json({ data: { connected: false, configured: false, instanceUrl: null, accountLabel: null, connectedAt: null }, error: null, meta: {} })
    return
  }
  const [row] = await db
    .select({
      id: userIntegrations.id,
      expiresAt: userIntegrations.expiresAt,
      instanceUrl: userIntegrations.instanceUrl,
      accountLabel: userIntegrations.accountLabel,
      updatedAt: userIntegrations.updatedAt,
    })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'salesforce')))
    .limit(1)

  // v1.80.0: lazy backfill for connections that pre-date v1.78 (when we
  // started capturing account_label at OAuth callback time). If we're
  // connected but have no label yet, hit SF's identity endpoint once and
  // persist it so subsequent loads are instant.
  let accountLabel = row?.accountLabel ?? null
  if (row && !accountLabel) {
    try {
      const { getSfConnection } = await import('../../services/salesforce/client.js')
      const conn = await getSfConnection(userId)
      if (conn) {
        const identity = await conn.identity() as { username?: string; email?: string; preferred_username?: string }
        accountLabel = identity.username ?? identity.preferred_username ?? identity.email ?? null
        if (accountLabel) {
          await db.update(userIntegrations).set({ accountLabel, updatedAt: new Date() }).where(eq(userIntegrations.id, row.id))
        }
      }
    } catch {
      // Non-fatal: leave label null, UI shows "Connected" without the "as X" line.
    }
  }

  // v1.99.0: probe the token against SF's identity endpoint so the UI
  // can distinguish "we have a row" from "the token still works". If
  // the row backfill above already ran identity() successfully, we
  // consider that a health signal too. On failure the UI shows a
  // banner nudging the user to reconnect from My Settings.
  let healthy = false
  if (row) {
    if (accountLabel && row.accountLabel) {
      // We have a persisted account label from a prior good call —
      // trust it as healthy unless a probe explicitly fails.
      healthy = true
    }
    try {
      const { getSfConnection } = await import('../../services/salesforce/client.js')
      const conn = await getSfConnection(userId)
      if (conn) {
        await conn.identity()
        healthy = true
      } else {
        healthy = false
      }
    } catch {
      healthy = false
    }
  }

  res.json({
    data: {
      connected: !!row,
      healthy,
      configured: isSalesforceConfigured(),
      instanceUrl: row?.instanceUrl ?? null,
      accountLabel,
      connectedAt: row?.updatedAt ?? null,
    },
    error: null,
    meta: {},
  })
})

// POST /auth/salesforce/disconnect — revoke the local copy (does not call SF revoke endpoint).
salesforceAuthRoutes.post('/salesforce/disconnect', requireAuth, async (req, res) => {
  await db
    .delete(userIntegrations)
    .where(and(eq(userIntegrations.userId, req.user!.id), eq(userIntegrations.provider, 'salesforce')))
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// --- Admin-scoped Salesforce connection (metadata introspection only) ---
// This connection is used by the App Admin to populate config dropdowns
// (field mappings, picklist values). It is NEVER used to read or write
// contributor activity data — those always run as the contributor's own
// SF identity so SF access controls are respected.

salesforceAuthRoutes.get('/salesforce-admin', requireAuth, requireAppAdmin, requireCrmProvider('salesforce'), async (req, res) => {
  if (!isSalesforceConfigured()) {
    res.status(503).json({ data: null, error: 'errors.salesforce.oauth_not_configured', meta: {} })
    return
  }
  const { verifier, challenge } = generatePkce()
  const nonce = generateBindingNonce()
  const state = signOAuthState(`admin:${req.user!.id}`, nonce)
  // On RECONNECT, honor the previously-connected instance URL so we
  // don't fall back to test.salesforce.com when the tenant fallback
  // and the actual admin org differ. Mirrors the user-side fix from
  // v1.65.2 for /auth/salesforce.
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, ADMIN_SF_SETTINGS_KEY)).limit(1)
  const existing = (row?.value as AdminSfConnectionRecord | undefined) ?? null
  const url = getSalesforceAuthUrl(state, challenge, existing?.instanceUrl ?? null)
  if (!url) {
    res.status(503).json({ data: null, error: 'errors.salesforce.oauth_not_configured', meta: {} })
    return
  }
  setOAuthBindingCookie(res, SF_BINDING_COOKIE_PREFIX, state, { nonce, userId: req.user!.id, verifier })
  res.redirect(url)
})

// v1.73.0: cache the live health-check for 60s so a page that loads
// this endpoint on mount doesn't hammer Salesforce.
let adminSfHealthCache: { healthy: boolean; error: string | null; checkedAt: number } | null = null

// v1.108.0: allow the admin Test Connection route (and reconnect
// callback) to overwrite the cached health so the "token not working"
// banner clears immediately instead of waiting up to 60s for the
// staleness window to expire.
export function setAdminSfHealth(healthy: boolean, error: string | null = null): void {
  adminSfHealthCache = { healthy, error, checkedAt: Date.now() }
}
salesforceAuthRoutes.get('/salesforce-admin/status', requireAuth, requireAppAdmin, async (_req, res) => {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, ADMIN_SF_SETTINGS_KEY)).limit(1)
  const record = (row?.value as AdminSfConnectionRecord | undefined) ?? null
  let connectedByEmail: string | null = null
  if (record?.userId) {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, record.userId)).limit(1)
    connectedByEmail = u?.email ?? null
  }
  // Best-effort live probe. When the admin token expires or was
  // revoked, dropdowns across Admin + the Activity form silently
  // return empty; there was no way for admins to see "the SF piece
  // is broken, click Reconnect". This surfaces it explicitly.
  let health = adminSfHealthCache
  const STALE_MS = 60_000
  const now = Date.now()
  if (record && (!health || (now - health.checkedAt) > STALE_MS)) {
    try {
      const { getAdminSfConnection } = await import('../../services/salesforce/client.js')
      const conn = await getAdminSfConnection()
      if (!conn) throw new Error('admin_sf_no_connection')
      // Cheapest possible read: describe the User object. Fails fast
      // when the token is bad. Full sobject list would be heavier.
      await conn.sobject('User').describe()
      health = { healthy: true, error: null, checkedAt: now }
    } catch (err) {
      health = { healthy: false, error: err instanceof Error ? err.message : String(err), checkedAt: now }
    }
    adminSfHealthCache = health
  }
  res.json({
    data: {
      connected: !!record,
      configured: isSalesforceConfigured(),
      instanceUrl: record?.instanceUrl ?? null,
      connectedByEmail,
      connectedAt: record?.updatedAt ?? null,
      tokenHealthy: record ? (health?.healthy ?? null) : null,
      tokenError: record ? (health?.error ?? null) : null,
    },
    error: null,
    meta: {},
  })
})

salesforceAuthRoutes.post('/salesforce-admin/disconnect', requireAuth, requireAppAdmin, async (_req, res) => {
  await db.delete(systemSettings).where(eq(systemSettings.key, ADMIN_SF_SETTINGS_KEY))
  res.json({ data: { ok: true }, error: null, meta: {} })
})
