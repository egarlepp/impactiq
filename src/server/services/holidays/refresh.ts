// Pull public holiday dates from a free API and upsert them into a
// holiday calendar. Nager (date.nager.at) is used because it needs no
// API key, covers 100+ countries, and returns clean JSON per (country,
// year). Country codes are ISO-3166-1 alpha-2, which matches the codes
// we already use on the seeded calendars (US, GB, DE, FR, IT, ES, PT, JP).

import { db } from '../../db/index.js'
import { holidayCalendars, holidayDates } from '../../../../drizzle/schema.js'
import { and, eq, gte, lte } from 'drizzle-orm'

interface NagerHoliday {
  date: string        // 'YYYY-MM-DD'
  localName: string
  name: string
  countryCode: string
}

async function fetchNager(country: string, year: number): Promise<NagerHoliday[]> {
  // Defense-in-depth: constrain the only interpolated segment to an ISO-3166
  // alpha-2 code. The host/scheme are constants and the value is admin-managed,
  // but this makes the no-SSRF guarantee explicit (CodeQL) and rejects junk.
  if (!/^[A-Za-z]{2}$/.test(country)) throw new Error(`Invalid country code: ${country}`)
  const safeYear = Math.trunc(Number(year))
  const url = `https://date.nager.at/api/v3/PublicHolidays/${safeYear}/${encodeURIComponent(country.toUpperCase())}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Nager fetch failed for ${country}/${year}: HTTP ${res.status}`)
  return await res.json() as NagerHoliday[]
}

// Refresh a single calendar for the given years. Existing dates in that
// year window are replaced by the fresh feed so a moved holiday (e.g.
// Nyepi, Rosh Hashanah, or a re-numbered observed day) picks up cleanly.
export async function refreshCalendar(calendarId: string, years: number[]): Promise<{ added: number; replaced: number; skipped: number; asOf: string }> {
  const [cal] = await db.select().from(holidayCalendars).where(eq(holidayCalendars.id, calendarId)).limit(1)
  if (!cal) throw new Error('calendar not found')

  let added = 0, replaced = 0
  let skipped = 0

  for (const year of years) {
    let fetched: NagerHoliday[]
    try {
      fetched = await fetchNager(cal.code, year)
    } catch {
      // Skip years the API doesn't cover for this country instead of
      // failing the whole refresh.
      skipped++
      continue
    }
    if (fetched.length === 0) { skipped++; continue }

    // Wipe existing dates for this calendar in the target year, then
    // insert the fresh set. Guarantees idempotence.
    const yearStart = `${year}-01-01`
    const yearEnd = `${year}-12-31`
    const existing = await db.select({ id: holidayDates.id }).from(holidayDates)
      .where(and(eq(holidayDates.calendarId, calendarId), gte(holidayDates.date, yearStart), lte(holidayDates.date, yearEnd)))
    if (existing.length > 0) {
      await db.delete(holidayDates).where(and(
        eq(holidayDates.calendarId, calendarId),
        gte(holidayDates.date, yearStart),
        lte(holidayDates.date, yearEnd),
      ))
      replaced += existing.length
    }
    for (const h of fetched) {
      await db.insert(holidayDates).values({
        calendarId,
        date: h.date,
        // Prefer the English name; fall back to localName if English is
        // missing (uncommon on Nager's feed).
        name: h.name || h.localName,
      }).onConflictDoNothing()
      added++
    }
  }

  return { added, replaced, skipped, asOf: new Date().toISOString().slice(0, 10) }
}

// Refresh every non-custom calendar (i.e., every calendar whose code
// looks like an ISO country). Custom calendars an admin creates for
// their own business closures are left alone — those don't come from
// a public feed.
export async function refreshAllCalendars(years: number[]): Promise<Array<{ calendarId: string; code: string; name: string; added: number; replaced: number; skipped: number; asOf: string; error?: string }>> {
  const cals = await db.select().from(holidayCalendars)
  const out: Array<{ calendarId: string; code: string; name: string; added: number; replaced: number; skipped: number; asOf: string; error?: string }> = []
  for (const c of cals) {
    // Only refresh ISO-country-like codes. Custom calendars use codes
    // like "biz-emea" or free-form names — skip those.
    if (!/^[A-Z]{2}$/.test(c.code)) continue
    try {
      const r = await refreshCalendar(c.id, years)
      out.push({ calendarId: c.id, code: c.code, name: c.name, ...r })
    } catch (err) {
      out.push({ calendarId: c.id, code: c.code, name: c.name, added: 0, replaced: 0, skipped: 0, asOf: '', error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
