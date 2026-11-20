import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, ChevronDown, Plus, X, Save, Wifi, MapPin } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Textarea } from '../ui/textarea.js'
import { Select } from '../ui/select.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { useTeam } from '../../hooks/useTeam.js'
import { useTeamProducts } from '../../hooks/useProducts.js'
import { cn } from '../../lib/utils.js'
import { DynamicIcon } from '../ui/icon-picker.js'

interface TemplateSummary { id: string; name: string }

// v1.86.0: always-rendered icon-only chip next to "+ Log Activity". The menu
// always includes a "New template…" option at the top so users can start a
// template without leaving the Activities page. Existing templates list
// underneath. Created templates surface on My Settings → Templates too
// because both surfaces read the same /api/templates.
export function TemplateQuickButton({ onPickTemplate }: { onPickTemplate: (id: string) => void }) {
  const { t } = useTranslation()
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [open, setOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  async function reload() {
    const r = await api.get<TemplateSummary[]>('/api/templates')
    setTemplates(r.data ?? [])
  }

  useEffect(() => { void reload() }, [])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <>
      <div className="relative" ref={ref}>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setOpen((o) => !o)}
          title={t('activity.template_quick.button')}
          aria-label={t('activity.template_quick.button')}
          className="text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/40 dark:hover:text-blue-300"
        >
          <Bookmark className="h-4 w-4" />
        </Button>
        {open && (
          <div className="absolute right-0 z-30 mt-1 min-w-[240px] rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
            <ul className="max-h-72 overflow-y-auto py-1 text-sm">
              <li>
                <button
                  type="button"
                  onClick={() => { setOpen(false); setModalOpen(true) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="font-medium">{t('activity.template_quick.new', 'New template…')}</span>
                </button>
              </li>
              {templates.length > 0 && (
                <li className="my-1 border-t border-gray-100 dark:border-gray-800" aria-hidden="true" />
              )}
              {templates.map((tp) => (
                <li key={tp.id}>
                  <button
                    type="button"
                    onClick={() => { setOpen(false); onPickTemplate(tp.id) }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <Bookmark className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                    <span className="min-w-0 truncate">{tp.name}</span>
                  </button>
                </li>
              ))}
              {templates.length === 0 && (
                <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                  {t('activity.template_quick.empty', 'No templates yet. Create one to get started.')}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
      {modalOpen && (
        <NewTemplateModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false)
            void reload()
            // v1.92.0: notify other surfaces (SuggestedActivityCard's
            // Approve-with-Template menu, My Settings → Templates) that
            // the template list changed, so they refresh without a page reload.
            window.dispatchEvent(new CustomEvent('impactiq:templates-changed'))
          }}
        />
      )}
    </>
  )
}

// Minimal in-page modal for creating a template. Mirrors the primary fields
// of My Settings → Templates so the two surfaces stay in sync; anything more
// exotic (products, notes template) is left to Settings where the whole
// editor lives.
function NewTemplateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation()
  const { activeTeam, activityTypes, subtypesByTypeId } = useTeam()
  const teamProducts = useTeamProducts(activeTeam?.id ?? null)
  const [name, setName] = useState('')
  const [titleTemplate, setTitleTemplate] = useState('')
  const [notesTemplate, setNotesTemplate] = useState('')
  const [effortHoursDefault, setEffortHoursDefault] = useState('')
  const [activityTypeId, setActivityTypeId] = useState('')
  const [subtypeId, setSubtypeId] = useState('')
  const [locationMode, setLocationMode] = useState<'remote' | 'onsite'>('remote')
  const [productIds, setProductIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const activeType = activityTypeId ? activityTypes.find((tp) => tp.id === activityTypeId) : null
  // v1.256.0: mirrors ActivityForm/TemplatesSection's Subtype gating —
  // hidden when the team hasn't turned Subtypes on or the chosen type has
  // none configured.
  const currentSubtypes = subtypesByTypeId[activityTypeId] ?? []
  const showQuickTemplateSubtype = !!activeTeam?.subtypesEnabled && currentSubtypes.length > 0

  function toggleProduct(pid: string) {
    setProductIds((cur) => cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid])
  }

  async function save() {
    if (!name.trim()) return
    setSaving(true); setErr(null)
    const res = await api.post('/api/templates', {
      name: name.trim(),
      titleTemplate: titleTemplate.trim(),
      notesTemplate: notesTemplate.trim() || null,
      // Server schema expects number (Zod z.number().nullable().optional()).
      // The <Input type="number"> in the modal still delivers a string, so
      // parse before send; empty or non-numeric → null so the field stays
      // truly "no default" rather than 0.
      effortHoursDefault: (() => {
        const trimmed = effortHoursDefault.trim()
        if (!trimmed) return null
        const n = Number(trimmed)
        return Number.isFinite(n) ? n : null
      })(),
      activityTypeId: activityTypeId || null,
      subtypeId: subtypeId || null,
      locationMode,
      productIds,
      teamId: activeTeam?.id ?? null,
    })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    onCreated()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-xl rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <Bookmark className="h-4 w-4 text-blue-600" />
            {t('activity.template_quick.new_title', 'New activity template')}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label>{t('settings.templates.name_label')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly Acme sync" autoFocus />
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t('settings.templates.effort_label')}</Label>
            <Input type="number" min={0} max={24} step="0.25" value={effortHoursDefault} onChange={(e) => setEffortHoursDefault(e.target.value)} />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label>{t('settings.templates.activity_type_label')}</Label>
            <TypePicker
              value={activityTypeId}
              onChange={(id) => { setActivityTypeId(id); setSubtypeId('') }}
              types={activityTypes}
              placeholder={t('settings.templates.no_type')}
              activeType={activeType ?? null}
            />
          </div>
          {showQuickTemplateSubtype && (
            <div className="col-span-2 flex flex-col gap-1">
              <Label>{t('settings.templates.subtype_label', 'Subtype')}</Label>
              <Select value={subtypeId} onChange={(e) => setSubtypeId(e.target.value)}>
                <option value="">{t('activity.form.subtype_none', '— None —')}</option>
                {currentSubtypes.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </div>
          )}
          <div className="col-span-2 flex flex-col gap-1">
            <Label>{t('settings.templates.title_template_label')}</Label>
            <Input value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)} placeholder="Weekly sync — Acme" />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label>{t('settings.templates.notes_template_label')}</Label>
            <Textarea value={notesTemplate} onChange={(e) => setNotesTemplate(e.target.value)} className="min-h-[60px]" />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label>{t('activity.form.location_mode_label')}</Label>
            <div className="inline-flex self-start overflow-hidden rounded-md border border-gray-300 dark:border-gray-700">
              <button type="button" onClick={() => setLocationMode('remote')} className={cn('flex items-center gap-1 px-3 py-1 text-xs', locationMode === 'remote' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-300')}>
                <Wifi className="h-3 w-3" />{t('activity.form.location_mode.remote')}
              </button>
              <button type="button" onClick={() => setLocationMode('onsite')} className={cn('flex items-center gap-1 px-3 py-1 text-xs', locationMode === 'onsite' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-300')}>
                <MapPin className="h-3 w-3" />{t('activity.form.location_mode.onsite')}
              </button>
            </div>
          </div>
          {teamProducts.length > 0 && (
            <div className="col-span-2 flex flex-col gap-1">
              <Label>{t('settings.templates.products_label', 'Products')}</Label>
              <div className="flex flex-wrap gap-2">
                {teamProducts.map((p) => {
                  const on = productIds.includes(p.id)
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
        </div>
        {err && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Icon-aware type picker mirroring the one added in TemplatesSection so
// activity-type icons/colors configured by admins actually surface here
// too. Standalone (not shared) to keep this component drop-in without a
// deeper refactor of the settings module.
function TypePicker({ value, onChange, types, placeholder, activeType }: {
  value: string
  onChange: (id: string) => void
  types: { id: string; name: string; icon?: string | null; color?: string | null }[]
  placeholder: string
  activeType: { id: string; name: string; icon?: string | null; color?: string | null } | null
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
