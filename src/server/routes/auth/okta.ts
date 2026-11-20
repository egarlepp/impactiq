import { Router } from 'express'
import { isUserDisabled } from '../../services/auth/userStatus.js'
import { ssoErrorReason } from '../../../shared/ssoErrors.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users, teamMembers, oktaGroupRoleMappings } from '../../../../drizzle/schema.js'
import { asc } from 'drizzle-orm'
import { authMethodAllowsOkta } from '../../../shared/schemas/password.js'
import { setSessionCookie } from '../../services/auth/session.js'
import { recordLoginEvent, recordLoginFailure } from '../../services/auth/loginDetection.js'
import {
  exchangeAuthorizationCode as exchangeOktaCode,
  fetchUserInfo as fetchOktaUserInfo,
  getOktaAuthUrl,
  generateNonce as generateOktaNonce,
  generatePkce as generateOktaPkce,
  isOktaConfigured,
  signOAuthState as signOktaState,
  verifyOAuthState as verifyOktaState,
  verifyOktaIdToken,
} from '../../services/auth/okta.js'
import { getAuthPolicy, getOktaGroupSettings } from '../../services/config/auth-policy.js'
import { isOktaAllowUnverifiedEmail } from '../../services/config/integrations.js'

import { oidcLimiter, OAUTH_PARAMS_COOKIE_PREFIX, encryptPkceParams, decryptPkceParams } from './oidc.js'

export const oktaAuthRoutes = Router()

// --- Okta OIDC (authorization-code flow) ---

// GET /auth/okta/configured — public; lets the login page decide whether to show the SSO button.
oktaAuthRoutes.get('/okta/configured', (_req, res) => {
  res.json({ data: { configured: isOktaConfigured() }, error: null, meta: {} })
})


// GET /auth/okta — redirect to Okta for sign-in with PKCE + nonce.
oktaAuthRoutes.get('/okta', oidcLimiter, async (_req, res) => {
  if (!isOktaConfigured()) {
    res.status(503).json({ data: null, error: 'errors.okta.not_configured', meta: {} })
    return
  }
  const nonce = generateOktaNonce()
  const state = signOktaState(nonce)
  const pkce = generateOktaPkce()
  const url = await getOktaAuthUrl(state, { nonce, codeChallenge: pkce.challenge })
  if (!url) {
    res.status(503).json({ data: null, error: 'errors.okta.discovery_failed', meta: {} })
    return
  }
  // Store the verifier and nonce so the callback can prove both were minted
  // in the same browser. Not signed — the state cookie already gates access
  // and the payload is opaque per-browser.
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : ''
  const cookieName = OAUTH_PARAMS_COOKIE_PREFIX + state.slice(0, 24)
  const cookieValue = encodeURIComponent(encryptPkceParams(pkce.verifier, nonce))
  res.setHeader('Set-Cookie', `${cookieName}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`)
  res.redirect(url)
})

// GET /auth/callback — Okta OIDC callback. JIT-provisions the user on first login and
// converts the Okta identity into a local session cookie so the rest of the app stays the same.
oktaAuthRoutes.get('/callback', oidcLimiter, async (req, res) => {
  if (!isOktaConfigured()) {
    res.status(503).json({ data: null, error: 'errors.okta.not_configured', meta: {} })
    return
  }
  const code = req.query['code']
  const state = req.query['state']
  const errorParam = req.query['error']

  if (typeof errorParam === 'string') {
    console.warn('[okta callback] identity provider returned an error:', errorParam.replace(/[^\w.-]/g, '').slice(0, 100))
    res.redirect(`/?oktaConnect=error&reason=${ssoErrorReason(errorParam)}`)
    return
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).json({ data: null, error: 'errors.oauth.missing_params', meta: {} })
    return
  }
  if (!verifyOktaState(state)) {
    res.status(400).json({ data: null, error: 'errors.oauth.invalid_state', meta: {} })
    return
  }

  // Pull the PKCE verifier + nonce cookie the /auth/okta handler minted.
  const paramsCookieName = OAUTH_PARAMS_COOKIE_PREFIX + state.slice(0, 24)
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
  // append(), not setHeader() — the later setSessionCookie() also writes
  // Set-Cookie and would otherwise clobber this one.
  res.append('Set-Cookie', clearParamsCookie)
  if (!paramsRaw) {
    res.status(400).json({ data: null, error: 'errors.oauth.pkce_missing', meta: {} })
    return
  }
  let pkceParams: { v: string; n: string }
  try {
    pkceParams = decryptPkceParams(paramsRaw)
  } catch {
    res.status(400).json({ data: null, error: 'errors.oauth.pkce_missing', meta: {} })
    return
  }

  let tokens
  let info
  let idClaims
  try {
    tokens = await exchangeOktaCode(code, pkceParams.v)
    idClaims = await verifyOktaIdToken(tokens.id_token, pkceParams.n)
    info = await fetchOktaUserInfo(tokens.access_token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    // Log the raw upstream detail server-side; do not reflect it to the
    // user-visible redirect (it can leak provider hints).
    console.warn('[okta callback]', message)
    res.redirect('/?oktaConnect=error&reason=errors.auth.sso_failed')
    return
  }

  if (!info.email) {
    res.redirect('/?oktaConnect=error&reason=errors.auth.sso_no_email')
    return
  }

  // Require a cryptographically-verified email match between the id_token and
  // the userinfo response — some tenants let end-users edit userinfo but keep
  // the id_token email pinned to the IdP-owned value.
  if (typeof idClaims.email === 'string' && idClaims.email.toLowerCase() !== info.email.toLowerCase()) {
    res.redirect('/?oktaConnect=error&reason=errors.auth.sso_email_mismatch')
    return
  }

  // email_verified gate. Default is strict; admins can opt out per
  // deployment if their IdP does not set the claim.
  const emailVerified = idClaims.email_verified === true || info.email_verified === true
  if (!emailVerified && !(await isOktaAllowUnverifiedEmail())) {
    res.redirect('/?oktaConnect=error&reason=errors.auth.sso_email_unverified')
    return
  }

  // Resolve match by Okta sub first, then by email. JIT-provision only when
  // the admin policy allows it (require_precreated_user = false).
  const emailLower = info.email.toLowerCase()
  const displayName = info.name ?? info.preferred_username ?? emailLower

  const [byOkta] = await db
    .select({ id: users.id, authMethod: users.authMethod })
    .from(users)
    .where(eq(users.oktaId, info.sub))
    .limit(1)

  let userId: string
  if (byOkta) {
    if (!authMethodAllowsOkta(byOkta.authMethod)) {
      res.redirect('/?oktaConnect=error&reason=errors.auth.sso_method_not_allowed')
      return
    }
    await db
      .update(users)
      .set({ email: emailLower, displayName, updatedAt: new Date() })
      .where(eq(users.id, byOkta.id))
    userId = byOkta.id
  } else {
    const [byEmail] = await db
      .select({ id: users.id, authMethod: users.authMethod })
      .from(users)
      .where(eq(users.email, emailLower))
      .limit(1)
    if (byEmail) {
      if (!authMethodAllowsOkta(byEmail.authMethod)) {
        res.redirect('/?oktaConnect=error&reason=errors.auth.sso_method_not_allowed')
        return
      }
      await db
        .update(users)
        .set({ oktaId: info.sub, displayName, updatedAt: new Date() })
        .where(eq(users.id, byEmail.id))
      userId = byEmail.id
    } else {
      // No matching ImpactIQ user. If the admin requires pre-created users,
      // refuse to JIT-provision and surface a clear error.
      if (getAuthPolicy().requirePrecreatedUser) {
        res.redirect('/?oktaConnect=error&reason=errors.auth.sso_no_account')
        return
      }
      // Resolve role + team from Okta group claim. Falls back to the
      // admin-configured defaults when no mapping matches.
      const groupSettings = getOktaGroupSettings()
      const claimName = groupSettings.groupClaimName || 'groups'
      const claim = info[claimName]
      const userGroups: string[] = Array.isArray(claim)
        ? claim.filter((g): g is string => typeof g === 'string')
        : Array.isArray(info.groups) ? info.groups : []
      const mappings = await db
        .select({ oktaGroup: oktaGroupRoleMappings.oktaGroup, role: oktaGroupRoleMappings.role, teamId: oktaGroupRoleMappings.teamId })
        .from(oktaGroupRoleMappings)
        .orderBy(asc(oktaGroupRoleMappings.sortOrder))
      const matched = mappings.find((m) => userGroups.includes(m.oktaGroup))
      const provisionedRole = matched?.role ?? groupSettings.defaultRole
      const provisionedTeamId = matched?.teamId ?? groupSettings.defaultTeamId

      const [inserted] = await db
        .insert(users)
        .values({ oktaId: info.sub, email: emailLower, displayName, defaultTeamId: provisionedTeamId })
        .returning({ id: users.id })
      if (!inserted) {
        res.redirect('/?oktaConnect=error&reason=errors.auth.sso_failed')
        return
      }
      if (provisionedTeamId) {
        await db.insert(teamMembers).values({ teamId: provisionedTeamId, userId: inserted.id, role: provisionedRole }).onConflictDoNothing()
      }
      userId = inserted.id
    }
  }

  // v1.425.0 (security audit L8): a disabled account can't sign in.
  if (await isUserDisabled(userId)) {
    void recordLoginFailure({ userId, attemptedEmail: emailLower, reason: 'user_disabled', method: 'okta', req })
    res.redirect('/?oktaConnect=error&reason=errors.auth.account_disabled')
    return
  }
  await setSessionCookie(res, userId, req, 'okta')
  void recordLoginEvent({ userId, method: 'okta', req })
  res.redirect('/')
})
