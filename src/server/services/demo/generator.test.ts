// pglite-backed: Demo Data lives in its own team, never touches real teams or
// real users' notifications, and serves the fixture calendar only to demo
// users and the admin who generated it.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { eq, like } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'
import { SCRIPTS } from './gongFixtures.js'
import { DEMO_CUSTOM_SECTIONS } from './profileFixtures.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let gen: typeof import('./generator.js')
let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb

beforeAll(async () => {
  gen = await import('./generator.js')
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

describe('demo data', () => {
  // One demo set at a time: clear it even when a test fails, so one
  // failure doesn't cascade into "already present" in the next test.
  afterEach(async () => {
    await gen.removeDemoData()
  })

  it('generates into its own team, scopes the calendar, and removes cleanly', async () => {
    const [realTeam] = await testDb.insert(schema.teams).values({ name: 'Real', slug: 'real' }).returning()
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin', email: 'admin@example.com', displayName: 'Admin', isAppAdmin: true }).returning()
    const [other] = await testDb.insert(schema.users).values({ oktaId: 'okta-other', email: 'other@example.com', displayName: 'Other' }).returning()
    await testDb.insert(schema.notifications).values({ userId: other!.id, teamId: realTeam!.id, kind: 'nudge', message: 'real nudge' })

    const result = await gen.generateDemoData({ contributorCount: 3, weeksBack: 2, includeAdmin: true, adminUserId: admin!.id, now: new Date('2026-10-21T12:00:00Z') })
    expect(result.teamId).not.toBe(realTeam!.id)
    expect(result.usersCreated).toBe(3)

    const [demoTeam] = await testDb.select().from(schema.teams).where(eq(schema.teams.slug, gen.DEMO_TEAM_SLUG))
    expect(demoTeam?.id).toBe(result.teamId)
    expect(await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, realTeam!.id))).toHaveLength(0)
    expect(await testDb.select().from(schema.teamMembers).where(eq(schema.teamMembers.teamId, realTeam!.id))).toHaveLength(0)
    const demoActivities = await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, result.teamId))
    expect(demoActivities.length).toBe(result.activitiesCreated)

    const products = await testDb.select({ name: schema.products.name }).from(schema.products).where(like(schema.products.name, '[Demo] %'))
    expect(products.map((p) => p.name)).toContain('[Demo] Core Platform')

    const [demoUser] = await testDb.select().from(schema.users).where(like(schema.users.email, `%${gen.DEMO_EMAIL_SUFFIX}`)).limit(1)
    expect(await gen.isDemoCalendarUser(admin!.id)).toBe(true)
    expect(await gen.isDemoCalendarUser(demoUser!.id)).toBe(true)
    expect(await gen.isDemoCalendarUser(other!.id)).toBe(false)

    await expect(gen.generateDemoData({ contributorCount: 1, weeksBack: 1, includeAdmin: true, adminUserId: admin!.id })).rejects.toBeInstanceOf(gen.DemoDataExistsError)

    // The richer data the dashboards need, all inside the demo team.
    const [cost] = await testDb.select().from(schema.costGroupTeams).where(eq(schema.costGroupTeams.teamId, result.teamId))
    expect(cost).toBeDefined()
    expect(await testDb.select().from(schema.subteams).where(eq(schema.subteams.teamId, result.teamId))).toHaveLength(2)
    expect(await testDb.select().from(schema.attachRateFields).where(eq(schema.attachRateFields.teamId, result.teamId))).toHaveLength(1)
    expect((await testDb.select().from(schema.crmOpportunityCoverage)).length).toBeGreaterThan(10)
    expect((await testDb.select().from(schema.crmHistoricalEvents)).every((r) => r.teamId === result.teamId)).toBe(true)
    const now = new Date('2026-10-21T12:00:00Z')
    expect(demoActivities.every((a) => a.startDatetime.getTime() <= now.getTime())).toBe(true)
    const oppLinked = demoActivities.filter((a) => a.crmWhatType === 'Opportunity')
    expect(oppLinked.length).toBeGreaterThan(0)
    expect(oppLinked.every((a) => !!a.salesStage && !!a.forecastCategory && !!a.oppCloseDate)).toBe(true)
    expect(demoActivities.some((a) => !!a.subtypeId)).toBe(true)
    const calendarLinked = demoActivities.filter((a) => a.outlookEventId)
    expect(calendarLinked.length).toBeGreaterThan(0)
    const stored = await testDb.select({ id: schema.outlookEvents.id }).from(schema.outlookEvents)
    const storedIds = new Set(stored.map((r) => r.id))
    expect(calendarLinked.filter((a) => a.userId !== admin!.id).every((a) => storedIds.has(a.outlookEventId!))).toBe(true)
    // A few rows in each exception state.
    expect(demoActivities.some((a) => a.status === 'draft')).toBe(true)
    expect(demoActivities.filter((a) => a.crmSyncStatus === 'failed')).toHaveLength(3)
    expect(demoActivities.filter((a) => a.crmSyncStatus === 'failed').every((a) => a.crmNextRetryAt === null)).toBe(true)
    expect(demoActivities.some((a) => a.crmSyncStatus === 'synced' && a.crmRecordId?.startsWith('demo-'))).toBe(true)
    expect(demoActivities.some((a) => a.crmWhatDeleted)).toBe(true)
    expect(demoActivities.some((a) => a.userId === admin!.id && a.outlookDeletedAt && !a.crmRecordId)).toBe(true)
    expect((await testDb.select().from(schema.nonActivityEvents)).length).toBeGreaterThan(0)
    // The fixture calendar is the same whatever window is requested.
    const day = gen.generateDemoOutlookEvents('2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z', demoUser!.id, { name: demoUser!.displayName, email: demoUser!.email })
    const week = gen.generateDemoOutlookEvents('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z', demoUser!.id, { name: demoUser!.displayName, email: demoUser!.email })
    expect(week.slice(0, day.length).map((e) => e.id)).toEqual(day.map((e) => e.id))

    // Sample Gong calls with transcripts, links and AI Notes (v1.459.0).
    const demoCalls = await testDb.select().from(schema.gongCalls)
    expect(demoCalls.length).toBeGreaterThan(0)
    expect(demoCalls.every((c) => c.id.startsWith('demo-gong-') && c.url === null)).toBe(true)
    expect(await testDb.select().from(schema.gongTranscriptCache)).toHaveLength(demoCalls.length)
    const links = await testDb.select().from(schema.activityGongCalls)
    expect(links.length).toBeGreaterThan(0)
    const demoActivityIds = new Set(demoActivities.map((a) => a.id))
    expect(links.every((l) => demoActivityIds.has(l.activityId))).toBe(true)
    expect(links.length).toBeLessThan(demoCalls.length) // some are left as suggestions
    const aiNotes = await testDb.select().from(schema.activityAiNotes)
    expect(aiNotes.length).toBeGreaterThan(0)
    expect(aiNotes.every((n) => n.model === 'Demo sample' && n.providerId === null)).toBe(true)
    const statuses = new Set((await testDb.select().from(schema.activityAiNoteItems)).map((i) => i.status))
    expect(statuses).toEqual(new Set(['to_review', 'kept']))
    expect(demoTeam?.aiNotesEnabled).toBe(true)
    // AI Assessments assigned to the demo team, with scores (v1.464.0).
    const rubrics = await testDb.select().from(schema.aiAssessments)
    expect(rubrics.length).toBeGreaterThan(0)
    expect(rubrics.every((r) => r.teamId === demoTeam!.id)).toBe(true)
    expect((await testDb.select().from(schema.aiAssessmentAssignments)).length).toBe(rubrics.length)
    const scores = await testDb.select().from(schema.activityAiAssessmentScores)
    expect(scores.length).toBeGreaterThan(0)
    expect(scores.every((sc) => demoActivityIds.has(sc.activityId) && sc.model === 'Demo sample' && sc.zeroedScore >= 0 && sc.zeroedScore <= 100)).toBe(true)
    expect(new Set(scores.map((sc) => sc.zeroedScore)).size).toBeGreaterThan(1)
    // Settings Profiles: one starred Default, each assessment on its own
    // profile, one Replace, and demo AI Note items in their custom sections (v1.473.0).
    const profiles = await testDb.select().from(schema.aiNoteProfiles).where(eq(schema.aiNoteProfiles.teamId, demoTeam!.id))
    expect(profiles.filter((p) => p.isDefault)).toHaveLength(1)
    expect(profiles.some((p) => p.combineMode === 'replace')).toBe(true)
    const profileIds = new Set(profiles.map((p) => p.id))
    expect(rubrics.every((r) => r.aiNoteProfileId !== null && profileIds.has(r.aiNoteProfileId))).toBe(true)
    // Which activities get a demo AI Note depends on the date, so the custom
    // sections are checked on the scripts, and on any seeded items.
    const scriptSections = new Set(Object.values(SCRIPTS).flatMap((sc) => sc.items.map((i) => i.section)))
    expect(Object.values(DEMO_CUSTOM_SECTIONS).every((c) => scriptSections.has(c.key))).toBe(true)
    const customItems = (await testDb.select().from(schema.activityAiNoteItems)).filter((i) => i.section.startsWith('c_'))
    expect(customItems.every((i) => i.sectionMeta !== null)).toBe(true)

    const removed = await gen.removeDemoData()
    expect(removed.teams).toBe(1)
    expect(removed.users).toBe(3)
    expect(removed.activities).toBe(result.activitiesCreated)
    expect(await testDb.select().from(schema.teams).where(eq(schema.teams.slug, gen.DEMO_TEAM_SLUG))).toHaveLength(0)
    expect(await testDb.select().from(schema.notifications).where(eq(schema.notifications.userId, other!.id))).toHaveLength(1)
    expect(await gen.isDemoCalendarUser(admin!.id)).toBe(false)
    expect(await gen.demoDataStatus()).toMatchObject({ team: null, users: 0, activities: 0, capacityGroups: 0 })
    expect(await testDb.select().from(schema.crmOpportunityCoverage)).toHaveLength(0)
    expect(await testDb.select().from(schema.crmHistoricalEvents)).toHaveLength(0)
    expect(await testDb.select().from(schema.outlookEvents)).toHaveLength(0)
    expect(await testDb.select().from(schema.costGroups).where(like(schema.costGroups.name, '[Demo] %'))).toHaveLength(0)
    expect(await testDb.select().from(schema.subteamUsers)).toHaveLength(0)
    expect(await testDb.select().from(schema.gongCalls)).toHaveLength(0)
    expect(await testDb.select().from(schema.gongTranscriptCache)).toHaveLength(0)
    expect(await testDb.select().from(schema.activityAiNotes)).toHaveLength(0)
    expect(await testDb.select().from(schema.aiAssessments)).toHaveLength(0)
    expect(await testDb.select().from(schema.activityAiAssessmentScores)).toHaveLength(0)
    expect(await testDb.select().from(schema.aiNoteProfiles)).toHaveLength(0)
  })

  it('plants the anomalies the What changed panel looks for', async () => {
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-2', email: 'admin2@example.com', displayName: 'Admin Two', isAppAdmin: true }).returning()
    const now = new Date('2026-10-21T12:00:00Z')
    const result = await gen.generateDemoData({ contributorCount: 4, weeksBack: 8, includeAdmin: false, adminUserId: admin!.id, now })
    const rows = await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, result.teamId))
    const lastWeekStart = new Date('2026-10-12T00:00:00Z').getTime()
    const lastWeekEnd = new Date('2026-10-19T00:00:00Z').getTime()
    const hoursBy = new Map<string, number>()
    for (const r of rows) {
      if (r.startDatetime.getTime() < lastWeekStart || r.startDatetime.getTime() >= lastWeekEnd) continue
      hoursBy.set(r.userId, (hoursBy.get(r.userId) ?? 0) + Number(r.effortHours))
    }
    const totals = [...hoursBy.values()].sort((a, b) => b - a)
    expect(totals[0]).toBeGreaterThan(37.5)
    expect(hoursBy.size).toBe(3)
    await gen.removeDemoData()
  })

  it('makes the What changed panel fire on a real run', async () => {
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-3', email: 'admin3@example.com', displayName: 'Admin Three', isAppAdmin: true }).returning()
    // detectAnomalies reads the real clock, so generate against it too.
    const result = await gen.generateDemoData({ contributorCount: 5, weeksBack: 12, includeAdmin: false, adminUserId: admin!.id })
    const { detectAnomalies } = await import('../dashboards/anomalies.js')
    const found = await detectAnomalies({ teamIds: [result.teamId], productCond: null })
    expect(found.insufficientHistory).toBe(false)
    const codes = found.anomalies.map((a) => a.code)
    expect(codes).toEqual(expect.arrayContaining(['account_burn_spike', 'contributor_logging_stopped', 'contributor_over_capacity', 'activity_type_surge']))
    await gen.removeDemoData()
  })

  it('creates a demo leader whose sign-in stays shown on Current state', async () => {
    const { verifyPassword } = await import('../auth/password.js')
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-5', email: 'admin5@example.com', displayName: 'Admin Five', isAppAdmin: true }).returning()
    const result = await gen.generateDemoData({ contributorCount: 2, weeksBack: 1, includeAdmin: false, adminUserId: admin!.id, createLeaderLogin: true })
    expect(result.leaderLogin?.email).toBe(gen.DEMO_LEADER_EMAIL)
    const [leader] = await testDb.select().from(schema.users).where(eq(schema.users.email, gen.DEMO_LEADER_EMAIL))
    expect(leader?.authMethod).toBe('password')
    // Not forced to change: Current state keeps showing this password.
    expect(leader?.mustChangePassword).toBe(false)
    expect(verifyPassword(result.leaderLogin!.password, leader!.passwordHash!)).toBe(true)
    const status = await gen.demoDataStatus()
    expect(status.leader).toEqual({ email: gen.DEMO_LEADER_EMAIL, password: result.leaderLogin!.password, passwordWorks: true })
    // Stored encrypted, never as plain text.
    const [flagRow] = await testDb.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, gen.DEMO_OUTLOOK_FLAG_KEY))
    expect(JSON.stringify(flagRow?.value)).not.toContain(result.leaderLogin!.password)
    const memberships = await testDb.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, leader!.id))
    expect(memberships).toEqual([expect.objectContaining({ teamId: result.teamId, role: 'leader' })])

    // Demo rows never reach a CRM: the write-back guard parks them.
    const { parkDemoActivitySync, DEMO_SYNC_ERROR } = await import('./ids.js')
    const [row] = await testDb.select({ id: schema.activities.id }).from(schema.activities).where(eq(schema.activities.teamId, result.teamId)).limit(1)
    expect(await parkDemoActivitySync(row!.id)).toBe(true)
    const [parked] = await testDb.select().from(schema.activities).where(eq(schema.activities.id, row!.id))
    expect(parked).toMatchObject({ crmSyncStatus: 'failed', crmSyncError: DEMO_SYNC_ERROR, crmNextRetryAt: null })

    const removed = await gen.removeDemoData()
    expect(removed.users).toBe(3)
    expect(await testDb.select().from(schema.users).where(eq(schema.users.email, gen.DEMO_LEADER_EMAIL))).toHaveLength(0)
  })

  it('adds Leads, Campaigns, nudge history and announcements', async () => {
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-6', email: 'admin6@example.com', displayName: 'Admin Six', isAppAdmin: true }).returning()
    const result = await gen.generateDemoData({ contributorCount: 4, weeksBack: 8, includeAdmin: false, adminUserId: admin!.id, createLeaderLogin: true })
    const rows = await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, result.teamId))
    expect(rows.some((r) => r.crmWhoType === 'Lead' && r.crmWhoId?.startsWith('demo-lead-'))).toBe(true)
    const campaignRows = rows.filter((r) => r.crmWhatType === 'Campaign')
    expect(campaignRows.length).toBeGreaterThan(0)
    expect(campaignRows.every((r) => r.marketingEventName === r.crmWhatName)).toBe(true)
    expect((await testDb.select().from(schema.crmLeadAccountLink)).map((l) => l.accountId).sort()).toEqual(['demo-acc-003', 'demo-acc-005'])
    const events = await testDb.select().from(schema.nudgeEvents).where(eq(schema.nudgeEvents.teamId, result.teamId))
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => !e.message.includes('{'))).toBe(true)
    expect(new Set(events.map((e) => e.triggerType)).size).toBeGreaterThan(1)
    expect((await testDb.select().from(schema.nudgeDismissals)).length).toBeGreaterThan(0)
    const notes = await testDb.select().from(schema.announcements).where(eq(schema.announcements.teamId, result.teamId))
    expect(notes.map((n) => n.targetType).sort()).toEqual(['subteam', 'team', 'team', 'user'])
    // Nothing running targets the whole team, so the admin gets no banner.
    const today = new Date().toISOString().slice(0, 10)
    expect(notes.filter((n) => n.targetType === 'team').every((n) => n.startDate > today || (n.endDate !== null && n.endDate < today))).toBe(true)

    await gen.removeDemoData()
    expect(await testDb.select().from(schema.crmLeadAccountLink)).toHaveLength(0)
    expect(await testDb.select().from(schema.nudgeEvents)).toHaveLength(0)
    expect(await testDb.select().from(schema.nudgeDismissals)).toHaveLength(0)
    expect(await testDb.select().from(schema.announcements)).toHaveLength(0)
  })

  it('speaks HubSpot when HubSpot is the CRM', async () => {
    const { setCrmProviderId } = await import('../crm/providerSetting.js')
    const { HUBSPOT_PROJECTS_OBJECT_TYPE_ID } = await import('../../../shared/hubspot.js')
    await setCrmProviderId('hubspot')
    try {
      const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-7', email: 'admin7@example.com', displayName: 'Admin Seven', isAppAdmin: true }).returning()
      const result = await gen.generateDemoData({ contributorCount: 3, weeksBack: 3, includeAdmin: false, adminUserId: admin!.id })
      const rows = await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, result.teamId))
      const stages = new Set(rows.map((r) => r.salesStage).filter(Boolean))
      expect(stages.has('Technical Validation')).toBe(false)
      expect([...stages].some((s) => ['Presentation Scheduled', 'Contract Sent', 'Closed Won', 'Closed Lost', 'Decision Maker Bought-In', 'Qualified To Buy', 'Appointment Scheduled'].includes(s!))).toBe(true)
      expect(rows.filter((r) => r.crmRelatedId).every((r) => r.crmRelatedType === HUBSPOT_PROJECTS_OBJECT_TYPE_ID)).toBe(true)
      const extras = await testDb.select().from(schema.teamActivityTypeCrmExtras)
      expect(extras.some((e) => (e.config as { sobject?: string }).sobject === HUBSPOT_PROJECTS_OBJECT_TYPE_ID)).toBe(true)
    } finally {
      await setCrmProviderId('salesforce')
    }
  })

  it('keeps the demo pipeline out of real teams\' Attach Rate', async () => {
    const { demoCoverageCondFor } = await import('./ids.js')
    const { and } = await import('drizzle-orm')
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-4', email: 'admin4@example.com', displayName: 'Admin Four', isAppAdmin: true }).returning()
    const [real] = await testDb.insert(schema.teams).values({ name: 'Real 2', slug: 'real-2' }).returning()
    await testDb.insert(schema.crmOpportunityCoverage).values({ oppId: '006000000000001AAA', oppName: 'Real Opp' })
    const result = await gen.generateDemoData({ contributorCount: 2, weeksBack: 2, includeAdmin: false, adminUserId: admin!.id })
    const col = schema.crmOpportunityCoverage.oppId
    const ids = async (scope: string[]) => (await testDb.select({ id: col }).from(schema.crmOpportunityCoverage).where(and(demoCoverageCondFor(col, scope, result.teamId)))).map((r) => r.id)
    expect(await ids([real!.id])).toEqual(['006000000000001AAA'])
    const demoOnly = await ids([result.teamId])
    expect(demoOnly.length).toBeGreaterThan(10)
    expect(demoOnly.every((id) => id.startsWith('demo-'))).toBe(true)
    await gen.removeDemoData()
    expect(await testDb.select({ id: col }).from(schema.crmOpportunityCoverage)).toEqual([{ id: '006000000000001AAA' }])
  })

  it('lays the data out in a timezone with the status mix, PTO, notes and the admin in Scheduling', async () => {
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-8', email: 'admin8@example.com', displayName: 'Admin Eight', isAppAdmin: true }).returning()
    const now = new Date('2026-10-21T20:00:00Z') // Wednesday, 16:00 in New York
    const tz = 'America/New_York'
    const result = await gen.generateDemoData({
      contributorCount: 3, weeksBack: 6, includeAdmin: true, adminUserId: admin!.id, now,
      timezone: tz, approvedPct: 70, declinedPct: 20, oooPct: 10, ptoDaysPerPerson: 2,
    })
    const people = await testDb.select().from(schema.users).where(like(schema.users.email, `%${gen.DEMO_EMAIL_SUFFIX}`))
    expect(people.every((p) => p.timezone === tz)).toBe(true)

    // Meetings start 9:30 local or later; local hour is read in the zone.
    const hourIn = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d))
    const stored = await testDb.select().from(schema.outlookEvents)
    const timed = stored.filter((e) => !e.isAllDay)
    expect(timed.length).toBeGreaterThan(0)
    expect(timed.every((e) => hourIn(e.startDatetime) >= 9 && hourIn(e.startDatetime) < 18)).toBe(true)
    expect(stored.some((e) => e.responseStatus === 'declined' && e.showAs === 'free')).toBe(true)
    expect(stored.some((e) => e.subject === 'Out of office' && e.showAs === 'oof')).toBe(true)

    // PTO rows, an all-day PTO event, and nothing logged that day.
    const pto = await testDb.select().from(schema.userPtoDays)
    expect(pto.length).toBeGreaterThanOrEqual(3 * 2)
    expect(pto.some((p) => p.date > '2026-10-21')).toBe(true)
    const acts = await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, result.teamId))
    const { localDateOf } = await import('./timezone.js')
    for (const p of pto) {
      expect(acts.some((a) => a.userId === p.userId && localDateOf(a.startDatetime, tz) === p.date)).toBe(false)
    }
    expect(stored.some((e) => e.subject === 'PTO' && pto.some((p) => p.userId === e.userId))).toBe(true)

    // Notes for the admin (My Notes "mine") and for the team.
    const notes = await testDb.select().from(schema.activityNotes)
    expect(notes.some((n) => n.createdBy === admin!.id)).toBe(true)
    expect(notes.some((n) => people.some((p) => p.id === n.createdBy))).toBe(true)
    expect((await gen.demoDataStatus()).notes).toBe(notes.length)

    // The admin is in a subteam, and their live fixture calendar follows
    // the stored settings (local working hours).
    const subteamRows = await testDb.select().from(schema.subteamUsers).where(eq(schema.subteamUsers.userId, admin!.id))
    expect(subteamRows).toHaveLength(1)
    const adminCal = await gen.demoCalendarFor(admin!.id, '2026-10-19T04:00:00Z', '2026-10-24T04:00:00Z')
    expect(adminCal!.filter((e) => !e.isAllDay).every((e) => hourIn(new Date(e.start)) >= 9)).toBe(true)
    // Demo people's live calendar matches what was stored for them.
    const person = people[0]!
    const linked = acts.filter((a) => a.userId === person.id && a.outlookEventId)
    const liveAll = await gen.demoCalendarFor(person.id, '2026-09-01T00:00:00Z', now.toISOString())
    const liveIds = new Set(liveAll!.map((e) => e.id))
    expect(linked.every((a) => liveIds.has(a.outlookEventId!))).toBe(true)
    expect(await gen.demoCalendarFor('00000000-0000-0000-0000-000000000000', '2026-10-19T00:00:00Z', '2026-10-24T00:00:00Z')).toBeNull()

    // Settings are kept for the form and for Reseed.
    expect((await gen.demoDataStatus()).settings).toMatchObject({ timezone: tz, declinedPct: 20, oooPct: 10, ptoDaysPerPerson: 2, contributorCount: 3, weeksBack: 6 })
  })

  it('gives most activities a Subtype and works the admin\'s activity names into titles', async () => {
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-10', email: 'admin10@example.com', displayName: 'Admin Ten', isAppAdmin: true }).returning()
    const names = ['Zero Trust workshop', '  zero trust WORKSHOP ', 'Quarterly architecture review', '']
    const result = await gen.generateDemoData({
      contributorCount: 3, weeksBack: 4, includeAdmin: true, adminUserId: admin!.id,
      now: new Date('2026-10-21T20:00:00Z'), activityNames: names,
    })
    const acts = await testDb.select().from(schema.activities).where(eq(schema.activities.teamId, result.teamId))
    expect(acts.length).toBeGreaterThan(20)
    const withSubtype = acts.filter((a) => a.subtypeId).length
    expect(withSubtype / acts.length).toBeGreaterThan(0.75)
    // Meeting has no default Subtypes; the demo team gets some.
    const [meeting] = await testDb.select().from(schema.teamActivityTypes)
      .where(eq(schema.teamActivityTypes.teamId, result.teamId)).then((rows) => rows.filter((r) => r.name === 'Meeting'))
    const meetingSubtypes = await testDb.select().from(schema.teamActivityTypeSubtypes).where(eq(schema.teamActivityTypeSubtypes.teamActivityTypeId, meeting!.id))
    expect(meetingSubtypes.length).toBeGreaterThan(0)

    expect(acts.some((a) => a.title.startsWith('Zero Trust workshop — '))).toBe(true)
    expect(acts.some((a) => a.title.startsWith('Quarterly architecture review — '))).toBe(true)
    const stored = await testDb.select().from(schema.outlookEvents)
    expect(stored.some((e) => / — (Acme Inc\.|BetaCo|CtrlCo|Delta Health|Echo Industries|Foxtrot Logistics|India Pharma|Golf Bank)$/.test(e.subject ?? ""))).toBe(true)
    // Cleaned and kept for Reseed; live calendars use them too.
    expect((await gen.demoDataStatus()).settings.activityNames).toEqual(['Zero Trust workshop', 'Quarterly architecture review'])
    const person = acts.find((a) => a.outlookEventId && a.title.includes('workshop'))
    if (person) {
      const live = await gen.demoCalendarFor(person.userId, '2026-09-01T00:00:00Z', '2026-10-22T00:00:00Z')
      expect(live!.some((e) => e.id === person.outlookEventId && e.subject === person.title)).toBe(true)
    }
  })

  it('reseeds from the stored settings and keeps the leader password', async () => {
    const [admin] = await testDb.insert(schema.users).values({ oktaId: 'okta-admin-9', email: 'admin9@example.com', displayName: 'Admin Nine', isAppAdmin: true }).returning()
    const first = await gen.generateDemoData({ contributorCount: 2, weeksBack: 2, includeAdmin: true, adminUserId: admin!.id, createLeaderLogin: true, timezone: 'Europe/Berlin' })
    const again = await gen.reseedDemoData({ adminUserId: admin!.id, overrides: { contributorCount: 3 } })
    expect(again.teamId).not.toBe(first.teamId)
    expect(again.usersCreated).toBe(3)
    expect(again.leaderLogin?.password).toBe(first.leaderLogin!.password)
    const status = await gen.demoDataStatus()
    expect(status.settings).toMatchObject({ contributorCount: 3, weeksBack: 2, timezone: 'Europe/Berlin', createLeaderLogin: true })
    expect(status.leader?.passwordWorks).toBe(true)
    await gen.removeDemoData()
    // Remove keeps the settings, drops the password.
    const after = await gen.demoDataStatus()
    expect(after.settings.timezone).toBe('Europe/Berlin')
    expect(after.leader).toBeNull()
    const [flagRow] = await testDb.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, gen.DEMO_OUTLOOK_FLAG_KEY))
    expect((flagRow?.value as { leaderPassword?: string | null }).leaderPassword ?? null).toBeNull()
  })
})
