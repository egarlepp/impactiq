import { createHash, randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { sessions } from '../../../../drizzle/schema.js'

export const SESSION_COOKIE = 'impactiq_session'
// Absolute session lifetime: force re-auth after 48 hours regardless of
// activity. Combined with the idle timeout below so a browser left open on a
// shared machine still expires within a working day.
const SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000
// Idle timeout: any session with no observed API traffic for 8 hours is
// treated as expired at verify time (last_used_at is bumped on every authed
// request, so this maps to "no user activity in 8h").
const SESSION_IDLE_MAX_MS = 8 * 60 * 60 * 1000
// Server-side session tokens are opaque random blobs — never HMAC-signed —
// and looked up by their SHA-256 hash. v1.423.0 (security audit M3): the old
// HMAC-signed cookie format is no longer accepted. It skipped the sessions
// table, so revocation, the idle timeout and sign-out-everywhere didn't apply
// to it. Any such cookie expired long ago (48h lifetime), so nobody is
// signed out by this.
const NEW_TOKEN_BYTES = 32

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

// Issue a brand-new server-side session and return the opaque cookie value.
// If the same (userId, ip, user-agent) already has an active session, revoke
// it first — a repeat login from the same browser shouldn't leave a wall of
// duplicate rows on the Active Sessions list.
export async function issueSession(userId: string, req?: Request, mfaMethod?: string | null): Promise<string> {
  const raw = randomBytes(NEW_TOKEN_BYTES).toString('base64url')
  const tokenHash = hashToken(raw)
  const ip = req?.ip ?? null
  const userAgent = typeof req?.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS)

  // Revoke prior active sessions from the same fingerprint. Skip when we
  // can't distinguish clients (no IP / no UA) — we don't want to nuke
  // legitimate parallel logins across devices behind a missing IP header.
  if (ip && userAgent) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(and(
      eq(sessions.userId, userId),
      eq(sessions.ip, ip),
      eq(sessions.userAgent, userAgent),
      isNull(sessions.revokedAt),
    ))
  }

  await db.insert(sessions).values({
    userId,
    tokenHash,
    ip,
    userAgent,
    expiresAt,
    mfaMethod: mfaMethod ?? null,
  })
  return raw
}

export async function verifySession(token: string): Promise<{ userId: string; sessionId: string } | null> {
  // Opaque token → hashed lookup in sessions.
  const now = new Date()
  const tokenHash = hashToken(token)
  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt, revokedAt: sessions.revokedAt, lastUsedAt: sessions.lastUsedAt })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1)
  if (row) {
    // Idle timeout: if the session hasn't been touched in SESSION_IDLE_MAX_MS,
    // revoke it and reject. Bumping last_used_at only when the session is still
    // live keeps a stale cookie from sliding forward on the next request.
    const idleFor = now.getTime() - new Date(row.lastUsedAt).getTime()
    if (idleFor > SESSION_IDLE_MAX_MS) {
      void db.update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.id, row.id))
      return null
    }
    // Fire-and-forget bump of last_used_at so idle sessions still surface an
    // accurate "last seen" in the sessions UI.
    void db.update(sessions).set({ lastUsedAt: sql`now()` }).where(eq(sessions.id, row.id))
    return { userId: row.userId, sessionId: row.id }
  }
  return null
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers['cookie']
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      return decodeURIComponent(trimmed.slice(SESSION_COOKIE.length + 1))
    }
  }
  return null
}

// Set the session cookie on the response. Callers pass the raw opaque token
// returned by issueSession().
export function setSessionCookieRaw(res: Response, rawToken: string): void {
  const maxAgeSec = Math.floor(SESSION_MAX_AGE_MS / 1000)
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : ''
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`,
  )
}

// Convenience wrapper: mint a session AND set the cookie in one call.
export async function setSessionCookie(res: Response, userId: string, req?: Request, mfaMethod?: string | null): Promise<void> {
  const raw = await issueSession(userId, req, mfaMethod)
  setSessionCookieRaw(res, raw)
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : ''
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
  )
}

// Revoke a specific session id.
export async function revokeSession(sessionId: string, userId: string): Promise<boolean> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })
  return result.length > 0
}

// v1.116.0: revoke every active session for a user. Used by the
// password-reset flow so a completed reset invalidates every existing
// login and the next sign-in must pass password + MFA fresh.
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const result = await db.update(sessions).set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })
  return result.length
}

// Revoke every non-current session for the user.
export async function revokeOtherSessions(userId: string, keepSessionId: string | null): Promise<number> {
  const conds = [eq(sessions.userId, userId), isNull(sessions.revokedAt)]
  const result = await db.update(sessions).set({ revokedAt: new Date() })
    .where(and(...conds))
    .returning({ id: sessions.id })
  // If we're keeping one, un-revoke it in a second update. Two-step keeps
  // the query readable and avoids a NOT-EQUALS in the WHERE.
  if (keepSessionId) {
    await db.update(sessions).set({ revokedAt: null })
      .where(and(eq(sessions.id, keepSessionId), eq(sessions.userId, userId)))
  }
  return result.length
}
