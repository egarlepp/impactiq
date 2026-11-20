// AI Assistant → Usage this month (services/ai/usage.ts) against pglite:
// grouping by feature / team / person, the team fallback to the requester's
// default team, filters and 20-row pages.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let usage: typeof import('./usage.js')

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  usage = await import('./usage.js')
})

describe('AI usage this month', () => {
  it('groups by feature, team and person, falls back to the default team, filters and pages', async () => {
    const now = new Date('2026-11-20T12:00:00Z')
    const [sales] = await testDb.insert(schema.teams).values({ name: 'Sales Engineering', slug: `se-${crypto.randomUUID()}` }).returning()
    const [channel] = await testDb.insert(schema.teams).values({ name: 'Channel', slug: `ch-${crypto.randomUUID()}` }).returning()
    const [dana] = await testDb.insert(schema.users).values({ oktaId: `o-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'Dana', defaultTeamId: sales!.id }).returning()
    const [lee] = await testDb.insert(schema.users).values({ oktaId: `o-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'Lee', defaultTeamId: channel!.id }).returning()
    const row = (feature: string, opts: { by?: string | null; team?: string | null; cost?: string; status?: string; at?: Date }) => ({
      feature,
      requestedBy: opts.by ?? null,
      teamId: opts.team ?? null,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: opts.cost ?? '0.01',
      status: opts.status ?? 'ok',
      providerName: 'Claude',
      createdAt: opts.at ?? new Date('2026-11-10T12:00:00Z'),
    })
    await testDb.insert(schema.aiRequests).values([
      // Charged to Channel even though Dana's default team is Sales.
      row('activity_ai_notes', { by: dana!.id, team: channel!.id, cost: '0.50' }),
      ...Array.from({ length: 22 }, () => row('note_organize', { by: dana!.id })),
      row('note_organize', { by: lee!.id, status: 'error' }),
      row('activity_classify', { by: null }),
      // Last month: never counted.
      row('note_organize', { by: lee!.id, at: new Date('2026-10-31T23:00:00Z') }),
    ])

    const byFeature = await usage.aiUsageView({ groupBy: 'feature', page: 1 }, now)
    expect(byFeature.totals).toMatchObject({ requests: 25, failed: 1 })
    expect(byFeature.groups.map((g) => [g.key, g.requests])).toEqual([
      ['activity_ai_notes', 1],
      ['note_organize', 23],
      ['activity_classify', 1],
    ])
    expect(byFeature.rows).toHaveLength(20)
    expect(byFeature.totalRows).toBe(25)
    const page2 = await usage.aiUsageView({ groupBy: 'feature', page: 2 }, now)
    expect(page2.rows).toHaveLength(5)
    expect(new Set([...byFeature.rows, ...page2.rows].map((r) => r.id)).size).toBe(25)
    // A page past the end clamps to the last one.
    expect((await usage.aiUsageView({ groupBy: 'feature', page: 9 }, now)).page).toBe(2)

    const byTeam = await usage.aiUsageView({ groupBy: 'team', page: 1 }, now)
    const teamCounts = Object.fromEntries(byTeam.groups.map((g) => [g.label ?? 'none', g.requests]))
    expect(teamCounts).toEqual({ 'Sales Engineering': 22, Channel: 2, none: 1 })

    const byUser = await usage.aiUsageView({ groupBy: 'user', page: 1 }, now)
    expect(Object.fromEntries(byUser.groups.map((g) => [g.label ?? 'none', g.requests]))).toEqual({ Dana: 23, Lee: 1, none: 1 })
    expect(byUser.options.users.map((u) => u.name)).toEqual(['Dana', 'Lee'])
    expect(byUser.options.teams.map((t) => t.name)).toEqual(['Channel', 'Sales Engineering'])

    const channelOnly = await usage.aiUsageView({ groupBy: 'feature', teamId: channel!.id, page: 1 }, now)
    expect(channelOnly.rows.map((r) => [r.feature, r.userName, r.teamName]).sort()).toEqual([
      ['activity_ai_notes', 'Dana', 'Channel'],
      ['note_organize', 'Lee', 'Channel'],
    ])
    const jobs = await usage.aiUsageView({ groupBy: 'feature', userId: 'none', page: 1 }, now)
    expect(jobs.rows.map((r) => r.feature)).toEqual(['activity_classify'])
    const noTeam = await usage.aiUsageView({ groupBy: 'feature', teamId: 'none', page: 1 }, now)
    expect(noTeam.totals.requests).toBe(1)
    const lee1 = await usage.aiUsageView({ groupBy: 'feature', userId: lee!.id, feature: 'note_organize', page: 1 }, now)
    expect(lee1.rows).toHaveLength(1)
    expect(lee1.rows[0]!.status).toBe('error')
  })
})
