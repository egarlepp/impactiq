import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { useCrmProvider } from '../store/crmProvider.js'

// v1.408.0: the signed-in user's own link to the active CRM
// (GET /api/crm/me). Only HubSpot reports anything beyond the provider: the
// portal, whether the install's connection is saved, and the HubSpot owner the
// user is matched to (there is no per-user HubSpot sign-in). Fetched once per
// page load and shared by the sidebar status and My Settings.
export interface CrmMeStatus {
  provider: string
  configured?: boolean
  portalName?: string | null
  owner?: { id: string; name: string | null; email: string | null } | null
}

let cached: Promise<CrmMeStatus | null> | null = null

function load(): Promise<CrmMeStatus | null> {
  if (!cached) {
    cached = api.get<CrmMeStatus>('/api/crm/me')
      .then((res) => res.data ?? null)
      .catch(() => { cached = null; return null })
  }
  return cached
}

export function useCrmMe(): { status: CrmMeStatus | null; loading: boolean } {
  const isHubspot = useCrmProvider() === 'hubspot'
  const [status, setStatus] = useState<CrmMeStatus | null>(null)
  const [loading, setLoading] = useState(isHubspot)

  useEffect(() => {
    if (!isHubspot) { setStatus(null); setLoading(false); return }
    let alive = true
    setLoading(true)
    void load().then((s) => { if (alive) { setStatus(s); setLoading(false) } })
    return () => { alive = false }
  }, [isHubspot])

  return { status, loading }
}
