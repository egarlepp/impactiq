import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api.js'
import type { Activity } from './useActivities.js'

// v1.242.0: APPROVED activities whose Outlook meeting has been deleted from the
// user's calendar, awaiting a Keep / Delete decision.
//
// Detection is server-side (see flagDeletedOutlookActivities in
// services/outlook/sync.ts) and only ever runs off a successful Graph fetch —
// this hook just reads the queue and issues the two decisions.
//
// `weekStart` scopes `items` to the week being viewed, for the in-week review
// section. `totalCount` always covers every week, because the bell and header
// banner report a global count.
export function useOutlookDeleted(weekStart: Date | null, reloadKey?: number) {
  const [items, setItems] = useState<Activity[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [busy, setBusy] = useState(false)

  const key = weekStart ? weekStart.toISOString() : ''

  // Rapidly navigating weeks (leave, then come right back) fires one fetch per
  // week with no guarantee they resolve in request order — the exact race that
  // hit useActivities.ts in v1.321. Without a staleness guard, the OLDER
  // request (for the week just left) can resolve after the newer one and
  // silently overwrite it with a different week's items, making this section
  // vanish on the week the user is actually looking at until a manual reload.
  const latestKeyRef = useRef(key)
  latestKeyRef.current = key

  const load = useCallback(async () => {
    const requestKey = key
    const qs = key ? `?weekStart=${encodeURIComponent(key)}` : ''
    const res = await api.get<Activity[]>(`/api/activities/outlook-deleted${qs}`)
    if (latestKeyRef.current !== requestKey) return // a newer week's request has since superseded this one
    setItems(res.data ?? [])
    const meta = (res.meta ?? {}) as { totalCount?: number }
    setTotalCount(meta.totalCount ?? 0)
  }, [key])

  useEffect(() => { void load() }, [load, reloadKey])

  // Both decisions accept either explicit ids (one card) or the week (the
  // Keep All / Delete All buttons on the section header). Never both-empty —
  // the server rejects an unscoped bulk call rather than guessing.
  const keep = useCallback(async (opts: { ids?: string[]; weekStart?: string }) => {
    setBusy(true)
    try {
      await api.post('/api/activities/outlook-deleted/keep', opts)
      await load()
    } finally { setBusy(false) }
  }, [load])

  const purge = useCallback(async (opts: { ids?: string[]; weekStart?: string }) => {
    setBusy(true)
    try {
      await api.delete('/api/activities/outlook-deleted', opts)
      await load()
    } finally { setBusy(false) }
  }, [load])

  return { items, totalCount, busy, reload: load, keep, purge }
}
