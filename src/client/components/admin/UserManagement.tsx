import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, AlertCircle, AlertTriangle, UserPlus, Check, X, Pencil, KeyRound, Save, ShieldCheck, Search, RefreshCw, Cloud, CalendarDays, ChevronDown, ChevronRight, ShieldAlert, Users, Ban, UserX, UserCheck, User, Layers, Clock, Bell, Send, CircleDollarSign, ArrowRight, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { Select } from '../ui/select.js'
import { CURRENCIES } from './common-lists.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { Button } from '../ui/button.js'
import { SubteamFilter } from '../ui/subteam-filter.js'
import { PASSWORD_RULES, validatePasswordComplexity, authMethodNeedsPassword, PASSWORD_EXPIRY_DAYS } from '../../../shared/schemas/password.js'
import { translateServerError } from '../../lib/errors.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import { FormSection, FormSectionsToolbar, FormSaveBar, FormSubheading, FieldLabel, useFormSections } from './FormSection.js'

type AuthMethod = 'password' | 'okta' | 'azure' | 'both'

interface TeamUser {
  userId: string
  email: string
  displayName: string
  role: 'contributor' | 'leader' | 'team_admin' | 'admin'
  isDefaultAdmin?: boolean
  authMethod?: AuthMethod
  defaultTeamId?: string | null
  defaultTeamName?: string | null
}

interface DirectoryUser {
  id: string
  email: string
  displayName: string
  firstName?: string | null
  lastName?: string | null
  isAppAdmin?: boolean
  canSeeAllTeams?: boolean
  isDefaultAdmin?: boolean
  authMethod?: AuthMethod
  defaultTeamId?: string | null
  defaultTeamName?: string | null
  supportedTeamIds?: string[]
  // v1.318.0: role per team_members row this user belongs to, keyed by
  // teamId — lets the "group by default team" cross-team view resolve the
  // right role for whichever team a user's row is grouped under, without a
  // second per-team fetch.
  teamRoles?: Record<string, string>
  mustChangePassword?: boolean
  oktaId?: string
  totpEnrolledAt?: string | null
  backupCodesRemaining?: number
  lastLoginAt?: string | null
  // v1.425.0: set when an App Admin disabled the account.
  disabledAt?: string | null
  // v1.323.0: when the password was last set — only meaningful for
  // authMethod='password' accounts, drives the password-expiry pill.
  passwordChangedAt?: string | null
  workerType?: 'full_time' | 'part_time' | 'contractor'
  workDays?: number
  workDayStartHour?: number
  workDayEndHour?: number
  crmUserId?: string | null
  sfUserName?: string | null
  sfUserEmail?: string | null
  preferredCurrency?: string | null
  // vNext: SF/Outlook connection icons. Read straight off user_integrations
  // (local Postgres, no live SF/Graph call) — "connected" means a token is
  // on file, not that it's been verified working right now. See the Verify
  // button (verifyConnection()) for the opt-in live check.
  sfConnected?: boolean
  sfConnectedAt?: string | null
  sfAccountLabel?: string | null
  outlookConnected?: boolean
  outlookConnectedAt?: string | null
  outlookAccountLabel?: string | null
}

interface ConnectionVerifyResult {
  connected: boolean
  healthy: boolean
  accountLabel: string | null
  connectedAt: string | null
  verifiedAt: string
  error: string | null
}

interface EditForm {
  displayName: string
  firstName: string
  lastName: string
  email: string
  isAppAdmin: boolean
  canSeeAllTeams: boolean
  isDefaultAdmin: boolean
  authMethod: AuthMethod
  defaultTeamId: string
  supportedTeamIds: string[]
  mustChangePassword: boolean
  workerType: 'full_time' | 'part_time' | 'contractor'
  workDays: number
  workDayStartHour: number
  workDayEndHour: number
  crmUserId: string | null
  sfUserName: string | null
  preferredCurrency: string | null
}

type PickerRole = 'none' | 'contributor' | 'leader' | 'team_admin' | 'admin'

type WorkerType = 'full_time' | 'part_time' | 'contractor'

interface WorkWeekSnapshot {
  workerType: WorkerType
  workDays: number
  workDayStartHour: number
  workDayEndHour: number
  workHoursPerDay?: Record<string, { start: number; end: number }> | null
}

interface WorkWeekRequest {
  id: string
  userId: string
  userDisplayName: string | null
  userEmail: string | null
  beforeSnapshot: WorkWeekSnapshot
  afterSnapshot: WorkWeekSnapshot
  status: string
  createdAt: string
}

const DAY_LABELS_UM = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
function daysMaskLabel(mask: number): string {
  const out: string[] = []
  for (let i = 0; i < 7; i++) if (mask & (1 << i)) out.push(DAY_LABELS_UM[i]!)
  return out.join(', ') || '—'
}

function formatLastLogin(iso: string | null | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  if (!iso) return t('admin.users.never_logged_in', 'Never')
  return new Date(iso).toLocaleString()
}

// v1.323.0: the 90-day password-reset countdown — only meaningful for
// authMethod='password' accounts (Okta/Azure SSO and 'both' accounts show
// "—", since password expiry policy is scoped to password-only accounts,
// see CLAUDE.md §4/§5). null when not applicable (caller renders a dash).
function passwordResetStatus(
  authMethod: AuthMethod | undefined,
  passwordChangedAt: string | null | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): { label: string; overdue: boolean } | null {
  if (authMethod !== 'password') return null
  if (!passwordChangedAt) return { label: t('admin.users.password_reset_unknown', 'Unknown'), overdue: false }
  const dueAt = new Date(passwordChangedAt).getTime() + PASSWORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  const daysLeft = Math.ceil((dueAt - Date.now()) / (24 * 60 * 60 * 1000))
  if (daysLeft < 0) return { label: t('admin.users.password_reset_overdue', '{{days}}d overdue', { days: Math.abs(daysLeft) }), overdue: true }
  if (daysLeft === 0) return { label: t('admin.users.password_reset_today', 'Due today'), overdue: true }
  return { label: t('admin.users.password_reset_in_days', 'in {{days}}d', { days: daysLeft }), overdue: false }
}

// vNext: one SF or Outlook connection icon + opt-in Verify button on a User
// Management roster row. `connected`/`connectedAt`/`accountLabel` come from
// the roster's own local user_integrations join (GET /users) — cheap, no
// live call, may be stale. `verifyResult` (once the admin clicks Verify)
// overrides that with a real, just-now-probed answer for this one row only;
// it is never fetched automatically. Three visual states: gray (not
// connected), green (connected — local snapshot, or verified healthy), red
// (verified and the token no longer works — a stale/revoked connection the
// local snapshot alone can't detect).
function ConnectionIcon({
  icon: Icon,
  label,
  connected,
  connectedAt,
  accountLabel,
  verifying,
  verifyResult,
  onVerify,
  t,
}: {
  icon: LucideIcon
  label: string
  connected: boolean
  connectedAt: string | null | undefined
  accountLabel: string | null | undefined
  verifying: boolean
  verifyResult: ConnectionVerifyResult | undefined
  onVerify: () => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const effectiveConnected = verifyResult ? verifyResult.connected : connected
  const effectiveLabel = verifyResult?.accountLabel ?? accountLabel
  const effectiveAt = verifyResult?.connectedAt ?? connectedAt
  const verifiedUnhealthy = !!verifyResult && verifyResult.connected && !verifyResult.healthy
  const colorClass = verifiedUnhealthy
    ? 'text-red-500 dark:text-red-400'
    : effectiveConnected
    ? 'text-green-500 dark:text-green-400'
    : 'text-gray-300 dark:text-gray-600'
  const statusLine = verifiedUnhealthy
    ? t('admin.users.connection_verify_unhealthy', '{{label}}: connected, but the token no longer works (verified just now)', { label })
    : !effectiveConnected
    ? t('admin.users.connection_not_connected', '{{label}}: not connected', { label })
    : verifyResult
    ? t('admin.users.connection_verified_healthy', '{{label}}: verified working just now', { label })
    : t('admin.users.connection_last_known', '{{label}}: connected (last known — not verified)', { label })
  const title = [statusLine, effectiveLabel ? t('admin.users.connection_as', 'as {{who}}', { who: effectiveLabel }) : null, effectiveAt ? new Date(effectiveAt).toLocaleString() : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="inline-flex items-center gap-0.5" title={title}>
      <Icon className={cn('h-3.5 w-3.5', colorClass)} />
      <button
        type="button"
        onClick={onVerify}
        disabled={verifying}
        title={t('admin.users.connection_verify_button', 'Verify {{label}} connection', { label })}
        aria-label={t('admin.users.connection_verify_button', 'Verify {{label}} connection', { label })}
        className="rounded p-0.5 text-gray-300 hover:text-blue-600 disabled:opacity-50 dark:text-gray-600 dark:hover:text-blue-400"
      >
        <RefreshCw className={cn('h-3 w-3', verifying && 'animate-spin')} />
      </button>
    </span>
  )
}

interface CreateForm {
  firstName: string
  lastName: string
  email: string
  password: string
  teamId: string
  role: PickerRole
  authMethod: AuthMethod
  mustChangePassword: boolean
  supportedTeamIds: string[]
  canSeeAllTeams: boolean
  workerType: WorkerType
  workDays: number
  workDayStartHour: number
  workDayEndHour: number
  // v1.115.0: opt-in emails at create time. sendInvitation supersedes
  // sendWelcome (the invitation email already includes credentials +
  // sets mustChangePassword). Server enforces the same precedence.
  sendWelcome: boolean
  sendInvitation: boolean
}

const emptyCreateForm: CreateForm = { firstName: '', lastName: '', email: '', password: '', teamId: '', role: 'none', authMethod: 'both', mustChangePassword: true, supportedTeamIds: [], canSeeAllTeams: false, workerType: 'full_time', workDays: 31, workDayStartHour: 9, workDayEndHour: 18, sendWelcome: false, sendInvitation: false }

const DAY_BITS_UM: { key: string; bit: number }[] = [
  { key: 'mon', bit: 1 },{ key: 'tue', bit: 2 },{ key: 'wed', bit: 4 },{ key: 'thu', bit: 8 },
  { key: 'fri', bit: 16 },{ key: 'sat', bit: 32 },{ key: 'sun', bit: 64 },
]

export function UserManagement({ teamId, globalView }: { teamId: string; globalView?: boolean }) {
  const { t, i18n } = useTranslation()
  const crmCtx = useCrmLabelContext()
  // Security fix (F-04, pentest 2026-09): the server now rejects setting a
  // team role to "admin" unless the caller is already an App Admin (that
  // role auto-grants global App Admin — see admin.ts's role-PATCH route).
  // Hide the option here to match, so a team_admin doesn't hit a confusing
  // 403 after picking it.
  const { user: viewer } = useCurrentUser()
  const viewerIsAppAdmin = !!viewer?.isAppAdmin
  const [users, setUsers] = useState<TeamUser[]>([])
  const [allUsers, setAllUsers] = useState<DirectoryUser[]>([])
  const [allTeams, setAllTeams] = useState<{ id: string; name: string; defaultWorkerType?: WorkerType; defaultWorkDays?: number; defaultWorkDayStartHour?: number; defaultWorkDayEndHour?: number }[]>([])
  // Tracks which work-week fields the admin has manually edited in the create
  // form. When the admin picks a team, we pre-fill fields that are still
  // untouched but leave admin-edited fields alone. Reset when the form closes.
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())
  function markTouched(field: string) {
    setTouchedFields((prev) => { if (prev.has(field)) return prev; const next = new Set(prev); next.add(field); return next })
  }
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [creatingUser, setCreatingUser] = useState(false)
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm)
  const [pickerUserId, setPickerUserId] = useState('')
  const [pickerRole, setPickerRole] = useState<PickerRole>('contributor')
  const [error, setError] = useState<string | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm>({ displayName: '', firstName: '', lastName: '', email: '', isAppAdmin: false, canSeeAllTeams: false, isDefaultAdmin: false, authMethod: 'both', defaultTeamId: '', supportedTeamIds: [], mustChangePassword: false, workerType: 'full_time', workDays: 31, workDayStartHour: 9, workDayEndHour: 18, crmUserId: null, sfUserName: null, preferredCurrency: null })
  const [resettingUserId, setResettingUserId] = useState<string | null>(null)
  // v1.472.0: the edit/create forms are grouped into collapsible sections;
  // which ones are open is remembered per admin in this browser.
  const editSections = useFormSections('admin.users.edit', { profile: true, access: true, crm: false, subteams: false, week: false, prefs: false })
  const createSections = useFormSections('admin.users.create', { profile: true, access: true, week: false, welcome: false })
  // Role on the team being viewed, edited inside the form (flat team view
  // only; the grouped All Teams view keeps the row dropdown). Saved with the
  // rest of the form through the same route the row dropdown uses.
  const [editRole, setEditRole] = useState<{ initial: string; value: string } | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  // vNext: opt-in per-row connection verify (SF/Outlook icons). Keyed by
  // `${userId}:${provider}` — never fires on its own, only from the Verify
  // button's onClick. verifyResults overrides the roster's local snapshot
  // for that one icon until the page is next reloaded.
  const [verifying, setVerifying] = useState<Record<string, boolean>>({})
  const [verifyResults, setVerifyResults] = useState<Record<string, ConnectionVerifyResult>>({})
  async function verifyConnection(userId: string, provider: 'salesforce' | 'microsoft') {
    const key = `${userId}:${provider}`
    setVerifying((v) => ({ ...v, [key]: true }))
    const res = await api.post<ConnectionVerifyResult>(`/api/admin/users/${userId}/verify-connection`, { provider })
    setVerifying((v) => ({ ...v, [key]: false }))
    if (res.data) setVerifyResults((v) => ({ ...v, [key]: res.data! }))
  }
  const [notifPrefs, setNotifPrefs] = useState<{ emailEnabled: boolean; weeklyRecapEnabled: boolean }>({ emailEnabled: true, weeklyRecapEnabled: true })
  const [notifPrefsInitial, setNotifPrefsInitial] = useState<{ emailEnabled: boolean; weeklyRecapEnabled: boolean }>({ emailEnabled: true, weeklyRecapEnabled: true })
  const [approvals, setApprovals] = useState<WorkWeekRequest[]>([])
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  async function reloadApprovals() {
    const res = await api.get<WorkWeekRequest[]>('/api/admin/work-week-requests?status=pending')
    setApprovals(res.data ?? [])
  }

  async function approveRequest(id: string) {
    const res = await api.post(`/api/admin/work-week-requests/${id}/approve`, {})
    if (res.error) { setError(res.error); return }
    await Promise.all([reloadApprovals(), reload()])
  }

  async function rejectRequest(id: string) {
    const res = await api.post(`/api/admin/work-week-requests/${id}/reject`, { notes: rejectNote || null })
    if (res.error) { setError(res.error); return }
    setRejectingId(null)
    setRejectNote('')
    await reloadApprovals()
  }

  useEffect(() => { void reloadApprovals() }, [])

  async function reload() {
    setLoading(true)
    // v1.318.0: globalView (teamId === '') has no single team's roster to
    // fetch — skip that request rather than hitting a malformed
    // /api/admin/teams//users URL. allUsers/allTeams alone are enough to
    // build the "group by default team" cross-team view below.
    const [memRes, dirRes, teamRes] = await Promise.all([
      teamId ? api.get<TeamUser[]>(`/api/admin/teams/${teamId}/users`) : Promise.resolve({ data: [] as TeamUser[], error: null, meta: {} }),
      api.get<DirectoryUser[]>('/api/admin/users'),
      api.get<{ id: string; name: string; defaultWorkerType?: WorkerType; defaultWorkDays?: number; defaultWorkDayStartHour?: number; defaultWorkDayEndHour?: number }[]>('/api/admin/teams'),
    ])
    setUsers(memRes.data ?? [])
    setAllUsers(dirRes.data ?? [])
    setAllTeams(teamRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => { void reload() }, [teamId, globalView])

  async function changeRole(userId: string, role: string) {
    if (role === 'none') {
      const target = users.find((u) => u.userId === userId)
      if (target) await removeUser(target, true)
      return
    }
    setSaving(userId)
    setError(null)
    const res = await api.patch(`/api/admin/teams/${teamId}/users/${userId}/role`, { role })
    if (res.error) {
      setError(res.error)
    } else {
      setUsers((prev) => prev.map((u) => (u.userId === userId ? { ...u, role: role as TeamUser['role'] } : u)))
    }
    setSaving(null)
  }

  async function removeUser(user: TeamUser, skipConfirm = false) {
    if (!skipConfirm && !window.confirm(t('admin.users.remove_confirm', { name: user.displayName }))) return
    setSaving(user.userId)
    setError(null)
    const res = await api.delete(`/api/admin/teams/${teamId}/users/${user.userId}`)
    if (res.error) {
      setError(res.error)
    } else {
      setUsers((prev) => prev.filter((u) => u.userId !== user.userId))
    }
    setSaving(null)
  }

  async function addMember() {
    if (!pickerUserId) return
    // "None" — leave the user out of the team (no membership row).
    if (pickerRole === 'none') {
      setAdding(false)
      setPickerUserId('')
      setPickerRole('contributor')
      return
    }
    setSaving('add')
    setError(null)
    const res = await api.post(`/api/admin/teams/${teamId}/users`, { userId: pickerUserId, role: pickerRole })
    setSaving(null)
    if (res.error) {
      setError(res.error)
      return
    }
    setAdding(false)
    setPickerUserId('')
    setPickerRole('contributor')
    await reload()
  }

  function openEdit(user: TeamUser) {
    const dir = allUsers.find((u) => u.id === user.userId)
    setEditingUserId(user.userId)
    setEditRole(!globalView && teamId && users.some((u) => u.userId === user.userId) ? { initial: user.role, value: user.role } : null)
    // v1.127.0: prefer per-field firstName/lastName if the directory
    // row has them; fall back to splitting displayName on the first
    // space so pre-migration data still edits cleanly.
    const dn = user.displayName ?? ''
    const spacedFirst = dn.split(/\s+/).slice(0, 1).join(' ')
    const spacedLast = dn.split(/\s+/).slice(1).join(' ')
    setEditForm({
      displayName: user.displayName,
      firstName: (dir?.firstName ?? spacedFirst) ?? '',
      lastName: (dir?.lastName ?? spacedLast) ?? '',
      email: user.email,
      isAppAdmin: dir?.isAppAdmin ?? false,
      canSeeAllTeams: dir?.canSeeAllTeams ?? false,
      isDefaultAdmin: dir?.isDefaultAdmin ?? user.isDefaultAdmin ?? false,
      authMethod: dir?.authMethod ?? user.authMethod ?? 'both',
      defaultTeamId: (dir?.defaultTeamId ?? user.defaultTeamId ?? '') as string,
      supportedTeamIds: dir?.supportedTeamIds ?? [],
      mustChangePassword: dir?.mustChangePassword ?? false,
      workerType: dir?.workerType ?? 'full_time',
      workDays: dir?.workDays ?? 31,
      workDayStartHour: dir?.workDayStartHour ?? 9,
      workDayEndHour: dir?.workDayEndHour ?? 18,
      crmUserId: dir?.crmUserId ?? null,
      sfUserName: dir?.sfUserName ?? null,
      preferredCurrency: dir?.preferredCurrency ?? null,
    })
    setError(null)
    // Load the user's notification prefs alongside the edit form so admins can
    // flip them in the same panel. Failures fall back to the "checked" default.
    void (async () => {
      const res = await api.get<{ emailEnabled: boolean; weeklyRecapEnabled: boolean }>(`/api/admin/users/${user.userId}/notification-prefs`)
      const next = {
        emailEnabled: res.data?.emailEnabled ?? true,
        weeklyRecapEnabled: res.data?.weeklyRecapEnabled ?? true,
      }
      setNotifPrefs(next)
      setNotifPrefsInitial(next)
    })()
  }

  async function submitEdit() {
    if (!editingUserId) return
    const { validateWorkWeek } = await import('../../../shared/schemas/workWeek.js')
    const wwErr = validateWorkWeek({
      workerType: editForm.workerType,
      workDays: editForm.workDays,
      workDayStartHour: editForm.workDayStartHour,
      workDayEndHour: editForm.workDayEndHour,
      workHoursPerDay: null,
    })
    if (wwErr) { setError(t(wwErr)); return }
    setSaving(editingUserId)
    setError(null)
    const payload: Record<string, unknown> = {
      ...editForm,
      // v1.127.0: send firstName/lastName as the primary name fields;
      // server recomposes displayName from them.
      firstName: editForm.firstName.trim() || undefined,
      lastName: editForm.lastName.trim() || undefined,
      defaultTeamId: editForm.defaultTeamId ? editForm.defaultTeamId : null,
    }
    // v1.317.0: isAppAdmin has no checkbox on this form anymore (removed
    // v1.94.0) — the per-team Role dropdown (changeRole()) is the sole
    // control for it now, syncing it server-side on every role change.
    // editForm.isAppAdmin is just a snapshot taken when this panel was
    // opened (openEdit(), hydrated from the `allUsers` directory), and that
    // directory isn't refetched by changeRole() — so the snapshot goes
    // stale the moment an admin demotes someone via the dropdown and then
    // saves ANY other field on this same already-open panel. Spreading it
    // back unconditionally silently resurrected the just-cleared isAppAdmin
    // flag. Only forward it when isDefaultAdmin is being explicitly
    // promoted here, which legitimately requires isAppAdmin: true.
    if (!editForm.isDefaultAdmin) delete payload['isAppAdmin']
    const res = await api.patch(`/api/admin/users/${editingUserId}`, payload)
    if (res.error) { setSaving(null); setError(res.error); return }
    // Persist notification prefs when the admin changed them. Independent
    // endpoint so the user save is not blocked by an unrelated failure here.
    if (notifPrefs.emailEnabled !== notifPrefsInitial.emailEnabled || notifPrefs.weeklyRecapEnabled !== notifPrefsInitial.weeklyRecapEnabled) {
      const prefRes = await api.put(`/api/admin/users/${editingUserId}/notification-prefs`, notifPrefs)
      if (prefRes.error) { setSaving(null); setError(prefRes.error); return }
    }
    if (editRole && editRole.value !== editRole.initial && teamId) {
      const roleRes = await api.patch(`/api/admin/teams/${teamId}/users/${editingUserId}/role`, { role: editRole.value })
      if (roleRes.error) { setSaving(null); setError(roleRes.error); return }
    }
    setSaving(null)
    setEditingUserId(null)
    await reload()
  }

  function openResetPassword(userId: string) {
    setResettingUserId(userId)
    setResetPassword('')
    setError(null)
  }

  async function submitResetPassword() {
    if (!resettingUserId) return
    const complexity = validatePasswordComplexity(resetPassword)
    if (!complexity.ok) { setError(`Password must satisfy: ${complexity.failedLabels.join(', ')}`); return }
    setSaving(resettingUserId)
    const res = await api.post(`/api/admin/users/${resettingUserId}/reset-password`, { password: resetPassword, mustChangePassword: true })
    setSaving(null)
    if (res.error) { setError(res.error); return }
    setResettingUserId(null)
    setResetPassword('')
    await reload()
  }

  // v1.425.0 (security audit L8): disabling blocks sign-in and revokes the
  // user's sessions and API keys; enabling restores sign-in only.
  async function setUserDisabled(userId: string, name: string, disable: boolean) {
    if (!window.confirm(t(disable ? 'admin.users.disable_confirm' : 'admin.users.enable_confirm', { name }))) return
    setSaving(userId)
    const res = await api.post(`/api/admin/users/${userId}/${disable ? 'disable' : 'enable'}`, {})
    setSaving(null)
    if (res.error) { setError(res.error); return }
    await reload()
  }

  async function resetMfa(userId: string, name: string) {
    if (!window.confirm(t('admin.users.reset_mfa_confirm', { name }))) return
    setSaving(userId)
    const res = await api.post(`/api/admin/users/${userId}/reset-mfa`, {})
    setSaving(null)
    if (res.error) { setError(res.error); return }
    await reload()
  }

  async function submitCreate() {
    const displayName = `${createForm.firstName.trim()} ${createForm.lastName.trim()}`.trim()
    if (!createForm.firstName.trim() || !createForm.lastName.trim() || !createForm.email.trim()) return
    // Password is only required when the account can use password login.
    if (authMethodNeedsPassword(createForm.authMethod)) {
      const complexity = validatePasswordComplexity(createForm.password)
      if (!complexity.ok) {
        setError(`Password must satisfy: ${complexity.failedLabels.join(', ')}`)
        return
      }
    }
    // Client-side work-week validation mirroring the server rules.
    const { validateWorkWeek } = await import('../../../shared/schemas/workWeek.js')
    const wwErr = validateWorkWeek({
      workerType: createForm.workerType,
      workDays: createForm.workDays,
      workDayStartHour: createForm.workDayStartHour,
      workDayEndHour: createForm.workDayEndHour,
      workHoursPerDay: null,
    })
    if (wwErr) { setError(t(wwErr)); return }
    setSaving('create')
    setError(null)
    const body: Record<string, unknown> = {
      displayName,
      email: createForm.email.trim(),
      mustChangePassword: createForm.mustChangePassword,
      authMethod: createForm.authMethod,
      canSeeAllTeams: createForm.canSeeAllTeams,
      supportedTeamIds: createForm.supportedTeamIds,
      workerType: createForm.workerType,
      workDays: createForm.workDays,
      workDayStartHour: createForm.workDayStartHour,
      workDayEndHour: createForm.workDayEndHour,
    }
    if (authMethodNeedsPassword(createForm.authMethod)) {
      body['password'] = createForm.password
    }
    body['sendWelcome'] = createForm.sendWelcome
    body['sendInvitation'] = createForm.sendInvitation
    // The selected team becomes the user's default team (even for admins,
    // who can still switch to "All Teams" from the sidebar).
    if (createForm.teamId) {
      body['teamId'] = createForm.teamId
      if (createForm.role !== 'none') body['role'] = createForm.role
    }
    const res = await api.post('/api/admin/users', body)
    setSaving(null)
    if (res.error) {
      setError(res.error)
      return
    }
    setCreatingUser(false)
    setCreateForm(emptyCreateForm)
    setTouchedFields(new Set())
    await reload()
  }

  // v1.318.0: extracted from the flat per-team member list so the "group by
  // default team" cross-team view (below) can reuse the exact same edit /
  // reset-password panels instead of duplicating ~230 lines of JSX. Neither
  // function depends on which list rendered the row — both gate purely on
  // editingUserId/resettingUserId matching the passed userId.
  function renderEditPanel(userId: string) {
    if (editingUserId !== userId) return null
    const missing = [
      !editForm.firstName.trim() && t('admin.users.first_name', 'First name'),
      !editForm.lastName.trim() && t('admin.users.last_name', 'Last name'),
      !editForm.email.trim() && t('admin.users.col_email'),
    ].filter((x): x is string => typeof x === 'string')
    const profileMissing = missing.length > 0
    const defaultTeamName = allTeams.find((tm) => tm.id === editForm.defaultTeamId)?.name ?? t('admin.users.no_default_team')
    const currentTeamName = allTeams.find((tm) => tm.id === teamId)?.name ?? ''
    const accessSummary = [
      editRole ? t(`admin.users.role_${editRole.value}`) : null,
      defaultTeamName,
      t(`admin.users.auth_method_${editForm.authMethod}`),
    ].filter(Boolean).join(' · ')
    const prefsSummary = [
      editForm.preferredCurrency ?? 'USD',
      notifPrefs.emailEnabled ? t('admin.users.sections.digest_on') : t('admin.users.sections.digest_off'),
      notifPrefs.weeklyRecapEnabled ? t('admin.users.sections.recap_on') : t('admin.users.sections.recap_off'),
    ].join(' · ')
    return (
      <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
        <div className="flex flex-col gap-2">
          <FormSectionsToolbar title={t('admin.users.edit')} state={editSections} />
          <FormSection
            id={`edit-profile-${userId}`} icon={User} color="indigo" title={t('admin.users.sections.profile')}
            summary={`${editForm.displayName} · ${editForm.email}`}
            status={profileMissing ? { kind: 'missing', label: t('admin.users.sections.required_missing') } : { kind: 'done', label: t('admin.users.sections.required_done') }}
            open={editSections.isOpen('profile') || profileMissing} onToggle={() => editSections.toggle('profile')}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <FieldLabel required>{t('admin.users.first_name', 'First name')}</FieldLabel>
                <Input
                  value={editForm.firstName}
                  required
                  onChange={(e) => {
                    const firstName = e.target.value
                    setEditForm((f) => ({ ...f, firstName, displayName: `${firstName.trim()} ${f.lastName.trim()}`.trim() }))
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel required>{t('admin.users.last_name', 'Last name')}</FieldLabel>
                <Input
                  value={editForm.lastName}
                  required
                  onChange={(e) => {
                    const lastName = e.target.value
                    setEditForm((f) => ({ ...f, lastName, displayName: `${f.firstName.trim()} ${lastName.trim()}`.trim() }))
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel required>{t('admin.users.col_email')}</FieldLabel>
                <Input type="email" required value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
          </FormSection>

          <FormSection
            id={`edit-access-${userId}`} icon={ShieldCheck} color="violet" title={t('admin.users.sections.access')}
            summary={accessSummary}
            open={editSections.isOpen('access')} onToggle={() => editSections.toggle('access')}
          >
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {editRole && (
                  <div className="flex flex-col gap-1">
                    <FieldLabel>{t('admin.users.sections.role_on_team', { team: currentTeamName })}</FieldLabel>
                    <Select value={editRole.value} onChange={(e) => setEditRole((r) => (r ? { ...r, value: e.target.value } : r))}>
                      <option value="contributor">{t('admin.users.role_contributor')}</option>
                      <option value="leader">{t('admin.users.role_leader')}</option>
                      <option value="team_admin">{t('admin.users.role_team_admin')}</option>
                      {(viewerIsAppAdmin || editRole.initial === 'admin') && <option value="admin">{t('admin.users.role_admin')}</option>}
                    </Select>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <FieldLabel>{t('admin.users.col_default_team')}</FieldLabel>
                  <Select value={editForm.defaultTeamId} onChange={(e) => setEditForm((f) => ({ ...f, defaultTeamId: e.target.value }))}>
                    <option value="">{t('admin.users.no_default_team')}</option>
                    {allTeams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <FieldLabel>{t('admin.users.auth_method')}</FieldLabel>
                  <Select value={editForm.authMethod} onChange={(e) => setEditForm((f) => ({ ...f, authMethod: e.target.value as AuthMethod }))}>
                    <option value="both">{t('admin.users.auth_method_both')}</option>
                    <option value="password">{t('admin.users.auth_method_password')}</option>
                    <option value="okta">{t('admin.users.auth_method_okta')}</option>
                    <option value="azure">{t('admin.users.auth_method_azure')}</option>
                  </Select>
                </div>
              </div>
              {renderSupportedTeams(editForm.canSeeAllTeams, editForm.supportedTeamIds, editForm.defaultTeamId, (canSeeAllTeams, supportedTeamIds) => setEditForm((f) => ({ ...f, canSeeAllTeams, supportedTeamIds })))}
              {/* v1.94.0: the App Admin checkbox was redundant — the Role
                  dropdown's "Admin" option syncs is_app_admin server-side.
                  The default-admin toggle stays: it's a distinct, non-role
                  concept (the original installer's admin that can't be demoted). */}
              <FormSubheading>{t('admin.users.sections.security')}</FormSubheading>
              <div className="grid grid-cols-1 gap-2 text-xs text-gray-700 sm:grid-cols-2 dark:text-gray-300">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={editForm.mustChangePassword} onChange={(e) => setEditForm((f) => ({ ...f, mustChangePassword: e.target.checked }))} className="h-4 w-4" />
                  {t('admin.users.must_change_password')}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={editForm.isDefaultAdmin} onChange={(e) => setEditForm((f) => ({ ...f, isDefaultAdmin: e.target.checked, isAppAdmin: e.target.checked || f.isAppAdmin }))} className="h-4 w-4" />
                  {t('admin.users.is_default_admin')}
                </label>
              </div>
            </div>
          </FormSection>

          <FormSection
            id={`edit-crm-${userId}`} icon={Cloud} color="sky" title={t('admin.users.sections.crm')}
            summary={editForm.crmUserId ? t('admin.users.sections.crm_linked', { name: editForm.sfUserName || editForm.crmUserId }) : t('admin.users.sections.crm_not_linked')}
            open={editSections.isOpen('crm')} onToggle={() => editSections.toggle('crm')}
          >
            <SfUserPicker
              bare
              value={editForm.crmUserId ? { id: editForm.crmUserId, name: editForm.sfUserName ?? '' } : null}
              onChange={(picked) => setEditForm((f) => ({
                ...f,
                crmUserId: picked?.id ?? null,
                sfUserName: picked?.name ?? null,
              }))}
              t={t}
            />
            {editForm.crmUserId && (
              <SfUserDetails userId={userId} crmUserId={editForm.crmUserId} t={t} />
            )}
          </FormSection>

          <FormSection
            id={`edit-subteams-${userId}`} icon={Layers} color="teal" title={t('admin.users.subteams_label')}
            summary={t('admin.users.subteam_limit', 'Up to 4 subteams')}
            open={editSections.isOpen('subteams')} onToggle={() => editSections.toggle('subteams')}
          >
            <UserSubteamsSection bare userId={userId} t={t} />
          </FormSection>

          <FormSection
            id={`edit-week-${userId}`} icon={Clock} color="emerald" title={t('admin.users.work_week')}
            summary={workWeekSummary(editForm)}
            open={editSections.isOpen('week')} onToggle={() => editSections.toggle('week')}
          >
            {renderWorkWeekFields(editForm, (patch) => setEditForm((f) => ({ ...f, ...patch })))}
          </FormSection>

          <FormSection
            id={`edit-prefs-${userId}`} icon={Bell} color="amber" title={t('admin.users.sections.prefs')}
            summary={prefsSummary}
            open={editSections.isOpen('prefs')} onToggle={() => editSections.toggle('prefs')}
          >
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {/* v1.76.0: display currency, per user. Kept in sync with
                    My Settings: both write users.preferred_currency. */}
                <div className="flex flex-col gap-1">
                  <FieldLabel>{t('admin.users.preferred_currency_label')}</FieldLabel>
                  <Select
                    value={editForm.preferredCurrency ?? 'USD'}
                    onChange={(e) => setEditForm((f) => ({ ...f, preferredCurrency: e.target.value === 'USD' ? null : e.target.value }))}
                  >
                    <option value="USD">USD — US Dollar (default)</option>
                    {CURRENCIES.filter((c) => c.code !== 'USD').map((c) => (
                      <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                    ))}
                  </Select>
                  <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.users.preferred_currency_hint')}</p>
                </div>
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <FieldLabel>{t('admin.users.notifications.title')}</FieldLabel>
                  <div className="flex flex-col gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={notifPrefs.emailEnabled} onChange={(e) => setNotifPrefs((p) => ({ ...p, emailEnabled: e.target.checked }))} className="h-4 w-4" />
                      {t('admin.users.notifications.email_enabled')}
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={notifPrefs.weeklyRecapEnabled} onChange={(e) => setNotifPrefs((p) => ({ ...p, weeklyRecapEnabled: e.target.checked }))} className="h-4 w-4" />
                      {t('admin.users.notifications.weekly_recap_enabled')}
                    </label>
                  </div>
                </div>
              </div>
              <p className="flex flex-wrap items-center gap-1.5 rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                <CircleDollarSign className="h-3.5 w-3.5 shrink-0" />
                <span>{t('admin.users.cost_rate_moved', 'Hourly cost is managed in Cost Groups. Assigned to this user\'s team as a cost group. A per-user override can be entered there.')}</span>
                <Link to="/admin?section=cost_groups" className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  {t('admin.users.sections.open_cost_groups')}<ArrowRight className="h-3 w-3" />
                </Link>
              </p>
            </div>
          </FormSection>

          <FormSaveBar missing={missing}>
            <Button variant="ghost" size="sm" onClick={() => { setEditingUserId(null); setError(null) }}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
            <Button size="sm" onClick={submitEdit} disabled={saving === editingUserId || missing.length > 0}>
              {saving === editingUserId ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}{t('common.save')}
            </Button>
          </FormSaveBar>
        </div>
      </div>
    )
  }

  // Supported Teams block, shared by the edit and create forms.
  function renderSupportedTeams(canSeeAllTeams: boolean, supportedTeamIds: string[], excludeTeamId: string, onChange: (canSeeAllTeams: boolean, supportedTeamIds: string[]) => void) {
    return (
      <>
        <FormSubheading>{t('admin.users.supported_teams')}</FormSubheading>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={canSeeAllTeams}
            onChange={(e) => onChange(e.target.checked, e.target.checked ? allTeams.map((tm) => tm.id) : supportedTeamIds)}
            className="h-4 w-4"
          />
          <span className="font-semibold">{t('admin.users.all_teams_master')}</span>
        </label>
        <div className="grid grid-cols-1 gap-1.5 pl-1 sm:grid-cols-3">
          {allTeams.filter((tm) => tm.id !== excludeTeamId).map((tm) => (
            <label key={tm.id} className="flex cursor-pointer items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={supportedTeamIds.includes(tm.id)}
                onChange={(e) => onChange(canSeeAllTeams, e.target.checked ? [...supportedTeamIds, tm.id] : supportedTeamIds.filter((id) => id !== tm.id))}
                className="h-4 w-4"
              />
              {tm.name}
            </label>
          ))}
        </div>
      </>
    )
  }

  function workWeekSummary(w: { workerType: WorkerType; workDays: number; workDayStartHour: number; workDayEndHour: number }): string {
    const days = DAY_BITS_UM.filter((d) => (w.workDays & d.bit) !== 0).map((d) => t(`settings.work_week.days.${d.key}`)).join(', ')
    return [
      t(`admin.users.worker_type_${w.workerType}`),
      days || '—',
      `${String(w.workDayStartHour).padStart(2, '0')}:00–${String(w.workDayEndHour).padStart(2, '0')}:00`,
    ].join(' · ')
  }

  // Work week fields, shared by the edit and create forms. `onField` lets the
  // create form mark a field as touched so a team pick won't overwrite it.
  function renderWorkWeekFields(
    w: { workerType: WorkerType; workDays: number; workDayStartHour: number; workDayEndHour: number },
    onChange: (patch: Partial<{ workerType: WorkerType; workDays: number; workDayStartHour: number; workDayEndHour: number }>) => void,
    onField?: (field: string) => void,
  ) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.6fr_0.8fr_0.8fr]">
        <div className="flex flex-col gap-1">
          <FieldLabel>{t('admin.users.worker_type_label')}</FieldLabel>
          <Select value={w.workerType} onChange={(e) => { onField?.('workerType'); onChange({ workerType: e.target.value as WorkerType }) }}>
            <option value="full_time">{t('admin.users.worker_type_full_time')}</option>
            <option value="part_time">{t('admin.users.worker_type_part_time')}</option>
            <option value="contractor">{t('admin.users.worker_type_contractor')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <FieldLabel>{t('admin.users.work_days')}</FieldLabel>
          <div className="flex flex-wrap gap-1">
            {DAY_BITS_UM.map((d) => {
              const on = (w.workDays & d.bit) !== 0
              return (
                <button
                  key={d.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => { onField?.('workDays'); onChange({ workDays: on ? w.workDays & ~d.bit : w.workDays | d.bit }) }}
                  className={'rounded border px-2 py-1 text-[11px] ' + (on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-gray-600 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300')}
                >{t(`settings.work_week.days.${d.key}`)}</button>
              )
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <FieldLabel>{t('admin.users.day_start')}</FieldLabel>
          <Select value={String(w.workDayStartHour)} onChange={(e) => { onField?.('workDayStartHour'); onChange({ workDayStartHour: Number(e.target.value) }) }}>
            {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <FieldLabel>{t('admin.users.day_end')}</FieldLabel>
          <Select value={String(w.workDayEndHour)} onChange={(e) => { onField?.('workDayEndHour'); onChange({ workDayEndHour: Number(e.target.value) }) }}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </Select>
        </div>
      </div>
    )
  }

  function renderResetPasswordPanel(userId: string) {
    if (resettingUserId !== userId) return null
    return (
      <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{t('admin.users.reset_password')}</p>
        <div className="flex flex-col gap-1">
          <Label>{t('admin.users.new_password')}</Label>
          <Input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} />
          <ul className="mt-1 flex flex-col gap-0.5 text-[10px] text-gray-500 dark:text-gray-400">
            {PASSWORD_RULES.map((r) => {
              const passed = r.test(resetPassword)
              return (
                <li key={r.key} className={passed ? 'text-green-600 dark:text-green-400' : ''}>
                  {passed ? <Check className="mr-1 inline h-3 w-3" /> : <X className="mr-1 inline h-3 w-3" />}
                  {r.label}
                </li>
              )
            })}
          </ul>
        </div>
        <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">{t('admin.users.reset_password_hint')}</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={submitResetPassword} disabled={saving === resettingUserId || !validatePasswordComplexity(resetPassword).ok}>
            {saving === resettingUserId && <Spinner className="mr-1 h-3 w-3" />}
            {t('admin.users.reset_password')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setResettingUserId(null); setResetPassword(''); setError(null) }}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
        </div>
      </div>
    )
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>

  const memberIds = new Set(users.map((u) => u.userId))
  const candidates = allUsers.filter((u) => !memberIds.has(u.id))

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{translateServerError(t, i18n, error)}</span>
        </div>
      )}

      <details open className="rounded-lg border border-amber-200 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20">
        <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
          {t('admin.approvals.title')} <span className="ml-1 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">{approvals.length}</span>
        </summary>
        <div className="border-t border-amber-200 px-4 py-3 dark:border-amber-800">
          <p className="mb-2 text-xs text-amber-900/80 dark:text-amber-200/80">{t('admin.approvals.description')}</p>
          {approvals.length === 0 ? (
            <p className="py-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.approvals.empty')}</p>
          ) : approvals.map((r) => {
            const b = r.beforeSnapshot; const a = r.afterSnapshot
            return (
              <div key={r.id} className="mb-2 rounded-md border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-900">
                <div className="mb-1 flex items-center justify-between">
                  <div>
                    <span className="font-medium text-gray-900 dark:text-gray-100">{r.userDisplayName ?? r.userEmail ?? r.userId}</span>
                    <span className="ml-2 text-gray-500 dark:text-gray-400">{t('admin.approvals.when_requested', { when: new Date(r.createdAt).toLocaleString() })}</span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => approveRequest(r.id)} className="rounded bg-green-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-green-700">{t('admin.approvals.approve')}</button>
                    <button onClick={() => { setRejectingId(rejectingId === r.id ? null : r.id); setRejectNote('') }} className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">{t('admin.approvals.reject')}</button>
                  </div>
                </div>
                <div className="grid grid-cols-[120px_1fr_1fr] gap-2 text-[11px]">
                  <span className="font-semibold text-gray-500 dark:text-gray-400">{t('admin.approvals.view_diff')}</span>
                  <span className="text-gray-500 dark:text-gray-400">Before</span>
                  <span className="text-gray-500 dark:text-gray-400">After</span>
                  <span className="text-gray-600 dark:text-gray-300">{t('admin.approvals.diff.worker_type')}</span>
                  <span>{t(`settings.worker_type.${b.workerType}`)}</span>
                  <span className="font-medium">{t(`settings.worker_type.${a.workerType}`)}</span>
                  <span className="text-gray-600 dark:text-gray-300">{t('admin.approvals.diff.days')}</span>
                  <span>{daysMaskLabel(b.workDays)}</span>
                  <span className="font-medium">{daysMaskLabel(a.workDays)}</span>
                  <span className="text-gray-600 dark:text-gray-300">{t('admin.approvals.diff.hours')}</span>
                  <span>{`${String(b.workDayStartHour).padStart(2,'0')}:00 → ${String(b.workDayEndHour).padStart(2,'0')}:00`}</span>
                  <span className="font-medium">{`${String(a.workDayStartHour).padStart(2,'0')}:00 → ${String(a.workDayEndHour).padStart(2,'0')}:00`}</span>
                  {(b.workHoursPerDay || a.workHoursPerDay) && (
                    <>
                      <span className="text-gray-600 dark:text-gray-300">{t('admin.approvals.diff.per_day')}</span>
                      <span className="truncate">{b.workHoursPerDay ? Object.entries(b.workHoursPerDay).map(([k,v]) => `${k} ${v.start}-${v.end}`).join(', ') : '—'}</span>
                      <span className="truncate font-medium">{a.workHoursPerDay ? Object.entries(a.workHoursPerDay).map(([k,v]) => `${k} ${v.start}-${v.end}`).join(', ') : '—'}</span>
                    </>
                  )}
                </div>
                {rejectingId === r.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <Input placeholder={t('admin.approvals.reject_note_prompt')} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} className="text-xs" />
                    <Button size="sm" onClick={() => rejectRequest(r.id)}>{t('admin.approvals.reject')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setRejectingId(null); setRejectNote('') }}>{t('common.cancel')}</Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </details>

      {creatingUser && (() => {
        const needsPassword = authMethodNeedsPassword(createForm.authMethod)
        const passwordOk = !needsPassword || validatePasswordComplexity(createForm.password).ok
        const createMissing = [
          !createForm.firstName.trim() && t('admin.users.first_name'),
          !createForm.lastName.trim() && t('admin.users.last_name'),
          !createForm.email.trim() && t('admin.users.col_email'),
          !passwordOk && t('admin.users.password'),
        ].filter((x): x is string => typeof x === 'string')
        const createTeamName = allTeams.find((tm) => tm.id === createForm.teamId)?.name ?? t('admin.users.role_none')
        return (
          <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
            <FormSectionsToolbar title={t('admin.users.create_user')} state={createSections} />
            <FormSection
              id="create-profile" icon={User} color="indigo" title={t('admin.users.sections.profile_signin')}
              summary={[`${createForm.firstName} ${createForm.lastName}`.trim(), createForm.email, t(`admin.users.auth_method_${createForm.authMethod}`)].filter(Boolean).join(' · ')}
              status={createMissing.length > 0 ? { kind: 'missing', label: t('admin.users.sections.required_missing') } : { kind: 'done', label: t('admin.users.sections.required_done') }}
              open={createSections.isOpen('profile') || createMissing.length > 0} onToggle={() => createSections.toggle('profile')}
            >
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <FieldLabel required>{t('admin.users.first_name')}</FieldLabel>
                    <Input required value={createForm.firstName} onChange={(e) => setCreateForm((f) => ({ ...f, firstName: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <FieldLabel required>{t('admin.users.last_name')}</FieldLabel>
                    <Input required value={createForm.lastName} onChange={(e) => setCreateForm((f) => ({ ...f, lastName: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <FieldLabel required>{t('admin.users.col_email')}</FieldLabel>
                    <Input type="email" required value={createForm.email} onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))} />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <FieldLabel>{t('admin.users.auth_method')}</FieldLabel>
                    <Select value={createForm.authMethod} onChange={(e) => setCreateForm((f) => ({ ...f, authMethod: e.target.value as AuthMethod }))}>
                      <option value="both">{t('admin.users.auth_method_both')}</option>
                      <option value="password">{t('admin.users.auth_method_password')}</option>
                      <option value="okta">{t('admin.users.auth_method_okta')}</option>
                      <option value="azure">{t('admin.users.auth_method_azure')}</option>
                    </Select>
                  </div>
                  {needsPassword && (
                    <div className="flex flex-col gap-1 sm:col-span-2">
                      <FieldLabel required>{t('admin.users.password')}</FieldLabel>
                      <Input type="password" required value={createForm.password} onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))} />
                      <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.users.sections.password_required_hint')}</p>
                      <ul className="mt-1 grid grid-cols-1 gap-0.5 text-[10px] text-gray-500 sm:grid-cols-2 dark:text-gray-400">
                        {PASSWORD_RULES.map((r) => {
                          const passed = r.test(createForm.password)
                          return (
                            <li key={r.key} className={passed ? 'text-green-600 dark:text-green-400' : ''}>
                              {passed ? <Check className="mr-1 inline h-3 w-3" /> : <X className="mr-1 inline h-3 w-3" />}
                              {r.label}
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </FormSection>

            <FormSection
              id="create-access" icon={ShieldCheck} color="violet" title={t('admin.users.sections.team_access')}
              summary={[createTeamName, createForm.role !== 'none' ? t(`admin.users.role_${createForm.role}`) : null].filter(Boolean).join(' · ')}
              open={createSections.isOpen('access')} onToggle={() => createSections.toggle('access')}
            >
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <FieldLabel optional>{t('admin.users.col_team')}</FieldLabel>
                    <Select value={createForm.teamId} onChange={(e) => {
                      const newTeamId = e.target.value
                      const team = allTeams.find((tm) => tm.id === newTeamId)
                      setCreateForm((f) => {
                        const next = { ...f, teamId: newTeamId }
                        if (team) {
                          if (!touchedFields.has('workerType') && team.defaultWorkerType) next.workerType = team.defaultWorkerType
                          if (!touchedFields.has('workDays') && team.defaultWorkDays !== undefined) next.workDays = team.defaultWorkDays
                          if (!touchedFields.has('workDayStartHour') && team.defaultWorkDayStartHour !== undefined) next.workDayStartHour = team.defaultWorkDayStartHour
                          if (!touchedFields.has('workDayEndHour') && team.defaultWorkDayEndHour !== undefined) next.workDayEndHour = team.defaultWorkDayEndHour
                        }
                        return next
                      })
                    }}>
                      <option value="">{t('admin.users.role_none')}</option>
                      {allTeams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                    </Select>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('admin.users.sections.team_later_hint')}</p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <FieldLabel>{t('admin.users.col_role')}</FieldLabel>
                    <Select value={createForm.role} onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as PickerRole }))}>
                      <option value="none">{t('admin.users.role_none')}</option>
                      <option value="contributor">{t('admin.users.role_contributor')}</option>
                      <option value="leader">{t('admin.users.role_leader')}</option>
                      <option value="team_admin">{t('admin.users.role_team_admin')}</option>
                      {viewerIsAppAdmin && <option value="admin">{t('admin.users.role_admin')}</option>}
                    </Select>
                  </div>
                </div>
                {renderSupportedTeams(createForm.canSeeAllTeams, createForm.supportedTeamIds, createForm.teamId, (canSeeAllTeams, supportedTeamIds) => setCreateForm((f) => ({ ...f, canSeeAllTeams, supportedTeamIds })))}
                <FormSubheading>{t('admin.users.sections.security')}</FormSubheading>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={createForm.mustChangePassword}
                    onChange={(e) => setCreateForm((f) => ({ ...f, mustChangePassword: e.target.checked }))}
                    className="h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
                  />
                  {t('admin.users.must_change_password')}
                </label>
              </div>
            </FormSection>

            <FormSection
              id="create-week" icon={Clock} color="emerald" title={t('admin.users.work_week')}
              summary={workWeekSummary(createForm)}
              open={createSections.isOpen('week')} onToggle={() => createSections.toggle('week')}
            >
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.users.sections.week_from_team')}</p>
                {renderWorkWeekFields(createForm, (patch) => setCreateForm((f) => ({ ...f, ...patch })), markTouched)}
              </div>
            </FormSection>

            {/* v1.115.0: opt-in emails at create. Invitation supersedes
                welcome (invitation carries the credentials + will force
                password change on first sign-in). */}
            <FormSection
              id="create-welcome" icon={Send} color="rose" title={t('admin.users.sections.welcome')}
              summary={createForm.sendInvitation ? t('admin.users.send_invitation') : createForm.sendWelcome ? t('admin.users.send_welcome') : t('admin.users.sections.no_email')}
              open={createSections.isOpen('welcome')} onToggle={() => createSections.toggle('welcome')}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={createForm.sendInvitation}
                    onChange={(e) => setCreateForm((f) => ({ ...f, sendInvitation: e.target.checked, sendWelcome: e.target.checked ? false : f.sendWelcome }))}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
                  />
                  <span>
                    <span className="block font-medium">{t('admin.users.send_invitation')}</span>
                    <span className="block text-[11px] text-gray-500 dark:text-gray-400">{t('admin.users.send_invitation_hint')}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={createForm.sendWelcome}
                    disabled={createForm.sendInvitation}
                    onChange={(e) => setCreateForm((f) => ({ ...f, sendWelcome: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-600"
                  />
                  <span>
                    <span className="block font-medium">{t('admin.users.send_welcome')}</span>
                    <span className="block text-[11px] text-gray-500 dark:text-gray-400">{t('admin.users.send_welcome_hint')}</span>
                  </span>
                </label>
              </div>
            </FormSection>

            <FormSaveBar missing={createMissing}>
              <Button variant="ghost" size="sm" onClick={() => { setCreatingUser(false); setCreateForm(emptyCreateForm); setTouchedFields(new Set()); setError(null) }}><X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}</Button>
              <Button size="sm" onClick={submitCreate} disabled={saving === 'create' || createMissing.length > 0}>
                {saving === 'create' ? <Spinner className="mr-1 h-3 w-3" /> : <UserPlus className="mr-1 h-3.5 w-3.5" />}{t('admin.users.create_user')}
              </Button>
            </FormSaveBar>
          </div>
        )
      })()}

      {!globalView && (adding ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <p className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
            {t('admin.users.add_member')}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Select value={pickerUserId} onChange={(e) => setPickerUserId(e.target.value)} className="flex-1 text-sm">
              <option value="">{t('admin.users.select_user')}</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>{u.displayName} — {u.email}</option>
              ))}
            </Select>
            <Select value={pickerRole} onChange={(e) => setPickerRole(e.target.value as PickerRole)} className="w-40 text-sm">
              <option value="none">{t('admin.users.role_none')}</option>
              <option value="contributor">{t('admin.users.role_contributor')}</option>
              <option value="leader">{t('admin.users.role_leader')}</option>
              <option value="team_admin">{t('admin.users.role_team_admin')}</option>
              {viewerIsAppAdmin && <option value="admin">{t('admin.users.role_admin')}</option>}
            </Select>
            <Button size="sm" onClick={addMember} disabled={!pickerUserId || saving === 'add'}>
              {saving === 'add' && <Spinner className="mr-1 h-3 w-3" />}
              <Save className="mr-1 h-3.5 w-3.5" />{t('common.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setError(null) }}>
              <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
            </Button>
          </div>
          {candidates.length === 0 && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.users.no_candidates')}</p>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {users.length} {t('admin.users.count')}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setCreatingUser(true); setError(null) }}>
              <UserPlus className="h-4 w-4" />
              {t('admin.users.create_user')}
            </Button>
            <Button size="sm" onClick={() => { setAdding(true); setError(null) }}>
              <Plus className="h-4 w-4" />
              {t('admin.users.add_member')}
            </Button>
          </div>
        </div>
      ))}

      {/* v1.318.0: cross-team ("All Teams") mode has no single team to add an
          existing user TO or "+ Add Member" against — only Create New User
          (which already carries its own team picker) makes sense here. */}
      {globalView && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {allUsers.length} {t('admin.users.count')}
          </p>
          <Button variant="secondary" size="sm" onClick={() => { setCreatingUser(true); setError(null) }}>
            <UserPlus className="h-4 w-4" />
            {t('admin.users.create_user')}
          </Button>
        </div>
      )}

      {!globalView && (
      <div className="flex flex-col gap-1">
        <div className="mb-2 grid grid-cols-[1fr_180px_90px_220px_140px_130px_130px_140px_200px] gap-6 px-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
          <span>{t('admin.users.col_user')}</span>
          <span>{t('admin.users.col_sf_user', { context: crmCtx })}</span>
          <span>{t('admin.users.col_connections', 'Connections')}</span>
          <span>{t('admin.users.col_email')}</span>
          <span>{t('admin.users.col_default_team')}</span>
          <span>{t('admin.users.col_last_login', 'Last Logged In')}</span>
          <span>{t('admin.users.col_password_reset', 'Password Reset')}</span>
          <span>{t('admin.users.col_role')}</span>
          <span></span>
        </div>
        {users.map((user) => {
          const dir = allUsers.find((u) => u.id === user.userId)
          return (
          <div key={user.userId} className="flex flex-col rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div className="grid grid-cols-[1fr_180px_90px_220px_140px_130px_130px_140px_200px] items-center gap-6 px-3 py-2">
              <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                {user.displayName}
                {user.isDefaultAdmin && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    {t('admin.users.default_admin_badge')}
                  </span>
                )}
                {dir?.disabledAt && <DisabledBadge t={t} />}
              </span>
              <span className="truncate text-xs text-gray-600 dark:text-gray-300" title={dir?.crmUserId ?? undefined}>
                {dir?.sfUserName
                  ? (
                    <span className="inline-flex items-center gap-1">
                      <Cloud className="h-3 w-3 text-blue-500 dark:text-blue-400" />
                      <span className="truncate">{dir.sfUserName}</span>
                    </span>
                  )
                  : <span className="italic text-gray-400 dark:text-gray-500">{t('admin.users.sf_user_unlinked')}</span>}
              </span>
              <span className="flex items-center gap-2">
                <ConnectionIcon
                  icon={Cloud}
                  label={t('settings.connections.salesforce_name', 'Salesforce')}
                  connected={dir?.sfConnected ?? false}
                  connectedAt={dir?.sfConnectedAt}
                  accountLabel={dir?.sfAccountLabel}
                  verifying={!!verifying[`${user.userId}:salesforce`]}
                  verifyResult={verifyResults[`${user.userId}:salesforce`]}
                  onVerify={() => verifyConnection(user.userId, 'salesforce')}
                  t={t}
                />
                <ConnectionIcon
                  icon={CalendarDays}
                  label={t('settings.connections.outlook_name', 'Outlook')}
                  connected={dir?.outlookConnected ?? false}
                  connectedAt={dir?.outlookConnectedAt}
                  accountLabel={dir?.outlookAccountLabel}
                  verifying={!!verifying[`${user.userId}:microsoft`]}
                  verifyResult={verifyResults[`${user.userId}:microsoft`]}
                  onVerify={() => verifyConnection(user.userId, 'microsoft')}
                  t={t}
                />
              </span>
              <span className="truncate text-xs text-gray-500 dark:text-gray-400">{user.email}</span>
              <span className="truncate text-xs text-gray-600 dark:text-gray-400">{user.defaultTeamName ?? '—'}</span>
              <span className="truncate text-xs text-gray-500 dark:text-gray-400">{formatLastLogin(dir?.lastLoginAt, t)}</span>
              {(() => {
                const status = passwordResetStatus(dir?.authMethod, dir?.passwordChangedAt, t)
                return status
                  ? <span className={cn('truncate text-xs', status.overdue ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>{status.label}</span>
                  : <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
              })()}
              <Select
                value={user.role}
                onChange={(e) => changeRole(user.userId, e.target.value)}
                disabled={saving === user.userId}
                className="text-xs"
              >
                <option value="contributor">{t('admin.users.role_contributor')}</option>
                <option value="leader">{t('admin.users.role_leader')}</option>
                <option value="team_admin">{t('admin.users.role_team_admin')}</option>
                {viewerIsAppAdmin && <option value="admin">{t('admin.users.role_admin')}</option>}
                <option value="none">{t('admin.users.role_none')}</option>
              </Select>
              <div className="flex justify-end gap-2">
                {(() => {
                  const dir = allUsers.find((u) => u.id === user.userId)
                  const enrolled = !!dir?.totpEnrolledAt
                  const codesRemaining = dir?.backupCodesRemaining ?? 0
                  const depleted = enrolled && codesRemaining === 0
                  const hint = depleted
                    ? t('admin.users.mfa_depleted_hint')
                    : enrolled
                    ? t('admin.users.mfa_enrolled_hint', { when: new Date(dir!.totpEnrolledAt!).toLocaleDateString() }) + ` · ${t('admin.users.mfa_codes_remaining', { count: codesRemaining })}`
                    : t('admin.users.mfa_not_enrolled_hint')
                  return (
                    <button
                      onClick={() => enrolled && resetMfa(user.userId, user.displayName)}
                      disabled={!enrolled || saving === user.userId}
                      title={hint}
                      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium ${
                        depleted
                          ? 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300'
                          : enrolled
                          ? 'bg-green-100 text-green-800 hover:bg-red-100 hover:text-red-700 dark:bg-green-900/40 dark:text-green-300'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                      }`}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {depleted
                        ? t('admin.users.mfa_locked')
                        : enrolled
                        ? `${t('admin.users.mfa_on')} · ${codesRemaining}`
                        : t('admin.users.mfa_off')}
                    </button>
                  )
                })()}
                <button
                  onClick={() => openEdit(user)}
                  className="rounded p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                  title={t('admin.users.edit')}
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => openResetPassword(user.userId)}
                  className="rounded p-1.5 text-gray-400 hover:text-amber-600 dark:hover:text-amber-400"
                  title={t('admin.users.reset_password')}
                >
                  <KeyRound className="h-4 w-4" />
                </button>
                {viewerIsAppAdmin && !user.isDefaultAdmin && user.userId !== viewer?.id && (
                  dir?.disabledAt ? (
                    <button
                      onClick={() => { void setUserDisabled(user.userId, user.displayName, false) }}
                      disabled={saving === user.userId}
                      className="rounded p-1.5 text-gray-400 hover:text-green-600 disabled:opacity-50 dark:hover:text-green-400"
                      title={t('admin.users.enable_user')}
                      aria-label={t('admin.users.enable_user')}
                    >
                      <UserCheck className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => { void setUserDisabled(user.userId, user.displayName, true) }}
                      disabled={saving === user.userId}
                      className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                      title={t('admin.users.disable_user')}
                      aria-label={t('admin.users.disable_user')}
                    >
                      <UserX className="h-4 w-4" />
                    </button>
                  )
                )}
                {!user.isDefaultAdmin && (
                  <button
                    onClick={() => removeUser(user)}
                    disabled={saving === user.userId}
                    className="rounded p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {renderEditPanel(user.userId)}
            {renderResetPasswordPanel(user.userId)}
          </div>
          )
        })}
        {users.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('admin.users.empty')}</p>
        )}
      </div>
      )}

      {globalView && (
        <GroupedByDefaultTeamView
          allUsers={allUsers}
          allTeams={allTeams}
          t={t}
          openEdit={openEdit}
          openResetPassword={openResetPassword}
          resetMfa={resetMfa}
          renderEditPanel={renderEditPanel}
          renderResetPasswordPanel={renderResetPasswordPanel}
          saving={saving}
          reload={reload}
          viewerIsAppAdmin={viewerIsAppAdmin}
        />
      )}
    </div>
  )
}

interface SfUserOption { id: string; name: string; email?: string | null; isActive?: boolean }

// Small combobox that searches the CRM's people (Salesforce Users, or
// HubSpot owners). Cached lookups hit the crm_users table; a Refresh button
// forces a fresh read from the CRM. Bound to editForm.crmUserId / sfUserName
// in the parent.
// Shows the linked SF User's Title and Manager (both pulled from
// Salesforce via /api/admin/users/:userId/sf-details, cached in
// crm_users), or on HubSpot the owner's HubSpot teams (HubSpot owners have
// no Title or Manager). Rendered directly below SfUserPicker when a link
// exists.
interface CrmUserDetails { title: string | null; managerName: string | null; managerId: string | null; teams?: string[] }
function SfUserDetails({ userId, crmUserId, t }: { userId: string; crmUserId: string; t: ReturnType<typeof useTranslation>['t'] }) {
  const crmCtx = useCrmLabelContext()
  const [state, setState] = useState<CrmUserDetails | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.get<CrmUserDetails>(`/api/admin/users/${userId}/sf-details`).then((res) => {
      if (cancelled) return
      setState(res.data ?? { title: null, managerName: null, managerId: null })
      setLoading(false)
    })
    return () => { cancelled = true }
    // crmUserId change re-fetches (admin picked a different SF user)
  }, [userId, crmUserId])
  if (loading) return <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Spinner className="h-3 w-3" /> {t('admin.users.sf_details_loading')}</div>
  if (!state) return null
  if (state.teams) {
    return (
      <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <Users className="mr-1 inline h-3 w-3" />
          {t('admin.users.crm_teams_label', { context: crmCtx })}
        </p>
        {state.teams.length > 0 ? (
          <p className="mt-0.5 text-sm text-gray-800 dark:text-gray-100">{state.teams.join(', ')}</p>
        ) : (
          <p className="mt-0.5 text-[11px] italic text-gray-500 dark:text-gray-400">{t('admin.users.crm_teams_empty', { context: crmCtx })}</p>
        )}
      </div>
    )
  }
  const nothing = !state.title && !state.managerName
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('admin.users.sf_title_label')}
        </p>
        <p className="mt-0.5 text-sm text-gray-800 dark:text-gray-100">{state.title ?? '—'}</p>
      </div>
      <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('admin.users.sf_manager_label')}
        </p>
        <p className="mt-0.5 text-sm text-gray-800 dark:text-gray-100">{state.managerName ?? '—'}</p>
      </div>
      {nothing && (
        <p className="col-span-2 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t('admin.users.sf_details_empty')}
        </p>
      )}
    </div>
  )
}

function SfUserPicker({ value, onChange, t, bare }: { value: { id: string; name: string } | null; onChange: (v: SfUserOption | null) => void; t: ReturnType<typeof useTranslation>['t']; bare?: boolean }) {
  const crmCtx = useCrmLabelContext()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<SfUserOption[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q), 200)
    return () => clearTimeout(h)
  }, [q])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
    void api.get<SfUserOption[]>(`/api/admin/sf/users?${params.toString()}`).then((res) => {
      if (cancelled) return
      if (res.error) setErr(res.error); else { setErr(null); setResults(res.data ?? []) }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, debouncedQ])

  async function refresh() {
    setRefreshBusy(true)
    setErr(null)
    const params = new URLSearchParams({ refresh: '1' })
    if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
    const res = await api.get<SfUserOption[]>(`/api/admin/sf/users?${params.toString()}`)
    setRefreshBusy(false)
    if (res.error) { setErr(res.error); return }
    setResults(res.data ?? [])
  }

  return (
    <div className={bare ? '' : 'rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900'}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          <Cloud className="mr-1 inline h-3.5 w-3.5" />
          {t('admin.users.sf_user_label', { context: crmCtx })}
        </p>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={refreshBusy} title={t('admin.users.sf_user_refresh_tip', { context: crmCtx })}>
          <RefreshCw className={cn('mr-1 h-3 w-3', refreshBusy && 'animate-spin')} />
          {t('admin.users.sf_user_refresh', { context: crmCtx })}
        </Button>
      </div>
      {value ? (
        <div className="mb-2 flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs dark:border-blue-800 dark:bg-blue-950/30">
          <Cloud className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
          <span className="flex-1 truncate text-gray-800 dark:text-gray-100">
            <span className="font-semibold">{value.name || value.id}</span>
            <span className="ml-1 text-[10px] text-gray-500 dark:text-gray-400">({value.id})</span>
          </span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-blue-800 hover:text-blue-900 dark:text-blue-200 dark:hover:text-blue-100"
            title={t('admin.users.sf_user_clear')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <p className="mb-2 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t('admin.users.sf_user_none', { context: crmCtx })}
        </p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <Input
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setOpen(true); setQ(e.target.value) }}
          placeholder={t('admin.users.sf_user_search_placeholder', { context: crmCtx })}
          className="pl-7"
        />
      </div>
      {err && (
        <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>
      )}
      {open && (
        <div className="mt-1 max-h-56 overflow-y-auto rounded border border-gray-200 bg-white text-xs dark:border-gray-700 dark:bg-gray-900">
          {loading && <p className="p-2 text-gray-400">…</p>}
          {!loading && results.length === 0 && (
            <p className="p-2 text-gray-400">{t('admin.users.sf_user_empty', { context: crmCtx })}</p>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => { onChange(r); setOpen(false); setQ('') }}
              className="flex w-full items-center gap-2 border-b border-gray-100 px-2 py-1.5 text-left last:border-b-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800"
            >
              <span className="flex-1 truncate">
                <span className="font-medium text-gray-800 dark:text-gray-100">{r.name}</span>
                {r.email && <span className="ml-1 text-[10px] text-gray-500 dark:text-gray-400">· {r.email}</span>}
              </span>
              <span className="text-[10px] text-gray-400">{r.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Subteams picker: multi-select over the subteams of the teams this
// user is part of (memberships plus default team). Rendered under the SF
// chips on the User Management edit form. Auto-saves on change.
// v1.470.0: it used to list every team's subteams, so a user could be put on
// another team's subteam. A subteam the user is still on but whose team they
// have left shows in its own amber group so an admin can remove it.
interface SubteamOption { id: string; name: string; kind: string | null; teamId: string; teamName: string; outsideTeams?: boolean }
function UserSubteamsSection({ userId, t, bare }: { userId: string; t: ReturnType<typeof useTranslation>['t']; bare?: boolean }) {
  const [all, setAll] = useState<SubteamOption[]>([])
  const [stale, setStale] = useState<SubteamOption[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [optionsRes, myRes] = await Promise.all([
        api.get<SubteamOption[]>(`/api/admin/users/${userId}/subteam-options`),
        api.get<SubteamOption[]>(`/api/admin/users/${userId}/subteams`),
      ])
      if (cancelled) return
      const mine = myRes.data ?? []
      setAll(optionsRes.data ?? [])
      setStale(mine.filter((s) => s.outsideTeams))
      setSelected(new Set(mine.map((s) => s.id)))
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [userId])
  const MAX_USER_SUBTEAMS = 4
  async function toggle(id: string) {
    // Cap at 4 subteams per user (matches the max subteam nesting depth).
    if (!selected.has(id) && selected.size >= MAX_USER_SUBTEAMS) return
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    const prev = selected
    setSelected(next)
    setSaving(true)
    setSaved(false)
    setError(null)
    const res = await api.put(`/api/admin/users/${userId}/subteams`, { subteamIds: Array.from(next) })
    setSaving(false)
    if (res.error) {
      setSelected(prev)
      setError(res.error)
      return
    }
    // A removed stale assignment can't be added back: its team isn't offered.
    setStale((rows) => rows.filter((r) => next.has(r.id)))
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  const byTeam = new Map<string, { teamName: string; rows: SubteamOption[] }>()
  for (const r of all) {
    const bucket = byTeam.get(r.teamId) ?? { teamName: r.teamName, rows: [] }
    bucket.rows.push(r)
    byTeam.set(r.teamId, bucket)
  }
  return (
    <div className={bare ? '' : 'mt-3 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900'}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          {!bare && t('admin.users.subteams_label')}
          <span className={cn('text-[10px] text-gray-500 dark:text-gray-400', bare ? 'font-normal' : 'ml-1 font-normal')}>{t('admin.users.subteam_limit', 'Up to 4 subteams')}</span>
        </p>
        {saving && <Spinner className="h-3 w-3 text-gray-400" />}
        {saved && <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{t('common.saved', 'Saved')}</span>}
      </div>
      {error && <p className="mb-2 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      {loading ? (
        <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
      ) : byTeam.size === 0 && stale.length === 0 ? (
        <p className="py-1 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t('admin.users.subteams_empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {stale.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/30">
              <p className="mb-1 flex items-center gap-1 text-[11px] text-amber-800 dark:text-amber-200">
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                {t('admin.users.subteams_outside_teams')}
              </p>
              <div className="flex flex-wrap gap-1">
                {stale.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggle(r.id)}
                    title={t('admin.users.subteams_outside_remove')}
                    aria-label={`${t('admin.users.subteams_outside_remove')}: ${r.teamName} / ${r.name}`}
                    className="inline-flex items-center gap-1 rounded border border-amber-400 bg-white px-2 py-0.5 text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:bg-gray-900 dark:text-amber-100 dark:hover:bg-amber-900/40"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    <span className="text-[10px] uppercase text-amber-700 dark:text-amber-300">{r.teamName}</span>
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {Array.from(byTeam.entries()).map(([tid, bucket]) => (
            <div key={tid}>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{bucket.teamName}</p>
              <div className="flex flex-wrap gap-1">
                {bucket.rows.map((r) => {
                  const on = selected.has(r.id)
                  const capped = !on && selected.size >= MAX_USER_SUBTEAMS
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggle(r.id)}
                      disabled={capped}
                      title={capped ? t('admin.users.subteam_limit', 'Up to 4 subteams') : undefined}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${on
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-800 dark:border-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-200'
                        : capped
                          ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 opacity-60 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-600'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'}`}
                    >
                      {r.name}
                      {r.kind && <span className="text-[9px] uppercase text-gray-400">{r.kind}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// v1.318.0: cross-team ("All Teams") roster view — groups every user the
// caller can see into collapsible sections by their Default Team, with a
// per-team SubteamFilter (the same shared chip used by Dashboard/Scheduling)
// to narrow each section down to specific subteams within that team. Only
// reachable when UserManagement is rendered with globalView (Admin.tsx
// passes it when the top team selector is set to "All Teams").
interface TeamSubteamOption { id: string; name: string }

interface GroupedByDefaultTeamViewProps {
  allUsers: DirectoryUser[]
  allTeams: { id: string; name: string }[]
  t: ReturnType<typeof useTranslation>['t']
  openEdit: (user: TeamUser) => void
  openResetPassword: (userId: string) => void
  resetMfa: (userId: string, name: string) => Promise<void>
  renderEditPanel: (userId: string) => React.ReactNode
  renderResetPasswordPanel: (userId: string) => React.ReactNode
  saving: string | null
  reload: () => Promise<void>
  // Security fix (F-04, pentest 2026-09): see UserManagement's own comment.
  viewerIsAppAdmin: boolean
}

const UNASSIGNED_GROUP_ID = '__unassigned__'

function GroupedByDefaultTeamView({
  allUsers, allTeams, t, openEdit, openResetPassword, resetMfa, renderEditPanel, renderResetPasswordPanel, saving, reload, viewerIsAppAdmin,
}: GroupedByDefaultTeamViewProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [subteamsByTeam, setSubteamsByTeam] = useState<Record<string, TeamSubteamOption[]>>({})
  const [subteamFilterByTeam, setSubteamFilterByTeam] = useState<Record<string, { subteamIds: string[]; userIds: string[] }>>({})
  const [subteamMembersById, setSubteamMembersById] = useState<Record<string, string[]>>({})
  const [roleSaving, setRoleSaving] = useState<string | null>(null)

  // Fetch each real team's subteams once — the synthetic "no default team"
  // bucket has no subteams of its own, so it never gets a filter chip.
  useEffect(() => {
    let cancelled = false
    async function loadSubteams() {
      const entries = await Promise.all(allTeams.map(async (team) => {
        const res = await api.get<{ id: string; name: string; isActive: boolean }[]>(`/api/admin/teams/${team.id}/subteams`)
        const rows = (res.data ?? []).filter((s) => s.isActive).map((s) => ({ id: s.id, name: s.name }))
        return [team.id, rows] as const
      }))
      if (cancelled) return
      setSubteamsByTeam(Object.fromEntries(entries) as Record<string, TeamSubteamOption[]>)
    }
    if (allTeams.length > 0) void loadSubteams()
    return () => { cancelled = true }
  }, [allTeams])

  // Resolve member ids for any subteam newly checked in any group's filter —
  // mirrors Dashboard.tsx's own subteamMembersById cache, just keyed across
  // multiple teams' filters instead of one.
  useEffect(() => {
    const toFetch: Array<{ teamId: string; subteamId: string }> = []
    for (const [tid, f] of Object.entries(subteamFilterByTeam)) {
      for (const sId of f.subteamIds) {
        if (!(sId in subteamMembersById)) toFetch.push({ teamId: tid, subteamId: sId })
      }
    }
    if (toFetch.length === 0) return
    void Promise.all(toFetch.map(({ teamId: tid, subteamId }) =>
      api.get<{ id: string }[]>(`/api/teams/${tid}/subteams/${subteamId}/members`)
        .then((res) => [subteamId, (res.data ?? []).map((m) => m.id)] as const)
        .catch(() => [subteamId, [] as string[]] as const),
    )).then((entries) => {
      setSubteamMembersById((prev) => {
        const next = { ...prev }
        for (const [id, ids] of entries) next[id] = ids
        return next
      })
    })
  }, [subteamFilterByTeam, subteamMembersById])

  const groups = useMemo(() => {
    const byTeam = new Map<string, DirectoryUser[]>()
    const unassigned: DirectoryUser[] = []
    for (const u of allUsers) {
      if (u.defaultTeamId) {
        const list = byTeam.get(u.defaultTeamId) ?? []
        list.push(u)
        byTeam.set(u.defaultTeamId, list)
      } else {
        unassigned.push(u)
      }
    }
    const sortByName = (a: DirectoryUser, b: DirectoryUser) => a.displayName.localeCompare(b.displayName)
    const out = allTeams.map((team) => ({
      id: team.id,
      name: team.name,
      members: (byTeam.get(team.id) ?? []).slice().sort(sortByName),
    }))
    if (unassigned.length > 0) {
      out.push({ id: UNASSIGNED_GROUP_ID, name: t('admin.users.no_default_team'), members: unassigned.sort(sortByName) })
    }
    return out
  }, [allUsers, allTeams, t])

  function effectiveMemberIdsForTeam(teamId: string): string[] | null {
    const f = subteamFilterByTeam[teamId]
    if (!f || (f.subteamIds.length === 0 && f.userIds.length === 0)) return null
    const set = new Set<string>(f.userIds)
    for (const id of f.subteamIds) for (const uid of subteamMembersById[id] ?? []) set.add(uid)
    return Array.from(set)
  }

  async function changeRoleForGroup(groupTeamId: string, userId: string, name: string, role: string) {
    setRoleSaving(userId)
    if (role === 'none') {
      if (!window.confirm(t('admin.users.remove_confirm', { name }))) { setRoleSaving(null); return }
      await api.delete(`/api/admin/teams/${groupTeamId}/users/${userId}`)
    } else {
      await api.patch(`/api/admin/teams/${groupTeamId}/users/${userId}/role`, { role })
    }
    setRoleSaving(null)
    await reload()
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const isOpen = expanded[group.id] ?? true
        const subteams = subteamsByTeam[group.id] ?? []
        const filter = subteamFilterByTeam[group.id] ?? { subteamIds: [], userIds: [] }
        const effectiveIds = effectiveMemberIdsForTeam(group.id)
        const visibleMembers = effectiveIds ? group.members.filter((m) => effectiveIds.includes(m.id)) : group.members
        return (
          <div key={group.id} className="rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between gap-2 rounded-t-lg bg-gray-50 px-4 py-2.5 dark:bg-gray-800/60">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [group.id]: !isOpen }))}
                className="flex flex-1 items-center gap-2 text-left text-sm font-semibold text-gray-800 dark:text-gray-200"
              >
                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                {group.name}
                <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  {group.members.length}
                </span>
              </button>
              {group.id !== UNASSIGNED_GROUP_ID && subteams.length > 0 && (
                <SubteamFilter
                  teamId={group.id}
                  subteams={subteams}
                  subteamIds={filter.subteamIds}
                  onSubteamIdsChange={(ids) => setSubteamFilterByTeam((prev) => ({ ...prev, [group.id]: { subteamIds: ids, userIds: prev[group.id]?.userIds ?? [] } }))}
                  userIds={filter.userIds}
                  onUserIdsChange={(ids) => setSubteamFilterByTeam((prev) => ({ ...prev, [group.id]: { subteamIds: prev[group.id]?.subteamIds ?? [], userIds: ids } }))}
                />
              )}
            </div>
            {isOpen && (
              <div className="flex flex-col gap-1 border-t border-gray-200 p-2 dark:border-gray-700">
                {visibleMembers.length === 0 ? (
                  <p className="py-4 text-center text-xs text-gray-400 dark:text-gray-500">{t('admin.users.empty')}</p>
                ) : (
                  <>
                    <div className="mb-1 grid grid-cols-[1fr_220px_150px_130px_140px_160px] gap-4 px-2 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                      <span>{t('admin.users.col_user')}</span>
                      <span>{t('admin.users.col_email')}</span>
                      <span>{t('admin.users.col_last_login', 'Last Logged In')}</span>
                      <span>{t('admin.users.col_password_reset', 'Password Reset')}</span>
                      <span>{t('admin.users.col_role')}</span>
                      <span></span>
                    </div>
                    {visibleMembers.map((dir) => {
                      const role = group.id === UNASSIGNED_GROUP_ID ? null : (dir.teamRoles?.[group.id] ?? null)
                      const enrolled = !!dir.totpEnrolledAt
                      const codesRemaining = dir.backupCodesRemaining ?? 0
                      const depleted = enrolled && codesRemaining === 0
                      const busy = saving === dir.id || roleSaving === dir.id
                      return (
                        <div key={dir.id} className="flex flex-col rounded-md border border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900">
                          <div className="grid grid-cols-[1fr_220px_150px_130px_140px_160px] items-center gap-4 px-2 py-2">
                            <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                              {dir.displayName}
                              {dir.isDefaultAdmin && (
                                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                  {t('admin.users.default_admin_badge')}
                                </span>
                              )}
                              {dir.disabledAt && <DisabledBadge t={t} />}
                            </span>
                            <span className="truncate text-xs text-gray-500 dark:text-gray-400">{dir.email}</span>
                            <span className="truncate text-xs text-gray-500 dark:text-gray-400">{formatLastLogin(dir.lastLoginAt, t)}</span>
                            {(() => {
                              const status = passwordResetStatus(dir.authMethod, dir.passwordChangedAt, t)
                              return status
                                ? <span className={cn('truncate text-xs', status.overdue ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>{status.label}</span>
                                : <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                            })()}
                            {role ? (
                              <Select
                                value={role}
                                disabled={busy}
                                onChange={(e) => void changeRoleForGroup(group.id, dir.id, dir.displayName, e.target.value)}
                                className="text-xs"
                              >
                                <option value="contributor">{t('admin.users.role_contributor')}</option>
                                <option value="leader">{t('admin.users.role_leader')}</option>
                                <option value="team_admin">{t('admin.users.role_team_admin')}</option>
                                {viewerIsAppAdmin && <option value="admin">{t('admin.users.role_admin')}</option>}
                                <option value="none">{t('admin.users.role_none')}</option>
                              </Select>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs italic text-gray-400 dark:text-gray-500" title={t('admin.users.not_a_member_hint', "Default team set, but no membership row on this team")}>
                                <ShieldAlert className="h-3.5 w-3.5" />
                                {t('admin.users.not_a_member', 'Not a member')}
                              </span>
                            )}
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => enrolled && resetMfa(dir.id, dir.displayName)}
                                disabled={!enrolled || busy}
                                title={depleted
                                  ? t('admin.users.mfa_depleted_hint')
                                  : enrolled
                                  ? t('admin.users.mfa_enrolled_hint', { when: new Date(dir.totpEnrolledAt!).toLocaleDateString() }) + ` · ${t('admin.users.mfa_codes_remaining', { count: codesRemaining })}`
                                  : t('admin.users.mfa_not_enrolled_hint')}
                                className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium ${
                                  depleted
                                    ? 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300'
                                    : enrolled
                                    ? 'bg-green-100 text-green-800 hover:bg-red-100 hover:text-red-700 dark:bg-green-900/40 dark:text-green-300'
                                    : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                                }`}
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                                {depleted
                                  ? t('admin.users.mfa_locked')
                                  : enrolled
                                  ? `${t('admin.users.mfa_on')} · ${codesRemaining}`
                                  : t('admin.users.mfa_off')}
                              </button>
                              <button
                                onClick={() => openEdit({
                                  userId: dir.id,
                                  displayName: dir.displayName,
                                  email: dir.email,
                                  role: (role as TeamUser['role']) ?? 'contributor',
                                  authMethod: dir.authMethod,
                                  defaultTeamId: dir.defaultTeamId,
                                  isDefaultAdmin: dir.isDefaultAdmin,
                                })}
                                className="rounded p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                                title={t('admin.users.edit')}
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => openResetPassword(dir.id)}
                                className="rounded p-1.5 text-gray-400 hover:text-amber-600 dark:hover:text-amber-400"
                                title={t('admin.users.reset_password')}
                              >
                                <KeyRound className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                          {renderEditPanel(dir.id)}
                          {renderResetPasswordPanel(dir.id)}
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function DisabledBadge({ t }: { t: (key: string) => string }) {
  return (
    <span className="ml-2 inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-800 dark:bg-red-900/40 dark:text-red-300">
      <Ban className="h-3 w-3" />
      {t('admin.users.disabled_badge')}
    </span>
  )
}
