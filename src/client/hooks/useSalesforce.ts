import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'

export interface SalesforceStatus {
  connected: boolean
  // v1.99.0: `connected` reflects "we have a stored token"; `healthy`
  // reflects "the stored token actually works against SF right now".
  // A user can be connected but not healthy after a password reset or
  // token revocation; the UI shows a banner nudging Reconnect.
  healthy?: boolean
  configured: boolean
  instanceUrl: string | null
  accountLabel: string | null
  connectedAt: string | null
}

export function useSalesforce() {
  const [status, setStatus] = useState<SalesforceStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<SalesforceStatus>('/auth/salesforce/status')
      setStatus(res.data ?? { connected: false, configured: false, instanceUrl: null, accountLabel: null, connectedAt: null })
    } catch {
      setStatus({ connected: false, configured: false, instanceUrl: null, accountLabel: null, connectedAt: null })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const connect = useCallback(() => {
    window.location.assign('/auth/salesforce')
  }, [])

  const disconnect = useCallback(async () => {
    await api.post('/auth/salesforce/disconnect', {})
    await reload()
  }, [reload])

  return { status, loading, connect, disconnect, reload }
}
