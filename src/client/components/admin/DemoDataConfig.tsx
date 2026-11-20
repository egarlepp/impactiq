import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Copy, FlaskConical, KeyRound, MessageSquareText, RefreshCw, Sparkles, Trash2, Users } from 'lucide-react'
import { api } from '../../lib/api.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'

interface DemoSettings {
  contributorCount: number
  weeksBack: number
  createLeaderLogin: boolean
  timezone: string | null
  approvedPct: number
  declinedPct: number
  oooPct: number
  ptoDaysPerPerson: number
  activityNames: string[]
}
interface LeaderStatus { email: string; password: string | null; passwordWorks: boolean }
interface Status {
  team: { id: string; name: string } | null
  users: number
  activities: number
  notes: number
  ptoDays: number
  capacityGroups: number
  outlookEnabled: boolean
  settings: DemoSettings
  leader: LeaderStatus | null
}
interface GenerateResult { teamId: string; usersCreated: number; activitiesCreated: number }

// Must match DEMO_TEAM_NAME in services/demo/generator.ts; shown before the
// team exists.
const DEMO_TEAM_NAME = '[Demo] Sales Engineering'
// Must match STORAGE_KEY in store/team.tsx: after Generate or Reseed the app
// reloads into the demo team so the data shows straight away.
const ACTIVE_TEAM_KEY = 'active_team_id'

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function timeZoneList(current: string): string[] {
  let zones: string[] = []
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = []
  }
  const all = new Set(['UTC', ...zones, current])
  return Array.from(all).sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)))
}

function clampInt(value: string, min: number, max: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function reloadInto(teamId: string | null) {
  try {
    if (teamId) localStorage.setItem(ACTIVE_TEAM_KEY, teamId)
    else localStorage.removeItem(ACTIVE_TEAM_KEY)
  } catch {
    // Storage blocked: the reload still shows the data once the team is picked.
  }
  window.location.reload()
}

export function DemoDataConfig() {
  const { t } = useTranslation()
  const [contributorCount, setContributorCount] = useState(6)
  const [weeksBack, setWeeksBack] = useState(12)
  const [createLeaderLogin, setCreateLeaderLogin] = useState(false)
  const [timezone, setTimezone] = useState(browserTimeZone())
  const [approvedPct, setApprovedPct] = useState(70)
  const [declinedPct, setDeclinedPct] = useState(5)
  const [oooPct, setOooPct] = useState(3)
  const [ptoDaysPerPerson, setPtoDaysPerPerson] = useState(3)
  // One activity name per line, as typed; split when sent.
  const [activityNamesText, setActivityNamesText] = useState('')
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState<'idle' | 'generate' | 'reseed' | 'remove' | 'reloading'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const zones = useMemo(() => timeZoneList(timezone), [timezone])
  // With no stored settings the timezone starts as the admin's own (My
  // Settings), so the demo calendar lines up with their weekly view.
  const { user } = useCurrentUser()
  const [timezoneSource, setTimezoneSource] = useState<'default' | 'stored' | 'picked'>('default')
  const userTimezone = user?.timezone ?? null
  useEffect(() => {
    if (timezoneSource === 'default' && userTimezone) setTimezone(userTimezone)
  }, [timezoneSource, userTimezone])

  async function reload(prefill: boolean) {
    const statusRes = await api.get<Status>('/api/admin/demo-data/status')
    if (!statusRes.data) return
    setStatus(statusRes.data)
    if (prefill) {
      const s = statusRes.data.settings
      setContributorCount(Math.min(10, Math.max(1, s.contributorCount)))
      setWeeksBack(Math.min(26, Math.max(4, s.weeksBack)))
      setCreateLeaderLogin(s.createLeaderLogin)
      if (s.timezone) { setTimezone(s.timezone); setTimezoneSource('stored') }
      setApprovedPct(s.approvedPct)
      setDeclinedPct(s.declinedPct)
      setOooPct(s.oooPct)
      setPtoDaysPerPerson(s.ptoDaysPerPerson)
      setActivityNamesText((s.activityNames ?? []).join('\n'))
    }
  }

  useEffect(() => { void reload(true) }, [])

  const settingsBody = (): DemoSettings => ({
    contributorCount, weeksBack, createLeaderLogin, timezone, approvedPct, declinedPct, oooPct, ptoDaysPerPerson,
    activityNames: activityNamesText.split(/\r?\n/).map((n) => n.trim()).filter((n) => n.length > 0).slice(0, 50),
  })

  async function generate() {
    setBusy('generate'); setMessage(null); setError(null)
    const res = await api.post<GenerateResult>('/api/admin/demo-data/generate', { ...settingsBody(), includeAdmin: true })
    if (res.error || !res.data) { setBusy('idle'); setError(t(res.error ?? 'errors.demo_data.request_failed')); return }
    setMessage(t('admin.demo_data.reloading'))
    setBusy('reloading')
    reloadInto(res.data.teamId)
  }

  async function reseed() {
    if (!window.confirm(t('admin.demo_data.reseed_confirm'))) return
    setBusy('reseed'); setMessage(null); setError(null)
    const res = await api.post<GenerateResult>('/api/admin/demo-data/reseed', settingsBody())
    if (res.error || !res.data) { setBusy('idle'); setError(t(res.error ?? 'errors.demo_data.request_failed')); await reload(false); return }
    setMessage(t('admin.demo_data.reloading'))
    setBusy('reloading')
    reloadInto(res.data.teamId)
  }

  async function remove() {
    if (!status || (!status.team && status.users === 0 && status.activities === 0)) return
    if (!window.confirm(t('admin.demo_data.remove_confirm', { users: status.users, activities: status.activities }))) return
    setBusy('remove'); setMessage(null); setError(null)
    const res = await api.delete('/api/admin/demo-data')
    if (res.error) { setBusy('idle'); setError(t(res.error)); return }
    setMessage(t('admin.demo_data.reloading'))
    setBusy('reloading')
    // Leave the demo team if it was the active one; it no longer exists.
    let active: string | null = null
    try { active = localStorage.getItem(ACTIVE_TEAM_KEY) } catch { active = null }
    if (active && active === status.team?.id) reloadInto(null)
    else window.location.reload()
  }

  async function copyLeaderLogin(leader: LeaderStatus) {
    if (!leader.password) return
    try {
      await navigator.clipboard.writeText(`${leader.email}\n${leader.password}`)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const hasDemoData = !!status && (!!status.team || status.users > 0 || status.activities > 0)
  const leader = status?.leader ?? null
  const inputClass = 'w-24 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
  const numberField = (label: string, hint: string, value: number, set: (n: number) => void, min: number, max: number) => (
    <label className="flex flex-col gap-1 text-xs text-gray-700 dark:text-gray-300">
      <span className="font-medium">{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={(e) => set(clampInt(e.target.value, min, max))} className={inputClass} />
      <span className="text-gray-500 dark:text-gray-400">{hint}</span>
    </label>
  )

  return (
    <div className="flex flex-col gap-4">
      {hasDemoData && status && (
        <div className="flex items-start gap-4 rounded-lg border-2 border-amber-400 bg-amber-50 px-5 py-4 text-amber-950 shadow-sm dark:border-amber-500 dark:bg-amber-950/50 dark:text-amber-100">
          <FlaskConical className="mt-0.5 h-8 w-8 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <p className="text-lg font-bold tracking-tight">{t('admin.demo_data.banner_title')}</p>
            <p className="mt-1 text-sm">
              {t('admin.demo_data.banner_body', {
                team: status.team?.name ?? DEMO_TEAM_NAME,
                users: status.users,
                activities: status.activities,
                notes: status.notes,
                pto: status.ptoDays,
                groups: status.capacityGroups,
              })}
            </p>
            {status.outlookEnabled && <p className="mt-1 text-xs opacity-90">{t('admin.demo_data.outlook_active')}</p>}
          </div>
        </div>
      )}

      <div className="flex items-start gap-3 rounded-md border border-purple-200 bg-purple-50 px-4 py-3 text-sm text-purple-900 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-200">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('admin.demo_data.intro')}</span>
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.demo_data.current_state')}</p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {hasDemoData
            ? t('admin.demo_data.state_present', { users: status!.users, activities: status!.activities, groups: status!.capacityGroups })
            : t('admin.demo_data.empty_state')}
        </p>
        {leader && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="flex items-center gap-1.5 font-semibold"><KeyRound className="h-3.5 w-3.5" />{t('admin.demo_data.leader_created_title')}</p>
            <p className="mt-1"><span className="font-medium">{t('admin.demo_data.leader_email_label')}:</span> <span className="font-mono">{leader.email}</span></p>
            {leader.password ? (
              <p><span className="font-medium">{t('admin.demo_data.leader_password_label')}:</span> <span className="font-mono">{leader.password}</span></p>
            ) : (
              <p className="mt-1 flex items-start gap-1"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('admin.demo_data.leader_password_unavailable')}</p>
            )}
            {leader.password && !leader.passwordWorks && (
              <p className="mt-1 flex items-start gap-1 text-red-700 dark:text-red-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('admin.demo_data.leader_password_changed')}</p>
            )}
            <p className="mt-1">{t('admin.demo_data.leader_created_note')}</p>
            {leader.password && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void copyLeaderLogin(leader)}>
                {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                {copied ? t('admin.demo_data.leader_copied') : t('admin.demo_data.leader_copy')}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <p className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.demo_data.config_title')}</p>
        <p className="mb-3 flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('admin.demo_data.team_note', { team: status?.team?.name ?? DEMO_TEAM_NAME })}</span>
        </p>
        <p className="mb-3 flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('admin.demo_data.gong_note')}</span>
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-gray-700 dark:text-gray-300">
            <span className="font-medium">{t('admin.demo_data.contributors_label')}: {contributorCount}</span>
            <input
              type="range"
              min={1}
              max={10}
              value={contributorCount}
              onChange={(e) => setContributorCount(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-700 dark:text-gray-300">
            <span className="font-medium">{t('admin.demo_data.weeks_label')}: {weeksBack}</span>
            <input
              type="range"
              min={4}
              max={26}
              value={weeksBack}
              onChange={(e) => setWeeksBack(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-700 dark:text-gray-300 md:col-span-2">
            <span className="font-medium">{t('admin.demo_data.timezone_label')}</span>
            <select
              value={timezone}
              onChange={(e) => { setTimezone(e.target.value); setTimezoneSource('picked') }}
              className="w-full max-w-xs rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <span className="text-gray-500 dark:text-gray-400">{t('admin.demo_data.timezone_hint')}</span>
          </label>
        </div>

        <p className="mb-2 mt-4 text-xs font-semibold text-gray-900 dark:text-gray-100">{t('admin.demo_data.mix_title')}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {numberField(t('admin.demo_data.approved_label'), t('admin.demo_data.approved_hint'), approvedPct, setApprovedPct, 0, 100)}
          {numberField(t('admin.demo_data.declined_label'), t('admin.demo_data.declined_hint'), declinedPct, setDeclinedPct, 0, 100)}
          {numberField(t('admin.demo_data.ooo_label'), t('admin.demo_data.ooo_hint'), oooPct, setOooPct, 0, 60)}
          {numberField(t('admin.demo_data.pto_label'), t('admin.demo_data.pto_hint'), ptoDaysPerPerson, setPtoDaysPerPerson, 0, 20)}
        </div>

        <label className="mt-4 flex flex-col gap-1 text-xs text-gray-700 dark:text-gray-300">
          <span className="font-medium">{t('admin.demo_data.activity_names_label')}</span>
          <textarea
            value={activityNamesText}
            onChange={(e) => setActivityNamesText(e.target.value)}
            rows={4}
            placeholder={t('admin.demo_data.activity_names_placeholder')}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder:text-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <span className="text-gray-500 dark:text-gray-400">{t('admin.demo_data.activity_names_hint')}</span>
        </label>

        <label className="mt-3 flex items-start gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={createLeaderLogin}
            onChange={(e) => setCreateLeaderLogin(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5"
          />
          <span>
            <span className="font-medium">{t('admin.demo_data.leader_label')}</span>
            <span className="block text-gray-500 dark:text-gray-400">{t('admin.demo_data.leader_hint')}</span>
          </span>
        </label>
        {hasDemoData && <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">{t('admin.demo_data.remove_first')}</p>}
        {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
        {message && <p className="mt-3 text-xs text-green-600 dark:text-green-400">{message}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={generate} disabled={busy !== 'idle' || hasDemoData}>
            {busy === 'generate' ? <Spinner className="mr-1 h-3 w-3" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
            {t('admin.demo_data.generate')}
          </Button>
          <Button size="sm" variant="outline" onClick={reseed} disabled={busy !== 'idle' || !hasDemoData}>
            {busy === 'reseed' ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            {t('admin.demo_data.reseed')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={remove}
            disabled={busy !== 'idle' || !hasDemoData}
            className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {busy === 'remove' ? <Spinner className="mr-1 h-3 w-3" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
            {t('admin.demo_data.remove')}
          </Button>
        </div>
      </div>
    </div>
  )
}
