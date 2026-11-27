import { Router } from 'express'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users, userIntegrations } from '../../../../drizzle/schema.js'
import { requireAuth } from '../../middleware/auth.js'
import { encryptToken } from '../../services/auth/salesforce.js'
import { normalizeTimeZone } from '../../../shared/windowsTimezones.js'
import {
  exchangeAuthorizationCode as exchangeMsCode,
  getMicrosoftAuthUrl,
  isMicrosoftConfigured,
  signCallbackState as signMsState,
  verifyOAuthState as verifyMsState,
} from '../../services/auth/microsoft.js'
import {
  MS_BINDING_COOKIE_PREFIX,
  checkOAuthBinding,
  clearOAuthBindingCookie,
  generateBindingNonce,
  setOAuthBindingCookie,
} from './oauthBinding.js'

export const microsoftAuthRoutes = Router()

// --- Microsoft Graph OAuth (Outlook calendar) ---

// Default: attempt silent SSO via Microsoft browser session (prompt=none).
// On interaction_required / consent_required / login_required the callback
// re-initiates the flow with prompt=select_account.
// Pass ?interactive=1 to skip the silent attempt (used by the callback fallback).
microsoftAuthRoutes.get('/microsoft', requireAuth, (req, res) => {
  if (!isMicrosoftConfigured()) {
    res.status(503).json({ data: null, error: 'errors.microsoft.oauth_not_configured', meta: {} })
    return
  }
  const interactive = req.query['interactive'] === '1'
  const silent = !interactive
  // Encode whether this was a silent attempt into the state so the callback can fall back.
  const stateUserId = silent ? `silent:${req.user!.id}` : req.user!.id
  const nonce = generateBindingNonce()
  const state = signMsState(stateUserId, nonce)
  const url = getMicrosoftAuthUrl(state, silent ? { silent: true, loginHint: req.user!.email, req } : { req })
  if (!url) {
    res.status(503).json({ data: null, error: 'errors.microsoft.oauth_not_configured', meta: {} })
    return
  }
  setOAuthBindingCookie(res, MS_BINDING_COOKIE_PREFIX, state, { nonce, userId: req.user!.id })
  res.redirect(url)
})

microsoftAuthRoutes.get('/microsoft/callback', async (req, res) => {
  const code = req.query['code']
  const state = req.query['state']
  const errorParam = req.query['error']

  // Best-effort: unwrap the silent: prefix to detect a failed silent attempt.
  let wasSilent = false
  if (typeof state === 'string') {
    const sd = verifyMsState(state)
    if (sd?.userId.startsWith('silent:')) wasSilent = true
  }

  if (typeof errorParam === 'string') {
    // Silent SSO failed (no MS session, no prior consent, etc.) — fall back to interactive.
    const SILENT_FAIL_ERRORS = ['interaction_required', 'consent_required', 'login_required', 'account_selection_required']
    if (wasSilent && SILENT_FAIL_ERRORS.includes(errorParam)) {
      res.redirect('/auth/microsoft?interactive=1')
      return
    }
    res.redirect(`/?msConnect=error&reason=${encodeURIComponent(errorParam)}`)
    return
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).json({ data: null, error: 'errors.oauth.missing_params', meta: {} })
    return
  }

  const rawState = verifyMsState(state)
  if (!rawState) {
    res.status(400).json({ data: null, error: 'errors.oauth.invalid_state', meta: {} })
    return
  }
  // Unwrap silent: prefix to recover the real user id.
  const stateData = { userId: rawState.userId.startsWith('silent:') ? rawState.userId.slice('silent:'.length) : rawState.userId }

  // v1.423.0: same browser (binding cookie, same nonce) and same signed-in
  // user as the one who started the flow, so a crafted callback link can't
  // attach one person's mailbox to someone else's ImpactIQ account.
  const binding = await checkOAuthBinding(req, MS_BINDING_COOKIE_PREFIX, state, { nonce: rawState.nonce, userId: stateData.userId })
  clearOAuthBindingCookie(res, MS_BINDING_COOKIE_PREFIX, state)
  if (!binding) {
    res.redirect(`/?msConnect=error&reason=${encodeURIComponent('errors.oauth.session_mismatch')}`)
    return
  }

  let tokens
  try {
    tokens = await exchangeMsCode(code, req)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.redirect(`/?msConnect=error&reason=${encodeURIComponent(message)}`)
    return
  }

  const accessTokenEncrypted = encryptToken(tokens.access_token)
  const refreshTokenEncrypted = tokens.refresh_token ? encryptToken(tokens.refresh_token) : null
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000)

  // Best-effort: fetch UPN / mail via Graph /me so My Settings can show
  // which mailbox is wired up.
  let msAccountLabel: string | null = null
  try {
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (meRes.ok) {
      const meData = await meRes.json() as { userPrincipalName?: string; mail?: string }
      msAccountLabel = meData.mail ?? meData.userPrincipalName ?? null
    }
  } catch {
    // Non-fatal
  }

  const [existing] = await db
    .select({ id: userIntegrations.id })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, stateData.userId), eq(userIntegrations.provider, 'microsoft')))
    .limit(1)

  if (existing) {
    await db
      .update(userIntegrations)
      .set({
        lastError: null,
        lastErrorAt: null,
        accessTokenEncrypted,
        ...(refreshTokenEncrypted && { refreshTokenEncrypted }),
        ...(msAccountLabel && { accountLabel: msAccountLabel }),
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(userIntegrations.id, existing.id))
  } else {
    await db.insert(userIntegrations).values({
      userId: stateData.userId,
      provider: 'microsoft',
      accessTokenEncrypted,
      refreshTokenEncrypted,
      accountLabel: msAccountLabel,
      expiresAt,
    })
  }

  // Fetch the user's mailbox timezone from Graph and persist it so activity
  // datetimes are always stored and synced to the CRM in the correct zone.
  // Connecting Outlook takes precedence over an earlier pick (timezone_source
  // goes back to 'auto'); the user can override it again on My Settings.
  // Flag `tzSwitched=1` on the redirect so the client can surface a one-time
  // banner when Outlook replaces a timezone the user had set.
  let tzSwitched = false
  try {
    const [before] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, stateData.userId)).limit(1)
    const mbRes = await fetch('https://graph.microsoft.com/v1.0/me/mailboxSettings', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (mbRes.ok) {
      const mbData = await mbRes.json() as { timeZone?: string }
      // v1.471.1: stored as an IANA id (Graph usually sends a Windows name).
      const tz = normalizeTimeZone(mbData.timeZone)
      if (tz) {
        await db.update(users)
          .set({ timezone: tz, outlookTimezone: tz, timezoneSource: 'auto', timezoneCheckedAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, stateData.userId))
        if (before?.timezone && before.timezone !== tz && before.timezone !== 'UTC') {
          tzSwitched = true
        }
      }
    }
  } catch {
    // Non-fatal: timezone stays as previously stored value
  }

  res.redirect(`/?msConnect=success${tzSwitched ? '&tzSwitched=1' : ''}`)
})

microsoftAuthRoutes.post('/microsoft/disconnect', requireAuth, async (req, res) => {
  await db
    .delete(userIntegrations)
    .where(and(eq(userIntegrations.userId, req.user!.id), eq(userIntegrations.provider, 'microsoft')))
  // The app timezone stays as it is; only the mailbox's own copy goes, so
  // Settings stops offering an Outlook timezone that can no longer refresh.
  await db.update(users).set({ outlookTimezone: null, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// GET /auth/microsoft/status — for the frontend to know if Outlook is connected.
microsoftAuthRoutes.get('/microsoft/status', requireAuth, async (req, res) => {
  const userId = req.user!.id
  const [row] = await db
    .select({ id: userIntegrations.id, expiresAt: userIntegrations.expiresAt, accountLabel: userIntegrations.accountLabel, updatedAt: userIntegrations.updatedAt })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'microsoft')))
    .limit(1)

  // v1.80.0: lazy backfill for pre-v1.78 Outlook connections. Hit Graph /me
  // once, persist, and return immediately on subsequent loads.
  let accountLabel = row?.accountLabel ?? null
  if (row && !accountLabel) {
    try {
      const { getMicrosoftAccessToken } = await import('../../services/outlook/client.js')
      const token = await getMicrosoftAccessToken(userId)
      if (token) {
        const meRes = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${token}` } })
        if (meRes.ok) {
          const meData = await meRes.json() as { userPrincipalName?: string; mail?: string }
          accountLabel = meData.mail ?? meData.userPrincipalName ?? null
          if (accountLabel) {
            await db.update(userIntegrations).set({ accountLabel, updatedAt: new Date() }).where(eq(userIntegrations.id, row.id))
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // v1.197.0: probe the stored token like the SF status does, so the UI can
  // distinguish "we have a row" from "the token still works". A refresh that
  // fails (revoked consent, expired refresh token) means the calendar panel
  // will silently return nothing until the user reconnects.
  let healthy = false
  if (row) {
    try {
      const { getMicrosoftAccessToken } = await import('../../services/outlook/client.js')
      const token = await getMicrosoftAccessToken(userId)
      healthy = !!token
    } catch {
      healthy = false
    }
  }

  res.json({
    data: {
      connected: !!row,
      healthy,
      configured: isMicrosoftConfigured(),
      accountLabel,
      connectedAt: row?.updatedAt ?? null,
    },
    error: null,
    meta: {},
  })
})
