// pglite-backed tests for detectAnomalies() — the "what changed" leader
// dashboard callout (CLAUDE.md §13). Same shared-instance-per-file
// convention as engine.test.ts / resolver.test.ts. Each test uses its own
// fresh team so results stay isolated by the query's teamId filter.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { startOfWeek, endOfWeek, subWeeks, addDays } from 'date-fns'
import type { TestDb } from '../../db/testDb.js'

let testDb: TestDb
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let detectAnomalies: typeof import('./anomalies.js')['detectAnomalies']
let schema: typeof import('../../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ detectAnomalies } = await import('./anomalies.js'))
  schema = await import('../../../../drizzle/schema.js')
  const dbModule = await import('../../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

// Mirrors detectAnomalies()'s own anchor math for weekShift=0 exactly, so
// fixtures land in the same buckets the function under test computes.
const BASELINE_WEEKS = 8
const anchor = subWeeks(new Date(), 1)
const weekStart = startOfWeek(anchor, { weekStartsOn: 1 })
const weekEnd = endOfWeek(anchor, { weekStartsOn: 1 })
void weekEnd
void BASELINE_WEEKS

function currentWeekDate(): Date {
  return addDays(weekStart, 2) // Wednesday of the week under test
}

// weeksBack=1 is the week immediately before weekStart; weeksBack=8 is the
// earliest baseline week. Both are inside [baseStart, baseEnd] by construction.
function baselineWeekDate(weeksBack: number): Date {
  return addDays(subWeeks(weekStart, weeksBack), 2)
}

async function makeTeam() {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  return team!
}

async function makeUser() {
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'Test User',
  }).returning()
  return user!
}

async function makeMember(teamId: string) {
  const user = await makeUser()
  await testDb.insert(schema.teamMembers).values({ teamId, userId: user.id, role: 'contributor' })
  return user
}

async function makeActivityType(teamId: string, name = 'Demo') {
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId, name, sortOrder: 1 }).returning()
  return type!
}

async function logActivity(opts: {
  userId: string
  teamId: string
  activityTypeId: string
  date: Date
  hours: number
  crmWhatId?: string | null
  crmWhatName?: string | null
  crmWhatType?: 'Opportunity' | 'Account' | null
  crmWhoId?: string | null
  crmSyncStatus?: 'pending' | 'synced' | 'failed' | null
}) {
  await testDb.insert(schema.activities).values({
    userId: opts.userId,
    teamId: opts.teamId,
    title: 'A',
    activityTypeId: opts.activityTypeId,
    status: 'submitted',
    startDatetime: opts.date,
    endDatetime: opts.date,
    effortHours: opts.hours.toFixed(2),
    crmWhatId: opts.crmWhatId ?? null,
    crmWhatName: opts.crmWhatName ?? null,
    crmWhatType: opts.crmWhatType ?? null,
    crmWhoId: opts.crmWhoId ?? null,
    crmSyncStatus: opts.crmSyncStatus ?? null,
  })
}

describe('detectAnomalies — insufficient history', () => {
  it('flags insufficientHistory when fewer than MIN_BASELINE_WEEKS have any data', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    // Only 2 populated baseline weeks — below the 4-week minimum.
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(1), hours: 1 })
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(2), hours: 1 })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.insufficientHistory).toBe(true)
    expect(result.baselineWeeksWithData).toBe(2)
  })
})

describe('detectAnomalies — account/opportunity burn spike', () => {
  it('fires when this week is far above the mean of ACTIVE baseline weeks, and reports that mean', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    const whatId = '006xxACTIVE'
    // 3 active baseline weeks at 4h each -> mean 4. Plus one more baseline
    // week on an unrelated Opportunity purely to clear the overall
    // MIN_BASELINE_WEEKS(4) gate that flips insufficientHistory (which would
    // otherwise skip every baseline-relative detector regardless of this
    // one's own 3-active-week floor).
    for (const w of [1, 2, 3]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 4, crmWhatId: whatId, crmWhatName: 'Acme Corp', crmWhatType: 'Opportunity' })
    }
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(4), hours: 1, crmWhatId: 'unrelated-opp', crmWhatType: 'Opportunity' })
    // Current week: 12h -> ratio 3.0 (>= 2.5 threshold), volume floor (8h) cleared.
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 12, crmWhatId: whatId, crmWhatName: 'Acme Corp', crmWhatType: 'Opportunity' })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    const found = result.anomalies.find((a) => a.code === 'account_burn_spike' && a.subjectId === whatId)
    expect(found).toBeDefined()
    // Mean must be computed over the 3 ACTIVE weeks (4h), not all 8 (which would be 1.5h).
    expect(found!.params.average).toBe(4)
    expect(found!.params.ratio).toBe(3)
    expect(found!.subjectType).toBe('opportunity')
  })

  it('does not fire below the spike ratio even with the volume floor cleared', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    const whatId = '006xxQUIET'
    for (const w of [1, 2, 3]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 4, crmWhatId: whatId, crmWhatType: 'Opportunity' })
    }
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(4), hours: 1, crmWhatId: 'unrelated-opp', crmWhatType: 'Opportunity' })
    // 9h this week -> ratio 2.25, below the 2.5x threshold.
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 9, crmWhatId: whatId, crmWhatType: 'Opportunity' })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.code === 'account_burn_spike' && a.subjectId === whatId)).toBe(false)
  })

  it('does not fire when fewer than the minimum number of active baseline weeks exist, even at a huge ratio', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    const whatId = '006xxSPARSE'
    // Only 2 active baseline weeks (below ACCOUNT_MIN_ACTIVE_BASELINE_WEEKS = 3).
    // Use a 4th, unrelated baseline week on a DIFFERENT what-id so the team
    // still clears MIN_BASELINE_WEEKS overall and insufficientHistory is false.
    for (const w of [1, 2]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 4, crmWhatId: whatId, crmWhatType: 'Opportunity' })
    }
    for (const w of [3, 4]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 1, crmWhatId: 'other-opp', crmWhatType: 'Opportunity' })
    }
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 40, crmWhatId: whatId, crmWhatType: 'Opportunity' })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.code === 'account_burn_spike' && a.subjectId === whatId)).toBe(false)
  })
})

describe('detectAnomalies — contributor over capacity', () => {
  it('fires once hours/target clears the over-capacity ratio', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    const [g] = await testDb.insert(schema.capacityGroups).values({
      name: 'G', capacityMethod: 'fixed_hours', targetHoursPerWeek: '20.0',
    }).returning()
    await testDb.insert(schema.capacityGroupTeams).values({ groupId: g!.id, teamId: team.id })
    // 26h / 20h target = 1.3 (>= 1.25 threshold)
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 26 })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    const found = result.anomalies.find((a) => a.code === 'contributor_over_capacity' && a.subjectId === user.id)
    expect(found).toBeDefined()
    expect(found!.params.target).toBe(20)
  })

  it('does not fire below the over-capacity ratio', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    const [g] = await testDb.insert(schema.capacityGroups).values({
      name: 'G', capacityMethod: 'fixed_hours', targetHoursPerWeek: '20.0',
    }).returning()
    await testDb.insert(schema.capacityGroupTeams).values({ groupId: g!.id, teamId: team.id })
    // 24h / 20h = 1.2, below 1.25
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 24 })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.code === 'contributor_over_capacity' && a.subjectId === user.id)).toBe(false)
  })
})

describe('detectAnomalies — contributor stopped logging', () => {
  it('fires for a user active every baseline week who logged nothing this week', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    for (const w of [1, 2, 3, 4]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 5 })
    }
    // Nothing logged this week.
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.code === 'contributor_logging_stopped' && a.subjectId === user.id)).toBe(true)
  })

  it('does not fire for a user with fewer active baseline weeks than the floor', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    for (const w of [1, 2, 3]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 5 })
    }
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.code === 'contributor_logging_stopped' && a.subjectId === user.id)).toBe(false)
  })
})

describe('detectAnomalies — activity-type surge/collapse use the FULL 8-week baseline, zero weeks included', () => {
  it('surge: divides by 8, not by the number of populated weeks', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id, 'Discovery')
    // Only 4 of 8 baseline weeks populated, 10h each -> sum 40, mean = 40/8 = 5
    // (NOT 40/4 = 10, which is what an active-weeks-only average would give).
    for (const w of [1, 2, 3, 4]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 10 })
    }
    // Current week 30h -> ratio vs mean(5) = 6.0 (>= 2.5 surge threshold)
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 30 })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    const found = result.anomalies.find((a) => a.code === 'activity_type_surge' && a.subjectName === 'Discovery')
    expect(found).toBeDefined()
    expect(found!.params.average).toBe(5)
  })

  it('collapse: a type with an established baseline mean that drops to zero this week', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id, 'Enablement')
    for (const w of [1, 2, 3, 4]) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(w), hours: 10 })
    }
    // Nothing logged this week for this type -> ratio 0 <= 0.4 collapse threshold.
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    const found = result.anomalies.find((a) => a.code === 'activity_type_collapse' && a.subjectName === 'Enablement')
    expect(found).toBeDefined()
    expect(found!.severity).toBe('medium') // ratio === 0 -> medium, not low
  })

  it('does not fire for a type whose baseline mean never clears the minimum-hours floor', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id, 'RareType')
    // 1 baseline week at 2h -> mean = 2/8 = 0.25, well under TYPE_MIN_BASELINE_HOURS (5)
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(1), hours: 2 })
    await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 20 })

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.subjectName === 'RareType')).toBe(false)
  })
})

describe('detectAnomalies — unlinked activity spike', () => {
  it('fires when unlinked share jumps well above the baseline share, past both floors', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    // Baseline: 40 total, 2 unlinked (5% share) — clearly linked most of the time.
    for (let i = 0; i < 38; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(1), hours: 1, crmWhatId: `wid-${i}` })
    }
    for (let i = 0; i < 2; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: baselineWeekDate(1), hours: 1 })
    }
    // This week: 20 total, 10 unlinked -> share 0.5 (>= 0.25 floor, count >= 5 floor, jump 0.45 >= 0.15)
    for (let i = 0; i < 10; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 1, crmWhatId: `cur-${i}` })
    }
    for (let i = 0; i < 10; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 1 })
    }

    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    const found = result.anomalies.find((a) => a.code === 'unlinked_spike')
    expect(found).toBeDefined()
    expect(found!.severity).toBe('medium') // share >= 0.5
  })

  it('does not fire when the unlinked count is below the volume floor', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    // 4 total, all 4 unlinked this week -> share 1.0 but count (4) < UNLINKED_MIN_COUNT (5)
    for (let i = 0; i < 4; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 1 })
    }
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.code === 'unlinked_spike')).toBe(false)
  })
})

describe('detectAnomalies — Salesforce sync failures', () => {
  it('fires once failed-sync count clears the floor', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    for (let i = 0; i < 3; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 1, crmSyncStatus: 'failed' })
    }
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    const found = result.anomalies.find((a) => a.code === 'sync_failures')
    expect(found).toBeDefined()
    expect(found!.severity).toBe('medium') // below the 10-failure high-severity threshold
  })

  it('escalates to high severity once failures reach double digits', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    for (let i = 0; i < 10; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 1, crmSyncStatus: 'failed' })
    }
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    const found = result.anomalies.find((a) => a.code === 'sync_failures')
    expect(found!.severity).toBe('high')
  })

  it('does not fire below the failure-count floor', async () => {
    const team = await makeTeam()
    const user = await makeMember(team.id)
    const type = await makeActivityType(team.id)
    for (let i = 0; i < 2; i++) {
      await logActivity({ userId: user.id, teamId: team.id, activityTypeId: type.id, date: currentWeekDate(), hours: 1, crmSyncStatus: 'failed' })
    }
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    expect(result.anomalies.some((a) => a.code === 'sync_failures')).toBe(false)
  })
})
