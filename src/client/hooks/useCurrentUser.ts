import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

export interface CurrentUser {
  id: string
  email: string
  displayName: string
  isAppAdmin: boolean
  // v1.332.0: the one designated `users.is_default_admin` account — gates the
  // sidebar Update pill's configure/act affordances. App Admins can VIEW
  // update status; only this account can configure or (Phase 2) trigger one.
  isDefaultAdmin?: boolean
  canSeeAllTeams: boolean
  isAdmin: boolean
  memberships: { teamId: string; role: 'contributor' | 'leader' | 'team_admin' | 'admin' }[]
  // Page-access matrix from /auth/me. App admins get { '*': true }; everyone
  // else gets per-page keys derived from role_permissions table.
  permissions?: Record<string, boolean>
  workDays?: number
  workDayStartHour?: number
  workDayEndHour?: number
  workHoursPerDay?: Partial<Record<'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun', { start: number; end: number }>> | null
  workerType?: 'full_time' | 'part_time' | 'contractor'
  timezone?: string
  outlookWritebackEnabled?: boolean
  // v1.262.0: "Private meetings → Non-Activity" — see CLAUDE.md §7.
  privateMeetingsAsNonActivity?: boolean
  // v1.263.0: self-service Work & Notifications defaults (My Settings).
  defaultTeamId?: string | null
  defaultSubteamId?: string | null
  showFlightDeck?: boolean
  effectiveHourlyCostRate?: string | number | null
  sfInstanceUrl?: string | null
  // v1.364.0: the caller's own most recent successful login — powers the
  // sidebar user-pill's hover tooltip. Same reduction as the admin roster's
  // "Last Logged In" column (v1.318.0), just scoped to this one user.
  lastLoginAt?: string | null
}

export function clearCurrentUserCache() {
  cached = null
}

export function hasPermission(user: CurrentUser | null, pageKey: string): boolean {
  if (!user) return false
  if (user.isAppAdmin || user.isAdmin) return true
  const perms = user.permissions
  if (!perms) return true // legacy: no matrix yet → don't lock people out
  if (perms['*']) return true
  return perms[pageKey] === true
}

let cached: CurrentUser | null = null
let inflight: Promise<CurrentUser | null> | null = null

async function fetchCurrent(): Promise<CurrentUser | null> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = api.get<CurrentUser>('/auth/me').then((res) => {
    cached = res.data ?? null
    inflight = null
    return cached
  })
  return inflight
}

export function useCurrentUser(): { user: CurrentUser | null; loading: boolean } {
  const [user, setUser] = useState<CurrentUser | null>(cached)
  const [loading, setLoading] = useState(!cached)
  useEffect(() => {
    let mounted = true
    void fetchCurrent().then((u) => {
      if (mounted) {
        setUser(u)
        setLoading(false)
      }
    })
    return () => { mounted = false }
  }, [])
  return { user, loading }
}
