import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activities,
  eventWebhookDeliveries,
  eventWebhooks,
  nudgeRules,
  teamActivityTypes,
  teamMembers,
  teams,
  users,
} from '../../../../drizzle/schema.js'
import { getPublicBaseUrl } from '../config/integrations.js'
import {
  EVENT_PAYLOAD_VERSION,
  TEAMLESS_EVENT_TYPES,
  webhookWantsEvent,
  type EventScope,
  type EventType,
} from '../../../shared/eventWebhooks.js'

// Queues an event for every active webhook subscribed to it
// (docs/event-webhooks.md). Only inserts delivery rows; the
// event_webhook_worker job sends them, with retries. Never throws, so the
// action that raised the event can't fail because of a webhook.

export interface EventPayload {
  id: string
  type: string
  version: number
  createdAt: string
  data: Record<string, unknown>
}

export function buildEventPayload(type: string, data: Record<string, unknown>, now: Date = new Date()): EventPayload {
  return { id: randomUUID(), type, version: EVENT_PAYLOAD_VERSION, createdAt: now.toISOString(), data }
}

export async function emitEvent(type: EventType, data: Record<string, unknown>, scope: EventScope): Promise<number> {
  try {
    const hooks = await db
      .select({ id: eventWebhooks.id, isActive: eventWebhooks.isActive, events: eventWebhooks.events, teamIds: eventWebhooks.teamIds, userIds: eventWebhooks.userIds })
      .from(eventWebhooks)
      .where(eq(eventWebhooks.isActive, true))
    const effective: EventScope = TEAMLESS_EVENT_TYPES.includes(type) ? { ...scope, teamIds: null } : scope
    const targets = hooks.filter((h) => webhookWantsEvent(h, type, effective))
    if (targets.length === 0) return 0
    const payload = buildEventPayload(type, data)
    await db.insert(eventWebhookDeliveries).values(targets.map((h) => ({
      webhookId: h.id,
      eventId: payload.id,
      eventType: type,
      payload,
    })))
    return targets.length
  } catch (err) {
    console.warn(`[event-webhooks] could not queue ${type}:`, err instanceof Error ? err.message : String(err))
    return 0
  }
}

// The activity part of an activity.* event. A private meeting's title is
// left out, as it is everywhere else in the app (CLAUDE.md §7).
export async function activityEventData(activityId: string): Promise<{ teamId: string; userId: string; data: Record<string, unknown> } | null> {
  const [row] = await db
    .select({
      a: activities,
      typeName: teamActivityTypes.name,
      teamName: teams.name,
      userEmail: users.email,
      userName: users.displayName,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.userId))
    .innerJoin(teams, eq(teams.id, activities.teamId))
    .leftJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .where(eq(activities.id, activityId))
    .limit(1)
  if (!row) return null
  const a = row.a
  const base = await getPublicBaseUrl()
  const day = a.startDatetime.toISOString().slice(0, 10)
  return {
    teamId: a.teamId,
    userId: a.userId,
    data: {
      activity: {
        id: a.id,
        title: a.isPrivateMeeting ? null : a.title,
        isPrivateMeeting: a.isPrivateMeeting,
        status: a.status,
        type: a.activityTypeId ? { id: a.activityTypeId, name: row.typeName } : null,
        subtype: a.subtypeName,
        start: a.startDatetime.toISOString(),
        end: a.endDatetime.toISOString(),
        effortHours: Number(a.effortHours),
        submittedAt: a.submittedAt?.toISOString() ?? null,
        url: base ? `${base}/?openActivityId=${encodeURIComponent(a.id)}&startDate=${day}` : null,
      },
      user: { id: a.userId, email: row.userEmail, displayName: row.userName },
      team: { id: a.teamId, name: row.teamName },
      crm: {
        whatType: a.crmWhatType,
        whatId: a.crmWhatId,
        whatName: a.crmWhatName,
        accountId: a.crmAccountId,
        accountName: a.crmAccountName,
        recordId: a.crmRecordId,
        syncStatus: a.crmSyncStatus,
        syncError: a.crmSyncError,
        syncAttempts: a.crmSyncAttempts,
      },
      outlook: {
        deletedAt: a.outlookDeletedAt?.toISOString() ?? null,
      },
    },
  }
}

export async function emitActivityEvent(type: Extract<EventType, `activity.${string}`>, activityId: string): Promise<void> {
  try {
    const built = await activityEventData(activityId)
    if (!built) return
    await emitEvent(type, built.data, { teamIds: [built.teamId], userId: built.userId })
  } catch (err) {
    console.warn(`[event-webhooks] could not build ${type}:`, err instanceof Error ? err.message : String(err))
  }
}

export async function emitNudgeSent(input: {
  userId: string
  teamId: string
  ruleId: string
  triggerType: string
  message: string
  severity: string
}): Promise<void> {
  try {
    const [row] = await db
      .select({ email: users.email, displayName: users.displayName, teamName: teams.name })
      .from(users)
      .innerJoin(teams, eq(teams.id, input.teamId))
      .where(eq(users.id, input.userId))
      .limit(1)
    const [rule] = await db.select({ name: nudgeRules.name }).from(nudgeRules)
      .where(and(eq(nudgeRules.id, input.ruleId)))
      .limit(1)
    await emitEvent('nudge.sent', {
      nudge: {
        ruleId: input.ruleId,
        ruleName: rule?.name ?? null,
        triggerType: input.triggerType,
        message: input.message,
        severity: input.severity,
      },
      user: { id: input.userId, email: row?.email ?? null, displayName: row?.displayName ?? null },
      team: { id: input.teamId, name: row?.teamName ?? null },
    }, { teamIds: [input.teamId], userId: input.userId })
  } catch (err) {
    console.warn('[event-webhooks] could not build nudge.sent:', err instanceof Error ? err.message : String(err))
  }
}

// A person and every team they are on, for events about one person.
async function personScope(userId: string): Promise<{ person: { id: string; email: string | null; displayName: string | null } | null; scope: EventScope }> {
  const [u] = await db.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
  const memberships = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId))
  return {
    person: u ? { id: userId, email: u.email ?? null, displayName: u.displayName ?? null } : null,
    scope: { teamIds: memberships.map((m) => m.teamId), userId },
  }
}

// A sign-in from an IP not seen for this person in the last 90 days (the same
// check that sends them the "new sign-in" email). `firstSignIn` marks their
// first sign-in ever, which is always flagged.
export async function emitSuspiciousSignIn(input: {
  userId: string
  method: string
  ip: string | null
  userAgent: string | null
  at: Date
  firstSignIn: boolean
}): Promise<void> {
  try {
    const { person, scope } = await personScope(input.userId)
    await emitEvent('auth.suspicious_sign_in', {
      user: person ?? { id: input.userId, email: null, displayName: null },
      signIn: {
        method: input.method,
        ip: input.ip,
        userAgent: input.userAgent,
        at: input.at.toISOString(),
        firstSignIn: input.firstSignIn,
      },
    }, scope)
  } catch (err) {
    console.warn('[event-webhooks] could not build auth.suspicious_sign_in:', err instanceof Error ? err.message : String(err))
  }
}

export async function emitUserDisabled(input: {
  userId: string
  actorId: string
  sessionsRevoked: number
  apiKeysRevoked: number
}): Promise<void> {
  try {
    const { person, scope } = await personScope(input.userId)
    const actor = await personScope(input.actorId)
    await emitEvent('user.disabled', {
      user: person ?? { id: input.userId, email: null, displayName: null },
      disabledBy: actor.person,
      sessionsRevoked: input.sessionsRevoked,
      apiKeysRevoked: input.apiKeysRevoked,
      at: new Date().toISOString(),
    }, scope)
  } catch (err) {
    console.warn('[event-webhooks] could not build user.disabled:', err instanceof Error ? err.message : String(err))
  }
}

// Sent once a month, the first time AI requests reach the monthly budget
// (the same moment App Admins get the budget email).
export async function emitAiBudgetReached(input: { month: string; budgetUsd: number; spentUsd: number }): Promise<void> {
  await emitEvent('ai.budget_reached', {
    ai: {
      month: input.month,
      budgetUsd: Math.round(input.budgetUsd * 100) / 100,
      spentUsd: Math.round(input.spentUsd * 100) / 100,
    },
  }, { teamIds: null, userId: null })
}
