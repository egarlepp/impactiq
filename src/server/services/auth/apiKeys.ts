import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from '../../db/index.js'
import { apiKeys, users } from '../../../../drizzle/schema.js'
import { and, eq, isNull, sql } from 'drizzle-orm'

const KEY_PREFIX_LEN = 8
const KEY_BYTES = 32 // 256 bits of raw entropy → 43 base64url chars
const SCRYPT_KEYLEN = 32

// New key format: `iqk_<43 base64url chars>`. The prefix `iqk_` makes leaked
// keys grep-able and is part of the surface-hash so tampering the prefix
// won't validate.
export function newRawApiKey(): string {
  return `iqk_${randomBytes(KEY_BYTES).toString('base64url')}`
}

export function keyPrefix(raw: string): string {
  return raw.slice(0, KEY_PREFIX_LEN)
}

export function hashRawKey(raw: string): { salt: string; hash: string } {
  const salt = randomBytes(16)
  const hash = scryptSync(raw, salt, SCRYPT_KEYLEN)
  return { salt: salt.toString('hex'), hash: hash.toString('hex') }
}

export interface VerifiedApiKey {
  userId: string
  apiKeyId: string
  scopes: string[]
}

// Verify a raw key against the api_keys table. Returns userId + key id +
// scopes when the key is valid, active, and not expired. Bumps
// last_used_at asynchronously.
export async function verifyApiKey(raw: string): Promise<VerifiedApiKey | null> {
  if (!raw.startsWith('iqk_')) return null
  const prefix = keyPrefix(raw)
  const candidates = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId, keyHash: apiKeys.keyHash, keySalt: apiKeys.keySalt, expiresAt: apiKeys.expiresAt, revokedAt: apiKeys.revokedAt, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyPrefix, prefix), isNull(apiKeys.revokedAt)))
  const now = Date.now()
  for (const c of candidates) {
    if (c.expiresAt && c.expiresAt.getTime() < now) continue
    const expected = scryptSync(raw, Buffer.from(c.keySalt, 'hex'), SCRYPT_KEYLEN)
    const stored = Buffer.from(c.keyHash, 'hex')
    if (expected.length !== stored.length) continue
    if (timingSafeEqual(expected, stored)) {
      // v1.425.0 (security audit L8): a disabled user's keys stop working
      // even if one was somehow left unrevoked. Covers REST and MCP.
      const [owner] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, c.userId)).limit(1)
      if (!owner || owner.disabledAt) return null
      // Fire-and-forget bump; don't block the request.
      void db.update(apiKeys).set({ lastUsedAt: sql`now()` }).where(eq(apiKeys.id, c.id))
      return { userId: c.userId, apiKeyId: c.id, scopes: c.scopes ?? ['rest:full'] }
    }
  }
  return null
}
