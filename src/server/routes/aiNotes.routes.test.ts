// The AI Notes routes (routes/aiNotes.ts) against pglite, with the AI
// provider mocked: the tab's visibility, Generate from notes alone, Keep /
// Regenerate / Remove / Copy to Notes, the private-note rule and the team's
// monthly limit. Gong isn't connected here, so no transcript is read.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import express from 'express'
import { eq, sql } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../db/testDb.js'
import type { ProviderCall, ProviderOutcome } from '../services/ai/adapters.js'
import type { AiNotesView, MyAiNotesList } from '../../shared/aiNotes.js'

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js')
  const { createTestDb } = await import('../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../services/audit/log.js', () => ({ logAudit: async () => {} }))
const callProvider = vi.fn<(p: unknown, call: ProviderCall) => Promise<ProviderOutcome>>()
vi.mock('../services/ai/adapters.js', () => ({ callProvider: (p: unknown, call: ProviderCall) => callProvider(p, call) }))

let schema: typeof import('../../../drizzle/schema.js')
let providers: typeof import('../services/ai/providers.js')
let testDb: TestDb
let base = ''
let currentUserId = ''

async function call<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/ai-notes${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: T; error: string | null; meta: Record<string, unknown> } }
}

const answer = (items: Array<{ section: string; text: string; cites?: string[] }>): ProviderOutcome => ({
  status: 'ok',
  text: JSON.stringify({ items: items.map((i) => ({ verdict: null, owner: null, meddpicc: null, cites: [], ...i })) }),
  inputTokens: 1000,
  outputTokens: 1000,
})

beforeAll(async () => {
  schema = await import('../../../drizzle/schema.js')
  providers = await import('../services/ai/providers.js')
  testDb = (await import('../db/index.js')).db as unknown as TestDb
  await testDb.insert(schema.aiProviders).values({
    kind: 'anthropic', name: 'Claude', model: 'test-model', isActive: true, isDefault: true,
    inputPricePerMTok: '1', outputPricePerMTok: '1',
  })
  await providers.saveAiSettings({ enabled: true, monthlyBudgetUsd: null, budgetAlertSentFor: null, disabledFeatures: [] })
  providers.clearAiCache()
  const { aiNotesRouter } = await import('./aiNotes.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/ai-notes', aiNotesRouter)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => { callProvider.mockReset() })

async function seed(opts: { enabled?: boolean; limit?: string | null; privateNote?: boolean } = {}) {
  const [team] = await testDb.insert(schema.teams).values({
    name: 'T', slug: `t-${crypto.randomUUID()}`, aiNotesEnabled: opts.enabled ?? true, aiNotesMonthlyLimitUsd: opts.limit ?? null,
  }).returning()
  const mkUser = async (name: string) => {
    const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: name }).returning()
    await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: u!.id, role: 'contributor' })
    return u!
  }
  const owner = await mkUser('Owner')
  const peer = await mkUser('Peer')
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
  const start = new Date('2026-10-28T15:00:00Z')
  const [act] = await testDb.insert(schema.activities).values({
    userId: owner.id, teamId: team!.id, title: 'Acme demo', activityTypeId: type!.id, status: 'submitted',
    startDatetime: start, endDatetime: new Date(start.getTime() + 3600_000), effortHours: '1.00',
  }).returning()
  const [note] = await testDb.insert(schema.activityNotes).values({
    activityId: act!.id, body: 'Acme uses Okta. CFO signs.', createdBy: owner.id, isPrivate: opts.privateNote ?? false,
  }).returning()
  // A teammate's note never feeds the owner's AI Note.
  await testDb.insert(schema.activityNotes).values({ activityId: act!.id, body: 'Peer note', createdBy: peer.id })
  currentUserId = owner.id
  return { team: team!, owner, peer, act: act!, note: note! }
}

describe('AI Notes routes', () => {
  it('hides the tab while the team switch is off', async () => {
    const { act } = await seed({ enabled: false })
    const r = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(r.status).toBe(200)
    expect(r.json.data.enabled).toBe(false)
    expect((await call('POST', `/activities/${act.id}/generate`)).status).toBe(409)
  })

  it('generates from notes alone, tags the spend with the team, and keeps kept items on Regenerate', async () => {
    const { act, team } = await seed()
    let r = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(r.json.data).toMatchObject({ enabled: true, canGenerate: true, canEdit: true, sources: { notes: 1, transcriptsAvailable: false } })

    callProvider.mockResolvedValueOnce(answer([
      { section: 'summary', text: 'Acme uses Okta.', cites: ['N1'] },
      { section: 'checked', text: 'Should be dropped: no transcript' },
      { section: 'risks', text: 'Budget unclear.' },
    ]))
    r = await call<AiNotesView>('POST', `/activities/${act.id}/generate`)
    expect(r.status).toBe(200)
    const prompt = callProvider.mock.calls[0]![1]
    expect(prompt.user).toContain('Acme uses Okta. CFO signs.')
    expect(prompt.user).not.toContain('Peer note')
    expect(r.json.data.items.map((i) => [i.section, i.text, i.status])).toEqual([
      ['summary', 'Acme uses Okta.', 'to_review'],
      ['risks', 'Budget unclear.', 'to_review'],
    ])
    expect(r.json.data.items[0]!.citations).toEqual([{ kind: 'note', noteId: expect.any(String) }])
    const usage = await testDb.select().from(schema.aiRequests).where(eq(schema.aiRequests.teamId, team.id))
    expect(usage).toHaveLength(1)
    expect(usage[0]!.feature).toBe('activity_ai_notes')

    const summary = r.json.data.items[0]!
    expect((await call('PATCH', `/items/${summary.id}`, { status: 'kept' })).status).toBe(200)

    callProvider.mockResolvedValueOnce(answer([{ section: 'next_steps', text: 'Send SSO docs.' }]))
    r = await call<AiNotesView>('POST', `/activities/${act.id}/generate`)
    expect(callProvider.mock.calls[1]![1].user).toContain('## Already kept\n- [summary] Acme uses Okta.')
    expect(r.json.data.items.map((i) => [i.text, i.status])).toEqual([
      ['Acme uses Okta.', 'kept'],
      ['Send SSO docs.', 'to_review'],
    ])

    const next = r.json.data.items[1]!
    expect((await call('DELETE', `/items/${next.id}`)).status).toBe(200)
    r = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(r.json.data.items).toHaveLength(1)
  })

  it('copies an item to Notes once, and only the owner can act', async () => {
    const { act, peer } = await seed()
    callProvider.mockResolvedValueOnce(answer([{ section: 'risks', text: 'Budget unclear.' }]))
    const r = await call<AiNotesView>('POST', `/activities/${act.id}/generate`)
    const item = r.json.data.items[0]!

    currentUserId = peer.id
    const peerView = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(peerView.status).toBe(404) // no Gong call, leader switch off: not readable
    expect((await call('POST', `/items/${item.id}/copy-to-notes`)).status).toBe(404)
    expect((await call('POST', `/activities/${act.id}/generate`)).status).toBe(404)

    currentUserId = act.userId
    const copied = await call<{ noteId: string }>('POST', `/items/${item.id}/copy-to-notes`)
    expect(copied.status).toBe(201)
    const [note] = await testDb.select().from(schema.activityNotes).where(eq(schema.activityNotes.id, copied.json.data.noteId))
    expect(note).toMatchObject({ body: 'Budget unclear.', createdBy: act.userId, isPrivate: false })
    expect((await call('POST', `/items/${item.id}/copy-to-notes`)).status).toBe(409)
    const [row] = await testDb.select().from(schema.activityAiNoteItems).where(eq(schema.activityAiNoteItems.id, item.id))
    expect(row!.status).toBe('kept')
  })

  it('lets team leaders read with the switch on, except an AI Note written from a private note', async () => {
    const { act, peer, team } = await seed({ privateNote: true })
    await testDb.update(schema.teamMembers).set({ role: 'leader' }).where(eq(schema.teamMembers.userId, peer.id))
    await testDb.update(schema.teams).set({ transcriptsLeaderAccess: true }).where(eq(schema.teams.id, team.id))
    currentUserId = peer.id
    let r = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ enabled: true, canEdit: false, canGenerate: false, blockedReason: 'not_owner', sources: { notes: 0 } })

    currentUserId = act.userId
    callProvider.mockResolvedValueOnce(answer([{ section: 'summary', text: 'Private fact.' }]))
    r = await call<AiNotesView>('POST', `/activities/${act.id}/generate`)
    expect(r.json.data.note?.usedPrivateNotes).toBe(true)

    currentUserId = peer.id
    expect((await call('GET', `/activities/${act.id}`)).status).toBe(404)
  })

  it('stops Generate once the team reaches its monthly limit', async () => {
    const { act, team } = await seed({ limit: '0.01' })
    await testDb.insert(schema.aiRequests).values({ feature: 'activity_ai_notes', teamId: team.id, costUsd: '0.02', status: 'ok' })
    const r = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(r.json.data).toMatchObject({ canGenerate: false, blockedReason: 'team_over_budget' })
    const g = await call('POST', `/activities/${act.id}/generate`)
    expect(g.status).toBe(409)
    expect(g.json.error).toBe('errors.ai_notes.team_over_budget')
    expect(callProvider).not.toHaveBeenCalled()
  })

  it('adds the sections of profiles on assessments that run here, and keeps custom section names on items', async () => {
    const { act, owner, team } = await seed()
    await testDb.update(schema.users).set({ aiNotesSections: ['summary'] }).where(eq(schema.users.id, owner.id))
    const custom = { key: 'c_tech0001', name: 'Technical requirements', instructions: 'List each requirement the customer stated.', icon: 'Cpu', color: '#0ea5e9' }
    const [profile] = await testDb.insert(schema.aiNoteProfiles).values({ teamId: team.id, name: 'Discovery', sections: ['risks'], customSections: [custom] }).returning()
    const [assessment] = await testDb.insert(schema.aiAssessments).values({ teamId: team.id, name: 'Discovery quality', aiNoteProfileId: profile!.id }).returning()
    await testDb.insert(schema.aiAssessmentCriteria).values({ assessmentId: assessment!.id, name: 'Pain', weight: 10, anchors: {}, sortOrder: 0 })
    await testDb.insert(schema.aiAssessmentTeams).values({ assessmentId: assessment!.id, teamId: team.id })
    await testDb.insert(schema.aiAssessmentAssignments).values({ teamId: team.id, activityTypeId: act.activityTypeId!, subtypeId: null, assessmentId: assessment!.id })

    let r = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(r.json.data.sections).toEqual(['summary', 'risks'])
    expect(r.json.data.customSections).toEqual([custom])
    expect(r.json.data.profiles).toEqual([{ id: profile!.id, name: 'Discovery', icon: null, color: null }])

    callProvider.mockResolvedValueOnce(answer([
      { section: 'summary', text: 'Acme uses Okta.' },
      { section: 'c_tech0001', text: 'SAML SSO with Okta.' },
      { section: 'meddpicc', text: 'Not asked for' },
    ]))
    r = await call<AiNotesView>('POST', `/activities/${act.id}/generate`)
    expect(r.status).toBe(200)
    expect(callProvider.mock.calls[0]![1].system).toContain('c_tech0001: "Technical requirements"')
    expect(r.json.data.items.map((i) => [i.section, i.text, i.sectionMeta])).toEqual([
      ['summary', 'Acme uses Okta.', null],
      ['c_tech0001', 'SAML SSO with Okta.', { name: 'Technical requirements', icon: 'Cpu', color: '#0ea5e9' }],
    ])

    // The profile goes away: its sections stop being added, written items keep their name.
    await testDb.delete(schema.aiNoteProfiles).where(eq(schema.aiNoteProfiles.id, profile!.id))
    r = await call<AiNotesView>('GET', `/activities/${act.id}`)
    expect(r.json.data.sections).toEqual(['summary'])
    expect(r.json.data.customSections).toEqual([])
    expect(r.json.data.items[1]!.sectionMeta).toEqual({ name: 'Technical requirements', icon: 'Cpu', color: '#0ea5e9' })
  })

  it('saves a person\'s sections and goes back to the team default', async () => {
    await seed()
    expect((await call('PUT', '/settings', { sections: [] })).status).toBe(400)
    expect((await call('PUT', '/settings', { sections: ['risks', 'summary'] })).json.data).toEqual({ sections: ['summary', 'risks'] })
    expect((await call('PUT', '/settings', { sections: null })).json.data).toEqual({ sections: null })
    const [u] = await testDb.select({ s: schema.users.aiNotesSections }).from(schema.users).where(sql`${schema.users.id} = ${currentUserId}`)
    expect(u!.s).toBeNull()
  })
  it('lists the caller\'s own AI Notes for My Notes, with review counts and search', async () => {
    const { act, peer, team } = await seed()
    let mine = await call<MyAiNotesList>('GET', '/mine')
    expect(mine.json.data).toMatchObject({ enabled: true, notes: [], totals: { notes: 0, toReview: 0 } })

    callProvider.mockResolvedValueOnce(answer([
      { section: 'summary', text: 'Acme provisions with SCIM.' },
      { section: 'risks', text: 'Budget unclear.' },
    ]))
    const gen = await call<AiNotesView>('POST', `/activities/${act.id}/generate`)
    await call('PATCH', `/items/${gen.json.data.items[0]!.id}`, { status: 'kept' })

    mine = await call<MyAiNotesList>('GET', '/mine')
    expect(mine.json.data.totals).toEqual({ notes: 1, toReview: 1 })
    expect(mine.json.data.notes[0]).toMatchObject({ activityId: act.id, activityTitle: 'Acme demo', activityTypeName: 'Demo', toReview: 1, kept: 1, fromTranscript: false })

    // Search reaches the items' text and the activity title; LIKE wildcards are literal.
    expect((await call<MyAiNotesList>('GET', '/mine?q=scim')).json.data.notes).toHaveLength(1)
    expect((await call<MyAiNotesList>('GET', '/mine?q=acme%20demo')).json.data.notes).toHaveLength(1)
    expect((await call<MyAiNotesList>('GET', '/mine?q=nothing')).json.data.notes).toHaveLength(0)
    expect((await call<MyAiNotesList>('GET', `/mine?q=${encodeURIComponent('%')}`)).json.data.notes).toHaveLength(0)

    // Only the caller's own activities.
    currentUserId = peer.id
    expect((await call<MyAiNotesList>('GET', '/mine')).json.data).toMatchObject({ enabled: true, notes: [] })

    // Team switch off: the AI Note is hidden, as on the activity's tab.
    await testDb.update(schema.teams).set({ aiNotesEnabled: false }).where(eq(schema.teams.id, team.id))
    currentUserId = act.userId
    expect((await call<MyAiNotesList>('GET', '/mine')).json.data).toMatchObject({ enabled: false, notes: [] })
  })
})
