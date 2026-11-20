// Where a user's timezone comes from (v1.469.0, users.timezone_source).
//   auto   follows the Outlook mailbox when Outlook is connected; UTC until then
//   crm    the user picked their CRM's timezone (Salesforce user / HubSpot portal)
//   manual the user picked a timezone from the list
// Only 'auto' lets the hourly Outlook check change users.timezone, so an
// override sticks until the user picks Outlook again or reconnects Outlook.
export const TIMEZONE_SOURCES = ['auto', 'crm', 'manual'] as const
export type TimezoneSource = typeof TIMEZONE_SOURCES[number]

export function isTimezoneSource(v: unknown): v is TimezoneSource {
  return typeof v === 'string' && (TIMEZONE_SOURCES as readonly string[]).includes(v)
}

/** Whether `tz` is an IANA zone this runtime knows (Intl accepts it). */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** IANA zones for the manual picker, UTC first. */
export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  const zones = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : []
  return ['UTC', ...zones.filter((z) => z !== 'UTC')]
}
