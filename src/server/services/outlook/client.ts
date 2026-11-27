import { db } from '../../db/index.js'
import { userIntegrations, users } from '../../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import { decryptToken, encryptToken } from '../auth/salesforce.js'
import { refreshAccessToken } from '../auth/microsoft.js'
import { getMsIntegrationConfig } from '../config/integrations.js'
import { normalizeTimeZone } from '../../../shared/windowsTimezones.js'
import { CLEARED_USER_INTEGRATION_ERROR, markUserIntegrationFailed, recordIntegrationCall } from '../health/integrationStatus.js'
import { microsoftIdentityUrl } from '../auth/microsoftIdentity.js'

// Refresh the user's stored timezone from Graph mailboxSettings if it's been
// more than TZ_REFRESH_INTERVAL_MS since the last check, or has never been
// checked. Non-fatal — swallowed on any failure so calendar polls never break
// because of a mailboxSettings hiccup.
// v1.469.0: the mailbox timezone is always kept in outlook_timezone, but only
// becomes the app timezone while timezone_source is 'auto'; a timezone the
// user picked (CRM or manual) is never overwritten here.
// v1.471.1: Graph usually answers with a Windows name ("Pacific Standard
// Time"); it is stored as its IANA id, and a name Intl can't use is ignored.
const TZ_REFRESH_INTERVAL_MS = 60 * 60 * 1000  // 1 hour

async function maybeRefreshUserTimezone(userId: string, accessToken: string): Promise<void> {
  try {
    const [row] = await db
      .select({ tz: users.timezone, source: users.timezoneSource, outlookTz: users.outlookTimezone, checked: users.timezoneCheckedAt })
      .from(users).where(eq(users.id, userId)).limit(1)
    if (row?.checked && Date.now() - row.checked.getTime() < TZ_REFRESH_INTERVAL_MS) return
    const mbRes = await fetch('https://graph.microsoft.com/v1.0/me/mailboxSettings', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!mbRes.ok) return
    const mb = await mbRes.json() as { timeZone?: string }
    const tz = normalizeTimeZone(mb.timeZone)
    const patch: Record<string, unknown> = { timezoneCheckedAt: new Date() }
    if (tz && tz !== row?.outlookTz) patch['outlookTimezone'] = tz
    if (tz && row?.source === 'auto' && tz !== row.tz) patch['timezone'] = tz
    await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, userId))
  } catch {
    // Non-fatal
  }
}

const REFRESH_SKEW_MS = 60 * 1000

export async function getMicrosoftAccessToken(userId: string): Promise<string | null> {
  return getAccessToken(userId)
}

async function getAccessToken(userId: string): Promise<string | null> {
  const [integration] = await db
    .select()
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'microsoft')))
    .limit(1)

  if (!integration?.accessTokenEncrypted) return null

  const expiresAt = integration.expiresAt?.getTime() ?? null
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() < REFRESH_SKEW_MS

  if (needsRefresh && integration.refreshTokenEncrypted) {
    const refreshToken = decryptToken(integration.refreshTokenEncrypted)
    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>
    try {
      refreshed = await refreshAccessToken(refreshToken)
    } catch (err) {
      // App Health counts this user as needing to reconnect Outlook.
      await markUserIntegrationFailed(integration.id, err)
      recordIntegrationCall('microsoft', false, err)
      throw err
    }
    recordIntegrationCall('microsoft', true)
    const newAccess = encryptToken(refreshed.access_token)
    const newRefresh = refreshed.refresh_token ? encryptToken(refreshed.refresh_token) : integration.refreshTokenEncrypted
    const newExpiry = new Date(Date.now() + (refreshed.expires_in - 60) * 1000)

    await db
      .update(userIntegrations)
      .set({
        ...CLEARED_USER_INTEGRATION_ERROR,
        accessTokenEncrypted: newAccess,
        refreshTokenEncrypted: newRefresh,
        expiresAt: newExpiry,
        updatedAt: new Date(),
      })
      .where(eq(userIntegrations.id, integration.id))

    return refreshed.access_token
  }

  return decryptToken(integration.accessTokenEncrypted)
}

export interface GraphAttendee { name: string; email: string; response: string; type: string }

export interface GraphCalendarEvent {
  id: string
  subject: string
  start: string
  end: string
  isAllDay: boolean
  bodyPreview: string
  location?: string
  attendees?: GraphAttendee[]
  organizer?: { name: string; email: string }
  eventType?: string
  seriesMasterId?: string
  // v1.225.0: free/busy signal for calendar-derived capacity. Graph values:
  // free/tentative/busy/oof/workingElsewhere/unknown.
  showAs?: string
  isCancelled?: boolean
  // The CALLER's own response: organizer/none/tentativelyAccepted/accepted/declined/notResponded.
  responseStatus?: string
  // v1.262.0: Graph values normal/personal/private/confidential — the
  // organizer's own privacy marking on the event, set in Outlook. 'private'
  // and 'confidential' both drive ImpactIQ's Private Meeting treatment (see
  // CLAUDE.md §7 Private Meetings). Note this is orthogonal to any access
  // boundary Graph itself enforces — for a delegated fetch of the token
  // owner's OWN calendar, Graph returns full details regardless of
  // sensitivity; it's purely a signal the calling code has to act on.
  sensitivity?: string
}

interface GraphAttendeeRaw {
  emailAddress?: { name?: string; address?: string }
  status?: { response?: string }
  type?: string
}

interface GraphEventRaw {
  id: string
  subject?: string
  bodyPreview?: string
  isAllDay?: boolean
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  location?: { displayName?: string }
  attendees?: GraphAttendeeRaw[]
  organizer?: { emailAddress?: { name?: string; address?: string } }
  type?: string
  seriesMasterId?: string
  showAs?: string
  isCancelled?: boolean
  responseStatus?: { response?: string }
  sensitivity?: string
}

interface GraphCalendarViewResponse {
  value: GraphEventRaw[]
  '@odata.nextLink'?: string
}

export async function fetchCalendarEvents(
  userId: string,
  startIso: string,
  endIso: string,
): Promise<GraphCalendarEvent[] | null> {
  const accessToken = await getAccessToken(userId)
  if (!accessToken) return null

  // Opportunistically re-pull the user's timezone from Outlook so a change in
  // Outlook (e.g. moved offices) propagates without them re-connecting. Rate
  // limited to once per hour per user by maybeRefreshUserTimezone.
  void maybeRefreshUserTimezone(userId, accessToken)

  const params = new URLSearchParams({
    startDateTime: startIso,
    endDateTime: endIso,
    '$top': '100',
    '$orderby': 'start/dateTime',
    '$select': 'id,subject,bodyPreview,isAllDay,start,end,location,attendees,organizer,type,seriesMasterId,showAs,isCancelled,responseStatus,sensitivity',
  })

  // Follow @odata.nextLink so a busy window (>100 events) returns ALL events,
  // not just the first page. This matters because the calendar sync deletes
  // cached events the pull didn't return — a truncated page would wrongly
  // remove real events from the cache.
  let url: string | null = `https://graph.microsoft.com/v1.0/me/calendarView?${params.toString()}`
  const all: GraphEventRaw[] = []
  let guard = 0
  while (url && guard < 50) {
    guard++
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Graph calendarView failed (${res.status}): ${text}`)
    }
    const page = (await res.json()) as GraphCalendarViewResponse
    all.push(...page.value)
    url = page['@odata.nextLink'] ?? null
  }

  return mapGraphEvents({ value: all })
}

function mapGraphEvents(body: GraphCalendarViewResponse): GraphCalendarEvent[] {
  return body.value.map((e) => {
    const event: GraphCalendarEvent = {
      id: e.id,
      subject: e.subject ?? '(No subject)',
      start: new Date(e.start.dateTime + 'Z').toISOString(),
      end: new Date(e.end.dateTime + 'Z').toISOString(),
      isAllDay: e.isAllDay ?? false,
      bodyPreview: e.bodyPreview ?? '',
    }
    if (e.location?.displayName) event.location = e.location.displayName
    if (Array.isArray(e.attendees) && e.attendees.length > 0) {
      event.attendees = e.attendees.map((a) => ({
        name: a.emailAddress?.name ?? '',
        email: a.emailAddress?.address ?? '',
        response: a.status?.response ?? 'none',
        type: a.type ?? 'required',
      }))
    }
    if (e.organizer?.emailAddress) {
      event.organizer = {
        name: e.organizer.emailAddress.name ?? '',
        email: e.organizer.emailAddress.address ?? '',
      }
    }
    if (e.type) event.eventType = e.type
    if (e.seriesMasterId) event.seriesMasterId = e.seriesMasterId
    if (e.showAs) event.showAs = e.showAs
    if (e.isCancelled !== undefined) event.isCancelled = e.isCancelled
    if (e.responseStatus?.response) event.responseStatus = e.responseStatus.response
    if (e.sensitivity) event.sensitivity = e.sensitivity
    return event
  })
}

// Fetches a client-credentials (application) token for the shared MS Graph
// tenant. Requires the Azure app registration to have `Calendars.Read`
// APPLICATION permission and admin-consent granted — see
// docs/outlook-app-only.md. Returns null if MS config is missing.
async function getAppOnlyAccessToken(): Promise<string | null> {
  const cfg = getMsIntegrationConfig()
  if (!cfg) return null
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  })
  let res: Response
  try {
    res = await fetch(microsoftIdentityUrl(cfg.tenantId, '/oauth2/v2.0/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (err) {
    recordIntegrationCall('microsoft', false, err)
    throw err
  }
  if (!res.ok) {
    const text = await res.text()
    const err = new Error(`App-only token fetch failed (${res.status}): ${text}`)
    recordIntegrationCall('microsoft', false, err)
    throw err
  }
  recordIntegrationCall('microsoft', true)
  const json = (await res.json()) as { access_token: string }
  return json.access_token
}

// v1.156.0: Outlook calendar WRITE-BACK (per-user delegated token).
// Thrown when the user's granted token lacks Calendars.ReadWrite (they
// connected before the scope upgrade). Callers surface a reconnect prompt.
export class OutlookScopeError extends Error {
  constructor() { super('errors.outlook.reconnect_needed') }
}

export interface WritebackEventInput {
  subject: string
  bodyHtml: string
  startIso: string
  endIso: string
  timeZone: string
  // v1.161.0: real Required attendees to set on the event. Graph emails an
  // invite to each, so the caller only puts INTERNAL recipients here; external
  // attendees stay in the body text.
  attendees?: Array<{ name?: string; email: string }>
}

// Graph wants a naive local wall-clock string + a separate timeZone. We render
// the instant in the user's OWN timezone (IANA, e.g. America/New_York) so the
// event opens in Outlook showing the user's zone — not "Coordinated Universal
// Time". Graph accepts IANA zone names for the start/end timeZone field.
function toGraphDateTime(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  return `${m['year']}-${m['month']}-${m['day']}T${m['hour']}:${m['minute']}:${m['second']}`
}

function graphEventBody(input: WritebackEventInput): Record<string, unknown> {
  const tz = input.timeZone && input.timeZone.length > 0 ? input.timeZone : 'UTC'
  const body: Record<string, unknown> = {
    subject: input.subject,
    body: { contentType: 'HTML', content: input.bodyHtml },
    start: { dateTime: toGraphDateTime(input.startIso, tz), timeZone: tz },
    end: { dateTime: toGraphDateTime(input.endIso, tz), timeZone: tz },
    categories: ['ImpactIQ'],
  }
  if (input.attendees && input.attendees.length > 0) {
    body['attendees'] = input.attendees.map((a) => ({
      emailAddress: { address: a.email, name: a.name ?? a.email },
      type: 'required',
    }))
  }
  return body
}

async function graphWrite(userId: string, method: 'POST' | 'PATCH', url: string, body: unknown): Promise<GraphEventRaw | null> {
  const accessToken = await getAccessToken(userId)
  if (!accessToken) return null // not connected
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 403) throw new OutlookScopeError()
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph ${method} event failed (${res.status}): ${text}`)
  }
  return (await res.json()) as GraphEventRaw
}

// Create an event on the user's own calendar. Returns the new Graph event id,
// or null when the user isn't connected.
export async function createCalendarEvent(userId: string, input: WritebackEventInput): Promise<string | null> {
  const created = await graphWrite(userId, 'POST', 'https://graph.microsoft.com/v1.0/me/events', graphEventBody(input))
  return created?.id ?? null
}

// Update a previously-created event in place (keeps one calendar entry when the
// activity is edited). Returns the event id, or null when not connected.
export async function updateCalendarEvent(userId: string, eventId: string, input: WritebackEventInput): Promise<string | null> {
  const updated = await graphWrite(userId, 'PATCH', `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, graphEventBody(input))
  return updated?.id ?? eventId
}

// Delete an event we created on the user's own calendar. Best-effort: a 404
// (already gone) is treated as success. Returns false when not connected.
export async function deleteCalendarEvent(userId: string, eventId: string): Promise<boolean> {
  const accessToken = await getAccessToken(userId)
  if (!accessToken) return false
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 403) throw new OutlookScopeError()
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`Graph DELETE event failed (${res.status}): ${text}`)
  }
  return true
}

// v1.244.0: stamp the ImpactIQ category on an event that ALREADY EXISTS on the
// user's calendar — a meeting they were invited to and then logged, as opposed
// to one ImpactIQ created itself.
//
// Until now the category was only ever set in graphEventBody(), i.e. on the
// CREATE path, so it only ever landed on ImpactIQ-authored events. An approved
// activity that came from someone else's meeting invite was never categorized,
// because the whole write-back path is skipped for those (writing would
// duplicate the meeting).
//
// Reads the current categories first and MERGES, rather than overwriting:
// `categories` is a single mailbox-local list, and a blind PATCH would silently
// wipe whatever colour-coding the user already had on that meeting.
//
// Safe on meetings organized by other people. In Graph, `categories` is a
// per-mailbox property — patching it touches only the caller's own copy and
// sends no update to the organizer or attendees.
//
// Returns true when the category is present afterwards (including when it was
// already there and nothing needed doing), false when not connected.
export const IMPACTIQ_CATEGORY = 'ImpactIQ'

export async function ensureEventCategorized(userId: string, eventId: string): Promise<boolean> {
  const accessToken = await getAccessToken(userId)
  if (!accessToken) return false
  const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`

  const readRes = await fetch(`${url}?$select=id,categories`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (readRes.status === 403) throw new OutlookScopeError()
  // Gone from the calendar — nothing to categorize, and not an error worth
  // retrying. The deleted-activity review queue handles that case separately.
  if (readRes.status === 404) return false
  if (!readRes.ok) {
    const text = await readRes.text()
    throw new Error(`Graph GET event failed (${readRes.status}): ${text}`)
  }
  const current = (await readRes.json()) as { categories?: string[] }
  const existing = Array.isArray(current.categories) ? current.categories : []
  // Case-insensitive check so we don't add a second near-duplicate entry if the
  // category was created with different casing in the mailbox.
  if (existing.some((c) => c.toLowerCase() === IMPACTIQ_CATEGORY.toLowerCase())) return true

  await graphWrite(userId, 'PATCH', url, { categories: [...existing, IMPACTIQ_CATEGORY] })
  return true
}

// v1.336.0: the title-write-back counterpart to ensureEventCategorized()
// above, for an activity linked to an EXISTING meeting the user did not
// organize. Reported behavior: editing a meeting's title/subject directly
// in Outlook as a non-organizer DOES save — but only on that user's own
// calendar (confirmed by live testing against a real tenant, not assumed) —
// the same mailbox-local-write shape Graph's `categories` property already
// has. So a PATCH of `subject` here carries the identical safety contract
// ensureEventCategorized() already relies on: it touches only the caller's
// own copy of the event and sends no update to the organizer or other
// attendees, whether or not the caller organized it.
//
// GETs the current subject first and skips the write when it already
// matches — every one of the three call sites (create/update/resync) calls
// this unconditionally on every submitted-activity write, so without this
// check an unchanged title would still cost a Graph PATCH every time.
//
// Deliberately a separate GET from ensureEventCategorized()'s own read
// (an extra round trip) rather than merged into one — each Graph operation
// here stays a small, independently callable, independently testable unit,
// matching this file's existing one-concern-per-function shape.
export async function ensureEventTitleSynced(userId: string, eventId: string, subject: string): Promise<boolean> {
  const accessToken = await getAccessToken(userId)
  if (!accessToken) return false
  const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`

  const readRes = await fetch(`${url}?$select=id,subject`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (readRes.status === 403) throw new OutlookScopeError()
  if (readRes.status === 404) return false
  if (!readRes.ok) {
    const text = await readRes.text()
    throw new Error(`Graph GET event failed (${readRes.status}): ${text}`)
  }
  const current = (await readRes.json()) as { subject?: string }
  if (current.subject === subject) return true

  await graphWrite(userId, 'PATCH', url, { subject })
  return true
}

// Read another user's calendar using app-only (client-credentials) auth.
// mailboxUpn is the target user's userPrincipalName (typically their email).
export async function fetchCalendarEventsAsApp(
  mailboxUpn: string,
  startIso: string,
  endIso: string,
): Promise<GraphCalendarEvent[] | null> {
  const accessToken = await getAppOnlyAccessToken()
  if (!accessToken) return null
  const params = new URLSearchParams({
    startDateTime: startIso,
    endDateTime: endIso,
    '$top': '100',
    '$orderby': 'start/dateTime',
    '$select': 'id,subject,bodyPreview,isAllDay,start,end,location,attendees,organizer,type,seriesMasterId,showAs,isCancelled,responseStatus,sensitivity',
  })
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxUpn)}/calendarView?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' } },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph app-only calendarView failed (${res.status}): ${text}`)
  }
  return mapGraphEvents((await res.json()) as GraphCalendarViewResponse)
}
