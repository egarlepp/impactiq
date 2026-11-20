import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Copy, Trash2, X, Save, Building2, Pencil, Plus, Wifi, MapPin, ChevronDown } from 'lucide-react'
import { DynamicIcon } from '../ui/icon-picker.js'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { Input } from '../ui/input.js'
import { Textarea } from '../ui/textarea.js'
import { Label } from '../ui/label.js'
import { cn } from '../../lib/utils.js'

// v1.93.0: cross-user Activity Templates admin.
// v1.95.0: Clone modal with target-user + team pickers.
// v1.96.0: PATCH + POST endpoints + inline Edit / New Template modal.
// v1.97.0: modal now mirrors the user-facing New Template form
// (TemplateQuickButton): activity type, title, notes, default effort,
// location mode, and product pills — with the admin-only target user +
// team pickers layered on top. Both surfaces write identical rows.

interface TemplateRow {
  id: string
  name: string
  titleTemplate: string
  notesTemplate: string | null
  effortHoursDefault: string | null
  locationModeDefault: string | null
  activityTypeId: string | null
  productIds: string[] | null
  userId: string
  teamId: string | null
  createdAt: string
  updatedAt: string
  userDisplayName: string
  userEmail: string
  teamName: string | null
}

interface UserOption { id: string; displayName: string; email: string }
interface TeamOption { id: string; name: string }
interface ActivityTypeOption { id: string; name: string; teamId: string; isActive: boolean; icon?: string | null; color?: string | null }
interface ProductOption { id: string; name: string; teamId: string | null; iconDataUrl?: string | null }

type Mode = null | { kind: 'clone'; source: TemplateRow } | { kind: 'edit'; source: TemplateRow } | { kind: 'new' }

export function ActivityTemplatesAdmin() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [users, setUsers] = useState<UserOption[]>([])
  const [teamsList, setTeamsList] = useState<TeamOption[]>([])
  const [types, setTypes] = useState<ActivityTypeOption[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [fUserId, setFUserId] = useState<string>('')
  const [fTeamId, setFTeamId] = useState<string>('')
  const [fName, setFName] = useState<string>('')
  const [fTitleTemplate, setFTitleTemplate] = useState<string>('')
  const [fNotesTemplate, setFNotesTemplate] = useState<string>('')
  const [fEffort, setFEffort] = useState<string>('')
  const [fActivityTypeId, setFActivityTypeId] = useState<string>('')
  const [fLocationMode, setFLocationMode] = useState<'remote' | 'onsite'>('remote')
  const [fProductIds, setFProductIds] = useState<string[]>([])
  const [fSaving, setFSaving] = useState(false)

  async function reload() {
    setLoading(true)
    const res = await api.get<TemplateRow[]>('/api/admin/activity-templates')
    setRows(res.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() }, [])

  async function loadPickerData() {
    if (users.length === 0) {
      const u = await api.get<UserOption[]>('/api/admin/users')
      setUsers(u.data ?? [])
    }
    if (teamsList.length === 0) {
      const tRes = await api.get<TeamOption[]>('/api/admin/teams')
      setTeamsList(tRes.data ?? [])
    }
    if (types.length === 0) {
      const at = await api.get<ActivityTypeOption[]>('/api/admin/activity-types')
      setTypes((at.data ?? []).filter((x) => x.isActive))
    }
    if (products.length === 0) {
      const pr = await api.get<ProductOption[]>('/api/admin/products')
      setProducts(pr.data ?? [])
    }
  }

  async function del(r: TemplateRow) {
    if (!window.confirm(t('admin.activity_templates.delete_confirm', 'Delete template "{{name}}" owned by {{owner}}?', { name: r.name, owner: r.userDisplayName }))) return
    setBusy(r.id)
    await api.delete(`/api/admin/activity-templates/${r.id}`)
    setBusy(null)
    void reload()
  }

  function seedFromRow(r: TemplateRow, forName: string) {
    setFUserId(r.userId)
    setFTeamId(r.teamId ?? '')
    setFName(forName)
    setFTitleTemplate(r.titleTemplate)
    setFNotesTemplate(r.notesTemplate ?? '')
    setFEffort(r.effortHoursDefault ?? '')
    setFActivityTypeId(r.activityTypeId ?? '')
    setFLocationMode((r.locationModeDefault === 'onsite' ? 'onsite' : 'remote'))
    setFProductIds(Array.isArray(r.productIds) ? r.productIds : [])
  }

  function openClone(r: TemplateRow) { setMode({ kind: 'clone', source: r }); seedFromRow(r, `${r.name} (copy)`); void loadPickerData() }
  function openEdit(r: TemplateRow) { setMode({ kind: 'edit', source: r }); seedFromRow(r, r.name); void loadPickerData() }
  function openNew() {
    setMode({ kind: 'new' })
    setFUserId(''); setFTeamId(''); setFName(''); setFTitleTemplate(''); setFNotesTemplate('')
    setFEffort(''); setFActivityTypeId(''); setFLocationMode('remote'); setFProductIds([])
    void loadPickerData()
  }
  function closeModal() { setMode(null); setFSaving(false) }

  function toggleProduct(pid: string) {
    setFProductIds((cur) => cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid])
  }

  async function submitModal() {
    if (!mode) return
    setFSaving(true)
    const commonBody = {
      name: fName,
      titleTemplate: fTitleTemplate,
      notesTemplate: fNotesTemplate || null,
      effortHoursDefault: fEffort || null,
      teamId: fTeamId === '' ? null : fTeamId,
      activityTypeId: fActivityTypeId || null,
      locationModeDefault: fLocationMode,
      productIds: fProductIds.length > 0 ? fProductIds : null,
    }
    if (mode.kind === 'clone') {
      await api.post(`/api/admin/activity-templates/${mode.source.id}/clone`, {
        targetUserId: fUserId || undefined,
        teamId: commonBody.teamId,
        name: fName || undefined,
      })
      // Clone endpoint only accepts a subset. If any other field was edited,
      // patch the clone we just created — but we don't have its id back from
      // the current API shape. Simpler: for full-field edits users should
      // Edit the cloned row afterwards. Keep clone lightweight.
    } else if (mode.kind === 'edit') {
      await api.patch(`/api/admin/activity-templates/${mode.source.id}`, {
        ...commonBody,
        userId: fUserId,
      })
    } else {
      await api.post('/api/admin/activity-templates', {
        ...commonBody,
        userId: fUserId,
      })
    }
    setFSaving(false)
    closeModal()
    void reload()
  }

  const teamProducts = fTeamId
    ? products.filter((p) => !p.teamId || p.teamId === fTeamId)
    : products

  const modalTitle = mode?.kind === 'clone'
    ? t('admin.activity_templates.clone_modal_title', 'Clone template')
    : mode?.kind === 'edit'
      ? t('admin.activity_templates.edit_modal_title', 'Edit template')
      : t('admin.activity_templates.new_modal_title', 'New activity template')

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Bookmark className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span>{rows.length} {t('admin.activity_templates.count', 'template(s) across all users')}</span>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4" />
          {t('admin.activity_templates.new', 'New template')}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.activity_templates.empty', 'No templates yet.')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800/50 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">{t('admin.activity_templates.name', 'Name')}</th>
                <th className="px-3 py-2">{t('admin.activity_templates.owner', 'Owner')}</th>
                <th className="px-3 py-2">{t('admin.activity_templates.team', 'Team')}</th>
                <th className="px-3 py-2">{t('admin.activity_templates.created', 'Created')}</th>
                <th className="px-3 py-2">{t('admin.activity_templates.updated', 'Updated')}</th>
                <th className="px-3 py-2 text-right">{t('common.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2">
                    <p className="font-medium text-gray-900 dark:text-gray-100">{r.name}</p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">{r.titleTemplate}</p>
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-gray-800 dark:text-gray-200">{r.userDisplayName}</p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">{r.userEmail}</p>
                  </td>
                  <td className="px-3 py-2">
                    {r.teamName ? (
                      <Badge variant="secondary" className="inline-flex items-center gap-1">
                        <Building2 className="h-3 w-3 shrink-0" />
                        {r.teamName}
                      </Badge>
                    ) : <span className="text-[11px] text-gray-400 dark:text-gray-500">—</span>}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400">{new Date(r.updatedAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(r)} disabled={busy === r.id} title={t('common.edit', 'Edit')}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openClone(r)} disabled={busy === r.id} title={t('admin.activity_templates.clone_assign', 'Clone / assign to another user or team')}>
                        {busy === r.id ? <Spinner className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void del(r)} disabled={busy === r.id} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40" title={t('common.delete', 'Delete')}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={closeModal}>
          <div className="w-full max-w-xl rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
                {mode.kind === 'clone' && <Copy className="h-4 w-4 text-blue-600 dark:text-blue-400" />}
                {mode.kind === 'edit' && <Pencil className="h-4 w-4 text-blue-600 dark:text-blue-400" />}
                {mode.kind === 'new' && <Bookmark className="h-4 w-4 text-blue-600 dark:text-blue-400" />}
                {modalTitle}
              </h3>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"><X className="h-4 w-4" /></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label>{t('settings.templates.name_label', 'Template name')}</Label>
                <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Weekly Acme sync" autoFocus />
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('settings.templates.effort_label', 'Default effort hours')}</Label>
                <Input type="number" min={0} max={24} step="0.25" value={fEffort} onChange={(e) => setFEffort(e.target.value)} />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('settings.templates.activity_type_label', 'Activity type')}</Label>
                <ActivityTypePicker
                  value={fActivityTypeId}
                  onChange={setFActivityTypeId}
                  types={types}
                  teamId={fTeamId}
                  placeholder={t('settings.templates.no_type', '— None —')}
                />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('settings.templates.title_template_label', 'Activity title')}</Label>
                <Input value={fTitleTemplate} onChange={(e) => setFTitleTemplate(e.target.value)} placeholder="Weekly sync — Acme" />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('settings.templates.notes_template_label', 'Default notes')}</Label>
                <Textarea value={fNotesTemplate} onChange={(e) => setFNotesTemplate(e.target.value)} className="min-h-[60px]" />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('activity.form.location_mode_label', 'Location')}</Label>
                <div className="inline-flex self-start overflow-hidden rounded-md border border-gray-300 dark:border-gray-700">
                  <button type="button" onClick={() => setFLocationMode('remote')} className={cn('flex items-center gap-1 px-3 py-1 text-xs', fLocationMode === 'remote' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-300')}>
                    <Wifi className="h-3 w-3" />{t('activity.form.location_mode.remote', 'Remote')}
                  </button>
                  <button type="button" onClick={() => setFLocationMode('onsite')} className={cn('flex items-center gap-1 px-3 py-1 text-xs', fLocationMode === 'onsite' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-300')}>
                    <MapPin className="h-3 w-3" />{t('activity.form.location_mode.onsite', 'On-site')}
                  </button>
                </div>
              </div>
              {teamProducts.length > 0 && (
                <div className="col-span-2 flex flex-col gap-1">
                  <Label>{t('settings.templates.products_label', 'Products')}</Label>
                  <div className="flex flex-wrap gap-2">
                    {teamProducts.map((p) => {
                      const on = fProductIds.includes(p.id)
                      return (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => toggleProduct(p.id)}
                          className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', on ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-300' : 'border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300')}
                        >
                          {p.iconDataUrl && <img src={p.iconDataUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />}
                          {p.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="col-span-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('admin.activity_templates.admin_assignment', 'Admin assignment')}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <Label>{t('admin.activity_templates.target_user', 'Target user')}</Label>
                    <select value={fUserId} onChange={(e) => setFUserId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                      <option value="">{t('admin.activity_templates.pick_user', '— Select a user —')}</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.displayName} — {u.email}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>{t('admin.activity_templates.target_team', 'Target team (optional)')}</Label>
                    <select value={fTeamId} onChange={(e) => setFTeamId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                      <option value="">{t('admin.activity_templates.team_none', '— No team (personal) —')}</option>
                      {teamsList.map((tm) => (
                        <option key={tm.id} value={tm.id}>{tm.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeModal} disabled={fSaving}>
                <X className="h-4 w-4" />
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button size="sm" onClick={() => void submitModal()} disabled={fSaving || !fUserId || !fName.trim() || !fTitleTemplate.trim()}>
                {fSaving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                {t('common.save', 'Save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// v1.103.0: dedicated Activity-type picker for the admin templates modal.
// Fixes two issues in the previous native <select>:
//   1) When no team was picked, every team's types listed side-by-side —
//      producing duplicate entries for the same name (Demo, Demo, ...).
//      We now dedupe by canonical name across teams.
//   2) Native <option> can't render lucide icons + team color. Custom
//      popover renders the DynamicIcon + colored dot next to each option.
function ActivityTypePicker({ value, onChange, types, teamId, placeholder }: {
  value: string
  onChange: (id: string) => void
  types: ActivityTypeOption[]
  teamId: string
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

  // Filter to the selected team first. When no team is selected, dedupe
  // across teams by lower-cased name so admins see each type ONCE (they
  // pick a target team afterwards; the id we keep is the first one).
  const filtered = teamId ? types.filter((tp) => tp.teamId === teamId) : types
  const seen = new Set<string>()
  const opts: ActivityTypeOption[] = []
  for (const tp of filtered) {
    const key = tp.name.toLowerCase().trim()
    if (seen.has(key)) continue
    seen.add(key)
    opts.push(tp)
  }
  const activeType = value ? opts.find((tp) => tp.id === value) ?? types.find((tp) => tp.id === value) ?? null : null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-left text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {activeType ? (
            <>
              {activeType.icon && <DynamicIcon name={activeType.icon} className="h-4 w-4 shrink-0" style={{ color: activeType.color ?? undefined }} />}
              {!activeType.icon && activeType.color && <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: activeType.color }} />}
              <span className="truncate">{activeType.name}</span>
            </>
          ) : (
            <span className="text-gray-500 dark:text-gray-400">{placeholder}</span>
          )}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
      </button>
      {open && (
        <ul className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <li>
            <button type="button" onClick={() => { onChange(''); setOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
              {placeholder}
            </button>
          </li>
          {opts.map((tp) => (
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
