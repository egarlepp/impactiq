// v1.333.0: App Updates Phase 2 — the process side of the scheduled
// maintenance window. See maintenanceWindow.ts and CLAUDE.md §14b for the
// full model; the short version: this job's only job is to notice the
// admin-scheduled instant has arrived and exit the current process at
// (approximately) that moment, relying on the container's restart policy
// (`unless-stopped` or equivalent — see docker-compose.yml) to bring it back
// up. It does NOT pull code, rebuild, or redeploy anything — see the
// maintenanceWindow.ts header comment for why that stays a manual,
// host-specific step outside this app.
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { logSystemAudit } from '../audit/log.js'
import { getMaintenanceWindow, isMaintenanceWindowDue, markMaintenanceWindowCompleted } from './maintenanceWindow.js'

export const RESTART_SCHEDULER_JOB_KEY = 'restart_scheduler'

// Gives the just-written job_runs/audit rows a moment to land, and any
// in-flight request a moment to finish, before the process exits. Not a
// real graceful-drain (no server.close()) — deliberate: a maintenance-window
// restart is expected, announced downtime, not an unplanned crash, so a
// short flat delay is enough rather than plumbing a drain hook through
// index.ts for this one job.
const RESTART_GRACE_MS = 3000

let stopFn: (() => void) | null = null
export function startRestartScheduler(): void {
  if (stopFn) return
  stopFn = scheduleJob(RESTART_SCHEDULER_JOB_KEY, 15 * 1000, async () => {
    const startedAt = new Date()
    const window = await getMaintenanceWindow()
    // No-op tick (no job_runs row) whenever there's nothing due — this ticks
    // every 15s essentially forever, so it must follow the same "only log
    // real work" gate every other fast-tick job in this app already does
    // (CLAUDE.md's Scheduling convention).
    if (!window || !isMaintenanceWindowDue(window, new Date())) return

    // Re-reads and re-checks inside markMaintenanceWindowCompleted() itself
    // — guards against an admin cancelling the window in the gap between
    // the read above and this write. A null result means we lost that race.
    const completed = await markMaintenanceWindowCompleted()
    if (!completed) return

    await logSystemAudit({
      action: 'system_update.restart_triggered',
      targetType: 'integration',
      targetId: 'maintenance_window',
      meta: { scheduledAt: completed.scheduledAt, completedAt: completed.completedAt },
    })
    await writeRun(
      RESTART_SCHEDULER_JOB_KEY,
      startedAt,
      'ok',
      `Restarting process for scheduled maintenance window (was due at ${completed.scheduledAt})`,
      completed,
    )

    console.log(`[restart-scheduler] Scheduled maintenance window reached (${completed.scheduledAt}) — restarting process in ${RESTART_GRACE_MS}ms`)
    setTimeout(() => process.exit(0), RESTART_GRACE_MS)
  }, { firstRunDelayMs: 5 * 1000 })
}
