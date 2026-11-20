import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { announcements, nudgeDismissals, nudgeEvents, nudgeRules, teams } from '../../../../drizzle/schema.js'

const DAY_MS = 86400_000

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// The Opportunities and Accounts the nudge messages name. Kept to the
// fixture names generator.ts links activities to, so a message reads like
// it was about the demo team's own work.
const NUDGE_OPPS = ['BetaCo Eval', 'Delta Health POC', 'Foxtrot Logistics Platform', 'CtrlCo Discovery']
const NUDGE_ACCOUNTS = ['ACME Corp', 'India Pharma', 'Golf Bank', 'Juliet Energy']

function fill(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => tokens[key] ?? whole)
}

export interface DemoNudgeHistoryInput {
  teamId: string
  people: Array<{ id: string; name: string }>
  // The person planted as "stopped logging": they get the No Activity Days
  // nudge for the weeks they logged nothing.
  stoppedUserId: string | null
  now: Date
  weeksBack: number
  rnd: () => number
}

// Nudge History for the demo team: deliveries of the team's own seeded
// rules over the generated window, worded from each rule's own template,
// plus a few snoozes so the Dismissals tab and the snooze KPIs have data.
// Everything references demo users and the demo team's rules, so it goes
// with the team (and its rules) on Remove.
export async function seedDemoNudgeHistory(input: DemoNudgeHistoryInput): Promise<{ events: number; dismissals: number }> {
  const { teamId, people, stoppedUserId, now, weeksBack, rnd } = input
  const rules = await db.select().from(nudgeRules).where(eq(nudgeRules.teamId, teamId))
  if (rules.length === 0 || people.length === 0) return { events: 0, dismissals: 0 }
  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1)
  const byTrigger = new Map(rules.map((r) => [r.triggerType, r]))
  const daysOf = (r: typeof rules[number]): number => {
    const cfg = r.triggerConfig as { days?: unknown } | null
    return typeof cfg?.days === 'number' ? cfg.days : 7
  }

  const rows: Array<typeof nudgeEvents.$inferInsert> = []
  const push = (rule: typeof rules[number] | undefined, person: { id: string; name: string }, at: Date, extra: Record<string, string>) => {
    if (!rule || at.getTime() > now.getTime()) return
    const days = String(daysOf(rule))
    rows.push({
      userId: person.id,
      teamId,
      nudgeRuleId: rule.id,
      triggerType: rule.triggerType,
      message: fill(rule.messageTemplate, {
        days,
        days_overdue: days,
        user_name: person.name,
        team_name: team?.name ?? '',
        days_since_activity: days,
        ...extra,
      }),
      channel: rnd() < 0.15 ? 'email' : 'in_app',
      deliveredAt: at,
    })
  }

  const thisWeek = new Date(now)
  thisWeek.setUTCHours(13, 0, 0, 0)
  for (let w = weeksBack - 1; w >= 0; w--) {
    const weekStart = new Date(thisWeek.getTime() - (w * 7 + ((thisWeek.getUTCDay() + 6) % 7)) * DAY_MS)
    for (const person of people) {
      const stopped = person.id === stoppedUserId && w <= 1
      if (stopped || rnd() < 0.08) {
        push(byTrigger.get('no_activity_days'), person, new Date(weekStart.getTime() + 4 * DAY_MS), {})
      }
      if (rnd() < 0.2) {
        const opp = NUDGE_OPPS[Math.floor(rnd() * NUDGE_OPPS.length)]!
        push(byTrigger.get('stage_no_type'), person, new Date(weekStart.getTime() + (1 + Math.floor(rnd() * 3)) * DAY_MS), { opp_name: opp })
      }
      if (rnd() < 0.12) {
        const account = NUDGE_ACCOUNTS[Math.floor(rnd() * NUDGE_ACCOUNTS.length)]!
        push(byTrigger.get('type_no_followup'), person, new Date(weekStart.getTime() + (1 + Math.floor(rnd() * 3)) * DAY_MS), { account_name: account })
      }
    }
  }
  if (rows.length > 0) await db.insert(nudgeEvents).values(rows)

  // Snoozes: one current (seven days), one that already ran out.
  const dismissals: Array<typeof nudgeDismissals.$inferInsert> = []
  const stageRule = byTrigger.get('stage_no_type')
  const followupRule = byTrigger.get('type_no_followup')
  if (stageRule && people[0]) {
    dismissals.push({ userId: people[0].id, nudgeRuleId: stageRule.id, dismissedAt: new Date(now.getTime() - DAY_MS), expiresAt: new Date(now.getTime() + 6 * DAY_MS) })
  }
  const second = people[2] ?? people[0]
  if (followupRule && second) {
    dismissals.push({ userId: second.id, nudgeRuleId: followupRule.id, dismissedAt: new Date(now.getTime() - 20 * DAY_MS), expiresAt: new Date(now.getTime() - 13 * DAY_MS) })
  }
  if (dismissals.length > 0) await db.insert(nudgeDismissals).values(dismissals)
  return { events: rows.length, dismissals: dismissals.length }
}

export interface DemoAnnouncementsInput {
  teamId: string
  adminUserId: string
  now: Date
  subteamId: string | null
  leaderUserId: string | null
  // The evaluation Activity Type's name (Admin → Workplace → Terminology).
  evalWork: string
}

// Announcements in each state the admin list shows: running, scheduled and
// ended. The running ones target a demo subteam and the demo leader, never
// the whole team, so the generating admin (a demo team member) doesn't get
// a banner of their own.
export async function seedDemoAnnouncements(input: DemoAnnouncementsInput): Promise<number> {
  const { teamId, adminUserId, now, subteamId, leaderUserId } = input
  const rows: Array<typeof announcements.$inferInsert> = []
  const base = { teamId, createdBy: adminUserId, createdAt: now, updatedAt: now }
  if (subteamId) {
    rows.push({
      ...base,
      targetType: 'subteam',
      subteamId,
      message: `Quarter-end push: log ${input.evalWork} against its Project so Project costing is complete.`,
      severity: 'warning',
      icon: 'Megaphone',
      startDate: isoDate(new Date(now.getTime() - 3 * DAY_MS)),
      endDate: isoDate(new Date(now.getTime() + 10 * DAY_MS)),
    })
  }
  if (leaderUserId) {
    rows.push({
      ...base,
      targetType: 'user',
      targetUserId: leaderUserId,
      message: 'Welcome to the ImpactIQ demo. Open Dashboard to see the team\'s capacity, activity mix and what changed last week.',
      severity: 'info',
      icon: 'Sparkles',
      startDate: isoDate(now),
      endDate: isoDate(new Date(now.getTime() + 30 * DAY_MS)),
    })
  }
  rows.push({
    ...base,
    targetType: 'team',
    message: 'Holiday week: capacity targets drop to 24 hours for the week.',
    severity: 'info',
    icon: 'CalendarDays',
    startDate: isoDate(new Date(now.getTime() + 7 * DAY_MS)),
    endDate: isoDate(new Date(now.getTime() + 14 * DAY_MS)),
  })
  rows.push({
    ...base,
    targetType: 'team',
    message: 'New Activity Types guide is live. Check it before logging your next Discovery.',
    severity: 'info',
    icon: 'BookOpen',
    startDate: isoDate(new Date(now.getTime() - 30 * DAY_MS)),
    endDate: isoDate(new Date(now.getTime() - 10 * DAY_MS)),
  })
  await db.insert(announcements).values(rows)
  return rows.length
}
