// pglite-backed tests for the capacity/cost resolver — the single source of
// truth for "what is X's target/rate on team Y at time T?" (CLAUDE.md §12).
// Same shared-instance-per-file convention as engine.test.ts.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { subDays, formatISO } from 'date-fns'
import type { TestDb } from '../../db/testDb.js'

let testDb: TestDb
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let resolveCapacityBatch: typeof import('./resolver.js')['resolveCapacityBatch']
let resolveCostBatch: typeof import('./resolver.js')['resolveCostBatch']
let findOverridesConflict: typeof import('./resolver.js')['findOverridesConflict']
let workWeekHours: typeof import('./resolver.js')['workWeekHours']
let schema: typeof import('../../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ resolveCapacityBatch, resolveCostBatch, findOverridesConflict, workWeekHours } = await import('./resolver.js'))
  schema = await import('../../../../drizzle/schema.js')
  const dbModule = await import('../../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

function isoDate(d: Date): string {
  return formatISO(d, { representation: 'date' })
}

async function makeTeam() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  return team!
}

async function makeUser(overrides: Partial<typeof schema.users.$inferInsert> = {}) {
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Test User',
    ...overrides,
  }).returning()
  return user!
}

async function makeCapacityGroup(teamId: string, overrides: Partial<typeof schema.capacityGroups.$inferInsert> = {}) {
  const [group] = await testDb.insert(schema.capacityGroups).values({
    name: 'Group',
    capacityMethod: 'fixed_hours',
    targetHoursPerWeek: '30.0',
    ...overrides,
  }).returning()
  await testDb.insert(schema.capacityGroupTeams).values({ groupId: group!.id, teamId })
  return group!
}

async function makeCostGroup(teamId: string, overrides: Partial<typeof schema.costGroups.$inferInsert> = {}) {
  const [group] = await testDb.insert(schema.costGroups).values({
    name: 'CostGroup',
    hourlyCostRate: '50.00',
    ...overrides,
  }).returning()
  await testDb.insert(schema.costGroupTeams).values({ groupId: group!.id, teamId })
  return group!
}

describe('workWeekHours', () => {
  it('counts set day-bits × (endHour - startHour)', () => {
    // bits 0-4 = Mon-Fri (31), 8am-6pm = 10h/day
    expect(workWeekHours(31, 8, 18)).toBe(50)
  })
  it('returns 0 for no days selected', () => {
    expect(workWeekHours(0, 8, 18)).toBe(0)
  })
  it('never returns negative hours when endHour < startHour', () => {
    expect(workWeekHours(31, 18, 8)).toBe(0)
  })
})

describe('resolveCapacityBatch — user overrides', () => {
  it('a dated override wins over the group target', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCapacityGroup(team.id, { targetHoursPerWeek: '30.0' })
    await testDb.insert(schema.capacityUserOverrides).values({
      userId: user.id, teamId: team.id, targetHoursPerWeek: '10.0', reason: 'pto',
      effectiveFrom: isoDate(subDays(new Date(), 5)), effectiveTo: null,
    })
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    const r = out.get(`${user.id}::${team.id}`)!
    expect(r.hours).toBe(10)
    expect(r.source).toBe('override:pto')
  })

  it('effectiveFrom is inclusive — an override starting exactly today counts', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCapacityGroup(team.id, { targetHoursPerWeek: '30.0' })
    const today = new Date()
    await testDb.insert(schema.capacityUserOverrides).values({
      userId: user.id, teamId: team.id, targetHoursPerWeek: '12.0', reason: 'ramp',
      effectiveFrom: isoDate(today), effectiveTo: null,
    })
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: today }])
    expect(out.get(`${user.id}::${team.id}`)!.hours).toBe(12)
  })

  it('effectiveTo is exclusive — an override ending exactly today no longer applies today', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCapacityGroup(team.id, { targetHoursPerWeek: '30.0' })
    const today = new Date()
    await testDb.insert(schema.capacityUserOverrides).values({
      userId: user.id, teamId: team.id, targetHoursPerWeek: '12.0', reason: 'ramp',
      effectiveFrom: isoDate(subDays(today, 10)), effectiveTo: isoDate(today),
    })
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: today }])
    // override has lapsed as of today -> falls through to the group's fixed_hours target
    expect(out.get(`${user.id}::${team.id}`)!.hours).toBe(30)
    expect(out.get(`${user.id}::${team.id}`)!.source).toBe('group:Group:fixed')
  })

  it('an override the day before it ends is still active', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCapacityGroup(team.id, { targetHoursPerWeek: '30.0' })
    const today = new Date()
    await testDb.insert(schema.capacityUserOverrides).values({
      userId: user.id, teamId: team.id, targetHoursPerWeek: '12.0', reason: 'ramp',
      effectiveFrom: isoDate(subDays(today, 10)), effectiveTo: isoDate(subDays(today, -1)),
    })
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: today }])
    expect(out.get(`${user.id}::${team.id}`)!.hours).toBe(12)
  })
})

describe('resolveCapacityBatch — group methods', () => {
  it('fixed_hours returns the group target directly', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCapacityGroup(team.id, { capacityMethod: 'fixed_hours', targetHoursPerWeek: '25.5' })
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    expect(out.get(`${user.id}::${team.id}`)!.hours).toBe(25.5)
  })

  it('self_declared floors the user\'s own work-week at the group target', async () => {
    const team = await makeTeam()
    // 31 = Mon-Fri, 8-18 -> 50h declared, above a 20h group floor
    const user = await makeUser({ workDays: 31, workDayStartHour: 8, workDayEndHour: 18 })
    await makeCapacityGroup(team.id, { capacityMethod: 'self_declared', targetHoursPerWeek: '20.0' })
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    expect(out.get(`${user.id}::${team.id}`)!.hours).toBe(50)
  })

  it('self_declared floors UP to the group target when the user declares fewer hours', async () => {
    const team = await makeTeam()
    // 3 = Mon+Tue only, 8-12 -> 8h declared, below a 30h group floor
    const user = await makeUser({ workDays: 3, workDayStartHour: 8, workDayEndHour: 12 })
    await makeCapacityGroup(team.id, { capacityMethod: 'self_declared', targetHoursPerWeek: '30.0' })
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    expect(out.get(`${user.id}::${team.id}`)!.hours).toBe(30)
  })

  it('falls back to a flat default when the team has no capacity group at all', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    const r = out.get(`${user.id}::${team.id}`)!
    expect(r.hours).toBe(30)
    expect(r.source).toBe('default')
  })

  it('calendar_derived falls back to the group target when there is not enough trailing history', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCapacityGroup(team.id, { capacityMethod: 'calendar_derived', targetHoursPerWeek: '22.0' })
    // No outlook_events inserted at all -> weeksWithData = 0, below CALENDAR_DERIVED_MIN_WEEKS
    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    const r = out.get(`${user.id}::${team.id}`)!
    expect(r.hours).toBe(22)
    expect(r.source).toBe('group:Group:calendar_derived:insufficient_history')
  })

  it('calendar_derived uses the trailing real-meeting-load average once enough weeks have data', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCapacityGroup(team.id, { capacityMethod: 'calendar_derived', targetHoursPerWeek: '22.0' })

    const asOf = new Date()
    const dow = asOf.getUTCDay()
    const monShift = dow === 0 ? -6 : 1 - dow
    const asOfMonday = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate() + monShift))

    // 4 weeks of a single 10h qualifying meeting each (>= CALENDAR_DERIVED_MIN_WEEKS)
    for (let weeksBack = 1; weeksBack <= 4; weeksBack++) {
      const start = new Date(asOfMonday.getTime() - weeksBack * 7 * 86_400_000 + 3 * 3_600_000) // Monday 03:00
      const end = new Date(start.getTime() + 10 * 3_600_000)
      await testDb.insert(schema.outlookEvents).values({
        id: `evt-${crypto.randomUUID()}`,
        userId: user.id,
        subject: 'Weekly sync',
        isAllDay: false,
        startDatetime: start,
        endDatetime: end,
        showAs: 'busy',
        isCancelled: false,
        responseStatus: 'accepted',
      })
    }

    const out = await resolveCapacityBatch([{ userId: user.id, teamId: team.id, asOf }])
    const r = out.get(`${user.id}::${team.id}`)!
    expect(r.hours).toBe(10)
    expect(r.source).toBe('group:Group:calendar_derived')
  })
})

describe('resolveCostBatch', () => {
  it('a dated override wins over the group rate', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCostGroup(team.id, { hourlyCostRate: '50.00' })
    await testDb.insert(schema.costUserOverrides).values({
      userId: user.id, teamId: team.id, hourlyCostRate: '75.00', currency: 'USD', reason: 'special_project',
      effectiveFrom: isoDate(subDays(new Date(), 5)), effectiveTo: null,
    })
    const out = await resolveCostBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    const r = out.get(`${user.id}::${team.id}`)!
    expect(r.rate).toBe(75)
    expect(r.source).toBe('override:special_project')
  })

  it('falls back to the team\'s cost group rate when there is no override', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await makeCostGroup(team.id, { hourlyCostRate: '42.00', currency: 'EUR' })
    const out = await resolveCostBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    const r = out.get(`${user.id}::${team.id}`)!
    expect(r.rate).toBe(42)
    expect(r.currency).toBe('EUR')
    expect(r.source).toBe('group:CostGroup')
  })

  it('reports unset when neither an override nor a cost group exists', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const out = await resolveCostBatch([{ userId: user.id, teamId: team.id, asOf: new Date() }])
    const r = out.get(`${user.id}::${team.id}`)!
    expect(r.rate).toBeNull()
    expect(r.source).toBe('unset')
  })
})

describe('findOverridesConflict', () => {
  it('detects an overlap with an existing open-ended override', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await testDb.insert(schema.capacityUserOverrides).values({
      userId: user.id, teamId: team.id, targetHoursPerWeek: '10.0', reason: 'pto',
      effectiveFrom: '2026-01-01', effectiveTo: null,
    })
    const conflictId = await findOverridesConflict({
      table: 'capacity', userId: user.id, teamId: team.id,
      effectiveFrom: '2026-02-01', effectiveTo: '2026-03-01',
    })
    expect(conflictId).not.toBeNull()
  })

  it('reports no conflict for a range entirely before an existing override starts', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    await testDb.insert(schema.capacityUserOverrides).values({
      userId: user.id, teamId: team.id, targetHoursPerWeek: '10.0', reason: 'pto',
      effectiveFrom: '2026-06-01', effectiveTo: null,
    })
    const conflictId = await findOverridesConflict({
      table: 'capacity', userId: user.id, teamId: team.id,
      effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01',
    })
    expect(conflictId).toBeNull()
  })

  it('excludes the row itself via excludeId (editing an override in place)', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const [existing] = await testDb.insert(schema.capacityUserOverrides).values({
      userId: user.id, teamId: team.id, targetHoursPerWeek: '10.0', reason: 'pto',
      effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01',
    }).returning()
    const conflictId = await findOverridesConflict({
      table: 'capacity', userId: user.id, teamId: team.id,
      effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01',
      excludeId: existing!.id,
    })
    expect(conflictId).toBeNull()
  })
})
