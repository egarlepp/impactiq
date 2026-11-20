// v1.436.0: Communications rules with "Also send as Slack DM" on. pglite for
// email_rules; the email transport, the email integration config and the
// Slack DM are mocked.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

const sentEmails: Array<{ to: string; subject: string }> = []
const emailState = { fail: false }
vi.mock('./index.js', () => ({
  sendEmailViaConfigured: vi.fn(async (msg: { to: string; subject: string }) => {
    if (emailState.fail) throw new Error('smtp down')
    sentEmails.push({ to: msg.to, subject: msg.subject })
  }),
}))

const configState: { email: boolean } = { email: true }
vi.mock('../config/integrations.js', () => ({
  getEmailIntegrationConfig: vi.fn(() => (configState.email ? { authMethod: 'smtp' } : null)),
}))

const dms: Array<{ userId: string; heading: string; text: string; severity: string }> = []
const dmState = { ok: true }
vi.mock('../slack/dm.js', () => ({
  deliverSlackDmToUser: vi.fn(async (userId: string, msg: { heading: string; text: string; severity: string }) => {
    if (!dmState.ok) return { ok: false, reason: 'not_linked' }
    dms.push({ userId, ...msg })
    return { ok: true }
  }),
}))

let db: typeof import('../../db/index.js')['db']
let emailRules: typeof import('../../../../drizzle/schema.js')['emailRules']
let sendByRule: typeof import('./rule-sender.js')['sendByRule']
let invalidateEmailRuleCache: typeof import('./rules.js')['invalidateEmailRuleCache']

async function setRule(key: string, patch: { sendSlack?: boolean; isActive?: boolean }) {
  await db
    .insert(emailRules)
    .values({ key, name: key, isActive: patch.isActive ?? true, sendSlack: patch.sendSlack ?? false })
    .onConflictDoUpdate({ target: emailRules.key, set: { isActive: patch.isActive ?? true, sendSlack: patch.sendSlack ?? false } })
  invalidateEmailRuleCache()
}

const input = {
  to: 'pat@example.com',
  toName: 'Pat',
  defaultSubject: 'Job failed: {{jobKey}}',
  defaultBodyHtml: '<p>{{jobKey}} failed</p>',
  defaultBodyText: '{{jobKey}} failed',
  tokens: { jobKey: 'refresh_opp_snapshots' },
  userId: '00000000-0000-0000-0000-000000000001',
}

beforeAll(async () => {
  ;({ db } = await import('../../db/index.js'))
  ;({ emailRules } = await import('../../../../drizzle/schema.js'))
  ;({ sendByRule } = await import('./rule-sender.js'))
  ;({ invalidateEmailRuleCache } = await import('./rules.js'))
})

beforeEach(() => {
  sentEmails.length = 0
  dms.length = 0
  emailState.fail = false
  configState.email = true
  dmState.ok = true
})

describe('sendByRule Slack copy', () => {
  it('sends only the email when the rule has Slack off', async () => {
    await setRule('job_failure_alert', { sendSlack: false })
    const r = await sendByRule('job_failure_alert', input)
    expect(r).toMatchObject({ sent: true, emailed: true })
    expect(sentEmails).toHaveLength(1)
    expect(dms).toHaveLength(0)
  })

  it('also DMs the recipient with the interpolated subject and text', async () => {
    await setRule('job_failure_alert', { sendSlack: true })
    const r = await sendByRule('job_failure_alert', { ...input, severity: 'critical' })
    expect(r.sent).toBe(true)
    expect(sentEmails).toHaveLength(1)
    expect(dms).toEqual([{ userId: input.userId, heading: 'Job failed: refresh_opp_snapshots', text: 'refresh_opp_snapshots failed', severity: 'critical' }])
  })

  it('never DMs for a rule outside the Slack list, even with the flag set', async () => {
    await setRule('password_reset', { sendSlack: true })
    await sendByRule('password_reset', input)
    expect(dms).toHaveLength(0)
    expect(sentEmails).toHaveLength(1)
  })

  it('does not DM without a recipient user id', async () => {
    await setRule('weekly_recap', { sendSlack: true })
    const { userId: _omit, ...noUser } = input
    await sendByRule('weekly_recap', noUser)
    expect(dms).toHaveLength(0)
  })

  it('sends nothing when the rule is inactive', async () => {
    await setRule('daily_digest', { sendSlack: true, isActive: false })
    const r = await sendByRule('daily_digest', input)
    expect(r).toEqual({ sent: false, reason: 'rule_inactive' })
    expect(dms).toHaveLength(0)
    expect(sentEmails).toHaveLength(0)
  })

  it('still DMs when the email fails', async () => {
    await setRule('ai_budget_reached', { sendSlack: true })
    emailState.fail = true
    await expect(sendByRule('ai_budget_reached', input)).rejects.toThrow('smtp down')
    expect(dms).toHaveLength(1)
  })

  it('counts a DM as sent when email is not configured', async () => {
    await setRule('login_new_location', { sendSlack: true })
    configState.email = false
    const r = await sendByRule('login_new_location', input)
    expect(r).toMatchObject({ sent: true, emailed: false })
    expect(sentEmails).toHaveLength(0)
  })

  it('falls back to the email path when email is not configured and the DM is skipped', async () => {
    await setRule('login_new_location', { sendSlack: true })
    configState.email = false
    dmState.ok = false
    // The mocked transport doesn't know about config; the real one throws
    // "Email not configured" here, which callers already handle.
    const r = await sendByRule('login_new_location', input)
    expect(r.emailed).toBe(true)
    expect(r.slack).toEqual({ ok: false, reason: 'not_linked' })
  })

  it('stores send_slack on email_rules', async () => {
    await setRule('weekly_recap', { sendSlack: true })
    const [row] = await db.select().from(emailRules).where(eq(emailRules.key, 'weekly_recap'))
    expect(row?.sendSlack).toBe(true)
  })
})
