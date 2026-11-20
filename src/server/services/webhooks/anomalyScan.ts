import { and, eq } from 'drizzle-orm'
import { format, startOfWeek, subWeeks } from 'date-fns'
import { db } from '../../db/index.js'
import { eventWebhookAnomalyScans, eventWebhooks, teams } from '../../../../drizzle/schema.js'
import { detectAnomalies, type Anomaly } from '../dashboards/anomalies.js'
import { getCrmProviderId } from '../crm/providerSetting.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { emitEvent } from './events.js'
import type { CrmProviderId } from '../../../shared/crmProvider.js'

// anomaly.found (docs/event-webhooks.md): once per team per completed week,
// the same findings the leader dashboards' "What changed" panel shows, sent
// as one event per team. Runs only while an active webhook subscribes to it,
// and records each (team, week) it checked so nothing is sent twice.

export const ANOMALY_SCAN_JOB_KEY = 'anomaly_webhook_scan'
const INTERVAL_MS = 6 * 60 * 60 * 1000

// English text for each finding, matching leader.anomalies.codes.* in the
// en locale. Receivers get the code and params too, to word it themselves.
const MESSAGES: Record<string, string> = {
  account_burn_spike: '{{name}} took {{hours}}h this week, {{ratio}}× its usual {{average}}h.',
  contributor_over_capacity: '{{name}} logged {{hours}}h against a {{target}}h target ({{pct}}%).',
  contributor_logging_stopped: '{{name}} logged nothing this week after {{weeks}} straight weeks of activity.',
  activity_type_surge: '{{name}} jumped to {{hours}}h, {{ratio}}× the usual {{average}}h.',
  activity_type_collapse: '{{name}} fell {{pct}}% to {{hours}}h, against a usual {{average}}h.',
  unlinked_spike: '{{count}} of {{total}} activities ({{pct}}%) have no {{crm}} link, up from {{baselinePct}}%.',
  sync_failures: '{{count}} activities failed to sync to {{crm}} this week.',
}

const CRM_NAMES: Record<CrmProviderId, string> = { salesforce: 'Salesforce', hubspot: 'HubSpot', none: 'CRM' }

export function anomalyMessage(a: Anomaly, crmName: string): string {
  const template = MESSAGES[a.code]
  if (!template) return a.code
  const values: Record<string, string | number> = { name: a.subjectName ?? '', crm: crmName, ...a.params }
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => String(values[key] ?? ''))
}

export function lastCompletedWeekStart(now: Date = new Date()): string {
  return format(startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }), 'yyyy-MM-dd')
}

export async function scanAnomaliesForWebhooks(now: Date = new Date()): Promise<{ teamsScanned: number; eventsSent: number }> {
  const hooks = await db.select({ events: eventWebhooks.events, teamIds: eventWebhooks.teamIds })
    .from(eventWebhooks)
    .where(eq(eventWebhooks.isActive, true))
  const subscribed = hooks.filter((h) => h.events.includes('anomaly.found'))
  if (subscribed.length === 0) return { teamsScanned: 0, eventsSent: 0 }
  const everyTeam = subscribed.some((h) => h.teamIds.length === 0)
  const wanted = new Set(subscribed.flatMap((h) => h.teamIds))

  const weekStart = lastCompletedWeekStart(now)
  const activeTeams = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.isActive, true))
  const crmName = CRM_NAMES[await getCrmProviderId()]
  let teamsScanned = 0
  let eventsSent = 0
  for (const team of activeTeams) {
    if (!everyTeam && !wanted.has(team.id)) continue
    const [done] = await db.select({ teamId: eventWebhookAnomalyScans.teamId })
      .from(eventWebhookAnomalyScans)
      .where(and(eq(eventWebhookAnomalyScans.teamId, team.id), eq(eventWebhookAnomalyScans.weekStart, weekStart)))
      .limit(1)
    if (done) continue
    const result = await detectAnomalies({ teamIds: [team.id], productCond: null })
    teamsScanned += 1
    if (result.anomalies.length > 0) {
      const sent = await emitEvent('anomaly.found', {
        team: { id: team.id, name: team.name },
        week: { start: result.weekStart, end: result.weekEnd, baselineWeeks: result.baselineWeeks },
        anomalies: result.anomalies.map((a) => ({
          code: a.code,
          severity: a.severity,
          subject: { type: a.subjectType, id: a.subjectId, name: a.subjectName },
          params: a.params,
          message: anomalyMessage(a, crmName),
        })),
        notShown: result.suppressed,
      }, { teamIds: [team.id], userId: null })
      if (sent > 0) eventsSent += 1
    }
    await db.insert(eventWebhookAnomalyScans)
      .values({ teamId: team.id, weekStart, findings: result.anomalies.length })
      .onConflictDoNothing()
  }
  return { teamsScanned, eventsSent }
}

let stopFn: (() => void) | null = null

export function startAnomalyWebhookScan(): void {
  if (stopFn) return
  stopFn = scheduleJob(ANOMALY_SCAN_JOB_KEY, INTERVAL_MS, async () => {
    const startedAt = new Date()
    try {
      const { teamsScanned, eventsSent } = await scanAnomaliesForWebhooks()
      if (teamsScanned > 0) {
        await writeRun(ANOMALY_SCAN_JOB_KEY, startedAt, 'ok', `Checked ${teamsScanned} team(s), sent ${eventsSent} anomaly event(s)`, { teamsScanned, eventsSent })
      }
    } catch (err) {
      await writeRun(ANOMALY_SCAN_JOB_KEY, startedAt, 'error', err instanceof Error ? err.message : String(err), null)
    }
  })
}

export function stopAnomalyWebhookScan(): void {
  stopFn?.()
  stopFn = null
}
