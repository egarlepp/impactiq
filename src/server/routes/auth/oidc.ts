import { rateLimit } from '../../middleware/rate-limit.js'
import { encryptToken as encryptSecret, decryptToken as decryptSecret } from '../../services/config/crypto.js'

// v1.416.0: shared by the Okta and Azure SSO routes (okta.ts, azure.ts):
// one rate limiter for both, and the encrypted PKCE + nonce cookie.
// Moved here unchanged from routes/auth.ts.

// Okta/Azure OIDC initiate + callback are unauthenticated by necessity (this
// IS the pre-login flow) and previously rode only the generous shared global
// limiter — real hardening follow-up from the go-live security audit. 30/15min per IP covers a
// real user's initiate + callback + the occasional retry several times over,
// while still bounding a scripted probe of either provider's endpoints.
export const oidcLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 })

// Bundle the PKCE verifier + OIDC nonce into a signed cookie tied to state.
// The cookie name is derived from state so multiple in-flight logins from
// the same browser don't collide.
export const OAUTH_PARAMS_COOKIE_PREFIX = 'impactiq_okta_params_'

// v1.256.1: the cookie payload is AES-256-GCM encrypted (same
// TOKEN_ENCRYPTION_KEY-derived cipher as Salesforce/Microsoft token
// storage) rather than plain JSON — closes CodeQL's
// clear-text-storage-of-sensitive-data alert on this cookie. Shared by
// both the Okta and Azure SSO flows below. The cookie is still
// short-lived (10 min) and HttpOnly/Secure; this is defense-in-depth on
// top of those, not a replacement for them. decryptToken throws on a
// malformed/tampered value, which the existing try/catch at each call
// site already turns into `errors.oauth.pkce_missing`.
export function encryptPkceParams(verifier: string, nonce: string): string {
  return encryptSecret(JSON.stringify({ v: verifier, n: nonce }))
}
export function decryptPkceParams(encrypted: string): { v: string; n: string } {
  return JSON.parse(decryptSecret(encrypted)) as { v: string; n: string }
}
