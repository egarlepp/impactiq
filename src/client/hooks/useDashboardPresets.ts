import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'

export interface DashboardPreset {
  id: string
  name: string
  filters: Record<string, unknown>
  updatedAt?: string
}

// Manages the caller's saved dashboard filter presets. Keeps a local
// cache and exposes reload/save/remove helpers. The filter payload is
// opaque server-side — this hook stores whatever object the Dashboard
// page hands in.
export function useDashboardPresets() {
  const [presets, setPresets] = useState<DashboardPreset[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const res = await api.get<DashboardPreset[]>('/api/dashboards/presets')
    setPresets(res.data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { void reload() }, [reload])

  const save = useCallback(async (name: string, filters: Record<string, unknown>) => {
    const res = await api.post<DashboardPreset>('/api/dashboards/presets', { name, filters })
    if (res.data) await reload()
    return res
  }, [reload])

  const remove = useCallback(async (id: string) => {
    await api.delete(`/api/dashboards/presets/${id}`)
    await reload()
  }, [reload])

  return { presets, loading, reload, save, remove }
}
