// vNext: Opportunity Relink (CLAUDE.md §7). buildRelinkSnapshotPatch() is a
// pure function — no I/O — so it's tested directly, mirroring how
// buildSfRecord() (writeback.ts) was made independently testable.
// applyOpportunityRelink() does touch the database (a transaction against
// `activities`), so it's exercised against pglite, same convention as
// resolver.test.ts / engine.test.ts.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'
import { ASSIGNED_SE_FALLBACK_FIELD, PRIMARY_ENGINEER_FALLBACK_FIELD } from './refreshOppSnapshots.js'
import type { RelinkOppRow } from './relinkOpportunity.js'

let testDb: TestDb
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let buildRelinkSnapshotPatch: typeof import('./relinkOpportunity.js')['buildRelinkSnapshotPatch']
let applyOpportunityRelink: typeof import('./relinkOpportunity.js')['applyOpportunityRelink']
let schema: typeof import('../../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ buildRelinkSnapshotPatch, applyOpportunityRelink } = await import('./relinkOpportunity.js'))
  schema = await import('../../../../drizzle/schema.js')
  const dbModule = await import('../../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

function oppRow(overrides: Partial<RelinkOppRow> = {}): RelinkOppRow {
  return {
    Id: '006xx0000opp1',
    Name: 'Renewal — Acme Corp',
    StageName: 'Closed Won',
    ForecastCategoryName: 'Closed',
    Amount: 50000,
    IsClosed: true,
    IsWon: true,
    CloseDate: '2026-09-30',
    OwnerId: '005xx0000owner1',
    Owner: { Name: 'Pat Owner' },
    AccountId: '001xx0000acct1',
    Account: { Name: 'Acme Corp' },
    ...overrides,
  }
}

describe('buildRelinkSnapshotPatch', () => {
  it('maps a normal live Opportunity record into the patch shape', () => {
    const patch = buildRelinkSnapshotPatch(oppRow(), undefined, undefined)
    expect(patch).toEqual({
      crmWhatId: '006xx0000opp1',
      crmWhatName: 'Renewal — Acme Corp',
      crmAccountId: '001xx0000acct1',
      crmAccountName: 'Acme Corp',
      salesStage: 'Closed Won',
      forecastCategory: 'Closed',
      oppAmount: '50000',
      crmIsClosed: true,
      crmIsWon: true,
      crmOppCloseDate: '2026-09-30',
      crmOppOwnerId: '005xx0000owner1',
      crmOppOwnerName: 'Pat Owner',
      crmAssignedSeName: null,
      crmPrimaryEngineerName: null,
    })
  })

  it('degrades missing/null fields to null rather than throwing', () => {
    const patch = buildRelinkSnapshotPatch(oppRow({
      Amount: null, CloseDate: null, OwnerId: null, Owner: null, AccountId: null, Account: null,
    }), undefined, undefined)
    expect(patch.oppAmount).toBeNull()
    expect(patch.crmOppCloseDate).toBeNull()
    expect(patch.crmOppOwnerName).toBeNull()
    expect(patch.crmAccountId).toBeNull()
    expect(patch.crmAccountName).toBeNull()
  })

  it('resolves Assigned SE / Primary Engineer via a flat field when no mapping path is configured', () => {
    const rec = oppRow({ [ASSIGNED_SE_FALLBACK_FIELD]: 'Jamie SE', [PRIMARY_ENGINEER_FALLBACK_FIELD]: 'Robin PE' })
    const patch = buildRelinkSnapshotPatch(rec, undefined, undefined)
    expect(patch.crmAssignedSeName).toBe('Jamie SE')
    expect(patch.crmPrimaryEngineerName).toBe('Robin PE')
  })

  it('resolves Assigned SE / Primary Engineer via a configured relationship path when present', () => {
    const rec = oppRow({
      Assigned_SE__r: { Name: 'Jamie via lookup' },
      Primary_Engineer__r: { Name: 'Robin via lookup' },
    })
    const patch = buildRelinkSnapshotPatch(rec, 'Assigned_SE__r.Name', 'Primary_Engineer__r.Name')
    expect(patch.crmAssignedSeName).toBe('Jamie via lookup')
    expect(patch.crmPrimaryEngineerName).toBe('Robin via lookup')
  })

  it('falls back to the canonical flat field when the configured path resolves to nothing', () => {
    const rec = oppRow({ [ASSIGNED_SE_FALLBACK_FIELD]: 'Fallback Jamie' })
    // Assigned_SE__r.Name isn't present on this record at all.
    const patch = buildRelinkSnapshotPatch(rec, 'Assigned_SE__r.Name', undefined)
    expect(patch.crmAssignedSeName).toBe('Fallback Jamie')
  })
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

function baseSnapshot(overrides: Partial<Parameters<typeof applyOpportunityRelink>[0]['snapshot']> = {}) {
  return {
    crmWhatId: 'opp-new',
    crmWhatName: 'New Opportunity',
    crmAccountId: 'acct-new',
    crmAccountName: 'New Account',
    salesStage: 'Negotiation',
    forecastCategory: 'Best Case',
    oppAmount: '75000',
    crmIsClosed: false,
    crmIsWon: false,
    crmOppCloseDate: '2026-12-31',
    crmOppOwnerId: 'owner-new',
    crmOppOwnerName: 'New Owner',
    crmAssignedSeName: 'New SE',
    crmPrimaryEngineerName: 'New PE',
    ...overrides,
  }
}

describe('applyOpportunityRelink', () => {
  it('moves both draft and submitted activities off the old Opp onto the new one', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const type = await makeActivityType(team.id)

    const [draft] = await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'Draft one', activityTypeId: type.id, status: 'draft',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-old', crmWhatType: 'Opportunity', crmWhatName: 'Old Opportunity',
    }).returning()
    const [submitted] = await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'Submitted one', activityTypeId: type.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '2.00',
      crmWhatId: 'opp-old', crmWhatType: 'Opportunity', crmWhatName: 'Old Opportunity',
    }).returning()

    const { movedIds } = await applyOpportunityRelink({
      teamId: team.id, fromOppId: 'opp-old', toOppId: 'opp-new', snapshot: baseSnapshot(),
    })
    expect(movedIds.sort()).toEqual([draft!.id, submitted!.id].sort())

    const [refreshedDraft] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, draft!.id))
    const [refreshedSubmitted] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, submitted!.id))
    expect(refreshedDraft!.crmWhatId).toBe('opp-new')
    expect(refreshedDraft!.crmWhatName).toBe('New Opportunity')
    expect(refreshedSubmitted!.crmWhatId).toBe('opp-new')
  })

  it('resets crmWhatDeleted/crmDisconnectCheckedAt on every moved row', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const type = await makeActivityType(team.id)
    const [activity] = await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'A', activityTypeId: type.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-old', crmWhatType: 'Opportunity', crmWhatName: 'Old Opportunity',
      crmWhatDeleted: true,
    }).returning()

    await applyOpportunityRelink({ teamId: team.id, fromOppId: 'opp-old', toOppId: 'opp-new', snapshot: baseSnapshot() })

    const [refreshed] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, activity!.id))
    expect(refreshed!.crmWhatDeleted).toBe(false)
    expect(refreshed!.crmDisconnectCheckedAt).not.toBeNull()
  })

  it('re-queues Salesforce sync only for a row that already has an crmRecordId', async () => {
    const team = await makeTeam()
    const user = await makeUser()
    const type = await makeActivityType(team.id)

    const [synced] = await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'Synced', activityTypeId: type.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-old', crmWhatType: 'Opportunity', crmWhatName: 'Old Opportunity',
      crmRecordId: '00Uxxxxxxxxxxxx', crmSyncStatus: 'synced',
    }).returning()
    const [neverSynced] = await testDb.insert(schema.activities).values({
      userId: user.id, teamId: team.id, title: 'Draft never synced', activityTypeId: type.id, status: 'draft',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-old', crmWhatType: 'Opportunity', crmWhatName: 'Old Opportunity',
      crmRecordId: null,
    }).returning()

    const { requeuedIds } = await applyOpportunityRelink({
      teamId: team.id, fromOppId: 'opp-old', toOppId: 'opp-new', snapshot: baseSnapshot(),
    })
    expect(requeuedIds).toEqual([synced!.id])

    const [refreshedSynced] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, synced!.id))
    expect(refreshedSynced!.crmSyncStatus).toBe('pending')
    expect(refreshedSynced!.crmSyncError).toBeNull()
    expect(refreshedSynced!.crmSyncAttempts).toBe(0)

    const [refreshedDraft] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, neverSynced!.id))
    // Not re-queued (no crmRecordId) — its sync status is untouched (default 'pending' from insert, not reset).
    expect(refreshedDraft!.crmWhatId).toBe('opp-new')
  })

  it('never touches a same-fromOppId activity that belongs to a different team', async () => {
    const teamA = await makeTeam()
    const teamB = await makeTeam()
    const user = await makeUser()
    const typeA = await makeActivityType(teamA.id)
    const typeB = await makeActivityType(teamB.id)

    await testDb.insert(schema.activities).values({
      userId: user.id, teamId: teamA.id, title: 'Team A activity', activityTypeId: typeA.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-old', crmWhatType: 'Opportunity', crmWhatName: 'Old Opportunity',
    })
    const [otherTeamActivity] = await testDb.insert(schema.activities).values({
      userId: user.id, teamId: teamB.id, title: 'Team B activity (should be untouched)', activityTypeId: typeB.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
      crmWhatId: 'opp-old', crmWhatType: 'Opportunity', crmWhatName: 'Old Opportunity',
    }).returning()

    const { movedIds } = await applyOpportunityRelink({
      teamId: teamA.id, fromOppId: 'opp-old', toOppId: 'opp-new', snapshot: baseSnapshot(),
    })
    expect(movedIds).not.toContain(otherTeamActivity!.id)

    const [refreshedOther] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, otherTeamActivity!.id))
    expect(refreshedOther!.crmWhatId).toBe('opp-old')
  })
})
