import type { CompareMode } from './period.js'

// Prior-period offset used by every dashboard when the Compare toggle is
// active. Kept as a whole-week shift so it composes with `rangeFor(weeks,
// weekShift)` on the server; roughly matches calendar month/quarter/year.
export function weekShiftFor(mode: CompareMode): number {
  switch (mode) {
    case 'off': return 0
    case 'wow': return -1
    case 'mom': return -4
    case 'qoq': return -13
    case 'yoy': return -52
  }
}

interface DashboardFetchOpts {
  teamId: string
  weeksBack?: number
  productIds?: string[]
  userId?: string | null
  // v1.265.0: multi-person filter — the union of every individually-picked
  // person plus every member of every checked subteam (Dashboard.tsx's
  // SubteamFilter mode="multi"). Server-side param name is `userIds`
  // (matching the convention already used by ManagerRollup/SalesTeamBreakdown/
  // ProjectCosting/UserLeaderboard/AttachRate) — kept distinct from the
  // singular `userId` above so a caller can still narrow to exactly one
  // person without going through the array path.
  memberIds?: string[]
  weekShift?: number
  extra?: Record<string, string | number | undefined>
}

// v1.195.0: dashboard-wide date controls (date basis + an exact start/end
// window from a custom range or FY/FQ pick). Set once by the Dashboard page
// and appended to every dashboard request so all tabs stay in sync without
// threading the values through each component. Attach Rate manages its own
// opportunity-level basis and opts out via buildDashboardUrl's skipDateParams.
export type DashDateBasis = 'activity' | 'created' | 'close'
let dashDate: { basis: DashDateBasis; start: string; end: string } = { basis: 'activity', start: '', end: '' }
export function setDashDateParams(next: { basis: DashDateBasis; start: string; end: string }): void {
  dashDate = next
}
// Query fragment for components that build their URL by hand.
export function dashDateParams(): Record<string, string> {
  const p: Record<string, string> = {}
  if (dashDate.basis !== 'activity') p['dateBasis'] = dashDate.basis
  if (dashDate.start && dashDate.end) { p['start'] = dashDate.start; p['end'] = dashDate.end }
  return p
}

// Build a `/api/dashboards/<name>` URL with the shared query-param
// convention. Keeps every component's fetch call one line.
export function buildDashboardUrl(name: string, opts: DashboardFetchOpts): string {
  const params = new URLSearchParams({ teamId: opts.teamId })
  if (opts.weeksBack !== undefined) params.set('weeks', String(opts.weeksBack))
  if (opts.productIds && opts.productIds.length > 0) params.set('productIds', opts.productIds.join(','))
  if (opts.userId) params.set('userId', opts.userId)
  if (opts.memberIds && opts.memberIds.length > 0) params.set('userIds', opts.memberIds.join(','))
  if (opts.weekShift !== undefined && opts.weekShift !== 0) params.set('weekShift', String(opts.weekShift))
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      if (v === undefined || v === '') continue
      params.set(k, String(v))
    }
  }
  // Append the dashboard-wide date basis / window unless the caller already
  // set its own (e.g. Attach Rate's opportunity basis).
  for (const [k, v] of Object.entries(dashDateParams())) if (!params.has(k)) params.set(k, v)
  return `/api/dashboards/${name}?${params.toString()}`
}
