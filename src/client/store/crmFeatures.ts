import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../lib/api.js'
import { DEFAULT_CRM_FEATURES, normalizeCrmFeatures, type CrmFeatures } from '../../shared/crmFeatures.js'

// App-wide CRM feature switches (Admin → Integrations → CRM features).
// Fetched once per page load on first use and shared by every component;
// the admin card calls setCrmFeaturesState() after a save so the change is
// visible immediately. Until the fetch answers, the defaults (everything
// on) apply, matching what the server assumes for an unset install.
let current: CrmFeatures = DEFAULT_CRM_FEATURES
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setCrmFeaturesState(next: CrmFeatures) {
  current = next
  listeners.forEach((cb) => { cb() })
}

function ensureLoaded() {
  if (loading) return
  loading = api.get<CrmFeatures>('/api/crm/features').then((res) => {
    if (res.data) setCrmFeaturesState(normalizeCrmFeatures(res.data))
    else loading = null // retry on the next mount rather than sticking on defaults
  }).catch(() => { loading = null })
}

export function useCrmFeatures(): CrmFeatures {
  useEffect(() => { ensureLoaded() }, [])
  return useSyncExternalStore(subscribe, () => current, () => current)
}
