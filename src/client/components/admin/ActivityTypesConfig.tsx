import { useState, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, X, Save, PlugZap, Star, Tags, LifeBuoy, Eye, Sparkles, Ticket, CircleSlash } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { api } from '../../lib/api.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Textarea } from '../ui/textarea.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { TeamAssignmentPicker } from './TeamAssignmentPicker.js'
import { useTeam } from '../../hooks/useTeam.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { IconPicker, DynamicIcon } from '../ui/icon-picker.js'
import { ColorPicker } from '../ui/color-picker.js'
import { MarkdownProse } from '../ui/markdown-prose.js'
import { ActivityTypesTransfer } from './ActivityTypesTransfer.js'
import { useEvaluationSource } from '../../store/evaluationSource.js'
import { useCrmProvider } from '../../store/crmProvider.js'
import { CRITERIAIQ_RELATED_TYPE } from '../../../shared/evaluationSource.js'
import type { HubspotProjectObject, HubspotPropertyField } from '../../../shared/hubspot.js'
import { CRM_DISPLAY_NAMES } from '../../../shared/crmProvider.js'
import { activityTypeExtraCrm, HUBSPOT_OPP_FIELD_OBJECT } from '../../../shared/crmExtras.js'

interface ActivityType {
  id: string
  teamId: string | null
  name: string
  crmObjectType: 'Event' | 'Task'
  isActive: boolean
  sortOrder: number
  teamIds: string[]
  color: string | null
  icon: string | null
  // Optional override — when set, writeback uses this string as the SF Type
  // picklist value. Multiple activity types can share the same override so
  // fine-grained ImpactIQ types (Build out / Test / Architect) all roll up to
  // one SF value (Eval Work).
  crmPicklistValue?: string | null
  // Merged from the old Salesforce Type Mapping page: these live in
  // sf_event_type_config keyed by (teamId, crm_picklist_value ?? name).
  sfPicklistIsActive?: boolean
  fallbackValue?: string | null
  typicalDurationMinutes?: number | null
  // v1.70.0: count of team_activity_type_crm_extras rows attached to
  // this type. Powers the small marker on the list row so admins can
  // see at a glance which types have SF Extras wired up.
  sfExtrasCount?: number
  // v1.240.0: the type the Outlook suggestion fallback uses when no
  // keyword rule and no AI classification produced a result. Team-scoped
  // only — meaningless (and hidden) on global types, since the fallback
  // reads team_activity_types.teamId directly rather than the shared/
  // junction assignment global types use.
  isDefaultSuggestion?: boolean
  // v1.255.0: Guide fields — see the "Classify Activity" section below
  // and the Guide page (src/client/pages/Guide.tsx) that reads them.
  useThisWhen?: string | null
  usuallyAttachTo?: string | null
  examples?: string | null
}

interface FormState {
  name: string
  isActive: boolean
  crmObjectType: 'Event' | 'Task'
  teamIds: string[]
  color: string
  icon: string | null
  crmPicklistValue: string
  sfPicklistIsActive: boolean
  fallbackValue: string
  typicalDurationMinutes: string
  useThisWhen: string
  usuallyAttachTo: string
  examples: string
}

const DEFAULT_COLOR = '#64748B'

export function ActivityTypesConfig({ teamId, globalView }: { teamId: string; globalView?: boolean }) {
  const { t } = useTranslation()
  const extrasCtx = useCrmProvider() === 'hubspot' ? 'hubspot' : undefined
  const { teams, reloadTeams } = useTeam()
  const { user } = useCurrentUser()
  const isAppAdmin = !!user?.isAppAdmin
  const showTeamPicker = isAppAdmin
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [types, setTypes] = useState<ActivityType[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [seedMessage, setSeedMessage] = useState<string | null>(null)
  // v1.256.0: team-wide toggle for the Log Activity form / Activity
  // Templates Subtype picker — read off the shared team list (already
  // includes subtypesEnabled) rather than a dedicated fetch, mirroring
  // how globalView's team-name badges above reuse the same `teams` list.
  const [subtypesTogglePending, setSubtypesTogglePending] = useState(false)
  const subtypesEnabled = !!teams.find((tm) => tm.id === teamId)?.subtypesEnabled

  async function toggleSubtypesEnabled(next: boolean) {
    setSubtypesTogglePending(true)
    await api.patch(`/api/admin/teams/${teamId}/subtypes-enabled`, { subtypesEnabled: next })
    await reloadTeams()
    setSubtypesTogglePending(false)
  }
  // v1.255.5: bumped whenever seedDefaultContent() sets Distinctions, so
  // GuideDistinctionsEditor (which owns its own load state) refetches
  // without the parent needing to know its internals.
  const [distinctionsReloadKey, setDistinctionsReloadKey] = useState(0)
  const emptyForm = (initialTeamIds: string[]): FormState => ({ name: '', isActive: true, crmObjectType: 'Event', teamIds: initialTeamIds, color: DEFAULT_COLOR, icon: null, crmPicklistValue: '', sfPicklistIsActive: true, fallbackValue: '', typicalDurationMinutes: '', useThisWhen: '', usuallyAttachTo: '', examples: '' })
  const [createForm, setCreateForm] = useState<FormState>(emptyForm(globalView ? [] : [teamId]))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<FormState>(emptyForm([]))

  const teamNameById = new Map(teams.map((tm) => [tm.id, tm.name]))

  async function reload() {
    setLoading(true)
    const url = globalView ? '/api/admin/activity-types' : `/api/admin/teams/${teamId}/activity-types`
    const res = await api.get<ActivityType[]>(url)
    setTypes(res.data ?? [])
    setLoading(false)
  }

  useEffect(() => { void reload() }, [teamId, globalView])

  async function update(id: string, patch: Partial<ActivityType> & { teamIds?: string[] }) {
    setSaving(id)
    const url = globalView ? `/api/admin/activity-types/${id}` : `/api/admin/teams/${teamId}/activity-types/${id}`
    const res = await api.patch(url, patch)
    setSaving(null)
    if (res.error) { setDeleteError(res.error); return }
    await reload()
  }

  async function submitCreate() {
    if (!createForm.name.trim()) return
    setSaving('create')
    const url = globalView ? '/api/admin/activity-types' : `/api/admin/teams/${teamId}/activity-types`
    const dur = createForm.typicalDurationMinutes.trim()
    const res = await api.post(url, {
      name: createForm.name.trim(),
      crmObjectType: createForm.crmObjectType,
      teamIds: createForm.teamIds,
      color: createForm.color,
      ...(createForm.icon ? { icon: createForm.icon } : {}),
      crmPicklistValue: createForm.crmPicklistValue.trim() || null,
      useThisWhen: createForm.useThisWhen.trim() || null,
      usuallyAttachTo: createForm.usuallyAttachTo.trim() || null,
      examples: createForm.examples.trim() || null,
    })
    if (res.error) { setSaving(null); setDeleteError(res.error); return }
    // After base insert succeeds (team-scoped only), send the SF Mapping fields
    // via the PATCH so sf_event_type_config is upserted for this team+name.
    const createdId = (res.data as { id?: string } | null)?.id
    if (!globalView && createdId && (createForm.sfPicklistIsActive !== undefined || createForm.fallbackValue || dur)) {
      const patchRes = await api.patch(`/api/admin/teams/${teamId}/activity-types/${createdId}`, {
        sfPicklistIsActive: createForm.sfPicklistIsActive,
        fallbackValue: createForm.fallbackValue.trim() || null,
        typicalDurationMinutes: dur === '' ? null : Number(dur),
      })
      if (patchRes.error) { setSaving(null); setDeleteError(patchRes.error); return }
    }
    setSaving(null)
    setCreating(false)
    setCreateForm(emptyForm(globalView ? [] : [teamId]))
    await reload()
  }

  function openEdit(type: ActivityType) {
    setEditingId(type.id)
    setEditForm({
      name: type.name,
      isActive: type.isActive,
      crmObjectType: type.crmObjectType,
      teamIds: type.teamIds,
      color: type.color ?? DEFAULT_COLOR,
      icon: type.icon,
      crmPicklistValue: type.crmPicklistValue ?? '',
      sfPicklistIsActive: type.sfPicklistIsActive ?? true,
      fallbackValue: type.fallbackValue ?? '',
      typicalDurationMinutes: type.typicalDurationMinutes != null ? String(type.typicalDurationMinutes) : '',
      useThisWhen: type.useThisWhen ?? '',
      usuallyAttachTo: type.usuallyAttachTo ?? '',
      examples: type.examples ?? '',
    })
  }

  async function submitEdit() {
    if (!editingId || !editForm.name.trim()) return
    const dur = editForm.typicalDurationMinutes.trim()
    await update(editingId, {
      name: editForm.name.trim(),
      isActive: editForm.isActive,
      crmObjectType: editForm.crmObjectType,
      teamIds: editForm.teamIds,
      color: editForm.color,
      icon: editForm.icon,
      crmPicklistValue: editForm.crmPicklistValue.trim() || null,
      useThisWhen: editForm.useThisWhen.trim() || null,
      usuallyAttachTo: editForm.usuallyAttachTo.trim() || null,
      examples: editForm.examples.trim() || null,
      ...(!globalView && {
        sfPicklistIsActive: editForm.sfPicklistIsActive,
        fallbackValue: editForm.fallbackValue.trim() || null,
        typicalDurationMinutes: dur === '' ? null : Number(dur),
      }),
    } as Partial<ActivityType> & { teamIds?: string[] })
    setEditingId(null)
  }

  // v1.255.4/1.255.5: admin fallback for when migrations 0128/0129's
  // hardcoded team-slug match silently found no matching team — see
  // defaultGuideContent.ts. Lives at the parent level (not inside
  // GuideDistinctionsEditor) so its button can sit next to Add Activity
  // Type per the layout the type list itself, not just Distinctions,
  // is what the seed actually fills in.
  async function seedDefaultContent() {
    setSeeding(true)
    setSeedMessage(null)
    const res = await api.post<{ typesUpdated: number; subtypesInserted: number; distinctionsSet: boolean }>(`/api/admin/teams/${teamId}/seed-guide-content`, {})
    setSeeding(false)
    if (res.data) {
      setSeedMessage(t('admin.activity_types.guide_seed_result', '{{types}} activity type(s) updated, {{subtypes}} subtype(s) added.', { types: res.data.typesUpdated, subtypes: res.data.subtypesInserted }))
      if (res.data.distinctionsSet) setDistinctionsReloadKey((k) => k + 1)
      await reload()
    }
  }

  async function remove(type: ActivityType) {
    if (!window.confirm(t('admin.activity_types.delete_confirm', { name: type.name }))) return
    setDeleteError(null)
    setSaving(type.id)
    const url = globalView ? `/api/admin/activity-types/${type.id}` : `/api/admin/teams/${teamId}/activity-types/${type.id}`
    const res = await api.delete(url)
    setSaving(null)
    if (res.error === 'in_use') {
      setDeleteError(t('admin.activity_types.delete_in_use', { name: type.name }))
      return
    }
    if (res.error) {
      setDeleteError(res.error)
      return
    }
    await reload()
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  const gridCols = globalView ? 'grid-cols-[1fr_120px_1fr_100px_80px]' : 'grid-cols-[1fr_120px_100px_80px]'

  return (
    <div className="flex flex-col gap-3">
      {!globalView && <GuideDistinctionsEditor teamId={teamId} reloadKey={distinctionsReloadKey} />}
      {deleteError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {deleteError}
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-700 dark:text-gray-300">{types.length} {t('admin.activity_types.count')}</p>
        <div className="flex items-center gap-2">
          {seedMessage && <span className="text-xs text-green-600 dark:text-green-400">{seedMessage}</span>}
          {/* v1.256.0: team-wide Subtype picker kill switch — sits to the
              left of Seed Default Content, both team-scoped-only controls
              on this same header row. */}
          {!globalView && (
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={subtypesEnabled}
                onChange={(e) => void toggleSubtypesEnabled(e.target.checked)}
                disabled={subtypesTogglePending}
                className="h-3.5 w-3.5"
              />
              {t('admin.activity_types.subtypes_enabled_label', 'Enable Subtypes')}
            </label>
          )}
          {/* v1.255.5: moved here (left of Add Activity Type) from the
              Distinctions card — the seed action fills in the type list's
              own Classify Activity / Subtypes fields, not just Distinctions,
              so it reads more naturally next to the action that adds to
              that same list. */}
          {!globalView && (
            <Button size="sm" variant="outline" onClick={() => void seedDefaultContent()} disabled={seeding}>
              {seeding ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
              {t('admin.activity_types.guide_seed_button', 'Seed Default Content')}
            </Button>
          )}
          {/* v1.374.0: Export / Import the team's whole Activity Types setup
              (types, icons, subtypes, SF Extras, Classify Activity text,
              Distinctions) as one JSON file. */}
          {!globalView && (
            <ActivityTypesTransfer
              teamId={teamId}
              onApplied={async () => { await reload(); await reloadTeams(); setDistinctionsReloadKey((k) => k + 1) }}
            />
          )}
          {!creating && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {t('admin.activity_types.add')}
            </Button>
          )}
        </div>
      </div>

      {creating && (
        <FormCard
          title={t('admin.activity_types.add')}
          form={createForm}
          setForm={setCreateForm}
          onSubmit={submitCreate}
          onCancel={() => { setCreating(false); setCreateForm(emptyForm(globalView ? [] : [teamId])) }}
          saving={saving === 'create'}
          showTeamPicker={showTeamPicker}
          showSfMappingSection={!globalView}
        />
      )}

      <div className="flex flex-col gap-1">
        <div className={`mb-1 grid ${gridCols} gap-3 px-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500`}>
          <span>{t('admin.activity_types.name')}</span>
          <span>{t('admin.activity_types.sf_object')}</span>
          {globalView && <span>{t('admin.activity_types.scope')}</span>}
          <span>{t('admin.activity_types.status')}</span>
          <span></span>
        </div>
        {types.map((type) =>
          editingId === type.id ? (
            <FormCard
              key={type.id}
              title={t('common.edit')}
              form={editForm}
              setForm={setEditForm}
              onSubmit={submitEdit}
              onCancel={() => setEditingId(null)}
              saving={saving === type.id}
              showTeamPicker={showTeamPicker}
              showSfMappingSection={!globalView}
              extraSection={!globalView ? (
                <div className="flex flex-col gap-3">
                  <SfExtrasEditor teamId={teamId!} typeId={type.id} />
                  <SubtypesEditor teamId={teamId!} typeId={type.id} />
                </div>
              ) : undefined}
            />
          ) : (
            <div key={type.id} className={`grid ${gridCols} items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900`}>
              <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                  {type.icon && <DynamicIcon name={type.icon} className="h-4 w-4" style={type.color ? { color: type.color } : undefined} />}
                  {!type.icon && type.color && <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: type.color }} />}
                  {type.name}
                  {/* v1.240.0: lives here rather than the SF Object column —
                      that column is 120px, sized for the Event/Task select
                      alone, and had already started clipping it once the SF
                      Extras marker showed up too. The Name column is 1fr. */}
                  {!globalView && (
                    <button
                      type="button"
                      onClick={() => update(type.id, { isDefaultSuggestion: !type.isDefaultSuggestion })}
                      disabled={saving === type.id}
                      title={type.isDefaultSuggestion
                        ? t('admin.activity_types.default_suggestion_hint_on', 'Used when no keyword rule or AI classification matches — click to unset')
                        : t('admin.activity_types.default_suggestion_hint_off', 'Set as the fallback suggestion when nothing else matches')}
                      className="shrink-0"
                    >
                      <Badge
                        variant={type.isDefaultSuggestion ? 'default' : 'outline'}
                        className={cn('gap-1 text-[10px]', !type.isDefaultSuggestion && 'text-gray-400 dark:text-gray-500')}
                      >
                        <Star className="h-2.5 w-2.5" />
                        {t('admin.activity_types.default_suggestion_badge', 'Default')}
                      </Badge>
                    </button>
                  )}
                </span>
                {type.crmPicklistValue && type.crmPicklistValue !== type.name && (
                  <span className="ml-5 text-[10px] text-gray-500 dark:text-gray-400" title={t('admin.activity_types.sf_picklist_value_hint')}>
                    {t('admin.activity_types.sf_picklist_value_arrow')} <span className="font-mono">{type.crmPicklistValue}</span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {(type.sfExtrasCount ?? 0) > 0 && (
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-400"
                    title={t('admin.activity_types.sf_extras_marker', {
                      count: type.sfExtrasCount ?? 0,
                      context: extrasCtx,
                    })}
                  >
                    <PlugZap className="h-3 w-3" />
                  </span>
                )}
                <Select
                  value={type.crmObjectType}
                  onChange={(e) => update(type.id, { crmObjectType: e.target.value as 'Event' | 'Task' })}
                  className="text-xs"
                >
                  <option value="Event">Event</option>
                  <option value="Task">Task</option>
                </Select>
              </div>
              {globalView && (
                <div className="flex flex-wrap gap-1">
                  {type.teamIds.length === 0 ? (
                    <span className="text-xs text-amber-500 dark:text-amber-400">{t('admin.team_assignment.unassigned')}</span>
                  ) : (
                    type.teamIds.map((tid) => (
                      <Badge key={tid} variant="outline" className="text-[10px]">{teamNameById.get(tid) ?? tid.slice(0, 6)}</Badge>
                    ))
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => update(type.id, { isActive: !type.isActive })}
                disabled={saving === type.id}
                className="text-left text-xs"
              >
                <Badge variant={type.isActive ? 'success' : 'outline'}>
                  {type.isActive ? t('admin.picklist.active') : t('admin.picklist.inactive')}
                </Badge>
              </button>
              <div className="flex items-center gap-1">
                <button onClick={() => openEdit(type)} className="rounded p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label={t('common.edit')}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => remove(type)} disabled={saving === type.id} className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400" aria-label={t('common.delete')}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )
        )}
        {types.length === 0 && !creating && (
          <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">
            {t('admin.activity_types.empty')}
          </p>
        )}
      </div>
    </div>
  )
}

interface FormCardProps {
  title: string
  form: FormState
  setForm: (next: FormState) => void
  onSubmit: () => void
  onCancel: () => void
  saving: boolean
  showTeamPicker: boolean
  showSfMappingSection: boolean
  extraSection?: ReactNode
}

function FormCard({ title, form, setForm, onSubmit, onCancel, saving, showTeamPicker, showSfMappingSection, extraSection }: FormCardProps) {
  const { t } = useTranslation()
  const [sfPicklistValues, setSfPicklistValues] = useState<{ value: string; label: string; active: boolean }[]>([])
  const [sfPicklistLoading, setSfPicklistLoading] = useState(false)
  const [sfPicklistError, setSfPicklistError] = useState<string | null>(null)

  // Load live picklist values for the chosen SF Object → Type field. Falls back
  // silently when SF isn't connected admin-side.
  useEffect(() => {
    let cancelled = false
    setSfPicklistLoading(true)
    setSfPicklistError(null)
    api.get<{ values: { value: string; label: string; active: boolean }[] }>(`/api/admin/sf/picklist-values?object=${form.crmObjectType}&field=Type`).then((res) => {
      if (cancelled) return
      if (res.data) setSfPicklistValues(res.data.values)
      else if (res.error) setSfPicklistError(res.error)
      setSfPicklistLoading(false)
    })
    return () => { cancelled = true }
  }, [form.crmObjectType])

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</p>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label>{t('admin.activity_types.name')}</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          <label className="mt-1 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            {t('admin.activity_types.active_label')}
            <span className="text-[10px] text-gray-500 dark:text-gray-400">
              {t('admin.activity_types.active_hint')}
            </span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.activity_types.sf_object')}</Label>
          <Select value={form.crmObjectType} onChange={(e) => setForm({ ...form, crmObjectType: e.target.value as 'Event' | 'Task' })}>
            <option value="Event">Event</option>
            <option value="Task">Task</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <ColorPicker
            label={t('admin.activity_types.color_label')}
            value={form.color}
            onChange={(next) => setForm({ ...form, color: next })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.activity_types.icon_label')}</Label>
          <div className="flex items-center gap-2">
            <IconPicker value={form.icon} onChange={(icon) => setForm({ ...form, icon })} />
            {form.icon && (
              <DynamicIcon name={form.icon} className="h-5 w-5" style={{ color: form.color }} />
            )}
          </div>
        </div>
      </div>
      {/* Salesforce picklist mapping — moved from the old standalone page.
          Fields only meaningful in a team context; hidden in globalView. */}
      {showSfMappingSection && (
        <div className="mt-3 flex flex-col gap-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('admin.activity_types.sf_mapping_section')}
          </p>
          {/* CRM Type value — separate from the ImpactIQ name so
              many activity types (Build out / Test / Architect) can all roll
              up to a single SF value (Eval Work). Blank ⇒ use the name. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>{t('admin.activity_types.sf_picklist_value_label')}</Label>
              {sfPicklistValues.length > 0 ? (
                <Select
                  value={form.crmPicklistValue}
                  onChange={(e) => setForm({ ...form, crmPicklistValue: e.target.value })}
                >
                  <option value="">{t('admin.activity_types.sf_picklist_value_default_option')}</option>
                  {sfPicklistValues.map((v) => (
                    <option key={v.value} value={v.value} disabled={!v.active}>
                      {v.label}{!v.active ? ' (inactive)' : ''}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={form.crmPicklistValue}
                  onChange={(e) => setForm({ ...form, crmPicklistValue: e.target.value })}
                  placeholder={form.name || t('admin.activity_types.sf_type_value_placeholder')}
                />
              )}
              <p className="text-[10px] text-gray-500 dark:text-gray-400">
                {t('admin.activity_types.sf_picklist_value_hint')}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.activity_types.fallback_label')}</Label>
              <Input
                value={form.fallbackValue}
                onChange={(e) => setForm({ ...form, fallbackValue: e.target.value })}
                placeholder="Other"
              />
              <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.fallback_hint_v2')}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>{t('admin.activity_types.typical_duration_label')}</Label>
              <Input
                type="number"
                min={0}
                value={form.typicalDurationMinutes}
                onChange={(e) => setForm({ ...form, typicalDurationMinutes: e.target.value })}
                placeholder="60"
              />
              <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.typical_duration_hint')}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t('admin.activity_types.sf_picklist_active_label')}</Label>
              <label className="mt-1 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={form.sfPicklistIsActive}
                  onChange={(e) => setForm({ ...form, sfPicklistIsActive: e.target.checked })}
                  className="h-3.5 w-3.5"
                />
                {t('admin.activity_types.sf_picklist_active_desc')}
              </label>
              <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.sf_picklist_active_hint')}</p>
            </div>
          </div>
        </div>
      )}
      {/* v1.255.0: read-only reference content surfaced on the Guide page —
          sits between Salesforce Mapping and Assign to teams so the "how
          to classify this activity" fields read together with the SF
          mapping decisions that depend on them, before scoping who sees
          the type at all. */}
      <div className="mt-3 flex flex-col gap-3 border-t border-gray-200 pt-3 dark:border-gray-700">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <Tags className="h-3.5 w-3.5" />
          {t('admin.activity_types.classify_section', 'Classify Activity')}
        </p>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.activity_types.use_this_when_label', 'Use This When')}</Label>
          <Textarea
            rows={2}
            value={form.useThisWhen}
            onChange={(e) => setForm({ ...form, useThisWhen: e.target.value })}
            placeholder={t('admin.activity_types.use_this_when_placeholder', "e.g. You're evaluating whether the product fits a specific technical requirement.")}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.activity_types.usually_attach_to_label', 'Usually Attach To')}</Label>
          <Textarea
            rows={2}
            value={form.usuallyAttachTo}
            onChange={(e) => setForm({ ...form, usuallyAttachTo: e.target.value })}
            placeholder={t('admin.activity_types.usually_attach_to_placeholder', 'e.g. Opportunity, Account, or both')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.activity_types.examples_label', 'Examples')}</Label>
          <Textarea
            rows={2}
            value={form.examples}
            onChange={(e) => setForm({ ...form, examples: e.target.value })}
            placeholder={t('admin.activity_types.examples_placeholder', 'e.g. Configuration review, proof-of-concept, workshop')}
          />
        </div>
        <p className="text-[10px] text-gray-500 dark:text-gray-400">
          {t('admin.activity_types.classify_hint', 'Shown read-only on the Guide page (all roles). Leave all three blank to skip this type on that page.')}
        </p>
      </div>
      {showTeamPicker && (
        <div className="mt-3">
          <TeamAssignmentPicker
            selectedIds={form.teamIds}
            onChange={(ids) => setForm({ ...form, teamIds: ids })}
          />
        </div>
      )}
      {extraSection && <div className="mt-3">{extraSection}</div>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onSubmit} disabled={saving || !form.name.trim()}>
          {saving && <Spinner className="mr-1 h-3 w-3" />}
          <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
      </div>
    </div>
  )
}

interface SfExtraRow {
  id: string
  kind: 'opp_field_display' | 'related_object_picker' | 'ticket_picker'
  config: Record<string, unknown>
}

// v1.67.0: per-activity-type Salesforce Extras. Renders directly under
// the team-scoped edit form so admins can see which extras are wired
// up to a type without leaving the row. Two kinds: read-only Opp field
// readout (e.g. RFP_Request__c on RFx Work) and a related-record picker
// (e.g. Evaluation__c on Eval Work).
interface SfObjectMeta { name: string; label: string; custom: boolean }
interface SfFieldMeta { name: string; label: string; type: string; updateable: boolean }

// v1.67.0 / v1.69.0: per-activity-type Salesforce Extras. Renders
// inside the FormCard above the Save/Cancel row so admins see extras
// as part of the type they're editing. SObject and field selectors
// are live SF describe dropdowns — admins never have to type API
// names by hand. opp_field_display supports a read/write mode when
// the sobject is Opportunity and the SF field is updateable.
// The stored config for a HubSpot Project picker: the object type id, read
// by its primary display property; the label only if one was typed.
function hubspotProjectConfig(draft: Record<string, string>, objects: HubspotProjectObject[] | null): Record<string, string> {
  const sobject = draft['sobject'] ?? ''
  const obj = objects?.find((o) => o.objectTypeId === sobject)
  return {
    sobject,
    labelField: obj?.primaryDisplayProperty ?? draft['labelField'] ?? 'hs_name',
    mode: 'read',
    ...(draft['label'] ? { label: draft['label'] } : {}),
  }
}

// The Opp field readout's input for a HubSpot Deal property: checkbox for a
// boolean property, number for a number, text for everything else.
function hubspotOppFieldType(field: HubspotPropertyField | undefined): 'boolean' | 'number' | 'text' {
  if (field?.type === 'boolean') return 'boolean'
  if (field?.type === 'double') return 'number'
  return 'text'
}

function SfExtrasEditor({ teamId, typeId }: { teamId: string; typeId: string }) {
  const { t } = useTranslation()
  // v1.388.0: with CriteriaIQ as the primary Project source, a Related
  // picker is the CriteriaIQ Project picker. It only needs a label: the
  // projects come from CriteriaIQ, not a Salesforce child object.
  const criteriaIqPrimary = useEvaluationSource().primary === 'criteriaiq'
  // HubSpot (phase 4): a Ticket picker reads HubSpot Tickets, the same
  // object on every portal, and closed means a closed pipeline stage, so it
  // only needs a label.
  const onHubspot = useCrmProvider() === 'hubspot'
  const [rows, setRows] = useState<SfExtraRow[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState<null | 'opp_field_display' | 'related_object_picker' | 'ticket_picker'>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [sobjects, setSobjects] = useState<SfObjectMeta[]>([])
  const [fields, setFields] = useState<SfFieldMeta[]>([])
  const [fieldsLoading, setFieldsLoading] = useState(false)
  // v1.337.0: live picklist values for whichever field is mapped to
  // ticket_status on the chosen SObject, so an admin picks Closed values
  // from real org data rather than typing free text. Resolved in two steps
  // (which field is mapped -> that field's live picklist) since the mapping
  // itself lives in SF Field Mappings, not in this Extra's own config.
  const [ticketStatusOptions, setTicketStatusOptions] = useState<Array<{ value: string; label: string }>>([])
  const [ticketStatusLoading, setTicketStatusLoading] = useState(false)
  // HubSpot (phase 6b): the Project picker reads a HubSpot Project object,
  // the standard Projects object (0-970) or a custom object, chosen here.
  // Records come from the Deal's associations, so no lookup field is set.
  const [projectObjects, setProjectObjects] = useState<HubspotProjectObject[] | null>(null)
  const hubspotProjectPicker = onHubspot && !criteriaIqPrimary
  const crmCtx = onHubspot ? 'hubspot' : undefined
  // HubSpot: an Opp field reads a Deal property, picked from the portal's
  // Deal properties.
  const [dealProperties, setDealProperties] = useState<HubspotPropertyField[] | null>(null)
  const [dealPropertiesError, setDealPropertiesError] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    const res = await api.get<SfExtraRow[]>(`/api/admin/teams/${teamId}/activity-types/${typeId}/sf-extras`)
    setRows(res.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [typeId])

  // Load SObject list once — it's the same for both extra kinds and
  // rarely changes during an editing session.
  useEffect(() => {
    if (onHubspot) return
    void (async () => {
      const res = await api.get<SfObjectMeta[]>('/api/salesforce/sobjects')
      setSobjects(res.data ?? [])
    })()
  }, [onHubspot])

  useEffect(() => {
    if (!onHubspot || adding !== 'opp_field_display' || dealProperties) return
    let cancelled = false
    void api.get<{ fields: HubspotPropertyField[] }>(`/api/admin/hubspot/properties?object=${HUBSPOT_OPP_FIELD_OBJECT}`).then((res) => {
      if (cancelled) return
      setDealPropertiesError(res.error)
      setDealProperties(res.data?.fields ?? [])
    })
    return () => { cancelled = true }
  }, [onHubspot, adding, dealProperties])

  useEffect(() => {
    if (!hubspotProjectPicker || adding !== 'related_object_picker' || projectObjects) return
    let cancelled = false
    void api.get<HubspotProjectObject[]>('/api/admin/hubspot/project-objects').then((res) => {
      if (!cancelled) setProjectObjects(res.data ?? [])
    })
    return () => { cancelled = true }
  }, [hubspotProjectPicker, adding, projectObjects])

  // Load fields when the draft picks a new sobject. Reset field
  // dropdowns whenever the sobject changes so a stale apiName from a
  // previous pick doesn't survive. Also auto-defaults labelField to
  // 'Name' (or the first field on the child) once the field list is
  // known, so admins don't have to remember the convention.
  const currentSobject = (draft['sobject'] && draft['sobject'].length > 0)
    ? draft['sobject']
    : (adding === 'opp_field_display' ? 'Opportunity' : '')
  useEffect(() => {
    if (!currentSobject || onHubspot) { setFields([]); return }
    setFieldsLoading(true)
    let cancelled = false
    void (async () => {
      const res = await api.get<SfFieldMeta[]>(`/api/salesforce/sobjects/${encodeURIComponent(currentSobject)}/fields`)
      if (cancelled) return
      const list = res.data ?? []
      setFields(list)
      setFieldsLoading(false)
      // Auto-default labelField for related_object_picker: prefer Name
      // if present, else the first non-Id field.
      if (adding === 'related_object_picker' && list.length > 0 && !draft['labelField']) {
        const preferred = list.find((f) => f.name === 'Name') ?? list.find((f) => f.name !== 'Id')
        if (preferred) setDraft((d) => ({ ...d, labelField: preferred.name }))
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSobject, adding])

  // v1.337.0: resolve the Closed-status picklist for the ticket_picker
  // config form. Two calls: which field is mapped to ticket_status for this
  // SObject (SF Field Mappings, admin-configured separately from this
  // Extra), then that field's live picklist values (same describe endpoint
  // Opp field readout's SF Field dropdown already uses).
  useEffect(() => {
    if (adding !== 'ticket_picker' || !currentSobject || onHubspot) { setTicketStatusOptions([]); return }
    let cancelled = false
    setTicketStatusLoading(true)
    void (async () => {
      const mappingsRes = await api.get<Array<{ appField: string; crmFieldApi: string; crmObject: string; isActive: boolean }>>(`/api/admin/teams/${teamId}/sf-field-mappings`)
      const statusMapping = (mappingsRes.data ?? []).find((m) => m.appField === 'ticket_status' && m.crmObject === currentSobject && m.isActive)
      if (cancelled) return
      if (!statusMapping) { setTicketStatusOptions([]); setTicketStatusLoading(false); return }
      const describeRes = await api.get<{ object: string; fields: Array<{ apiName: string; picklistValues: Array<{ value: string; label: string }> }> }>(`/api/admin/sf/fields?object=${encodeURIComponent(currentSobject)}`)
      if (cancelled) return
      const field = describeRes.data?.fields.find((f) => f.apiName === statusMapping.crmFieldApi)
      setTicketStatusOptions(field?.picklistValues ?? [])
      setTicketStatusLoading(false)
    })()
    return () => { cancelled = true }
  }, [adding, currentSobject, teamId, onHubspot])

  async function submitCreate() {
    if (!adding) return
    let config: Record<string, string> = { ...draft }
    if (adding === 'opp_field_display') {
      if (!config['sobject']) config['sobject'] = onHubspot ? HUBSPOT_OPP_FIELD_OBJECT : 'Opportunity'
      // Persist a fieldType even if the admin never touched the Select
      // (the Select's *displayed* default is 'boolean' but the value
      // isn't in draft until onChange fires). Without this the SE side
      // renders a text "true/false" instead of a real checkbox.
      if (!config['fieldType']) config['fieldType'] = 'boolean'
      if (!config['mode']) config['mode'] = 'read'
    }
    if (adding === 'related_object_picker' && criteriaIqPrimary) {
      config = { sobject: CRITERIAIQ_RELATED_TYPE, mode: 'read', ...(config['label'] ? { label: config['label'] } : {}) }
    } else if (adding === 'related_object_picker' && hubspotProjectPicker) {
      config = hubspotProjectConfig(config, projectObjects)
    } else if (adding === 'related_object_picker') {
      if (!config['parentField']) config['parentField'] = 'Opportunity__c'
      if (!config['labelField']) config['labelField'] = 'Name'
      if (!config['mode']) config['mode'] = 'read'
    }
    if (adding === 'ticket_picker' && onHubspot) {
      config = { sobject: 'tickets', ...(config['label'] ? { label: config['label'] } : {}) }
    }
    await api.post(`/api/admin/teams/${teamId}/activity-types/${typeId}/sf-extras`, { kind: adding, config })
    setAdding(null); setDraft({})
    await reload()
  }
  async function remove(id: string) {
    if (!window.confirm(t('admin.activity_types.sf_extras_delete_confirm', { context: onHubspot ? 'hubspot' : undefined }))) return
    await api.delete(`/api/admin/teams/${teamId}/activity-types/${typeId}/sf-extras/${id}`)
    await reload()
  }

  // v1.74.0: allow admins to edit an existing extras row in place.
  // Loads its config into the same draft state the create form uses,
  // then persists via PATCH on save.
  const [editingId, setEditingId] = useState<string | null>(null)
  function openEdit(row: SfExtraRow) {
    const stringConfig: Record<string, string> = {}
    for (const [k, v] of Object.entries(row.config)) {
      if (v == null) continue
      stringConfig[k] = typeof v === 'string' ? v : String(v)
    }
    setDraft(stringConfig)
    setAdding(row.kind)
    setEditingId(row.id)
  }
  async function submitUpdate() {
    if (!editingId || !adding) return
    let config: Record<string, string> = { ...draft }
    if (adding === 'opp_field_display') {
      if (!config['sobject']) config['sobject'] = onHubspot ? HUBSPOT_OPP_FIELD_OBJECT : 'Opportunity'
      if (!config['fieldType']) config['fieldType'] = 'boolean'
      if (!config['mode']) config['mode'] = 'read'
    }
    if (adding === 'related_object_picker' && criteriaIqPrimary) {
      config = { sobject: CRITERIAIQ_RELATED_TYPE, mode: 'read', ...(config['label'] ? { label: config['label'] } : {}) }
    } else if (adding === 'related_object_picker' && hubspotProjectPicker) {
      config = hubspotProjectConfig(config, projectObjects)
    } else if (adding === 'related_object_picker') {
      if (!config['parentField']) config['parentField'] = 'Opportunity__c'
      if (!config['labelField']) config['labelField'] = 'Name'
      if (!config['mode']) config['mode'] = 'read'
    }
    if (adding === 'ticket_picker' && onHubspot) {
      config = { sobject: 'tickets', ...(config['label'] ? { label: config['label'] } : {}) }
    }
    await api.patch(`/api/admin/teams/${teamId}/activity-types/${typeId}/sf-extras/${editingId}`, { kind: adding, config })
    setEditingId(null)
    setAdding(null)
    setDraft({})
    await reload()
  }

  const updateableFields = fields.filter((f) => f.updateable)
  const referenceFields = fields.filter((f) => f.type === 'reference')

  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/20">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
        {t('admin.activity_types.sf_extras_title', { context: onHubspot ? 'hubspot' : undefined })}
      </p>
      <p className="mb-3 text-[11px] text-gray-600 dark:text-gray-400">
        {t('admin.activity_types.sf_extras_hint', { context: onHubspot ? 'hubspot' : undefined })}
      </p>
      {loading ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <ul className="mb-3 flex flex-col gap-2">
          {rows.map((r) => {
            // An Opp field or related picker reads one CRM; on another CRM
            // it stays saved but the activity form leaves it out.
            const rowCrm = activityTypeExtraCrm(r.kind, r.config)
            const otherCrm = rowCrm !== null && rowCrm !== (onHubspot ? 'hubspot' : 'salesforce')
            return (
            <li key={r.id} className={cn('flex items-start justify-between gap-3 rounded border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900', otherCrm && 'opacity-70')}>
              <div className="min-w-0 flex-1">
                <Badge variant="outline" className="mr-2 text-[10px]">{r.kind === 'opp_field_display' ? t('admin.activity_types.sf_extras_add_opp', { context: rowCrm === 'hubspot' ? 'hubspot' : undefined }) : r.kind === 'related_object_picker' ? (criteriaIqPrimary || onHubspot ? t('admin.activity_types.sf_extras_add_project') : t('admin.activity_types.sf_extras_add_related')) : t('admin.activity_types.sf_extras_add_ticket')}</Badge>
                <span className="font-mono text-[11px] text-gray-700 dark:text-gray-200">{JSON.stringify(r.config)}</span>
                {otherCrm && (
                  <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
                    <CircleSlash className="h-3 w-3 shrink-0" />
                    {t('admin.activity_types.sf_extras_other_crm', { other: CRM_DISPLAY_NAMES[rowCrm].name, active: CRM_DISPLAY_NAMES[onHubspot ? 'hubspot' : 'salesforce'].name })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => openEdit(r)} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label={t('common.edit')} title={t('common.edit')}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => void remove(r.id)} className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400" aria-label={t('common.delete')} title={t('common.delete')}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
            )
          })}
          {rows.length === 0 && <li className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.sf_extras_empty', 'No extras set for this type.')}</li>}
        </ul>
      )}
      {adding ? (
        <div className="flex flex-col gap-2 rounded border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-[11px] font-semibold text-gray-700 dark:text-gray-200">
            {editingId
              ? (adding === 'opp_field_display'
                ? t('admin.activity_types.sf_extras_edit_opp_field', { context: crmCtx })
                : adding === 'related_object_picker'
                  ? t('admin.activity_types.sf_extras_edit_related', { defaultValue: 'Edit — related Salesforce object picker', context: hubspotProjectPicker ? 'hubspot' : undefined })
                  : t('admin.activity_types.sf_extras_edit_ticket', { defaultValue: 'Edit — Salesforce ticket picker', context: onHubspot ? 'hubspot' : undefined }))
              : (adding === 'opp_field_display'
                ? t('admin.activity_types.sf_extras_new_opp_field', { context: crmCtx })
                : adding === 'related_object_picker'
                  ? t('admin.activity_types.sf_extras_new_related', { defaultValue: 'New — related Salesforce object picker', context: hubspotProjectPicker ? 'hubspot' : undefined })
                  : t('admin.activity_types.sf_extras_new_ticket', { defaultValue: 'New — Salesforce ticket picker', context: onHubspot ? 'hubspot' : undefined }))}
          </p>
          {adding === 'opp_field_display' && onHubspot ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.hubspot_deal_property')}</Label>
                {dealProperties === null ? (
                  <Spinner className="h-4 w-4" />
                ) : dealProperties.length === 0 ? (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">{dealPropertiesError ?? t('admin.activity_types.hubspot_deal_property_none')}</p>
                ) : (
                  <Select
                    value={draft['apiName'] ?? ''}
                    onChange={(e) => {
                      const field = dealProperties.find((f) => f.apiName === e.target.value)
                      setDraft({ ...draft, sobject: HUBSPOT_OPP_FIELD_OBJECT, apiName: e.target.value, fieldType: hubspotOppFieldType(field), ...(field && !draft['label'] ? { label: field.label } : {}) })
                    }}
                  >
                    <option value="">{t('admin.activity_types.hubspot_deal_property_pick')}</option>
                    {dealProperties.map((f) => (
                      <option key={f.apiName} value={f.apiName}>{`${f.label} (${f.apiName})`}</option>
                    ))}
                  </Select>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_label')}</Label>
                <Input value={draft['label'] ?? ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="RFP Request" />
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_field_type')}</Label>
                <Select value={draft['fieldType'] ?? 'boolean'} onChange={(e) => setDraft({ ...draft, fieldType: e.target.value })}>
                  <option value="boolean">{t('admin.activity_types.sf_extras_field_type_boolean')}</option>
                  <option value="text">{t('admin.activity_types.sf_extras_field_type_text')}</option>
                  <option value="number">{t('admin.activity_types.sf_extras_field_type_number')}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_mode')}</Label>
                <Select value={draft['mode'] ?? 'read'} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                  <option value="read">{t('admin.activity_types.sf_extras_mode_read')}</option>
                  <option value="read_write">{t('admin.activity_types.sf_extras_mode_read_write')}</option>
                </Select>
                {draft['mode'] === 'read_write' && dealProperties?.find((f) => f.apiName === draft['apiName'])?.readOnly && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400">{t('admin.activity_types.sf_extras_mode_warn')}</p>
                )}
              </div>
              <p className="col-span-2 text-[10px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.hubspot_deal_property_hint')}</p>
            </div>
          ) : adding === 'opp_field_display' ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_sobject', 'SF Object')}</Label>
                <Input
                  list={`atse-sobjects-${typeId}`}
                  value={draft['sobject'] ?? 'Opportunity'}
                  onChange={(e) => setDraft({ ...draft, sobject: e.target.value, apiName: '' })}
                  placeholder="Opportunity"
                  className="font-mono text-xs"
                />
                <datalist id={`atse-sobjects-${typeId}`}>
                  {sobjects.map((s) => (
                    <option key={s.name} value={s.name} label={`${s.label} (${s.name})`} />
                  ))}
                </datalist>
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.activity_types.sf_extras_sobject_hint_opp', 'Type to filter. Read/write mode only supported when SF Object is Opportunity.')}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_api_name', 'SF Field')}</Label>
                <Input
                  list={`atse-fields-${typeId}-${currentSobject}`}
                  value={draft['apiName'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, apiName: e.target.value })}
                  placeholder={fieldsLoading ? t('common.loading', 'Loading…') : 'Field API Name'}
                  className="font-mono text-xs"
                />
                <datalist id={`atse-fields-${typeId}-${currentSobject}`}>
                  {fields.map((f) => (
                    <option key={f.name} value={f.name} label={`${f.label} — ${f.type}`} />
                  ))}
                </datalist>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_label', 'Display Label')}</Label>
                <Input value={draft['label'] ?? ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="RFP Request" />
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_field_type', 'Field Type')}</Label>
                <Select value={draft['fieldType'] ?? 'boolean'} onChange={(e) => setDraft({ ...draft, fieldType: e.target.value })}>
                  <option value="boolean">{t('admin.activity_types.sf_extras_field_type_boolean')}</option>
                  <option value="text">{t('admin.activity_types.sf_extras_field_type_text')}</option>
                  <option value="number">{t('admin.activity_types.sf_extras_field_type_number')}</option>
                </Select>
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_mode', 'Mode')}</Label>
                <Select value={draft['mode'] ?? 'read'} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                  <option value="read">{t('admin.activity_types.sf_extras_mode_read', 'Read-only (displays the SF value)')}</option>
                  <option value="read_write">{t('admin.activity_types.sf_extras_mode_read_write', 'Read / write (SE can edit and save back to Salesforce)')}</option>
                </Select>
                {(() => {
                  const picked = updateableFields.find((f) => f.name === draft['apiName'])
                  if (draft['mode'] === 'read_write' && draft['apiName'] && !picked) {
                    return (
                      <p className="text-[10px] text-amber-600 dark:text-amber-400">
                        {t('admin.activity_types.sf_extras_mode_warn', 'The selected SF field is not updateable — writes will be rejected by Salesforce.')}
                      </p>
                    )
                  }
                  return null
                })()}
              </div>
            </div>
          ) : adding === 'related_object_picker' && criteriaIqPrimary ? (
            <div className="flex flex-col gap-1">
              <Label>{t('admin.activity_types.sf_extras_label', 'Display Label')}</Label>
              <Input value={draft['label'] ?? ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder={t('activity.criteriaiq_picker.title')} />
              <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.sf_extras_criteriaiq_hint')}</p>
            </div>
          ) : adding === 'related_object_picker' && hubspotProjectPicker ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.hubspot_project_object')}</Label>
                {projectObjects === null ? (
                  <Spinner className="h-4 w-4" />
                ) : projectObjects.length === 0 ? (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">{t('admin.activity_types.hubspot_project_object_none')}</p>
                ) : (
                  <Select value={draft['sobject'] ?? ''} onChange={(e) => setDraft({ ...draft, sobject: e.target.value })}>
                    <option value="">{t('admin.activity_types.hubspot_project_object_pick')}</option>
                    {projectObjects.map((o) => (
                      <option key={o.objectTypeId} value={o.objectTypeId}>
                        {o.standard ? t('admin.activity_types.hubspot_projects_standard') : `${o.label ?? o.objectTypeId} (${o.objectTypeId})`}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_label', 'Display Label')}</Label>
                <Input value={draft['label'] ?? ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder={t('admin.activity_types.sf_extras_add_project')} />
              </div>
              <p className="col-span-2 text-[10px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.hubspot_project_hint')}</p>
            </div>
          ) : adding === 'related_object_picker' ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_sobject_child', 'Child SF Object')}</Label>
                <Input
                  list={`atse-sobjects-${typeId}`}
                  value={draft['sobject'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, sobject: e.target.value, labelField: '', parentField: '' })}
                  placeholder="Evaluation__c"
                  className="font-mono text-xs"
                />
                <datalist id={`atse-sobjects-${typeId}`}>
                  {sobjects.map((s) => (
                    <option key={s.name} value={s.name} label={`${s.label} (${s.name})`} />
                  ))}
                </datalist>
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.activity_types.sf_extras_sobject_child_hint', 'Type to filter.')}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_parent', 'SF Field (Opportunity lookup on the child)')}</Label>
                <Input
                  list={`atse-refs-${typeId}-${currentSobject}`}
                  value={draft['parentField'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, parentField: e.target.value })}
                  placeholder="Opportunity__c"
                  className="font-mono text-xs"
                  disabled={!draft['sobject']}
                />
                <datalist id={`atse-refs-${typeId}-${currentSobject}`}>
                  {referenceFields.map((f) => (
                    <option key={f.name} value={f.name} label={`${f.label} — ${f.name}`} />
                  ))}
                </datalist>
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.activity_types.sf_extras_parent_hint', 'The lookup field on the child that points back to the parent Opportunity. Filters the picker to records under the currently linked Opp. Only reference fields on the chosen child are listed.')}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_label_field', 'Display Field on Child')}</Label>
                <Input
                  list={`atse-fields-${typeId}-${currentSobject}`}
                  value={draft['labelField'] ?? 'Name'}
                  onChange={(e) => setDraft({ ...draft, labelField: e.target.value })}
                  placeholder="Name"
                  className="font-mono text-xs"
                  disabled={!draft['sobject']}
                />
                <datalist id={`atse-fields-${typeId}-${currentSobject}`}>
                  {fields.map((f) => (
                    <option key={f.name} value={f.name} label={`${f.label} — ${f.type}`} />
                  ))}
                </datalist>
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.activity_types.sf_extras_label_field_hint', 'The field on the child record read as the option label in the picker. Usually Name.')}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_label', 'Display Label')}</Label>
                <Input value={draft['label'] ?? ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Evaluations" />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_mode', 'Mode')}</Label>
                <Select value={draft['mode'] ?? 'read'} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                  <option value="read">{t('admin.activity_types.sf_extras_mode_read_related', 'Read — SE picks a record; ID+Name stored on the activity (default)')}</option>
                  <option value="write">{t('admin.activity_types.sf_extras_mode_write_related', 'Write — send the picked SF Id to Salesforce on save (follow-up wiring)')}</option>
                  <option value="read_write">{t('admin.activity_types.sf_extras_mode_read_write_related', 'Read / write — both (follow-up wiring)')}</option>
                </Select>
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.activity_types.sf_extras_related_mode_hint', 'Only Read is functional today — write-back of picked child IDs to Salesforce is a follow-up.')}
                </p>
              </div>
            </div>
          ) : onHubspot ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_label', 'Display Label')}</Label>
                <Input value={draft['label'] ?? ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Support Tickets" />
              </div>
              <p className="col-span-2 text-[10px] text-gray-500 dark:text-gray-400">
                {t('admin.activity_types.sf_extras_ticket_hubspot_hint')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_ticket_sobject', 'Ticket SF Object')}</Label>
                <Input
                  list={`atse-sobjects-${typeId}`}
                  value={draft['sobject'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, sobject: e.target.value, closedStatusValues: '' })}
                  placeholder="Case"
                  className="font-mono text-xs"
                />
                <datalist id={`atse-sobjects-${typeId}`}>
                  {sobjects.map((s) => (
                    <option key={s.name} value={s.name} label={`${s.label} (${s.name})`} />
                  ))}
                </datalist>
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.activity_types.sf_extras_ticket_sobject_hint', 'Type to filter. Every display field (Ticket Number, Subject, Status, etc.) is resolved via SF Field Mappings for this object — map ticket_number, ticket_subject, ticket_date_opened, ticket_status, ticket_contact, ticket_description, ticket_platform, ticket_owner, and ticket_account there, not here.')}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_label', 'Display Label')}</Label>
                <Input value={draft['label'] ?? ''} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Support Tickets" />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label>{t('admin.activity_types.sf_extras_ticket_closed', 'Closed Status Values (excluded by default)')}</Label>
                {!currentSobject ? (
                  <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.activity_types.sf_extras_ticket_closed_no_sobject', 'Pick a Ticket SF Object above first.')}</p>
                ) : ticketStatusLoading ? (
                  <Spinner className="h-4 w-4" />
                ) : ticketStatusOptions.length === 0 ? (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400">
                    {t('admin.activity_types.sf_extras_ticket_closed_unmapped', 'Map ticket_status in SF Field Mappings for this object to pick Closed values from live picklist data.')}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {ticketStatusOptions.map((opt) => {
                      const selected = (draft['closedStatusValues'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
                      const checked = selected.includes(opt.value)
                      return (
                        <label key={opt.value} className="flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-800">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked ? [...selected, opt.value] : selected.filter((v) => v !== opt.value)
                              setDraft({ ...draft, closedStatusValues: next.join(',') })
                            }}
                          />
                          {opt.label}
                        </label>
                      )
                    })}
                  </div>
                )}
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  {t('admin.activity_types.sf_extras_ticket_closed_hint', 'Tickets with one of these Status values are hidden unless the SE checks Show Closed. Leave empty to never filter by status.')}
                </p>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={(adding === 'related_object_picker' && hubspotProjectPicker && !draft['sobject']) || (adding === 'opp_field_display' && onHubspot && !draft['apiName'])} onClick={() => void (editingId ? submitUpdate() : submitCreate())}>
              <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(null); setDraft({}); setEditingId(null) }}>
              <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {/* Every kind works on either CRM: Opp field reads an Opportunity
              field (Salesforce) or a Deal property (HubSpot), and the related
              picker is a Salesforce child object, a HubSpot Project object or
              a CriteriaIQ project. */}
          <Button size="sm" variant="outline" onClick={() => {
            setAdding('opp_field_display')
            // Seed the draft so an admin who never touches Field Type or
            // Mode still saves sensible defaults (checkbox / read-only)
            // instead of undefined values that read as text "true"/"false"
            // on the Activity form.
            setDraft({ sobject: onHubspot ? HUBSPOT_OPP_FIELD_OBJECT : 'Opportunity', fieldType: 'boolean', mode: 'read' })
          }}>
            <Plus className="mr-1 h-3.5 w-3.5" />{t('admin.activity_types.sf_extras_add_opp', { context: crmCtx })}
          </Button>
          <Button size="sm" variant="outline" onClick={() => {
            setAdding('ticket_picker')
            setDraft({})
          }}>
            <Ticket className="mr-1 h-3.5 w-3.5" />{t('admin.activity_types.sf_extras_add_ticket', 'Ticket picker')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => {
            setAdding('related_object_picker')
            setDraft(criteriaIqPrimary || onHubspot ? { mode: 'read' } : { labelField: 'Name', mode: 'read' })
          }}>
            <Plus className="mr-1 h-3.5 w-3.5" />{criteriaIqPrimary || onHubspot ? t('admin.activity_types.sf_extras_add_project') : t('admin.activity_types.sf_extras_add_related', 'Related picker')}
          </Button>
        </div>
      )}
    </div>
  )
}

interface SubtypeRow {
  id: string
  name: string
  sortOrder: number
}

// v1.255.0: free-text subtype labels an admin can attach to an activity
// type (e.g. Discovery → Initial Discovery / Technical Discovery /
// Architecture). Display-only for now — not wired into classification or
// the Log Activity form, just a name + sort order list, far simpler than
// SfExtrasEditor above since there's no Salesforce metadata involved.
function SubtypesEditor({ teamId, typeId }: { teamId: string; typeId: string }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SubtypeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const reload = async () => {
    setLoading(true)
    const res = await api.get<SubtypeRow[]>(`/api/admin/teams/${teamId}/activity-types/${typeId}/subtypes`)
    setRows(res.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [typeId])

  async function submitAdd() {
    if (!draftName.trim()) return
    await api.post(`/api/admin/teams/${teamId}/activity-types/${typeId}/subtypes`, { name: draftName.trim(), sortOrder: (rows.at(-1)?.sortOrder ?? 0) + 10 })
    setAdding(false); setDraftName('')
    await reload()
  }
  async function submitRename(id: string) {
    if (!editingName.trim()) return
    await api.patch(`/api/admin/teams/${teamId}/activity-types/${typeId}/subtypes/${id}`, { name: editingName.trim() })
    setEditingId(null); setEditingName('')
    await reload()
  }
  async function remove(id: string) {
    if (!window.confirm(t('admin.activity_types.subtypes_delete_confirm', 'Remove this subtype?'))) return
    await api.delete(`/api/admin/teams/${teamId}/activity-types/${typeId}/subtypes/${id}`)
    await reload()
  }

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        <Tags className="h-3.5 w-3.5" />
        {t('admin.activity_types.subtypes_section', 'Subtypes')}
      </p>
      <p className="mb-2 text-[10px] text-gray-500 dark:text-gray-400">
        {t('admin.activity_types.subtypes_hint', 'Optional finer-grained labels for this type (e.g. Discovery → Technical Discovery, Architecture). Display-only for now — not used for classification or on the Log Activity form.')}
      </p>
      {loading ? (
        <div className="flex justify-center py-3"><Spinner className="h-4 w-4" /></div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1 dark:border-gray-700">
              {editingId === row.id ? (
                <>
                  <Input value={editingName} onChange={(e) => setEditingName(e.target.value)} className="h-7 flex-1 text-xs" autoFocus />
                  <button onClick={() => void submitRename(row.id)} className="rounded p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400" aria-label={t('common.save')}>
                    <Save className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => { setEditingId(null); setEditingName('') }} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label={t('common.cancel')}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-xs text-gray-700 dark:text-gray-200">{row.name}</span>
                  <button onClick={() => { setEditingId(row.id); setEditingName(row.name) }} className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label={t('common.edit')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => void remove(row.id)} className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400" aria-label={t('common.delete')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
          {rows.length === 0 && !adding && (
            <p className="py-2 text-center text-[11px] text-gray-400 dark:text-gray-500">{t('admin.activity_types.subtypes_empty', 'No subtypes yet.')}</p>
          )}
        </div>
      )}
      {adding ? (
        <div className="mt-2 flex items-center gap-2">
          <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder={t('admin.activity_types.subtypes_name_placeholder', 'e.g. Technical Discovery')} className="h-7 flex-1 text-xs" autoFocus />
          <Button size="sm" onClick={() => void submitAdd()} disabled={!draftName.trim()}>
            <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraftName('') }}>
            <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="mt-2" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />{t('admin.activity_types.subtypes_add', 'Add Subtype')}
        </Button>
      )}
    </div>
  )
}

// v1.255.0: team-scoped free text rendered at the bottom of the Guide page
// ("Distinctions" — e.g. Discovery vs Demo). Not per-type, so it lives at
// the top of the page rather than inside any single FormCard.
export function GuideDistinctionsEditor({ teamId, reloadKey }: { teamId: string; reloadKey?: number }) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  // v1.255.5: refetches on `reloadKey` too — bumped by the parent's
  // "Seed Default Content" action (now rendered next to Add Activity
  // Type, not in this card) whenever seeding actually set Distinctions.
  useEffect(() => {
    setLoading(true)
    void api.get<{ guideDistinctions: string | null }>(`/api/teams/${teamId}/guide-distinctions`).then((res) => {
      setValue(res.data?.guideDistinctions ?? '')
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, reloadKey])

  async function save() {
    setSaving(true)
    setSaved(false)
    const res = await api.patch<{ guideDistinctions: string | null }>(`/api/admin/teams/${teamId}/guide-distinctions`, { guideDistinctions: value.trim() || null })
    setSaving(false)
    if (!res.error) { setDirty(false); setSaved(true) }
  }

  if (loading) return <div className="flex justify-center py-4"><Spinner className="h-4 w-4" /></div>

  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-300">
        <LifeBuoy className="h-4 w-4" />
        {t('admin.activity_types.guide_distinctions_section', 'Guide: Distinctions')}
      </p>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {t('admin.activity_types.guide_distinctions_hint', "Free text rendered as the Distinctions section at the bottom of the Guide page (e.g. Discovery vs Demo). Team-scoped, not tied to any single activity type. Supports Markdown.")}
      </p>
      {previewing ? (
        <div className="min-h-[10rem] rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
          {value.trim() ? (
            <MarkdownProse>{value}</MarkdownProse>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500">{t('admin.activity_types.guide_distinctions_preview_empty', 'Nothing to preview yet.')}</p>
          )}
        </div>
      ) : (
        <Textarea
          rows={8}
          value={value}
          onChange={(e) => { setValue(e.target.value); setDirty(true); setSaved(false) }}
          placeholder={t('admin.activity_types.guide_distinctions_placeholder', 'Discovery vs Demo:\nDiscovery = "Tell me about your world."\nDemo = "Let me show you how we address what we learned."')}
        />
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty || previewing}>
          {saving && <Spinner className="mr-1 h-3 w-3" />}
          <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPreviewing((p) => !p)}>
          {previewing ? <Pencil className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
          {previewing ? t('common.edit') : t('admin.activity_types.guide_distinctions_preview', 'Preview')}
        </Button>
        {saved && <span className="text-xs text-green-600 dark:text-green-400">{t('admin.activity_types.guide_distinctions_saved', 'Saved')}</span>}
      </div>
    </div>
  )
}
