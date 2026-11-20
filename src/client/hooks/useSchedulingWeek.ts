import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api.js'

export interface SchedBlock {
  start: string
  end: string
  isAllDay: boolean
  color: string | null
  subject?: string
  id?: string
  // v1.155.0: where the block came from, so the View toggle can show the
  // calendar, logged activities, or a deduped union.
  source?: 'outlook' | 'activity'
  logged?: boolean
  // v1.263.0: true when this meeting is marked Private/Confidential in
  // Outlook (or activities.isPrivateMeeting for a logged activity). `subject`
  // is only ever present alongside this when the viewer is the meeting's own
  // owner — see scheduling.ts's canDetail comment. The client always renders
  // "Private meeting" + a lock in place of any real subject when this is set.
  isPrivate?: boolean
  // v1.263.0: the current user's own RSVP is Tentative — drives the same
  // .stripe-tentative hatch pattern used on Activities cards.
  isTentative?: boolean
}

export interface SchedUser {
  userId: string
  displayName: string
  isSelf: boolean
  anonymized: boolean
  timezone?: string
  capacityHours: number | null
  pto: string[]
  blocks: SchedBlock[]
}

export interface SchedWeek {
  users: SchedUser[]
  privileged: boolean
  teamRoster?: { id: string; displayName: string }[]
}

// v1.153.0: loads the team free/busy week for the Scheduling page. Reads
// the server aggregation endpoint (cached outlook_events + activities),
// which applies privacy server-side — a contributor never receives peer
// names/subjects.
export function useSchedulingWeek(params: {
  teamId: string | null
  startIso: string
  endIso: string
  subteamIds: string[]
  userIds: string[]
  reloadKey?: number
}) {
  const { teamId, startIso, endIso, subteamIds, userIds, reloadKey } = params
  const [data, setData] = useState<SchedWeek | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!teamId) { setData(null); return }
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ teamId, start: startIso, end: endIso })
    if (subteamIds.length) qs.set('subteamIds', subteamIds.join(','))
    if (userIds.length) qs.set('userIds', userIds.join(','))
    const res = await api.get<SchedWeek>(`/api/scheduling/week?${qs.toString()}`)
    if (res.error) setError(res.error)
    setData(res.data ?? null)
    setLoading(false)
  }, [teamId, startIso, endIso, subteamIds.join(','), userIds.join(','), reloadKey])

  useEffect(() => { void load() }, [load])

  return { data, loading, error, reload: load }
}
