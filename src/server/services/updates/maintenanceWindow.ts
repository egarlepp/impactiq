// v1.333.0: App Updates Phase 2 — a default-admin-scheduled maintenance
// window that (1) announces an upcoming restart to every signed-in user
// (MaintenanceBanner.tsx) with a live countdown in the final 30 minutes, and
// (2) at the scheduled instant, has the app restart its own process (see
// restartScheduler.ts). See CLAUDE.md §14b for the full writeup, including
// the important caveat: self-restarting only puts a NEWER version in place
// if the admin has already staged a rebuilt image/container out-of-band
// before the scheduled time — this feature automates the moment of cutover,
// not the build-and-deploy step itself, which stays host-specific and
// intentionally outside this app.
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'

const CONFIG_KEY = 'maintenance_window'

export interface MaintenanceWindow {
  scheduledAt: string // ISO
  message: string | null
  status: 'scheduled' | 'completed' | 'cancelled'
  createdBy: string
  createdByEmail: string | null
  createdAt: string // ISO
  completedAt: string | null
}

async function readWindow(): Promise<MaintenanceWindow | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, CONFIG_KEY)).limit(1)
  return (row?.value as MaintenanceWindow | undefined) ?? null
}

async function writeWindow(value: MaintenanceWindow): Promise<void> {
  const [existing] = await db.select({ key: systemSettings.key }).from(systemSettings).where(eq(systemSettings.key, CONFIG_KEY)).limit(1)
  if (existing) {
    await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, CONFIG_KEY))
  } else {
    await db.insert(systemSettings).values({ key: CONFIG_KEY, value })
  }
}

// GET /admin/maintenance-window — deliberately readable by any signed-in
// user (registered before adminRouter's blanket admin gate, same convention
// as the v1.322.0 fiscal-year fix), since the whole point is every user
// sees the announcement, not just admins.
export async function getMaintenanceWindow(): Promise<MaintenanceWindow | null> {
  return readWindow()
}

// requireDefaultAdmin-gated at the route layer. Overwrites any existing
// window (scheduled, completed, or cancelled) — there is only ever one
// "current" window; scheduling a new one always replaces whatever was there,
// which is the expected behavior for "change the announced time."
export async function scheduleMaintenanceWindow(
  scheduledAt: Date,
  message: string | null,
  createdBy: string,
  createdByEmail: string | null,
): Promise<MaintenanceWindow> {
  const value: MaintenanceWindow = {
    scheduledAt: scheduledAt.toISOString(),
    message,
    status: 'scheduled',
    createdBy,
    createdByEmail,
    createdAt: new Date().toISOString(),
    completedAt: null,
  }
  await writeWindow(value)
  return value
}

// requireDefaultAdmin-gated at the route layer. Deletes the row outright
// (not a 'cancelled' status left lingering) — there is nothing useful to
// show users about a window that never happened, unlike a 'completed' one
// which backs the post-restart confirmation banner.
export async function cancelMaintenanceWindow(): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, CONFIG_KEY))
}

export function isMaintenanceWindowDue(window: MaintenanceWindow, now: Date): boolean {
  return window.status === 'scheduled' && new Date(window.scheduledAt).getTime() <= now.getTime()
}

// Called by the restart-scheduler job right before it exits the process.
// Returns the updated window so the job can log/audit it, or null if there
// was nothing due (the job re-checks itself right before calling this, but
// re-reading here guards against a race with an admin cancelling between
// the job's own check and this write).
export async function markMaintenanceWindowCompleted(): Promise<MaintenanceWindow | null> {
  const current = await readWindow()
  if (!current || !isMaintenanceWindowDue(current, new Date())) return null
  const updated: MaintenanceWindow = { ...current, status: 'completed', completedAt: new Date().toISOString() }
  await writeWindow(updated)
  return updated
}
