import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { apiKeys, sessions, users } from '../../../../drizzle/schema.js'

// Disabled accounts (v1.425.0, security audit L8). An App Admin disables an
// account from User Management; requireAuth, every sign-in path and API keys
// then refuse it. Disabling also revokes every session and API key the user
// holds, so access ends at once rather than when a session expires.

export async function isUserDisabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId)).limit(1)
  return !!row?.disabledAt
}

export type DisableUserResult =
  | { ok: true; sessionsRevoked: number; apiKeysRevoked: number }
  | { ok: false; status: number; error: string }

export async function disableUser(targetId: string, actorId: string): Promise<DisableUserResult> {
  if (targetId === actorId) return { ok: false, status: 400, error: 'errors.users.cannot_disable_self' }
  const [target] = await db
    .select({ id: users.id, isDefaultAdmin: users.isDefaultAdmin })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1)
  if (!target) return { ok: false, status: 404, error: 'errors.users.not_found' }
  if (target.isDefaultAdmin) return { ok: false, status: 400, error: 'errors.users.cannot_disable_default_admin' }
  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ disabledAt: sql`coalesce(${users.disabledAt}, now())`, disabledBy: actorId, updatedAt: new Date() })
      .where(eq(users.id, targetId))
    const revokedSessions = await tx
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.userId, targetId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id })
    const revokedKeys = await tx
      .update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.userId, targetId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id })
    return { ok: true as const, sessionsRevoked: revokedSessions.length, apiKeysRevoked: revokedKeys.length }
  })
}

// Re-enabling restores sign-in only. Revoked sessions and API keys stay
// revoked; the user signs in again and issues new keys.
export async function enableUser(targetId: string): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ disabledAt: null, disabledBy: null, updatedAt: new Date() })
    .where(eq(users.id, targetId))
    .returning({ id: users.id })
  return updated.length > 0
}
