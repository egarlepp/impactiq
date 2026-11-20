import { inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'
import { BACKUP_REMINDER_DAYS_DEFAULT, BACKUP_REMINDER_DAY_OPTIONS, type BackupReminderDays } from '../../../shared/healthOverview.js'

// v1.444.0: when the last full backup was downloaded from Admin → Backup &
// Restore, and how long App Health waits before reminding an admin to take
// another. 0 days turns the reminder off (for an install whose host already
// backs up the database). Both live in system_settings, so a restore brings
// back the values as they were when that backup was taken.

const LAST_KEY = 'backup_last_export'
const REMINDER_KEY = 'backup_reminder_days'

export interface BackupStatus {
  lastBackupAt: string | null
  lastBackupBy: string | null
  reminderDays: BackupReminderDays
}

function isReminderDays(v: unknown): v is BackupReminderDays {
  return typeof v === 'number' && (BACKUP_REMINDER_DAY_OPTIONS as readonly number[]).includes(v)
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const rows = await db.select().from(systemSettings).where(inArray(systemSettings.key, [LAST_KEY, REMINDER_KEY]))
  const last = rows.find((r) => r.key === LAST_KEY)?.value as { at?: unknown; userId?: unknown } | undefined
  const reminder = (rows.find((r) => r.key === REMINDER_KEY)?.value as { days?: unknown } | undefined)?.days
  return {
    lastBackupAt: typeof last?.at === 'string' ? last.at : null,
    lastBackupBy: typeof last?.userId === 'string' ? last.userId : null,
    reminderDays: isReminderDays(reminder) ? reminder : BACKUP_REMINDER_DAYS_DEFAULT,
  }
}

async function upsert(key: string, value: Record<string, unknown>): Promise<void> {
  await db.insert(systemSettings).values({ key, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } })
}

// Called once the whole backup file has been written to the download.
export async function recordBackupCompleted(userId: string, appVersion: string): Promise<void> {
  await upsert(LAST_KEY, { at: new Date().toISOString(), userId, appVersion })
}

export async function setBackupReminderDays(days: BackupReminderDays): Promise<void> {
  await upsert(REMINDER_KEY, { days })
}
