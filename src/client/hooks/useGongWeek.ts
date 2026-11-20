import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import type { GongWeekMarks } from '../../shared/gong.js'

const EMPTY: { recorded: Set<string>; linked: Set<string> } = { recorded: new Set(), linked: new Set() }

// v1.456.0 (Gong plan, phase 3): which of the signed-in person's meetings in
// the shown week Gong recorded, and which of their activities have a call
// linked. Empty when Gong isn't connected, the Transcripts tab isn't granted,
// or someone else's week is shown (`enabled` false). `fromMs`/`toMs` and
// `reloadKey` are primitives so the effect doesn't refire every render.
// v1.460.0: whether the Transcripts tab is available for this team's
// activities (Gong connected, or demo Gong data for the demo team, plus the
// Role Management grant). Drives the Transcripts icon on activity cards.
export function useGongTranscriptsEnabled(teamId: string | null | undefined) {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    if (!teamId) { setEnabled(false); return }
    let cancelled = false
    api.get<{ enabled: boolean }>(`/api/gong/status?teamId=${encodeURIComponent(teamId)}`).then((res) => {
      if (!cancelled) setEnabled(res.data?.enabled === true)
    })
    return () => { cancelled = true }
  }, [teamId])
  return enabled
}

export function useGongWeek(enabled: boolean, fromMs: number, toMs: number, reloadKey: number) {
  const [marks, setMarks] = useState(EMPTY)
  useEffect(() => {
    if (!enabled) { setMarks(EMPTY); return }
    let cancelled = false
    void (async () => {
      const status = await api.get<{ enabled: boolean }>('/api/gong/status')
      if (cancelled || !status.data?.enabled) { if (!cancelled) setMarks(EMPTY); return }
      const q = new URLSearchParams({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() })
      const res = await api.get<GongWeekMarks>(`/api/gong/week?${q.toString()}`)
      if (cancelled) return
      setMarks(res.data ? { recorded: new Set(res.data.recordedEvents), linked: new Set(res.data.linkedActivities) } : EMPTY)
    })()
    return () => { cancelled = true }
  }, [enabled, fromMs, toMs, reloadKey])
  return marks
}
