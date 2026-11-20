import { desc, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users, passwordHistory } from '../../../../drizzle/schema.js'
import { hashPassword, verifyPassword } from './password.js'
import { PASSWORD_HISTORY_LIMIT } from '../../../shared/schemas/password.js'

// Password reuse + expiry policy — see CLAUDE.md §4/§5. Scoped entirely to
// accounts whose authMethod is exactly 'password': Okta/Azure SSO accounts,
// and 'both' (all login options) accounts, are exempt since password is
// either not their credential at all or only one of several ways in.

async function isPasswordReused(userId: string, newPassword: string, currentHash: string | null): Promise<boolean> {
  if (currentHash && verifyPassword(newPassword, currentHash)) return true
  const history = await db
    .select({ passwordHash: passwordHistory.passwordHash })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.createdAt))
    .limit(PASSWORD_HISTORY_LIMIT - 1)
  return history.some((h) => verifyPassword(newPassword, h.passwordHash))
}

// Moves the just-superseded hash into history (if there was one), prunes
// history down to the last PASSWORD_HISTORY_LIMIT-1 rows, and writes the
// new hash + passwordChangedAt onto the user — all in one transaction so a
// mid-write failure can't leave history and the live hash disagreeing.
async function recordPasswordChange(userId: string, oldHash: string | null, newHash: string, mustChangePassword: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    if (oldHash) {
      await tx.insert(passwordHistory).values({ userId, passwordHash: oldHash })
    }
    const keep = await tx
      .select({ id: passwordHistory.id })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt))
      .limit(PASSWORD_HISTORY_LIMIT - 1)
    const keepIds = new Set(keep.map((r) => r.id))
    const all = await tx.select({ id: passwordHistory.id }).from(passwordHistory).where(eq(passwordHistory.userId, userId))
    for (const row of all) {
      if (!keepIds.has(row.id)) await tx.delete(passwordHistory).where(eq(passwordHistory.id, row.id))
    }
    await tx.update(users).set({ passwordHash: newHash, mustChangePassword, passwordChangedAt: new Date() }).where(eq(users.id, userId))
  })
}

// Single entry point for every password-write code path (self-service
// change, forgot-password reset, admin reset). Re-reads the target user's
// own authMethod/passwordHash rather than trusting a caller-supplied flag,
// so the reuse check can never be skipped by an inconsistent caller.
export async function setUserPassword(
  userId: string,
  newPassword: string,
  mustChangePassword: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [target] = await db.select({ authMethod: users.authMethod, passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1)
  if (!target) return { ok: false, error: 'errors.user_not_found' }
  if (target.authMethod === 'password' && (await isPasswordReused(userId, newPassword, target.passwordHash))) {
    return { ok: false, error: 'errors.password_reused' }
  }
  await recordPasswordChange(userId, target.passwordHash, hashPassword(newPassword), mustChangePassword)
  return { ok: true }
}
