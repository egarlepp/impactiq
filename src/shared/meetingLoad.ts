// Shared between src/server/services/capacity/meetingLoad.ts (the "Meeting
// Load" figure on leader dashboards, and the calendar_derived capacity
// method) and src/client/pages/WeeklyView.tsx (the contributor's own weekly
// capacity bar). Lives here, not in the server file, so the client can
// import the exact same predicate instead of a hand-duplicated copy that
// could silently drift — see CLAUDE.md §12.1 and the mappingValidation.ts/
// buildSfRecord() "mirror exactly" precedent for why that drift risk is
// worth avoiding here too.
//
// This measures MEETING LOAD, not availability. An empty calendar is not
// free time — it just means no meetings were scheduled. Every caller-facing
// label/tooltip for this number must say so; see CLAUDE.md §12.

export interface MeetingLoadEventFields {
  isAllDay: boolean
  isCancelled?: boolean | null
  showAs?: string | null
  responseStatus?: string | null
}

/**
 * Does this cached Outlook event count as real, busy meeting time?
 *
 * - All-day events never count (they aren't meetings in the capacity sense).
 * - Cancelled events never count.
 * - `showAs = 'workingElsewhere'` never counts — it's explicitly not meeting
 *   load, and counting it would reintroduce "empty calendar = busy" in
 *   reverse.
 * - `responseStatus = 'declined'` never counts.
 * - The organizer's own events report `responseStatus` as `'organizer'` (or
 *   sometimes `'none'`) rather than a real response — these MUST count, not
 *   be treated as "no response yet."
 * - `showAs`/`responseStatus` are NULL/undefined on any row cached before
 *   the v1.225.0 Graph $select change (server), or on a demo-mode fixture
 *   event that never set them (client) — treated as "busy" so this reads no
 *   worse than the pre-v1.225.0 behavior (which counted every non-all-day
 *   event), a temporary non-regression rather than an undercount.
 */
export function isRealMeetingLoad(e: MeetingLoadEventFields): boolean {
  if (e.isAllDay) return false
  if (e.isCancelled) return false
  if (e.responseStatus === 'declined') return false
  const showAs = e.showAs ?? 'busy'
  return showAs === 'busy' || showAs === 'tentative' || showAs === 'oof'
}
