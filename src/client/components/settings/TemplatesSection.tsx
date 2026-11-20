import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Save, X, Wifi, MapPin } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Textarea } from '../ui/textarea.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { useTeam } from '../../hooks/useTeam.js'
import { useTeamProducts } from '../../hooks/useProducts.js'
import { cn } from '../../lib/utils.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import type { ActivityType } from '../../store/team.js'

interface TemplateRow {
  id: string
  name: string
  titleTemplate: string
  notesTemplate: string | null
  effortHoursDefault: string | null
  locationModeDefault: string | null
  activityTypeId: string | null
  // v1.256.0: pre-fills the Log Activity form's Subtype picker when this
  // template is applied. Never written to Salesforce.
  subtypeId: string | null
  productIds: string[] | null
  teamId: string | null
}

interface FormState {
  name: string
  titleTemplate: string
  notesTemplate: string
  effortHoursDefault: string
  activityTypeId: string
  subtypeId: string
  locationMode: 'remote' | 'onsite'
  productIds: string[]
  teamId: string
}

const empty: FormState = { name: '', titleTemplate: '', notesTemplate: '', effortHoursDefault: '', activityTypeId: '', subtypeId: '', locationMode: 'remote', productIds: [], teamId: '' }

export function TemplatesSection() {
  const { t } = useTranslation()
  const { activeTeam, teams, activityTypes, subtypesByTypeId } = useTeam()
  const [rows, setRows] = useState<TemplateRow[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(empty)
  const [saving, setSaving] = useState(false)
  // Products are team-scoped; refresh whenever the template's target team changes.
  const teamProducts = useTeamProducts(form.teamId || activeTeam?.id || null)
  // v1.256.0: subtypesByTypeId (like activityTypes above) is scoped to the
  // sidebar's active team, so this only resolves correctly when the
  // template's own team picker matches it — same pre-existing scope as
  // the Activity Type picker below. subtypesEnabled is a real per-team
  // flag, so it's looked up on the template's OWN team when set.
  const subtypesEnabled = !!teams.find((tm) => tm.id === (form.teamId || activeTeam?.id))?.subtypesEnabled
  const currentSubtypes = subtypesByTypeId[form.activityTypeId] ?? []
  const showTemplateSubtype = subtypesEnabled && currentSubtypes.length > 0

  async function reload() {
    const res = await api.get<TemplateRow[]>('/api/templates')
    setRows(res.data ?? [])
  }
  useEffect(() => { void reload() }, [])

  function openCreate() {
    setForm({ ...empty, teamId: activeTeam?.id ?? '' })
    setCreating(true); setEditingId(null)
  }
  function openEdit(r: TemplateRow) {
    setForm({
      name: r.name,
      titleTemplate: r.titleTemplate,
      notesTemplate: r.notesTemplate ?? '',
      effortHoursDefault: r.effortHoursDefault ?? '',
      activityTypeId: r.activityTypeId ?? '',
      subtypeId: r.subtypeId ?? '',
      locationMode: (r.locationModeDefault as 'remote' | 'onsite') ?? 'remote',
      productIds: r.productIds ?? [],
      teamId: r.teamId ?? activeTeam?.id ?? '',
    })
    setEditingId(r.id)
    setCreating(false)
  }
  function cancel() { setCreating(false); setEditingId(null); setForm(empty) }

  async function submit() {
    setSaving(true)
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      titleTemplate: form.titleTemplate.trim(),
      teamId: form.teamId || null,
      activityTypeId: form.activityTypeId || null,
      subtypeId: form.subtypeId || null,
      locationModeDefault: form.locationMode,
      productIds: form.productIds,
    }
    if (form.notesTemplate.trim()) body['notesTemplate'] = form.notesTemplate.trim()
    if (form.effortHoursDefault.trim()) {
      const n = Number(form.effortHoursDefault)
      if (Number.isFinite(n) && n >= 0 && n <= 24) body['effortHoursDefault'] = n
    }
    if (editingId) await api.patch(`/api/templates/${editingId}`, body)
    else await api.post('/api/templates', body)
    setSaving(false)
    cancel()
    await reload()
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(t('settings.templates.delete_confirm', { name }))) return
    await api.delete(`/api/templates/${id}`)
    await reload()
  }

  function toggleProduct(pid: string) {
    setForm((f) => ({
      ...f,
      productIds: f.productIds.includes(pid) ? f.productIds.filter((x) => x !== pid) : [...f.productIds, pid],
    }))
  }

  const showForm = creating || editingId !== null
  const typeById = new Map(activityTypes.map((tp) => [tp.id, tp.name] as const))

  return (
    <div className="flex flex-col gap-3">
      {!showForm && (
        <div>
          <Button size="sm" onClick={openCreate}><Plus className="mr-1 h-3 w-3" />{t('settings.templates.create')}</Button>
        </div>
      )}
      {showForm && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1"><Label>{t('settings.templates.name_label')}</Label><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Weekly Acme sync" /></div>
            <div className="flex flex-col gap-1"><Label>{t('settings.templates.effort_label')}</Label><Input type="number" min={0} max={24} step="0.25" value={form.effortHoursDefault} onChange={(e) => setForm((f) => ({ ...f, effortHoursDefault: e.target.value }))} /></div>
            <div className="flex flex-col gap-1">
              <Label>{t('settings.templates.team_label')}</Label>
              <Select value={form.teamId} onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value, activityTypeId: '', productIds: [] }))}>
                <option value="">{t('settings.templates.pick_team')}</option>
                {(teams ?? []).map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('settings.templates.activity_type_label')}</Label>
              <ActivityTypePicker
                value={form.activityTypeId}
                types={activityTypes}
                onChange={(id) => setForm((f) => ({ ...f, activityTypeId: id, subtypeId: '' }))}
                placeholder={t('settings.templates.no_type')}
              />
            </div>
            {showTemplateSubtype && (
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('settings.templates.subtype_label', 'Subtype')}</Label>
                <Select value={form.subtypeId} onChange={(e) => setForm((f) => ({ ...f, subtypeId: e.target.value }))}>
                  <option value="">{t('activity.form.subtype_none', '— None —')}</option>
                  {currentSubtypes.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </div>
            )}
            <div className="col-span-2 flex flex-col gap-1"><Label>{t('settings.templates.title_template_label')}</Label><Input value={form.titleTemplate} onChange={(e) => setForm((f) => ({ ...f, titleTemplate: e.target.value }))} placeholder="Weekly sync — Acme" /></div>
            <div className="col-span-2 flex flex-col gap-1"><Label>{t('settings.templates.notes_template_label')}</Label><Textarea value={form.notesTemplate} onChange={(e) => setForm((f) => ({ ...f, notesTemplate: e.target.value }))} className="min-h-[60px]" /></div>
            <div className="col-span-2 flex flex-col gap-1">
              <Label>{t('activity.form.location_mode_label')}</Label>
              <div className="inline-flex self-start rounded-md border border-gray-300 dark:border-gray-700 overflow-hidden">
                <button type="button" onClick={() => setForm((f) => ({ ...f, locationMode: 'remote' }))} className={cn('flex items-center gap-1 px-3 py-1 text-xs', form.locationMode === 'remote' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300')}>
                  <Wifi className="h-3 w-3" />{t('activity.form.location_mode.remote')}
                </button>
                <button type="button" onClick={() => setForm((f) => ({ ...f, locationMode: 'onsite' }))} className={cn('flex items-center gap-1 px-3 py-1 text-xs', form.locationMode === 'onsite' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300')}>
                  <MapPin className="h-3 w-3" />{t('activity.form.location_mode.onsite')}
                </button>
              </div>
            </div>
            {teamProducts.length > 0 && (
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('settings.templates.products_label')}</Label>
                <div className="flex flex-wrap gap-2">
                  {teamProducts.map((p) => {
                    const on = form.productIds.includes(p.id)
                    return (
                      <button type="button" key={p.id} onClick={() => toggleProduct(p.id)} className={cn('rounded-full border px-2 py-0.5 text-xs', on ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-300' : 'border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300')}>
                        {p.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={submit} disabled={saving || !form.name.trim() || !form.titleTemplate.trim()}>
              {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {!rows ? <Spinner className="h-4 w-4" /> : rows.length === 0 ? (
        <p className="py-3 text-sm text-gray-500 dark:text-gray-400">{t('settings.templates.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.name}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {r.titleTemplate}
                  {r.activityTypeId && typeById.has(r.activityTypeId) && <> · {typeById.get(r.activityTypeId)}</>}
                  {r.effortHoursDefault && <> · {r.effortHoursDefault}h</>}
                  {r.locationModeDefault && <> · {r.locationModeDefault}</>}
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(r)} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => remove(r.id, r.name)} className="rounded p-1 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// v1.86.0: icon-aware activity-type picker. Native <select> can't render
// SVGs, so admin-configured icons on team_activity_types (color + lucide
// icon name) were being swallowed. This picker mirrors the Log Activity
// form's type picker vocabulary — icon + colored dot + name — so what
// admins configure actually surfaces in the template form.
function ActivityTypePicker({
  value, types, onChange, placeholder,
}: {
  value: string
  types: ActivityType[]
  onChange: (id: string) => void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const active = value ? types.find((t) => t.id === value) : null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-left text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {active ? (
            <>
              {active.icon && <DynamicIcon name={active.icon} className="h-4 w-4 shrink-0" style={{ color: active.color ?? undefined }} />}
              {!active.icon && active.color && <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: active.color }} />}
              <span className="truncate">{active.name}</span>
            </>
          ) : (
            <span className="text-gray-500 dark:text-gray-400">{placeholder}</span>
          )}
        </span>
        <span className="text-gray-400">▾</span>
      </button>
      {open && (
        <ul className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <li>
            <button type="button" onClick={() => { onChange(''); setOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
              {placeholder}
            </button>
          </li>
          {types.map((tp) => (
            <li key={tp.id}>
              <button
                type="button"
                onClick={() => { onChange(tp.id); setOpen(false) }}
                className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800', tp.id === value && 'bg-blue-50 dark:bg-blue-950/40')}
              >
                {tp.icon && <DynamicIcon name={tp.icon} className="h-4 w-4 shrink-0" style={{ color: tp.color ?? undefined }} />}
                {!tp.icon && tp.color && <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tp.color }} />}
                <span className="truncate">{tp.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
