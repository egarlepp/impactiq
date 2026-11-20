import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle, ArrowDown, ArrowLeftRight, ArrowUp, ChevronDown, ChevronRight, ClipboardCheck, GripVertical, Info, Layers, Pencil, Plus, PlusCircle, Save, Star, Trash2, X,
} from 'lucide-react'
import {
  DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, verticalListSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Textarea } from '../ui/textarea.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { DynamicIcon, IconPicker } from '../ui/icon-picker.js'
import { ColorPicker } from '../ui/color-picker.js'
import { AI_NOTE_SECTION_ICONS, AI_NOTE_SECTION_STYLES, AiNoteSectionPicker } from '../aiNotes/AiNoteSectionPicker.js'
import {
  AI_NOTE_CUSTOM_INSTRUCTIONS_MAX,
  AI_NOTE_CUSTOM_NAME_MAX,
  AI_NOTE_PROFILE_MAX_CUSTOM,
  newCustomSectionKey,
  type AiNoteProfile,
  type AiNoteProfileCombineMode,
  type AiNoteSection,
} from '../../../shared/aiNotes.js'

// AI Assessments → Settings → Settings Profiles (v1.466.0). A profile is a
// named set of AI Note sections: built-in ones plus custom sections with
// their own instructions. The starred Default profile (v1.471.0) is what
// people who haven't picked their own sections get. An assessment picks a
// profile in its editor; where it runs, the profile's sections are added to
// the default, or replace it when the profile is set to Replace. A person's
// own sections (My Settings) are always kept.

const CARD = 'rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900'
const PROFILE_ICON = 'Layers'
const CUSTOM_ICON = 'Sparkles'

interface CustomDraft {
  key: string
  name: string
  instructions: string
  icon: string | null
  color: string | null
  open: boolean
}

interface ProfileDraft {
  id: string | null
  name: string
  description: string
  icon: string | null
  iconColor: string | null
  sections: AiNoteSection[]
  customSections: CustomDraft[]
  combineMode: AiNoteProfileCombineMode
  isDefault: boolean
}

function newCustom(): CustomDraft {
  return { key: newCustomSectionKey(), name: '', instructions: '', icon: null, color: null, open: true }
}

function draftFrom(p: AiNoteProfile): ProfileDraft {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    icon: p.icon,
    iconColor: p.iconColor,
    sections: p.sections,
    customSections: p.customSections.map((c) => ({ ...c, open: false })),
    combineMode: p.combineMode,
    isDefault: p.isDefault,
  }
}

function customInvalid(c: CustomDraft): boolean {
  return c.name.trim() === '' || c.instructions.trim() === ''
}

function ColoredIcon({ name, color, fallback, className }: { name: string | null; color: string | null; fallback: string; className?: string }) {
  return (
    <DynamicIcon
      name={name ?? fallback}
      className={`${className ?? 'h-4 w-4'} ${color ? '' : 'text-indigo-600 dark:text-indigo-400'}`}
      style={color ? { color } : undefined}
    />
  )
}

export function AiNoteProfilesConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<AiNoteProfile[] | null>(null)
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    setProfiles(null)
    setDraft(null)
    setError(null)
    let cancelled = false
    void api.get<AiNoteProfile[]>(`/api/admin/teams/${teamId}/ai-note-profiles`).then((res) => {
      if (cancelled) return
      if (res.data) setProfiles(res.data)
      else setError(res.error ?? 'errors.server')
    })
    return () => { cancelled = true }
  }, [teamId])

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function patchCustom(key: string, patch: Partial<CustomDraft>) {
    setDraft((d) => d ? { ...d, customSections: d.customSections.map((c) => c.key === key ? { ...c, ...patch } : c) } : d)
  }

  function moveCustom(index: number, by: -1 | 1) {
    setDraft((d) => {
      if (!d) return d
      const target = index + by
      if (target < 0 || target >= d.customSections.length) return d
      return { ...d, customSections: arrayMove(d.customSections, index, target) }
    })
  }

  function onCustomDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setDraft((d) => {
      if (!d) return d
      const from = d.customSections.findIndex((c) => c.key === active.id)
      const to = d.customSections.findIndex((c) => c.key === over.id)
      if (from < 0 || to < 0) return d
      return { ...d, customSections: arrayMove(d.customSections, from, to) }
    })
  }

  const noSections = !!draft && draft.sections.length + draft.customSections.length === 0
  const someCustomInvalid = !!draft && draft.customSections.some(customInvalid)
  const draftInvalid = !draft || draft.name.trim() === '' || noSections || someCustomInvalid

  async function save() {
    if (!draft) return
    if (draftInvalid) {
      setDraft({ ...draft, customSections: draft.customSections.map((c) => customInvalid(c) ? { ...c, open: true } : c) })
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      icon: draft.icon,
      iconColor: draft.iconColor,
      sections: draft.sections,
      customSections: draft.customSections.map((c) => ({ key: c.key, name: c.name.trim(), instructions: c.instructions.trim(), icon: c.icon, color: c.color })),
      combineMode: draft.combineMode,
    }
    const res = draft.id
      ? await api.put<AiNoteProfile[]>(`/api/admin/teams/${teamId}/ai-note-profiles/${draft.id}`, body)
      : await api.post<AiNoteProfile[]>(`/api/admin/teams/${teamId}/ai-note-profiles`, body)
    setBusy(false)
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    setProfiles(res.data)
    setDraft(null)
  }

  async function setDefault(profileId: string | null) {
    setBusy(true)
    setError(null)
    const res = await api.put<AiNoteProfile[]>(`/api/admin/teams/${teamId}/ai-note-profile-default`, { profileId })
    setBusy(false)
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    setProfiles(res.data)
    setDraft((d) => d && d.id ? { ...d, isDefault: d.id === profileId } : d)
  }

  async function remove(id: string) {
    setBusy(true)
    setError(null)
    const res = await api.delete<AiNoteProfile[]>(`/api/admin/teams/${teamId}/ai-note-profiles/${id}`)
    setBusy(false)
    setConfirmDelete(null)
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    setProfiles(res.data)
    if (draft?.id === id) setDraft(null)
  }

  const editor = draft ? (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ai-note-profile-name">{t('admin.ai_note_profiles.name_label')}</Label>
          <Input id="ai-note-profile-name" value={draft.name} maxLength={120} placeholder={t('admin.ai_note_profiles.name_placeholder')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ai-note-profile-description">{t('admin.ai_note_profiles.description_label')}</Label>
          <Input id="ai-note-profile-description" value={draft.description} maxLength={1000} placeholder={t('admin.ai_note_profiles.description_placeholder')} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('admin.ai_note_profiles.icon_label')}</Label>
          <div className="flex items-center gap-2">
            <IconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
            <ColoredIcon name={draft.icon} color={draft.iconColor} fallback={PROFILE_ICON} className="h-5 w-5" />
          </div>
        </div>
        <ColorPicker
          label={t('admin.ai_note_profiles.icon_color_label')}
          value={draft.iconColor}
          onChange={(next) => setDraft({ ...draft, iconColor: next })}
          onReset={() => setDraft({ ...draft, iconColor: null })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.ai_note_profiles.combine_label')}</h4>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('admin.ai_note_profiles.combine_label')}>
          {(['add', 'replace'] as const).map((mode) => {
            const Icon = mode === 'add' ? PlusCircle : ArrowLeftRight
            const selected = draft.combineMode === mode
            return (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={selected ? 'default' : 'outline'}
                role="radio"
                aria-checked={selected}
                onClick={() => setDraft({ ...draft, combineMode: mode })}
                disabled={busy}
              >
                <Icon className="mr-1 h-3.5 w-3.5" />
                {t(`admin.ai_note_profiles.combine_${mode}`)}
              </Button>
            )
          })}
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400">{t(`admin.ai_note_profiles.combine_${draft.combineMode}_hint`)}</p>
        {draft.isDefault ? (
          <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <Star className="mt-px h-3.5 w-3.5 shrink-0 fill-current" />
            {t('admin.ai_note_profiles.default_note')}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.ai_note_profiles.builtin_label')}</h4>
        <p className="-mt-1 text-xs text-gray-600 dark:text-gray-400">{t('admin.ai_note_profiles.builtin_hint')}</p>
        <AiNoteSectionPicker value={draft.sections} onChange={(sections) => setDraft({ ...draft, sections })} disabled={busy} allowEmpty />
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.ai_note_profiles.custom_label')}</h4>
        <p className="-mt-1 text-xs text-gray-600 dark:text-gray-400">{t('admin.ai_note_profiles.custom_hint')}</p>
        {draft.customSections.length > 0 ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onCustomDragEnd}>
            <SortableContext items={draft.customSections.map((c) => c.key)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1.5">
                {draft.customSections.map((c, i) => (
                  <CustomSectionRow
                    key={c.key}
                    c={c}
                    index={i}
                    count={draft.customSections.length}
                    onPatch={(patch) => patchCustom(c.key, patch)}
                    onMove={(by) => moveCustom(i, by)}
                    onRemove={() => setDraft({ ...draft, customSections: draft.customSections.filter((x) => x.key !== c.key) })}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : null}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.customSections.length >= AI_NOTE_PROFILE_MAX_CUSTOM}
            onClick={() => setDraft({ ...draft, customSections: [...draft.customSections.map((c) => customInvalid(c) ? c : { ...c, open: false }), newCustom()] })}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('admin.ai_note_profiles.add_custom', { max: AI_NOTE_PROFILE_MAX_CUSTOM })}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={busy || draft.name.trim() === '' || noSections}>
          {busy ? <Spinner className="mr-1 h-4 w-4" /> : <Save className="mr-1 h-4 w-4" />}
          {t('common.save')}
        </Button>
        <Button type="button" variant="outline" onClick={() => { setDraft(null); setError(null) }} disabled={busy}>
          <X className="mr-1 h-4 w-4" />
          {t('common.cancel')}
        </Button>
        {noSections ? (
          <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5" />
            {t('admin.ai_note_profiles.sections_required')}
          </span>
        ) : someCustomInvalid ? (
          <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5" />
            {t('admin.ai_note_profiles.custom_incomplete')}
          </span>
        ) : null}
      </div>
    </div>
  ) : null

  return (
    <section className={`${CARD} max-w-2xl p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Layers className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('admin.ai_note_profiles.title')}
          </h3>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{t('admin.ai_note_profiles.hint')}</p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => { setError(null); setDraft({ id: null, name: '', description: '', icon: null, iconColor: null, sections: [], customSections: [newCustom()], combineMode: 'add', isDefault: false }) }}
          disabled={busy || !profiles || (draft !== null && draft.id === null)}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t('admin.ai_note_profiles.new')}
        </Button>
      </div>

      {error ? <p className="mt-3 text-sm text-red-600 dark:text-red-400">{t(error)}</p> : null}
      {profiles && !profiles.some((p) => p.isDefault) ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('admin.ai_note_profiles.no_default')}
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        {!profiles ? (error ? null : <div className="flex justify-center py-4"><Spinner /></div>) : null}
        {draft && draft.id === null ? (
          <div className="rounded-md border border-indigo-300 p-3 dark:border-indigo-700">
            <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <ColoredIcon name={draft.icon} color={draft.iconColor} fallback={PROFILE_ICON} />
              {draft.name.trim() || t('admin.ai_note_profiles.new')}
            </h4>
            {editor}
          </div>
        ) : null}
        {profiles && profiles.length === 0 && !draft ? (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-gray-300 px-3 py-3 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-400">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('admin.ai_note_profiles.empty')}
          </div>
        ) : null}
        {(profiles ?? []).map((p) => {
          const editingThis = draft?.id === p.id
          const open = editingThis || expanded.has(p.id)
          const total = p.sections.length + p.customSections.length
          return (
            <div key={p.id} className={`rounded-md border ${editingThis ? 'border-indigo-300 dark:border-indigo-700' : 'border-gray-200 dark:border-gray-700'}`}>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <button type="button" onClick={() => { if (!editingThis) toggleExpanded(p.id) }} aria-expanded={open} className="flex min-w-[12rem] flex-1 items-center gap-2 text-left">
                  {open ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
                  <ColoredIcon name={p.icon} color={p.iconColor} fallback={PROFILE_ICON} className="h-5 w-5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{p.name}</span>
                    {p.description ? <span className="block truncate text-xs text-gray-600 dark:text-gray-400">{p.description}</span> : null}
                  </span>
                </button>
                <div className="flex flex-wrap items-center gap-1.5">
                  {p.isDefault ? (
                    <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400">
                      <Star className="mr-1 h-3 w-3 fill-current" />{t('admin.ai_note_profiles.default_badge')}
                    </Badge>
                  ) : null}
                  {p.combineMode === 'replace' ? (
                    <Badge variant="outline" title={t('admin.ai_note_profiles.combine_replace_hint')}>
                      <ArrowLeftRight className="mr-1 h-3 w-3" />
                      {t('admin.ai_note_profiles.combine_badge_replace')}
                    </Badge>
                  ) : null}
                  <Badge variant="outline"><Layers className="mr-1 h-3 w-3" />{t('admin.ai_note_profiles.section_count', { count: total })}</Badge>
                  <Badge variant="outline"><ClipboardCheck className="mr-1 h-3 w-3" />{t('admin.ai_note_profiles.used_by', { count: p.assessmentCount })}</Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void setDefault(p.isDefault ? null : p.id)}
                    disabled={busy}
                    aria-pressed={p.isDefault}
                    title={p.isDefault ? t('admin.ai_note_profiles.clear_default') : t('admin.ai_note_profiles.make_default')}
                    aria-label={`${p.isDefault ? t('admin.ai_note_profiles.clear_default') : t('admin.ai_note_profiles.make_default')}: ${p.name}`}
                  >
                    <Star className={`h-3.5 w-3.5 ${p.isDefault ? 'fill-current text-amber-500 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`} />
                  </Button>
                  {!editingThis ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setError(null); setDraft(draftFrom(p)) }} disabled={busy} title={t('common.edit')} aria-label={t('common.edit')}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
              {open ? (
                <div className="border-t border-gray-100 px-3 py-3 dark:border-gray-800">
                  {editingThis ? editor : (
                    <div className="flex flex-col gap-3">
                      <ul className="flex flex-col gap-1.5">
                        {p.sections.map((s) => {
                          const Icon = AI_NOTE_SECTION_ICONS[s]
                          return (
                            <li key={s} className="flex items-center gap-2 text-xs">
                              <Icon className={`h-3.5 w-3.5 shrink-0 ${AI_NOTE_SECTION_STYLES[s].icon}`} />
                              <span className="font-medium text-gray-900 dark:text-gray-100">{t(`activity.ai_notes.section.${s}`)}</span>
                              <span className="text-gray-500 dark:text-gray-400">{t('admin.ai_note_profiles.builtin_tag')}</span>
                            </li>
                          )
                        })}
                        {p.customSections.map((c) => (
                          <li key={c.key} className="flex items-start gap-2 text-xs">
                            <ColoredIcon name={c.icon} color={c.color} fallback={CUSTOM_ICON} className="mt-px h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0">
                              <span className="font-medium text-gray-900 dark:text-gray-100">{c.name}</span>
                              <span className="block text-gray-600 dark:text-gray-400">{c.instructions}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => { setError(null); setDraft(draftFrom(p)) }} disabled={busy}>
                          <Pencil className="mr-1 h-3.5 w-3.5" />
                          {t('common.edit')}
                        </Button>
                        {confirmDelete === p.id ? (
                          <>
                            <Button type="button" size="sm" variant="destructive" onClick={() => void remove(p.id)} disabled={busy}>
                              <Trash2 className="mr-1 h-3.5 w-3.5" />
                              {p.assessmentCount > 0 ? t('admin.ai_note_profiles.confirm_delete_used', { count: p.assessmentCount }) : t('admin.ai_note_profiles.confirm_delete')}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>
                              <X className="mr-1 h-3.5 w-3.5" />
                              {t('common.cancel')}
                            </Button>
                          </>
                        ) : (
                          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(p.id)} disabled={busy} title={t('common.delete')} aria-label={t('common.delete')}>
                            <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function CustomSectionRow({ c, index, count, onPatch, onMove, onRemove }: {
  c: CustomDraft
  index: number
  count: number
  onPatch: (patch: Partial<CustomDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.key })
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const invalid = customInvalid(c)
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-md border bg-gray-50 dark:bg-gray-800/50 ${invalid && !c.open ? 'border-red-300 dark:border-red-800' : 'border-gray-200 dark:border-gray-700'}`}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none rounded p-1 text-gray-400 hover:text-gray-600 active:cursor-grabbing dark:text-gray-500 dark:hover:text-gray-300"
          aria-label={t('admin.ai_note_profiles.drag_handle')}
          title={t('admin.ai_note_profiles.drag_handle')}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => onPatch({ open: !c.open })} aria-expanded={c.open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {c.open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          <ColoredIcon name={c.icon} color={c.color} fallback={CUSTOM_ICON} className="h-3.5 w-3.5 shrink-0" />
          <span className={`truncate text-sm ${c.name.trim() ? 'font-medium text-gray-900 dark:text-gray-100' : 'italic text-gray-500 dark:text-gray-400'}`}>
            {c.name.trim() || t('admin.ai_note_profiles.custom_untitled')}
          </span>
          {invalid && !c.open ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" aria-label={t('admin.ai_note_profiles.custom_incomplete')} /> : null}
        </button>
        <div className="flex shrink-0 items-center">
          <Button type="button" size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} title={t('admin.ai_note_profiles.move_up')} aria-label={t('admin.ai_note_profiles.move_up')}><ArrowUp className="h-3.5 w-3.5" /></Button>
          <Button type="button" size="sm" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)} title={t('admin.ai_note_profiles.move_down')} aria-label={t('admin.ai_note_profiles.move_down')}><ArrowDown className="h-3.5 w-3.5" /></Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove} title={t('admin.ai_note_profiles.remove_custom')} aria-label={t('admin.ai_note_profiles.remove_custom')}><Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" /></Button>
        </div>
      </div>
      {c.open ? (
        <div className="flex flex-col gap-2 border-t border-gray-200 bg-white px-3 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`custom-name-${c.key}`}>{t('admin.ai_note_profiles.custom_name')}</Label>
            <Input id={`custom-name-${c.key}`} value={c.name} maxLength={AI_NOTE_CUSTOM_NAME_MAX} placeholder={t('admin.ai_note_profiles.custom_name_placeholder')} onChange={(e) => onPatch({ name: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`custom-instructions-${c.key}`}>{t('admin.ai_note_profiles.custom_instructions')}</Label>
            <Textarea
              id={`custom-instructions-${c.key}`}
              rows={3}
              maxLength={AI_NOTE_CUSTOM_INSTRUCTIONS_MAX}
              value={c.instructions}
              placeholder={t('admin.ai_note_profiles.custom_instructions_placeholder')}
              onChange={(e) => onPatch({ instructions: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-end gap-6">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('admin.ai_note_profiles.icon_label')}</Label>
              <div className="flex items-center gap-2">
                <IconPicker value={c.icon} onChange={(icon) => onPatch({ icon })} />
                <ColoredIcon name={c.icon} color={c.color} fallback={CUSTOM_ICON} className="h-5 w-5" />
              </div>
            </div>
            <ColorPicker
              label={t('admin.ai_note_profiles.icon_color_label')}
              value={c.color}
              onChange={(next) => onPatch({ color: next })}
              onReset={() => onPatch({ color: null })}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
