import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle, AlertTriangle, Check, CheckCheck, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleCheck, CircleHelp, ClipboardCopy, Clock, ExternalLink,
  Layers, Lock, MessageCircleText, RefreshCw, Sparkles, StickyNote, Target, Trash2, UserRound,
} from 'lucide-react'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { AI_NOTE_SECTION_ICONS, AI_NOTE_SECTION_STYLES } from '../aiNotes/AiNoteSectionPicker.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { formatTranscriptOffset, gongCallUrlAt } from '../../../shared/gong.js'
import {
  AI_NOTE_CUSTOM_KEY_RX,
  AI_NOTE_SECTIONS,
  isBuiltInAiNoteSection,
  type AiNoteCitation,
  type AiNoteItem,
  type AiNoteVerdict,
  type AiNotesView,
} from '../../../shared/aiNotes.js'

// The AI Notes tab on the activity drawer (Gong plan, phase 4). The owner
// clicks Generate; the AI reads the linked Gong transcript(s) and the owner's
// own notes and writes items that arrive as To review. Keep makes an item
// permanent, Remove deletes it, Copy to Notes turns it into a normal note.
// Hidden unless the AI Assistant and the team's AI Notes switch are on.

const VERDICT_STYLE: Record<AiNoteVerdict, { icon: typeof Sparkles; cls: string }> = {
  confirmed: { icon: CircleCheck, cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' },
  not_in_notes: { icon: CircleHelp, cls: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300' },
  differs: { icon: AlertTriangle, cls: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300' },
}

// A profile's custom section without a color of its own (v1.466.0).
const CUSTOM_SECTION_STYLE = {
  icon: 'text-indigo-600 dark:text-indigo-400',
  header: 'bg-indigo-50 hover:bg-indigo-100 text-indigo-900 dark:bg-indigo-950/40 dark:hover:bg-indigo-950/70 dark:text-indigo-100',
  edge: 'border-l-indigo-500 dark:border-l-indigo-400',
  count: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200',
}

function tint(hex: string, alpha: number): string | undefined {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

// Which sections this person collapsed, remembered in this browser only.
const COLLAPSED_KEY = 'impactiq.aiNotes.collapsedSections'

// Built-in keys and custom (profile) section keys, v1.466.0.
function isSectionKey(v: unknown): v is string {
  return typeof v === 'string' && (isBuiltInAiNoteSection(v) || AI_NOTE_CUSTOM_KEY_RX.test(v))
}

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter(isSectionKey) : [])
  } catch {
    return new Set()
  }
}

function writeCollapsed(next: Set<string>) {
  try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])) } catch { /* storage off: still works for this visit */ }
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

export function AiNotesTab({ activityId, onCountChange, onNotesChanged, onViewChange }: {
  activityId: string
  onCountChange?: (count: number) => void
  // Every new state (My Notes → AI keeps its list counts in step).
  onViewChange?: (view: AiNotesView) => void
  // A copy added a note: the drawer refreshes its Notes count.
  onNotesChanged?: () => void
}) {
  const { t, i18n } = useTranslation()
  const [view, setView] = useState<AiNotesView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [busyItem, setBusyItem] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)

  function setCollapsedAndSave(next: Set<string>) {
    setCollapsed(next)
    writeCollapsed(next)
  }

  function toggleSection(section: string) {
    const next = new Set(collapsed)
    if (next.has(section)) next.delete(section)
    else next.add(section)
    setCollapsedAndSave(next)
  }

  function apply(next: AiNotesView) {
    setView(next)
    onCountChange?.(next.items.length)
    onViewChange?.(next)
  }

  async function load() {
    const res = await api.get<AiNotesView>(`/api/ai-notes/activities/${activityId}`)
    if (res.error) { setError(t(res.error)); return }
    if (res.data) apply(res.data)
  }

  useEffect(() => {
    setView(null)
    setError(null)
    setNotice(null)
    let cancelled = false
    void api.get<AiNotesView>(`/api/ai-notes/activities/${activityId}`).then((res) => {
      if (cancelled) return
      if (res.error) { setError(t(res.error)); return }
      if (res.data) apply(res.data)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId])

  async function generate() {
    const toReview = view?.items.filter((i) => i.status === 'to_review').length ?? 0
    if (toReview > 0 && !window.confirm(t('activity.ai_notes.regenerate_confirm', { count: toReview }))) return
    setGenerating(true)
    setError(null)
    setNotice(null)
    const res = await api.post<AiNotesView>(`/api/ai-notes/activities/${activityId}/generate`, {})
    setGenerating(false)
    if (res.error) { setError(t(res.error)); return }
    if (res.data) apply(res.data)
    const meta = res.meta as { items?: number; truncated?: boolean } | undefined
    if (meta?.truncated) setNotice(t('activity.ai_notes.truncated'))
    else if (meta?.items === 0) setNotice(t('activity.ai_notes.nothing_new'))
  }

  async function keep(item: AiNoteItem) {
    setBusyItem(item.id)
    setError(null)
    const res = await api.patch(`/api/ai-notes/items/${item.id}`, { status: 'kept' })
    setBusyItem(null)
    if (res.error) { setError(t(res.error)); return }
    await load()
  }

  async function remove(item: AiNoteItem) {
    setBusyItem(item.id)
    setError(null)
    const res = await api.delete(`/api/ai-notes/items/${item.id}`)
    setBusyItem(null)
    if (res.error) { setError(t(res.error)); return }
    await load()
  }

  async function copyToNotes(item: AiNoteItem) {
    setBusyItem(item.id)
    setError(null)
    const res = await api.post(`/api/ai-notes/items/${item.id}/copy-to-notes`, {})
    setBusyItem(null)
    if (res.error) { setError(t(res.error)); return }
    setNotice(t('activity.ai_notes.copied'))
    onNotesChanged?.()
    await load()
  }

  async function keepAll() {
    setBusyItem('all')
    setError(null)
    const res = await api.post(`/api/ai-notes/activities/${activityId}/keep-all`, {})
    setBusyItem(null)
    if (res.error) { setError(t(res.error)); return }
    await load()
  }

  if (!view && !error) return <div className="flex justify-center py-8"><Spinner /></div>
  if (!view) return <ErrorBox message={error ?? ''} />

  const callUrl = new Map(view.sources.calls.map((c) => [c.id, c.url]))
  const callLabel = new Map(view.sources.calls.map((c, i) => [c.id, view.sources.calls.length > 1 ? `C${i + 1} ` : '']))
  const toReview = view.items.filter((i) => i.status === 'to_review').length
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
  // Built-in sections first, then the profiles' custom sections, then any
  // custom section an earlier AI Note wrote that no profile adds any more.
  const customDefs = new Map(view.customSections.map((c) => [c.key, { name: c.name, icon: c.icon, color: c.color }]))
  const orderedKeys: string[] = [...AI_NOTE_SECTIONS, ...view.customSections.map((c) => c.key)]
  for (const item of view.items) if (!orderedKeys.includes(item.section)) orderedKeys.push(item.section)
  const bySection = orderedKeys
    .map((s) => {
      const items = view.items.filter((i) => i.section === s)
      const meta = isBuiltInAiNoteSection(s) ? null : customDefs.get(s) ?? items.find((i) => i.sectionMeta)?.sectionMeta ?? null
      return { section: s, items, meta }
    })
    .filter((g) => g.items.length > 0)

  const citation = (c: AiNoteCitation, i: number) => {
    if (c.kind === 'note') {
      return (
        <span key={i} className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 dark:border-gray-700 dark:text-gray-300" title={t('activity.ai_notes.cite_note_hint')}>
          <StickyNote className="h-3 w-3" />
          {t('activity.ai_notes.cite_note')}
        </span>
      )
    }
    const href = gongCallUrlAt(callUrl.get(c.callId) ?? null, c.startMs)
    const label = `${callLabel.get(c.callId) ?? ''}${formatTranscriptOffset(c.startMs)}`
    const cls = 'inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 dark:border-gray-700 dark:text-gray-300'
    return href ? (
      <a key={i} href={href} target="_blank" rel="noopener noreferrer" className={`${cls} hover:border-indigo-300 hover:text-indigo-700 dark:hover:border-indigo-700 dark:hover:text-indigo-300`} title={t('activity.ai_notes.cite_call_hint')}>
        <Clock className="h-3 w-3" />
        {label}
        <ExternalLink className="h-3 w-3" />
      </a>
    ) : (
      <span key={i} className={cls}><Clock className="h-3 w-3" />{label}</span>
    )
  }

  const blockedText = view.blockedReason && view.blockedReason !== 'not_owner'
    ? t(`activity.ai_notes.blocked.${view.blockedReason}`)
    : null

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorBox message={error} /> : null}
      {notice ? (
        <div className="flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      ) : null}

      <div className="rounded-md border border-gray-200 px-3 py-2.5 dark:border-gray-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-xs text-gray-600 dark:text-gray-400">
            <p className="flex items-center gap-1.5">
              <MessageCircleText className="h-3.5 w-3.5 shrink-0" />
              {view.sources.transcriptsAvailable
                ? t('activity.ai_notes.source_calls', { count: view.sources.calls.length })
                : t('activity.ai_notes.source_no_calls')}
            </p>
            {view.canEdit ? (
              <p className="mt-0.5 flex items-center gap-1.5">
                <StickyNote className="h-3.5 w-3.5 shrink-0" />
                {t('activity.ai_notes.source_notes', { count: view.sources.notes })}
              </p>
            ) : null}
            {view.note ? (
              <p className="mt-0.5 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                {t('activity.ai_notes.generated', { when: when(view.note.generatedAt), name: view.note.generatedByName ?? '—' })}
              </p>
            ) : null}
          </div>
          {view.canEdit ? (
            <div className="flex items-center gap-2">
              {toReview > 0 ? (
                <Button type="button" size="sm" variant="outline" disabled={busyItem !== null || generating} onClick={() => void keepAll()}>
                  <CheckCheck className="mr-1 h-3.5 w-3.5" />
                  {t('activity.ai_notes.keep_all')}
                </Button>
              ) : null}
              <Button type="button" size="sm" disabled={!view.canGenerate || generating} onClick={() => void generate()} title={blockedText ?? undefined}>
                {generating
                  ? <Spinner className="mr-1 h-3.5 w-3.5" />
                  : view.note ? <RefreshCw className="mr-1 h-3.5 w-3.5" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                {generating ? t('activity.ai_notes.generating') : view.note ? t('activity.ai_notes.regenerate') : t('activity.ai_notes.generate')}
              </Button>
            </div>
          ) : null}
        </div>
        {view.canEdit && blockedText ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {blockedText}
          </p>
        ) : null}
        {view.profiles.length > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('activity.ai_notes.profiles_hint', { names: view.profiles.map((p) => p.name).join(', ') })}
          </p>
        ) : null}
        {view.note?.usedPrivateNotes ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('activity.ai_notes.private_hint')}
          </p>
        ) : null}
      </div>

      {view.items.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center dark:border-gray-600">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('activity.ai_notes.empty_title')}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {view.canEdit ? t('activity.ai_notes.empty_hint') : t('activity.ai_notes.empty_hint_readonly')}
          </p>
        </div>
      ) : (
        <>
        {bySection.length > 1 ? (
          <div className="flex justify-end">
            {bySection.every((g) => collapsed.has(g.section)) ? (
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setCollapsedAndSave(new Set())}>
                <ChevronsUpDown className="mr-1 h-3.5 w-3.5" />
                {t('activity.ai_notes.expand_all')}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setCollapsedAndSave(new Set(bySection.map((g) => g.section)))}>
                <ChevronsDownUp className="mr-1 h-3.5 w-3.5" />
                {t('activity.ai_notes.collapse_all')}
              </Button>
            )}
          </div>
        ) : null}
        {bySection.map(({ section, items, meta }) => {
          const builtIn = isBuiltInAiNoteSection(section)
          const Icon = builtIn ? AI_NOTE_SECTION_ICONS[section] : null
          const style = builtIn ? AI_NOTE_SECTION_STYLES[section] : CUSTOM_SECTION_STYLE
          const color = !builtIn && meta?.color ? meta.color : null
          const open = !collapsed.has(section)
          const pending = items.filter((i) => i.status !== 'kept').length
          const panelId = `ai-notes-section-${section}`
          return (
            <section key={section} className={`overflow-hidden rounded-md border border-l-4 border-gray-200 dark:border-gray-700 ${style.edge}`} style={color ? { borderLeftColor: color } : undefined}>
              <h3>
                <button
                  type="button"
                  onClick={() => toggleSection(section)}
                  aria-expanded={open}
                  aria-controls={panelId}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold ${style.header}`}
                  style={color ? { backgroundColor: tint(color, 0.12) } : undefined}
                >
                  {open ? <ChevronDown className="h-4 w-4 shrink-0 opacity-70" /> : <ChevronRight className="h-4 w-4 shrink-0 opacity-70" />}
                  {Icon
                    ? <Icon className={`h-4 w-4 shrink-0 ${style.icon}`} />
                    : <DynamicIcon name={meta?.icon ?? 'Sparkles'} className={`h-4 w-4 shrink-0 ${color ? '' : style.icon}`} style={color ? { color } : undefined} />}
                  <span className="min-w-0 flex-1 truncate">{builtIn ? t(`activity.ai_notes.section.${section}`) : meta?.name ?? t('activity.ai_notes.section_custom')}</span>
                  {pending > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                      <Clock className="h-3 w-3" />
                      {t('activity.ai_notes.section_to_review', { count: pending })}
                    </span>
                  ) : null}
                  <span className={`inline-flex min-w-[1.5rem] justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${style.count}`} title={t('activity.ai_notes.section_items', { count: items.length })}>
                    {items.length}
                  </span>
                </button>
              </h3>
              {open ? (
              <ul id={panelId} className="flex flex-col gap-1.5 bg-white p-2 dark:bg-gray-900">
                {items.map((item) => {
                  const verdict = item.verdict ? VERDICT_STYLE[item.verdict] : null
                  const VerdictIcon = verdict?.icon
                  const kept = item.status === 'kept'
                  return (
                    <li
                      key={item.id}
                      className={`rounded-md border px-3 py-2 text-sm ${kept ? 'border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900' : 'border-indigo-200 bg-indigo-50/40 dark:border-indigo-900 dark:bg-indigo-950/20'}`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        {verdict && VerdictIcon && item.verdict ? (
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${verdict.cls}`}>
                            <VerdictIcon className="h-3 w-3" />
                            {t(`activity.ai_notes.verdict.${item.verdict}`)}
                          </span>
                        ) : null}
                        {item.meddpiccKey ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                            <Target className="h-3 w-3" />
                            {t(`meddpicc.${item.meddpiccKey}`)}
                          </span>
                        ) : null}
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${kept ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300'}`}>
                          {kept ? <Check className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                          {kept ? t('activity.ai_notes.status_kept') : t('activity.ai_notes.status_to_review')}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-gray-800 dark:text-gray-100">{item.text}</p>
                      {item.ownerName ? (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                          <UserRound className="h-3 w-3" />
                          {t('activity.ai_notes.owner', { name: item.ownerName })}
                        </p>
                      ) : null}
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1">{item.citations.map(citation)}</div>
                        {view.canEdit ? (
                          <div className="flex items-center gap-1">
                            {!kept ? (
                              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busyItem !== null} onClick={() => void keep(item)}>
                                <Check className="mr-1 h-3 w-3" />
                                {t('activity.ai_notes.keep')}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={busyItem !== null || !!item.copiedNoteId}
                              onClick={() => void copyToNotes(item)}
                              title={item.copiedNoteId ? t('activity.ai_notes.already_copied') : t('activity.ai_notes.copy_hint')}
                            >
                              <ClipboardCopy className="mr-1 h-3 w-3" />
                              {item.copiedNoteId ? t('activity.ai_notes.copied_short') : t('activity.ai_notes.copy')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs text-red-600 dark:text-red-400"
                              disabled={busyItem !== null}
                              onClick={() => void remove(item)}
                              title={t('activity.ai_notes.remove')}
                              aria-label={t('activity.ai_notes.remove')}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
              ) : null}
            </section>
          )
        })}
        </>
      )}
      <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('activity.ai_notes.footer')}</p>
    </div>
  )
}
