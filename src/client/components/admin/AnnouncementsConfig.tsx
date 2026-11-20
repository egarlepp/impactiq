import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Save, X, Info, AlertTriangle, AlertOctagon, Users, UsersRound, User as UserIcon, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useNotifications } from '../ui/notifications.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Textarea } from '../ui/textarea.js'
import { Label } from '../ui/label.js'
import { Select } from '../ui/select.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { IconPicker, DynamicIcon } from '../ui/icon-picker.js'
import { ColorPicker } from '../ui/color-picker.js'
import { cn } from '../../lib/utils.js'

type TargetType = 'team' | 'subteam' | 'user'
type Severity = 'info' | 'warning' | 'critical'

interface Announcement {
  id: string
  teamId: string
  targetType: TargetType
  subteamId: string | null
  targetUserId: string | null
  message: string
  severity: Severity
  icon: string | null
  iconColorLight: string | null
  iconColorDark: string | null
  startDate: string
  endDate: string | null
  recurringDaily: boolean
  isActive: boolean
  sendSlack: boolean
  slackSentAt: string | null
  createdBy: string | null
}

interface SubteamOption { id: string; name: string }
interface MemberOption { id: string; displayName: string; email: string }

interface FormState {
  targetType: TargetType
  subteamId: string
  targetUserId: string
  message: string
  severity: Severity
  icon: string | null
  iconColorLight: string | null
  iconColorDark: string | null
  startDate: string
  endDate: string
  recurringDaily: boolean
  isActive: boolean
  sendSlack: boolean
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

const emptyForm: FormState = {
  targetType: 'team',
  subteamId: '',
  targetUserId: '',
  message: '',
  severity: 'info',
  icon: null,
  iconColorLight: null,
  iconColorDark: null,
  startDate: todayIso(),
  endDate: '',
  recurringDaily: false,
  isActive: true,
  sendSlack: false,
}

const SEVERITY_ICON: Record<Severity, typeof Info> = { info: Info, warning: AlertTriangle, critical: AlertOctagon }
const SEVERITY_BADGE_VARIANT: Record<Severity, 'default' | 'warning' | 'destructive'> = { info: 'default', warning: 'warning', critical: 'destructive' }

export function AnnouncementsConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  // Reused only for its refresh() — after a create/edit/delete here, the
  // underlying announcement is no longer what the notifications table has
  // synced (server-side self-heals within 60s on its own, see
  // syncAnnouncementNotifications in routes/notifications.ts), but the admin
  // making the change expects the bell/banner to update immediately rather
  // than wait out that poll window.
  const { refresh: refreshNotifications } = useNotifications()
  const [rows, setRows] = useState<Announcement[]>([])
  const [subteams, setSubteams] = useState<SubteamOption[]>([])
  const [members, setMembers] = useState<MemberOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)

  async function reload() {
    setLoading(true)
    const [rowsRes, subteamsRes, membersRes] = await Promise.all([
      api.get<Announcement[]>(`/api/teams/${teamId}/announcements`),
      api.get<SubteamOption[]>(`/api/teams/${teamId}/subteams`),
      api.get<MemberOption[]>(`/api/teams/${teamId}/members`),
    ])
    setRows(rowsRes.data ?? [])
    setSubteams(subteamsRes.data ?? [])
    setMembers(membersRes.data ?? [])
    setLoading(false)
  }
  useEffect(() => { void reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamId])

  function openCreate() {
    setForm(emptyForm)
    setEditingId(null)
    setCreating(true)
    setError(null)
  }
  function openEdit(row: Announcement) {
    setForm({
      targetType: row.targetType,
      subteamId: row.subteamId ?? '',
      targetUserId: row.targetUserId ?? '',
      message: row.message,
      severity: row.severity,
      icon: row.icon,
      iconColorLight: row.iconColorLight,
      iconColorDark: row.iconColorDark,
      startDate: row.startDate,
      endDate: row.endDate ?? '',
      recurringDaily: row.recurringDaily,
      isActive: row.isActive,
      sendSlack: row.sendSlack,
    })
    setEditingId(row.id)
    setCreating(false)
    setError(null)
  }
  function closeForm() {
    setCreating(false)
    setEditingId(null)
    setError(null)
  }

  async function submit() {
    if (form.targetType === 'subteam' && !form.subteamId) { setError(t('admin.announcements.error_subteam_required', 'Pick a subteam.')); return }
    if (form.targetType === 'user' && !form.targetUserId) { setError(t('admin.announcements.error_user_required', 'Pick a user.')); return }
    if (!form.message.trim()) { setError(t('admin.announcements.error_message_required', 'Message is required.')); return }
    setSaving(true)
    setError(null)
    const payload = {
      targetType: form.targetType,
      subteamId: form.targetType === 'subteam' ? form.subteamId : null,
      targetUserId: form.targetType === 'user' ? form.targetUserId : null,
      message: form.message.trim(),
      severity: form.severity,
      // No icon chosen -> colors are meaningless, always clear them too so
      // a color picked then un-set never lingers as dead config.
      icon: form.icon,
      iconColorLight: form.icon ? form.iconColorLight : null,
      iconColorDark: form.icon ? form.iconColorDark : null,
      startDate: form.startDate,
      endDate: form.endDate || null,
      recurringDaily: form.recurringDaily,
      isActive: form.isActive,
      sendSlack: form.sendSlack,
    }
    const res = editingId
      ? await api.patch(`/api/teams/${teamId}/announcements/${editingId}`, payload)
      : await api.post(`/api/teams/${teamId}/announcements`, payload)
    setSaving(false)
    if (res.error) { setError(t(res.error, res.error)); return }
    closeForm()
    await reload()
    void refreshNotifications()
  }

  async function remove(id: string) {
    if (!window.confirm(t('admin.announcements.delete_confirm', 'Delete this announcement? It will disappear for everyone immediately.'))) return
    const res = await api.delete(`/api/teams/${teamId}/announcements/${id}`)
    if (res.error) { setError(t(res.error, res.error)); return }
    await reload()
    void refreshNotifications()
  }

  function targetLabel(row: Announcement): string {
    if (row.targetType === 'team') return t('admin.announcements.target_team', 'Whole team')
    if (row.targetType === 'subteam') {
      const st = subteams.find((s) => s.id === row.subteamId)
      return st ? t('admin.announcements.target_subteam_named', 'Subteam: {{name}}', { name: st.name }) : t('admin.announcements.target_subteam', 'Subteam')
    }
    const m = members.find((mm) => mm.id === row.targetUserId)
    return m ? t('admin.announcements.target_user_named', 'User: {{name}}', { name: m.displayName }) : t('admin.announcements.target_user', 'User')
  }

  const canDelete = (row: Announcement): boolean =>
    !!user && (user.isAppAdmin || user.isAdmin || row.createdBy === user.id)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.announcements.title', 'Announcements')}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.announcements.description', 'Post a message to your whole team, a subteam, or one person. It shows in the top banner and the notification bell until dismissed.')}
          </p>
        </div>
        {!creating && !editingId && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            {t('admin.announcements.create_button', 'New Announcement')}
          </Button>
        )}
      </div>

      {(creating || editingId) && (
        <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
          <div>
            <Label>{t('admin.announcements.target_type_label', 'Who sees this')}</Label>
            <div className="mt-1 flex gap-2">
              <button type="button" onClick={() => setForm((f) => ({ ...f, targetType: 'team' }))}
                className={cn('inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium', form.targetType === 'team' ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300')}>
                <Users className="h-3.5 w-3.5" />{t('admin.announcements.target_type_team', 'Team')}
              </button>
              <button type="button" onClick={() => setForm((f) => ({ ...f, targetType: 'subteam' }))}
                className={cn('inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium', form.targetType === 'subteam' ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300')}>
                <UsersRound className="h-3.5 w-3.5" />{t('admin.announcements.target_type_subteam', 'Subteam')}
              </button>
              <button type="button" onClick={() => setForm((f) => ({ ...f, targetType: 'user' }))}
                className={cn('inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium', form.targetType === 'user' ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300')}>
                <UserIcon className="h-3.5 w-3.5" />{t('admin.announcements.target_type_user', 'Specific person')}
              </button>
            </div>
          </div>

          {form.targetType === 'subteam' && (
            <div>
              <Label>{t('admin.announcements.subteam_label', 'Subteam')}</Label>
              <Select value={form.subteamId} onChange={(e) => setForm((f) => ({ ...f, subteamId: e.target.value }))}>
                <option value="">{t('admin.announcements.select_subteam', 'Select a subteam…')}</option>
                {subteams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
          )}
          {form.targetType === 'user' && (
            <div>
              <Label>{t('admin.announcements.user_label', 'Person')}</Label>
              <Select value={form.targetUserId} onChange={(e) => setForm((f) => ({ ...f, targetUserId: e.target.value }))}>
                <option value="">{t('admin.announcements.select_user', 'Select a person…')}</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </Select>
            </div>
          )}

          <div>
            <Label>{t('admin.announcements.message_label', 'Message')}</Label>
            <Textarea value={form.message} maxLength={2000} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} rows={3} />
          </div>

          <div>
            <Label>{t('admin.announcements.severity_label', 'Severity')}</Label>
            <Select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Severity }))}>
              <option value="info">{t('admin.announcements.severity_info', 'Info')}</option>
              <option value="warning">{t('admin.announcements.severity_warning', 'Warning')}</option>
              <option value="critical">{t('admin.announcements.severity_critical', 'Critical')}</option>
            </Select>
          </div>

          <div>
            <Label>{t('admin.announcements.icon_label', 'Header banner icon (optional)')}</Label>
            <div className="mt-1 flex items-center gap-2">
              <IconPicker value={form.icon} onChange={(icon) => setForm((f) => ({ ...f, icon }))} />
              {form.icon && (
                <DynamicIcon
                  name={form.icon}
                  className="h-5 w-5"
                  style={{ color: form.iconColorLight ?? undefined }}
                />
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
              {t('admin.announcements.icon_hint', 'Shown in the top-header banner only — the notification bell and toast always use the plain severity icon. Leave unset to use the severity icon everywhere.')}
            </p>
          </div>

          {form.icon && (
            <div className="grid grid-cols-2 gap-3">
              <ColorPicker
                label={t('admin.announcements.icon_color_light_label', 'Icon color (light mode)')}
                value={form.iconColorLight}
                onChange={(next) => setForm((f) => ({ ...f, iconColorLight: next }))}
                onReset={() => setForm((f) => ({ ...f, iconColorLight: null }))}
              />
              <ColorPicker
                label={t('admin.announcements.icon_color_dark_label', 'Icon color (dark mode)')}
                value={form.iconColorDark}
                onChange={(next) => setForm((f) => ({ ...f, iconColorDark: next }))}
                onReset={() => setForm((f) => ({ ...f, iconColorDark: null }))}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('admin.announcements.start_date_label', 'Start date')}</Label>
              <Input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div>
              <Label>{t('admin.announcements.end_date_label', 'End date')}</Label>
              <Input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
              <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{t('admin.announcements.end_date_hint', 'Leave blank for no end date.')}</p>
            </div>
          </div>

          <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="checkbox" className="mt-0.5" checked={form.recurringDaily} onChange={(e) => setForm((f) => ({ ...f, recurringDaily: e.target.checked }))} />
            <span>
              {t('admin.announcements.recurring_daily_label', 'Reappear daily')}
              <br />
              <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('admin.announcements.recurring_daily_hint', "If someone dismisses it, it comes back the next day (their own local morning) until the end date. If off, dismissing it hides it for good.")}</span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="checkbox" className="mt-0.5" checked={form.sendSlack} onChange={(e) => setForm((f) => ({ ...f, sendSlack: e.target.checked }))} />
            <span>
              <span className="inline-flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />{t('admin.announcements.send_slack_label')}</span>
              <br />
              <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('admin.announcements.send_slack_hint')}</span>
            </span>
          </label>

          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
            {t('admin.announcements.is_active_label', 'Active')}
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closeForm}>
              <X className="h-4 w-4" />
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={saving}>
              {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.announcements.empty_state', 'No announcements yet.')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const SevIcon = SEVERITY_ICON[row.severity]
            return (
              <div key={row.id} className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <SevIcon className={cn('mt-0.5 h-4 w-4 shrink-0', row.severity === 'critical' ? 'text-red-500' : row.severity === 'warning' ? 'text-amber-500' : 'text-blue-500')} />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-gray-900 dark:text-gray-100">{row.message}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                      <Badge variant={SEVERITY_BADGE_VARIANT[row.severity]}>{t(`admin.announcements.severity_${row.severity}`)}</Badge>
                      <span>{targetLabel(row)}</span>
                      <span>· {row.startDate}{row.endDate ? ` – ${row.endDate}` : ` (${t('admin.announcements.no_end_date', 'no end date')})`}</span>
                      {row.recurringDaily && <span>· {t('admin.announcements.recurring_badge', 'Recurring daily')}</span>}
                      {!row.isActive && <span>· {t('admin.announcements.inactive_badge', 'Inactive')}</span>}
                      {row.sendSlack && (
                        <span className="inline-flex items-center gap-1">
                          · <MessageSquare className="h-3 w-3" />
                          {row.slackSentAt ? t('admin.announcements.slack_sent_badge') : t('admin.announcements.slack_pending_badge')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => openEdit(row)} className="rounded p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400" title={t('common.edit', 'Edit')}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  {canDelete(row) && (
                    <button onClick={() => void remove(row.id)} className="rounded p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400" title={t('common.delete', 'Delete')}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
