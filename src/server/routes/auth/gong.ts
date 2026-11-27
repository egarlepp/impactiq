import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { signCallbackState, verifyOAuthState } from '../../services/auth/salesforce.js'
import { logAudit } from '../../services/audit/log.js'
import { getGongStoredView, saveGongOAuthTokens } from '../../services/gong/config.js'
import { gongOAuthRedirectUri } from '../../services/gong/connection.js'
import { buildGongAuthorizeUrl, exchangeGongAuthorizationCode, GongOAuthError } from '../../services/gong/oauth.js'
import { getGongClientSecret } from '../../services/gong/config.js'
import { db } from '../../db/index.js'
import { users } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import {
  checkOAuthBinding,
  clearOAuthBindingCookie,
  generateBindingNonce,
  setOAuthBindingCookie,
} from './oauthBinding.js'

// Gong OAuth app connect (Gong plan, phase 1). An App Admin starts it from
// Admin → Integrations → Gong; they sign in to Gong as a Gong tech admin and
// authorize the customer's own Gong app once for the whole tenant. Same
// protections as the Salesforce and Microsoft connect flows (v1.423.0): an
// HMAC-signed state, an encrypted binding cookie with the same nonce, and
// the callback must arrive in the same signed-in admin's browser.
export const GONG_BINDING_COOKIE_PREFIX = 'impactiq_gong_oauth_'
const STATE_PREFIX = 'gong:'
const ADMIN_RETURN = '/admin?section=integrations'

export const gongAuthRoutes = Router()

gongAuthRoutes.get('/gong', requireAuth, requireAppAdmin, async (req, res) => {
  const view = await getGongStoredView()
  const redirectUri = await gongOAuthRedirectUri()
  if (!view?.oauthClientId || !view.hasOAuthClientSecret || !redirectUri) {
    res.redirect(`${ADMIN_RETURN}&gongConnect=error&reason=${encodeURIComponent('errors.gong.oauth_client_required')}`)
    return
  }
  const nonce = generateBindingNonce()
  const state = signCallbackState(`${STATE_PREFIX}${req.user!.id}`, nonce)
  setOAuthBindingCookie(res, GONG_BINDING_COOKIE_PREFIX, state, { nonce, userId: req.user!.id })
  res.redirect(buildGongAuthorizeUrl({ clientId: view.oauthClientId, redirectUri, state }))
})

gongAuthRoutes.get('/gong/callback', async (req, res) => {
  const fail = (reason: string) => res.redirect(`${ADMIN_RETURN}&gongConnect=error&reason=${encodeURIComponent(reason)}`)
  const code = req.query['code']
  const state = req.query['state']
  if (typeof req.query['error'] === 'string') { fail('errors.gong.oauth_denied'); return }
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 2048) { fail('errors.oauth.missing_params'); return }
  const stateData = verifyOAuthState(state)
  if (!stateData || !stateData.userId.startsWith(STATE_PREFIX)) { fail('errors.oauth.invalid_state'); return }
  const actorUserId = stateData.userId.slice(STATE_PREFIX.length)
  const binding = await checkOAuthBinding(req, GONG_BINDING_COOKIE_PREFIX, state, { nonce: stateData.nonce, userId: actorUserId })
  clearOAuthBindingCookie(res, GONG_BINDING_COOKIE_PREFIX, state)
  if (!binding) { fail('errors.oauth.session_mismatch'); return }

  const view = await getGongStoredView()
  const clientSecret = await getGongClientSecret()
  const redirectUri = await gongOAuthRedirectUri()
  if (!view?.oauthClientId || !clientSecret || !redirectUri) { fail('errors.gong.oauth_client_required'); return }
  try {
    const tokens = await exchangeGongAuthorizationCode({ code, redirectUri, clientId: view.oauthClientId, clientSecret })
    await saveGongOAuthTokens({ ...tokens, connected: true })
  } catch (err) {
    fail(err instanceof GongOAuthError ? err.code : 'errors.gong.oauth_failed')
    return
  }
  const [actor] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, actorUserId)).limit(1)
  await logAudit(req, { action: 'integration.gong.oauth_connect', targetType: 'integration', targetId: 'gong', actor: actor ?? null })
  res.redirect(`${ADMIN_RETURN}&gongConnect=ok`)
})
