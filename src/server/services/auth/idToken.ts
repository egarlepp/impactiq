import crypto from 'node:crypto'
import { safeFetch } from '../net/safeFetch.js'

// Minimal RS256 JWT verifier for Okta id_tokens. Uses node:crypto — no new
// dependency. Covers what Okta's discovery + JWKS give us: RSA signing keys
// indexed by `kid`. Validates signature + `iss` + `aud` + `exp` + `iat` +
// `nonce`.

interface JwkKey {
  kty: string
  kid: string
  use?: string
  alg?: string
  n: string
  e: string
}

interface JwksResponse { keys: JwkKey[] }

// Per-issuer JWKS cache. Okta rotates keys occasionally; a short TTL is
// enough because verifyIdToken will refetch on unknown-kid anyway.
const jwksCache = new Map<string, { keys: JwkKey[]; expiresAt: number }>()
const JWKS_TTL_MS = 60 * 60 * 1000

async function loadJwks(jwksUri: string, force = false): Promise<JwkKey[]> {
  const cached = jwksCache.get(jwksUri)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys
  // The JWKS URL comes from the IdP's discovery document (Okta's host is
  // admin-configured), so it gets the same address checks as any other.
  const res = await safeFetch(jwksUri)
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`)
  const body = (await res.json()) as JwksResponse
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache.set(jwksUri, { keys, expiresAt: Date.now() + JWKS_TTL_MS })
  return keys
}

function decodeB64Url(part: string): Buffer {
  return Buffer.from(part, 'base64url')
}

export interface IdTokenClaims {
  iss: string
  aud: string | string[]
  sub: string
  exp: number
  iat: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  [key: string]: unknown
}

export interface VerifyOptions {
  issuer: string
  audience: string
  nonce: string
  jwksUri: string
  // Clock skew tolerance in seconds. Real deployments always drift a few sec.
  clockSkewSec?: number
}

// Verify an Okta id_token per OIDC core §3.1.3.7. Throws with a stable
// message on any failure — the route wraps and hides the detail from users.
export async function verifyIdToken(idToken: string, opts: VerifyOptions): Promise<IdTokenClaims> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('id_token malformed')
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  const header = JSON.parse(decodeB64Url(headerB64).toString('utf8')) as { alg?: string; kid?: string }
  if (header.alg !== 'RS256') throw new Error(`Unsupported alg: ${header.alg}`)
  if (!header.kid) throw new Error('id_token missing kid')

  // Find the signing key; refetch JWKS once if kid is unknown (rotation).
  let keys = await loadJwks(opts.jwksUri)
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    keys = await loadJwks(opts.jwksUri, true)
    jwk = keys.find((k) => k.kid === header.kid)
    if (!jwk) throw new Error('Unknown signing key')
  }
  if (jwk.kty !== 'RSA') throw new Error(`Unsupported kty: ${jwk.kty}`)

  // Node's JWK import: pass the JWK object directly with format: 'jwk'.
  // Type stubs across drizzle-kit-managed toolchains sometimes lack
  // JsonWebKey — cast keeps runtime behavior intact.
  const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' } as unknown as crypto.JsonWebKeyInput)
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8')
  const signature = decodeB64Url(sigB64)
  const verifier = crypto.createVerify('RSA-SHA256')
  verifier.update(signingInput)
  if (!verifier.verify(publicKey, signature)) throw new Error('id_token signature invalid')

  const claims = JSON.parse(decodeB64Url(payloadB64).toString('utf8')) as IdTokenClaims
  const now = Math.floor(Date.now() / 1000)
  const skew = opts.clockSkewSec ?? 30

  if (claims.iss !== opts.issuer) throw new Error('id_token issuer mismatch')
  const audMatches = Array.isArray(claims.aud) ? claims.aud.includes(opts.audience) : claims.aud === opts.audience
  if (!audMatches) throw new Error('id_token audience mismatch')
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new Error('id_token expired')
  if (typeof claims.iat === 'number' && claims.iat - skew > now) throw new Error('id_token issued in future')
  if (claims.nonce !== opts.nonce) throw new Error('id_token nonce mismatch')

  return claims
}
