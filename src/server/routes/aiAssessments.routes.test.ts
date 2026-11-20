// AI Assessment scores (routes/aiAssessments.ts + AI Notes Generate) against
// pglite, with the AI provider and the Gong transcript mocked: Leaders-only
// visibility (never the owner), scoring after Generate when a transcript was
// read, both scores, and a Leader's Run assessment replacing the score.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { eq } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'
import type { ProviderCall, ProviderOutcome } from '../services/ai/adapters.js'
import type { AiAssessmentsActivityView } from '../../shared/aiAssessments.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../services/audit/log.js', () => ({ logAudit: async () => {} }))
const callProvider = vi.fn<(p: unknown, call: ProviderCall) => Promise<ProviderOutcome>>()
vi.mock('../services/ai/adapters.js', () => ({ callProvider: (p: unknown, call: ProviderCall) => callProvider(p, call) }))
vi.mock('../services/gong/config.js', async () => {
  const actual = await vi.importActual<typeof import('../services/gong/config.js')>('../services/gong/config.js')
  return { ...actual, isGongConfigured: async () => true }
})
vi.mock('../services/gong/transcripts.js', async () => {
  const actual = await vi.importActual<typeof import('../services/gong/transcripts.js')>('../services/gong/transcripts.js')
  return {
    ...actual,
    getGongTranscript: async () => ({
      monologues: [{ speakerId: 's1', topic: null, sentences: [{ start: 5000, end: 8000, text: 'We lose two hours a day to manual reviews.' }] }],
      fetchedAt: new Date(),
    }),
  }
})

let schema: typeof import('../../../drizzle/schema.js')
let testDb: TestDb
let base = ''
let currentUserId = ''

async function call<T = AiAssessmentsActivityView>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: T; error: string | null; meta: Record<string, unknown> } }
}

const ok = (payload: unknown): ProviderOutcome => ({ status: 'ok', text: JSON.stringify(payload), inputTokens: 100, outputTokens: 100 })
const noteAnswer = ok({ items: [{ section: 'summary', text: 'Two hours a day lost.', verdict: null, owner: null, meddpicc: null, cites: ['C1@00:05'] }] })
const scoreAnswer = (k1: number | null, k2: number | null) => ok({
  criteria: [
    { criterion: 'A1.K1', level: k1, rationale: 'They named a time cost.', cites: ['C1@00:05'] },
    { criterion: 'A1.K2', level: k2, rationale: null, cites: [] },
  ],
})

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  const providers = await import('../services/ai/providers.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  await testDb.insert(schema.aiProviders).values({
    kind: 'anthropic', name: 'Claude', model: 'test-model', isActive: true, isDefault: true,
    inputPricePerMTok: '1', outputPricePerMTok: '1',
  })
  await providers.saveAiSettings({ enabled: true, monthlyBudgetUsd: null, budgetAlertSentFor: null, disabledFeatures: [] })
  providers.clearAiCache()
  const { aiNotesRouter } = await import('./aiNotes.js')
  const { aiAssessmentsRouter } = await import('./aiAssessments.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/ai-notes', aiNotesRouter)
  app.use('/api/ai-assessments', aiAssessmentsRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => { callProvider.mockReset() })

async function seed(opts: { assign?: boolean } = {}) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}`, aiNotesEnabled: true }).returning()
  const mkUser = async (name: string, role: 'contributor' | 'leader') => {
    const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: name }).returning()
    await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: u!.id, role })
    return u!
  }
  const owner = await mkUser('Owner', 'contributor')
  const peer = await mkUser('Peer', 'contributor')
  const leader = await mkUser('Lee Leader', 'leader')
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Discovery', sortOrder: 1 }).returning()
  await testDb.insert(schema.activityTypeTeams).values({ activityTypeId: type!.id, teamId: team!.id })
  const start = new Date('2026-10-28T15:00:00Z')
  const [act] = await testDb.insert(schema.activities).values({
    userId: owner.id, teamId: team!.id, title: 'Acme discovery', activityTypeId: type!.id, status: 'submitted',
    startDatetime: start, endDatetime: new Date(start.getTime() + 3600_000), effortHours: '1.00',
  }).returning()
  const callId = `call-${crypto.randomUUID()}`
  await testDb.insert(schema.gongCalls).values({ id: callId, title: 'Acme call', url: 'https://app.gong.io/call?id=1', startedAt: start })
  await testDb.insert(schema.activityGongCalls).values({ activityId: act!.id, gongCallId: callId, linkMethod: 'manual' })
  const [assessment] = await testDb.insert(schema.aiAssessments).values({ teamId: team!.id, name: 'Technical Discovery' }).returning()
  await testDb.insert(schema.aiAssessmentTeams).values({ assessmentId: assessment!.id, teamId: team!.id })
  await testDb.insert(schema.aiAssessmentCriteria).values([
    { assessmentId: assessment!.id, name: 'Pain quantified', lookFor: 'A cost or time figure', weight: 25, anchors: { '1': 'None', '5': 'With a figure' }, sortOrder: 0 },
    { assessmentId: assessment!.id, name: 'Next step with a date', weight: 10, sortOrder: 1 },
  ])
  if (opts.assign ?? true) {
    await testDb.insert(schema.aiAssessmentAssignments).values({ teamId: team!.id, activityTypeId: type!.id, subtypeId: null, assessmentId: assessment!.id })
  }
  return { team: team!, owner, peer, leader, act: act!, assessment: assessment! }
}

describe('AI Assessment scores', () => {
  it('shows the tab to Leaders only, never to the owner or a teammate', async () => {
    const { owner, peer, leader, act } = await seed()
    currentUserId = owner.id
    expect((await call('GET', `/ai-assessments/activities/${act.id}`)).json.data.visible).toBe(false)
    expect((await call('POST', `/ai-assessments/activities/${act.id}/run`)).status).toBe(404)
    currentUserId = peer.id
    expect((await call('GET', `/ai-assessments/activities/${act.id}`)).json.data.visible).toBe(false)
    currentUserId = leader.id
    const r = await call('GET', `/ai-assessments/activities/${act.id}`)
    expect(r.json.data).toMatchObject({ visible: true, canRun: true, blockedReason: null, assigned: [{ name: 'Technical Discovery' }], scores: [] })
  })

  it("scores the assigned assessment when the owner's Generate reads a transcript", async () => {
    const { owner, leader, act, assessment, team } = await seed()
    currentUserId = owner.id
    callProvider.mockResolvedValueOnce(noteAnswer).mockResolvedValueOnce(scoreAnswer(4, null))
    const gen = await call('POST', `/ai-notes/activities/${act.id}/generate`)
    expect(gen.status).toBe(200)
    expect(callProvider).toHaveBeenCalledTimes(2)
    const prompt = callProvider.mock.calls[1]![1]
    expect(prompt.user).toContain('A1.K1: Pain quantified')
    expect(prompt.user).toContain('Level 5: With a figure')
    expect(prompt.user).toContain('We lose two hours a day')
    // The owner still can't see it.
    expect((await call('GET', `/ai-assessments/activities/${act.id}`)).json.data.visible).toBe(false)

    currentUserId = leader.id
    const r = await call('GET', `/ai-assessments/activities/${act.id}`)
    expect(r.json.data.scores).toHaveLength(1)
    // 25×4 of 35×5 = 57 with the not-observed criterion as zero; 100 of 125 = 80 observed only.
    expect(r.json.data.scores[0]).toMatchObject({
      assessmentId: assessment.id, assessmentName: 'Technical Discovery', assessmentVersion: 1, currentVersion: 1,
      zeroed: 57, observed: 80, notObservedCount: 1, criteriaCount: 2, runByName: 'Owner',
    })
    expect(r.json.data.scores[0]!.criteria[0]).toMatchObject({ name: 'Pain quantified', level: 4, citations: [{ kind: 'transcript', startMs: 5000 }] })
    expect(r.json.data.scores[0]!.criteria[1]).toMatchObject({ level: null, citations: [] })
    expect(r.json.data.calls).toEqual([{ id: expect.any(String), url: 'https://app.gong.io/call?id=1' }])
    const usage = await testDb.select().from(schema.aiRequests).where(eq(schema.aiRequests.teamId, team.id))
    expect(usage.map((u) => u.feature).sort()).toEqual(['activity_ai_assessments', 'activity_ai_notes'])
  })

  it("lets a Leader run it, replacing the activity's score for that assessment", async () => {
    const { leader, act } = await seed()
    currentUserId = leader.id
    callProvider.mockResolvedValueOnce(scoreAnswer(2, 3))
    let r = await call('POST', `/ai-assessments/activities/${act.id}/run`)
    expect(r.status).toBe(200)
    expect(r.json.meta['scored']).toBe(1)
    expect(r.json.data.scores[0]).toMatchObject({ zeroed: 46, observed: 46, notObservedCount: 0, runByName: 'Lee Leader' })
    callProvider.mockResolvedValueOnce(scoreAnswer(5, 5))
    r = await call('POST', `/ai-assessments/activities/${act.id}/run`)
    expect(r.json.data.scores).toHaveLength(1)
    expect(r.json.data.scores[0]).toMatchObject({ zeroed: 100, observed: 100 })
  })

  it('does nothing when no assessment is assigned, and a bad answer fails cleanly', async () => {
    const { owner, leader, act } = await seed({ assign: false })
    currentUserId = leader.id
    expect((await call('GET', `/ai-assessments/activities/${act.id}`)).json.data.visible).toBe(false)
    currentUserId = owner.id
    callProvider.mockResolvedValueOnce(noteAnswer)
    expect((await call('POST', `/ai-notes/activities/${act.id}/generate`)).status).toBe(200)
    expect(callProvider).toHaveBeenCalledTimes(1)

    const other = await seed()
    currentUserId = other.leader.id
    callProvider.mockResolvedValueOnce({ status: 'ok', text: 'not json', inputTokens: 1, outputTokens: 1 })
    const r = await call('POST', `/ai-assessments/activities/${other.act.id}/run`)
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('errors.ai_assessments.failed')
  })
})
