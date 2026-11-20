import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../lib/api.js'
import { applyTerminologyWording } from '../i18n/index.js'
import { DEFAULT_TERMINOLOGY, normalizeTerminology, type Terminology } from '../../shared/terminology.js'

// The org's word for an evaluation (Admin → Workplace → Terminology). Fetched
// once per page load and shared, like the CRM provider store; the admin page
// calls setTerminologyState() after a save so every screen updates at once.
let current: Terminology = DEFAULT_TERMINOLOGY
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setTerminologyState(next: Terminology) {
  current = normalizeTerminology(next)
  applyTerminologyWording(current)
  listeners.forEach((cb) => { cb() })
}

function ensureLoaded() {
  if (loading) return
  loading = api.get<Terminology>('/api/terminology').then((res) => {
    if (res.data) setTerminologyState(res.data)
    else loading = null
  }).catch(() => { loading = null })
}

export function useTerminology(): Terminology {
  useEffect(() => { ensureLoaded() }, [])
  return useSyncExternalStore(subscribe, () => current, () => current)
}
