import postgres from 'postgres'
import { pgTlsOptions } from '../../db/index.js'

// v1.414.0: background jobs run in every app process, so a second replica
// (a rolling deploy's overlap, or a deliberate scale-out) would double-send
// digests, double-process the write-back queues, and race the snapshot
// refreshers. Each run now takes a Postgres advisory lock keyed by jobKey
// first; whichever process gets it runs the task and the others skip that
// tick. No new table, nothing to clean up: Postgres drops a session lock by
// itself when the connection goes away, including when a process dies.
//
// Session locks belong to a connection, so lock and unlock have to go
// through the same one. They get their own single-connection client rather
// than the app pool: holding a pooled connection for the length of a task
// would take one away from every query the task itself makes. One session
// can hold any number of locks, so one connection serves every job.
// idle_timeout and max_lifetime are off because closing this connection
// mid-task would release a lock that is still in use.
//
// Two-int form, (namespace, hashtext(jobKey)): Postgres keeps it separate
// from the single-bigint key the migrator uses (727_445_301).
const JOB_LOCK_NAMESPACE = 727_445_302

let lockClient: ReturnType<typeof postgres> | null = null

function getLockClient(): ReturnType<typeof postgres> | null {
  if (lockClient) return lockClient
  const url = process.env['DATABASE_URL']
  if (!url) return null
  const ssl = pgTlsOptions()
  lockClient = postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connection: { application_name: 'impactiq-job-locks' },
    ...(ssl ? { ssl } : {}),
  })
  return lockClient
}

// Session locks are re-entrant inside one connection, so the advisory lock
// alone can't stop the same process overlapping itself (Run Now clicked
// while the scheduled tick is mid-run). This set covers that case.
const runningHere = new Set<string>()

export type JobLockResult = { ran: true } | { ran: false; reason: 'locked' }

export async function withJobLock(jobKey: string, task: () => Promise<void>): Promise<JobLockResult> {
  if (runningHere.has(jobKey)) return { ran: false, reason: 'locked' }
  runningHere.add(jobKey)
  try {
    const client = getLockClient()
    // No database configured (setup mode, unit tests): nothing to share a
    // lock with, so run as a single instance did before.
    if (!client) {
      await task()
      return { ran: true }
    }
    let acquired: boolean
    try {
      const [row] = await client<{ ok: boolean }[]>`
        select pg_try_advisory_lock(${JOB_LOCK_NAMESPACE}::int, hashtext(${jobKey})) as ok`
      acquired = row?.ok === true
    } catch (err) {
      // Fail open: a lock-connection hiccup must not stop every job. The
      // worst case is one tick that may overlap another replica, which is
      // what every tick did before this existed.
      console.warn(`[job-lock:${jobKey}] lock check failed, running without it:`, err instanceof Error ? err.message : err)
      await task()
      return { ran: true }
    }
    if (!acquired) return { ran: false, reason: 'locked' }
    try {
      await task()
    } finally {
      try {
        await client`select pg_advisory_unlock(${JOB_LOCK_NAMESPACE}::int, hashtext(${jobKey}))`
      } catch (err) {
        // If the connection dropped, Postgres already released the lock.
        console.warn(`[job-lock:${jobKey}] unlock failed:`, err instanceof Error ? err.message : err)
      }
    }
    return { ran: true }
  } finally {
    runningHere.delete(jobKey)
  }
}
