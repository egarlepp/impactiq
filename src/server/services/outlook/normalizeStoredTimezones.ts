import { inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users } from '../../../../drizzle/schema.js'
import { normalizeTimeZone, windowsToIana } from '../../../shared/windowsTimezones.js'

// v1.471.1: before this release the Outlook mailbox timezone was stored as
// Graph sent it, usually a Windows name ("Pacific Standard Time") that Intl
// rejects. Runs once per boot after migrations: rewrites every stored Windows
// name in users.timezone / users.outlook_timezone to its IANA id. Values that
// are already IANA, or unknown, are left alone. Idempotent, so a second boot
// changes nothing. Done in code rather than a migration because the mapping
// lives in src/shared/windowsTimezones.ts and a SQL copy would drift from it.

export interface TimezoneNormalizeResult {
  updated: number
}

export async function normalizeStoredTimezones(): Promise<TimezoneNormalizeResult> {
  const rows = await db
    .select({ id: users.id, timezone: users.timezone, outlookTimezone: users.outlookTimezone })
    .from(users)
    .where(or(isNotNull(users.timezone), isNotNull(users.outlookTimezone)))

  // Group by the rewrite so a big install needs one UPDATE per distinct value
  // pair, not one per user.
  const groups = new Map<string, { timezone?: string; outlookTimezone?: string; ids: string[] }>()
  for (const row of rows) {
    const patch: { timezone?: string; outlookTimezone?: string } = {}
    const tz = convert(row.timezone)
    if (tz) patch.timezone = tz
    const outlookTz = convert(row.outlookTimezone)
    if (outlookTz) patch.outlookTimezone = outlookTz
    if (!patch.timezone && !patch.outlookTimezone) continue
    const key = `${row.timezone ?? ''}\u0000${row.outlookTimezone ?? ''}`
    const group = groups.get(key) ?? { ...patch, ids: [] }
    group.ids.push(row.id)
    groups.set(key, group)
  }

  let updated = 0
  for (const group of groups.values()) {
    const set: { timezone?: string; outlookTimezone?: string } = {}
    if (group.timezone) set.timezone = group.timezone
    if (group.outlookTimezone) set.outlookTimezone = group.outlookTimezone
    await db.update(users).set(set).where(inArray(users.id, group.ids))
    updated += group.ids.length
  }
  return { updated }
}

/** The IANA id for a stored Windows name, or null when nothing should change. */
function convert(value: string | null): string | null {
  if (!value || !windowsToIana(value)) return null
  const iana = normalizeTimeZone(value)
  return iana && iana !== value ? iana : null
}
