import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

export interface Suggestion {
  outlookEventId: string
  subject: string
  start: string
  end: string
  bodyPreview: string | null
  suggestedActivityTypeId: string | null
  suggestedActivityTypeName: string | null
  suggestedActivityTypeColor: string | null
  suggestedActivityTypeIcon: string | null
  // v1.243.0: 'user_keyword' = the viewer's OWN Non-Activity subject keywords
  // (My Settings → Data & Templates), as distinct from 'keyword' which means a
  // team rule in Admin → Keyword Rules. Kept separate so the card can point at
  // the right place to change it.
  suggestionSource: 'keyword' | 'user_keyword' | 'private_sensitivity' | 'ai' | 'none'
  suggestionConfidence: number
  matchedKeywords: string[] | null
  matchedRuleId: string | null
  matchedRuleField: 'subject' | 'body' | 'both' | null
  // v1.240.0: true when a keyword rule classified this event as
  // Non-Activity rather than suggesting a type. The server also upserts
  // non_activity_events for this (userId, outlookEventId), so this flag is
  // just the same-poll mirror of that — useNonActivities()'s own list will
  // catch up on its next poll regardless.
  isNonActivitySuggestion: boolean
  // v1.262.0: independent of isNonActivitySuggestion — a private meeting
  // gets the Private Meeting card treatment (pill, lock icon, masked
  // title) regardless of whether the user has "Private meetings →
  // Non-Activity" turned on. See CLAUDE.md §7 Private Meetings.
  isPrivate: boolean
  meetingOwner: string | null
  // v1.240.0: the organizer's email, separate from the display-only
  // meetingOwner string above — needed to resolve "am I required/optional"
  // for a meeting the current user organized themselves (Graph omits the
  // organizer from `attendees` entirely).
  organizerEmail: string | null
  // v1.241.0: the current user's own RSVP on this meeting (Graph
  // `responseStatus.response`). 'tentativelyAccepted' drives the hatch
  // pattern on the card.
  responseStatus: string | null
  // v1.239.0: response/type (Graph attendee RSVP + required/optional) are
  // optional here — populated for the Log Activity form's read-only
  // "meeting responses" summary (see ActivityForm.tsx), not required for
  // existing consumers that only ever read name/email.
  attendees: { name?: string; email?: string; response?: string; type?: string }[] | null
  // v1.91.0: cached SF suggestions based on attendee emails. Nulls when
  // SF hasn't been consulted yet or no matches found. Powers the
  // PossibleMatchChip on SuggestedActivityCard.
  suggestedAccount: { id: string; name: string } | null
  suggestedOpportunity: { id: string; name: string; accountId?: string | null; accountName?: string | null } | null
  suggestionCandidates: Array<{ id: string; name: string; type: 'Account' | 'Opportunity'; detail?: string | null }> | null
  userOverrideSfWhat: { id: string; type: 'Account' | 'Opportunity'; name: string } | null
}

export function useSuggestions(teamId: string | null, weekStart: Date, userId?: string | null): { suggestions: Suggestion[]; reload: () => void; nonActivityColor: string | null } {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  // v1.262.0: the team's configured Non-Activity anchor color (falls back to
  // plain light gray client-side when null) — drives the Private Meeting
  // card background. See outlook.ts's /suggestions route.
  const [nonActivityColor, setNonActivityColor] = useState<string | null>(null)
  const start = new Date(weekStart)
  const end = new Date(weekStart)
  end.setDate(end.getDate() + 7)

  const key = `${teamId}|${start.toISOString()}|${userId ?? ''}`

  async function load() {
    if (!teamId) { setSuggestions([]); return }
    const params = new URLSearchParams({ teamId, start: start.toISOString(), end: end.toISOString() })
    if (userId) params.set('userId', userId)
    const res = await api.get<Suggestion[]>(`/api/outlook/suggestions?${params.toString()}`)
    setSuggestions(res.data ?? [])
    setNonActivityColor((res.meta?.['nonActivityColor'] as string | null) ?? null)
  }

  useEffect(() => { void load() }, [key])
  return { suggestions, reload: load, nonActivityColor }
}
