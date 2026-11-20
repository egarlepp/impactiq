import { Router } from 'express'
import { isUserDisabled } from '../../services/auth/userStatus.js'
import { ssoErrorReason } from '../../../shared/ssoErrors.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users } from '../../../../drizzle/schema.js'
import { authMethodAllowsAzure } from '../../../shared/schemas/password.js'
import { setSessionCookie } from '../../services/auth/session.js'
import { recordLoginEvent, recordLoginFailure } from '../../services/auth/loginDetection.js'
import {
  exchangeAuthorizationCode as exchangeAzureCode,
  fetchUserInfo as fetchAzureUserInfo,
  getAzureAuthUrl,
  generateNonce as generateAzureNonce,
  generatePkce as generateAzurePkce,
  isAzureSsoConfigured,
  getAzureSsoConfig,
  signOAuthState as signAzureState,
  verifyOAuthState as verifyAzureState,
  verifyAzureIdToken,
} from '../../services/auth/azureSso.js'

import { oidcLimiter, encryptPkceParams, decryptPkceParams } from './oidc.js'

export const azureAuthRoutes = Router()

// --- Azure AD / Entra ID OIDC (authorization-code flow) ---
// Mirrors the Okta flow but on its OWN callback path (/auth/azure/callback) so
// both providers can be enabled at once without colliding.

const AZURE_PARAMS_COOKIE_PREFIX = 'impactiq_azure_params_'

// GET /auth/azure/configured — public; lets the login page show the button.
azureAuthRoutes.get('/azure/configured', (_req, res) => {
  res.json({ data: { configured: isAzureSsoConfigured() }, error: null, meta: {} })
})

// GET /auth/azure — redirect to Azure for sign-in with PKCE + nonce.
azureAuthRoutes.get('/azure', oidcLimiter, async (_req, res) => {
  if (!isAzureSsoConfigured()) {
    res.status(503).json({ data: null, error: 'errors.azure_sso.not_configured', meta: {} })
    return
  }
  const nonce = generateAzureNonce()
  const state = signAzureState(nonce)
  const pkce = generateAzurePkce()
  const url = await getAzureAuthUrl(state, { nonce, codeChallenge: pkce.challenge })
  if (!url) {
    res.status(503).json({ data: null, error: 'errors.azure_sso.discovery_failed', meta: {} })
    return
  }
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : ''
  const cookieName = AZURE_PARAMS_COOKIE_PREFIX + state.slice(0, 24)
  const cookieValue = encodeURIComponent(encryptPkceParams(pkce.verifier, nonce))
  res.setHeader('Set-Cookie', `${cookieName}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`)
  res.redirect(url)
})

// GET /auth/azure/callback — Azure OIDC callback. JIT-provisions on first login
// (when allowJit) as a Contributor with no default team, then issues a session.
azureAuthRoutes.get('/azure/callback', oidcLimiter, async (req, res) => {
  if (!isAzureSsoConfigured()) {
    res.status(503).json({ data: null, error: 'errors.azure_sso.not_configured', meta: {} })
    return
  }
  const code = req.query['code']
  const state = req.query['state']
  const errorParam = req.query['error']
  if (typeof errorParam === 'string') {
    console.warn('[azure callback] identity provider returned an error:', errorParam.replace(/[^\w.-]/g, '').slice(0, 100))
    res.redirect(`/?ssoConnect=error&reason=${ssoErrorReason(errorParam)}`)
    return
  }
  if (typeof code !== 'string' || typeof state !== 'string') { res.status(400).json({ data: null, error: 'errors.oauth.missing_params', meta: {} }); return }
  if (!verifyAzureState(state)) { res.status(400).json({ data: null, error: 'errors.oauth.invalid_state', meta: {} }); return }

  const paramsCookieName = AZURE_PARAMS_COOKIE_PREFIX + state.slice(0, 24)
  const cookieHeader = req.headers['cookie'] ?? ''
  const paramsRaw = (() => {
    for (const part of cookieHeader.split(';')) {
      const t = part.trim()
      if (t.startsWith(paramsCookieName + '=')) return decodeURIComponent(t.slice(paramsCookieName.length + 1))
    }
    return null
  })()
  const clearParamsCookie = process.env['NODE_ENV'] === 'production'
    ? `${paramsCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure`
    : `${paramsCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  res.append('Set-Cookie', clearParamsCookie)
  if (!paramsRaw) { res.status(400).json({ data: null, error: 'errors.oauth.pkce_missing', meta: {} }); return }
  let pkceParams: { v: string; n: string }
  try { pkceParams = decryptPkceParams(paramsRaw) }
  catch { res.status(400).json({ data: null, error: 'errors.oauth.pkce_missing', meta: {} }); return }

  let tokens, info, idClaims
  try {
    tokens = await exchangeAzureCode(code, pkceParams.v)
    idClaims = await verifyAzureIdToken(tokens.id_token, pkceParams.n)
    info = await fetchAzureUserInfo(tokens.access_token)
  } catch (err) {
    console.warn('[azure callback]', err instanceof Error ? err.message : String(err))
    res.redirect('/?ssoConnect=error&reason=errors.auth.sso_failed')
    return
  }

  // Resolve email from the verified id_token first, then userinfo, then the UPN.
  const email = (typeof idClaims.email === 'string' && idClaims.email)
    || info.email
    || info.preferred_username
    || (typeof idClaims.preferred_username === 'string' ? idClaims.preferred_username : undefined)
  if (!email || !email.includes('@')) {
    res.redirect('/?ssoConnect=error&reason=errors.auth.sso_no_email')
    return
  }
  const emailLower = email.toLowerCase()
  // Azure object id (oid) is stable per tenant; fall back to sub.
  const azureOid = (typeof idClaims['oid'] === 'string' && idClaims['oid']) ? idClaims['oid'] as string : idClaims.sub
  const displayName = info.name ?? (typeof idClaims.name === 'string' ? idClaims.name : undefined) ?? info.preferred_username ?? emailLower

  const [byAzure] = await db.select({ id: users.id, authMethod: users.authMethod }).from(users).where(eq(users.azureId, azureOid)).limit(1)
  let userId: string
  if (byAzure) {
    if (!authMethodAllowsAzure(byAzure.authMethod)) { res.redirect('/?ssoConnect=error&reason=errors.auth.sso_method_not_allowed'); return }
    await db.update(users).set({ email: emailLower, displayName, updatedAt: new Date() }).where(eq(users.id, byAzure.id))
    userId = byAzure.id
  } else {
    const [byEmail] = await db.select({ id: users.id, authMethod: users.authMethod }).from(users).where(eq(users.email, emailLower)).limit(1)
    if (byEmail) {
      if (!authMethodAllowsAzure(byEmail.authMethod)) { res.redirect('/?ssoConnect=error&reason=errors.auth.sso_method_not_allowed'); return }
      await db.update(users).set({ azureId: azureOid, displayName, updatedAt: new Date() }).where(eq(users.id, byEmail.id))
      userId = byEmail.id
    } else {
      // No matching user. JIT only when the admin enabled it; provision as a
      // Contributor with NO default team (admin assigns team/role afterward).
      const cfg = getAzureSsoConfig()
      if (!cfg?.allowJit) {
        res.redirect('/?ssoConnect=error&reason=errors.auth.sso_no_account')
        return
      }
      const { randomUUID } = await import('node:crypto')
      const [inserted] = await db.insert(users)
        .values({ oktaId: `azure:${randomUUID()}`, azureId: azureOid, email: emailLower, displayName })
        .returning({ id: users.id })
      if (!inserted) { res.redirect('/?ssoConnect=error&reason=errors.auth.sso_failed'); return }
      userId = inserted.id
    }
  }

  // v1.425.0 (security audit L8): a disabled account can't sign in.
  if (await isUserDisabled(userId)) {
    void recordLoginFailure({ userId, attemptedEmail: emailLower, reason: 'user_disabled', method: 'azure', req })
    res.redirect('/?ssoConnect=error&reason=errors.auth.account_disabled')
    return
  }
  await setSessionCookie(res, userId, req, 'azure')
  void recordLoginEvent({ userId, method: 'azure', req })
  res.redirect('/')
})
