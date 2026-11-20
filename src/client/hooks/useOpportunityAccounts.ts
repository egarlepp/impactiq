import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

interface OppAccount { id: string; accountId: string | null; accountName: string | null }

const cache = new Map<string, OppAccount>()
let inflight: Map<string, Promise<void>> = new Map()

async function fetchMissing(ids: string[]): Promise<void> {
  const missing = ids.filter((id) => !cache.has(id) && !inflight.has(id))
  if (missing.length === 0) return
  const p = (async () => {
    const res = await api.post<OppAccount[]>('/api/salesforce/opportunities/accounts', { ids: missing })
    if (res.data) {
      for (const r of res.data) cache.set(r.id, r)
    } else {
      for (const id of missing) cache.set(id, { id, accountId: null, accountName: null })
    }
  })()
  for (const id of missing) inflight.set(id, p)
  await p
  for (const id of missing) inflight.delete(id)
}

export function useOpportunityAccounts(oppIds: string[]): Map<string, OppAccount> {
  const [tick, setTick] = useState(0)
  const key = oppIds.slice().sort().join(',')
  useEffect(() => {
    if (oppIds.length === 0) return
    let cancelled = false
    void fetchMissing(oppIds).then(() => { if (!cancelled) setTick((t) => t + 1) })
    return () => { cancelled = true }
  }, [key])
  const out = new Map<string, OppAccount>()
  for (const id of oppIds) {
    const c = cache.get(id)
    if (c) out.set(id, c)
  }
  void tick
  return out
}
