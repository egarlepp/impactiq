import { and, eq, isNotNull, lt } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users } from '../../../../drizzle/schema.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { PASSWORD_EXPIRY_DAYS } from '../../../shared/schemas/password.js'

const JOB_KEY = 'password_expiry_enforcement'

// v1.323.0: daily sweep enforcing the 90-day password policy (CLAUDE.md
// §4/§5). Scoped to authMethod='password' accounts only — Okta/Azure SSO
// accounts, and 'both'/all-login-options accounts (password is only one of
// several ways in for those), are entirely exempt. Reuses the SAME
// mustChangePassword flag the first-login forced-change flow already uses,
// so no new UI/gate is needed anywhere: requireAuth already blocks a
// non-allowlisted request once this is true, and Login.tsx already renders
// the change-password screen for it.
export async function enforcePasswordExpiry(): Promise<void> {
  const startedAt = new Date()
  try {
    const cutoff = new Date(Date.now() - PASSWORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
    const result = await db
      .update(users)
      .set({ mustChangePassword: true })
      .where(and(
        eq(users.authMethod, 'password'),
        eq(users.mustChangePassword, false),
        isNotNull(users.passwordChangedAt),
        lt(users.passwordChangedAt, cutoff),
      ))
      .returning({ id: users.id })
    await writeRun(JOB_KEY, startedAt, 'ok', `Flagged ${result.length} account${result.length === 1 ? '' : 's'} for password reset`, { flagged: result.length })
  } catch (err) {
    await writeRun(JOB_KEY, startedAt, 'error', err instanceof Error ? err.message : String(err), null)
  }
}

let stopFn: (() => void) | null = null
export function startPasswordExpiryWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, 24 * 60 * 60 * 1000, enforcePasswordExpiry)
}
