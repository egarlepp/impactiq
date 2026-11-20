// Outbound event webhooks (Admin → Integrations → Event Webhooks,
// docs/event-webhooks.md). ImpactIQ POSTs a signed JSON event to each
// subscribed URL when something happens, so n8n or another automation tool
// can react: post to Teams, open a ticket, notify a channel.

export const EVENT_TYPES = [
  'activity.submitted',
  'activity.crm_sync_failed',
  'activity.outlook_deleted',
  'nudge.sent',
  'job.failed',
  'auth.suspicious_sign_in',
  'user.disabled',
  'ai.budget_reached',
  'anomaly.found',
] as const
export type EventType = typeof EVENT_TYPES[number]

// Sent only by the admin page's Send test button; nobody subscribes to it.
export const TEST_EVENT_TYPE = 'webhook.test'

// Events that belong to no team. They ignore a webhook's team filter: a
// webhook that subscribes to one gets it whatever teams it is limited to.
export const TEAMLESS_EVENT_TYPES: readonly EventType[] = ['job.failed', 'ai.budget_reached']

// Who an event is about, for a webhook's team and person filters. `teamIds`
// null means the event belongs to no team; a person event lists every team
// the person is on. `userId` null means the event is not about one person
// (job failures, the AI budget, a team's anomalies) and ignores the person filter.
export interface EventScope {
  teamIds: readonly string[] | null
  userId: string | null
}

export const EVENT_PAYLOAD_VERSION = 1

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const
export type DeliveryStatus = typeof DELIVERY_STATUSES[number]

// Minutes to wait before each retry. A delivery that still fails after the
// last one is marked failed (about 22 hours after the event).
export const DELIVERY_RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720] as const
export const MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_MINUTES.length + 1

export function retryDelayMinutes(attemptsSoFar: number): number | null {
  if (attemptsSoFar >= MAX_DELIVERY_ATTEMPTS) return null
  return DELIVERY_RETRY_MINUTES[attemptsSoFar - 1] ?? null
}

export function isEventType(v: string): v is EventType {
  return (EVENT_TYPES as readonly string[]).includes(v)
}

// Whether a webhook with these settings gets an event of this type and scope.
// The team and person filters both apply; an empty filter allows everything.
export function webhookWantsEvent(
  hook: { isActive: boolean; events: readonly string[]; teamIds: readonly string[]; userIds: readonly string[] },
  type: EventType,
  scope: EventScope,
): boolean {
  if (!hook.isActive || !hook.events.includes(type)) return false
  const teamOk = hook.teamIds.length === 0 || scope.teamIds === null || scope.teamIds.some((id) => hook.teamIds.includes(id))
  const userOk = hook.userIds.length === 0 || scope.userId === null || hook.userIds.includes(scope.userId)
  return teamOk && userOk
}
