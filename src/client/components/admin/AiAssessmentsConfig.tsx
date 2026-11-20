import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, ClipboardCheck, GripVertical,
  Info, Layers, ListChecks, Lock, Pencil, Plus, Save, Settings2, Trash2, Users, X,
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
import { Select } from '../ui/select.js'
import { Textarea } from '../ui/textarea.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { DynamicIcon, IconPicker } from '../ui/icon-picker.js'
import { ColorPicker } from '../ui/color-picker.js'
import { TeamAssignmentPicker } from './TeamAssignmentPicker.js'
import { AiNotesConfig } from './AiNotesConfig.js'
import { AiNoteProfilesConfig } from './AiNoteProfilesConfig.js'
import { useTeam, type ActivityType, type ActivityTypeSubtype } from '../../hooks/useTeam.js'
import {
  AI_ASSESSMENT_LEVELS,
  AI_ASSESSMENT_MAX_CRITERIA,
  AI_ASSESSMENT_MAX_PER_ACTIVITY,
  AI_ASSESSMENT_MAX_WEIGHT,
  type AiAssessment,
  type AiAssessmentAnchors,
  type AiAssessmentAssignment,
  type AiAssessmentsAdminView,
} from '../../../shared/aiAssessments.js'
import type { AiNoteProfile } from '../../../shared/aiNotes.js'

// Admin → Activities & Rules → AI Assessments (v1.461.0). Three tabs:
// Assessments (the team's scored rubrics), Assignments (which rubric runs
// for each Activity Type and Subtype) and Settings (the team's AI Notes
// switch and spend limit, moved here from Workplace, and the Settings
// Profiles, the starred Default one included).
// v1.465.0: every assessment and criterion is collapsible, assessments carry
// an icon and icon color, criteria reorder by drag or arrows, and the
// Assignments tab is one compact row per Activity Type tinted with its color.

export type AiAssessmentsTab = 'assessments' | 'assignments' | 'settings'

const DEFAULT_ICON = 'ClipboardCheck'
const CARD = 'rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900'

interface CriterionDraft {
  key: string
  name: string
  lookFor: string
  weight: string
  anchors: AiAssessmentAnchors
  open: boolean
  levelsOpen: boolean
}

interface Draft {
  id: string | null
  name: string
  description: string
  icon: string | null
  iconColor: string | null
  aiNoteProfileId: string | null
  isActive: boolean
  isLocked: boolean
  teamIds: string[]
  criteria: CriterionDraft[]
}

function newCriterion(): CriterionDraft {
  return { key: crypto.randomUUID(), name: '', lookFor: '', weight: '10', anchors: {}, open: true, levelsOpen: false }
}

function draftFrom(a: AiAssessment): Draft {
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? '',
    icon: a.icon,
    iconColor: a.iconColor,
    aiNoteProfileId: a.aiNoteProfileId,
    isActive: a.isActive,
    isLocked: a.isLocked,
    teamIds: a.teamIds,
    criteria: a.criteria.map((c) => ({
      key: c.id, name: c.name, lookFor: c.lookFor ?? '', weight: String(c.weight), anchors: c.anchors, open: false, levelsOpen: false,
    })),
  }
}

function weightOf(c: CriterionDraft): number {
  const n = Number(c.weight)
  return Number.isInteger(n) ? n : NaN
}

function criterionInvalid(c: CriterionDraft): boolean {
  const w = weightOf(c)
  return c.name.trim() === '' || !(w >= 1 && w <= AI_ASSESSMENT_MAX_WEIGHT)
}

/** #rrggbb at the given opacity, for tinting a row with an Activity Type's color. */
function tint(hex: string | null | undefined, alpha: number): string | undefined {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function AssessmentIcon({ a, className }: { a: { icon: string | null; iconColor: string | null }; className?: string }) {
  return (
    <DynamicIcon
      name={a.icon ?? DEFAULT_ICON}
      className={`${className ?? 'h-4 w-4'} ${a.iconColor ? '' : 'text-indigo-600 dark:text-indigo-400'}`}
      style={a.iconColor ? { color: a.iconColor } : undefined}
    />
  )
}

export function AiAssessmentsConfig({ teamId, tab, onTabChange }: { teamId: string; tab: AiAssessmentsTab; onTabChange: (tab: AiAssessmentsTab) => void }) {
  const { t } = useTranslation()
  const tabs: Array<{ key: AiAssessmentsTab; label: string; icon: typeof ListChecks }> = [
    { key: 'assessments', label: t('admin.ai_assessments.tab_assessments'), icon: ClipboardCheck },
    { key: 'assignments', label: t('admin.ai_assessments.tab_assignments'), icon: ListChecks },
    { key: 'settings', label: t('admin.ai_assessments.tab_settings'), icon: Settings2 },
  ]
  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => onTabChange(key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === key
              ? 'border-indigo-600 font-medium text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
              : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      {tab === 'settings' ? (
        <div className="flex flex-col gap-6">
          <AiNotesConfig teamId={teamId} />
          <AiNoteProfilesConfig teamId={teamId} />
        </div>
      ) : <RubricsAndAssignments teamId={teamId} tab={tab} />}
    </div>
  )
}

function RubricsAndAssignments({ teamId, tab }: { teamId: string; tab: 'assessments' | 'assignments' }) {
  const { t } = useTranslation()
  const [view, setView] = useState<AiAssessmentsAdminView | null>(null)
  const [types, setTypes] = useState<ActivityType[]>([])
  const [subtypes, setSubtypes] = useState<ActivityTypeSubtype[]>([])
  const [profiles, setProfiles] = useState<AiNoteProfile[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setView(null)
    setError(null)
    let cancelled = false
    void Promise.all([
      api.get<AiAssessmentsAdminView>(`/api/admin/teams/${teamId}/ai-assessments`),
      api.get<ActivityType[]>(`/api/teams/${teamId}/activity-types`),
      api.get<ActivityTypeSubtype[]>(`/api/teams/${teamId}/activity-type-subtypes`),
      api.get<AiNoteProfile[]>(`/api/admin/teams/${teamId}/ai-note-profiles`),
    ]).then(([a, ty, st, pr]) => {
      if (cancelled) return
      if (!a.data) { setError(a.error ?? 'errors.server'); return }
      setView(a.data)
      setTypes(ty.data ?? [])
      setSubtypes(st.data ?? [])
      setProfiles(pr.data ?? [])
    })
    return () => { cancelled = true }
  }, [teamId])

  if (!view) {
    return error
      ? <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{t(error)}</p>
      : <div className="flex justify-center py-8"><Spinner /></div>
  }
  return tab === 'assessments'
    ? <AssessmentsTab teamId={teamId} view={view} onView={setView} profiles={profiles} />
    : <AssignmentsTab teamId={teamId} view={view} onView={setView} types={types} subtypes={subtypes} />
}

function IntroBanner({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{text}</span>
    </div>
  )
}

// ---- Assessments tab --------------------------------------------------------

function AssessmentsTab({ teamId, view, onView, profiles }: { teamId: string; view: AiAssessmentsAdminView; onView: (v: AiAssessmentsAdminView) => void; profiles: AiNoteProfile[] }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const { teams } = useTeam()
  const teamName = (id: string) => teams.find((tm) => tm.id === id)?.name ?? '—'
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startNew() {
    setError(null)
    setDraft({ id: null, name: '', description: '', icon: null, iconColor: null, aiNoteProfileId: null, isActive: true, isLocked: false, teamIds: [teamId], criteria: [newCriterion()] })
  }

  const totalWeight = draft ? draft.criteria.reduce((n, c) => n + (Number.isFinite(weightOf(c)) ? weightOf(c) : 0), 0) : 0
  const draftInvalid = !draft
    || draft.name.trim() === ''
    || draft.criteria.length === 0
    || draft.teamIds.length === 0
    || draft.criteria.some(criterionInvalid)

  function patchCriterion(key: string, patch: Partial<CriterionDraft>) {
    setDraft((d) => d ? { ...d, criteria: d.criteria.map((c) => c.key === key ? { ...c, ...patch } : c) } : d)
  }

  function moveCriterion(index: number, by: -1 | 1) {
    setDraft((d) => {
      if (!d) return d
      const target = index + by
      if (target < 0 || target >= d.criteria.length) return d
      return { ...d, criteria: arrayMove(d.criteria, index, target) }
    })
  }

  function onCriteriaDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setDraft((d) => {
      if (!d) return d
      const from = d.criteria.findIndex((c) => c.key === active.id)
      const to = d.criteria.findIndex((c) => c.key === over.id)
      if (from < 0 || to < 0) return d
      return { ...d, criteria: arrayMove(d.criteria, from, to) }
    })
  }

  function setAllCriteriaOpen(open: boolean) {
    setDraft((d) => d ? { ...d, criteria: d.criteria.map((c) => ({ ...c, open })) } : d)
  }

  async function save() {
    if (!draft) return
    if (draftInvalid) {
      // Open every criterion that needs attention so the admin can see why Save is off.
      setDraft({ ...draft, criteria: draft.criteria.map((c) => criterionInvalid(c) ? { ...c, open: true } : c) })
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      icon: draft.icon,
      iconColor: draft.iconColor,
      aiNoteProfileId: draft.aiNoteProfileId,
      isActive: draft.isActive,
      teamIds: draft.teamIds,
      criteria: draft.criteria.map((c) => ({ name: c.name.trim(), lookFor: c.lookFor.trim() || null, weight: weightOf(c), anchors: c.anchors })),
      ...(view.canLock ? { isLocked: draft.isLocked } : {}),
    }
    const res = draft.id
      ? await api.patch<AiAssessmentsAdminView>(`/api/admin/teams/${teamId}/ai-assessments/${draft.id}`, body)
      : await api.post<AiAssessmentsAdminView>(`/api/admin/teams/${teamId}/ai-assessments`, body)
    setBusy(false)
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    onView(res.data)
    setDraft(null)
  }

  async function toggleActive(a: AiAssessment) {
    setError(null)
    const res = await api.patch<AiAssessmentsAdminView>(`/api/admin/teams/${teamId}/ai-assessments/${a.id}`, { isActive: !a.isActive })
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    onView(res.data)
  }

  async function remove(id: string) {
    setBusy(true)
    setError(null)
    const res = await api.delete<AiAssessmentsAdminView>(`/api/admin/teams/${teamId}/ai-assessments/${id}`)
    setBusy(false)
    setConfirmDelete(null)
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    onView(res.data)
    if (draft?.id === id) setDraft(null)
  }

  const anyOpen = draft?.criteria.some((c) => c.open) ?? false
  const editor = draft ? (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ai-assessment-name">{t('admin.ai_assessments.name_label')}</Label>
          <Input id="ai-assessment-name" value={draft.name} maxLength={120} placeholder={t('admin.ai_assessments.name_placeholder')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ai-assessment-description">{t('admin.ai_assessments.description_label')}</Label>
          <Input id="ai-assessment-description" value={draft.description} maxLength={1000} placeholder={t('admin.ai_assessments.description_placeholder')} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">{t('admin.ai_assessments.icon_label')}</Label>
          <div className="flex items-center gap-2">
            <IconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
            <AssessmentIcon a={draft} className="h-5 w-5" />
          </div>
        </div>
        <ColorPicker
          label={t('admin.ai_assessments.icon_color_label')}
          value={draft.iconColor}
          onChange={(next) => setDraft({ ...draft, iconColor: next })}
          onReset={() => setDraft({ ...draft, iconColor: null })}
        />
        <div className="flex flex-wrap items-center gap-4 pb-1.5">
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            <input id="ai-assessment-active" type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} className="rounded border-gray-300 dark:border-gray-600" />
            {t('admin.ai_assessments.active_label')}
          </label>
          {view.canLock ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300" title={t('admin.ai_assessments.lock_hint')}>
              <input id="ai-assessment-locked" type="checkbox" checked={draft.isLocked} onChange={(e) => setDraft({ ...draft, isLocked: e.target.checked })} className="rounded border-gray-300 dark:border-gray-600" />
              <Lock className="h-3.5 w-3.5" />
              {t('admin.ai_assessments.lock_label')}
            </label>
          ) : null}
        </div>
      </div>

      <TeamAssignmentPicker selectedIds={draft.teamIds} onChange={(ids) => setDraft({ ...draft, teamIds: ids })} disabled={busy} />

      <div className="flex max-w-md flex-col gap-1">
        <Label htmlFor="ai-assessment-profile" className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5" />
          {t('admin.ai_assessments.profile_label')}
        </Label>
        <Select
          id="ai-assessment-profile"
          value={draft.aiNoteProfileId ?? ''}
          onChange={(e) => setDraft({ ...draft, aiNoteProfileId: e.target.value || null })}
          disabled={busy}
        >
          <option value="">{t('admin.ai_assessments.profile_none')}</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {draft.aiNoteProfileId && !profiles.some((p) => p.id === draft.aiNoteProfileId) ? (
            <option value={draft.aiNoteProfileId}>
              {view.assessments.find((x) => x.id === draft.id)?.aiNoteProfileName ?? t('admin.ai_assessments.profile_other_team')}
            </option>
          ) : null}
        </Select>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {profiles.length === 0 ? t('admin.ai_assessments.profile_hint_empty') : t('admin.ai_assessments.profile_hint')}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <ListChecks className="h-4 w-4" />
            {t('admin.ai_assessments.criteria_label')}
          </h4>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-600 dark:text-gray-400">{t('admin.ai_assessments.criteria_hint', { max: AI_ASSESSMENT_MAX_WEIGHT })}</span>
            {draft.criteria.length > 1 ? (
              <button type="button" onClick={() => setAllCriteriaOpen(!anyOpen)} className="flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300">
                {anyOpen ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {anyOpen ? t('admin.ai_assessments.collapse_all') : t('admin.ai_assessments.expand_all')}
              </button>
            ) : null}
          </div>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onCriteriaDragEnd}>
          <SortableContext items={draft.criteria.map((c) => c.key)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5">
              {draft.criteria.map((c, i) => (
                <CriterionRow
                  key={c.key}
                  c={c}
                  index={i}
                  count={draft.criteria.length}
                  totalWeight={totalWeight}
                  onPatch={(patch) => patchCriterion(c.key, patch)}
                  onMove={(by) => moveCriterion(i, by)}
                  onRemove={() => setDraft({ ...draft, criteria: draft.criteria.filter((x) => x.key !== c.key) })}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.criteria.length >= AI_ASSESSMENT_MAX_CRITERIA}
            onClick={() => setDraft({ ...draft, criteria: [...draft.criteria.map((c) => criterionInvalid(c) ? c : { ...c, open: false }), newCriterion()] })}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('admin.ai_assessments.add_criterion')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={busy || draft.name.trim() === '' || draft.teamIds.length === 0}>
          {busy ? <Spinner className="mr-1 h-4 w-4" /> : <Save className="mr-1 h-4 w-4" />}
          {t('common.save')}
        </Button>
        <Button type="button" variant="outline" onClick={() => { setDraft(null); setError(null) }} disabled={busy}>
          <X className="mr-1 h-4 w-4" />
          {t('common.cancel')}
        </Button>
        {draft.criteria.some(criterionInvalid) ? (
          <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5" />
            {t('admin.ai_assessments.criteria_incomplete')}
          </span>
        ) : null}
      </div>
    </div>
  ) : null

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <IntroBanner text={t('admin.ai_assessments.intro')} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('admin.ai_assessments.count', { count: view.assessments.length })}</p>
        <Button type="button" size="sm" onClick={startNew} disabled={busy || (draft !== null && draft.id === null)}>
          <Plus className="mr-1 h-4 w-4" />
          {t('admin.ai_assessments.new')}
        </Button>
      </div>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{t(error)}</p> : null}
      {draft && draft.id === null ? (
        <section className={`${CARD} border-indigo-300 p-4 dark:border-indigo-700`}>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <AssessmentIcon a={draft} />
            {draft.name.trim() || t('admin.ai_assessments.new')}
          </h3>
          {editor}
        </section>
      ) : null}
      {view.assessments.length === 0 && !draft ? (
        <div className={`${CARD} border-dashed px-4 py-10 text-center`}>
          <ClipboardCheck className="mx-auto h-6 w-6 text-gray-400" />
          <p className="mt-2 text-sm font-medium text-gray-800 dark:text-gray-200">{t('admin.ai_assessments.empty_title')}</p>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{t('admin.ai_assessments.empty_hint')}</p>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {view.assessments.map((a) => {
          const editingThis = draft?.id === a.id
          const open = editingThis || expanded.has(a.id)
          const readOnly = a.isLocked && !view.canLock
          const total = a.criteria.reduce((n, c) => n + c.weight, 0)
          return (
            <div key={a.id} className={`${CARD} ${editingThis ? 'border-indigo-300 dark:border-indigo-700' : ''} ${a.isActive ? '' : 'opacity-75'}`}>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => { if (!editingThis) toggleExpanded(a.id) }}
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {open ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
                  <AssessmentIcon a={a} className="h-5 w-5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{a.name}</span>
                    {a.description ? <span className="block truncate text-xs text-gray-600 dark:text-gray-400">{a.description}</span> : null}
                  </span>
                </button>
                <div className="flex flex-wrap items-center gap-1.5">
                  {a.isActive
                    ? <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />{t('admin.ai_assessments.active')}</Badge>
                    : <Badge variant="secondary"><CircleSlash className="mr-1 h-3 w-3" />{t('admin.ai_assessments.inactive')}</Badge>}
                  {a.isLocked ? <Badge variant="warning" title={t('admin.ai_assessments.lock_hint')}><Lock className="mr-1 h-3 w-3" />{t('admin.ai_assessments.locked')}</Badge> : null}
                  {a.aiNoteProfileName ? <Badge variant="outline" title={t('admin.ai_assessments.profile_badge_hint')}><Layers className="mr-1 h-3 w-3" />{a.aiNoteProfileName}</Badge> : null}
                  <Badge variant="outline"><ListChecks className="mr-1 h-3 w-3" />{t('admin.ai_assessments.criteria_count', { count: a.criteria.length })}</Badge>
                  <Badge variant="outline"><ClipboardCheck className="mr-1 h-3 w-3" />{t('admin.ai_assessments.assigned_count', { count: a.assignmentCount })}</Badge>
                  <Badge variant="outline" title={a.teamIds.map(teamName).join(', ')}><Users className="mr-1 h-3 w-3" />{t('admin.ai_assessments.team_count', { count: a.teamIds.length })}</Badge>
                  {!readOnly && !editingThis ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => { setError(null); setDraft(draftFrom(a)) }}
                      disabled={busy}
                      title={t('common.edit')}
                      aria-label={t('common.edit')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
              {open ? (
                <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-800">
                  {editingThis ? editor : (
                    <div className="flex flex-col gap-3">
                      <ol className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
                        {a.criteria.map((c, i) => (
                          <li key={c.id} className="flex items-start gap-3 py-1.5 text-xs">
                            <span className="w-4 shrink-0 pt-px text-right font-semibold tabular-nums text-gray-400 dark:text-gray-500">{i + 1}</span>
                            <span className="min-w-0 flex-1">
                              <span className="font-medium text-gray-900 dark:text-gray-100">{c.name}</span>
                              {c.lookFor ? <span className="block text-gray-600 dark:text-gray-400">{c.lookFor}</span> : null}
                            </span>
                            <span className="shrink-0 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                              {c.weight} <span className="text-gray-500 dark:text-gray-400">({total > 0 ? Math.round((c.weight / total) * 100) : 0}%)</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="mr-auto text-[11px] text-gray-500 dark:text-gray-400">
                          {t('admin.ai_assessments.version_line', { version: a.version, when: new Date(a.updatedAt).toLocaleDateString(), name: a.updatedByName ?? '—' })}
                        </p>
                        {readOnly ? (
                          <span className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400"><Lock className="h-3.5 w-3.5" />{t('admin.ai_assessments.locked_readonly')}</span>
                        ) : (
                          <>
                            <Button type="button" size="sm" variant="outline" onClick={() => void toggleActive(a)} disabled={busy}>
                              {a.isActive ? <CircleSlash className="mr-1 h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                              {a.isActive ? t('admin.ai_assessments.deactivate') : t('admin.ai_assessments.activate')}
                            </Button>
                            <Button type="button" size="sm" variant="outline" onClick={() => { setError(null); setDraft(draftFrom(a)) }} disabled={busy}>
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              {t('common.edit')}
                            </Button>
                            {confirmDelete === a.id ? (
                              <>
                                <Button type="button" size="sm" variant="destructive" onClick={() => void remove(a.id)} disabled={busy}>
                                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                                  {a.teamIds.length > 1 ? t('admin.ai_assessments.confirm_delete_shared', { count: a.teamIds.length }) : t('admin.ai_assessments.confirm_delete')}
                                </Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>
                                  <X className="mr-1 h-3.5 w-3.5" />
                                  {t('common.cancel')}
                                </Button>
                              </>
                            ) : (
                              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(a.id)} disabled={busy} title={t('common.delete')} aria-label={t('common.delete')}>
                                <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                              </Button>
                            )}
                          </>
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
    </div>
  )
}

function CriterionRow({ c, index, count, totalWeight, onPatch, onMove, onRemove }: {
  c: CriterionDraft
  index: number
  count: number
  totalWeight: number
  onPatch: (patch: Partial<CriterionDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.key })
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const w = weightOf(c)
  const share = totalWeight > 0 && Number.isFinite(w) ? Math.round((w / totalWeight) * 100) : 0
  const invalid = criterionInvalid(c)
  const levelCount = Object.values(c.anchors).filter((v) => v && v.trim() !== '').length
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
          aria-label={t('admin.ai_assessments.drag_handle')}
          title={t('admin.ai_assessments.drag_handle')}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="w-4 shrink-0 text-center text-xs font-semibold tabular-nums text-gray-400 dark:text-gray-500">{index + 1}</span>
        <button type="button" onClick={() => onPatch({ open: !c.open })} aria-expanded={c.open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {c.open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
          <span className={`truncate text-sm ${c.name.trim() ? 'font-medium text-gray-900 dark:text-gray-100' : 'italic text-gray-500 dark:text-gray-400'}`}>
            {c.name.trim() || t('admin.ai_assessments.criterion_untitled')}
          </span>
          {invalid && !c.open ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" aria-label={t('admin.ai_assessments.criteria_incomplete')} /> : null}
        </button>
        <span className="shrink-0 text-xs tabular-nums text-gray-600 dark:text-gray-400" title={t('admin.ai_assessments.share_hint')}>
          {Number.isFinite(w) ? w : '—'} · {t('admin.ai_assessments.share', { pct: share })}
        </span>
        <div className="flex shrink-0 items-center">
          <Button type="button" size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} title={t('admin.ai_assessments.move_up')} aria-label={t('admin.ai_assessments.move_up')}><ArrowUp className="h-3.5 w-3.5" /></Button>
          <Button type="button" size="sm" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)} title={t('admin.ai_assessments.move_down')} aria-label={t('admin.ai_assessments.move_down')}><ArrowDown className="h-3.5 w-3.5" /></Button>
          <Button type="button" size="sm" variant="ghost" disabled={count === 1} onClick={onRemove} title={t('admin.ai_assessments.remove_criterion')} aria-label={t('admin.ai_assessments.remove_criterion')}><Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" /></Button>
        </div>
      </div>
      {c.open ? (
        <div className="flex flex-col gap-2 border-t border-gray-200 bg-white px-3 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor={`crit-name-${c.key}`}>{t('admin.ai_assessments.criterion_name')}</Label>
              <Input id={`crit-name-${c.key}`} value={c.name} maxLength={120} placeholder={t('admin.ai_assessments.criterion_name_placeholder')} onChange={(e) => onPatch({ name: e.target.value })} />
            </div>
            <div className="flex w-28 flex-col gap-1">
              <Label htmlFor={`crit-weight-${c.key}`}>{t('admin.ai_assessments.weight')}</Label>
              <Input id={`crit-weight-${c.key}`} type="number" min={1} max={AI_ASSESSMENT_MAX_WEIGHT} step={1} inputMode="numeric" value={c.weight} onChange={(e) => onPatch({ weight: e.target.value })} />
            </div>
          </div>
          {c.name.trim() !== '' && !(w >= 1 && w <= AI_ASSESSMENT_MAX_WEIGHT)
            ? <p className="text-xs text-red-600 dark:text-red-400">{t('admin.ai_assessments.weight_invalid', { max: AI_ASSESSMENT_MAX_WEIGHT })}</p>
            : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`crit-look-${c.key}`}>{t('admin.ai_assessments.look_for')}</Label>
            <Textarea id={`crit-look-${c.key}`} rows={2} maxLength={1000} value={c.lookFor} placeholder={t('admin.ai_assessments.look_for_placeholder')} onChange={(e) => onPatch({ lookFor: e.target.value })} />
          </div>
          <button type="button" onClick={() => onPatch({ levelsOpen: !c.levelsOpen })} aria-expanded={c.levelsOpen} className="flex items-center gap-1 self-start text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300">
            {c.levelsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t('admin.ai_assessments.levels_toggle', { count: levelCount })}
          </button>
          {c.levelsOpen ? (
            <div className="grid gap-2">
              <p className="text-xs text-gray-600 dark:text-gray-400">{t('admin.ai_assessments.levels_hint')}</p>
              {AI_ASSESSMENT_LEVELS.map((level) => {
                const k = String(level) as keyof AiAssessmentAnchors
                return (
                  <div key={level} className="flex items-center gap-2">
                    <Label htmlFor={`crit-anchor-${c.key}-${level}`} className="w-16 shrink-0 text-xs">{t('admin.ai_assessments.level', { level })}</Label>
                    <Input
                      id={`crit-anchor-${c.key}-${level}`}
                      value={c.anchors[k] ?? ''}
                      maxLength={300}
                      placeholder={level === 1 ? t('admin.ai_assessments.level_1_placeholder') : level === 5 ? t('admin.ai_assessments.level_5_placeholder') : ''}
                      onChange={(e) => onPatch({ anchors: { ...c.anchors, [k]: e.target.value } })}
                    />
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---- Assignments tab --------------------------------------------------------

interface Slot {
  key: string
  type: ActivityType
  subtype: ActivityTypeSubtype | null
}

function AssignmentsTab({ teamId, view, onView, types, subtypes }: {
  teamId: string
  view: AiAssessmentsAdminView
  onView: (v: AiAssessmentsAdminView) => void
  types: ActivityType[]
  subtypes: ActivityTypeSubtype[]
}) {
  const { t } = useTranslation()
  const { teams } = useTeam()
  const subtypesEnabled = !!teams.find((tm) => tm.id === teamId)?.subtypesEnabled
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set())
  const byId = useMemo(() => new Map(view.assessments.map((a) => [a.id, a])), [view.assessments])
  const activeAssessments = view.assessments.filter((a) => a.isActive)
  const ignoredSubtypeRows = subtypesEnabled ? 0 : view.assignments.filter((x) => x.subtypeId !== null).length

  function rowsFor(slot: Slot): AiAssessmentAssignment[] {
    return view.assignments.filter((x) => x.activityTypeId === slot.type.id && x.subtypeId === (slot.subtype?.id ?? null))
  }

  function toggleType(id: string) {
    setOpenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function add(slot: Slot, assessmentId: string) {
    if (!assessmentId) return
    setBusy(slot.key)
    setError(null)
    const res = await api.post<AiAssessmentsAdminView>(`/api/admin/teams/${teamId}/ai-assessment-assignments`, {
      activityTypeId: slot.type.id,
      subtypeId: slot.subtype?.id ?? null,
      assessmentId,
    })
    setBusy(null)
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    onView(res.data)
  }

  async function remove(slotKey: string, assignmentId: string) {
    setBusy(slotKey)
    setError(null)
    const res = await api.delete<AiAssessmentsAdminView>(`/api/admin/teams/${teamId}/ai-assessment-assignments/${assignmentId}`)
    setBusy(null)
    if (!res.data) { setError(res.error ?? 'errors.server'); return }
    onView(res.data)
  }

  function slotControls(slot: Slot) {
    const rows = rowsFor(slot)
    const assignedIds = new Set(rows.map((r) => r.assessmentId))
    const options = activeAssessments.filter((a) => !assignedIds.has(a.id))
    const full = rows.length >= AI_ASSESSMENT_MAX_PER_ACTIVITY
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {rows.map((r) => {
          const a = byId.get(r.assessmentId)
          return (
            <span
              key={r.id}
              className={`inline-flex items-center gap-1 rounded-full border bg-white px-2 py-0.5 text-xs dark:bg-gray-900 ${a?.isActive === false
                ? 'border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400'
                : 'border-gray-300 text-gray-800 dark:border-gray-600 dark:text-gray-100'}`}
            >
              {a ? <AssessmentIcon a={a} className="h-3 w-3" /> : <ClipboardCheck className="h-3 w-3" />}
              {a?.name ?? '—'}
              {a?.isActive === false ? <span className="italic">({t('admin.ai_assessments.inactive')})</span> : null}
              <button type="button" disabled={busy === slot.key} onClick={() => void remove(slot.key, r.id)} title={t('admin.ai_assessments.unassign')} aria-label={t('admin.ai_assessments.unassign')} className="ml-0.5 rounded hover:text-red-600 dark:hover:text-red-400">
                <X className="h-3 w-3" />
              </button>
            </span>
          )
        })}
        {!full && options.length > 0 ? (
          <Select
            aria-label={t('admin.ai_assessments.add_assignment')}
            className="h-7 w-auto bg-white py-0 text-xs dark:bg-gray-900"
            value=""
            disabled={busy === slot.key}
            onChange={(e) => void add(slot, e.target.value)}
          >
            <option value="">{t('admin.ai_assessments.add_assignment')}</option>
            {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        ) : null}
        {rows.length === 0 && (full || options.length === 0) ? <span className="text-xs text-gray-500 dark:text-gray-400">—</span> : null}
        {busy === slot.key ? <Spinner className="h-3.5 w-3.5" /> : null}
      </div>
    )
  }

  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <IntroBanner text={subtypesEnabled ? t('admin.ai_assessments.assign_intro') : t('admin.ai_assessments.assign_intro_no_subtypes')} />
      {ignoredSubtypeRows > 0 ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {t('admin.ai_assessments.subtype_rows_ignored', { count: ignoredSubtypeRows })}
        </p>
      ) : null}
      {view.assessments.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('admin.ai_assessments.assign_none_defined')}</p>
      ) : null}
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{t(error)}</p> : null}
      <div className="flex flex-col gap-1.5">
        {types.map((type) => {
          const typeSlot: Slot = { key: `${type.id}:all`, type, subtype: null }
          const typeSubtypes = subtypesEnabled ? subtypes.filter((s) => s.teamActivityTypeId === type.id) : []
          const subtypeSlots: Slot[] = typeSubtypes.map((st) => ({ key: `${type.id}:${st.id}`, type, subtype: st }))
          const ownCount = subtypeSlots.filter((s) => rowsFor(s).length > 0).length
          const open = openTypes.has(type.id)
          const strong = tint(type.color, 0.16)
          const light = tint(type.color, 0.06)
          return (
            <div key={type.id} className={`${CARD} overflow-hidden`}>
              <div
                className={`flex flex-wrap items-center gap-2 px-3 py-1.5 ${strong ? '' : 'bg-gray-100 dark:bg-gray-800'}`}
                style={strong ? { backgroundColor: strong } : undefined}
              >
                {subtypeSlots.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggleType(type.id)}
                    aria-expanded={open}
                    title={open ? t('admin.ai_assessments.hide_subtypes') : t('admin.ai_assessments.show_subtypes')}
                    aria-label={open ? t('admin.ai_assessments.hide_subtypes') : t('admin.ai_assessments.show_subtypes')}
                    className="rounded p-0.5 text-gray-600 hover:bg-black/5 dark:text-gray-300 dark:hover:bg-white/10"
                  >
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : <span className="w-5" />}
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                  <DynamicIcon name={type.icon ?? 'Circle'} className="h-4 w-4 shrink-0" style={type.color ? { color: type.color } : undefined} />
                  <span className="truncate">{type.name}</span>
                </span>
                {subtypeSlots.length > 0 ? (
                  <button type="button" onClick={() => toggleType(type.id)} className="text-[11px] text-gray-600 hover:underline dark:text-gray-400">
                    {t('admin.ai_assessments.subtype_summary', { count: subtypeSlots.length, own: ownCount })}
                  </button>
                ) : null}
                <div className="ml-auto">{slotControls(typeSlot)}</div>
              </div>
              {open ? subtypeSlots.map((slot) => {
                const own = rowsFor(slot).length > 0
                return (
                  <div
                    key={slot.key}
                    className={`flex flex-wrap items-center gap-2 border-t border-gray-100 py-1 pl-10 pr-3 dark:border-gray-800 ${light ? '' : 'bg-gray-50 dark:bg-gray-800/40'}`}
                    style={light ? { backgroundColor: light } : undefined}
                  >
                    <span className="min-w-0 truncate text-sm text-gray-800 dark:text-gray-200">{slot.subtype!.name}</span>
                    {!own ? <span className="text-[11px] italic text-gray-500 dark:text-gray-400">{t('admin.ai_assessments.inherits')}</span> : null}
                    <div className="ml-auto">{slotControls(slot)}</div>
                  </div>
                )
              }) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
