import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'

export interface TeamMembership {
  id: string
  name: string
  slug: string
  icon?: string | null
  role: 'contributor' | 'leader' | 'admin'
  // Team-level work-week defaults. Used by admin create-user form to pre-fill.
  defaultWorkerType?: 'full_time' | 'part_time' | 'contractor'
  defaultWorkDays?: number
  defaultWorkDayStartHour?: number
  defaultWorkDayEndHour?: number
  // v1.256.0: team-wide kill switch for the Subtype picker on the Log
  // Activity form and Activity Templates. Off by default.
  subtypesEnabled?: boolean
}

// v1.255.0/1.256.0: a Subtype under a given activity type (e.g. Discovery
// -> Technical Discovery). Fetched in bulk alongside activityTypes below
// and grouped by teamActivityTypeId — mirrors Guide.tsx's own fetch of
// the same endpoint, centralized here so ActivityForm/TemplatesSection
// don't each duplicate the request.
export interface ActivityTypeSubtype {
  id: string
  teamActivityTypeId: string
  name: string
  sortOrder: number
}

export interface ActivityType {
  id: string
  teamId: string | null
  name: string
  crmObjectType: 'Event' | 'Task'
  isActive: boolean
  sortOrder: number
  color?: string | null
  icon?: string | null
  // v1.255.0: Guide fields, read-only reference content — see Guide.tsx.
  useThisWhen?: string | null
  usuallyAttachTo?: string | null
  examples?: string | null
}

export const ALL_TEAMS_ID = '__all__'

export interface ActiveSelection {
  // Either a team ID (single team) or ALL_TEAMS_ID for the consolidated view.
  id: string
  name: string
  icon?: string | null
  role: 'contributor' | 'leader' | 'admin'
  isAll: boolean
}

interface TeamContextValue {
  teams: TeamMembership[]
  active: ActiveSelection | null
  setActive: (selection: ActiveSelection) => void
  // Legacy compat aliases — `activeTeam` is the single-team selection or null
  // when the user has picked "All Teams". Most pre-existing pages use these.
  activeTeam: TeamMembership | null
  setActiveTeam: (team: TeamMembership) => void
  canSeeAll: boolean
  loading: boolean
  reloadTeams: () => Promise<void>
  activityTypes: ActivityType[]
  // v1.256.0: Subtypes for the active team's activity types, grouped by
  // teamActivityTypeId. Empty for every type until an admin adds Subtypes
  // AND turns Subtypes on for the team (activeTeam.subtypesEnabled).
  subtypesByTypeId: Record<string, ActivityTypeSubtype[]>
}

const STORAGE_KEY = 'active_team_id'

const TeamContext = createContext<TeamContextValue | null>(null)

function buildSelection(teams: TeamMembership[], id: string | null, canSeeAll: boolean): ActiveSelection | null {
  if (canSeeAll && id === ALL_TEAMS_ID) {
    return { id: ALL_TEAMS_ID, name: 'All Teams', icon: null, role: 'admin', isAll: true }
  }
  if (id) {
    const found = teams.find((t) => t.id === id)
    if (found) return { id: found.id, name: found.name, icon: found.icon, role: found.role, isAll: false }
  }
  const first = teams[0]
  if (!first) return null
  return { id: first.id, name: first.name, icon: first.icon, role: first.role, isAll: false }
}

export function TeamProvider({ children }: { children: React.ReactNode }) {
  const [teams, setTeams] = useState<TeamMembership[]>([])
  const [active, setActiveState] = useState<ActiveSelection | null>(null)
  const [canSeeAll, setCanSeeAll] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([])
  const [subtypesByTypeId, setSubtypesByTypeId] = useState<Record<string, ActivityTypeSubtype[]>>({})

  const reloadTeams = useCallback(async () => {
    try {
      const res = await api.get<TeamMembership[]>('/api/teams')
      const list = res.data ?? []
      const all = !!(res.meta as { canSeeAll?: boolean } | undefined)?.canSeeAll
      setTeams(list)
      setCanSeeAll(all)
      setActiveState((current) => {
        const stored = localStorage.getItem(STORAGE_KEY)
        return buildSelection(list, current?.id ?? stored, all)
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reloadTeams() }, [reloadTeams])

  useEffect(() => {
    if (!active || active.isAll) {
      setActivityTypes([])
      setSubtypesByTypeId({})
      return
    }
    api.get<ActivityType[]>(`/api/teams/${active.id}/activity-types`).then((res) => {
      if (res.data) setActivityTypes(res.data)
    })
    // v1.256.0: fetched alongside activityTypes so the Log Activity form
    // and Activity Templates can look up a chosen type's Subtypes with no
    // extra round-trip of their own.
    api.get<ActivityTypeSubtype[]>(`/api/teams/${active.id}/activity-type-subtypes`).then((res) => {
      const grouped: Record<string, ActivityTypeSubtype[]> = {}
      for (const row of res.data ?? []) {
        (grouped[row.teamActivityTypeId] ??= []).push(row)
      }
      setSubtypesByTypeId(grouped)
    })
  }, [active])

  const setActive = useCallback((selection: ActiveSelection) => {
    localStorage.setItem(STORAGE_KEY, selection.id)
    setActiveState(selection)
  }, [])

  const activeTeam = useMemo<TeamMembership | null>(() => {
    if (!active || active.isAll) return null
    return teams.find((t) => t.id === active.id) ?? null
  }, [active, teams])

  const setActiveTeam = useCallback((team: TeamMembership) => {
    const selection: ActiveSelection = {
      id: team.id,
      name: team.name,
      icon: team.icon,
      role: team.role,
      isAll: false,
    }
    localStorage.setItem(STORAGE_KEY, team.id)
    setActiveState(selection)
  }, [])

  const value = useMemo<TeamContextValue>(
    () => ({ teams, active, setActive, activeTeam, setActiveTeam, canSeeAll, loading, reloadTeams, activityTypes, subtypesByTypeId }),
    [teams, active, setActive, activeTeam, setActiveTeam, canSeeAll, loading, reloadTeams, activityTypes, subtypesByTypeId],
  )

  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>
}

export function useTeam(): TeamContextValue {
  const ctx = useContext(TeamContext)
  if (!ctx) throw new Error('useTeam must be used within a TeamProvider')
  return ctx
}
