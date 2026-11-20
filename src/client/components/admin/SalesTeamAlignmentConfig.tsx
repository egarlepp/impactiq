import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ChevronDown, ChevronRight, Handshake, Pencil, X, Save } from 'lucide-react'
import { api } from '../../lib/api.js'
import { Spinner } from '../ui/spinner.js'
import { Chip } from '../ui/chip.js'
import { AsyncCombobox, type AsyncOption } from '../ui/async-combobox.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// Must match subteamAttribution.ts's UNASSIGNED_SUBTEAM_ID on the server —
// duplicated (not imported) since that module is server-side only. Same
// convention Team Activity Deep-Dive's client half already uses for its own
// synthetic "Unassigned" bucket.
const UNASSIGNED_KEY = '__unassigned__'

interface RosterRow {
  teamId: string
  teamName: string
  subteamId: string
  subteamName: string
  userId: string
  displayName: string
  email: string
  managerCount: number
  ownerCount: number
}

interface AlignmentDetail {
  managerIds: string[]
  ownerIds: string[]
  crmUsers: { id: string; name: string; email: string | null; managerId: string | null }[]
}

interface SfUserRow {
  id: string
  name: string
  email: string | null
  managerId: string | null
  isActive: boolean
}

interface Props {
  teamId: string
  globalView?: boolean
}

export function SalesTeamAlignmentConfig({ teamId, globalView }: Props) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const { user } = useCurrentUser()
  const [roster, setRoster] = useState<RosterRow[] | null>(null)
  const [search, setSearch] = useState('')
  const [unalignedFirst, setUnalignedFirst] = useState(true)
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set())
  const [expandedSubteams, setExpandedSubteams] = useState<Set<string>>(new Set())
  const [expandedUser, setExpandedUser] = useState<string | null>(null)
  const [detail, setDetail] = useState<AlignmentDetail | null>(null)
  const [managers, setManagers] = useState<AsyncOption[]>([])
  const [owners, setOwners] = useState<AsyncOption[]>([])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)

  async function reload() {
    const [rRes, sRes] = await Promise.all([
      api.get<RosterRow[]>(`/api/admin/sales-team-alignment/roster${teamId ? `?teamId=${teamId}` : ''}`),
      // Prime the cached-at chip by touching the sf-users endpoint.
      api.get<SfUserRow[]>('/api/admin/sf-users?q=&limit=1'),
    ])
    setRoster(rRes.data ?? [])
    const meta = sRes.meta as { lastSyncedAt?: string | null }
    setLastSyncedAt(meta?.lastSyncedAt ?? null)
  }

  useEffect(() => {
    void reload()
    // v1.320.0: re-fetch whenever the team scope changes (the header team
    // selector, mirroring User Management's globalView pattern).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, globalView])

  // v1.320.0: Team -> Subteam grouping (collapsible at both levels). The
  // Team level only renders in globalView — a single specific team has
  // nothing to group by at that tier, so its subteam groups render directly.
  // Search / "unaligned first" apply within each subteam's row list, and an
  // empty subteam group (everything filtered out) is hidden rather than
  // shown as an empty shell.
  const teamGroups = useMemo(() => {
    if (!roster) return []
    const q = search.trim().toLowerCase()
    const byTeam = new Map<string, { teamId: string; teamName: string; rows: RosterRow[] }>()
    for (const r of roster) {
      if (q && !r.displayName.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) continue
      const g = byTeam.get(r.teamId) ?? { teamId: r.teamId, teamName: r.teamName, rows: [] }
      g.rows.push(r)
      byTeam.set(r.teamId, g)
    }
    const sortRows = (rows: RosterRow[]) => {
      const sorted = rows.slice()
      if (unalignedFirst) {
        sorted.sort((a, b) => {
          const sa = a.managerCount + a.ownerCount
          const sb = b.managerCount + b.ownerCount
          if (sa === 0 && sb !== 0) return -1
          if (sa !== 0 && sb === 0) return 1
          return a.displayName.localeCompare(b.displayName)
        })
      } else {
        sorted.sort((a, b) => a.displayName.localeCompare(b.displayName))
      }
      return sorted
    }
    const bySubteam = (rows: RosterRow[]) => {
      const map = new Map<string, { subteamId: string; subteamName: string; rows: RosterRow[] }>()
      for (const r of rows) {
        const g = map.get(r.subteamId) ?? { subteamId: r.subteamId, subteamName: r.subteamName, rows: [] }
        g.rows.push(r)
        map.set(r.subteamId, g)
      }
      return Array.from(map.values())
        .map((g) => ({ ...g, rows: sortRows(g.rows) }))
        .filter((g) => g.rows.length > 0)
        .sort((a, b) => {
          if (a.subteamId === UNASSIGNED_KEY) return 1
          if (b.subteamId === UNASSIGNED_KEY) return -1
          return a.subteamName.localeCompare(b.subteamName)
        })
    }
    return Array.from(byTeam.values())
      .map((g) => ({ teamId: g.teamId, teamName: g.teamName, subteams: bySubteam(g.rows), memberCount: g.rows.length }))
      .filter((g) => g.subteams.length > 0)
      .sort((a, b) => a.teamName.localeCompare(b.teamName))
  }, [roster, search, unalignedFirst])

  function toggleTeam(id: string) {
    setExpandedTeams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleSubteam(id: string) {
    setExpandedSubteams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function toggleExpandUser(userId: string) {
    if (expandedUser === userId) { setExpandedUser(null); return }
    setExpandedUser(userId)
    setDetail(null); setManagers([]); setOwners([])
    const res = await api.get<AlignmentDetail>(`/api/admin/users/${userId}/sf-alignment`)
    const d = res.data
    if (!d) return
    setDetail(d)
    const byId = new Map(d.crmUsers.map((u) => [u.id, u]))
    setManagers(d.managerIds.map((id) => {
      const u = byId.get(id)
      return { id, label: u?.name ?? id, subLabel: u?.email ?? undefined }
    }))
    setOwners(d.ownerIds.map((id) => {
      const u = byId.get(id)
      return { id, label: u?.name ?? id, subLabel: u?.email ?? undefined }
    }))
  }

  async function fetchSfOptions(q: string): Promise<AsyncOption[]> {
    const res = await api.get<SfUserRow[]>(`/api/admin/sf-users?q=${encodeURIComponent(q)}&limit=50`)
    return (res.data ?? []).map((r) => ({ id: r.id, label: r.name, subLabel: r.email ?? undefined }))
  }

  async function saveAlignment(userId: string) {
    setSavingId(userId)
    const res = await api.put<{ managerIds: string[]; ownerIds: string[] }>(`/api/admin/users/${userId}/sf-alignment`, {
      managerIds: managers.map((m) => m.id),
      ownerIds: owners.map((o) => o.id),
    })
    setSavingId(null)
    if (res.error) return
    setRoster((prev) => (prev ?? []).map((r) => (r.userId === userId ? { ...r, managerCount: managers.length, ownerCount: owners.length } : r)))
    setExpandedUser(null)
  }

  async function syncFromCrm() {
    setSyncing(true); setSyncMsg(null)
    const res = await api.post<{ upserted: number }>('/api/admin/salesforce/sync-users', {})
    setSyncing(false)
    if (res.error) {
      setSyncMsg(t('admin.sales_team_alignment.sync_failure', { error: res.error.startsWith('errors.') ? t(res.error) : res.error }))
    } else {
      setSyncMsg(t('admin.sales_team_alignment.sync_success', { count: res.data?.upserted ?? 0, context: crmCtx }))
      setLastSyncedAt(new Date().toISOString())
    }
  }

  if (!roster) return <div className="flex justify-center py-12"><Spinner className="h-5 w-5" /></div>

  function displaySubteamName(name: string, id: string): string {
    return id === UNASSIGNED_KEY ? t('admin.sales_team_alignment.unassigned', 'Unassigned') : name
  }

  function renderUserRow(u: RosterRow) {
    const isOpen = expandedUser === u.userId
    return (
      <div key={u.userId} className="border-b border-gray-100 last:border-b-0 dark:border-gray-900">
        <div className="grid grid-cols-[1fr_1fr_100px_100px_120px] items-center gap-2 px-3 py-2">
          <span className="font-medium text-gray-900 dark:text-gray-100">{u.displayName}</span>
          <span className="text-gray-600 dark:text-gray-400">{u.email}</span>
          <span className="text-right tabular-nums">{u.managerCount}</span>
          <span className="text-right tabular-nums">{u.ownerCount}</span>
          <span className="text-right">
            <button
              type="button"
              onClick={() => void toggleExpandUser(u.userId)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-900 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              {isOpen ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
              {isOpen ? t('common.close') : t('admin.sales_team_alignment.edit')}
            </button>
          </span>
        </div>
        {isOpen && (
          <div className="border-t border-gray-100 bg-gray-50 px-3 py-3 dark:border-gray-900 dark:bg-gray-900/50">
            {!detail ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.sales_team_alignment.managers_label', { context: crmCtx })}
                  </label>
                  <AsyncCombobox
                    value={managers}
                    onChange={setManagers}
                    fetchOptions={fetchSfOptions}
                    placeholder={t('admin.sales_team_alignment.search_sf_users', { context: crmCtx })}
                    emptyHint={t('admin.sales_team_alignment.no_matches', { context: crmCtx })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.sales_team_alignment.owners_label', { context: crmCtx })}
                  </label>
                  <AsyncCombobox
                    value={owners}
                    onChange={setOwners}
                    fetchOptions={fetchSfOptions}
                    placeholder={t('admin.sales_team_alignment.search_sf_users', { context: crmCtx })}
                    emptyHint={t('admin.sales_team_alignment.no_matches', { context: crmCtx })}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setExpandedUser(null)}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-900 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
                  >
                    <X className="h-3 w-3" />
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveAlignment(u.userId)}
                    disabled={savingId === u.userId}
                    className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    <Save className="h-3 w-3" />
                    {t('admin.sales_team_alignment.save')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderSubteamGroup(sub: { subteamId: string; subteamName: string; rows: RosterRow[] }, key: string) {
    const isOpen = expandedSubteams.has(key)
    return (
      <div key={key} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
        <button
          type="button"
          onClick={() => toggleSubteam(key)}
          className="flex w-full items-center gap-2 bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-800 dark:bg-gray-900 dark:text-gray-200"
        >
          {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          {displaySubteamName(sub.subteamName, sub.subteamId)}
          <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            {sub.rows.length}
          </span>
        </button>
        {isOpen && (
          <div className="bg-white dark:bg-gray-950">
            <div className="grid grid-cols-[1fr_1fr_100px_100px_120px] gap-2 border-b border-gray-100 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-gray-400 dark:border-gray-900 dark:text-gray-500">
              <span>{t('admin.sales_team_alignment.col_name')}</span>
              <span>{t('admin.sales_team_alignment.col_email')}</span>
              <span className="text-right">{t('admin.sales_team_alignment.col_managers')}</span>
              <span className="text-right">{t('admin.sales_team_alignment.col_owners')}</span>
              <span></span>
            </div>
            {sub.rows.map(renderUserRow)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
        <Handshake className="h-4 w-4" />
        {t('admin.sales_team_alignment.description', { context: crmCtx })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('admin.sales_team_alignment.search_placeholder')}
          className="flex-1 min-w-[16rem] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={unalignedFirst} onChange={(e) => setUnalignedFirst(e.target.checked)} />
          {t('admin.sales_team_alignment.unaligned_first')}
        </label>
        {/* v1.320.0: the org-wide Salesforce sync is App-Admin-only server-
            side (shared admin SF connection, same convention as every other
            tenant-wide refresh action) — hidden here rather than shown and
            then 403ing on click for a team_admin. */}
        {user?.isAppAdmin && (
          <button
            type="button"
            onClick={syncFromCrm}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            <RefreshCw className={syncing ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
            {t('admin.sales_team_alignment.refresh_button', { context: crmCtx })}
          </button>
        )}
        {lastSyncedAt && (
          <Chip variant="neutral" size="xs">
            {t('admin.sales_team_alignment.cached_as_of', { when: new Date(lastSyncedAt).toLocaleString(), context: crmCtx })}
          </Chip>
        )}
      </div>
      {syncMsg && <p className="text-xs text-gray-600 dark:text-gray-400">{syncMsg}</p>}

      {teamGroups.length === 0 && (
        <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.sales_team_alignment.empty', 'No matching users.')}</p>
      )}

      <div className="space-y-3">
        {teamGroups.map((team) => {
          if (!globalView) {
            // A single specific team has nothing to group by at the Team
            // tier — render its Subteam groups directly, same as the
            // multi-team case minus the redundant outer shell.
            return <div key={team.teamId} className="space-y-2">{team.subteams.map((sub) => renderSubteamGroup(sub, `${team.teamId}|${sub.subteamId}`))}</div>
          }
          const isOpen = expandedTeams.has(team.teamId)
          return (
            <div key={team.teamId} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
              <button
                type="button"
                onClick={() => toggleTeam(team.teamId)}
                className="flex w-full items-center gap-2 bg-gray-100 px-3 py-2.5 text-left text-sm font-semibold text-gray-900 dark:bg-gray-800 dark:text-gray-100"
              >
                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                {team.teamName}
                <span className="rounded-full bg-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-600 dark:text-gray-200">
                  {team.memberCount}
                </span>
              </button>
              {isOpen && (
                <div className="space-y-2 bg-gray-50/50 p-2 dark:bg-gray-900/30">
                  {team.subteams.map((sub) => renderSubteamGroup(sub, `${team.teamId}|${sub.subteamId}`))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
