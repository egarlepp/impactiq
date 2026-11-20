import { Router } from 'express'
import { db } from '../../db/index.js'
import { and, eq, sql, gte, inArray } from 'drizzle-orm'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { desc } from 'drizzle-orm'

export const schedulingRoutes = Router()

// ─── v1.138.0 / v1.141.0: Scheduling / job-runs monitor ─────────────────
schedulingRoutes.get('/scheduling', requireAppAdmin, async (req, res) => {
  const { jobRuns, jobConfig } = await import('../../../../drizzle/schema.js')
  const { getCrmProviderId } = await import('../../services/crm/providerSetting.js')
  const { jobAppliesToCrm } = await import('../../services/jobs/jobCrm.js')
  const { jobWaitingFor } = await import('../../services/jobs/jobReadiness.js')
  const { parseRecentRunLimit, parseRecentRunPage } = await import('../../../shared/jobCategories.js')
  // v1.439.0: Recent runs shows 20, 50 or 100 a page (anything else is 20).
  // v1.441.0: paged with ?recentPage=.
  const recentLimit = parseRecentRunLimit(req.query.recent)
  const recentPage = parseRecentRunPage(req.query.recentPage)
  const activeCrm = await getCrmProviderId()
  // v1.227.0: cadenceEditable + defaultIntervalMs — the admin-editable
  // interval (job_config.interval_ms) is only honored by the scheduler for
  // jobs marked cadenceEditable: true. digest_worker / weekly_recap_worker
  // tick frequently just to check a clock (daily 08:00 / Friday PM local) —
  // their meaningful "cadence" is that gate, not the tick itself, so their
  // interval stays fixed. historical_backfill isn't scheduled at all (it's
  // admin-triggered from the CRM Historical Import page).
  //
  // notes_push_worker's default corrected 60s → 30s here to match the
  // service's actual POLL_INTERVAL_MS — the display string had drifted from
  // the code.
  const listed = [
    { jobKey: 'refresh_opp_snapshots', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'SF Opp snapshot refresh (Sales Stage / Forecast / Owner / Assigned SE / …)' },
    { jobKey: 'refresh_opp_coverage',  cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'Salesforce Attach Rate coverage refresh (SE attachment per Opportunity)' },
    // v1.437.0: both were running nightly but missing from this list.
    { jobKey: 'detect_disconnected_links', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'Salesforce link health: flags activities whose linked Salesforce record was deleted' },
    { jobKey: 'salesforce_user_sync', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'Salesforce user list refresh, for Sales Team Alignment and matching users to Salesforce users' },
    { jobKey: 'writeback_worker',       cadence: '30s', defaultIntervalMs: 30 * 1000, cadenceEditable: true, description: 'Salesforce activity write-back queue' },
    { jobKey: 'outlook_writeback_worker', cadence: '30s', defaultIntervalMs: 30 * 1000, cadenceEditable: true, description: 'Outlook calendar write-back queue (per-user opt-in)' },
    { jobKey: 'notes_push_worker',      cadence: '30s', defaultIntervalMs: 30 * 1000, cadenceEditable: true, description: 'Salesforce note push queue (Notes → ContentNote)' },
    { jobKey: 'notification_sweep',     cadence: '30min', defaultIntervalMs: 30 * 60 * 1000, cadenceEditable: true, description: 'Nudges for every user in working hours (in-app, email, Slack) and announcements to Slack' },
    { jobKey: 'event_webhook_worker',   cadence: '30s', defaultIntervalMs: 30 * 1000, cadenceEditable: true, description: 'Outbound event webhook deliveries, with retries' },
    { jobKey: 'anomaly_webhook_scan',   cadence: '6h', defaultIntervalMs: 6 * 60 * 60 * 1000, cadenceEditable: true, description: 'Sends each team\'s "What changed" findings to event webhooks, once per completed week' },
    // v1.230.0: these two never had an admin-meaningful interval to edit
    // (cadenceEditable stays false — see the comment above), but their
    // clock-check TARGET is now editable, via a separate scheduleEditable
    // flag and job_config.schedule_hour/minute/day_of_week (independent of
    // interval editing entirely).
    // v1.231.0: emailRuleKey/emailRuleName point at the Communications rule
    // each job's regular (non-error) email actually goes through — so an
    // admin reading Scheduling can jump straight to the exact rule that
    // controls what these two jobs send, by name, without guessing.
    // v1.329.0: cadence text shortened to just the raw tick — the actual
    // send time now has its own Send Window column instead of being folded
    // into this label, since the two are genuinely different concepts (how
    // often the scheduler checks vs. when the check considers itself due).
    { jobKey: 'digest_worker',          cadence: '60s tick', defaultIntervalMs: 60 * 1000, cadenceEditable: false, scheduleEditable: true, scheduleKind: 'daily' as const, defaultScheduleHour: 8, defaultScheduleMinute: 0, description: 'Morning notification digest', emailRuleKey: 'daily_digest', emailRuleName: 'Daily notification digest' },
    { jobKey: 'weekly_recap_worker',    cadence: '5min tick', defaultIntervalMs: 5 * 60 * 1000, cadenceEditable: false, scheduleEditable: true, scheduleKind: 'weekly' as const, defaultScheduleHour: 17, defaultScheduleMinute: 0, defaultScheduleDayOfWeek: 5, description: 'Weekly SE recap email', emailRuleKey: 'weekly_recap', emailRuleName: 'Weekly recap' },
    { jobKey: 'sync_audit_cull',        cadence: '6h', defaultIntervalMs: 6 * 60 * 60 * 1000, cadenceEditable: true, description: 'Retention cull: CRM sync audit, nudges, MCP, audit log, job runs, login history, AI and webhook logs' },
    // v1.388.0: no-op tick (no job_runs row) unless CriteriaIQ is the primary
    // Project source and activities link CriteriaIQ projects; see
    // services/criteriaiq/primaryProjects.ts.
    { jobKey: 'refresh_criteriaiq_projects', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'CriteriaIQ project snapshot refresh (CriteriaIQ as the primary Project source)' },
    { jobKey: 'gong_call_index', cadence: '15m', defaultIntervalMs: 15 * 60 * 1000, cadenceEditable: true, description: 'Gong call index, for transcript suggestions and search on activities' },
    { jobKey: 'gong_auto_link', cadence: '15m', defaultIntervalMs: 15 * 60 * 1000, cadenceEditable: true, description: 'Gong auto-link: links a recorded call to its activity when the match is clear (same meeting, or one strong match)' },
    { jobKey: 'gong_user_sync', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'Gong user list refresh, for matching users to Gong users by email' },
    { jobKey: 'hubspot_owner_sync', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'HubSpot owner list refresh, for matching users to HubSpot owners by email' },
    { jobKey: 'refresh_hubspot_snapshots', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'HubSpot Deal snapshot refresh (Deal stage / forecast / amount / owner / SE / Company)' },
    { jobKey: 'refresh_hubspot_opp_coverage', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'HubSpot Attach Rate coverage refresh (Deals and the Attach Rate fields, for the Attach Rate dashboard)' },
    { jobKey: 'hubspot_detect_disconnected_links', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'HubSpot link health: flags activities whose linked HubSpot record is gone, moves links off merged records' },
    { jobKey: 'hubspot_writeback_worker', cadence: '30s', defaultIntervalMs: 30 * 1000, cadenceEditable: true, description: 'HubSpot activity write-back queue (meetings and tasks)' },
    { jobKey: 'hubspot_notes_push_worker', cadence: '30s', defaultIntervalMs: 30 * 1000, cadenceEditable: true, description: 'HubSpot note push queue (notes on Deals and Companies)' },
    { jobKey: 'refresh_historical_opps', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'Historical import: refresh open Opportunities (Salesforce) or Deals (HubSpot)' },
    { jobKey: 'historical_backfill',     cadence: 'manual (admin-triggered)', defaultIntervalMs: null, cadenceEditable: false, description: 'Historical import: pre-ImpactIQ CRM activity backfill (Salesforce Events or HubSpot meetings)' },
    { jobKey: 'password_expiry_enforcement', cadence: '24h', defaultIntervalMs: 24 * 60 * 60 * 1000, cadenceEditable: true, description: 'Force password reset for authMethod=password accounts whose password is 90+ days old' },
    // v1.332.0: no-op tick (no job_runs row) until an admin configures a
    // GitHub PAT under Admin → Integrations → App Updates — see
    // services/updates/checkForUpdates.ts.
    { jobKey: 'check_for_updates', cadence: '6h', defaultIntervalMs: 6 * 60 * 60 * 1000, cadenceEditable: true, description: 'Check the pinned GitHub branch for a newer app version' },
    // v1.333.0: no-op tick (no job_runs row) unless a default admin has
    // scheduled a maintenance window that's now due — see
    // services/updates/restartScheduler.ts. Cadence is deliberately NOT
    // editable: 15s is already tight enough that widening it has no real
    // benefit, and narrowing it below the job's own grace delay would be
    // pointless.
    { jobKey: 'restart_scheduler', cadence: '15s', defaultIntervalMs: 15 * 1000, cadenceEditable: false, description: 'Restart the app process when a scheduled maintenance window is reached' },
  ].filter((r) => jobAppliesToCrm(r.jobKey, activeCrm))
  // v1.438.0: the setup each listed job is still waiting for (null = ready).
  // A waiting job doesn't run, so the page shows that instead of Active.
  const registry = await Promise.all(listed.map(async (r) => ({ ...r, waitingFor: await jobWaitingFor(r.jobKey, activeCrm) })))
  // v1.437.0: only the active CRM's jobs are listed (jobs/jobCrm.ts), and with
  // the CRM set to None no CRM job is. The scheduler skips the same jobs, so
  // the page shows exactly what runs. Recent runs and the failed-runs count
  // follow the same list, so an old run of the other CRM's job can't light up
  // a KPI for a job that isn't shown.
  const visibleKeys = registry.map((r) => r.jobKey)
  const latestPerJob = await db.execute(sql`
    SELECT DISTINCT ON (job_key) job_key, started_at, finished_at, duration_ms, status, message
    FROM job_runs
    WHERE job_key IN (${sql.join(visibleKeys.map((k) => sql`${k}`), sql`, `)})
    ORDER BY job_key, started_at DESC
  `)
  const recentWhere = inArray(jobRuns.jobKey, visibleKeys)
  const [recentTotalRow] = await db.select({ c: sql<number>`count(*)::int` }).from(jobRuns).where(recentWhere)
  const recentTotal = Number(recentTotalRow?.c ?? 0)
  const recent = await db.select().from(jobRuns).where(recentWhere)
    .orderBy(desc(jobRuns.startedAt)).limit(recentLimit).offset((recentPage - 1) * recentLimit)
  const config = await db.select().from(jobConfig)
  // v1.330.0: backs the Scheduling KPI row's "Failed Runs (7d)" card. The
  // `recent` list above is capped at 20 rows total across every job, which
  // isn't enough to count reliably — one noisy job can push another job's
  // real errors out of that window entirely. A dedicated count avoids that.
  const [failedRuns7dRow] = await db.select({ c: sql<number>`count(*)::int` }).from(jobRuns)
    .where(and(eq(jobRuns.status, 'error'), inArray(jobRuns.jobKey, visibleKeys),
      gte(jobRuns.startedAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))))
  // v1.231.0: the "Email admins on error" toggle on every row sends through
  // this same rule, regardless of which job tripped it — surfaced once here
  // rather than duplicated onto every registry entry.
  const errorEmailRule = { key: 'job_failure_alert', name: 'Scheduled job failure alert' }
  res.json({ data: { registry, latest: latestPerJob, recent, config, errorEmailRule, failedRuns7d: Number(failedRuns7dRow?.c ?? 0), activeCrm, recentLimit, recentPage, recentTotal }, error: null })
})

// v1.443.0: Clear on Recent runs deletes every row in job_runs (v1.441.0
// only hid them). The KPI cards, each job's Last run and Failed Runs (7d) read
// the same table, so they start over too; the confirm prompt says so.
schedulingRoutes.post('/scheduling/recent-runs/clear', requireAppAdmin, async (req, res) => {
  const { jobRuns } = await import('../../../../drizzle/schema.js')
  const deleted = (await db.delete(jobRuns).returning({ id: jobRuns.id })).length
  await logAudit(req, { action: 'job_runs.clear', targetType: 'scheduling', targetId: 'recent_runs', meta: { deleted } })
  res.json({ data: { deleted }, error: null, meta: {} })
})

// v1.283.0: force a job to run immediately, for an admin to test a job
// without waiting for its next natural tick. Invokes the exact task
// scheduleJob() registered for this jobKey — see scheduler.ts's registry —
// so this can never drift from what the job actually does on schedule.
// historical_backfill isn't registered (it's never passed through
// scheduleJob(); it has its own dedicated trigger under CRM Historical
// Import), so it 404s here rather than getting a second, redundant trigger.
schedulingRoutes.post('/scheduling/:jobKey/run-now', requireAppAdmin, async (req, res) => {
  const { jobKey } = req.params as { jobKey: string }
  const { runJobNow, isJobRegistered } = await import('../../services/jobs/scheduler.js')
  if (!isJobRegistered(jobKey)) {
    res.status(404).json({ data: null, error: 'errors.scheduling.job_not_runnable', meta: {} }); return
  }
  // v1.328.0: digest_worker/weekly_recap_worker only write a job_runs row
  // when they actually send something — the clock-gated "is it the right
  // send window" check they share with their real scheduled tick (see
  // scheduler.ts's comment on this) means clicking Run Now outside that
  // window, or after everyone already got today's/this week's send, does
  // nothing at all, silently. Previously this endpoint always answered
  // `{ ran: true }` either way, which reads identically to "nothing
  // happened" whether the task genuinely ran and sent zero emails or the
  // button itself is broken — that ambiguity is exactly what got reported
  // as a bug. Comparing the latest job_runs row for this key before/after
  // lets the response — and the client's toast — tell the two apart.
  const { jobRuns } = await import('../../../../drizzle/schema.js')
  const [before] = await db.select({ startedAt: jobRuns.startedAt }).from(jobRuns)
    .where(eq(jobRuns.jobKey, jobKey)).orderBy(desc(jobRuns.startedAt)).limit(1)
  const result = await runJobNow(jobKey)
  // v1.414.0: the job is mid-run here or on another replica (jobLock.ts).
  // Not an error, so the page shows its own "already running" state.
  // v1.437.0: a job for a CRM that isn't the active one doesn't run.
  if (!result.ok && result.error === 'inactive_crm') {
    res.status(409).json({ data: null, error: 'errors.scheduling.job_inactive_crm', meta: {} }); return
  }
  // v1.438.0: its integration isn't connected yet (jobReadiness.ts).
  if (!result.ok && result.error === 'not_set_up') {
    res.status(409).json({ data: null, error: 'errors.scheduling.job_not_set_up', meta: {} }); return
  }
  if (!result.ok && result.error === 'already_running') {
    res.json({ data: { ran: false, recordedNewRun: false, alreadyRunning: true, nextEtaMinutes: null }, error: null, meta: {} }); return
  }
  if (!result.ok) {
    res.json({ data: null, error: 'errors.scheduling.run_now_failed', meta: { message: result.error } }); return
  }
  const [after] = await db.select({ startedAt: jobRuns.startedAt, message: jobRuns.message }).from(jobRuns)
    .where(eq(jobRuns.jobKey, jobKey)).orderBy(desc(jobRuns.startedAt)).limit(1)
  const recordedNewRun = !!after && (!before || after.startedAt.getTime() !== before.startedAt.getTime())
  // v1.329.0: on a noop for one of the two clock-gated jobs, tell the admin
  // when it could actually do something next — the real per-user ETA (each
  // enabled user's own local send time), not a guess against one timezone.
  // See getNextDigestEtaMinutes/getNextWeeklyRecapEtaMinutes for why this
  // can't be a single global "next tick" answer.
  let nextEtaMinutes: number | null = null
  if (!recordedNewRun) {
    if (jobKey === 'digest_worker') {
      const { getNextDigestEtaMinutes } = await import('../../services/notifications/digest.js')
      nextEtaMinutes = await getNextDigestEtaMinutes()
    } else if (jobKey === 'weekly_recap_worker') {
      const { getNextWeeklyRecapEtaMinutes } = await import('../../services/notifications/weekly-recap.js')
      nextEtaMinutes = await getNextWeeklyRecapEtaMinutes()
    }
  }
  res.json({ data: { ran: true, recordedNewRun, message: recordedNewRun ? (after?.message ?? null) : null, nextEtaMinutes }, error: null })
})
