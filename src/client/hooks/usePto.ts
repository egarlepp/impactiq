import { useEffect, useState, useCallback } from 'react'
import { format } from 'date-fns'
import { api } from '../lib/api.js'

export interface PtoEntry { date: string; note: string | null }

// Module-level store — every hook instance shares the same PTO set for a
// (start,end) window. When one component toggles PTO, all others re-render
// because they subscribe to the same `version` counter.
const cache = new Map<string, Set<string>>()
const listeners = new Set<() => void>()
let version = 0

function bumpVersion() {
  version += 1
  for (const l of listeners) l()
}

export function usePto(weekStart: Date, weekEnd: Date) {
  const startStr = format(weekStart, 'yyyy-MM-dd')
  const endStr = format(weekEnd, 'yyyy-MM-dd')
  const key = `${startStr}|${endStr}`
  const [, setV] = useState(version)
  const [dates, setDates] = useState<Set<string>>(cache.get(key) ?? new Set())

  const reload = useCallback(async () => {
    const res = await api.get<PtoEntry[]>(`/auth/me/pto?start=${startStr}&end=${endStr}`)
    const next = new Set((res.data ?? []).map((r) => r.date))
    cache.set(key, next)
    setDates(next)
    bumpVersion()
  }, [key, startStr, endStr])

  // Subscribe: any external bumpVersion re-renders this instance and pulls
  // the latest cache entry for its window.
  useEffect(() => {
    const listener = () => {
      setV(version)
      const c = cache.get(key)
      if (c) setDates(c)
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [key])

  useEffect(() => { void reload() }, [reload])

  async function toggle(iso: string) {
    // Optimistic update in the cache first so every subscriber sees it
    // before the network round-trip returns.
    const next = new Set(cache.get(key) ?? [])
    const willAdd = !next.has(iso)
    if (willAdd) next.add(iso); else next.delete(iso)
    cache.set(key, next)
    setDates(next)
    bumpVersion()
    if (willAdd) {
      await api.post('/auth/me/pto', { date: iso })
    } else {
      await api.delete(`/auth/me/pto/${iso}`)
    }
    // Refresh from server to reconcile any error.
    void reload()
  }

  return { ptoDates: dates, togglePto: toggle, reloadPto: reload }
}
