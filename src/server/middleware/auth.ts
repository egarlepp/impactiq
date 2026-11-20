import type { Request, Response, NextFunction } from 'express'
import { db } from '../db/index.js'
import { users } from '../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { readSessionCookie, verifySession, clearSessionCookie, setSessionCookieRaw } from '../services/auth/session.js'
import { verifyApiKey } from '../services/auth/apiKeys.js'

export interface AuthenticatedUser {
  id: string
  oktaId: string
  email: string
  displayName: string
}

export interface AuthenticatedApiKey {
  id: string
  scopes: string[]
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser
      // v1.145.0: populated ONLY when the request auth'd via API key. Absent
      // for session-cookie requests (which are implicitly full-scope).
      apiKey?: AuthenticatedApiKey
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Try API key first (Authorization: Bearer iqk_...). Falls back to the
  // session cookie so browser flows keep working unchanged.
  const authHeader = req.headers['authorization']
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer iqk_')) {
    const raw = authHeader.slice('Bearer '.length)
    const verified = await verifyApiKey(raw)
    if (!verified) {
      res.status(401).json({ data: null, error: 'errors.apikey.invalid', meta: {} })
      return
    }
    // v1.145.0: MCP-only tokens must not reach the REST surface. If the
    // key doesn't include rest:full, refuse REST access (the MCP router
    // does its own scope check).
    if (!verified.scopes.includes('rest:full')) {
      res.status(403).json({ data: null, error: 'errors.apikey.wrong_scope', meta: { required: 'rest:full' } })
      return
    }
    const [row] = await db
      .select({ id: users.id, oktaId: users.oktaId, email: users.email, displayName: users.displayName, mustChangePassword: users.mustChangePassword, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, verified.userId))
      .limit(1)
    if (!row) { res.status(401).json({ data: null, error: 'User not found', meta: {} }); return }
    // v1.425.0 (security audit L8): a disabled account and a pending forced
    // password change stop API keys too, not just browser sessions.
    if (row.disabledAt) { res.status(401).json({ data: null, error: 'errors.auth.account_disabled', meta: {} }); return }
    if (row.mustChangePassword) { res.status(428).json({ data: null, error: 'errors.must_change_password', meta: {} }); return }
    req.user = { id: row.id, oktaId: row.oktaId, email: row.email, displayName: row.displayName }
    req.apiKey = { id: verified.apiKeyId, scopes: verified.scopes }
    next()
    return
  }

  const token = readSessionCookie(req)
  if (!token) {
    res.status(401).json({ data: null, error: 'Unauthorized', meta: {} })
    return
  }
  const session = await verifySession(token)
  if (!session) {
    clearSessionCookie(res)
    res.status(401).json({ data: null, error: 'Session expired', meta: {} })
    return
  }
  const [row] = await db
    .select({ id: users.id, oktaId: users.oktaId, email: users.email, displayName: users.displayName, mustChangePassword: users.mustChangePassword, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)
  if (!row) {
    clearSessionCookie(res)
    res.status(401).json({ data: null, error: 'User not found', meta: {} })
    return
  }
  // v1.425.0 (security audit L8): disabling revokes sessions, but check here
  // too so a session issued in the same instant can't outlive it.
  if (row.disabledAt) {
    clearSessionCookie(res)
    res.status(401).json({ data: null, error: 'errors.auth.account_disabled', meta: {} })
    return
  }
  // Enforce first-login password reset server-side. Without this, a user
  // who dismisses the "Set Your Password" screen (refresh, back button,
  // network error) still holds a valid session cookie and can reach the
  // app — the client-only guard was cosmetic. Block every request except
  // the endpoints the change-password flow itself needs.
  if (row.mustChangePassword) {
    const path = req.path
    const ALLOW = new Set([
      '/auth/me',
      '/auth/change-password',
      '/auth/logout',
      '/auth/csrf',
    ])
    if (!ALLOW.has(path)) {
      res.status(428).json({ data: null, error: 'errors.must_change_password', meta: {} })
      return
    }
  }
  req.user = { id: row.id, oktaId: row.oktaId, email: row.email, displayName: row.displayName }
  next()
}
