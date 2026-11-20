// Prepend-update helpers for the "post a dated note, keep history" feature
// (Engineer Notes / Situation-Next Steps on the linked Evaluation record —
// see CLAUDE.md / Admin → SF Field Mappings). Pure, framework-free, and
// used identically on the client (live preview as the user types) and the
// server (the authoritative validation immediately before the SF write) so
// the two can never disagree about what fits.
//
// Character length uses plain `string.length` (UTF-16 code units) — the
// same measure JS gives you by default and the one every other length-limit
// check in this codebase already uses implicitly. There is no prior
// precedent in ImpactIQ for Salesforce-metadata character counting to
// follow, so this is a documented assumption, not a verified fact about how
// Salesforce itself counts a Long Text Area's length — see the emoji/
// surrogate-pair test cases in sfFieldPrepend.test.ts, which pin the exact
// behavior so it's visible (and easy to revisit) rather than silently
// assumed.

/**
 * `EG` from "Eric"/"Garlepp". Missing or blank names fall back to `?`
 * rather than fabricating an initial — never silently invents identity.
 */
export function computeInitials(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const first = (firstName ?? '').trim()
  const last = (lastName ?? '').trim()
  const firstChar = first.length > 0 ? first[0] : '?'
  const lastChar = last.length > 0 ? last[0] : '?'
  return `${firstChar}${lastChar}`.toUpperCase()
}

/** `MM/DD/YY - FI: text` — the one required output format, produced in exactly one place. */
export function formatEntry(dateMMDDYY: string, initials: string, text: string): string {
  return `${dateMMDDYY} - ${initials}: ${text}`
}

/**
 * Prepend a formatted entry above the field's existing content. An empty/
 * null existing value returns just the new entry (no stray blank lines —
 * AC2); otherwise one blank line separates entries, matching the required
 * visual format. Existing content is never trimmed, reordered, or rewritten.
 */
export function buildPrependedValue(existingValue: string | null | undefined, formattedEntry: string): string {
  const existing = existingValue ?? ''
  if (existing.length === 0) return formattedEntry
  return `${formattedEntry}\n\n${existing}`
}

export interface CapacityResult {
  finalValue: string
  charactersUsed: number
  maximumCharacters: number | null
  charactersRemaining: number | null
  /** 0 when within limit; the exact overage otherwise (AC5's "shorten by N characters"). */
  overBy: number
  fits: boolean
}

/**
 * Computes capacity from the EXACT final value that would be submitted —
 * never just the textarea input — per the feature's core requirement. When
 * `maxLength` is unknown (describe() didn't return one), remaining/overBy
 * are null/0 and `fits` is always true: an unknown limit must never block
 * a submission the way a real breach would.
 */
export function computeCapacity(args: {
  existingValue: string | null | undefined
  formattedEntry: string
  maxLength: number | null
}): CapacityResult {
  const finalValue = buildPrependedValue(args.existingValue, args.formattedEntry)
  const charactersUsed = finalValue.length
  if (args.maxLength == null) {
    return { finalValue, charactersUsed, maximumCharacters: null, charactersRemaining: null, overBy: 0, fits: true }
  }
  const charactersRemaining = args.maxLength - charactersUsed
  const overBy = charactersRemaining < 0 ? -charactersRemaining : 0
  return { finalValue, charactersUsed, maximumCharacters: args.maxLength, charactersRemaining, overBy, fits: overBy === 0 }
}
