import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'

export interface CalendarAttendee { name: string; email: string; response: string; type: string }
export interface CalendarEvent {
  id: string
  subject: string
  start: string
  end: string
  isAllDay: boolean
  bodyPreview: string
  location?: string
  alreadyLogged: boolean
  activityTypeColor?: string | null
  activityTypeIcon?: string | null
  attendees?: CalendarAttendee[]
  organizer?: { name: string; email: string }
  eventType?: string
  seriesMasterId?: string
  // v1.241.0: the CURRENT user's own RSVP on this event (Graph
  // `responseStatus.response`): none | organizer | tentativelyAccepted |
  // accepted | declined | notResponded. Already fetched and returned by
  // /api/outlook/calendar — this type just never declared it. Drives the
  // tentative hatch pattern on calendar blocks and activity cards.
  responseStatus?: string
  showAs?: string
  isCancelled?: boolean
  // v1.262.0: derived from Outlook's own sensitivity marking (private or
  // confidential) — see CLAUDE.md §7 Private Meetings.
  isPrivate?: boolean
}

export interface CalendarMeta {
  fallback?: 'no_app_only_graph'
  personName?: string
}

export interface OutlookStatus {
  connected: boolean
  configured: boolean
  connectedAt: string | null
}

export function useOutlookStatus() {
  const [status, setStatus] = useState<OutlookStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const res = await api.get<OutlookStatus>('/api/outlook/status')
    setStatus(res.data ?? { connected: false, configured: false, connectedAt: null })
    setLoading(false)
  }, [])

  useEffect(() => { void reload() }, [reload])

  const connect = useCallback(() => {
    window.location.assign('/auth/microsoft')
  }, [])

  const disconnect = useCallback(async () => {
    await api.post('/auth/microsoft/disconnect', {})
    await reload()
  }, [reload])

  return { status, loading, connect, disconnect, reload }
}

export function useCalendarEvents(weekStart: Date, enabled: boolean, userId?: string | null, reloadKey?: number) {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [meta, setMeta] = useState<CalendarMeta>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // v1.161.0: refetch when the tab regains focus so a change made in Outlook
  // (e.g. a deleted event) surfaces on return. The server re-syncs on this
  // read with a short freshness window, then reconciles deletions.
  const [focusKey, setFocusKey] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const onFocus = () => { if (document.visibilityState === 'visible') setFocusKey((k) => k + 1) }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setEvents([])
      setMeta({})
      return
    }
    const start = new Date(weekStart)
    const end = new Date(weekStart)
    end.setDate(end.getDate() + 7)

    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() })
    if (userId) params.set('userId', userId)
    api
      .get<CalendarEvent[]>(`/api/outlook/calendar?${params.toString()}`)
      .then((res) => {
        if (res.error) setError(res.error)
        else setEvents(res.data ?? [])
        setMeta((res.meta as CalendarMeta | undefined) ?? {})
        setLoading(false)
      })
  }, [enabled, weekStart.toISOString(), userId, reloadKey, focusKey])

  return { events, meta, loading, error }
}
