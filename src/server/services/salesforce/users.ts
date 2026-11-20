import { db } from '../../db/index.js'
import { crmUsers } from '../../../../drizzle/schema.js'
import { sql } from 'drizzle-orm'
import { getAdminSfConnection, getAdminSfConnectionRecord } from './client.js'
import { writeRun } from '../jobs/writeRun.js'
import { scheduleJob } from '../jobs/scheduler.js'

interface SfUserRecord {
  Id: string
  Name: string
  Email: string | null
  ManagerId: string | null
  IsActive: boolean
}

// Syncs the SF User directory into local crm_users. Uses the org-wide admin SF
// connection so we don't need per-user OAuth. Pages via queryMore(); upserts
// on Id conflict. Returns count of rows written.
export async function syncSfUsers(): Promise<{ upserted: number }> {
  const conn = await getAdminSfConnection()
  if (!conn) throw new Error('errors.salesforce.admin_connection_missing')

  const soql = 'SELECT Id, Name, Email, ManagerId, IsActive FROM User WHERE IsActive = true'
  const collected: SfUserRecord[] = []

  let result = await conn.query<SfUserRecord>(soql)
  collected.push(...result.records)
  while (!result.done && result.nextRecordsUrl) {
    result = await conn.queryMore<SfUserRecord>(result.nextRecordsUrl)
    collected.push(...result.records)
  }

  if (collected.length === 0) return { upserted: 0 }

  const now = new Date()
  // First pass: insert every row without manager_id so we don't hit a
  // self-FK violation when a manager appears later in the list. Second pass:
  // set manager_id.
  const chunkSize = 500
  for (let i = 0; i < collected.length; i += chunkSize) {
    const chunk = collected.slice(i, i + chunkSize)
    await db
      .insert(crmUsers)
      .values(chunk.map((r) => ({
        id: r.Id,
        name: r.Name,
        email: r.Email,
        managerId: null,
        isActive: r.IsActive,
        lastSyncedAt: now,
      })))
      .onConflictDoUpdate({
        target: crmUsers.id,
        set: {
          name: sql`excluded.name`,
          email: sql`excluded.email`,
          isActive: sql`excluded.is_active`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      })
  }
  // Second pass: apply manager references now that all rows exist.
  for (const r of collected) {
    if (!r.ManagerId) continue
    await db
      .update(crmUsers)
      .set({ managerId: r.ManagerId })
      .where(sql`${crmUsers.id} = ${r.Id}`)
  }
  return { upserted: collected.length }
}

// v1.437.0: nightly Salesforce user directory refresh, the Salesforce
// counterpart of hubspot_owner_sync. Before this, crm_users only refreshed
// when an admin pressed Sync on Sales Team Alignment, so a new rep or a
// manager change never reached alignment until someone remembered to.
// A quiet no-op (no job_runs row) with no admin Salesforce connection, as
// hubspot_owner_sync is without a HubSpot key; the scheduler skips it on
// any other CRM (jobs/jobCrm.ts).
export const SF_USER_SYNC_JOB_KEY = 'salesforce_user_sync'

export async function runSfUserSync(opts: { source?: 'scheduled' | 'manual' } = {}): Promise<{ upserted: number } | null> {
  const record = await getAdminSfConnectionRecord()
  if (!record?.accessTokenEncrypted) return null
  const startedAt = new Date()
  try {
    const result = await syncSfUsers()
    await writeRun(SF_USER_SYNC_JOB_KEY, startedAt, 'ok', `${result.upserted} active Salesforce users`, { ...result, source: opts.source ?? 'scheduled' })
    return result
  } catch (err) {
    const code = err instanceof Error ? err.message : String(err)
    await writeRun(SF_USER_SYNC_JOB_KEY, startedAt, 'error', code, { source: opts.source ?? 'scheduled' })
    throw err
  }
}

let stopFn: (() => void) | null = null
export function startSfUserSyncWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(SF_USER_SYNC_JOB_KEY, 24 * 60 * 60 * 1000, async () => {
    await runSfUserSync().catch(() => {})
  }, { firstRunDelayMs: 3 * 60 * 1000 })
}
