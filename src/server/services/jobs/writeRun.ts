import { db } from '../../db/index.js'
import { jobRuns, jobConfig, users } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { sendByRule } from '../email/rule-sender.js'
import { reportMessage } from '../observability/errorTracking.js'

// v1.213.0: single shared implementation of the job-run recorder that was
// duplicated verbatim between refreshOppSnapshots.ts and
// refreshOppCoverage.ts. The historical-import jobs are the third consumer,
// which is where copy-paste stops being defensible.
//
// Writes one job_runs row (surfacing the job on Admin → Monitoring →
// Scheduling) and, on error, emails app admins who opted in via
// job_config.notify_on_error — at most one email per admin per job per day.

export type JobRunStatus = 'ok' | 'error'

export async function writeRun(
  jobKey: string,
  startedAt: Date,
  status: JobRunStatus,
  message: string | null,
  detail: unknown,
): Promise<void> {
  const finishedAt = new Date()
  try {
    await db.insert(jobRuns).values({
      jobKey,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status,
      message,
      detail: detail as object,
    })
  } catch {
    // Never let job-audit persistence break the job itself.
  }

  if (status !== 'error') return
  // Message only: `detail` can hold record ids and names.
  reportMessage(`Job ${jobKey} failed: ${message ?? '(no message)'}`, { jobKey, source: 'job_run' })
  // The event webhook worker's own failures aren't sent through itself.
  if (jobKey !== 'event_webhook_worker') {
    const { emitEvent } = await import('../webhooks/events.js')
    await emitEvent('job.failed', { job: { key: jobKey, message, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() } }, { teamIds: null, userId: null })
  }
  try {
    const [cfg] = await db.select().from(jobConfig).where(eq(jobConfig.jobKey, jobKey)).limit(1)
    if (!cfg?.notifyOnError) return
    const now = new Date()
    if (cfg.lastErrorEmailAt && sameLocalDay(cfg.lastErrorEmailAt, now)) return
    const admins = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.isAppAdmin, true))
    const recipients = admins.filter((a) => !!a.email)
    if (recipients.length === 0) return
    // v1.230.0: routed through sendByRule('job_failure_alert', ...) instead
    // of calling sendEmailViaConfigured directly — this used to bypass
    // Admin → Communications entirely (no Active/Inactive gate, no
    // customizable template, invisible on the rules list). Same content as
    // before, now as the rule's default subject/body.
    const safeMessage = (message ?? '(no message)').replace(/</g, '&lt;')
    // v1.436.0: one admin's failed send (or no email integration) must not
    // stop the next admin's email or Slack DM.
    let anySent = false
    for (const a of recipients) {
      const result = await sendByRule('job_failure_alert', {
        to: a.email,
        toName: a.displayName ?? undefined,
        defaultSubject: `[ImpactIQ] Job failed: ${jobKey}`,
        defaultBodyHtml: `<p><strong>Job:</strong> ${jobKey}</p><p><strong>When:</strong> ${startedAt.toISOString()}</p><p><strong>Message:</strong></p><pre>${safeMessage}</pre>`,
        defaultBodyText: `Job ${jobKey} failed at ${startedAt.toISOString()}: ${message ?? '(no message)'}`,
        tokens: { jobKey, when: startedAt.toISOString(), message: message ?? '(no message)' },
        userId: a.id,
        severity: 'critical',
      }).catch(() => null)
      if (result?.sent) anySent = true
    }
    // Stamp only after something went out, so a broken email setup still
    // retries on the next failure (as before).
    if (!anySent) return
    await db.update(jobConfig).set({ lastErrorEmailAt: now }).where(eq(jobConfig.jobKey, jobKey))
  } catch {
    // Swallow email failures — don't cascade back into the job runner.
  }
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
