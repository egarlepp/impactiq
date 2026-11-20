// v1.444.0: who has been calling /ready, so App Health can remind an admin to
// point a load balancer or uptime monitor at it. In memory and per server
// process: with several replicas, each only knows the calls it answered.

import type { ReadinessCalls } from '../../../shared/healthOverview.js'

// lastUserAgent is the caller's User-Agent, trimmed: it usually names the
// monitor (UptimeRobot, ELB-HealthChecker, kube-probe, ...).

const startedAt = new Date()
const DAY_MS = 24 * 60 * 60 * 1000
const UA_MAX = 120
let last: { at: number; ready: boolean; userAgent: string | null } | null = null
// One timestamp per call, pruned to the last 24 hours. A monitor checking
// every 30 seconds keeps 2,880 numbers, which is fine.
let recent: number[] = []

export function noteReadyCall(userAgent: string | undefined, ready: boolean, now: number = Date.now()): void {
  last = { at: now, ready, userAgent: userAgent ? userAgent.slice(0, UA_MAX) : null }
  recent.push(now)
  if (recent.length > 0 && now - recent[0]! > DAY_MS) recent = recent.filter((t) => now - t <= DAY_MS)
}

export function getReadinessCalls(now: number = Date.now()): ReadinessCalls {
  return {
    processStartedAt: startedAt.toISOString(),
    lastCalledAt: last ? new Date(last.at).toISOString() : null,
    lastReady: last ? last.ready : null,
    lastUserAgent: last?.userAgent ?? null,
    callsLast24h: recent.filter((t) => now - t <= DAY_MS).length,
  }
}

// Test hook.
export function resetReadinessCalls(): void {
  last = null
  recent = []
}
