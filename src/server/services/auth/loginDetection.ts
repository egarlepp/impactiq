import { and, eq, gte } from 'drizzle-orm'
import type { Request } from 'express'
import { db } from '../../db/index.js'
import { loginEvents, users } from '../../../../drizzle/schema.js'

// A login is "suspicious" when we haven't seen that IP for the same user
// within the last 90 days. Cheap check; no geolocation needed. Also flags
// as suspicious when the user has zero prior logins (first-time UA fingerprint).
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000

export interface RecordLoginOpts {
  userId: string
  method: 'password' | 'okta' | 'azure' | 'mfa' | 'totp' | 'backup_code'
  req: Request
}

export async function recordLoginEvent({ userId, method, req }: RecordLoginOpts): Promise<{ suspicious: boolean }> {
  const ip = req.ip ?? null
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null

  // Suspicious = we've never seen this IP for this user in the lookback window.
  let suspicious = false
  let firstSignIn = false
  if (ip) {
    const cutoff = new Date(Date.now() - LOOKBACK_MS)
    const [prior] = await db
      .select({ id: loginEvents.id })
      .from(loginEvents)
      .where(and(eq(loginEvents.userId, userId), eq(loginEvents.ip, ip), gte(loginEvents.createdAt, cutoff)))
      .limit(1)
    suspicious = !prior
    if (suspicious) {
      const [anyPrior] = await db
        .select({ id: loginEvents.id })
        .from(loginEvents)
        .where(and(eq(loginEvents.userId, userId), eq(loginEvents.success, true)))
        .limit(1)
      firstSignIn = !anyPrior
    }
  }

  const [event] = await db.insert(loginEvents).values({ userId, method, ip, userAgent, success: true, isSuspicious: suspicious }).returning()

  if (suspicious && event) {
    // Notify the user, best-effort. Failures are swallowed so login itself
    // never breaks because email is down.
    void notifyUserOfNewLogin(userId, ip, userAgent, event.id).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[login-alert] notify failed:', err)
    })
    const { emitSuspiciousSignIn } = await import('../webhooks/events.js')
    void emitSuspiciousSignIn({ userId, method, ip, userAgent, at: event.createdAt, firstSignIn })
  }
  return { suspicious }
}

// Record a failed login attempt. userId is null when we can't tie the
// attempt to a known account (unknown email); attemptedEmail keeps the
// email typed by the caller regardless.
export async function recordLoginFailure(opts: {
  userId: string | null
  attemptedEmail: string
  reason: 'invalid_password' | 'unknown_user' | 'mfa_invalid' | 'mfa_required' | 'user_disabled' | 'password_expired' | 'other'
  method: 'password' | 'okta' | 'azure' | 'mfa' | 'totp' | 'backup_code'
  req: Request
}): Promise<void> {
  const ip = opts.req.ip ?? null
  const userAgent = typeof opts.req.headers['user-agent'] === 'string' ? opts.req.headers['user-agent'] : null
  await db.insert(loginEvents).values({
    userId: opts.userId,
    attemptedEmail: opts.attemptedEmail,
    success: false,
    failureReason: opts.reason,
    method: opts.method,
    ip,
    userAgent,
    isSuspicious: false,
  })
}

async function notifyUserOfNewLogin(userId: string, ip: string | null, userAgent: string | null, eventId: string): Promise<void> {
  const [u] = await db.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return
  const { sendByRule } = await import('../email/rule-sender.js')
  const defaultSubject = 'New sign-in to your ImpactIQ account'
  const defaultBodyHtml = `<p>Hi {{name}},</p>
<p>We noticed a sign-in from a new location.</p>
<ul>
  <li><b>IP:</b> {{ip}}</li>
  <li><b>User agent:</b> {{userAgent}}</li>
  <li><b>Signed in at:</b> {{signInTime}}</li>
</ul>
<p>If this was you, no action is needed.</p>
<p>If not:</p>
<ol>
  <li>Go to My Settings → Active Sessions and revoke every session you don't recognise.</li>
  <li>Change your password from the login screen (a fresh MFA challenge will follow).</li>
  <li>Contact your ImpactIQ admin.</li>
</ol>`
  const defaultBodyText = `Hi {{name}},\n\nWe noticed a sign-in from a new location.\n\n  IP:          {{ip}}\n  User agent:  {{userAgent}}\n  Signed in:   {{signInTime}}\n\nIf this was you, no action is needed.\n\nIf not:\n  1. My Settings → Active Sessions and revoke every session you don't recognise.\n  2. Change your password from the login screen (a fresh MFA challenge will follow).\n  3. Contact your ImpactIQ admin.\n`
  const result = await sendByRule('login_new_location', {
    to: u.email,
    toName: u.displayName,
    defaultSubject,
    defaultBodyHtml,
    defaultBodyText,
    tokens: { name: u.displayName, ip: ip ?? 'unknown', userAgent: userAgent ?? 'unknown', signInTime: new Date().toISOString() },
    userId,
    severity: 'warning',
  })
  if (result.sent) {
    await db.update(loginEvents).set({ alertSentAt: new Date() }).where(eq(loginEvents.id, eventId))
  }
}
