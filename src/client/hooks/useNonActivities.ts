import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'

// Tracks the caller's "not an activity" flags on Outlook events. The set is
// keyed by outlookEventId so both the Activities list (which filters
// suggestions) and the Calendar panel (which grays them out) can consult
// the same source of truth.
export function useNonActivities() {
  const [ids, setIds] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    const res = await api.get<string[]>('/api/non-activities')
    setIds(new Set(res.data ?? []))
  }, [])

  useEffect(() => { void reload() }, [reload])

  const mark = useCallback(async (outlookEventId: string) => {
    setIds((prev) => { const n = new Set(prev); n.add(outlookEventId); return n })
    await api.post('/api/non-activities', { outlookEventId })
  }, [])

  const unmark = useCallback(async (outlookEventId: string) => {
    setIds((prev) => { const n = new Set(prev); n.delete(outlookEventId); return n })
    await api.delete(`/api/non-activities/${encodeURIComponent(outlookEventId)}`)
  }, [])

  return { ids, mark, unmark, reload }
}
