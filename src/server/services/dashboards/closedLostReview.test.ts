// pglite-backed tests for fetchClosedLostReviewCandidates() — the "Closed
// Lost — Needs Review" dashboard's candidate query (CLAUDE.md §7/§13).
// Same shared-instance-per-file convention as resolver.test.ts / engine.test.ts.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { subDays, addDays } from 'date-fns'
import type { TestDb } from '../../db/testDb.js'

let testDb: TestDb
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let fetchClosedLostReviewCandidates: typeof import('./closedLostReview.js')['fetchClosedLostReviewCandidates']
let schema: typeof import('../../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ fetchClosedLostReviewCandidates } = await import('./closedLostReview.js'))
  schema = await import('../../../../drizzle/schema.js')
  const dbModule = await import('../../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

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

async function makeActivityType(teamId: string) {
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId, name: 'Demo', sortOrder: 1 }).returning()
  return type!
}

function baseParams(teamId: string, overrides: Partial<Parameters<typeof fetchClosedLostReviewCandidates>[0]> = {}) {
  return {
    teamId,
    dateBasis: 'activity' as const,
    rangeStart: subDays(new Date(), 30),
    rangeEnd: addDays(new Date(), 1),
    stages: [],
    forecast: [],
    acvRanges: [],
    productIds: [],
    memberIds: [],
    includeDismissed: false,
    ...overrides,
  }
}

describe('fetchClosedLostReviewCandidates', () => {
  it('includes a submitted activity on a Closed Lost (isClosed && !isWon) Opportunity', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const type = await makeActivityType(team.id)
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'A', activityTypeId: type.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-lost', crmWhatType: 'Opportunity', crmWhatName: 'Lost Opp',
      crmIsClosed: true, crmIsWon: false,
    })
    const rows = await fetchClosedLostReviewCandidates(baseParams(team.id))
    expect(rows.map((r) => r.oppId)).toEqual(['opp-lost'])
    expect(rows[0]!.activityCount).toBe(1)
  })

  it('excludes an Opportunity that is closed AND won', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const type = await makeActivityType(team.id)
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'A', activityTypeId: type.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-won', crmWhatType: 'Opportunity', crmWhatName: 'Won Opp',
      crmIsClosed: true, crmIsWon: true,
    })
    const rows = await fetchClosedLostReviewCandidates(baseParams(team.id))
    expect(rows).toEqual([])
  })

  it('excludes an Opportunity that is still open (not closed)', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const type = await makeActivityType(team.id)
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'A', activityTypeId: type.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-open', crmWhatType: 'Opportunity', crmWhatName: 'Open Opp',
      crmIsClosed: false, crmIsWon: false,
    })
    const rows = await fetchClosedLostReviewCandidates(baseParams(team.id))
    expect(rows).toEqual([])
  })

  it('excludes a draft activity on an otherwise-qualifying Opportunity', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const type = await makeActivityType(team.id)
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'A', activityTypeId: type.id, status: 'draft',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-draft-only', crmWhatType: 'Opportunity', crmWhatName: 'Draft-linked Opp',
      crmIsClosed: true, crmIsWon: false,
    })
    const rows = await fetchClosedLostReviewCandidates(baseParams(team.id))
    expect(rows).toEqual([])
  })

  it('excludes a dismissed Opportunity by default, and includes it when includeDismissed=true', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const admin = await makeUser()
    const type = await makeActivityType(team.id)
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'A', activityTypeId: type.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-dismissed', crmWhatType: 'Opportunity', crmWhatName: 'Dismissed Opp',
      crmIsClosed: true, crmIsWon: false,
    })
    await testDb.insert(schema.oppReviewDismissals).values({
      teamId: team.id, crmOppId: 'opp-dismissed', crmOppName: 'Dismissed Opp', dismissedBy: admin.id,
    })

    const hidden = await fetchClosedLostReviewCandidates(baseParams(team.id))
    expect(hidden).toEqual([])

    const shown = await fetchClosedLostReviewCandidates(baseParams(team.id, { includeDismissed: true }))
    expect(shown).toHaveLength(1)
    expect(shown[0]!.dismissed).not.toBeNull()
    expect(shown[0]!.dismissed!.by).toBe(admin.id)
  })

  it('is team-scoped — an otherwise-matching activity on a different team never appears', async () => {
    const teamA = await makeTeam()
    const teamB = await makeTeam()
    const user = await makeUser()
    const typeB = await makeActivityType(teamB.id)
    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: teamB.id, title: 'A', activityTypeId: typeB.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-team-b', crmWhatType: 'Opportunity', crmWhatName: 'Team B Opp',
      crmIsClosed: true, crmIsWon: false,
    })
    const rows = await fetchClosedLostReviewCandidates(baseParams(teamA.id))
    expect(rows).toEqual([])
  })
})
