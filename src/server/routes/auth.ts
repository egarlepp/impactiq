import { Router } from 'express'
import { isUserDisabled } from '../services/auth/userStatus.js'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../../../drizzle/schema.js'
import { verifyPassword } from '../services/auth/password.js'
import { validatePasswordComplexity, authMethodNeedsPassword } from '../../shared/schemas/password.js'
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  verifySession,
  revokeSession,
  revokeOtherSessions,
} from '../services/auth/session.js'
import { sessions as sessionsTbl, loginEvents } from '../../../drizzle/schema.js'
import { requireAuth } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../services/auth/totp.js'
import { generateBackupCodes, consumeBackupCode } from '../services/auth/backupCodes.js'
import { mintMfaChallenge, verifyMfaChallenge } from '../services/auth/mfaChallenge.js'
import { encryptToken as encryptSecret, decryptToken as decryptSecret } from '../services/config/crypto.js'
import { recordLoginEvent, recordLoginFailure } from '../services/auth/loginDetection.js'
import { desc, isNull } from 'drizzle-orm'
import { profileAuthRoutes } from './auth/profile.js'
import { oktaAuthRoutes } from './auth/okta.js'
import { azureAuthRoutes } from './auth/azure.js'
import { salesforceAuthRoutes } from './auth/salesforce.js'
import { gongAuthRoutes } from './auth/gong.js'
import { microsoftAuthRoutes } from './auth/microsoft.js'
import { apiKeysAuthRoutes } from './auth/apiKeys.js'

// Kept importable from here for routes/admin/integrations.ts.
export { setAdminSfHealth } from './auth/salesforce.js'

export const authRouter = Router()

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// Brute-force guard on password login. 10 attempts per IP per 15 min is
// generous for a real user but shuts down credential-spraying loops.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })

// v1.289.0: security audit finding A1 — the IP-keyed limiter above gives
// every source IP its own fresh 10-attempt budget, so a distributed
// attacker (many IPs, or a VPN/proxy pool) faces no per-account ceiling at
// all. This second limiter is keyed by the attempted email instead, closing
// that gap regardless of how many IPs an attacker rotates through. Slightly
// looser than the per-IP limit since it also has to accommodate one
// legitimate user mistyping a password from a few different devices.
function emailKeyFn(prefix: string) {
  return (req: import('express').Request): string => {
    const body = req.body as { email?: unknown }
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
    return `${prefix}:${email}`
  }
}
const loginByEmailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, keyFn: emailKeyFn('login') })


authRouter.post('/login', loginLimiter, loginByEmailLimiter, async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.invalid_credentials', meta: {} })
    return
  }
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      mustChangePassword: users.mustChangePassword,
      authMethod: users.authMethod,
      totpEnrolledAt: users.totpEnrolledAt,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1)

  if (!user) {
    void recordLoginFailure({ userId: null, attemptedEmail: parsed.data.email, reason: 'unknown_user', method: 'password', req })
    res.status(401).json({ data: null, error: 'errors.invalid_credentials', meta: {} })
    return
  }
  if (!user.passwordHash || !verifyPassword(parsed.data.password, user.passwordHash)) {
    void recordLoginFailure({ userId: user.id, attemptedEmail: parsed.data.email, reason: 'invalid_password', method: 'password', req })
    res.status(401).json({ data: null, error: 'errors.invalid_credentials', meta: {} })
    return
  }

  // v1.425.0 (security audit L8): a disabled account can't sign in.
  if (user.disabledAt) {
    void recordLoginFailure({ userId: user.id, attemptedEmail: parsed.data.email, reason: 'user_disabled', method: 'password', req })
    res.status(403).json({ data: null, error: 'errors.auth.account_disabled', meta: {} })
    return
  }

  // Block password login for Okta-only / Azure-only users — they must use SSO.
  if (!authMethodNeedsPassword(user.authMethod)) {
    void recordLoginFailure({ userId: user.id, attemptedEmail: parsed.data.email, reason: 'user_disabled', method: 'password', req })
    res.status(403).json({ data: null, error: 'errors.okta_only_account', meta: {} })
    return
  }

  // Password verified. MFA is REQUIRED for password login. Never set the
  // session cookie here — mint a short-lived challenge token and let the
  // client complete either enrollment or verify at /auth/mfa/*.
  const intent: 'enroll' | 'verify' = user.totpEnrolledAt ? 'verify' : 'enroll'
  const mfaToken = mintMfaChallenge(user.id, intent)
  res.json({
    data: {
      needsMfa: true,
      mfaIntent: intent,
      mfaToken,
      email: user.email,
      displayName: user.displayName,
      mustChangePassword: user.mustChangePassword,
    },
    error: null,
    meta: {},
  })
})

// Rate limiter shared across all MFA endpoints. Prevents brute-forcing the
// 6-digit code (10^6 space) or the backup code (30^13 but observable per-
// attempt). Keyed by the challenge token so a valid password + throttled
// codes doesn't lock legit users out globally.
const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => {
    const body = req.body as { mfaToken?: unknown }
    const t = typeof body?.mfaToken === 'string' ? body.mfaToken.slice(0, 32) : ''
    return `${req.ip ?? 'unknown'}:${t}`
  },
})

// POST /auth/mfa/enroll — first step of new-user enrollment. Returns a fresh
// TOTP secret + otpauth URL for the client to render as a QR code. Idempotent
// per challenge token: the same secret is regenerated on each call, which is
// fine because it isn't persisted until /verify-enrollment succeeds.
authRouter.post('/mfa/enroll', mfaLimiter, async (req, res) => {
  const parsed = z.object({ mfaToken: z.string() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.mfa_token_required', meta: {} }); return }
  const claims = verifyMfaChallenge(parsed.data.mfaToken, 'enroll')
  if (!claims) { res.status(401).json({ data: null, error: 'errors.mfa.challenge_invalid', meta: {} }); return }
  const [u] = await db.select({ email: users.email, totpEnrolledAt: users.totpEnrolledAt }).from(users).where(eq(users.id, claims.userId)).limit(1)
  if (!u) { res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} }); return }
  if (u.totpEnrolledAt) { res.status(400).json({ data: null, error: 'errors.mfa.already_enrolled', meta: {} }); return }
  const secret = generateTotpSecret()
  const url = otpauthUrl(secret, u.email)
  // Render the QR as an inline SVG string so the client can drop it directly
  // into the DOM. Kept server-side to avoid a client-side QR dep + keeps the
  // otpauth URL out of any lingering client caches.
  const { toString: qrToString } = await import('qrcode')
  const qrSvg = await qrToString(url, { type: 'svg', margin: 1, width: 200 })
  // Echo the plaintext secret back to the client ONE time so the QR renderer
  // has it. Not stored yet — the next call must include it plus a valid code.
  res.json({ data: { secret, otpauthUrl: url, qrSvg }, error: null, meta: {} })
})

// POST /auth/mfa/verify-enrollment — the user scanned the QR and entered
// their first code. Verifies the code, persists the encrypted secret, mints
// backup codes, and returns them to display ONCE.
authRouter.post('/mfa/verify-enrollment', mfaLimiter, async (req, res) => {
  const parsed = z.object({ mfaToken: z.string(), secret: z.string(), code: z.string() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.mfa_code_required', meta: {} }); return }
  const claims = verifyMfaChallenge(parsed.data.mfaToken, 'enroll')
  if (!claims) { res.status(401).json({ data: null, error: 'errors.mfa.challenge_invalid', meta: {} }); return }
  if (!verifyTotp(parsed.data.secret, parsed.data.code)) {
    res.status(401).json({ data: null, error: 'errors.mfa.code_invalid', meta: {} }); return
  }
  if (await isUserDisabled(claims.userId)) {
    res.status(403).json({ data: null, error: 'errors.auth.account_disabled', meta: {} }); return
  }
  const { plain, hashes } = generateBackupCodes()
  await db.update(users).set({
    totpSecretEncrypted: encryptSecret(parsed.data.secret),
    totpEnrolledAt: new Date(),
    mfaBackupCodesHash: hashes,
    updatedAt: new Date(),
  }).where(eq(users.id, claims.userId))
  await setSessionCookie(res, claims.userId, req, 'totp')
  void recordLoginEvent({ userId: claims.userId, method: 'mfa', req })
  res.json({ data: { backupCodes: plain }, error: null, meta: {} })
})

// POST /auth/mfa/verify — subsequent logins. Accepts a 6-digit TOTP code or
// a backup code. On success sets the session cookie.
authRouter.post('/mfa/verify', mfaLimiter, async (req, res) => {
  const parsed = z.object({ mfaToken: z.string(), code: z.string() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.mfa_code_required', meta: {} }); return }
  const claims = verifyMfaChallenge(parsed.data.mfaToken, 'verify')
  if (!claims) { res.status(401).json({ data: null, error: 'errors.mfa.challenge_invalid', meta: {} }); return }
  const [u] = await db.select({
    totpSecretEncrypted: users.totpSecretEncrypted,
    mfaBackupCodesHash: users.mfaBackupCodesHash,
  }).from(users).where(eq(users.id, claims.userId)).limit(1)
  if (!u?.totpSecretEncrypted) { res.status(401).json({ data: null, error: 'errors.mfa.not_enrolled', meta: {} }); return }
  if (await isUserDisabled(claims.userId)) {
    res.status(403).json({ data: null, error: 'errors.auth.account_disabled', meta: {} }); return
  }
  const raw = parsed.data.code.trim()
  const isSixDigit = /^\d{6}$/.test(raw.replace(/\s+/g, ''))

  // Gate on backup-code depletion BEFORE letting anything through — once a
  // user has burned every recovery code we lock the account pending admin
  // reset regardless of whether the caller is trying TOTP or a backup code.
  const storedBefore = Array.isArray(u.mfaBackupCodesHash) ? u.mfaBackupCodesHash as { salt: string; hash: string }[] : []
  if (storedBefore.length === 0) {
    res.status(423).json({ data: null, error: 'errors.mfa.backup_codes_depleted', meta: {} }); return
  }

  let method: 'totp' | 'backup_code' = 'totp'
  let backupCodesRemaining = storedBefore.length
  if (isSixDigit) {
    const secret = decryptSecret(u.totpSecretEncrypted)
    if (!verifyTotp(secret, raw)) {
      res.status(401).json({ data: null, error: 'errors.mfa.code_invalid', meta: {} }); return
    }
  } else {
    // Try as a backup code.
    const remaining = consumeBackupCode(raw, storedBefore)
    if (!remaining) {
      res.status(401).json({ data: null, error: 'errors.mfa.code_invalid', meta: {} }); return
    }
    await db.update(users).set({ mfaBackupCodesHash: remaining, updatedAt: new Date() }).where(eq(users.id, claims.userId))
    method = 'backup_code'
    backupCodesRemaining = remaining.length
  }
  await setSessionCookie(res, claims.userId, req, method)
  void recordLoginEvent({ userId: claims.userId, method, req })
  res.json({ data: { ok: true, mfaMethod: method, backupCodesRemaining }, error: null, meta: {} })
})

// POST /auth/mfa/regenerate-backup-codes — authenticated users can rotate
// their backup codes at any time.
authRouter.post('/mfa/regenerate-backup-codes', requireAuth, async (req, res) => {
  const [u] = await db.select({ totpEnrolledAt: users.totpEnrolledAt }).from(users).where(eq(users.id, req.user!.id)).limit(1)
  if (!u?.totpEnrolledAt) { res.status(400).json({ data: null, error: 'errors.mfa.not_enrolled', meta: {} }); return }
  const { plain, hashes } = generateBackupCodes()
  await db.update(users).set({ mfaBackupCodesHash: hashes, updatedAt: new Date() }).where(eq(users.id, req.user!.id))
  res.json({ data: { backupCodes: plain }, error: null, meta: {} })
})

authRouter.post('/change-password', async (req, res) => {
  const session = await verifySession(readSessionCookie(req))
  if (!session || await isUserDisabled(session.userId)) {
    res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} })
    return
  }
  // currentPassword is required unless the user has mustChangePassword=true
  // (first-login flow, where they were provisioned by an admin with a temporary
  // password). Every other change-password request must prove possession of
  // the current password so a hijacked session can't lock the real user out.
  const schema = z.object({ newPassword: z.string(), currentPassword: z.string().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: 'errors.validation.password_required', meta: {} })
    return
  }
  const [existing] = await db
    .select({ passwordHash: users.passwordHash, mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)
  if (!existing) { res.status(401).json({ data: null, error: 'errors.unauthorized', meta: {} }); return }

  const needsCurrent = !existing.mustChangePassword && !!existing.passwordHash
  if (needsCurrent) {
    if (!parsed.data.currentPassword) {
      res.status(400).json({ data: null, error: 'errors.validation.current_password_required', meta: {} })
      return
    }
    if (!verifyPassword(parsed.data.currentPassword, existing.passwordHash!)) {
      res.status(401).json({ data: null, error: 'errors.invalid_credentials', meta: {} })
      return
    }
  }
  const complexity = validatePasswordComplexity(parsed.data.newPassword)
  if (!complexity.ok) {
    res.status(400).json({
      data: null,
      error: `Password must satisfy: ${complexity.failedLabels.join(', ')}`,
      meta: {},
    })
    return
  }
  const { setUserPassword } = await import('../services/auth/passwordPolicy.js')
  const result = await setUserPassword(session.userId, parsed.data.newPassword, false)
  if (!result.ok) { res.status(400).json({ data: null, error: result.error, meta: {} }); return }
  // Rotate the session cookie so a future secret rotation invalidates the
  // pre-change token.
  await setSessionCookie(res, session.userId, req)
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// v1.116.0: password reset — request phase. Deliberately opaque to
// avoid user-enumeration: always returns 200 with a neutral message,
// regardless of whether the email exists, whether the account is
// password-capable, or whether email delivery actually succeeded.
// Rate-limited to 5 attempts per 15 min per IP.
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 })
// Same per-account rationale as loginByEmailLimiter above — without this, a
// distributed caller could email-bomb one account's inbox with reset links
// from an unlimited number of source IPs.
const forgotByEmailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyFn: emailKeyFn('forgot') })
authRouter.post('/forgot-password', forgotLimiter, forgotByEmailLimiter, async (req, res) => {
  const schema = z.object({ email: z.string().email() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.email_required', meta: {} }); return }
  const email = parsed.data.email.trim().toLowerCase()
  try {
    const [u] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, authMethod: users.authMethod }).from(users).where(eq(users.email, email)).limit(1)
    // Only issue tokens for accounts that can actually password-login.
    // Okta-only / Azure-only accounts are silently skipped so we don't leak
    // "this email uses SSO".
    if (u && authMethodNeedsPassword(u.authMethod)) {
      const { randomBytes, createHash } = await import('node:crypto')
      const token = randomBytes(32).toString('base64url')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 60 min
      const { passwordResetTokens } = await import('../../../drizzle/schema.js')
      await db.insert(passwordResetTokens).values({
        userId: u.id,
        tokenHash,
        expiresAt,
        ip: req.ip ?? null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      })
      const base = (process.env['APP_URL'] ?? '').replace(/\/+$/, '')
      const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`
      const { sendByRule } = await import('../services/email/rule-sender.js')
      await sendByRule('password_reset', {
        to: u.email,
        toName: u.displayName,
        defaultSubject: 'Reset your ImpactIQ password',
        defaultBodyHtml: '<p>Hi {{name}},</p><p>Someone (hopefully you) asked to reset your ImpactIQ password. The link below is good for 60 minutes and only works once:</p><p><a href="{{resetUrl}}">Reset my password</a></p><p>If you didn\'t request this, ignore this email — your password stays the same.</p>',
        defaultBodyText: 'Hi {{name}},\n\nSomeone (hopefully you) asked to reset your ImpactIQ password. This link is good for 60 minutes and only works once:\n{{resetUrl}}\n\nIf you didn\'t request this, ignore this email — your password stays the same.\n',
        tokens: { name: u.displayName, resetUrl, expiresIn: '60 minutes' },
      })
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[forgot-password] failed:', err instanceof Error ? err.message : err)
  }
  res.json({ data: { ok: true, message: 'If an account exists for that email, a reset link has been sent.' }, error: null, meta: {} })
})

// v1.116.0: password reset — verify phase. Client hits this to check
// the token before rendering the "set new password" form. Returns
// { ok: true, displayName } on success, 400/410 on bad/expired/used.
authRouter.post('/reset-password/verify', async (req, res) => {
  const schema = z.object({ token: z.string().min(20) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.token_required', meta: {} }); return }
  try {
    const { createHash } = await import('node:crypto')
    const tokenHash = createHash('sha256').update(parsed.data.token).digest('hex')
    const { passwordResetTokens } = await import('../../../drizzle/schema.js')
    const [row] = await db.select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
    }).from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, tokenHash)).limit(1)
    if (!row) { res.status(410).json({ data: null, error: 'errors.reset.invalid_or_expired', meta: {} }); return }
    if (row.usedAt) { res.status(410).json({ data: null, error: 'errors.reset.already_used', meta: {} }); return }
    if (row.expiresAt.getTime() < Date.now()) { res.status(410).json({ data: null, error: 'errors.reset.invalid_or_expired', meta: {} }); return }
    const [u] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, row.userId)).limit(1)
    res.json({ data: { ok: true, displayName: u?.displayName ?? '', email: u?.email ?? '' }, error: null, meta: {} })
  } catch (err) {
    res.status(500).json({ data: null, error: 'errors.server', meta: {} })
    console.warn('[reset-verify] failed', err instanceof Error ? err.message : err)
  }
})

// v1.116.0: password reset — commit phase. Consumes the token,
// updates the password, sets mustChangePassword=false, and clears any
// existing MFA-verified sessions for the user so the next sign-in
// forces a fresh MFA challenge as well as the new password.
authRouter.post('/reset-password', async (req, res) => {
  const schema = z.object({ token: z.string().min(20), newPassword: z.string() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.reset_shape', meta: {} }); return }
  const complexity = validatePasswordComplexity(parsed.data.newPassword)
  if (!complexity.ok) { res.status(400).json({ data: null, error: `Password must satisfy: ${complexity.failedLabels.join(', ')}`, meta: {} }); return }
  try {
    const { createHash } = await import('node:crypto')
    const tokenHash = createHash('sha256').update(parsed.data.token).digest('hex')
    const { passwordResetTokens } = await import('../../../drizzle/schema.js')
    const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, tokenHash)).limit(1)
    if (!row) { res.status(410).json({ data: null, error: 'errors.reset.invalid_or_expired', meta: {} }); return }
    if (row.usedAt) { res.status(410).json({ data: null, error: 'errors.reset.already_used', meta: {} }); return }
    if (row.expiresAt.getTime() < Date.now()) { res.status(410).json({ data: null, error: 'errors.reset.invalid_or_expired', meta: {} }); return }
    const { setUserPassword } = await import('../services/auth/passwordPolicy.js')
    const result = await setUserPassword(row.userId, parsed.data.newPassword, false)
    if (!result.ok) { res.status(400).json({ data: null, error: result.error, meta: {} }); return }
    await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id))
    // Revoke any active sessions for this user so a hijacked session
    // (rare, since password is what they had) can't ride through. The
    // login flow will re-challenge for MFA on the next sign-in.
    try {
      const { revokeAllSessionsForUser } = await import('../services/auth/session.js')
      await revokeAllSessionsForUser(row.userId)
    } catch { /* ignore if helper missing */ }
    res.json({ data: { ok: true }, error: null, meta: {} })
  } catch (err) {
    res.status(500).json({ data: null, error: 'errors.server', meta: {} })
    console.warn('[reset-password] failed', err instanceof Error ? err.message : err)
  }
})

authRouter.post('/logout', async (req, res) => {
  // Revoke the current session row (if any) so it can't be re-used even if
  // the cookie gets replayed.
  const s = await verifySession(readSessionCookie(req))
  if (s?.sessionId) await revokeSession(s.sessionId, s.userId)
  clearSessionCookie(res)
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// GET /auth/sessions — list the caller's active sessions (marking which is
// current so the UI can label the current row and gate revocation).
authRouter.get('/sessions', requireAuth, async (req, res) => {
  const current = await verifySession(readSessionCookie(req))
  const rows = await db
    .select({
      id: sessionsTbl.id,
      ip: sessionsTbl.ip,
      userAgent: sessionsTbl.userAgent,
      createdAt: sessionsTbl.createdAt,
      lastUsedAt: sessionsTbl.lastUsedAt,
      expiresAt: sessionsTbl.expiresAt,
    })
    .from(sessionsTbl)
    .where(and(eq(sessionsTbl.userId, req.user!.id), isNull(sessionsTbl.revokedAt)))
    .orderBy(desc(sessionsTbl.lastUsedAt))
  res.json({ data: rows.map((r) => ({ ...r, isCurrent: r.id === current?.sessionId })), error: null, meta: {} })
})

// DELETE /auth/sessions/:id — revoke a specific session.
authRouter.delete('/sessions/:id', requireAuth, async (req, res) => {
  const { id } = req.params as { id: string }
  const ok = await revokeSession(id, req.user!.id)
  if (!ok) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: { id }, error: null, meta: {} })
})

// DELETE /auth/sessions — revoke every session except the one making the
// request. Convenience for "sign me out of all other devices".
authRouter.delete('/sessions', requireAuth, async (req, res) => {
  const current = await verifySession(readSessionCookie(req))
  const revoked = await revokeOtherSessions(req.user!.id, current?.sessionId ?? null)
  res.json({ data: { revoked }, error: null, meta: {} })
})

// GET /auth/me/logins — the caller's last 10 sign-in events (successful and
// failed). Powers the "Recent Logins" panel in My Settings.
authRouter.get('/me/logins', requireAuth, async (req, res) => {
  const rows = await db
    .select({
      id: loginEvents.id,
      success: loginEvents.success,
      failureReason: loginEvents.failureReason,
      method: loginEvents.method,
      ip: loginEvents.ip,
      userAgent: loginEvents.userAgent,
      isSuspicious: loginEvents.isSuspicious,
      createdAt: loginEvents.createdAt,
    })
    .from(loginEvents)
    .where(eq(loginEvents.userId, req.user!.id))
    .orderBy(desc(loginEvents.createdAt))
    .limit(10)
  res.json({ data: rows, error: null, meta: {} })
})

// v1.416.0: profile, SSO (Okta, Azure), Salesforce, Microsoft and API key
// routes live in ./auth/. Mounted in the order they used to appear in this
// file, after the password and MFA routes above, so route matching is unchanged.
authRouter.use(profileAuthRoutes)
authRouter.use(oktaAuthRoutes)
authRouter.use(azureAuthRoutes)
authRouter.use(salesforceAuthRoutes)
authRouter.use(microsoftAuthRoutes)
authRouter.use(apiKeysAuthRoutes)
authRouter.use(gongAuthRoutes)
