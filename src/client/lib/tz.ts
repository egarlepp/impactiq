// Timezone helpers. Everything server-side stores UTC ISO strings; the
// UI must render and edit those in the *user's* timezone (from
// /auth/me), not the browser's local timezone. Using Intl instead of
// date-fns-tz keeps this dep-free.

import { normalizeTimeZone } from '../../shared/windowsTimezones.js'

// v1.471.1: a Windows name ("Pacific Standard Time") is converted to its IANA
// id, and a value Intl can't use falls back to the browser's zone instead of
// throwing and breaking the screen.
function resolveTZ(tz?: string | null): string {
  return normalizeTimeZone(tz) ?? normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC'
}

// Short timezone acronym for a given IANA zone (e.g. "EST"/"EDT"/"GMT+9").
// Pass a reference date within the viewed week so DST is labeled correctly.
export function tzAbbrev(tz?: string | null, at?: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTZ(tz),
    timeZoneName: 'short',
  }).formatToParts(at ?? new Date())
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
}

// Format a UTC ISO (or Date) for display in the given TZ. Example: h:mm a.
export function formatTimeInTZ(iso: string | Date, tz?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: resolveTZ(tz),
    hour: 'numeric',
    minute: '2-digit',
  }).format(iso instanceof Date ? iso : new Date(iso))
}

// Format a UTC ISO (or Date) as a full date + time for display in the given
// TZ, e.g. "Sep 17, 2026, 9:41 AM" — used by the sidebar user-pill's "Last
// logged in" tooltip (v1.364.0) and anywhere else that wants a single-line
// date+time stamp rather than just the time-of-day formatTimeInTZ gives.
export function formatDateTimeInTZ(iso: string | Date, tz?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: resolveTZ(tz),
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(iso instanceof Date ? iso : new Date(iso))
}

// Convert a UTC ISO string into the `YYYY-MM-DDTHH:mm` form required
// by an <input type="datetime-local">, with the wall-clock reading in
// the given TZ.
export function isoToLocalInputInTZ(iso: string, tz?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTZ(tz),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  return `${m['year']}-${m['month']}-${m['day']}T${m['hour']}:${m['minute']}`
}

// `YYYY-MM-DD` date part of an instant in a given TZ. Use for
// bucketing events into the correct day column when the user's TZ
// differs from the browser's (`date-fns/isSameDay` compares local
// dates and would misplace events near midnight).
export function ymdInTZ(input: string | Date, tz?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTZ(tz),
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(input instanceof Date ? input : new Date(input))
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  return `${m['year']}-${m['month']}-${m['day']}`
}

// Wall-clock hour+minute of an instant in a given TZ. Used by any
// pixel-position math (e.g. calendar grid Y-offset) that must agree
// with the labels rendered by formatTimeInTZ.
export function wallClockInTZ(input: string | Date, tz?: string | null): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTZ(tz),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(input instanceof Date ? input : new Date(input))
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  return { hour: Number(m['hour']) || 0, minute: Number(m['minute']) || 0 }
}

// Inverse of isoToLocalInputInTZ. Given a "YYYY-MM-DDTHH:mm" string
// the user typed while looking at their own TZ clock, produce the
// corresponding UTC ISO. Works by rendering a naive UTC guess back in
// the target TZ, measuring the offset that induced, and subtracting.
export function localInputInTZToIso(local: string, tz?: string | null): string {
  const zone = resolveTZ(tz)
  // Treat the input as if it were UTC to seed a Date. This is not the
  // real UTC — we'll correct for the TZ offset below.
  const naive = new Date(`${local}:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(naive)
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  const asIfLocal = Date.UTC(
    Number(m['year']), Number(m['month']) - 1, Number(m['day']),
    Number(m['hour']), Number(m['minute']),
  )
  const offset = asIfLocal - naive.getTime()
  return new Date(naive.getTime() - offset).toISOString()
}
