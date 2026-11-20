// System Health Overview (App Health, v1.440.0): the tile thresholds, the
// email delivery log, and the queue counts against a real (pglite) schema.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'
import { worstStatus } from '../../../shared/healthOverview.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let overview: typeof import('./overview.js')
let deliveryLog: typeof import('../email/deliveryLog.js')
let integrationStatus: typeof import('./integrationStatus.js')
let retention: typeof import('./retention.js')
let readiness: typeof import('./readiness.js')
let lastBackup: typeof import('../backup/lastBackup.js')

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  overview = await import('./overview.js')
  deliveryLog = await import('../email/deliveryLog.js')
  integrationStatus = await import('./integrationStatus.js')
  retention = await import('./retention.js')
  readiness = await import('./readiness.js')
  lastBackup = await import('../backup/lastBackup.js')
})

const MIN = 60 * 1000

describe('worstStatus', () => {
  it('ignores off lines unless every line is off', () => {
    expect(worstStatus(['ok', 'off'])).toBe('ok')
    expect(worstStatus(['ok', 'warning', 'off'])).toBe('warning')
    expect(worstStatus(['warning', 'error'])).toBe('error')
    expect(worstStatus(['off', 'off'])).toBe('off')
    expect(worstStatus([])).toBe('off')
  })
})

describe('thresholds', () => {
  it('queueStatus goes amber at 15 minutes and red at an hour of backlog', () => {
    const q = { pending: 3, failed: 0, blocked: false }
    expect(overview.queueStatus({ ...q, oldestPendingAgeMs: 2 * MIN })).toBe('ok')
    expect(overview.queueStatus({ ...q, oldestPendingAgeMs: 15 * MIN })).toBe('warning')
    expect(overview.queueStatus({ ...q, oldestPendingAgeMs: 60 * MIN })).toBe('error')
    // An age with nothing pending means nothing.
    expect(overview.queueStatus({ ...q, pending: 0, oldestPendingAgeMs: 90 * MIN })).toBe('ok')
  })

  it('queueStatus flags open failures and young work behind a stopped worker', () => {
    expect(overview.queueStatus({ pending: 0, oldestPendingAgeMs: null, failed: 1, blocked: false })).toBe('warning')
    expect(overview.queueStatus({ pending: 1, oldestPendingAgeMs: 1000, failed: 0, blocked: true })).toBe('warning')
    expect(overview.queueStatus({ pending: 0, oldestPendingAgeMs: null, failed: 0, blocked: true })).toBe('ok')
  })

  it('heartbeatOverdue allows a grace period past the armed time', () => {
    const now = Date.now()
    const poller = { intervalMs: 30_000, runningSince: null }
    expect(overview.heartbeatOverdue({ ...poller, nextDueAt: now - 60_000 }, now)).toBe(false)
    expect(overview.heartbeatOverdue({ ...poller, nextDueAt: now - 3 * MIN }, now)).toBe(true)
    const daily = { intervalMs: 24 * 60 * MIN, runningSince: null }
    expect(overview.heartbeatOverdue({ ...daily, nextDueAt: now - 60 * MIN }, now)).toBe(false)
    expect(overview.heartbeatOverdue({ ...daily, nextDueAt: now - 25 * 60 * MIN }, now)).toBe(true)
  })

  it('heartbeatOverdue flags a tick that has run far longer than its interval', () => {
    const now = Date.now()
    expect(overview.heartbeatOverdue({ intervalMs: 30_000, nextDueAt: null, runningSince: now - 30 * MIN }, now)).toBe(false)
    expect(overview.heartbeatOverdue({ intervalMs: 30_000, nextDueAt: null, runningSince: now - 61 * MIN }, now)).toBe(true)
  })

  it('email is down when failures come with no successes', () => {
    expect(overview.emailStatus(10, 0)).toBe('ok')
    expect(overview.emailStatus(10, 1)).toBe('warning')
    expect(overview.emailStatus(0, 2)).toBe('error')
  })

  it('AI budget and error rate', () => {
    expect(overview.aiBudgetStatus(50, null)).toBe('ok')
    expect(overview.aiBudgetStatus(79, 100)).toBe('ok')
    expect(overview.aiBudgetStatus(80, 100)).toBe('warning')
    expect(overview.aiBudgetStatus(100, 100)).toBe('error')
    expect(overview.aiErrorStatus(4, 4)).toBe('ok')
    expect(overview.aiErrorStatus(5, 100)).toBe('ok')
    expect(overview.aiErrorStatus(5, 20)).toBe('warning')
  })

  it('connections and memory', () => {
    expect(overview.connectionsStatus(60, 100)).toBe('ok')
    expect(overview.connectionsStatus(70, 100)).toBe('warning')
    expect(overview.connectionsStatus(95, 100)).toBe('error')
    expect(overview.memoryStatus(500e6)).toBe('ok')
    expect(overview.memoryStatus(1e9)).toBe('warning')
    expect(overview.memoryStatus(2e9)).toBe('error')
  })
})

describe('v1.444.0 thresholds', () => {
  it('a few broken connections are quiet; a real share is a warning', () => {
    expect(overview.shareStatus(1, 50)).toBe('ok')
    expect(overview.shareStatus(3, 50)).toBe('warning')
    expect(overview.shareStatus(1, 4)).toBe('warning')
  })

  it('cache hit ratio needs real volume before it can warn', () => {
    expect(overview.cacheHitStatus(500, 500)).toBe('ok')
    expect(overview.cacheHitStatus(90_000, 10_000)).toBe('warning')
    expect(overview.cacheHitStatus(99_000, 1_000)).toBe('ok')
  })

  it('dead rows count only past a floor and a share of live rows', () => {
    expect(overview.deadRowsHigh(5_000, 0)).toBe(false)
    expect(overview.deadRowsHigh(20_000, 1_000_000)).toBe(false)
    expect(overview.deadRowsHigh(20_000, 50_000)).toBe(true)
  })

  it('backup reminder', () => {
    const now = Date.now()
    expect(overview.backupStatus(null, 14, now)).toBe('warning')
    expect(overview.backupStatus(now - 3 * 24 * 60 * MIN, 14, now)).toBe('ok')
    expect(overview.backupStatus(now - 20 * 24 * 60 * MIN, 14, now)).toBe('warning')
    expect(overview.backupStatus(null, 0, now)).toBe('off')
  })

  it('an integration is failing only while its latest outcome in the last day is a failure', () => {
    const now = Date.now()
    const at = (minAgo: number) => new Date(now - minAgo * MIN)
    expect(overview.integrationCallLine('hubspot', undefined, now).key).toBe('integration_ok')
    expect(overview.integrationCallLine('hubspot', { lastSuccessAt: at(5), lastFailureAt: null, lastError: null }, now))
      .toMatchObject({ key: 'integration_ok_seen', status: 'ok' })
    expect(overview.integrationCallLine('hubspot', { lastSuccessAt: at(30), lastFailureAt: at(5), lastError: '401' }, now))
      .toMatchObject({ key: 'integration_call_failed', status: 'warning', params: { error: '401' } })
    // Recovered since.
    expect(overview.integrationCallLine('hubspot', { lastSuccessAt: at(1), lastFailureAt: at(5), lastError: '401' }, now).key).toBe('integration_ok_seen')
    // An old failure with no success since no longer warns.
    expect(overview.integrationCallLine('hubspot', { lastSuccessAt: null, lastFailureAt: at(48 * 60), lastError: 'x' }, now).key).toBe('integration_ok')
  })
})

describe('integration call status', () => {
  it('keeps the latest success and failure per integration', async () => {
    await integrationStatus.writeIntegrationCall('slack', true)
    await integrationStatus.writeIntegrationCall('slack', false, new Error('invalid_auth'))
    const s = (await integrationStatus.getIntegrationStatuses()).get('slack')
    expect(s?.lastSuccessAt).not.toBeNull()
    expect(s?.lastFailureAt).not.toBeNull()
    expect(s?.lastError).toBe('invalid_auth')
  })

  it('counts active users whose token refresh failed', async () => {
    const [u1] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'A' }).returning()
    const [u2] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'B', disabledAt: new Date() }).returning()
    const rows = await testDb.insert(schema.userIntegrations).values([
      { userId: u1!.id, provider: 'microsoft', accessTokenEncrypted: 'x', refreshTokenEncrypted: 'y' },
      { userId: u2!.id, provider: 'microsoft', accessTokenEncrypted: 'x', refreshTokenEncrypted: 'y' },
    ]).returning()
    for (const r of rows) await integrationStatus.markUserIntegrationFailed(r.id, new Error('invalid_grant'))
    // The disabled user doesn't count.
    expect((await integrationStatus.countUsersNeedingReconnect()).get('microsoft')).toBe(1)
  })
})

describe('retention', () => {
  it('flags a table whose oldest row is past its period plus grace', async () => {
    await testDb.delete(schema.emailDeliveries)
    await testDb.insert(schema.emailDeliveries).values({
      category: 'test', recipient: 'a@example.com', subject: 'old', transport: 'smtp', status: 'sent', createdAt: new Date(Date.now() - 40 * 24 * 60 * MIN),
    })
    const checks = await retention.checkRetention()
    expect(checks.find((c) => c.key === 'email_deliveries')).toMatchObject({ days: 30, overdue: true })
    expect(checks.map((c) => c.key)).toEqual(retention.RETENTION_POLICIES.map((p) => p.key))
    await testDb.delete(schema.emailDeliveries)
    expect((await retention.checkRetention()).find((c) => c.key === 'email_deliveries')).toMatchObject({ oldestAgeDays: null, overdue: false })
  })

  it('reads an env override', () => {
    process.env['JOB_RUNS_RETENTION_DAYS'] = '45'
    try { expect(retention.retentionDays('job_runs')).toBe(45) } finally { delete process.env['JOB_RUNS_RETENTION_DAYS'] }
    expect(retention.retentionDays('job_runs')).toBe(90)
  })
})

describe('readiness calls', () => {
  it('remembers the last caller and counts the last day', () => {
    readiness.resetReadinessCalls()
    expect(readiness.getReadinessCalls().lastCalledAt).toBeNull()
    const now = Date.now()
    readiness.noteReadyCall('UptimeRobot/2.0', true, now - 25 * 60 * MIN)
    readiness.noteReadyCall('ELB-HealthChecker/2.0', false, now)
    const r = readiness.getReadinessCalls(now)
    expect(r).toMatchObject({ lastReady: false, lastUserAgent: 'ELB-HealthChecker/2.0', callsLast24h: 1 })
  })
})

describe('email delivery log', () => {
  beforeEach(async () => {
    await testDb.delete(schema.emailDeliveries)
  })

  it('records outcomes, summarizes the window and never stores more than it needs', async () => {
    await deliveryLog.recordEmailDelivery({ category: 'daily_digest', recipient: 'a@example.com', subject: 'Digest', transport: 'smtp', error: null })
    await deliveryLog.recordEmailDelivery({ category: 'job_failure_alert', recipient: 'b@example.com', subject: 'x'.repeat(500), transport: 'smtp', error: new Error('535 auth failed') })
    const s = await deliveryLog.emailDeliverySummary(new Date(Date.now() - 60 * MIN))
    expect(s.sent).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.lastFailure).toMatchObject({ category: 'job_failure_alert', error: '535 auth failed' })
    expect(s.lastSentAt).not.toBeNull()
    const rows = await testDb.select().from(schema.emailDeliveries)
    expect(Math.max(...rows.map((r) => r.subject.length))).toBeLessThanOrEqual(200)
  })

  it('culls rows past retention', async () => {
    await testDb.insert(schema.emailDeliveries).values([
      { category: 'test', recipient: 'a@example.com', subject: 'old', transport: 'smtp', status: 'sent', createdAt: new Date(Date.now() - 40 * 24 * 60 * MIN) },
      { category: 'test', recipient: 'a@example.com', subject: 'new', transport: 'smtp', status: 'sent' },
    ])
    expect(await deliveryLog.cullEmailDeliveries(30)).toBe(1)
    expect((await testDb.select().from(schema.emailDeliveries)).map((r) => r.subject)).toEqual(['new'])
  })
})

describe('getHealthOverview', () => {
  async function seedActivity(fields: Partial<typeof schema.activities.$inferInsert>) {
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    const [activity] = await testDb.insert(schema.activities).values({
      userId: user!.id, teamId: team!.id, title: 'Acme demo', activityTypeId: type!.id, status: 'submitted',
      startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
      ...fields,
    }).returning()
    return activity!
  }

  it('the Data tile reminds about a backup until one is taken, unless turned off', async () => {
    const data = async () => (await overview.getHealthOverview()).tiles.find((t) => t.id === 'data')!
    expect((await data()).lines.find((l) => l.key.startsWith('backup_'))).toMatchObject({ key: 'backup_never', status: 'warning' })
    await lastBackup.recordBackupCompleted(crypto.randomUUID(), '1.444.0')
    expect((await data()).lines.find((l) => l.key.startsWith('backup_'))).toMatchObject({ key: 'backup_last', status: 'ok' })
    await lastBackup.setBackupReminderDays(0)
    expect((await data()).lines.find((l) => l.key.startsWith('backup_'))).toMatchObject({ key: 'backup_last_off', status: 'off' })
  })

  it('returns every tile, and a broken check stays on its own tile', async () => {
    const result = await overview.getHealthOverview()
    expect(result.tiles.map((t) => t.id)).toEqual(['database', 'jobs', 'queues', 'integrations', 'email', 'ai', 'data', 'app'])
    // Not configured in tests: off, not an error.
    expect(result.tiles.find((t) => t.id === 'email')?.status).toBe('off')
    expect(result.tiles.find((t) => t.id === 'ai')?.status).toBe('off')
  })

  it('counts an old CRM write-back backlog and only unresolved failures, like CRM Sync', async () => {
    await testDb.delete(schema.activities)
    await seedActivity({ crmSyncStatus: 'pending', updatedAt: new Date(Date.now() - 2 * 60 * MIN) })
    const failed = await seedActivity({ crmSyncStatus: 'failed', updatedAt: new Date(Date.now() - 10 * MIN) })
    const resolved = await seedActivity({ crmSyncStatus: 'failed', updatedAt: new Date(Date.now() - 10 * MIN) })
    await testDb.insert(schema.syncIssueResolutions).values({ source: 'activity_writeback', issueKey: resolved.id })

    const queues = (await overview.getHealthOverview()).tiles.find((t) => t.id === 'queues')!
    const crmLines = queues.lines.filter((l) => l.params?.['queue'] === 'crm_writeback')
    expect(crmLines.find((l) => l.key === 'queue_pending')).toMatchObject({ status: 'error', params: { count: 1 } })
    expect(crmLines.find((l) => l.key === 'queue_failed')).toMatchObject({ status: 'warning', params: { count: 1 } })
    expect(queues.status).toBe('error')
    expect(failed.id).toBeTruthy()
  })

  it('counts a note push as failed only while its latest attempt failed and is unresolved', async () => {
    await testDb.delete(schema.activities)
    const activity = await seedActivity({ crmSyncStatus: 'synced' })
    const [note] = await testDb.insert(schema.activityNotes).values({ activityId: activity.id, body: 'n' }).returning()
    const t = (minAgo: number) => new Date(Date.now() - minAgo * MIN)
    await testDb.insert(schema.activityNotePushes).values([
      // Target A: failed, then synced. Not an issue.
      { activityNoteId: note!.id, crmTargetType: 'Opportunity', crmTargetId: 'A', status: 'failed', createdAt: t(30) },
      { activityNoteId: note!.id, crmTargetType: 'Opportunity', crmTargetId: 'A', status: 'synced', createdAt: t(20) },
      // Target B: failed and resolved afterwards. Not an issue.
      { activityNoteId: note!.id, crmTargetType: 'Opportunity', crmTargetId: 'B', status: 'failed', createdAt: t(30) },
      // Target C: failed. An issue.
      { activityNoteId: note!.id, crmTargetType: 'Account', crmTargetId: 'C', status: 'failed', createdAt: t(30) },
    ])
    await testDb.insert(schema.syncIssueResolutions).values({ source: 'note_push', issueKey: `${note!.id}:Opportunity:B` })

    const queues = (await overview.getHealthOverview()).tiles.find((tile) => tile.id === 'queues')!
    const failedLine = queues.lines.find((l) => l.key === 'queue_failed' && l.params?.['queue'] === 'notes_push')
    expect(failedLine?.params?.['count']).toBe(1)
  })
})
