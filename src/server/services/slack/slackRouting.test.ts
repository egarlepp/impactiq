// v1.433.0: Slack DMs for nudges and announcements, and the notification
// sweep's working-hours gate. pglite-backed; the Slack API and the team
// webhook post are mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq, and } from 'drizzle-orm'
import type { TestDb } from '../../db/testDb.js'

let testDb: TestDb
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const slackState = { configured: true }
const sentDms: Array<{ slackUserId: string; text: string }> = []
vi.mock('./client.js', () => ({
  getSlackConfigSummary: vi.fn(async () => ({ configured: slackState.configured, workspaceUrl: null })),
  sendSlackDm: vi.fn(async (slackUserId: string, text: string) => { sentDms.push({ slackUserId, text }) }),
}))

const channelPosts: Array<{ teamId: string; text: string }> = []
vi.mock('../nudge/slack.js', async () => {
  const actual = await vi.importActual<typeof import('../nudge/slack.js')>('../nudge/slack.js')
  return {
    ...actual,
    postToTeamSlackChannel: vi.fn(async (teamId: string, card: { text: string }) => {
      channelPosts.push({ teamId, text: card.text })
      return { ok: true, url: 'https://hooks.slack.com/services/x' }
    }),
    deliverSlackNudge: vi.fn(async () => ({ ok: false, url: null })),
  }
})

let schema: typeof import('../../../../drizzle/schema.js')
let sendDueAnnouncementsToSlack: typeof import('./announcements.js')['sendDueAnnouncementsToSlack']
let deliverSlackDmToUser: typeof import('./dm.js')['deliverSlackDmToUser']
let escapeSlackText: typeof import('./dm.js')['escapeSlackText']
let syncNudgeNotifications: typeof import('../nudge/sync.js')['syncNudgeNotifications']
let isWithinLocalWorkHours: typeof import('../nudge/sweep.js')['isWithinLocalWorkHours']

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  ;({ sendDueAnnouncementsToSlack } = await import('./announcements.js'))
  ;({ deliverSlackDmToUser, escapeSlackText } = await import('./dm.js'))
  ;({ syncNudgeNotifications } = await import('../nudge/sync.js'))
  ;({ isWithinLocalWorkHours } = await import('../nudge/sweep.js'))
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

beforeEach(() => {
  slackState.configured = true
  sentDms.length = 0
  channelPosts.length = 0
})

const today = () => new Date().toISOString().slice(0, 10)

async function makeTeam(webhook: string | null = null) {
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}`, slackWebhookUrl: webhook }).returning()
  return team!
}

async function makeUser(teamId: string, opts: { slackUserId?: string | null; optedOut?: boolean; disabled?: boolean } = {}) {
  const [user] = await testDb.insert(schema.users).values({
    oktaId: `okta-${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.com`,
    displayName: 'U',
    slackUserId: opts.slackUserId === undefined ? `U${crypto.randomUUID().slice(0, 8)}` : opts.slackUserId,
    disabledAt: opts.disabled ? new Date() : null,
  }).returning()
  await testDb.insert(schema.teamMembers).values({ teamId, userId: user!.id, role: 'contributor' })
  if (opts.optedOut) await testDb.insert(schema.userNotificationPrefs).values({ userId: user!.id, slackDmEnabled: false })
  return user!
}

describe('deliverSlackDmToUser', () => {
  it('skips without a bot, without a linked id, when opted out, and when disabled', async () => {
    const team = await makeTeam()
    const linked = await makeUser(team.id)
    const unlinked = await makeUser(team.id, { slackUserId: null })
    const optedOut = await makeUser(team.id, { optedOut: true })
    const disabled = await makeUser(team.id, { disabled: true })
    const msg = { heading: 'H', text: 'hello', severity: 'info' }

    expect(await deliverSlackDmToUser(unlinked.id, msg)).toEqual({ ok: false, reason: 'not_linked' })
    expect(await deliverSlackDmToUser(optedOut.id, msg)).toEqual({ ok: false, reason: 'opted_out' })
    expect(await deliverSlackDmToUser(disabled.id, msg)).toEqual({ ok: false, reason: 'disabled' })
    slackState.configured = false
    expect(await deliverSlackDmToUser(linked.id, msg)).toEqual({ ok: false, reason: 'not_configured' })
    slackState.configured = true
    expect(await deliverSlackDmToUser(linked.id, msg)).toEqual({ ok: true })
    expect(sentDms).toEqual([{ slackUserId: linked.slackUserId, text: 'H: hello' }])
  })

  it('escapes Slack control characters', () => {
    expect(escapeSlackText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })
})

describe('sendDueAnnouncementsToSlack', () => {
  it('DMs each subteam member once, then never again', async () => {
    const team = await makeTeam('https://hooks.slack.com/services/x')
    const [subteam] = await testDb.insert(schema.subteams).values({ teamId: team.id, name: 'S' }).returning()
    const a = await makeUser(team.id)
    const b = await makeUser(team.id, { optedOut: true })
    await makeUser(team.id) // on the team, not the subteam
    await testDb.insert(schema.subteamUsers).values([
      { subteamId: subteam!.id, userId: a.id, role: 'member' },
      { subteamId: subteam!.id, userId: b.id, role: 'member' },
    ])
    const [ann] = await testDb.insert(schema.announcements).values({
      teamId: team.id, targetType: 'subteam', subteamId: subteam!.id, message: 'Hi subteam', startDate: today(), sendSlack: true,
    }).returning()

    const first = await sendDueAnnouncementsToSlack()
    expect(first.announcements).toBe(1)
    expect(sentDms.map((d) => d.slackUserId)).toEqual([a.slackUserId])
    expect(channelPosts).toHaveLength(0)
    const [row] = await testDb.select().from(schema.announcements).where(eq(schema.announcements.id, ann!.id))
    expect(row!.slackSentAt).not.toBeNull()

    sentDms.length = 0
    const second = await sendDueAnnouncementsToSlack()
    expect(second.announcements).toBe(0)
    expect(sentDms).toHaveLength(0)
  })

  it('posts a team-wide announcement to the team channel instead of DMs', async () => {
    const team = await makeTeam('https://hooks.slack.com/services/x')
    await makeUser(team.id)
    await testDb.insert(schema.announcements).values({ teamId: team.id, targetType: 'team', message: 'All hands', startDate: today(), sendSlack: true })
    await sendDueAnnouncementsToSlack()
    expect(channelPosts.filter((p) => p.teamId === team.id)).toEqual([{ teamId: team.id, text: 'All hands' }])
    expect(sentDms).toHaveLength(0)
  })

  it('DMs team members when the team has no channel', async () => {
    const team = await makeTeam(null)
    const u = await makeUser(team.id)
    await testDb.insert(schema.announcements).values({ teamId: team.id, targetType: 'team', message: 'No channel', startDate: today(), sendSlack: true })
    await sendDueAnnouncementsToSlack()
    expect(sentDms.map((d) => d.slackUserId)).toEqual([u.slackUserId])
  })

  it('leaves it unclaimed when nothing could deliver it, and skips future and off ones', async () => {
    const team = await makeTeam(null)
    await makeUser(team.id)
    const [noBot] = await testDb.insert(schema.announcements).values({ teamId: team.id, targetType: 'team', message: 'Later', startDate: today(), sendSlack: true }).returning()
    const [future] = await testDb.insert(schema.announcements).values({ teamId: team.id, targetType: 'team', message: 'Future', startDate: '2999-01-01', sendSlack: true }).returning()
    const [off] = await testDb.insert(schema.announcements).values({ teamId: team.id, targetType: 'team', message: 'Off', startDate: today(), sendSlack: false }).returning()

    slackState.configured = false
    await sendDueAnnouncementsToSlack()
    const rows = await testDb.select().from(schema.announcements).where(eq(schema.announcements.teamId, team.id))
    for (const r of rows) expect(r.slackSentAt).toBeNull()
    expect(sentDms).toHaveLength(0)

    slackState.configured = true
    await sendDueAnnouncementsToSlack()
    const after = new Map((await testDb.select().from(schema.announcements).where(eq(schema.announcements.teamId, team.id))).map((r) => [r.id, r]))
    expect(after.get(noBot!.id)!.slackSentAt).not.toBeNull()
    expect(after.get(future!.id)!.slackSentAt).toBeNull()
    expect(after.get(off!.id)!.slackSentAt).toBeNull()
  })
})

describe('syncNudgeNotifications Slack DM', () => {
  it('DMs a nudge once per day for a rule with sendSlackDm on, and records it in Nudge History', async () => {
    const team = await makeTeam(null)
    const user = await makeUser(team.id)
    const [rule] = await testDb.insert(schema.nudgeRules).values({
      teamId: team.id, name: 'Nothing logged', triggerType: 'no_activity_days', triggerConfig: { days: 5 },
      messageTemplate: 'Log something', sendSlackDm: true,
    }).returning()
    await testDb.insert(schema.nudgeRuleTeams).values({ nudgeRuleId: rule!.id, teamId: team.id })

    const first = await syncNudgeNotifications(user.id, team.id)
    expect(first.delivered).toBe(1)
    expect(sentDms.map((d) => d.slackUserId)).toEqual([user.slackUserId])
    const second = await syncNudgeNotifications(user.id, team.id)
    expect(second.delivered).toBe(0)
    expect(sentDms).toHaveLength(1)

    const events = await testDb.select().from(schema.nudgeEvents)
      .where(and(eq(schema.nudgeEvents.userId, user.id), eq(schema.nudgeEvents.channel, 'slack_dm')))
    expect(events).toHaveLength(1)
  })

  it('sends no DM for a rule with sendSlackDm off', async () => {
    const team = await makeTeam(null)
    const user = await makeUser(team.id)
    const [rule] = await testDb.insert(schema.nudgeRules).values({
      teamId: team.id, name: 'Quiet', triggerType: 'no_activity_days', triggerConfig: { days: 5 }, messageTemplate: 'Log something',
    }).returning()
    await testDb.insert(schema.nudgeRuleTeams).values({ nudgeRuleId: rule!.id, teamId: team.id })
    const r = await syncNudgeNotifications(user.id, team.id)
    expect(r.delivered).toBe(1)
    expect(sentDms).toHaveLength(0)
  })
})

describe('isWithinLocalWorkHours', () => {
  // 2026-10-26 is a Monday.
  it('is true on a weekday between 08:00 and 18:00 local', () => {
    expect(isWithinLocalWorkHours('UTC', new Date('2026-10-26T08:00:00Z'))).toBe(true)
    expect(isWithinLocalWorkHours('UTC', new Date('2026-10-26T17:59:00Z'))).toBe(true)
  })
  it('is false before 08:00, from 18:00, and at weekends', () => {
    expect(isWithinLocalWorkHours('UTC', new Date('2026-10-26T07:59:00Z'))).toBe(false)
    expect(isWithinLocalWorkHours('UTC', new Date('2026-10-26T18:00:00Z'))).toBe(false)
    expect(isWithinLocalWorkHours('UTC', new Date('2026-10-24T12:00:00Z'))).toBe(false)
  })
  it('uses the user timezone', () => {
    // 16:00 UTC Monday is 09:00 in Los Angeles and 01:00 Tuesday in Tokyo.
    expect(isWithinLocalWorkHours('America/Los_Angeles', new Date('2026-10-26T16:00:00Z'))).toBe(true)
    expect(isWithinLocalWorkHours('Asia/Tokyo', new Date('2026-10-26T16:00:00Z'))).toBe(false)
  })
  it('falls back to UTC for an unknown timezone', () => {
    expect(isWithinLocalWorkHours('Not/AZone', new Date('2026-10-26T10:00:00Z'))).toBe(true)
  })
})
