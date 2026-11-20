// Centralised validation of security-critical env vars. Fails loud in
// production when required secrets are missing or under-length — but only
// once a database is configured (i.e., past first-run setup mode). Setup
// mode exists specifically so a fresh install can bootstrap itself without
// already knowing every secret; throwing here unconditionally defeated
// that — a production container with DATABASE_URL unset (exactly the
// condition setup mode is designed to handle) threw at import time, before
// Express ever bound the port. `restart: unless-stopped` then crash-loops
// it forever, and any reverse proxy in front just shows a permanent Bad
// Gateway instead of the intended setup wizard. In non-production, or
// while still in setup mode, we log one warning per var and fall back to a
// random per-process value so dev boxes (and a not-yet-configured prod
// container) keep working, but nothing on-disk is consistent across
// restarts (making the "dev key" attack useless).
import { randomBytes } from 'node:crypto'

const MIN_SECRET_BYTES = 32
const isProduction = process.env['NODE_ENV'] === 'production'
// Deliberately NOT imported from db/index.js — that's the exact same
// `!!process.env['DATABASE_URL']` check, inlined here to avoid coupling
// this early-imported module to anything else at all.
const isDbConfigured = !!process.env['DATABASE_URL']
const warned = new Set<string>()

function warnOnce(name: string, message: string): void {
  if (warned.has(name)) return
  warned.add(name)
  // eslint-disable-next-line no-console
  console.warn(`[env] ${name}: ${message}`)
}

// Read a required secret. In production, once a database is configured, a
// missing/short value throws at import time — the process should refuse to
// start. Otherwise (non-production, or still in setup mode) we generate a
// fresh random value once per process.
// v1.476.0: .env.example ships placeholders that start with "change-me". They
// are long enough to pass the length check, so treat them as unset: a copied
// .env.example must never run in production with a secret the whole internet
// can read.
export function isPlaceholderSecret(value: string): boolean {
  return /^change[-_]?me/i.test(value.trim())
}

function requireSecret(name: string, fallbackName?: string): string {
  const own = process.env[name]
  const fromFallback = fallbackName ? process.env[fallbackName] : undefined
  const raw = own ?? fromFallback
  if (raw && isPlaceholderSecret(raw)) {
    if (isProduction && isDbConfigured) {
      throw new Error(
        `[env] ${name} still has the placeholder value from .env.example. Generate one with \`openssl rand -hex 32\`. Refusing to start.`,
      )
    }
    warnOnce(name, 'still the .env.example placeholder — generating an ephemeral random value for this process')
    return randomBytes(MIN_SECRET_BYTES).toString('hex')
  }
  if (raw && raw.length >= MIN_SECRET_BYTES) {
    if (fallbackName && !process.env[name] && process.env[fallbackName]) {
      warnOnce(name, `using deprecated ${fallbackName}; set ${name} explicitly`)
    }
    return raw
  }
  if (isProduction && isDbConfigured) {
    throw new Error(
      `[env] ${name} is required in production and must be at least ${MIN_SECRET_BYTES} chars. Refusing to start.`,
    )
  }
  warnOnce(name, `not set or too short — generating an ephemeral random value for this process`)
  return randomBytes(MIN_SECRET_BYTES).toString('hex')
}

// HMAC secret for the session cookie signature.
export const SESSION_SECRET = requireSecret('SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY')

// AES-256-GCM key material for encrypting stored SF/MS refresh tokens.
// Callers derive a 32-byte key from this (via createHash / scryptSync).
export const TOKEN_ENCRYPTION_KEY = requireSecret('TOKEN_ENCRYPTION_KEY')
