import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, Save, X, CalendarClock, Users, Building2 } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { ROLE_TYPES, CURRENCIES } from './common-lists.js'

interface CapacityGroup {
  id: string
  name: string
  targetHoursPerWeek: string | null
  capacityMethod: 'fixed_hours' | 'self_declared' | 'exception_adjusted' | 'calendar_derived'
  region: string | null
  roleType: string | null
  teamIds: string[]
  // v1.225.0: admin opt-in, independent of capacityMethod — shows the
  // calendar-derived "Meeting Load" figure on leader dashboards for this
  // group's members. See CLAUDE.md §12.
  showRealMeetingLoad: boolean
}

interface Team { id: string; name: string; isActive: boolean }
interface UserRow { id: string; email: string; displayName: string }

interface Override {
  id: string
  userId: string
  teamId: string
  targetHoursPerWeek: string
  reason: string
  effectiveFrom: string
  effectiveTo: string | null
  userEmail: string
  userDisplayName: string
}

const METHOD_LABELS: Record<string, string> = {
  fixed_hours: 'admin.capacity_groups.method_fixed',
  self_declared: 'admin.capacity_groups.method_self_declared',
  exception_adjusted: 'admin.capacity_groups.method_exception',
  calendar_derived: 'admin.capacity_groups.method_calendar_derived',
}

const REASON_OPTIONS = ['pto', 'ramp', 'rotation', 'reduced', 'special_project', 'other'] as const

export function CapacityGroupsConfig() {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<CapacityGroup[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [overrides, setOverrides] = useState<Override[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  async function reload() {
    setLoading(true)
    const [g, tRes, u, o] = await Promise.all([
      api.get<CapacityGroup[]>('/api/admin/capacity-groups'),
      api.get<Team[]>('/api/admin/teams'),
      api.get<UserRow[]>('/api/admin/users'),
      api.get<Override[]>('/api/admin/capacity-user-overrides'),
    ])
    setGroups(g.data ?? [])
    setTeams(tRes.data ?? [])
    setUsers(u.data ?? [])
    setOverrides(o.data ?? [])
    setLoading(false)
  }

  useEffect(() => { void reload() }, [])

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('admin.capacity_groups.description', 'Group your teams under shared weekly-hour targets. Add per-user overrides for time-scoped exceptions (PTO, ramp, rotations).')}</p>
        <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
          <Plus className="mr-1 h-4 w-4" />
          {t('admin.capacity_groups.add_group')}
        </Button>
      </div>

      {creating && (
        <NewGroupForm onCreated={() => { setCreating(false); void reload() }} onCancel={() => setCreating(false)} />
      )}

      {groups.length === 0 && !creating && (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {t('admin.capacity_groups.empty')}
        </div>
      )}

      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          teams={teams}
          users={users}
          overrides={overrides.filter((o) => group.teamIds.includes(o.teamId))}
          onChanged={reload}
        />
      ))}
    </div>
  )
}

function NewGroupForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [hours, setHours] = useState('30')
  const [method, setMethod] = useState<'fixed_hours' | 'self_declared' | 'exception_adjusted' | 'calendar_derived'>('fixed_hours')
  const [region, setRegion] = useState('')
  const [roleType, setRoleType] = useState('')
  const [showRealMeetingLoad, setShowRealMeetingLoad] = useState(false)
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    await api.post('/api/admin/capacity-groups', {
      name,
      targetHoursPerWeek: Number(hours) || undefined,
      capacityMethod: method,
      region: region || undefined,
      roleType: roleType || undefined,
      showRealMeetingLoad,
    })
    setSaving(false)
    onCreated()
  }

  return (
    <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-3 grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1"><Label>{t('admin.capacity_groups.name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Americas SEs" /></div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.capacity_groups.target_hours')}</Label>
          <Input type="number" min="0" max="168" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
          {method === 'calendar_derived' && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.capacity_groups.calendar_derived_help')}</p>
          )}
        </div>
        <div className="flex flex-col gap-1"><Label>{t('admin.capacity_groups.method')}</Label>
          <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="fixed_hours">{t('admin.capacity_groups.method_fixed')}</option>
            <option value="self_declared">{t('admin.capacity_groups.method_self_declared')}</option>
            <option value="exception_adjusted">{t('admin.capacity_groups.method_exception')}</option>
            <option value="calendar_derived">{t('admin.capacity_groups.method_calendar_derived')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1"><Label>{t('admin.capacity_groups.region')}</Label><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="EMEA / APAC / Americas" /></div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.capacity_groups.role_type')}</Label>
          <Input value={roleType} onChange={(e) => setRoleType(e.target.value)} placeholder="SE / FDE" list="capacity-group-role-types" />
          <datalist id="capacity-group-role-types">
            {ROLE_TYPES.map((r) => <option key={r} value={r} />)}
          </datalist>
        </div>
        <label className="col-span-2 flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
          <input type="checkbox" className="mt-0.5" checked={showRealMeetingLoad} onChange={(e) => setShowRealMeetingLoad(e.target.checked)} />
          <span>
            <span className="flex items-center gap-1 font-medium"><CalendarClock className="h-3.5 w-3.5" />{t('admin.capacity_groups.show_real_meeting_load')}</span>
            <span className="text-gray-500 dark:text-gray-400">{t('admin.capacity_groups.show_real_meeting_load_hint')}</span>
          </span>
        </label>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={saving || !name.trim()}>
          {saving && <Spinner className="mr-1 h-3 w-3" />}<Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
      </div>
    </div>
  )
}

function GroupCard({ group, teams, users, overrides, onChanged }: { group: CapacityGroup; teams: Team[]; users: UserRow[]; overrides: Override[]; onChanged: () => void }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const [hours, setHours] = useState(group.targetHoursPerWeek ?? '30')
  const [method, setMethod] = useState(group.capacityMethod)
  const [region, setRegion] = useState(group.region ?? '')
  const [roleType, setRoleType] = useState(group.roleType ?? '')
  const [showRealMeetingLoad, setShowRealMeetingLoad] = useState(group.showRealMeetingLoad)
  const [attachError, setAttachError] = useState<string | null>(null)

  async function saveEdit() {
    await api.patch(`/api/admin/capacity-groups/${group.id}`, {
      name,
      targetHoursPerWeek: Number(hours) || null,
      capacityMethod: method,
      region: region || null,
      roleType: roleType || null,
      showRealMeetingLoad,
    })
    setEditing(false)
    onChanged()
  }

  async function del() {
    if (!window.confirm(t('admin.capacity_groups.delete_confirm', { name: group.name }))) return
    await api.delete(`/api/admin/capacity-groups/${group.id}`)
    onChanged()
  }

  async function attachTeam(teamId: string) {
    setAttachError(null)
    const res = await api.post<unknown>(`/api/admin/capacity-groups/${group.id}/teams/${teamId}`, {})
    if (res.error) { setAttachError(res.error); return }
    onChanged()
  }

  async function detachTeam(teamId: string) {
    await api.delete(`/api/admin/capacity-groups/${group.id}/teams/${teamId}`)
    onChanged()
  }

  const attachedTeams = teams.filter((t) => group.teamIds.includes(t.id))
  const availableTeams = teams.filter((t) => t.isActive && !group.teamIds.includes(t.id))

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-start justify-between gap-4">
        {editing ? (
          <div className="grid flex-1 grid-cols-2 gap-3">
            <div className="flex flex-col gap-1"><Label>{t('admin.capacity_groups.name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.capacity_groups.target_hours')}</Label>
              <Input type="number" min="0" max="168" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
              {method === 'calendar_derived' && (
                <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.capacity_groups.calendar_derived_help')}</p>
              )}
            </div>
            <div className="flex flex-col gap-1"><Label>{t('admin.capacity_groups.method')}</Label>
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="fixed_hours">{t('admin.capacity_groups.method_fixed')}</option>
                <option value="self_declared">{t('admin.capacity_groups.method_self_declared')}</option>
                <option value="exception_adjusted">{t('admin.capacity_groups.method_exception')}</option>
                <option value="calendar_derived">{t('admin.capacity_groups.method_calendar_derived')}</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1"><Label>{t('admin.capacity_groups.region')}</Label><Input value={region} onChange={(e) => setRegion(e.target.value)} /></div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.capacity_groups.role_type')}</Label>
              <Input value={roleType} onChange={(e) => setRoleType(e.target.value)} list="capacity-group-role-types" />
            </div>
            <label className="col-span-2 flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
              <input type="checkbox" className="mt-0.5" checked={showRealMeetingLoad} onChange={(e) => setShowRealMeetingLoad(e.target.checked)} />
              <span>
                <span className="flex items-center gap-1 font-medium"><CalendarClock className="h-3.5 w-3.5" />{t('admin.capacity_groups.show_real_meeting_load')}</span>
                <span className="text-gray-500 dark:text-gray-400">{t('admin.capacity_groups.show_real_meeting_load_hint')}</span>
              </span>
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{group.name}</p>
            <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span>{t('admin.capacity_groups.target_hours')}: <strong>{group.targetHoursPerWeek ?? '—'}</strong></span>
              <span>{t('admin.capacity_groups.method')}: <strong>{t(METHOD_LABELS[group.capacityMethod] ?? group.capacityMethod)}</strong></span>
              {group.region && <span>{t('admin.capacity_groups.region')}: <strong>{group.region}</strong></span>}
              {group.roleType && <span>{t('admin.capacity_groups.role_type')}: <strong>{group.roleType}</strong></span>}
              {group.showRealMeetingLoad && (
                <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400"><CalendarClock className="h-3.5 w-3.5" />{t('admin.capacity_groups.show_real_meeting_load')}</span>
              )}
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button size="sm" onClick={saveEdit}><Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}</Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}><X className="h-3.5 w-3.5" /></Button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} className="rounded p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil className="h-4 w-4" /></button>
              <button onClick={del} className="rounded p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <Users className="h-3.5 w-3.5" />
            {t('admin.capacity_groups.attached_teams', 'Attached teams')}
          </p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedTeams.length === 0 && <span className="text-xs italic text-gray-400">{t('admin.capacity_groups.no_teams', 'No teams attached')}</span>}
            {attachedTeams.map((tm) => (
              <span key={tm.id} className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300">
                <Building2 className="h-3 w-3 shrink-0" />
                {tm.name}
                <button onClick={() => detachTeam(tm.id)} className="hover:text-red-600"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Select value="" onChange={(e) => { if (e.target.value) void attachTeam(e.target.value) }} className="text-xs">
              <option value="">{t('admin.capacity_groups.attach_team', 'Attach a team...')}</option>
              {availableTeams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </Select>
          </div>
          {attachError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{attachError}</p>}
        </div>

        <OverridesPanel
          type="capacity"
          overrides={overrides as unknown as OverrideRow[]}
          users={users}
          attachedTeams={attachedTeams}
          onChanged={onChanged}
        />
      </div>
    </div>
  )
}

// Shared overrides panel used by both capacity + cost. `type` controls
// which endpoint the writes hit and which value column is edited.
export type OverrideRow = { id: string; userId: string; teamId: string; reason: string; effectiveFrom: string; effectiveTo: string | null; userDisplayName: string; userEmail: string } & Record<string, unknown>
export function OverridesPanel({
  type,
  overrides,
  users,
  attachedTeams,
  onChanged,
  valueField = 'targetHoursPerWeek',
  valueLabelKey = 'admin.capacity_groups.target_hours',
  currencyField,
}: {
  type: 'capacity' | 'cost'
  overrides: OverrideRow[]
  users: UserRow[]
  attachedTeams: Team[]
  onChanged: () => void
  valueField?: string
  valueLabelKey?: string
  currencyField?: string
}) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [reason, setReason] = useState<string>('pto')
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10))
  const [to, setTo] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const today = new Date().toISOString().slice(0, 10)

  const endpoint = type === 'capacity' ? '/api/admin/capacity-user-overrides' : '/api/admin/cost-user-overrides'

  async function save() {
    setErr(null)
    const body: Record<string, unknown> = { userId, teamId, reason, effectiveFrom: from, effectiveTo: to || null }
    if (type === 'capacity') body['targetHoursPerWeek'] = Number(value)
    else { body['hourlyCostRate'] = Number(value); body['currency'] = currency }
    const res = await api.post<unknown>(endpoint, body)
    if (res.error) { setErr(res.error); return }
    setAdding(false)
    setUserId(''); setTeamId(''); setValue(''); setReason('pto'); setTo(''); setFrom(today)
    onChanged()
  }

  async function del(id: string) {
    await api.delete(`${endpoint}/${id}`)
    onChanged()
  }

  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        <CalendarClock className="h-3.5 w-3.5" />
        {t('admin.capacity_groups.overrides.title', 'User overrides')}
      </p>
      <div className="mb-2 flex flex-col gap-1">
        {overrides.length === 0 && <span className="text-xs italic text-gray-400">{t('admin.capacity_groups.overrides.empty', 'No overrides')}</span>}
        {overrides.map((o) => {
          const active = o.effectiveFrom <= today && (!o.effectiveTo || today < o.effectiveTo)
          return (
            <div key={o.id} className={`flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs ${active ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30' : 'border-gray-200 dark:border-gray-700'}`}>
              <div className="flex flex-col">
                <span className="text-gray-700 dark:text-gray-200">
                  <strong>{o.userDisplayName}</strong> · {String(o[valueField] ?? '')}{type === 'cost' && currencyField ? ` ${String(o[currencyField] ?? '')}` : type === 'capacity' ? 'h' : ''}
                  <span className="ml-2 rounded bg-gray-100 px-1.5 text-[10px] uppercase dark:bg-gray-800">{o.reason}</span>
                </span>
                <span className="text-[10px] text-gray-500 dark:text-gray-400">{o.effectiveFrom} → {o.effectiveTo ?? t('admin.capacity_groups.overrides.open_ended', 'open')}</span>
              </div>
              <button onClick={() => del(o.id)} className="text-gray-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          )
        })}
      </div>
      {adding ? (
        <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/50">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <select value={userId} onChange={(e) => setUserId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
              <option value="">{t('admin.capacity_groups.overrides.user', 'User')}</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
              <option value="">{t('admin.capacity_groups.overrides.team', 'Team')}</option>
              {attachedTeams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
            <input type="number" placeholder={t(valueLabelKey)} value={value} onChange={(e) => setValue(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
            {type === 'cost' && (
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            )}
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
              {REASON_OPTIONS.map((r) => <option key={r} value={r}>{t(`admin.capacity_groups.overrides.reason_options.${r}`, r)}</option>)}
            </select>
            <div className="col-span-2 grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('admin.capacity_groups.overrides.start_date', 'Start date')}
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 text-xs normal-case text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <span>{t('admin.capacity_groups.overrides.end_date', 'End date')} <span className="normal-case text-gray-400">({t('admin.capacity_groups.overrides.open_ended', 'open')})</span></span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 text-xs normal-case text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
              </label>
            </div>
          </div>
          {err && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
          <div className="mt-2 flex gap-1">
            <Button size="sm" onClick={save} disabled={!userId || !teamId || !value}><Save className="mr-1 h-3 w-3" />{t('common.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setErr(null) }}><X className="h-3 w-3" /></Button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          + {t('admin.capacity_groups.overrides.add', 'Add override')}
        </button>
      )}
    </div>
  )
}

// Silence unused import warning; useMemo is available for future ergonomic
// selectors (e.g. resolving current effective value for each user).
void useMemo
