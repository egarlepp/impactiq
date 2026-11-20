// Wall-clock helpers for demo data generated in a chosen IANA timezone.
// With no timezone every helper works in UTC, which is how demo data was
// generated before the timezone setting existed (and what tests rely on).

const DAY_MS = 86400_000

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz)
    return true
  } catch {
    return false
  }
}

function partsOf(instant: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const out: Record<string, number> = {}
  for (const p of formatterFor(tz).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { y: out['year']!, mo: out['month']!, d: out['day']!, h: out['hour']!, mi: out['minute']!, s: out['second']! }
}

// Milliseconds the zone is ahead of UTC at this instant (negative west of UTC).
function offsetMs(instant: number, tz: string): number {
  const p = partsOf(instant, tz)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** 'YYYY-MM-DD' of the calendar day `instant` falls on in `tz` (UTC when none). */
export function localDateOf(instant: Date, tz?: string | null): string {
  if (!tz) return instant.toISOString().slice(0, 10)
  const p = partsOf(instant.getTime(), tz)
  return `${String(p.y).padStart(4, '0')}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

/** The instant that is `hours` past local midnight of `date` in `tz` (UTC when none). Recomputes the offset so DST days come out right. */
export function localToUtc(date: string, hours: number, tz?: string | null): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const wall = Date.UTC(y, m - 1, d) + Math.round(hours * 3600_000)
  if (!tz) return new Date(wall)
  let guess = wall - offsetMs(wall, tz)
  const second = offsetMs(guess, tz)
  if (second !== wall - guess) guess = wall - second
  return new Date(guess)
}

export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10)
}

/** 0 = Sunday … 6 = Saturday, for a 'YYYY-MM-DD' calendar date. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Monday of the week `instant` falls in, as a local calendar date. */
export function localMondayOf(instant: Date, tz?: string | null): string {
  const date = localDateOf(instant, tz)
  const dow = dayOfWeek(date)
  return addDaysToDate(date, dow === 0 ? -6 : 1 - dow)
}
