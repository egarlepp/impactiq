import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus, Trash2, Save, X, Power, PowerOff, ChevronDown, ChevronRight,
  GripVertical, Languages, ExternalLink, AlertCircle, PlaneTakeoff,
  Upload, Image as ImageIcon, Eye, RefreshCcw,
} from 'lucide-react'
import {
  DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, verticalListSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../../lib/api.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Textarea } from '../ui/textarea.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { IconPicker, DynamicIcon } from '../ui/icon-picker.js'
import { ColorPicker } from '../ui/color-picker.js'
import { FlightDeckModalView, type FlightDeckItem as FlightDeckPreviewItem } from '../flightdeck/FlightDeckModal.js'
import { cn } from '../../lib/utils.js'

type LinkType = 'app_page' | 'external_url'

interface FlightDeckItem {
  id: string
  teamId: string
  label: string
  tooltip: string | null
  icon: string
  iconColor: string | null
  screenshots: string[]
  linkType: LinkType
  linkValue: string
  isPreset: boolean
  sortOrder: number
  isActive: boolean
}

interface ItemPayload {
  label: string
  tooltip: string | null
  icon: string
  iconColor: string | null
  screenshots: string[]
  linkType: LinkType
  linkValue: string
}

const MAX_ACTIVE = 10
const LABEL_MAX = 120
const TOOLTIP_MAX = 400
const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024
const SCREENSHOT_MAX_COUNT = 5

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Convenience shortlist of common internal destinations — linkValue stays a
// plain free-text string server-side, this Select is just a faster way to
// fill it in than typing a route by hand. Matches the app's real nav routes
// (src/client/components/ui/nav.tsx) and reuses its labels so this list
// can't drift out of sync with what the sidebar actually calls each page.
const APP_PAGE_SUGGESTIONS: Array<{ value: string; labelKey: string }> = [
  { value: '/', labelKey: 'nav.activities' },
  { value: '/dashboard', labelKey: 'nav.dashboard' },
  { value: '/scheduling', labelKey: 'nav.scheduling' },
  { value: '/notes', labelKey: 'nav.my_notes' },
  { value: '/my-history', labelKey: 'nav.my_history' },
  { value: '/guide', labelKey: 'nav.guide' },
  { value: '/settings', labelKey: 'nav.settings' },
]

// Mirrors the 7 locales this app ships (CLAUDE.md §15). English is included
// as a selectable target too (matching the same convention nudge rule
// translations use) — an admin can override even the base-language copy
// for a team whose base template is intentionally non-English.
const LOCALES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'ja', label: '日本語' },
  { code: 'pt', label: 'Português' },
]

const EMPTY_FORM: ItemPayload = { label: '', tooltip: null, icon: '', iconColor: null, screenshots: [], linkType: 'app_page', linkValue: '/' }

export function FlightDeckConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const [items, setItems] = useState<FlightDeckItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [seedingDefaults, setSeedingDefaults] = useState(false)
  const [form, setForm] = useState<ItemPayload>(EMPTY_FORM)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [previewing, setPreviewing] = useState(false)
  // Preview is a visual stand-in, not a real session — checking an item off
  // in the preview only flips this local set, never flight_deck_completions.
  const [previewChecked, setPreviewChecked] = useState<Set<string>>(new Set())

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function reload() {
    setLoading(true)
    const res = await api.get<FlightDeckItem[]>(`/api/admin/teams/${teamId}/flight-deck-items`)
    setItems(res.data ?? [])
    setLoading(false)
  }

  useEffect(() => { void reload() }, [teamId])

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex((i) => i.id === active.id)
    const newIndex = items.findIndex((i) => i.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(items, oldIndex, newIndex)
    setItems(reordered)
    await api.patch(`/api/admin/teams/${teamId}/flight-deck-items/reorder`, {
      orderedIds: reordered.map((i) => i.id),
    })
  }

  async function toggleActive(item: FlightDeckItem) {
    setSaving(item.id)
    setError(null)
    const next = !item.isActive
    const res = await api.patch<FlightDeckItem>(`/api/admin/teams/${teamId}/flight-deck-items/${item.id}`, { isActive: next })
    setSaving(null)
    if (res.error || !res.data) { setError(res.error ?? t('admin.flight_deck.max_active_hint', { max: MAX_ACTIVE })); return }
    setItems((prev) => prev.map((i) => (i.id === item.id ? res.data! : i)))
  }

  async function saveItem(id: string, payload: ItemPayload) {
    setSaving(id)
    setError(null)
    const res = await api.patch<FlightDeckItem>(`/api/admin/teams/${teamId}/flight-deck-items/${id}`, payload)
    setSaving(null)
    if (res.error || !res.data) { setError(res.error ?? 'Failed to save item'); return }
    setItems((prev) => prev.map((i) => (i.id === id ? res.data! : i)))
  }

  async function remove(item: FlightDeckItem) {
    if (!window.confirm(t('admin.flight_deck.delete_confirm'))) return
    setSaving(item.id)
    await api.delete(`/api/admin/teams/${teamId}/flight-deck-items/${item.id}`)
    setItems((prev) => prev.filter((i) => i.id !== item.id))
    setSaving(null)
  }

  async function submitCreate() {
    setError(null)
    setNotice(null)
    if (!form.label.trim()) { setError(t('admin.flight_deck.label_required')); return }
    if (!form.icon) { setError(t('admin.flight_deck.icon_required')); return }
    if (!form.linkValue.trim()) { setError(t('admin.flight_deck.link_required')); return }
    setSaving('add')
    const res = await api.post<FlightDeckItem>(`/api/admin/teams/${teamId}/flight-deck-items`, {
      label: form.label.trim(),
      tooltip: form.tooltip?.trim() || null,
      icon: form.icon,
      iconColor: form.iconColor,
      screenshots: form.screenshots,
      linkType: form.linkType,
      linkValue: form.linkValue.trim(),
    })
    setSaving(null)
    if (res.error || !res.data) { setError(res.error ?? 'Failed to create item'); return }
    if ((res.meta as { cappedInactive?: boolean } | undefined)?.cappedInactive) {
      setNotice(t('admin.flight_deck.capped_inactive_notice', { max: MAX_ACTIVE }))
    }
    setAdding(false)
    setForm(EMPTY_FORM)
    await reload()
  }

  // Self-service fix for a team that's missing some or all of the seeded
  // default items (e.g. it existed before Flight Deck shipped, or a
  // migration-time backfill missed it because the team already had a custom
  // item at that point) — inserts whatever's missing, safe to click more
  // than once since the server only ever adds what isn't already there.
  async function seedDefaults() {
    setSeedingDefaults(true)
    setError(null)
    setNotice(null)
    const res = await api.post<{ added: number }>(`/api/admin/teams/${teamId}/flight-deck-items/seed-defaults`, {})
    setSeedingDefaults(false)
    if (res.error) { setError(res.error); return }
    const added = res.data?.added ?? 0
    setNotice(
      added > 0
        ? t('admin.flight_deck.defaults_added', { count: added })
        : t('admin.flight_deck.defaults_already_present'),
    )
    if (added > 0) await reload()
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  const activeCount = items.filter((i) => i.isActive).length
  const previewItems: FlightDeckPreviewItem[] = items
    .filter((i) => i.isActive)
    .map((i) => ({
      id: i.id,
      label: i.label,
      tooltip: i.tooltip,
      icon: i.icon,
      iconColor: i.iconColor,
      screenshots: i.screenshots ?? [],
      linkType: i.linkType,
      linkValue: i.linkValue,
      sortOrder: i.sortOrder,
      completed: previewChecked.has(i.id),
    }))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
        <div className="flex items-start gap-2">
          <PlaneTakeoff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('admin.flight_deck.intro', { max: MAX_ACTIVE })}</span>
        </div>
        <Button size="sm" variant="outline" className="shrink-0 bg-white dark:bg-gray-900" onClick={() => setPreviewing(true)}>
          <Eye className="mr-1 h-3.5 w-3.5" />
          {t('admin.flight_deck.preview')}
        </Button>
      </div>

      <div className="flex items-center justify-end">
        <Badge variant={activeCount >= MAX_ACTIVE ? 'warning' : 'secondary'}>
          {t('admin.flight_deck.active_count', { count: activeCount, max: MAX_ACTIVE })}
        </Badge>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.flight_deck.empty')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void handleDragEnd(e)}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2">
              {items.map((item, index) => (
                <FlightDeckItemRow
                  key={item.id}
                  item={item}
                  index={index}
                  teamId={teamId}
                  expanded={!!expanded[item.id]}
                  busy={saving === item.id}
                  onToggleExpanded={() => toggleExpanded(item.id)}
                  onToggleActive={() => void toggleActive(item)}
                  onSave={(payload) => void saveItem(item.id, payload)}
                  onDelete={() => void remove(item)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {adding ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <ItemFields form={form} onChange={setForm} />
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => void submitCreate()} disabled={saving === 'add'}>
              <Save className="mr-1 h-3.5 w-3.5" />
              {t('common.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setForm(EMPTY_FORM); setError(null) }}>
              <X className="mr-1 h-3.5 w-3.5" />
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => { setAdding(true); setError(null); setNotice(null) }}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('admin.flight_deck.add_item')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void seedDefaults()} disabled={seedingDefaults}>
            <RefreshCcw className={cn('mr-1 h-3.5 w-3.5', seedingDefaults && 'animate-spin')} />
            {t('admin.flight_deck.add_defaults')}
          </Button>
        </div>
      )}

      {previewing && (
        <FlightDeckModalView
          firstName={user?.displayName?.split(' ')[0] ?? null}
          items={previewItems}
          dontShowAgain={false}
          onDontShowAgainChange={() => {}}
          onToggleItem={(previewItem) => {
            setPreviewChecked((prev) => {
              const next = new Set(prev)
              if (next.has(previewItem.id)) next.delete(previewItem.id); else next.add(previewItem.id)
              return next
            })
          }}
          onOpenItem={() => {}}
          onDismiss={() => setPreviewing(false)}
          readOnly
        />
      )}
    </div>
  )
}

function ItemFields({ form, onChange }: { form: ItemPayload; onChange: (next: ItemPayload) => void }) {
  const { t } = useTranslation()
  const isKnownPage = APP_PAGE_SUGGESTIONS.some((p) => p.value === form.linkValue)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setUploadError(null)
    const remaining = SCREENSHOT_MAX_COUNT - form.screenshots.length
    if (remaining <= 0) {
      setUploadError(t('admin.flight_deck.screenshots_max', { max: SCREENSHOT_MAX_COUNT }))
      return
    }
    const files = Array.from(fileList).slice(0, remaining)
    const next: string[] = []
    for (const file of files) {
      if (file.size > SCREENSHOT_MAX_BYTES) {
        setUploadError(t('admin.flight_deck.screenshot_too_large'))
        continue
      }
      next.push(await fileToDataUrl(file))
    }
    if (next.length > 0) onChange({ ...form, screenshots: [...form.screenshots, ...next] })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[1fr_auto_auto] gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('admin.flight_deck.label')}</Label>
          <Input
            value={form.label}
            maxLength={LABEL_MAX}
            onChange={(e) => onChange({ ...form, label: e.target.value })}
            placeholder={t('admin.flight_deck.label_placeholder')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('admin.flight_deck.icon')}</Label>
          <IconPicker value={form.icon || null} onChange={(icon) => onChange({ ...form, icon: icon ?? '' })} />
        </div>
        <div className="flex flex-col gap-1">
          <ColorPicker
            label={t('admin.flight_deck.icon_color')}
            value={form.iconColor ?? null}
            onChange={(next) => onChange({ ...form, iconColor: next })}
            onReset={() => onChange({ ...form, iconColor: null })}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t('admin.flight_deck.tooltip')}</Label>
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{(form.tooltip ?? '').length}/{TOOLTIP_MAX}</span>
        </div>
        <Textarea
          value={form.tooltip ?? ''}
          maxLength={TOOLTIP_MAX}
          onChange={(e) => onChange({ ...form, tooltip: e.target.value })}
          placeholder={t('admin.flight_deck.tooltip_placeholder')}
          className="min-h-[52px] text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('admin.flight_deck.link_type')}</Label>
        <div className="inline-flex w-fit rounded-md border border-gray-300 p-0.5 dark:border-gray-600">
          <button
            type="button"
            onClick={() => onChange({ ...form, linkType: 'app_page', linkValue: isKnownPage ? form.linkValue : '/' })}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              form.linkType === 'app_page'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
            )}
          >
            {t('admin.flight_deck.app_page')}
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...form, linkType: 'external_url', linkValue: '' })}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              form.linkType === 'external_url'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
            )}
          >
            <ExternalLink className="mr-1 inline h-3 w-3" />
            {t('admin.flight_deck.external_url')}
          </button>
        </div>
      </div>

      {form.linkType === 'app_page' && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('admin.flight_deck.pick_page')}</Label>
          <Select
            value={isKnownPage ? form.linkValue : ''}
            onChange={(e) => { if (e.target.value) onChange({ ...form, linkValue: e.target.value }) }}
          >
            <option value="">{t('admin.flight_deck.pick_page_placeholder')}</option>
            {APP_PAGE_SUGGESTIONS.map((p) => (
              <option key={p.value} value={p.value}>{t(p.labelKey)}</option>
            ))}
          </Select>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{form.linkType === 'app_page' ? t('admin.flight_deck.page_path') : t('admin.flight_deck.url')}</Label>
        <Input
          value={form.linkValue}
          onChange={(e) => onChange({ ...form, linkValue: e.target.value })}
          placeholder={form.linkType === 'app_page' ? '/dashboard' : 'https://example.com'}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('admin.flight_deck.screenshots')}</Label>
        <div className="flex flex-wrap items-center gap-2">
          {form.screenshots.map((src, i) => (
            <div key={i} className="group relative h-14 w-20 shrink-0 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
              <img src={src} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onChange({ ...form, screenshots: form.screenshots.filter((_, j) => j !== i) })}
                className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 group-hover:opacity-100"
                title={t('common.delete')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {form.screenshots.length < SCREENSHOT_MAX_COUNT && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-14 w-20 flex-col items-center justify-center gap-0.5 rounded border border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-500 dark:border-gray-600 dark:hover:border-gray-500"
            >
              <Upload className="h-4 w-4" />
              <span className="text-[9px]">{t('admin.flight_deck.upload')}</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(e) => { void handleFiles(e.target.files); e.target.value = '' }}
          />
        </div>
        <p className="text-[10px] text-gray-400 dark:text-gray-500">
          {t('admin.flight_deck.screenshots_hint', { max: SCREENSHOT_MAX_COUNT })}
        </p>
        {uploadError && <p className="text-[10px] text-red-600 dark:text-red-400">{uploadError}</p>}
      </div>
    </div>
  )
}

function FlightDeckItemRow({
  item, index, teamId, expanded, busy, onToggleExpanded, onToggleActive, onSave, onDelete,
}: {
  item: FlightDeckItem
  index: number
  teamId: string
  expanded: boolean
  busy: boolean
  onToggleExpanded: () => void
  onToggleActive: () => void
  onSave: (payload: ItemPayload) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const [form, setForm] = useState<ItemPayload>({
    label: item.label, tooltip: item.tooltip, icon: item.icon, iconColor: item.iconColor,
    screenshots: item.screenshots ?? [], linkType: item.linkType, linkValue: item.linkValue,
  })

  // Re-sync local edit state if the row's underlying data changes from
  // outside this form (e.g. a reload after another admin's edit).
  useEffect(() => {
    setForm({
      label: item.label, tooltip: item.tooltip, icon: item.icon, iconColor: item.iconColor,
      screenshots: item.screenshots ?? [], linkType: item.linkType, linkValue: item.linkValue,
    })
  }, [item.id, item.label, item.tooltip, item.icon, item.iconColor, item.screenshots, item.linkType, item.linkValue])

  // Defensive: screenshots is typed as string[] but a row that predates this
  // column (or slipped through un-normalized) can still arrive as null —
  // that crashed the whole admin page once already (blank screen on a bare
  // `.length` read), so every read of item.screenshots here is guarded.
  const itemScreenshots = item.screenshots ?? []
  const dirty = form.label !== item.label
    || (form.tooltip ?? '') !== (item.tooltip ?? '')
    || form.icon !== item.icon
    || form.iconColor !== item.iconColor
    || form.screenshots.length !== itemScreenshots.length || form.screenshots.some((s, i) => s !== itemScreenshots[i])
    || form.linkType !== item.linkType
    || form.linkValue !== item.linkValue

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none rounded p-1 text-gray-300 hover:text-gray-500 active:cursor-grabbing dark:text-gray-600 dark:hover:text-gray-400"
          aria-label={t('admin.flight_deck.drag_handle')}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="w-4 shrink-0 text-center text-xs font-semibold text-gray-400 dark:text-gray-500">{index + 1}</span>

        <button type="button" onClick={onToggleExpanded} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          <DynamicIcon
            name={item.icon}
            className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400"
            style={item.iconColor ? { color: item.iconColor } : undefined}
          />
          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{item.label}</span>
          {item.isPreset && <Badge variant="secondary" className="shrink-0">{t('admin.flight_deck.default_badge')}</Badge>}
          {item.linkType === 'external_url' && <ExternalLink className="h-3 w-3 shrink-0 text-gray-400" />}
          {itemScreenshots.length > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-gray-400">
              <ImageIcon className="h-3 w-3" />
              {itemScreenshots.length}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={item.isActive ? 'success' : 'outline'}>
            {item.isActive ? t('admin.flight_deck.active') : t('admin.flight_deck.inactive')}
          </Badge>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onToggleActive}>
            {item.isActive ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
          </Button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
            aria-label={t('common.delete')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <ItemFields form={form} onChange={setForm} />
          {dirty && (
            <Button
              size="sm"
              className="mt-3"
              disabled={busy}
              onClick={() => onSave({ ...form, tooltip: form.tooltip?.trim() || null, linkValue: form.linkValue.trim(), label: form.label.trim() })}
            >
              <Save className="mr-1 h-3.5 w-3.5" />
              {t('common.save')}
            </Button>
          )}
          <FlightDeckTranslationsEditor itemId={item.id} teamId={teamId} baseLabel={item.label} />
        </div>
      )}
    </div>
  )
}

// Per-locale label/tooltip overrides — mirrors NudgeRulesConfig's
// NudgeTranslationsEditor exactly (same compact collapsible shape, same
// upsert-by-locale contract): admin picks a language, edits the localized
// copy, and saves. Server resolves the viewer's active locale at read time
// and falls back to the base item text when unset.
function FlightDeckTranslationsEditor({ itemId, teamId, baseLabel }: { itemId: string; teamId: string; baseLabel: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [locale, setLocale] = useState<string>('es')
  const [translations, setTranslations] = useState<Record<string, { label: string; tooltip: string | null }>>({})
  const [draftLabel, setDraftLabel] = useState('')
  const [draftTooltip, setDraftTooltip] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void api.get<Array<{ locale: string; label: string; tooltip: string | null }>>(
      `/api/admin/teams/${teamId}/flight-deck-items/${itemId}/translations`,
    ).then((res) => {
      const map: Record<string, { label: string; tooltip: string | null }> = {}
      for (const r of res.data ?? []) map[r.locale] = { label: r.label, tooltip: r.tooltip }
      setTranslations(map)
    })
  }, [open, itemId, teamId])

  useEffect(() => {
    const existing = translations[locale]
    setDraftLabel(existing?.label ?? '')
    setDraftTooltip(existing?.tooltip ?? '')
  }, [locale, translations])

  async function save() {
    setBusy(true)
    const label = draftLabel.trim()
    const tooltip = draftTooltip.trim() || null
    await api.put(`/api/admin/teams/${teamId}/flight-deck-items/${itemId}/translations/${locale}`, { label, tooltip })
    setTranslations((prev) => ({ ...prev, [locale]: { label, tooltip } }))
    setBusy(false)
  }
  async function remove() {
    setBusy(true)
    await api.delete(`/api/admin/teams/${teamId}/flight-deck-items/${itemId}/translations/${locale}`)
    setTranslations((prev) => { const n = { ...prev }; delete n[locale]; return n })
    setDraftLabel('')
    setDraftTooltip('')
    setBusy(false)
  }

  const existing = translations[locale] ?? null
  const dirty = draftLabel !== (existing?.label ?? '') || draftTooltip !== (existing?.tooltip ?? '')

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Languages className="h-3.5 w-3.5" />
        {t('admin.flight_deck.translations')}
        <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {Object.keys(translations).length}
        </span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs">{t('admin.flight_deck.language')}</Label>
            <Select value={locale} onChange={(e) => setLocale(e.target.value)} className="w-40">
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} ({l.code}){translations[l.code] ? ' •' : ''}
                </option>
              ))}
            </Select>
          </div>
          <Input
            value={draftLabel}
            maxLength={LABEL_MAX}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder={baseLabel}
            className="h-8 text-xs"
          />
          <Textarea
            value={draftTooltip}
            maxLength={TOOLTIP_MAX}
            onChange={(e) => setDraftTooltip(e.target.value)}
            placeholder={t('admin.flight_deck.tooltip_placeholder')}
            className="min-h-[52px] text-xs"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || draftLabel.trim() === ''}>
              <Save className="mr-1 h-3 w-3" />
              {t('admin.flight_deck.save_translation')}
            </Button>
            {existing && (
              <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy}>
                <Trash2 className="mr-1 h-3 w-3" />
                {t('admin.flight_deck.reset_to_base')}
              </Button>
            )}
          </div>
          <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.flight_deck.translations_hint')}</p>
        </div>
      )}
    </div>
  )
}
