// v1.113.0: single check every outbound email code path calls before
// dispatching. Fails safe — if the DB read errors or the row doesn't
// exist, we DEFAULT TO ACTIVE so a schema bootstrap issue doesn't
// silently kill all app email. Admins turn things off explicitly.

import { db } from '../../db/index.js'
import { emailRules } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'

export type EmailRuleKey =
  | 'login_new_location'
  | 'weekly_recap'
  | 'daily_digest'
  | 'nudge_email'
  | 'admin_test_email'
  | 'smtp_test'
  | 'welcome'
  | 'invitation'
  | 'password_reset'
  // v1.230.0: Admin → Scheduling's "Email admins on error" toggle, wired
  // through this rule so it's Active/Inactive-gated and template-editable
  // like every other outbound email — see src/server/services/jobs/writeRun.ts.
  | 'job_failure_alert'
  // v1.391.0: one email per month to App Admins when AI requests reach the
  // AI Assistant's monthly budget — see src/server/services/ai/gateway.ts.
  | 'ai_budget_reached'

// Small module-scoped cache so a nudge sync touching 20 rules doesn't
// hit the DB 20 times. 30s TTL — admins toggling active on/off see the
// change take effect within half a minute; nothing critical.
const cache = new Map<string, { active: boolean; at: number }>()
const TTL_MS = 30_000

export async function isEmailRuleActive(key: EmailRuleKey): Promise<boolean> {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < TTL_MS) return hit.active
  try {
    const [row] = await db.select({ isActive: emailRules.isActive }).from(emailRules).where(eq(emailRules.key, key)).limit(1)
    const active = row?.isActive ?? true
    cache.set(key, { active, at: now })
    return active
  } catch {
    return true // fail safe
  }
}

export function invalidateEmailRuleCache(key?: EmailRuleKey): void {
  if (key) cache.delete(key)
  else cache.clear()
}
