import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, Save, X, Users, RefreshCw, Building2 } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { OverridesPanel, type OverrideRow } from './CapacityGroupsConfig.js'
import { ROLE_TYPES, CURRENCIES } from './common-lists.js'

interface CostGroup {
  id: string
  name: string
  hourlyCostRate: string
  currency: string
  region: string | null
  roleType: string | null
  teamIds: string[]
}

interface Team { id: string; name: string; isActive: boolean }
interface UserRow { id: string; email: string; displayName: string }

interface Override {
  id: string
  userId: string
  teamId: string
  hourlyCostRate: string
  currency: string
  reason: string
  effectiveFrom: string
  effectiveTo: string | null
  userEmail: string
  userDisplayName: string
}

export function CostGroupsConfig() {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<CostGroup[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [overrides, setOverrides] = useState<Override[]>([])
  const [fxByCurrency, setFxByCurrency] = useState<Record<string, { ratePerUsd: number; asOf: string }>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  async function reload() {
    setLoading(true)
    const [g, tRes, u, o, fx] = await Promise.all([
      api.get<CostGroup[]>('/api/admin/cost-groups'),
      api.get<Team[]>('/api/admin/teams'),
      api.get<UserRow[]>('/api/admin/users'),
      api.get<Override[]>('/api/admin/cost-user-overrides'),
      api.get<Array<{ currency: string; ratePerUsd: number; asOf: string; source: string }>>('/api/admin/fx-rates'),
    ])
    setGroups(g.data ?? [])
    setTeams(tRes.data ?? [])
    setUsers(u.data ?? [])
    setOverrides(o.data ?? [])
    const fxMap: Record<string, { ratePerUsd: number; asOf: string }> = {}
    for (const r of fx.data ?? []) fxMap[r.currency] = { ratePerUsd: r.ratePerUsd, asOf: r.asOf }
    setFxByCurrency(fxMap)
    setLoading(false)
  }
  useEffect(() => { void reload() }, [])

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('admin.cost_groups.description', 'Set the hourly cost of an SE\'s time so revenue dashboards can compute ROI. Groups apply to any number of teams; per-user overrides can be dated for rate changes.')}</p>
        <div className="flex items-center gap-2">
          <FxRatesButton />
          <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
            <Plus className="mr-1 h-4 w-4" />
            {t('admin.cost_groups.add_group', 'Add cost group')}
          </Button>
        </div>
      </div>

      {creating && (
        <NewGroupForm onCreated={() => { setCreating(false); void reload() }} onCancel={() => setCreating(false)} />
      )}

      {groups.length === 0 && !creating && (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {t('admin.cost_groups.empty', 'No cost groups defined yet.')}
        </div>
      )}

      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          teams={teams}
          users={users}
          fxByCurrency={fxByCurrency}
          overrides={overrides.filter((o) => group.teamIds.includes(o.teamId))}
          onChanged={reload}
        />
      ))}
    </div>
  )
}

function FxRatesButton() {
  const { t } = useTranslation()
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState<{ asOf: string; count: number } | null>(null)
  const [rates, setRates] = useState<Array<{ currency: string; ratePerUsd: number; asOf: string; source: string }>>([])
  const [open, setOpen] = useState(false)

  async function loadRates() {
    const res = await api.get<Array<{ currency: string; ratePerUsd: number; asOf: string; source: string }>>('/api/admin/fx-rates')
    setRates(res.data ?? [])
  }
  useEffect(() => { if (open) void loadRates() }, [open])

  const [err, setErr] = useState<string | null>(null)
  async function refresh() {
    setRefreshing(true); setErr(null)
    const res = await api.post<{ inserted: number; asOf: string; source: string }>('/api/admin/fx-rates/refresh', {})
    setRefreshing(false)
    if (res.error) { setErr(res.error); return }
    if (res.data) {
      setStatus({ asOf: res.data.asOf, count: res.data.inserted })
      await loadRates()
    }
  }

  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
        <RefreshCw className="mr-1 h-3.5 w-3.5" />
        {t('admin.cost_groups.fx_rates', 'FX rates')}
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-80 rounded-md border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t('admin.cost_groups.fx_rates_title', 'Currency conversion rates')}</p>
            <Button size="sm" onClick={refresh} disabled={refreshing}>
              {refreshing ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3 w-3" />}
              {t('admin.cost_groups.fx_refresh', 'Refresh')}
            </Button>
          </div>
          <p className="mb-2 text-[10px] text-gray-500 dark:text-gray-400">
            {t('admin.cost_groups.fx_source', 'Rates from the European Central Bank (updated daily). All values shown as amount per 1 USD.')}
          </p>
          {(() => {
            const newestAsOf = rates.reduce((acc, r) => (acc && acc >= r.asOf ? acc : r.asOf), '' as string)
            const newestSource = rates.find((r) => r.asOf === newestAsOf)?.source
            return newestAsOf ? (
              <p className="mb-1 text-xs text-gray-600 dark:text-gray-400">
                {t('admin.cost_groups.fx_last_refresh', 'Last refresh: {{asOf}}', { asOf: newestAsOf })}
                {newestSource && <span className="ml-1 text-gray-400 dark:text-gray-500">· {newestSource}</span>}
              </p>
            ) : null
          })()}
          {err && <p className="mb-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{err}</p>}
          {status && <p className="mb-1 text-xs text-green-700 dark:text-green-400">{t('admin.cost_groups.fx_last_pull', 'Refreshed {{count}} rates as of {{asOf}}', status)}</p>}
          {rates.length === 0 ? (
            <p className="text-xs italic text-gray-400">{t('admin.cost_groups.fx_empty', 'No rates yet — click Refresh.')}</p>
          ) : (
            <div className="max-h-60 overflow-y-auto text-xs">
              {rates.map((r) => (
                <div key={r.currency} className="flex justify-between border-b border-gray-100 py-1 last:border-b-0 dark:border-gray-800">
                  <span className="font-mono text-gray-700 dark:text-gray-200">{r.currency}</span>
                  <span className="font-mono text-gray-600 dark:text-gray-400">{r.ratePerUsd.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NewGroupForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [rate, setRate] = useState('100')
  const [currency, setCurrency] = useState('USD')
  const [region, setRegion] = useState('')
  const [roleType, setRoleType] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    await api.post('/api/admin/cost-groups', {
      name,
      hourlyCostRate: Number(rate),
      currency,
      region: region || undefined,
      roleType: roleType || undefined,
    })
    setSaving(false)
    onCreated()
  }

  return (
    <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-3 grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1"><Label>{t('admin.cost_groups.name', 'Name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Americas SEs" /></div>
        <div className="flex flex-col gap-1"><Label>{t('admin.cost_groups.rate', 'Hourly rate')}</Label><Input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.cost_groups.currency', 'Currency')}</Label>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1"><Label>{t('admin.cost_groups.region', 'Region')}</Label><Input value={region} onChange={(e) => setRegion(e.target.value)} /></div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.cost_groups.role_type', 'Role type')}</Label>
          <Input value={roleType} onChange={(e) => setRoleType(e.target.value)} list="cost-group-role-types" />
          <datalist id="cost-group-role-types">
            {ROLE_TYPES.map((r) => <option key={r} value={r} />)}
          </datalist>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={saving || !name.trim() || !rate}>
          {saving && <Spinner className="mr-1 h-3 w-3" />}<Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
      </div>
    </div>
  )
}

function GroupCard({ group, teams, users, overrides, fxByCurrency, onChanged }: { group: CostGroup; teams: Team[]; users: UserRow[]; overrides: Override[]; fxByCurrency: Record<string, { ratePerUsd: number; asOf: string }>; onChanged: () => void }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const [rate, setRate] = useState(group.hourlyCostRate)
  const [currency, setCurrency] = useState(group.currency)
  const [region, setRegion] = useState(group.region ?? '')
  const [roleType, setRoleType] = useState(group.roleType ?? '')
  const [attachError, setAttachError] = useState<string | null>(null)

  async function saveEdit() {
    await api.patch(`/api/admin/cost-groups/${group.id}`, {
      name,
      hourlyCostRate: Number(rate),
      currency,
      region: region || null,
      roleType: roleType || null,
    })
    setEditing(false)
    onChanged()
  }

  async function del() {
    if (!window.confirm(t('admin.cost_groups.delete_confirm', 'Delete "{{name}}"?', { name: group.name }))) return
    await api.delete(`/api/admin/cost-groups/${group.id}`)
    onChanged()
  }

  async function attachTeam(teamId: string) {
    setAttachError(null)
    const res = await api.post<unknown>(`/api/admin/cost-groups/${group.id}/teams/${teamId}`, {})
    if (res.error) { setAttachError(res.error); return }
    onChanged()
  }
  async function detachTeam(teamId: string) {
    await api.delete(`/api/admin/cost-groups/${group.id}/teams/${teamId}`)
    onChanged()
  }

  const attachedTeams = teams.filter((tm) => group.teamIds.includes(tm.id))
  const availableTeams = teams.filter((tm) => tm.isActive && !group.teamIds.includes(tm.id))

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-start justify-between gap-4">
        {editing ? (
          <div className="grid flex-1 grid-cols-2 gap-3">
            <div className="flex flex-col gap-1"><Label>{t('admin.cost_groups.name', 'Name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="flex flex-col gap-1"><Label>{t('admin.cost_groups.rate', 'Hourly rate')}</Label><Input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.cost_groups.currency', 'Currency')}</Label>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
              </Select>
            </div>
            <div className="flex flex-col gap-1"><Label>{t('admin.cost_groups.region', 'Region')}</Label><Input value={region} onChange={(e) => setRegion(e.target.value)} /></div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.cost_groups.role_type', 'Role type')}</Label>
              <Input value={roleType} onChange={(e) => setRoleType(e.target.value)} list="cost-group-role-types" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{group.name}</p>
            <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
              {(() => {
                const rate = Number(group.hourlyCostRate)
                const fx = fxByCurrency[group.currency]
                const usdEquivalent = fx && fx.ratePerUsd > 0 ? rate / fx.ratePerUsd : null
                const tooltip = usdEquivalent != null
                  ? t('admin.cost_groups.usd_equivalent', '≈ USD {{value}} at 1 USD = {{fx}} {{currency}}', {
                      value: usdEquivalent.toFixed(2),
                      fx: fx!.ratePerUsd.toFixed(4),
                      currency: group.currency,
                    })
                  : t('admin.cost_groups.no_fx_yet', 'No FX rate cached — click FX rates → Refresh')
                return (
                  <span title={tooltip}>
                    {t('admin.cost_groups.rate', 'Rate')}: <strong>{group.currency} {rate.toFixed(2)}</strong>
                    {usdEquivalent != null && group.currency !== 'USD' && (
                      <span className="ml-1 text-gray-400">(≈ USD {usdEquivalent.toFixed(2)})</span>
                    )}
                  </span>
                )
              })()}
              {group.region && <span>{t('admin.cost_groups.region', 'Region')}: <strong>{group.region}</strong></span>}
              {group.roleType && <span>{t('admin.cost_groups.role_type', 'Role')}: <strong>{group.roleType}</strong></span>}
              {group.currency !== 'USD' && (() => {
                const fx = fxByCurrency[group.currency]
                if (!fx) return null
                return (
                  <span title={t('admin.cost_groups.fx_as_of', 'Rate as of {{asOf}}', { asOf: fx.asOf })} className="cursor-help border-b border-dotted border-gray-400 text-gray-500">
                    {t('admin.cost_groups.fx_short', 'FX')}: 1 USD = {fx.ratePerUsd.toFixed(4)} {group.currency}
                  </span>
                )
              })()}
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
            {t('admin.cost_groups.attached_teams', 'Attached teams')}
          </p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedTeams.length === 0 && <span className="text-xs italic text-gray-400">{t('admin.cost_groups.no_teams', 'No teams attached')}</span>}
            {attachedTeams.map((tm) => (
              <span key={tm.id} className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                <Building2 className="h-3 w-3 shrink-0" />
                {tm.name}
                <button onClick={() => detachTeam(tm.id)} className="hover:text-red-600"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Select value="" onChange={(e) => { if (e.target.value) void attachTeam(e.target.value) }} className="text-xs">
              <option value="">{t('admin.cost_groups.attach_team', 'Attach a team...')}</option>
              {availableTeams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </Select>
          </div>
          {attachError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{attachError}</p>}
        </div>

        <OverridesPanel
          type="cost"
          overrides={overrides as unknown as OverrideRow[]}
          users={users}
          attachedTeams={attachedTeams}
          onChanged={onChanged}
          valueField="hourlyCostRate"
          valueLabelKey="admin.cost_groups.rate"
          currencyField="currency"
        />
      </div>
    </div>
  )
}
