import { useState, useEffect, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, X, AlertCircle, Save, Copy, PowerOff, Power, Building2, Search, RefreshCw, UserRoundCog, Users, Palette, MessageSquare, Clock, Layers, Lock } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { Badge } from '../ui/badge.js'
import { Textarea } from '../ui/textarea.js'
import { IconPicker, DynamicIcon } from '../ui/icon-picker.js'
import { Select } from '../ui/select.js'
import { api } from '../../lib/api.js'
import { validateWorkWeek, type WorkerType } from '../../../shared/schemas/workWeek.js'
import { useCrmLabelContext, useCrmProvider } from '../../store/crmProvider.js'
import { FormSection, FormSectionsToolbar, FormSaveBar, FieldLabel, useFormSections } from './FormSection.js'

interface Team {
  id: string
  name: string
  slug: string
  description: string | null
  icon?: string | null
  isActive: boolean
  createdAt: string
  defaultWorkerType?: WorkerType
  defaultWorkDays?: number
  defaultWorkDayStartHour?: number
  defaultWorkDayEndHour?: number
  crmDepartments?: string[]
  managerUserId?: string | null
  slackWebhookUrl?: string | null
  activeThemeId?: string | null
}

interface TeamFormState {
  name: string
  slug: string
  description: string
  icon: string | null
  defaultWorkerType: WorkerType
  defaultWorkDays: number
  defaultWorkDayStartHour: number
  defaultWorkDayEndHour: number
  crmDepartments: string[]
  managerUserId: string | null
  slackWebhookUrl: string
  activeThemeId: string | null
}

const emptyForm: TeamFormState = {
  name: '', slug: '', description: '', icon: null,
  defaultWorkerType: 'full_time', defaultWorkDays: 31,
  defaultWorkDayStartHour: 9, defaultWorkDayEndHour: 18,
  crmDepartments: [], managerUserId: null,
  slackWebhookUrl: '',
  activeThemeId: null,
}

const MAX_SF_DEPARTMENTS = 5

const DAY_BITS_TC: { key: string; bit: number }[] = [
  { key: 'mon', bit: 1 },{ key: 'tue', bit: 2 },{ key: 'wed', bit: 4 },{ key: 'thu', bit: 8 },
  { key: 'fri', bit: 16 },{ key: 'sat', bit: 32 },{ key: 'sun', bit: 64 },
]

export function TeamsConfig({ onTeamChange }: { onTeamChange?: () => void }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<TeamFormState>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<TeamFormState>(emptyForm)
  // v1.472.0: collapsible edit-form sections, open state remembered per admin in this browser.
  const teamSections = useFormSections('admin.teams.edit', { identity: true, people: true, theme: false, notifications: false, week: false, subteams: false })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cloneSource, setCloneSource] = useState<Team | null>(null)
  const [cloneForm, setCloneForm] = useState<{ name: string; slug: string }>({ name: '', slug: '' })
  const [cloneSuccess, setCloneSuccess] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    const res = await api.get<Team[]>('/api/admin/teams')
    setTeams(res.data ?? [])
    setLoading(false)
  }

  useEffect(() => { void reload() }, [])

  // Warn early on a duplicate team name (case-insensitive) using the already
  // loaded list, so the user doesn't have to round-trip to hit the server
  // guard. `excludeId` skips the team being renamed.
  function isDuplicateName(name: string, excludeId?: string): boolean {
    const n = name.trim().toLowerCase()
    if (!n) return false
    return teams.some((tm) => tm.id !== excludeId && tm.name.trim().toLowerCase() === n)
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    // Base sanity checks — we allow non-full_time on the team default even if
    // the team ends up with mixed workforce. Skip the full_time-specific
    // 5-days/45-hours enforcement by not passing 'full_time' to the validator
    // for a hours check; instead run only structural validation ourselves.
    if (form.defaultWorkDays < 1) { setSaving(false); setError(t('errors.workweek.need_days')); return }
    if (form.defaultWorkDayEndHour <= form.defaultWorkDayStartHour) {
      setSaving(false); setError(t('errors.workweek.end_after_start')); return
    }
    // Still run the base validator with a non-full_time type to reuse checks.
    const wwErr = validateWorkWeek({
      workerType: form.defaultWorkerType === 'full_time' ? 'part_time' : form.defaultWorkerType,
      workDays: form.defaultWorkDays,
      workDayStartHour: form.defaultWorkDayStartHour,
      workDayEndHour: form.defaultWorkDayEndHour,
      workHoursPerDay: null,
    })
    if (wwErr) { setSaving(false); setError(t(wwErr)); return }
    if (isDuplicateName(form.name)) {
      setSaving(false); setError(t('errors.teams.duplicate_name', { name: form.name.trim() })); return
    }
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      defaultWorkerType: form.defaultWorkerType,
      defaultWorkDays: form.defaultWorkDays,
      defaultWorkDayStartHour: form.defaultWorkDayStartHour,
      defaultWorkDayEndHour: form.defaultWorkDayEndHour,
    }
    if (form.slug.trim()) body['slug'] = form.slug.trim()
    if (form.description.trim()) body['description'] = form.description.trim()
    if (form.icon) body['icon'] = form.icon
    const res = await api.post<Team>('/api/admin/teams', body)
    setSaving(false)
    if (res.error || !res.data) {
      setError(res.error ? t(res.error) : 'Failed to create team')
      return
    }
    setForm(emptyForm)
    setCreating(false)
    await reload()
    onTeamChange?.()
  }

  function openEdit(team: Team) {
    setEditingId(team.id)
    setEditForm({
      name: team.name,
      slug: team.slug,
      description: team.description ?? '',
      icon: team.icon ?? null,
      defaultWorkerType: team.defaultWorkerType ?? 'full_time',
      defaultWorkDays: team.defaultWorkDays ?? 31,
      defaultWorkDayStartHour: team.defaultWorkDayStartHour ?? 9,
      defaultWorkDayEndHour: team.defaultWorkDayEndHour ?? 18,
      crmDepartments: team.crmDepartments ?? [],
      managerUserId: team.managerUserId ?? null,
      slackWebhookUrl: team.slackWebhookUrl ?? '',
      activeThemeId: team.activeThemeId ?? null,
    })
    setError(null)
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setSaving(true)
    setError(null)
    if (editForm.defaultWorkDays < 1) { setSaving(false); setError(t('errors.workweek.need_days')); return }
    if (editForm.defaultWorkDayEndHour <= editForm.defaultWorkDayStartHour) {
      setSaving(false); setError(t('errors.workweek.end_after_start')); return
    }
    const wwErrE = validateWorkWeek({
      workerType: editForm.defaultWorkerType === 'full_time' ? 'part_time' : editForm.defaultWorkerType,
      workDays: editForm.defaultWorkDays,
      workDayStartHour: editForm.defaultWorkDayStartHour,
      workDayEndHour: editForm.defaultWorkDayEndHour,
      workHoursPerDay: null,
    })
    if (wwErrE) { setSaving(false); setError(t(wwErrE)); return }
    if (isDuplicateName(editForm.name, editingId)) {
      setSaving(false); setError(t('errors.teams.duplicate_name', { name: editForm.name.trim() })); return
    }
    const body: Record<string, unknown> = {
      name: editForm.name.trim(),
      description: editForm.description.trim() || undefined,
      icon: editForm.icon ?? undefined,
      defaultWorkerType: editForm.defaultWorkerType,
      defaultWorkDays: editForm.defaultWorkDays,
      defaultWorkDayStartHour: editForm.defaultWorkDayStartHour,
      defaultWorkDayEndHour: editForm.defaultWorkDayEndHour,
      crmDepartments: editForm.crmDepartments ?? [],
      managerUserId: editForm.managerUserId ?? null,
      slackWebhookUrl: editForm.slackWebhookUrl.trim() || null,
      activeThemeId: editForm.activeThemeId ?? null,
    }
    const res = await api.patch<Team>(`/api/admin/teams/${editingId}`, body)
    setSaving(false)
    if (res.error || !res.data) {
      setError(res.error ? t(res.error) : 'Failed to update team')
      return
    }
    setEditingId(null)
    await reload()
    onTeamChange?.()
  }

  async function toggleActive(team: Team) {
    // Deactivating is a soft-destructive action — activities on the
    // team continue to exist but the team disappears from all pickers.
    // Ask for confirmation before flipping active → inactive; the
    // reactivate direction is a plain flip.
    if (team.isActive && !window.confirm(t('admin.teams.deactivate_confirm', { name: team.name }))) {
      return
    }
    setSaving(true)
    await api.patch(`/api/admin/teams/${team.id}`, { isActive: !team.isActive })
    setSaving(false)
    await reload()
    onTeamChange?.()
  }

  function openClone(team: Team) {
    setCloneSource(team)
    setCloneForm({ name: `${team.name} (Copy)`, slug: `${team.slug}-copy` })
    setError(null)
  }

  async function submitClone(e: FormEvent) {
    e.preventDefault()
    if (!cloneSource) return
    setSaving(true)
    setError(null)
    if (isDuplicateName(cloneForm.name)) {
      setSaving(false); setError(t('errors.teams.duplicate_name', { name: cloneForm.name.trim() })); return
    }
    const res = await api.post<Team>(`/api/admin/teams/${cloneSource.id}/clone`, {
      name: cloneForm.name.trim(),
      slug: cloneForm.slug.trim() || undefined,
    })
    setSaving(false)
    if (res.error || !res.data) {
      setError(res.error ? t(res.error) : 'Failed to clone team')
      return
    }
    setCloneSuccess(t('admin.teams.clone_dialog.success', { name: res.data.name }))
    setCloneSource(null)
    await reload()
    onTeamChange?.()
    window.setTimeout(() => setCloneSuccess(null), 4000)
  }

  async function remove(team: Team) {
    if (!window.confirm(t('admin.teams.delete_confirm', { name: team.name }))) return
    setSaving(true)
    await api.delete(`/api/admin/teams/${team.id}`)
    setSaving(false)
    await reload()
    onTeamChange?.()
  }

  // `bare` drops the box and heading for use inside an edit-form section,
  // which already shows them (the heading used to appear twice there).
  function WorkWeekDefaults({ state, setState, bare }: { state: TeamFormState; setState: (updater: (f: TeamFormState) => TeamFormState) => void; bare?: boolean }) {
    return (
      <div className={bare ? '' : 'col-span-2 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900'}>
        {!bare && (
          <>
            <p className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
              {t('admin.teams.work_week_defaults.title')}
            </p>
            <p className="mb-3 text-[11px] text-gray-500 dark:text-gray-400">
              {t('admin.teams.work_week_defaults.description')}
            </p>
          </>
        )}
        <div className={bare ? 'grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.6fr_0.8fr_0.8fr]' : 'grid grid-cols-2 gap-3'}>
          <div className="flex flex-col gap-1">
            <Label>{t('admin.teams.work_week_defaults.worker_type_label')}</Label>
            <Select value={state.defaultWorkerType} onChange={(e) => setState((f) => ({ ...f, defaultWorkerType: e.target.value as WorkerType }))}>
              <option value="full_time">{t('admin.users.worker_type_full_time')}</option>
              <option value="part_time">{t('admin.users.worker_type_part_time')}</option>
              <option value="contractor">{t('admin.users.worker_type_contractor')}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t('admin.teams.work_week_defaults.days_label')}</Label>
            <div className="flex flex-wrap gap-1">
              {DAY_BITS_TC.map((d) => {
                const on = (state.defaultWorkDays & d.bit) !== 0
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => setState((f) => ({ ...f, defaultWorkDays: on ? f.defaultWorkDays & ~d.bit : f.defaultWorkDays | d.bit }))}
                    className={'rounded border px-2 py-0.5 text-[11px] ' + (on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-gray-600 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300')}
                  >{t(`settings.work_week.days.${d.key}`)}</button>
                )
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t('admin.teams.work_week_defaults.start_hour_label')}</Label>
            <Select value={String(state.defaultWorkDayStartHour)} onChange={(e) => setState((f) => ({ ...f, defaultWorkDayStartHour: Number(e.target.value) }))}>
              {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t('admin.teams.work_week_defaults.end_hour_label')}</Label>
            <Select value={String(state.defaultWorkDayEndHour)} onChange={(e) => setState((f) => ({ ...f, defaultWorkDayEndHour: Number(e.target.value) }))}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}
            </Select>
          </div>
        </div>
      </div>
    )
  }

  function workWeekSummary(w: TeamFormState): string {
    const days = DAY_BITS_TC.filter((d) => (w.defaultWorkDays & d.bit) !== 0).map((d) => t(`settings.work_week.days.${d.key}`)).join(', ')
    return [
      t(`admin.users.worker_type_${w.defaultWorkerType}`),
      days || '—',
      `${String(w.defaultWorkDayStartHour).padStart(2, '0')}:00–${String(w.defaultWorkDayEndHour).padStart(2, '0')}:00`,
    ].join(' · ')
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
  }

  return (
    <div className="flex flex-col gap-6">
      {cloneSuccess && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {cloneSuccess}
        </div>
      )}
      {cloneSource && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setCloneSource(null)}
        >
          <form
            onSubmit={submitClone}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900"
          >
            <h3 className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.teams.clone_dialog.title', { name: cloneSource.name })}
            </h3>
            <p className="mb-4 text-xs text-gray-600 dark:text-gray-400">
              {t('admin.teams.clone_dialog.description')}
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label>{t('admin.teams.clone_dialog.name_label')}</Label>
                <Input
                  value={cloneForm.name}
                  onChange={(e) => setCloneForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label>{t('admin.teams.clone_dialog.slug_label')}</Label>
                <Input
                  value={cloneForm.slug}
                  onChange={(e) => setCloneForm((f) => ({ ...f, slug: e.target.value }))}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setCloneSource(null)}>
                {t('admin.teams.clone_dialog.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={saving || !cloneForm.name.trim()}>
                {saving && <Spinner className="mr-1 h-3 w-3" />}
                <Copy className="mr-1 h-3.5 w-3.5" />
                {t('admin.teams.clone_dialog.submit')}
              </Button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {creating ? (
        <form onSubmit={submitCreate} className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <p className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
            {t('admin.teams.add_team')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <FieldLabel required>{t('admin.teams.name')}</FieldLabel>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required autoFocus />
            </div>
            <div className="flex flex-col gap-1">
              <FieldLabel optional>{t('admin.teams.slug')}</FieldLabel>
              <Input
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder={t('admin.teams.slug_placeholder')}
              />
            </div>
            <div className="col-span-2 flex flex-col gap-1">
              <Label>{t('admin.teams.icon')}</Label>
              <IconPicker value={form.icon} onChange={(icon) => setForm((f) => ({ ...f, icon }))} />
            </div>
            <div className="col-span-2 flex flex-col gap-1">
              <FieldLabel optional>{t('admin.teams.description')}</FieldLabel>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className="min-h-[60px]"
              />
            </div>
            <WorkWeekDefaults state={form} setState={setForm} />
          </div>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {t('admin.teams.create_hint')}
          </p>
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" disabled={saving || !form.name.trim()}>
              {saving && <Spinner className="mr-1 h-3 w-3" />}
              <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setCreating(false); setForm(emptyForm); setError(null) }}>
              <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {teams.length} {t('admin.teams.count')}
          </p>
          <Button size="sm" onClick={() => { setCreating(true); setError(null) }}>
            <Plus className="h-4 w-4" />
            {t('admin.teams.add_team')}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {teams.map((team) => (
          <div key={team.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            {editingId === team.id ? (
              <form onSubmit={submitEdit} className="flex flex-col gap-2">
                <FormSectionsToolbar title={t('admin.teams.sections.editing', { name: team.name })} state={teamSections} />
                <FormSection
                  id={`team-identity-${team.id}`} icon={Building2} color="indigo" title={t('admin.teams.section_identity')}
                  summary={[editForm.name, editForm.slug].filter(Boolean).join(' · ')}
                  status={editForm.name.trim() ? { kind: 'done', label: t('admin.users.sections.required_done') } : { kind: 'missing', label: t('admin.users.sections.required_missing') }}
                  open={teamSections.isOpen('identity') || !editForm.name.trim()} onToggle={() => teamSections.toggle('identity')}
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-1">
                      <FieldLabel required>{t('admin.teams.name')}</FieldLabel>
                      <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} required />
                    </div>
                    <div className="flex flex-col gap-1">
                      <FieldLabel>{t('admin.teams.slug')}</FieldLabel>
                      <div className="relative">
                        <Lock className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                        <Input value={editForm.slug} disabled className="pl-8 opacity-60" />
                      </div>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.teams.sections.slug_locked')}</p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <FieldLabel>{t('admin.teams.icon')}</FieldLabel>
                      <IconPicker value={editForm.icon} onChange={(icon) => setEditForm((f) => ({ ...f, icon }))} />
                    </div>
                    <div className="flex flex-col gap-1 sm:col-span-3">
                      <FieldLabel optional>{t('admin.teams.description')}</FieldLabel>
                      <Textarea
                        value={editForm.description}
                        onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                        className="min-h-[60px]"
                      />
                    </div>
                  </div>
                </FormSection>

                <FormSection
                  id={`team-people-${team.id}`} icon={Users} color="violet" title={t('admin.teams.section_people', { context: crmCtx })}
                  summary={[
                    editForm.managerUserId ? t('admin.teams.sections.manager_set') : t('admin.teams.sections.no_manager'),
                    t('admin.teams.sections.crm_links', { count: editForm.crmDepartments.length }),
                  ].join(' · ')}
                  open={teamSections.isOpen('people')} onToggle={() => teamSections.toggle('people')}
                >
                  <div className="flex flex-col gap-3">
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.teams.section_people_hint', { context: crmCtx })}</p>
                    <div className="flex flex-col gap-1">
                      <FieldLabel optional>{t('admin.teams.manager_label')}</FieldLabel>
                      <TeamManagerPicker
                        value={editForm.managerUserId}
                        onChange={(next) => setEditForm((f) => ({ ...f, managerUserId: next }))}
                        t={t}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <FieldLabel optional>{t('admin.teams.sf_department', { context: crmCtx })}</FieldLabel>
                      <SfDepartmentPicker
                        values={editForm.crmDepartments}
                        onChange={(next) => setEditForm((f) => ({ ...f, crmDepartments: next }))}
                        t={t}
                      />
                    </div>
                  </div>
                </FormSection>

                <FormSection
                  id={`team-theme-${team.id}`} icon={Palette} color="pink" title={t('admin.teams.section_theme')}
                  summary={editForm.activeThemeId ? t('admin.teams.sections.theme_custom') : t('admin.teams.sections.theme_inherit')}
                  open={teamSections.isOpen('theme')} onToggle={() => teamSections.toggle('theme')}
                >
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.teams.section_theme_hint')}</p>
                    <TeamThemePicker
                      value={editForm.activeThemeId}
                      onChange={(id) => setEditForm((f) => ({ ...f, activeThemeId: id }))}
                    />
                  </div>
                </FormSection>

                <FormSection
                  id={`team-notifications-${team.id}`} icon={MessageSquare} color="amber" title={t('admin.teams.section_notifications')}
                  summary={editForm.slackWebhookUrl.trim() ? t('admin.teams.sections.slack_on') : t('admin.teams.sections.slack_off')}
                  open={teamSections.isOpen('notifications')} onToggle={() => teamSections.toggle('notifications')}
                >
                  <div className="flex flex-col gap-1">
                    <p className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">{t('admin.teams.section_notifications_hint')}</p>
                    <FieldLabel optional>{t('admin.teams.slack_webhook_label')}</FieldLabel>
                    <Input
                      type="url"
                      value={editForm.slackWebhookUrl}
                      onChange={(e) => setEditForm((f) => ({ ...f, slackWebhookUrl: e.target.value }))}
                      placeholder="https://hooks.slack.com/services/…"
                    />
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">
                      {t('admin.teams.slack_webhook_hint')}
                    </p>
                  </div>
                </FormSection>

                <FormSection
                  id={`team-week-${team.id}`} icon={Clock} color="emerald" title={t('admin.teams.section_work_week')}
                  summary={workWeekSummary(editForm)}
                  open={teamSections.isOpen('week')} onToggle={() => teamSections.toggle('week')}
                >
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.teams.section_work_week_hint')}</p>
                    <WorkWeekDefaults state={editForm} setState={setEditForm} bare />
                  </div>
                </FormSection>

                <FormSection
                  id={`team-subteams-${team.id}`} icon={Layers} color="teal" title={t('admin.teams.section_subteams')}
                  summary={t('admin.teams.section_subteams_hint')}
                  open={teamSections.isOpen('subteams')} onToggle={() => teamSections.toggle('subteams')}
                >
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.teams.section_subteams_hint')}</p>
                    <SubteamsSection teamId={team.id} t={t} />
                  </div>
                </FormSection>

                <FormSaveBar missing={editForm.name.trim() ? [] : [t('admin.teams.name')]}>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                    <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
                  </Button>
                  <Button type="submit" size="sm" disabled={saving || !editForm.name.trim()}>
                    {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}{t('common.save')}
                  </Button>
                </FormSaveBar>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <DynamicIcon name={team.icon} className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                    <p className="font-medium text-gray-900 dark:text-gray-100">{team.name}</p>
                    <Badge variant={team.isActive ? 'success' : 'outline'}>
                      {team.isActive ? t('admin.teams.active') : t('admin.teams.inactive')}
                    </Badge>
                    {isDuplicateName(team.name, team.id) && (
                      <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300" title={t('admin.teams.duplicate_name_hint')}>
                        <AlertCircle className="mr-1 h-3 w-3" />
                        {t('admin.teams.duplicate_name_badge')}
                      </Badge>
                    )}
                  </div>
                  <p className="font-mono text-xs text-gray-500 dark:text-gray-400">{team.slug}</p>
                  {team.description && (
                    <p className="text-xs text-gray-600 dark:text-gray-400">{team.description}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {(team.crmDepartments ?? []).map((dept) => (
                    <span key={dept} className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100" title={t('admin.teams.sf_department_tip', { department: dept, context: crmCtx })}>
                      <Building2 className="h-3 w-3" />
                      <span className="max-w-[160px] truncate">{dept}</span>
                    </span>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => toggleActive(team)} disabled={saving}>
                    {team.isActive
                      ? <><PowerOff className="mr-1 h-3.5 w-3.5" />{t('admin.teams.deactivate')}</>
                      : <><Power className="mr-1 h-3.5 w-3.5" />{t('admin.teams.activate')}</>}
                  </Button>
                  <button
                    onClick={() => openClone(team)}
                    className="rounded p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                    aria-label={t('admin.teams.clone_button')}
                    title={t('admin.teams.clone_button')}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => openEdit(team)}
                    className="rounded p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    aria-label={t('common.edit')}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => remove(team)}
                    className="rounded p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {teams.length === 0 && (
          <p className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">
            {t('admin.teams.empty')}
          </p>
        )}
      </div>
    </div>
  )
}


// SF Department picker: searches distinct User.Department values on
// the connected SF org. The value stored is the plain Department
// string, not an id. A Refresh button re-runs the SOQL query so admins
// can pick up newly-added Departments without re-signing-in.
function SfDepartmentPicker({ values, onChange, t }: {
  values: string[]
  onChange: (next: string[]) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  // On HubSpot the values are HubSpot team names, read from the owner copy.
  const crmCtx = useCrmLabelContext()
  const atMax = values.length >= MAX_SF_DEPARTMENTS
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [results, setResults] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showResults, setShowResults] = useState(false)

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q), 200)
    return () => clearTimeout(h)
  }, [q])

  const load = async (refresh = false) => {
    setLoading(true); setErr(null)
    const params = new URLSearchParams()
    if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
    if (refresh) params.set('refresh', '1')
    const res = await api.get<string[]>(`/api/admin/sf/departments?${params.toString()}`)
    if (res.error) setErr(res.error); else setResults(res.data ?? [])
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { void load(false) /* eslint-disable-line react-hooks/exhaustive-deps */ }, [debouncedQ])

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('admin.teams.sf_department_hint', { context: crmCtx })}
        </p>
        <Button size="sm" variant="ghost" onClick={() => { setRefreshing(true); void load(true) }} disabled={refreshing || loading} title={t('admin.teams.sf_department_refresh', { context: crmCtx })}>
          <RefreshCw className={refreshing ? 'mr-1 h-3 w-3 animate-spin' : 'mr-1 h-3 w-3'} />
          {t('admin.teams.sf_department_refresh_short')}
        </Button>
      </div>
      {values.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs dark:border-blue-800 dark:bg-blue-950/30">
              <Building2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              <span className="font-semibold text-gray-800 dark:text-gray-100">{v}</span>
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="text-blue-800 hover:text-blue-900 dark:text-blue-200 dark:hover:text-blue-100"
                title={t('admin.teams.sf_department_clear')}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <span className="text-[11px] italic text-gray-500 dark:text-gray-400 self-center">
            {values.length}/{MAX_SF_DEPARTMENTS}
          </span>
        </div>
      ) : (
        <p className="mb-2 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t('admin.teams.sf_department_none', { context: crmCtx })}
        </p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setShowResults(true)}
          onBlur={() => { window.setTimeout(() => setShowResults(false), 150) }}
          placeholder={t('admin.teams.sf_department_search_placeholder', { context: crmCtx })}
          className="pl-7"
        />
      </div>
      {err && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>}
      {showResults && loading && !refreshing && <p className="mt-1 text-[11px] italic text-gray-500 dark:text-gray-400">{t('common.loading', 'Loading…')}</p>}
      {showResults && !loading && results.length > 0 && (
        <div className="mt-1 max-h-56 overflow-y-auto rounded border border-gray-200 bg-white text-xs dark:border-gray-700 dark:bg-gray-900">
          {results.map((r) => {
            const selected = values.includes(r)
            const disabled = !selected && atMax
            return (
              <button
                key={r}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (selected) onChange(values.filter((x) => x !== r))
                  else if (!atMax) onChange([...values, r])
                }}
                className={`flex w-full items-center gap-2 border-b border-gray-100 px-2 py-1.5 text-left last:border-b-0 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent dark:border-gray-800 dark:hover:bg-gray-800 ${selected ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-200'}`}
              >
                <Building2 className="h-3 w-3 text-gray-400" />
                {r}
                {selected && <span className="ml-auto text-[10px] text-blue-600 dark:text-blue-300">✓</span>}
              </button>
            )
          })}
        </div>
      )}
      {showResults && !loading && results.length === 0 && !err && (
        <p className="mt-1 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t('admin.teams.sf_department_empty', { context: crmCtx })}
        </p>
      )}
    </div>
  )
}

// ─── Team Manager picker: searches the CRM's people first (preferred
// source of truth) and app users as a secondary fallback. Picking a
// CRM person resolves to the linked ImpactIQ user (users.crmUserId, or on
// HubSpot an owner matched by link or email) — the team.manager_user_id
// FK targets ImpactIQ users, so someone with no ImpactIQ account can't be
// assigned. Salesforce searches live; HubSpot searches the owner copy.
function TeamManagerPicker({ value, onChange, t }: {
  value: string | null
  onChange: (v: string | null) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [appUsers, setAppUsers] = useState<{ id: string; displayName: string; email: string }[]>([])
  const [crmUsers, setSfUsers] = useState<{ Id: string; Name: string; Email: string | null }[]>([])
  const [q, setQ] = useState('')
  const [sfLoading, setSfLoading] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const crmProvider = useCrmProvider()
  const crmCtx = useCrmLabelContext()

  useEffect(() => {
    let cancelled = false
    api.get<{ id: string; displayName: string; email: string }[]>('/api/admin/users').then((res) => {
      if (cancelled) return
      setAppUsers(res.data ?? [])
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (q.trim().length < 2) { setSfUsers([]); return }
    let cancelled = false
    setSfLoading(true)
    const h = window.setTimeout(async () => {
      const term = encodeURIComponent(q.trim())
      const found: { Id: string; Name: string; Email: string | null }[] = crmProvider === 'hubspot'
        ? ((await api.get<{ id: string; name: string; email: string | null }[]>(`/api/admin/sf/users?q=${term}`)).data ?? [])
          .map((o) => ({ Id: o.id, Name: o.name, Email: o.email }))
        : crmProvider === 'salesforce'
          ? ((await api.get<{ Id: string; Name: string; Email: string | null }[]>(`/api/salesforce/search/users?q=${term}`)).data ?? [])
          : []
      if (cancelled) return
      setSfUsers(found)
      setSfLoading(false)
    }, 250)
    return () => { cancelled = true; window.clearTimeout(h) }
  }, [q, crmProvider])

  const current = appUsers.find((u) => u.id === value) ?? null
  const filteredApp = appUsers.filter((u) => {
    if (!q.trim()) return false
    const n = q.toLowerCase()
    return u.displayName.toLowerCase().includes(n) || u.email.toLowerCase().includes(n)
  }).slice(0, 5)

  async function pickSfUser(sf: { Id: string; Name: string; Email: string | null }) {
    setWarning(null)
    const res = await api.get<{ id: string; displayName: string; email: string } | null>(`/api/admin/users/by-sf/${encodeURIComponent(sf.Id)}`)
    if (!res.data) {
      setWarning(t('admin.teams.manager_no_impactiq_link', { name: sf.Name, context: crmCtx }))
      return
    }
    onChange(res.data.id)
    setQ('')
  }

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      {current ? (
        <div className="mb-2 flex items-center gap-2 rounded border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-xs dark:border-indigo-800 dark:bg-indigo-950/30">
          <span className="flex-1 truncate">
            <span className="font-semibold text-gray-800 dark:text-gray-100">{current.displayName}</span>
            <span className="ml-2 text-gray-500 dark:text-gray-400">{current.email}</span>
          </span>
          <button type="button" onClick={() => onChange(null)} className="text-indigo-800 hover:text-indigo-900 dark:text-indigo-200">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <p className="mb-2 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t('admin.teams.manager_none')}
        </p>
      )}
      <Input
        value={q}
        onChange={(e) => { setQ(e.target.value); setWarning(null) }}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 150)}
        placeholder={t('admin.teams.manager_search_placeholder', { context: crmCtx })}
        className="h-8 text-xs"
      />
      {warning && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{warning}</p>}
      {focused && q.trim().length >= 2 && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded border border-gray-200 bg-white text-xs dark:border-gray-700 dark:bg-gray-900">
          <div className="sticky top-0 bg-gray-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {t('admin.teams.manager_group_sf', { context: crmCtx })} ({crmUsers.length})
          </div>
          {sfLoading && <p className="px-2 py-1.5 text-[11px] italic text-gray-500 dark:text-gray-400">{t('common.loading', 'Loading…')}</p>}
          {!sfLoading && crmUsers.length === 0 && (
            <p className="px-2 py-1.5 text-[11px] italic text-gray-400 dark:text-gray-500">{t('sf.no_results', 'No matches')}</p>
          )}
          {crmUsers.map((u) => (
            <button
              key={`sf-${u.Id}`}
              type="button"
              onClick={() => void pickSfUser(u)}
              className="flex w-full flex-col items-start gap-0.5 border-b border-gray-100 px-2 py-1.5 text-left last:border-b-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">{u.Name}</span>
              {u.Email && <span className="text-[10px] text-gray-500 dark:text-gray-400">{u.Email}</span>}
            </button>
          ))}
          {filteredApp.length > 0 && (
            <>
              <div className="sticky top-0 bg-gray-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {t('admin.teams.manager_group_app')} ({filteredApp.length})
              </div>
              {filteredApp.map((u) => (
                <button
                  key={`app-${u.id}`}
                  type="button"
                  onClick={() => { onChange(u.id); setQ('') }}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-gray-100 px-2 py-1.5 text-left last:border-b-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800"
                >
                  <span className="font-medium text-gray-900 dark:text-gray-100">{u.displayName}</span>
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">{u.email}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Subteams admin: list, add, rename, delete, activate/deactivate,
// assign leaders. Members are managed on the User Management page (each
// user picks which subteams they belong to).
interface Subteam {
  id: string
  name: string
  kind: string | null
  isActive: boolean
  parentSubteamId: string | null
  depth: number
  leaders: { userId: string; name: string; email: string }[]
  members: { userId: string; name: string; email: string }[]
  memberCount: number
}

const MAX_SUBTEAM_DEPTH = 4

function SubteamsSection({ teamId, t }: { teamId: string; t: ReturnType<typeof useTranslation>['t'] }) {
  const [rows, setRows] = useState<Subteam[]>([])
  const [loading, setLoading] = useState(true)
  const [addingName, setAddingName] = useState('')
  const [addingKind, setAddingKind] = useState<'region' | 'type' | 'leader' | 'product' | 'other' | ''>('')
  const [addingParent, setAddingParent] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingLeadersFor, setEditingLeadersFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Inline edit (name / kind / parent) — replaces the old window.prompt.
  const [editingFor, setEditingFor] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editKind, setEditKind] = useState<'region' | 'type' | 'leader' | 'product' | 'other' | ''>('')
  const [editParent, setEditParent] = useState('')
  const [editError, setEditError] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    const res = await api.get<Subteam[]>(`/api/admin/teams/${teamId}/subteams`)
    setRows(res.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamId])

  async function addSubteam() {
    if (!addingName.trim()) return
    setSaving(true)
    setError(null)
    const res = await api.post(`/api/admin/teams/${teamId}/subteams`, { name: addingName.trim(), kind: addingKind || null, parentSubteamId: addingParent || null })
    setSaving(false)
    if (res.error) { setError(res.error); return }
    setAddingName('')
    setAddingKind('')
    setAddingParent('')
    await reload()
  }

  // Depth of a subteam's descendant subtree (0 = leaf). Used to disable parent
  // options that would push the new child past MAX_SUBTEAM_DEPTH.
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) if (r.parentSubteamId) { const a = childrenOf.get(r.parentSubteamId) ?? []; a.push(r.id); childrenOf.set(r.parentSubteamId, a) }
  const subtreeHeight = (id: string, guard = new Set<string>()): number => {
    if (guard.has(id)) return 0
    guard.add(id)
    const kids = childrenOf.get(id) ?? []
    return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => subtreeHeight(k, guard)))
  }
  // Depth-first display order (parent immediately followed by its children),
  // each branch alpha-sorted. Roots = no parent (or parent outside this list).
  const byId = new Map(rows.map((r) => [r.id, r]))
  const orderedRows: Subteam[] = []
  const pushTree = (r: Subteam, guard: Set<string>) => {
    if (guard.has(r.id)) return
    guard.add(r.id)
    orderedRows.push(r)
    ;(childrenOf.get(r.id) ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is Subteam => !!c)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => pushTree(c, guard))
  }
  {
    const guard = new Set<string>()
    rows
      .filter((r) => !r.parentSubteamId || !byId.has(r.parentSubteamId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((r) => pushTree(r, guard))
  }
  // Valid parent options for the add form: any subteam whose subtree still has
  // room for one more level below it (depth + height < MAX).
  const parentOptions = orderedRows.filter((r) => r.depth + subtreeHeight(r.id) < MAX_SUBTEAM_DEPTH)

  async function toggleActive(row: Subteam) {
    await api.patch(`/api/admin/teams/${teamId}/subteams/${row.id}`, { isActive: !row.isActive })
    await reload()
  }

  async function removeSubteam(row: Subteam) {
    if (!window.confirm(t('admin.teams.subteams.delete_confirm', { name: row.name }))) return
    await api.delete(`/api/admin/teams/${teamId}/subteams/${row.id}`)
    await reload()
  }

  function openEdit(row: Subteam) {
    setEditingLeadersFor(null)
    setEditError(null)
    setEditingFor(row.id)
    setEditName(row.name)
    setEditKind((row.kind as 'region' | 'type' | 'leader' | 'product' | 'other' | null) ?? '')
    setEditParent(row.parentSubteamId ?? '')
  }

  async function saveEdit(row: Subteam) {
    if (!editName.trim()) return
    setSaving(true)
    setEditError(null)
    const res = await api.patch(`/api/admin/teams/${teamId}/subteams/${row.id}`, {
      name: editName.trim(),
      kind: editKind || null,
      parentSubteamId: editParent || null,
    })
    setSaving(false)
    if (res.error) { setEditError(res.error); return }
    setEditingFor(null)
    await reload()
  }

  // Descendant ids of a subteam (so the edit parent picker can't create a cycle).
  const descendantsOf = (id: string, acc = new Set<string>()): Set<string> => {
    for (const c of childrenOf.get(id) ?? []) { if (!acc.has(c)) { acc.add(c); descendantsOf(c, acc) } }
    return acc
  }

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      {/* Title + hint are provided by the wrapping <FormSection> in the team
          edit form — don't repeat them here (was a duplicate header). */}
      {loading ? (
        <div className="flex justify-center py-4"><Spinner className="h-4 w-4" /></div>
      ) : rows.length === 0 ? (
        <p className="py-2 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t('admin.teams.subteams.empty')}
        </p>
      ) : (
        <div className="mb-3 flex flex-col gap-1.5">
          {orderedRows.map((r) => (
            <div key={r.id} className="rounded border border-gray-200 dark:border-gray-700" style={{ marginLeft: (r.depth - 1) * 20 }}>
              <div className="flex flex-col gap-1.5 px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-800 dark:text-gray-100">{r.name}</span>
                  {r.kind && <Badge variant="outline" className="text-[10px] uppercase">{r.kind}</Badge>}
                  <Badge variant={r.isActive ? 'success' : 'outline'} className="text-[10px]">{r.isActive ? t('admin.teams.active') : t('admin.teams.inactive')}</Badge>
                  <div className="ml-auto flex items-center gap-1">
                    <button type="button" aria-label={t('admin.teams.subteams.action_leaders', 'Leaders')} onClick={() => setEditingLeadersFor(editingLeadersFor === r.id ? null : r.id)} className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                      <UserRoundCog className="h-3 w-3" />{t('admin.teams.subteams.action_leaders', 'Leaders')}
                    </button>
                    <button type="button" aria-label={t('admin.teams.subteams.action_edit', 'Edit')} onClick={() => (editingFor === r.id ? setEditingFor(null) : openEdit(r))} className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                      <Pencil className="h-3 w-3" />{t('admin.teams.subteams.action_edit', 'Edit')}
                    </button>
                    <button type="button" aria-label={r.isActive ? t('admin.teams.subteams.action_disable', 'Disable') : t('admin.teams.subteams.action_enable', 'Enable')} onClick={() => toggleActive(r)} className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                      {r.isActive ? <PowerOff className="h-3 w-3" /> : <Power className="h-3 w-3" />}{r.isActive ? t('admin.teams.subteams.action_disable', 'Disable') : t('admin.teams.subteams.action_enable', 'Enable')}
                    </button>
                    <button type="button" aria-label={t('admin.teams.subteams.action_delete', 'Delete')} onClick={() => removeSubteam(r)} className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-red-50 hover:text-red-600 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-red-950/40 dark:hover:text-red-400">
                      <Trash2 className="h-3 w-3" />{t('admin.teams.subteams.action_delete', 'Delete')}
                    </button>
                  </div>
                </div>
                {/* Leader + member pills */}
                {(r.leaders.length > 0 || r.members.length > 0) && (
                  <div className="flex flex-col gap-1">
                    {r.leaders.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        {r.leaders.map((l) => (
                          <span key={l.userId} className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
                            <UserRoundCog className="h-2.5 w-2.5" />{l.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {r.members.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        {r.members.slice(0, 8).map((m) => (
                          <span key={m.userId} className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
                            {m.name}
                          </span>
                        ))}
                        {r.members.length > 8 && (
                          <span className="text-[10px] text-gray-500 dark:text-gray-400">+{r.members.length - 8}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {editingLeadersFor === r.id && (
                <SubteamLeadersEditor
                  teamId={teamId}
                  subteam={r}
                  onSaved={() => { setEditingLeadersFor(null); void reload() }}
                  t={t}
                />
              )}
              {editingFor === r.id && (() => {
                // Parent options exclude self + descendants (cycle) and any
                // subteam without room for this subtree's height under depth 4.
                const blocked = descendantsOf(r.id)
                blocked.add(r.id)
                const myHeight = subtreeHeight(r.id)
                const editParentOptions = orderedRows.filter((p) => !blocked.has(p.id) && p.depth + 1 + myHeight <= MAX_SUBTEAM_DEPTH)
                return (
                  <div className="border-t border-gray-100 bg-gray-50/60 px-2 py-2 dark:border-gray-800 dark:bg-gray-900/40">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="flex flex-1 flex-col gap-1">
                        <Label className="text-[11px]">{t('admin.teams.subteams.name_label')}</Label>
                        <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8 text-xs" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-[11px]">{t('admin.teams.subteams.kind_label')}</Label>
                        <Select value={editKind} onChange={(e) => setEditKind(e.target.value as 'region' | 'type' | 'leader' | 'product' | 'other' | '')} className="h-8 text-xs">
                          <option value="">{t('common.none', 'None')}</option>
                          <option value="region">Region</option>
                          <option value="type">Type</option>
                          <option value="leader">Leader</option>
                          <option value="product">Product</option>
                          <option value="other">Other</option>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-[11px]">{t('admin.teams.subteams.parent_label', 'Parent subteam')}</Label>
                        <Select value={editParent} onChange={(e) => setEditParent(e.target.value)} className="h-8 text-xs">
                          <option value="">{t('common.none', 'None')}</option>
                          {editParentOptions.map((p) => (
                            <option key={p.id} value={p.id}>{'— '.repeat(Math.max(0, p.depth - 1))}{p.name}</option>
                          ))}
                        </Select>
                      </div>
                      <Button type="button" size="sm" onClick={() => void saveEdit(r)} disabled={saving || !editName.trim()}>
                        {saving && <Spinner className="mr-1 h-3 w-3" />}
                        <Save className="mr-1 h-3.5 w-3.5" />
                        {t('common.save', 'Save')}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditingFor(null)}>
                        <X className="mr-1 h-3.5 w-3.5" />
                        {t('common.cancel', 'Cancel')}
                      </Button>
                    </div>
                    {editError && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{t(editError, 'Could not save subteam.')}</p>}
                  </div>
                )
              })()}
            </div>
          ))}
        </div>
      )}
      {/* NOT a <form> — SubteamsSection renders inside the outer Team edit
          form and nested forms cause the outer one to submit. Bare inputs +
          a type="button" trigger avoid the double-submit + page refresh. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label className="text-[11px]">{t('admin.teams.subteams.name_label')}</Label>
          <Input
            value={addingName}
            onChange={(e) => setAddingName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addSubteam() } }}
            placeholder={t('admin.teams.subteams.name_placeholder')}
            className="h-8 text-xs"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[11px]">{t('admin.teams.subteams.kind_label')}</Label>
          <Select value={addingKind} onChange={(e) => setAddingKind(e.target.value as 'region' | 'type' | 'leader' | 'product' | 'other' | '')} className="h-8 text-xs">
            <option value="">{t('common.none', 'None')}</option>
            <option value="region">Region</option>
            <option value="type">Type</option>
            <option value="leader">Leader</option>
            <option value="product">Product</option>
            <option value="other">Other</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[11px]">{t('admin.teams.subteams.parent_label', 'Parent subteam')}</Label>
          <Select value={addingParent} onChange={(e) => setAddingParent(e.target.value)} className="h-8 text-xs">
            <option value="">{t('common.none', 'None')}</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>{'— '.repeat(Math.max(0, p.depth - 1))}{p.name}</option>
            ))}
          </Select>
        </div>
        <Button type="button" size="sm" onClick={() => void addSubteam()} disabled={saving || !addingName.trim()}>
          {saving && <Spinner className="mr-1 h-3 w-3" />}
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('admin.teams.subteams.add')}
        </Button>
      </div>
      {error && <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{t(error, 'Could not save subteam.')}</p>}
    </div>
  )
}

function SubteamLeadersEditor({ teamId, subteam, onSaved, t }: {
  teamId: string
  subteam: Subteam
  onSaved: () => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [users, setUsers] = useState<{ id: string; displayName: string; email: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set(subteam.leaders.map((l) => l.userId)))
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.get<{ id: string; displayName: string; email: string }[]>('/api/admin/users').then((res) => {
      if (cancelled) return
      setUsers(res.data ?? [])
    })
    return () => { cancelled = true }
  }, [])
  const filtered = users.filter((u) => {
    if (!q.trim()) return selected.has(u.id) || false
    const n = q.toLowerCase()
    return u.displayName.toLowerCase().includes(n) || u.email.toLowerCase().includes(n)
  })
  async function save() {
    setSaving(true)
    await api.patch(`/api/admin/teams/${teamId}/subteams/${subteam.id}`, { leaderUserIds: Array.from(selected) })
    setSaving(false)
    onSaved()
  }
  return (
    <div className="border-t border-gray-100 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-800/50">
      <p className="mb-1 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
        {t('admin.teams.subteams.leaders_editor_title')}
      </p>
      <div className="flex flex-wrap gap-1">
        {Array.from(selected).map((uid) => {
          const u = users.find((x) => x.id === uid)
          if (!u) return null
          return (
            <span key={uid} className="inline-flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] dark:border-indigo-800 dark:bg-indigo-950/30">
              {u.displayName}
              <button type="button" onClick={() => setSelected((s) => { const next = new Set(s); next.delete(uid); return next })} className="text-indigo-700 dark:text-indigo-300">
                <X className="h-3 w-3" />
              </button>
            </span>
          )
        })}
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.teams.subteams.leader_search_placeholder')} className="mt-2 h-7 text-xs" />
      {q && filtered.length > 0 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 bg-white text-xs dark:border-gray-700 dark:bg-gray-900">
          {filtered.slice(0, 10).map((u) => (
            <button key={u.id} type="button" onClick={() => setSelected((s) => new Set(s).add(u.id))} className="flex w-full flex-col items-start gap-0.5 border-b border-gray-100 px-2 py-1 text-left last:border-b-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800">
              <span className="font-medium text-gray-900 dark:text-gray-100">{u.displayName}</span>
              <span className="text-[10px] text-gray-500 dark:text-gray-400">{u.email}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Spinner className="mr-1 h-3 w-3" />}
          <Save className="mr-1 h-3.5 w-3.5" />
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}

// v1.88.0: theme picker for the team's active_theme_id.
// v1.346.0: the "inherit" placeholder now names the CURRENT org-default
// theme instead of a static, never-changing "— Inherit org default —"
// literal — previously the only place that name showed up was on the
// theme's own row (already correctly dynamic via t.isActive below), so
// switching which theme is org-default via Admin → Themes → Set as
// Default never visibly changed this dropdown at all.
function TeamThemePicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useTranslation()
  const [themes, setThemes] = useState<Array<{ id: string; name: string; isActive: boolean }>>([])
  useEffect(() => {
    void api.get<Array<{ id: string; name: string; isActive: boolean }>>('/api/themes').then((r) => setThemes(r.data ?? []))
  }, [])
  const orgDefaultTheme = themes.find((th) => th.isActive)
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
    >
      <option value="">
        {orgDefaultTheme
          ? t('admin.teams.theme_inherit_default', { name: orgDefaultTheme.name, defaultValue: '— Inherit org default ({{name}}) —' })
          : t('admin.teams.theme_inherit_default_none', '— Inherit org default —')}
      </option>
      {themes.map((th) => (
        <option key={th.id} value={th.id}>
          {th.isActive ? t('admin.teams.theme_option_default', { name: th.name, defaultValue: '{{name}} (Default)' }) : th.name}
        </option>
      ))}
    </select>
  )
}
