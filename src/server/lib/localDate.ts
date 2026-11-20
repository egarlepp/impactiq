// Shared "what calendar day is it in this IANA timezone" helper. Extracted
// from duplicated private copies in services/notifications/digest.ts and
// .../weekly-recap.ts (both still import it from here) when
// services/announcements/engine.ts needed the exact same primitive — three
// independent implementations of one date computation is exactly the kind
// of drift CLAUDE.md flags repeatedly elsewhere in this codebase.
//
// Dependency-free Intl.DateTimeFormat, mirroring the approach
// src/client/lib/tz.ts and services/salesforce/fieldPrepend.ts already use;
// there is no server-side date-fns-tz usage anywhere in this codebase to
// extend instead. en-CA formats as YYYY-MM-DD (ISO order), which is what we
// want back directly with no part-reassembly.
export function localDayKeyFor(tz: string, at: Date): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz })
    return fmt.format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}
