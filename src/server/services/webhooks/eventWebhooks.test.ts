// pglite-backed: outbound event webhooks (docs/event-webhooks.md). Which
// webhooks an event is queued for, what the worker sends and how it retries,
// the activity payload's privacy rule, and the admin routes' secret handling.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../../db/testDb.js'
import { retryDelayMinutes, webhookWantsEvent, MAX_DELIVERY_ATTEMPTS } from '../../../shared/eventWebhooks.js'
// safeFetch pins DNS through undici's own fetch and never follows a redirect;
// these tests stub the global fetch, so the mock keeps the redirect rule.
vi.mock('../net/safeFetch.js', () => ({ safeFetch: (url: string | URL, init?: RequestInit) => globalThis.fetch(url, { ...init, redirect: 'manual' }) }))


vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let events: typeof import('./events.js')
let delivery: typeof import('./delivery.js')
let signing: typeof import('./signing.js')
let crypto: typeof import('../config/crypto.js')
let app: express.Express
let currentUserId = ''

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  events = await import('./events.js')
  delivery = await import('./delivery.js')
  signing = await import('./signing.js')
  crypto = await import('../config/crypto.js')
  const { eventWebhooksRoutes } = await import('../../routes/admin/eventWebhooks.js')
  app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string; email: string } }).user = { id: currentUserId, email: 'admin@example.com' }; next() })
  app.use('/api/admin', eventWebhooksRoutes)
})

// TEST-NET-3: a public address that needs no DNS lookup.
const URL_OK = 'https://203.0.113.10/hook'

async function reset() {
  await testDb.delete(schema.eventWebhookDeliveries)
  await testDb.delete(schema.eventWebhooks)
}

beforeEach(reset)
afterEach(() => { vi.unstubAllGlobals() })

async function addHook(values: Partial<typeof schema.eventWebhooks.$inferInsert> = {}) {
  const [row] = await testDb.insert(schema.eventWebhooks).values({
    name: 'n8n', url: URL_OK, secretEncrypted: crypto.encryptToken('whsec_test'), events: ['activity.submitted'], ...values,
  }).returning()
  return row!
}

async function fixtures(activity: Partial<typeof schema.activities.$inferInsert> = {}) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'Sales Engineering', slug: `t-${globalThis.crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${globalThis.crypto.randomUUID()}`, email: `${globalThis.crypto.randomUUID()}@example.com`, displayName: 'Dana' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  const [row] = await testDb.insert(schema.activities).values({
    userId: user!.id, teamId: team!.id, title: 'Acme demo', activityTypeId: type!.id, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    ...activity,
  }).returning()
  return { team: team!, user: user!, activity: row! }
}

function respond(status: number) {
  const fetchMock = vi.fn(async () => new Response(status === 204 ? null : 'ok', { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('subscription rules', () => {
  const hook = { isActive: true, events: ['activity.submitted', 'job.failed', 'anomaly.found'], teamIds: ['team-a'], userIds: [] as string[] }
  const team = (id: string) => ({ teamIds: [id], userId: null })

  it('matches on event type and team', () => {
    expect(webhookWantsEvent(hook, 'activity.submitted', team('team-a'))).toBe(true)
    expect(webhookWantsEvent(hook, 'activity.submitted', team('team-b'))).toBe(false)
    expect(webhookWantsEvent(hook, 'nudge.sent', team('team-a'))).toBe(false)
    expect(webhookWantsEvent({ ...hook, isActive: false }, 'activity.submitted', team('team-a'))).toBe(false)
    expect(webhookWantsEvent({ ...hook, teamIds: [] }, 'activity.submitted', team('team-z'))).toBe(true)
  })

  it('sends a teamless event to a team-limited webhook that subscribes to it', () => {
    expect(webhookWantsEvent(hook, 'job.failed', { teamIds: null, userId: null })).toBe(true)
  })

  it('matches a person event on any of their teams', () => {
    expect(webhookWantsEvent(hook, 'activity.submitted', { teamIds: ['team-b', 'team-a'], userId: 'u1' })).toBe(true)
    expect(webhookWantsEvent(hook, 'activity.submitted', { teamIds: [], userId: 'u1' })).toBe(false)
  })

  it('limits person events to the chosen people, and leaves other events alone', () => {
    const limited = { ...hook, userIds: ['u1'] }
    expect(webhookWantsEvent(limited, 'activity.submitted', { teamIds: ['team-a'], userId: 'u1' })).toBe(true)
    expect(webhookWantsEvent(limited, 'activity.submitted', { teamIds: ['team-a'], userId: 'u2' })).toBe(false)
    expect(webhookWantsEvent(limited, 'anomaly.found', team('team-a'))).toBe(true)
    expect(webhookWantsEvent(limited, 'job.failed', { teamIds: null, userId: null })).toBe(true)
  })

  it('retries on the documented schedule and gives up after the last try', () => {
    expect(retryDelayMinutes(1)).toBe(1)
    expect(retryDelayMinutes(2)).toBe(5)
    expect(retryDelayMinutes(MAX_DELIVERY_ATTEMPTS - 1)).toBe(720)
    expect(retryDelayMinutes(MAX_DELIVERY_ATTEMPTS)).toBeNull()
  })
})

describe('emitEvent', () => {
  it('queues one delivery per subscribed active webhook', async () => {
    const { team } = await fixtures()
    const wanted = await addHook({ teamIds: [team.id] })
    await addHook({ events: ['nudge.sent'] })
    await addHook({ isActive: false })
    await addHook({ teamIds: [globalThis.crypto.randomUUID()] })
    expect(await events.emitEvent('activity.submitted', { x: 1 }, { teamIds: [team.id], userId: null })).toBe(1)
    const rows = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.webhookId).toBe(wanted.id)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.payload).toMatchObject({ type: 'activity.submitted', version: 1, data: { x: 1 } })
  })

  it('sends an activity event only to webhooks limited to its owner', async () => {
    const { activity, user } = await fixtures()
    const mine = await addHook({ userIds: [user.id] })
    await addHook({ userIds: [globalThis.crypto.randomUUID()] })
    await events.emitActivityEvent('activity.submitted', activity.id)
    const rows = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(rows.map((r) => r.webhookId)).toEqual([mine.id])
  })

  it('scopes security events to the person and their teams', async () => {
    const { team, user } = await fixtures()
    await testDb.insert(schema.teamMembers).values({ teamId: team.id, userId: user.id, role: 'contributor' })
    const events2 = ['auth.suspicious_sign_in', 'user.disabled']
    const onTeam = await addHook({ events: events2, teamIds: [team.id] })
    await addHook({ events: events2, teamIds: [globalThis.crypto.randomUUID()] })
    await events.emitSuspiciousSignIn({ userId: user.id, method: 'okta', ip: '198.51.100.7', userAgent: 'test', at: new Date(), firstSignIn: false })
    await events.emitUserDisabled({ userId: user.id, actorId: user.id, sessionsRevoked: 2, apiKeysRevoked: 0 })
    const rows = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(rows.map((r) => [r.webhookId, r.eventType]).sort()).toEqual([[onTeam.id, 'auth.suspicious_sign_in'], [onTeam.id, 'user.disabled']].sort())
    const signIn = rows.find((r) => r.eventType === 'auth.suspicious_sign_in')!
    expect(signIn.payload).toMatchObject({ data: { user: { id: user.id, displayName: 'Dana' }, signIn: { ip: '198.51.100.7', method: 'okta' } } })
  })

  it('sends the AI budget event to every subscribed webhook whatever its filters', async () => {
    const hook = await addHook({ events: ['ai.budget_reached'], teamIds: [globalThis.crypto.randomUUID()], userIds: [globalThis.crypto.randomUUID()] })
    await events.emitAiBudgetReached({ month: '2026-10', budgetUsd: 50, spentUsd: 50.123 })
    const [row] = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(row!.webhookId).toBe(hook.id)
    expect(row!.payload).toMatchObject({ data: { ai: { month: '2026-10', budgetUsd: 50, spentUsd: 50.12 } } })
  })

  it("leaves a private meeting's title out of the activity payload", async () => {
    const { activity } = await fixtures({ isPrivateMeeting: true, title: 'Interview with a candidate' })
    const built = await events.activityEventData(activity.id)
    expect(built?.data['activity']).toMatchObject({ id: activity.id, title: null, isPrivateMeeting: true, effortHours: 1, type: { name: 'Demo' } })
    expect(JSON.stringify(built)).not.toContain('Interview')
  })
})

describe('delivery worker', () => {
  it('sends a signed POST with the event headers and marks it delivered', async () => {
    const hook = await addHook()
    await events.emitEvent('activity.submitted', { x: 1 }, { teamIds: null, userId: null })
    const fetchMock = respond(204)
    expect(await delivery.processDueDeliveries()).toMatchObject({ delivered: 1, failed: 0, processed: 1 })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(URL_OK)
    expect(init.redirect).toBe('manual')
    const headers = init.headers as Record<string, string>
    expect(headers[delivery.EVENT_HEADER]).toBe('activity.submitted')
    expect(headers['Authorization']).toBe('Bearer whsec_test')
    expect(signing.verifyWebhookSignature('whsec_test', headers[signing.WEBHOOK_TIMESTAMP_HEADER]!, String(init.body), headers[signing.WEBHOOK_SIGNATURE_HEADER]!)).toBe(true)

    const [row] = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(row).toMatchObject({ webhookId: hook.id, status: 'delivered', attempts: 1, lastStatusCode: 204 })
  })

  it('schedules a retry on failure and marks it failed after the last try', async () => {
    await addHook()
    await events.emitEvent('activity.submitted', {}, { teamIds: null, userId: null })
    respond(500)
    const start = new Date()
    await delivery.processDueDeliveries(start)
    let [row] = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500 })
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(start.getTime() + 60 * 1000 - 1000)

    // Not due yet: nothing is sent.
    expect((await delivery.processDueDeliveries(start)).processed).toBe(0)

    await testDb.update(schema.eventWebhookDeliveries).set({ attempts: MAX_DELIVERY_ATTEMPTS - 1, nextAttemptAt: start })
    await delivery.processDueDeliveries(start)
    ;[row] = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS })
  })

  it('does not follow a redirect', async () => {
    await addHook()
    await events.emitEvent('activity.submitted', {}, { teamIds: null, userId: null })
    respond(302)
    await delivery.processDueDeliveries()
    const [row] = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(row!.lastError).toMatch(/redirect/)
  })

  it('refuses a private address unless the webhook allows it, and never sends to loopback', async () => {
    const fetchMock = respond(200)
    for (const url of ['https://10.0.0.5/hook', 'http://127.0.0.1/hook']) {
      const out = await delivery.sendEvent({ url, secret: 's', allowPrivateNetwork: url.includes('127') }, events.buildEventPayload('webhook.test', {}), 'd1')
      expect(out.ok).toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    const ok = await delivery.sendEvent({ url: 'http://10.0.0.5/hook', secret: 's', allowPrivateNetwork: true }, events.buildEventPayload('webhook.test', {}), 'd1')
    expect(ok.ok).toBe(true)
  })

  it('closes queued deliveries when a webhook is turned off, and culls old finished ones', async () => {
    const hook = await addHook()
    await events.emitEvent('activity.submitted', {}, { teamIds: null, userId: null })
    await delivery.closePendingDeliveries(hook.id)
    const [row] = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(row!.status).toBe('failed')
    expect(await delivery.cullDeliveries(30, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(1)
  })
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: { data: unknown; error: string | null } }> {
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const { request } = await import('node:http')
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  } finally {
    server.close()
  }
}

describe('admin routes', () => {
  async function admin(isAppAdmin: boolean) {
    const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${globalThis.crypto.randomUUID()}`, email: `${globalThis.crypto.randomUUID()}@example.com`, displayName: 'A', isAppAdmin }).returning()
    currentUserId = u!.id
  }

  it('is App Admin only', async () => {
    await admin(false)
    expect((await call('GET', '/api/admin/event-webhooks')).status).toBe(403)
  })

  it('shows the secret once on create and never in the list', async () => {
    await admin(true)
    const created = await call('POST', '/api/admin/event-webhooks', { name: 'Teams', url: URL_OK, events: ['nudge.sent'] })
    expect(created.status).toBe(201)
    const { secret, webhook } = created.body.data as { secret: string; webhook: { id: string } }
    expect(secret).toMatch(/^whsec_/)
    const listed = await call('GET', '/api/admin/event-webhooks')
    expect(JSON.stringify(listed.body)).not.toContain(secret)
    expect(JSON.stringify(listed.body)).not.toContain('secretEncrypted')
    const [row] = await testDb.select().from(schema.eventWebhooks)
    expect(crypto.decryptToken(row!.secretEncrypted)).toBe(secret)

    const rotated = await call('POST', `/api/admin/event-webhooks/${webhook.id}/rotate-secret`)
    const next = (rotated.body.data as { secret: string }).secret
    expect(next).not.toBe(secret)
  })

  it('refuses a private URL without the opt-in and an unknown team', async () => {
    await admin(true)
    expect((await call('POST', '/api/admin/event-webhooks', { name: 'x', url: 'https://192.168.1.10/hook', events: ['job.failed'] })).status).toBe(400)
    const unknown = await call('POST', '/api/admin/event-webhooks', { name: 'x', url: URL_OK, events: ['job.failed'], teamIds: [globalThis.crypto.randomUUID()] })
    expect(unknown.body.error).toBe('errors.event_webhooks.unknown_team')
  })

  it('sends a test event and records it without queueing a retry', async () => {
    await admin(true)
    const hook = await addHook()
    const fetchMock = respond(200)
    const res = await call('POST', `/api/admin/event-webhooks/${hook.id}/test`)
    expect(res.body.data).toMatchObject({ ok: true, statusCode: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [row] = await testDb.select().from(schema.eventWebhookDeliveries)
    expect(row).toMatchObject({ eventType: 'webhook.test', status: 'delivered' })
  })
})

describe('anomaly scan', () => {
  it('words a finding in English with the CRM name filled in', async () => {
    const { anomalyMessage } = await import('./anomalyScan.js')
    expect(anomalyMessage({ code: 'sync_failures', severity: 'medium', subjectType: 'team', subjectId: null, subjectName: null, params: { count: 4 }, magnitude: 4 }, 'HubSpot'))
      .toBe('4 activities failed to sync to HubSpot this week.')
    expect(anomalyMessage({ code: 'contributor_over_capacity', severity: 'high', subjectType: 'user', subjectId: 'u', subjectName: 'Dana', params: { hours: 50, target: 40, pct: 125 }, magnitude: 1 }, 'CRM'))
      .toBe('Dana logged 50h against a 40h target (125%).')
  })

  it('checks each team once per completed week, and only while a webhook subscribes', async () => {
    const { scanAnomaliesForWebhooks, lastCompletedWeekStart } = await import('./anomalyScan.js')
    const { team } = await fixtures()
    expect((await scanAnomaliesForWebhooks()).teamsScanned).toBe(0)

    await addHook({ events: ['anomaly.found'], teamIds: [team.id] })
    expect((await scanAnomaliesForWebhooks()).teamsScanned).toBe(1)
    const scans = await testDb.select().from(schema.eventWebhookAnomalyScans)
    expect(scans).toEqual([expect.objectContaining({ teamId: team.id, weekStart: lastCompletedWeekStart() })])
    expect((await scanAnomaliesForWebhooks()).teamsScanned).toBe(0)
  })
})
