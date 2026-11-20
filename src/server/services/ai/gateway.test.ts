// pglite-backed: provider choice, the monthly budget, the classification cache
// and migration 0156's copy of the old Azure OpenAI settings.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestDb } from '../../db/testDb.js'
import type { ProviderCall, ProviderOutcome } from './adapters.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const callProvider = vi.fn<(p: unknown, call: ProviderCall) => Promise<ProviderOutcome>>()
vi.mock('./adapters.js', () => ({ callProvider: (p: unknown, call: ProviderCall) => callProvider(p, call) }))

const sendByRule = vi.fn(async () => ({ sent: true }))
vi.mock('../email/rule-sender.js', () => ({ sendByRule: (...args: unknown[]) => (sendByRule as (...a: unknown[]) => unknown)(...args) }))

let gateway: typeof import('./gateway.js')
let providers: typeof import('./providers.js')
let classify: typeof import('./classify.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  gateway = await import('./gateway.js')
  providers = await import('./providers.js')
  classify = await import('./classify.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

async function reset() {
  await testDb.delete(schema.aiClassificationCache)
  await testDb.delete(schema.aiRequests)
  await testDb.delete(schema.aiFeatureRoutes)
  await testDb.delete(schema.aiProviders)
  await testDb.delete(schema.systemSettings).where(sql`${schema.systemSettings.key} = 'ai_settings'`)
  providers.clearAiCache()
  callProvider.mockReset()
  sendByRule.mockClear()
}

async function addProvider(values: Partial<typeof schema.aiProviders.$inferInsert> = {}) {
  const [row] = await testDb.insert(schema.aiProviders).values({
    kind: 'anthropic', name: 'Claude', model: 'claude-opus-5-5', isActive: true, isDefault: false, ...values,
  }).returning()
  providers.clearAiCache()
  return row!
}

async function setSettings(enabled: boolean, monthlyBudgetUsd: number | null = null, disabledFeatures: import('../../../shared/ai.js').AiFeature[] = []) {
  await providers.saveAiSettings({ enabled, monthlyBudgetUsd, budgetAlertSentFor: null, disabledFeatures })
}

const ok = (text: string, inputTokens = 1000, outputTokens = 500): ProviderOutcome =>
  ({ status: 'ok', text, inputTokens, outputTokens })

describe('pickProviderRow', () => {
  type Row = import('./providers.js').AiProviderRow
  const row = (id: string, isActive: boolean, isDefault: boolean) => ({ id, isActive, isDefault } as Row)

  it('uses the routed provider when it is active', () => {
    const rows = [row('a', true, true), row('b', true, false)]
    expect(providers.pickProviderRow(rows, new Map([['notes_chat', 'b']]), 'notes_chat')?.id).toBe('b')
  })

  it('falls back to the default when the routed provider is inactive or missing', () => {
    const rows = [row('a', true, true), row('b', false, false)]
    expect(providers.pickProviderRow(rows, new Map([['notes_chat', 'b']]), 'notes_chat')?.id).toBe('a')
    expect(providers.pickProviderRow(rows, new Map([['notes_chat', 'gone']]), 'notes_chat')?.id).toBe('a')
  })

  it('returns none when the default is inactive and nothing is routed', () => {
    expect(providers.pickProviderRow([row('a', false, true)], new Map(), 'activity_classify')).toBeNull()
  })
})

describe('runAi', () => {
  beforeEach(reset)

  it('refuses while the assistant is off, without calling a provider', async () => {
    await addProvider({ isDefault: true })
    await setSettings(false)
    const r = await gateway.runAi({ feature: 'notes_chat', user: 'hi' })
    expect(r).toMatchObject({ ok: false, reason: 'disabled' })
    expect(callProvider).not.toHaveBeenCalled()
  })

  it('refuses a feature an App Admin turned off, while other features still run', async () => {
    await addProvider({ isDefault: true })
    await setSettings(true, null, ['activity_classify'])
    expect(await gateway.aiAvailability('activity_classify')).toMatchObject({ ok: false, reason: 'disabled' })
    expect(await gateway.runAi({ feature: 'activity_classify', user: 'hi' })).toMatchObject({ ok: false, reason: 'disabled' })
    expect(await classify.classifyWithAI(crypto.randomUUID(), 'Weekly sync')).toBeNull()
    expect(callProvider).not.toHaveBeenCalled()
    expect(await testDb.select().from(schema.aiRequests)).toHaveLength(0)

    callProvider.mockResolvedValueOnce(ok('answer'))
    expect(await gateway.runAi({ feature: 'notes_chat', user: 'hi' })).toMatchObject({ ok: true })
  })

  it('reads only known features from saved settings', async () => {
    await testDb.insert(schema.systemSettings).values({ key: 'ai_settings', value: { enabled: true, disabledFeatures: ['activity_classify', 'nope', 'activity_classify', 3] } })
    providers.clearAiCache()
    expect((await providers.getAiSettings()).disabledFeatures).toEqual(['activity_classify'])
  })

  it('reports no provider when none is active', async () => {
    await addProvider({ isDefault: true, isActive: false })
    await setSettings(true)
    expect(await gateway.runAi({ feature: 'notes_chat', user: 'hi' })).toMatchObject({ ok: false, reason: 'no_provider' })
  })

  it('calls the routed provider and logs usage with an estimated cost', async () => {
    await addProvider({ isDefault: true, name: 'Default' })
    const routed = await addProvider({ name: 'Routed', inputPricePerMTok: '2', outputPricePerMTok: '10' })
    await testDb.insert(schema.aiFeatureRoutes).values({ feature: 'notes_chat', providerId: routed.id })
    await setSettings(true)
    callProvider.mockResolvedValueOnce(ok('answer'))

    const r = await gateway.runAi({ feature: 'notes_chat', user: 'question' })
    expect(r).toMatchObject({ ok: true, text: 'answer', providerId: routed.id })

    const logged = await testDb.select().from(schema.aiRequests)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ feature: 'notes_chat', providerId: routed.id, status: 'ok', inputTokens: 1000, outputTokens: 500 })
    // 1000 × $2/M + 500 × $10/M
    expect(Number(logged[0]!.costUsd)).toBeCloseTo(0.007, 6)
    expect(logged[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stops at the monthly budget and emails App Admins once a month', async () => {
    const p = await addProvider({ isDefault: true })
    await setSettings(true, 1)
    await testDb.insert(schema.aiRequests).values({ feature: 'notes_chat', providerId: p.id, status: 'ok', costUsd: '1.5' })
    await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `admin-${crypto.randomUUID()}@example.com`, displayName: 'Admin', isAppAdmin: true })

    const first = await gateway.runAi({ feature: 'notes_chat', user: 'hi' })
    expect(first).toMatchObject({ ok: false, reason: 'over_budget' })
    expect(callProvider).not.toHaveBeenCalled()
    const adminMails = sendByRule.mock.calls.length
    expect(adminMails).toBeGreaterThan(0)
    expect(sendByRule.mock.calls.every((c) => (c as unknown[])[0] === 'ai_budget_reached')).toBe(true)

    await gateway.runAi({ feature: 'notes_chat', user: 'hi again' })
    expect(sendByRule.mock.calls.length).toBe(adminMails)

    const overBudget = await testDb.select().from(schema.aiRequests).where(sql`${schema.aiRequests.status} = 'over_budget'`)
    expect(overBudget).toHaveLength(2)
    expect(await gateway.aiAvailability('notes_chat')).toEqual({ ok: false, reason: 'over_budget' })
  })
})

describe('classifyWithAI cache', () => {
  beforeEach(reset)

  it('asks the provider once per event and reuses the answer', async () => {
    const slug = `t-${crypto.randomUUID()}`
    const [team] = await testDb.insert(schema.teams).values({ name: 'Team', slug }).returning()
    const [demo] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Discovery', sortOrder: 2 })
    await addProvider({ isDefault: true })
    await setSettings(true)
    callProvider.mockResolvedValue(ok(JSON.stringify({ results: [{ event: 1, activityType: 'Demo', confidence: 0.8 }] })))

    const first = await classify.classifyWithAI(team!.id, 'Product demo with Acme')
    const second = await classify.classifyWithAI(team!.id, 'Product demo with Acme')
    expect(first).toMatchObject({ activityTypeId: demo!.id, source: 'ai' })
    expect(second).toMatchObject({ activityTypeId: demo!.id, source: 'ai', confidence: 0.8 })
    expect(callProvider).toHaveBeenCalledTimes(1)

    const [cached] = await testDb.select().from(schema.aiClassificationCache)
    expect(cached).toMatchObject({ teamId: team!.id, activityTypeId: demo!.id, hitCount: 1 })

    await classify.classifyWithAI(team!.id, 'A different meeting')
    expect(callProvider).toHaveBeenCalledTimes(2)
  })

  it('caches "nothing fits" too', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'Team', slug: `t-${crypto.randomUUID()}` }).returning()
    await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 })
    await addProvider({ isDefault: true })
    await setSettings(true)
    callProvider.mockResolvedValue(ok(JSON.stringify({ results: [{ event: 1, activityType: null, confidence: 0.2 }] })))

    expect(await classify.classifyWithAI(team!.id, 'Lunch')).toBeNull()
    expect(await classify.classifyWithAI(team!.id, 'Lunch')).toBeNull()
    expect(callProvider).toHaveBeenCalledTimes(1)
  })
})

describe('classifyManyWithAI', () => {
  beforeEach(reset)

  async function teamWithTypes() {
    const [team] = await testDb.insert(schema.teams).values({ name: 'Team', slug: `t-${crypto.randomUUID()}` }).returning()
    const [demo] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    const [disc] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Discovery', sortOrder: 2 }).returning()
    await addProvider({ isDefault: true })
    await setSettings(true)
    return { team: team!, demo: demo!, disc: disc! }
  }

  it('sends every uncached event in one request and logs how many it covered', async () => {
    const { team, demo, disc } = await teamWithTypes()
    const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `u-${crypto.randomUUID()}@x.test`, displayName: 'U' }).returning()
    callProvider.mockResolvedValue(ok(JSON.stringify({ results: [
      { event: 1, activityType: 'Demo', confidence: 0.9 },
      { event: 2, activityType: 'Discovery', confidence: 0.7 },
      { event: 3, activityType: null, confidence: 0.1 },
    ] })))

    const results = await classify.classifyManyWithAI(team.id, [
      { subject: 'Product demo' }, { subject: 'Discovery call' }, { subject: 'Lunch' }, { subject: 'Product demo' },
    ], user!.id)
    expect(callProvider).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r?.activityTypeId ?? null)).toEqual([demo.id, disc.id, null, demo.id])

    const [logged] = await testDb.select().from(schema.aiRequests)
    expect(logged).toMatchObject({ feature: 'activity_classify', itemCount: 3, requestedBy: user!.id })
    expect(await testDb.select().from(schema.aiClassificationCache)).toHaveLength(3)

    // Everything is cached now: no second request.
    const again = await classify.classifyManyWithAI(team.id, [{ subject: 'Lunch' }, { subject: 'Discovery call' }])
    expect(again.map((r) => r?.activityTypeId ?? null)).toEqual([null, disc.id])
    expect(callProvider).toHaveBeenCalledTimes(1)
  })

  it('asks only about the events that are not cached', async () => {
    const { team, disc } = await teamWithTypes()
    callProvider.mockResolvedValueOnce(ok(JSON.stringify({ results: [{ event: 1, activityType: 'Demo', confidence: 0.9 }] })))
    await classify.classifyManyWithAI(team.id, [{ subject: 'Product demo' }])
    callProvider.mockResolvedValueOnce(ok(JSON.stringify({ results: [{ event: 1, activityType: 'Discovery', confidence: 0.6 }] })))
    const results = await classify.classifyManyWithAI(team.id, [{ subject: 'Product demo' }, { subject: 'Discovery call' }])
    expect(results[1]?.activityTypeId).toBe(disc.id)
    expect(callProvider).toHaveBeenCalledTimes(2)
    expect(callProvider.mock.calls[1]![1].user).not.toContain('Product demo')
  })

  it('does not cache an event the answer leaves out', async () => {
    const { team } = await teamWithTypes()
    callProvider.mockResolvedValue(ok(JSON.stringify({ results: [{ event: 1, activityType: 'Demo', confidence: 0.9 }] })))
    const results = await classify.classifyManyWithAI(team.id, [{ subject: 'Product demo' }, { subject: 'Other' }])
    expect(results[1]).toBeNull()
    expect(await testDb.select().from(schema.aiClassificationCache)).toHaveLength(1)
  })

  it('splits a large set into batches', async () => {
    const { team } = await teamWithTypes()
    callProvider.mockResolvedValue(ok(JSON.stringify({ results: [] })))
    const items = Array.from({ length: classify.CLASSIFY_BATCH_SIZE + 5 }, (_, i) => ({ subject: `Meeting ${i}` }))
    await classify.classifyManyWithAI(team.id, items)
    expect(callProvider).toHaveBeenCalledTimes(2)
    const counts = (await testDb.select().from(schema.aiRequests)).map((r) => r.itemCount).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(counts).toEqual([5, classify.CLASSIFY_BATCH_SIZE])
  })
})

describe('parseBatchAnswer', () => {
  it('ignores out-of-range, duplicate and malformed entries', () => {
    const out = classify.parseBatchAnswer(JSON.stringify({ results: [
      { event: 1, activityType: 'Demo', confidence: 0.5 },
      { event: 1, activityType: 'Other', confidence: 0.9 },
      { event: 4, activityType: 'Demo', confidence: 0.5 },
      { event: 'x' },
      { event: 2, activityType: null },
    ] }), 3)
    expect(out && [...out.entries()]).toEqual([[0, { activityType: 'Demo', confidence: 0.5 }], [1, { activityType: null, confidence: 0.7 }]])
    expect(classify.parseBatchAnswer('not json', 3)).toBeNull()
    expect(classify.parseBatchAnswer('{}', 3)).toBeNull()
  })
})

describe('migration 0156: Azure OpenAI settings move to ai_providers', () => {
  function dataStatements(): string[] {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const file = fs.readFileSync(path.resolve(dir, '../../../../drizzle/migrations/0156_ai_providers.sql'), 'utf8')
    const parts = file.split('--> statement-breakpoint').map((s) => s.trim())
    const start = parts.findIndex((s) => s.startsWith('INSERT INTO "ai_providers"'))
    return parts.slice(start)
  }

  it('copies a configured Azure row as the active default, turns the assistant on and deletes the old row', async () => {
    await reset()
    await testDb.insert(schema.systemSettings).values({
      key: 'integration_config_azure_openai',
      value: { endpoint: 'https://res.openai.azure.com/', apiKeyEncrypted: 'enc-key', deployment: 'gpt-4o-mini', allowedCustomHost: '' },
    })
    for (const s of dataStatements()) await testDb.execute(sql.raw(s))
    providers.clearAiCache()

    const rows = await testDb.select().from(schema.aiProviders)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'azure_openai', isActive: true, isDefault: true, model: 'gpt-4o-mini',
      secretEncrypted: 'enc-key', endpoint: 'https://res.openai.azure.com/', allowedCustomHost: null,
    })
    expect((await providers.getAiSettings()).enabled).toBe(true)
    const old = await testDb.select().from(schema.systemSettings).where(sql`${schema.systemSettings.key} = 'integration_config_azure_openai'`)
    expect(old).toHaveLength(0)
  })

  it('creates nothing when Azure was never configured', async () => {
    await reset()
    for (const s of dataStatements()) await testDb.execute(sql.raw(s))
    providers.clearAiCache()
    expect(await testDb.select().from(schema.aiProviders)).toHaveLength(0)
    expect(await providers.getAiSettings()).toEqual({ enabled: false, monthlyBudgetUsd: null, budgetAlertSentFor: null, disabledFeatures: [] })
  })
})
