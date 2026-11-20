import { db } from '../../db/index.js'
import { notifications, teamMembers, users, nudgeEvents } from '../../../../drizzle/schema.js'
import { eq, sql } from 'drizzle-orm'
import { evaluateNudges } from './engine.js'
import { deliverSlackNudge } from './slack.js'
import { deliverSlackDmToUser } from '../slack/dm.js'
import { emitNudgeSent } from '../webhooks/events.js'

// v1.433.0: moved here from routes/notifications.ts so the scheduled
// notification_sweep job (services/nudge/sweep.ts) runs the exact same
// evaluate → bell row → deliver path as the bell's own poll. The per-day
// dedupe below is what keeps the two from delivering a nudge twice.
//
// Returns `delivered`: how many nudges were newly inserted (and so sent out)
// this call, which the sweep uses to decide whether its run is worth a
// job_runs row.
// Pulls latest nudges for the user's accessible teams and upserts them as
// notifications. Dedupe on (user_id, dedupe_key) keeps repeat polling cheap.
// When teamId is null (user has "All Teams" selected), iterate every team
// the user belongs to so nudges from every team surface in the bell.
export async function syncNudgeNotifications(userId: string, teamId: string | null): Promise<{ ok: number; failed: number; delivered: number }> {
  let teamIds: string[]
  if (teamId) {
    teamIds = [teamId]
  } else {
    const memberships = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
    teamIds = memberships.map((m) => m.teamId)
  }
  let ok = 0
  let failed = 0
  let delivered = 0
  for (const tid of teamIds) {
    try {
      const nudges = await evaluateNudges(userId, tid)
      for (const n of nudges) {
        const dedupeKey = `nudge:${n.ruleId}:${new Date().toISOString().slice(0, 10)}`
        // dedupeKey is per-day, so a genuinely new day always inserts a fresh
        // (unread) row and re-alerts. Within the same day we do NOT reset
        // isRead on conflict — otherwise every poll flipped a nudge the user
        // just read back to unread, so it kept re-appearing in the bell and the
        // bottom toast when navigating. We still refresh the message/severity/
        // icon in case the rule copy changed.
        const [upserted] = await db
          .insert(notifications)
          .values({
            userId,
            teamId: tid,
            kind: 'nudge',
            message: n.message,
            dedupeKey,
            isRead: false,
            severity: n.severity,
            icon: n.icon,
          })
          .onConflictDoUpdate({
            // The arbiter is the PARTIAL unique index notifications_dedupe_idx
            // (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL. Postgres only
            // accepts a partial index as an ON CONFLICT target when the same
            // predicate is repeated, so targetWhere is required — without it the
            // insert throws 42P10 and the whole per-team nudge sync fails.
            target: [notifications.userId, notifications.dedupeKey],
            targetWhere: sql`dedupe_key IS NOT NULL`,
            set: { message: n.message, severity: n.severity, icon: n.icon },
          })
          // `xmax = 0` is true only for a freshly INSERTED row; on the
          // conflict-update path (same rule, same day) it's non-zero. We
          // re-alert the bell on every poll (isRead reset above) but must
          // only DELIVER + AUDIT once per rule per day — otherwise every
          // /api/notifications poll would re-send Slack/email and write a
          // duplicate Nudge History row.
          .returning({ inserted: sql<boolean>`(xmax = 0)` })
        if (upserted?.inserted) {
          delivered += 1
          // Best-effort audit log — one in-app delivery row per rule/day.
          // Failures here don't fail the sync.
          try {
            await db.insert(nudgeEvents).values({
              userId,
              teamId: tid,
              nudgeRuleId: n.ruleId,
              triggerType: n.triggerType,
              message: n.message,
              channel: 'in_app',
            })
          } catch (auditErr) {
            console.warn('[nudge-audit] insert failed:', auditErr instanceof Error ? auditErr.message : String(auditErr))
          }
          void emitNudgeSent({ userId, teamId: tid, ruleId: n.ruleId, triggerType: n.triggerType, message: n.message, severity: n.severity })
          // Slack delivery is fire-and-forget. Only audit-log the row when
          // the POST actually succeeded so the History page reflects
          // reality — a 404/expired webhook shouldn't look like a
          // successful Slack delivery.
          const slack = await deliverSlackNudge({
            teamId: tid,
            userId,
            message: n.message,
            severity: n.severity,
            icon: n.icon,
          })
          // v1.112.0: per-rule "Also send by email" delivery. Best-effort
          // — email failures never break the sync + audit chain.
          if (n.sendEmail) {
            try {
              const [u] = await db.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
              if (u?.email) {
                const { sendByRule } = await import('../email/rule-sender.js')
                const defaultSubject = `ImpactIQ nudge: ${n.message.slice(0, 80)}`
                const defaultBodyHtml = `<p style="margin:0 0 12px 0;">${n.message.replace(/</g, '&lt;')}</p>`
                const result = await sendByRule('nudge_email', {
                  to: u.email,
                  toName: u.displayName ?? undefined,
                  defaultSubject,
                  defaultBodyHtml,
                  defaultBodyText: n.message,
                  tokens: { name: u.displayName ?? '', message: n.message },
                })
                if (result.sent) {
                  try {
                    await db.insert(nudgeEvents).values({ userId, teamId: tid, nudgeRuleId: n.ruleId, triggerType: n.triggerType, message: n.message, channel: 'email' })
                  } catch (auditErr) {
                    console.warn('[nudge-audit-email] insert failed:', auditErr instanceof Error ? auditErr.message : String(auditErr))
                  }
                }
              }
            } catch (emailErr) {
              console.warn('[nudge-email] send failed:', emailErr instanceof Error ? emailErr.message : String(emailErr))
            }
          }
          // v1.433.0: per-rule "Also send as a Slack DM". Best-effort like
          // email; only a sent DM gets a Nudge History row.
          if (n.sendSlackDm) {
            const dm = await deliverSlackDmToUser(userId, { heading: 'ImpactIQ nudge', text: n.message, severity: n.severity })
            if (dm.ok) {
              try {
                await db.insert(nudgeEvents).values({ userId, teamId: tid, nudgeRuleId: n.ruleId, triggerType: n.triggerType, message: n.message, channel: 'slack_dm' })
              } catch (auditErr) {
                console.warn('[nudge-audit-slack-dm] insert failed:', auditErr instanceof Error ? auditErr.message : String(auditErr))
              }
            }
          }
          if (slack.ok) {
            try {
              await db.insert(nudgeEvents).values({
                userId,
                teamId: tid,
                nudgeRuleId: n.ruleId,
                triggerType: n.triggerType,
                message: n.message,
                channel: 'slack',
              })
            } catch (auditErr) {
              console.warn('[nudge-audit-slack] insert failed:', auditErr instanceof Error ? auditErr.message : String(auditErr))
            }
          }
        }
      }
      ok += 1
    } catch (err) {
      failed += 1
      // eslint-disable-next-line no-console
      console.warn('[nudge-sync] failed for team', tid, err instanceof Error ? err.message : err)
    }
  }
  return { ok, failed, delivered }
}

