import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, CalendarDays, CheckCircle2, CircleSlash, AlertCircle, LogOut, Plug, Bell, Languages, Clock, CalendarClock, Save, Globe2, DollarSign, KeyRound, Bookmark, Monitor, Settings2, Database, Shield, Briefcase, History, RefreshCcw, Users, CornerDownRight, CalendarOff, PlaneTakeoff, Lock, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Palette, Sun, Moon, MessageSquare, Sparkles, Info, RotateCcw, type LucideIcon } from 'lucide-react'
import { useTheme, type ThemePreference } from '../store/theme.js'
import { ApiKeysSection } from '../components/settings/ApiKeysSection.js'
import { TemplatesSection } from '../components/settings/TemplatesSection.js'
import { NonActivityKeywordsSection } from '../components/settings/NonActivityKeywordsSection.js'
import { SessionsSection } from '../components/settings/SessionsSection.js'
import { RecentLoginsSection } from '../components/settings/RecentLoginsSection.js'
import { AiNoteSectionPicker } from '../components/aiNotes/AiNoteSectionPicker.js'
import type { AiNoteSection } from '../../shared/aiNotes.js'
import i18n, { SUPPORTED_LANGUAGES } from '../i18n/index.js'
import { Button } from '../components/ui/button.js'
import { SingleSelect } from '../components/ui/single-select.js'
import { CURRENCIES } from '../components/admin/common-lists.js'
import { Badge } from '../components/ui/badge.js'
import { Spinner } from '../components/ui/spinner.js'
import { PageHeader } from '../components/ui/page-header.js'
import { api } from '../lib/api.js'
import { useSalesforce } from '../hooks/useSalesforce.js'
import { useCrmProvider } from '../store/crmProvider.js'
import type { CrmProviderId } from '../../shared/crmProvider.js'
import { listTimeZones, type TimezoneSource } from '../../shared/timezoneSource.js'
import { useCrmMe } from '../hooks/useCrmMe.js'
import { useCurrentUser, clearCurrentUserCache } from '../hooks/useCurrentUser.js'
import { cn } from '../lib/utils.js'

interface MsStatus {
  connected: boolean
  // v1.197.0: token exists but Graph rejected it (revoked/expired) — the
  // card shows a "Reconnect needed" state, mirroring Salesforce.
  healthy?: boolean
  configured: boolean
  accountLabel: string | null
  connectedAt: string | null
}

function useMicrosoft() {
  const [status, setStatus] = useState<MsStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<MsStatus>('/auth/microsoft/status')
      setStatus(res.data ?? { connected: false, configured: false, accountLabel: null, connectedAt: null })
    } catch {
      setStatus({ connected: false, configured: false, accountLabel: null, connectedAt: null })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const connect = useCallback(() => { window.location.assign('/auth/microsoft') }, [])
  const disconnect = useCallback(async () => {
    await api.post('/auth/microsoft/disconnect', {})
    await reload()
  }, [reload])

  return { status, loading, connect, disconnect, reload }
}

function ConnectionCard({
  icon: Icon,
  name,
  description,
  configured,
  connected,
  healthy,
  connectedAt,
  accountLabel,
  loading,
  onConnect,
  onDisconnect,
}: {
  icon: React.ComponentType<{ className?: string }>
  name: string
  description: string
  configured: boolean
  connected: boolean
  // Undefined = health unknown (older status shape) → treat as healthy.
  // false = we have a token but it was rejected (revoked/expired).
  healthy?: boolean
  connectedAt: string | null
  accountLabel: string | null
  loading: boolean
  onConnect: () => void
  onDisconnect: () => void
}) {
  const { t } = useTranslation()
  const [disconnecting, setDisconnecting] = useState(false)
  // Connected but the stored token was rejected — surface a distinct
  // "Reconnect needed" state instead of a reassuring green "Connected".
  const needsReconnect = connected && healthy === false

  async function handleDisconnect() {
    if (!window.confirm(t('settings.connections.disconnect_confirm', { name }))) return
    setDisconnecting(true)
    await onDisconnect()
    setDisconnecting(false)
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`rounded-md p-2 ${needsReconnect ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400' : connected ? 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{name}</p>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>
          </div>
        </div>
        {loading ? (
          <Spinner className="h-4 w-4 shrink-0 text-gray-400" />
        ) : (
          <Badge variant={needsReconnect ? 'warning' : connected ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
            {needsReconnect ? <AlertCircle className="h-3 w-3" /> : connected ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
            {needsReconnect
              ? t('settings.connections.reconnect_needed', 'Reconnect needed')
              : connected
              ? t('settings.connections.connected')
              : t('settings.connections.not_connected')}
          </Badge>
        )}
      </div>

      {connected && accountLabel && (
        <p className="text-xs text-gray-700 dark:text-gray-300">
          <span className="text-gray-500 dark:text-gray-400">{t('settings.connections.connected_as', 'Connected as')}:</span>{' '}
          <span className="font-medium">{accountLabel}</span>
        </p>
      )}

      {connected && connectedAt && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('settings.connections.connected_since', { date: new Date(connectedAt).toLocaleDateString() })}
        </p>
      )}

      {!configured && !connected && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('settings.connections.not_configured_admin')}</span>
        </div>
      )}

      {needsReconnect && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('settings.connections.token_broken', 'This connection has stopped working (token revoked or expired). Click Reconnect to re-authorize.')}</span>
        </div>
      )}

      <div className="flex gap-2">
        {connected ? (
          <>
            <Button size="sm" onClick={onConnect} variant="outline">
              <RefreshCcw className="mr-1 h-3.5 w-3.5" />
              {t('settings.connections.reconnect')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleDisconnect} disabled={disconnecting} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300">
              {disconnecting && <Spinner className="mr-1 h-3 w-3" />}
              <LogOut className="mr-1 h-3.5 w-3.5" />
              {t('settings.connections.disconnect')}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onConnect} disabled={!configured || loading}>
            {connected ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <Icon className="mr-1 h-3.5 w-3.5" />}
            {t('settings.connections.connect', { name })}
          </Button>
        )}
      </div>
    </div>
  )
}

// v1.408.0: HubSpot has no per-user sign-in: ImpactIQ uses the install's one
// HubSpot connection and matches each user to a HubSpot owner (User
// Management link, else email). This card shows that match instead of a
// Connect button.
function HubspotMeCard() {
  const { t } = useTranslation()
  const { status, loading } = useCrmMe()

  const configured = status?.configured ?? false
  const owner = status?.owner ?? null
  const matched = configured && !!owner

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`rounded-md p-2 ${matched ? 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-400' : configured ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
            <Cloud className="h-5 w-5" />
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{t('settings.connections.hubspot_name')}</p>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('settings.connections.hubspot_desc')}</p>
          </div>
        </div>
        {loading ? (
          <Spinner className="h-4 w-4 shrink-0 text-gray-400" />
        ) : (
          <Badge variant={matched ? 'success' : configured ? 'warning' : 'secondary'} className="inline-flex shrink-0 items-center gap-1">
            {matched ? <CheckCircle2 className="h-3 w-3" /> : configured ? <AlertCircle className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
            {matched
              ? t('settings.connections.connected')
              : configured
              ? t('settings.connections.hubspot_not_matched')
              : t('settings.connections.not_connected')}
          </Badge>
        )}
      </div>

      {!loading && matched && owner && (
        <p className="text-xs text-gray-700 dark:text-gray-300">
          <span className="text-gray-500 dark:text-gray-400">{t('settings.connections.hubspot_matched_as')}:</span>{' '}
          <span className="font-medium">{owner.name ?? owner.email ?? owner.id}</span>
          {owner.name && owner.email && <span className="text-gray-500 dark:text-gray-400"> ({owner.email})</span>}
        </p>
      )}

      {!loading && configured && status?.portalName && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('settings.connections.hubspot_portal', { portal: status.portalName })}
        </p>
      )}

      {!loading && configured && !owner && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('settings.connections.hubspot_no_owner')}</span>
        </div>
      )}

      {!loading && !configured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('settings.connections.not_configured_admin')}</span>
        </div>
      )}
    </div>
  )
}

interface NotificationPrefs {
  emailEnabled: boolean
  emailTransport: 'graph' | 'smtp'
  timezone: string
  weeklyRecapEnabled?: boolean
  slackDmEnabled?: boolean
}

// v1.156.0: per-user opt-in to write logged activities back to the user's own
// Outlook calendar. Off by default; makes clear the app will create events.
function OutlookWritebackCard({ connected }: { connected: boolean }) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const [enabled, setEnabled] = useState<boolean>(!!user?.outlookWritebackEnabled)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setEnabled(!!user?.outlookWritebackEnabled) }, [user?.outlookWritebackEnabled])

  async function toggle(next: boolean) {
    setEnabled(next)
    setSaving(true)
    await api.patch('/auth/me/outlook-writeback', { enabled: next })
    clearCurrentUserCache()
    setSaving(false)
  }

  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <label className={cn('flex items-start gap-2 text-sm', !connected && 'opacity-60')}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!connected || saving}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
        />
        <span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{t('settings.outlook_writeback.label', 'Write my logged activities to my Outlook calendar')}</span>
          <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">{t('settings.outlook_writeback.hint', 'When you submit an activity that isn’t already on your calendar, ImpactIQ will create a matching event on your Outlook calendar.')}</span>
        </span>
      </label>

      {!connected && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('settings.outlook_writeback.connect_first', 'Connect your Outlook calendar above to enable this.')}</p>
      )}

      {enabled && connected && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('settings.outlook_writeback.notice', 'ImpactIQ will create and update events on your Outlook calendar. If your activities aren’t appearing, reconnect Outlook above to grant calendar-write access.')}</span>
        </div>
      )}
    </div>
  )
}

// The single flag behind both the Flight Deck modal's "Don't show again"
// checkbox and this toggle — same optimistic-save pattern as
// OutlookWritebackCard above. Lets a user who dismissed the modal (or an
// admin who wants to re-see a newly added checklist item) turn it back on
// without waiting for someone else to flip it.
function FlightDeckPreferenceCard() {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const [enabled, setEnabled] = useState<boolean>(user?.showFlightDeck !== false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setEnabled(user?.showFlightDeck !== false) }, [user?.showFlightDeck])

  async function toggle(next: boolean) {
    setEnabled(next)
    setSaving(true)
    await api.patch('/api/flight-deck/preference', { show: next })
    clearCurrentUserCache()
    setSaving(false)
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
        />
        <span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{t('settings.flight_deck.label')}</span>
          <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">{t('settings.flight_deck.hint')}</span>
        </span>
      </label>
    </div>
  )
}

// v1.457.0 (Gong plan, phase 4): which sections the AI writes when this
// person generates an AI Note on one of their activities. Starts on the
// team's default; "Use team default" goes back to it.
function AiNotesSectionsCard() {
  const { t } = useTranslation()
  const [state, setState] = useState<{ sections: AiNoteSection[] | null; teamDefaultSections: AiNoteSection[]; available: boolean } | null>(null)
  const [draft, setDraft] = useState<AiNoteSection[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<{ sections: AiNoteSection[] | null; teamDefaultSections: AiNoteSection[]; available: boolean }>('/api/ai-notes/settings').then((res) => {
      if (cancelled || !res.data) return
      setState(res.data)
      setDraft(res.data.sections ?? res.data.teamDefaultSections)
    })
    return () => { cancelled = true }
  }, [])

  if (!state) return <div className="flex justify-center py-4"><Spinner /></div>

  async function save(next: AiNoteSection[] | null) {
    setSaving(true)
    setError(null)
    const res = await api.put<{ sections: AiNoteSection[] | null }>('/api/ai-notes/settings', { sections: next })
    setSaving(false)
    if (res.error || !res.data) { setError(res.error ?? 'errors.server'); return }
    setState((cur) => (cur ? { ...cur, sections: res.data!.sections } : cur))
    setDraft(res.data.sections ?? state!.teamDefaultSections)
  }

  const current = state.sections ?? state.teamDefaultSections
  const dirty = draft.join(',') !== current.join(',')
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      {!state.available ? (
        <p className="flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('settings.ai_notes.not_available')}
        </p>
      ) : null}
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {state.sections ? t('settings.ai_notes.using_own') : t('settings.ai_notes.using_team')}
      </p>
      <AiNoteSectionPicker value={draft} onChange={setDraft} disabled={saving} />
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{t(error)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save(draft)}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {t('common.save')}
        </Button>
        {state.sections ? (
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void save(null)}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {t('settings.ai_notes.use_team_default')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// v1.262.0: "Private meetings → Non-Activity" — matchPrivateSensitivity
// (services/ai/classify.ts) consults Outlook's own sensitivity marking
// (private/confidential) directly, independent of the subject-keyword rule
// above. Default checked (see the users table default) so a private meeting
// is auto-excluded out of the box; this lets a contributor turn that off if
// they'd rather review those meetings themselves. See CLAUDE.md §7.
function PrivateMeetingsCard() {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const [enabled, setEnabled] = useState<boolean>(user?.privateMeetingsAsNonActivity !== false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setEnabled(user?.privateMeetingsAsNonActivity !== false) }, [user?.privateMeetingsAsNonActivity])

  async function toggle(next: boolean) {
    setEnabled(next)
    setSaving(true)
    await api.patch('/auth/me/private-meetings-as-non-activity', { enabled: next })
    clearCurrentUserCache()
    setSaving(false)
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
        />
        <span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{t('settings.private_meetings.label', 'Private meetings → Non-Activity')}</span>
          <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">{t('settings.private_meetings.hint', 'Meetings you\'ve marked Private or Confidential in Outlook are automatically excluded from your activity list, the same as a Non-Activity keyword match.')}</span>
        </span>
      </label>
    </div>
  )
}

function NotificationPrefsCard({ emailConfigured }: { emailConfigured: boolean }) {
  const { t } = useTranslation()
  const [prefs, setPrefs] = useState<NotificationPrefs>({ emailEnabled: true, emailTransport: 'graph', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', weeklyRecapEnabled: true, slackDmEnabled: true })
  const [slack, setSlack] = useState<{ configured: boolean; linked: boolean }>({ configured: false, linked: false })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void (async () => {
      const res = await api.get<NotificationPrefs>('/api/notifications/prefs')
      if (res.data) {
        const d = res.data
        setPrefs((p) => ({ ...p, ...d, timezone: d.timezone || p.timezone }))
      }
      const meta = res.meta as { slackConfigured?: boolean; slackLinked?: boolean }
      setSlack({ configured: !!meta?.slackConfigured, linked: !!meta?.slackLinked })
      setLoading(false)
    })()
  }, [])

  async function save() {
    setSaving(true)
    setSaved(false)
    await api.put('/api/notifications/prefs', prefs)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (loading) return <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-blue-100 p-2 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400">
          <Bell className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('settings.notifications.title')}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('settings.notifications.description')}</p>
        </div>
      </div>

      {!emailConfigured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('settings.notifications.not_configured_admin')}</span>
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.emailEnabled}
          onChange={(e) => setPrefs((p) => ({ ...p, emailEnabled: e.target.checked }))}
          className="h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
        />
        <span className="text-gray-700 dark:text-gray-300">{t('settings.notifications.email_enabled')}</span>
      </label>

      {prefs.emailEnabled && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('settings.notifications.timezone_note', { tz: prefs.timezone })}
        </p>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!prefs.weeklyRecapEnabled}
          onChange={(e) => setPrefs((p) => ({ ...p, weeklyRecapEnabled: e.target.checked }))}
          className="h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
        />
        <span className="text-gray-700 dark:text-gray-300">{t('settings.notifications.weekly_recap_enabled')}</span>
      </label>
      {prefs.weeklyRecapEnabled && prefs.emailEnabled && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('settings.notifications.weekly_recap_note')}
        </p>
      )}

      {slack.configured && (
        <>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs.slackDmEnabled !== false}
              onChange={(e) => setPrefs((p) => ({ ...p, slackDmEnabled: e.target.checked }))}
              className="h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
            />
            <MessageSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            <span className="text-gray-700 dark:text-gray-300">{t('settings.notifications.slack_dm_enabled')}</span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {slack.linked ? t('settings.notifications.slack_dm_note') : t('settings.notifications.slack_dm_not_linked')}
          </p>
        </>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          {t('common.save')}
        </Button>
        {saved && <span className="text-xs text-green-600 dark:text-green-400">{t('common.saved')}</span>}
      </div>
    </div>
  )
}

// v1.331.0: only Connections open by default — the others are read
// occasionally, not on every visit, so keeping them collapsed cuts the
// initial scroll length without hiding anything (a chevron and the header's
// single toggle both make it obvious more is there).
const SETTINGS_GROUP_KEYS = ['connections', 'preferences', 'data', 'security', 'workplace'] as const
type SettingsGroupKey = typeof SETTINGS_GROUP_KEYS[number]

export default function Settings() {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const sf = useSalesforce()
  const crm = useCrmProvider()
  const ms = useMicrosoft()
  const [emailConfigured, setEmailConfigured] = useState(false)
  const [tzSwitchedBanner, setTzSwitchedBanner] = useState(false)
  const [groupOpen, setGroupOpen] = useState<Record<SettingsGroupKey, boolean>>({
    connections: true, preferences: false, data: false, security: false, workplace: false,
  })
  const allGroupsOpen = SETTINGS_GROUP_KEYS.every((k) => groupOpen[k])
  function toggleGroup(key: SettingsGroupKey) {
    setGroupOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  }
  function toggleAllGroups() {
    const next = !allGroupsOpen
    setGroupOpen(Object.fromEntries(SETTINGS_GROUP_KEYS.map((k) => [k, next])) as Record<SettingsGroupKey, boolean>)
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('tzSwitched') === '1') {
      setTzSwitchedBanner(true)
      params.delete('tzSwitched')
      const q = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${q ? '?' + q : ''}`)
    }
  }, [])
  useEffect(() => {
    void (async () => {
      // /api/admin/integrations/status is admin-only; use the public status hook instead.
      // For now we read from the same endpoint and gracefully degrade for non-admins.
      const res = await api.get<{ smtp?: { configured: boolean } }>('/api/admin/integrations/status')
      setEmailConfigured(Boolean(res.data?.smtp?.configured))
    })().catch(() => { /* non-admin users: assume configured so the toggle isn't blocked */ setEmailConfigured(true) })
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={Plug}
        title={t('settings.title')}
        subtitle={user ? `${user.displayName} · ${user.email}` : null}
        right={
          <button
            type="button"
            onClick={toggleAllGroups}
            title={allGroupsOpen ? t('activity.collapse_all', 'Collapse all') : t('activity.expand_all', 'Expand all')}
            aria-label={allGroupsOpen ? t('activity.collapse_all', 'Collapse all') : t('activity.expand_all', 'Expand all')}
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            {allGroupsOpen ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
          </button>
        }
      />

      <div className="relative flex-1 overflow-y-auto bg-gray-100 p-6 dark:bg-gray-900">
      {/* v1.367.2 tried a grid-cell overlay to stretch the watermark to full
          content height — reverted (v1.368.1): stretching it to this long,
          many-group page's much-taller box changed its crop/zoom, visibly
          distorting it. Back to the original, non-stretched `absolute
          inset-0` sizing; the `bg-gray-100 dark:bg-gray-900` on the scroll
          container itself (one step off the page's own `bg-gray-50`/
          `dark:bg-gray-950`, §20's PageShell) is what actually fixes the
          long-page gap — an element background-color always extends across
          the full scrollable height, unlike an absolutely positioned child
          pinned to the container's own CSS box. Same fix applied in
          lockstep to Guide.tsx, HowToUseImpactIQ.tsx, and Admin.tsx. */}
      {/* World watermark — matches Admin.tsx's treatment exactly (same
          image, opacity, blend mode, and `background-size: cover` at a
          plain `right center` position). See Admin.tsx for the history of
          why `cover` with no positional offset is the only safe choice
          here — re-verify at both a narrow and a very wide viewport before
          changing backgroundPosition/backgroundSize on this div.
          v1.355.0: world.webp's own pixels are near-black navy — `screen`
          blend only lightens using the blend layer's own color, so
          screening that near-black asset onto the dark page background was
          invisible regardless of opacity. `invert(1)` flips it to
          near-white first, same fix as Admin.tsx — keep both in sync. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-20 mix-blend-multiply dark:opacity-20 dark:mix-blend-screen dark:[filter:invert(1)]"
        style={{
          backgroundImage: "url('/world.webp')",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right center',
          backgroundSize: 'cover',
        }}
      />
      <div className="relative flex flex-col gap-8">
        <SettingsGroup icon={Plug} title={t('settings.group.connections', 'Connections')} open={groupOpen.connections} onToggle={() => toggleGroup('connections')}>
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Plug className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.connections.title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            {crm === 'none'
              ? t('settings.connections.description_no_crm')
              : crm === 'hubspot'
              ? t('settings.connections.description_hubspot')
              : t('settings.connections.description')}
          </p>

          <div className="flex flex-col gap-4 sm:grid sm:grid-cols-2">
            {crm === 'hubspot' && <HubspotMeCard />}
            {crm === 'salesforce' && (
            <ConnectionCard
              icon={Cloud}
              name={t('settings.connections.salesforce_name')}
              description={t('settings.connections.salesforce_desc')}
              configured={sf.status?.configured ?? false}
              connected={sf.status?.connected ?? false}
              healthy={sf.status?.healthy}
              connectedAt={sf.status?.connectedAt ?? null}
              accountLabel={sf.status?.accountLabel ?? null}
              loading={sf.loading}
              onConnect={sf.connect}
              onDisconnect={sf.disconnect}
            />
            )}
            <ConnectionCard
              icon={CalendarDays}
              name={t('settings.connections.outlook_name')}
              description={t('settings.connections.outlook_desc')}
              configured={ms.status?.configured ?? false}
              connected={ms.status?.connected ?? false}
              healthy={ms.status?.healthy}
              connectedAt={ms.status?.connectedAt ?? null}
              accountLabel={ms.status?.accountLabel ?? null}
              loading={ms.loading}
              onConnect={ms.connect}
              onDisconnect={ms.disconnect}
            />
          </div>

          <OutlookWritebackCard connected={ms.status?.connected ?? false} />
        </section>
        </SettingsGroup>

        <SettingsGroup icon={Settings2} title={t('settings.group.preferences', 'Preferences')} open={groupOpen.preferences} onToggle={() => toggleGroup('preferences')}>
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Palette className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.appearance.section_title', 'Appearance')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            {t('settings.appearance.description', 'Choose how ImpactIQ looks on this device. Moved here from the sidebar so it lives with your other preferences.')}
          </p>
          <ThemePreferenceCard />
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Globe2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.timezone.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.timezone.description', { context: crm === 'none' ? 'none' : undefined })}</p>
          {tzSwitchedBanner && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200">
              <Globe2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">{t('settings.timezone.switched_title', 'Timezone updated to Outlook')}</p>
                <p className="mt-0.5 text-xs">{t('settings.timezone.switched_body', 'Outlook is now connected, so we switched the app timezone to match. You can pick a different timezone below.')}</p>
              </div>
              <button
                type="button"
                onClick={() => setTzSwitchedBanner(false)}
                className="text-indigo-700 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-100"
                aria-label={t('common.dismiss', 'Dismiss')}
              >×</button>
            </div>
          )}
          <TimezoneSourcePicker
            currentTz={user?.timezone ?? 'UTC'}
            outlookConnected={!!ms.status?.connected}
            crmProvider={crm}
          />
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Clock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.work_week.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.work_week.description')}</p>
          <WorkWeekCard microsoftConnected={ms.status?.connected ?? false} />
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <CalendarClock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.holidays.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.holidays.description')}</p>
          <HolidayCalendarsCard />
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Languages className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.language.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.language.section_description')}</p>
          <LanguagePickerCard />
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <PlaneTakeoff className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.flight_deck.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.flight_deck.section_description')}</p>
          <FlightDeckPreferenceCard />
        </section>
        </SettingsGroup>

        <SettingsGroup icon={Database} title={t('settings.group.data', 'Data & Templates')} open={groupOpen.data} onToggle={() => toggleGroup('data')}>
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Bookmark className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.templates.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.templates.description')}</p>
          <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <TemplatesSection />
          </div>
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <CalendarOff className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.non_activity_keywords.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            {t('settings.non_activity_keywords.description')}
          </p>
          <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <NonActivityKeywordsSection />
          </div>
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.ai_notes.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.ai_notes.description')}</p>
          <AiNotesSectionsCard />
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Lock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.private_meetings.section_title', 'Private Meetings')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            {t('settings.private_meetings.description', "Meetings marked Private or Confidential in Outlook get a distinct card treatment (masked title, lock icon) wherever they appear in ImpactIQ.")}
          </p>
          <PrivateMeetingsCard />
        </section>
        </SettingsGroup>

        <SettingsGroup icon={Shield} title={t('settings.group.security', 'Security & Access')} open={groupOpen.security} onToggle={() => toggleGroup('security')}>
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Monitor className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.sessions.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.sessions.description')}</p>
          <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <SessionsSection />
          </div>
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <History className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.recent_logins.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.recent_logins.description')}</p>
          <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <RecentLoginsSection />
          </div>
        </section>

        <section id="api-keys">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <KeyRound className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.api_keys.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.api_keys.description')}</p>
          <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <ApiKeysSection />
          </div>
        </section>
        </SettingsGroup>

        <SettingsGroup icon={Briefcase} title={t('settings.group.workplace', 'Work & Notifications')} open={groupOpen.workplace} onToggle={() => toggleGroup('workplace')}>
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Users className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.teams.section_title', 'Team')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.teams.description', 'Your team and any subteams you’re a member of.')}</p>
          <TeamMembershipCard />
          <DefaultScopeCard />
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <DollarSign className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.hourly_cost_rate.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.hourly_cost_rate.description')}</p>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
            <p className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">{t('settings.hourly_cost_rate.current')}:</span>
              <span className="ml-2 font-mono text-gray-800 dark:text-gray-100">
                {user?.effectiveHourlyCostRate != null
                  ? `$${Number(user.effectiveHourlyCostRate).toFixed(2)}/hr`
                  : t('settings.hourly_cost_rate.not_set')}
              </span>
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('settings.hourly_cost_rate.managed_by_admin')}</p>
            <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
              <PreferredCurrencyPicker />
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Bell className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {t('settings.notifications.section_title')}
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t('settings.notifications.section_description')}</p>
          <NotificationPrefsCard key={user?.id} emailConfigured={emailConfigured} />
        </section>
        </SettingsGroup>
      </div>
      </div>
    </div>
  )
}

interface TeamMembershipRow {
  teamId: string
  teamName: string
  role: string
  subteams: Array<{ id: string; name: string; kind: string | null; role: string }>
}

// v1.75.0 / v1.76.0: user-scoped preferred display currency. Uses
// the same SingleSelect chip as the Dashboard's "Show Costs In" so
// the two pickers look identical. Currencies with a cached FX rate
// float to the top; ones without are still selectable but marked so
// the SE knows an admin needs to Refresh in Admin → Cost Groups.
interface FxCurrencyRow { currency: string; ratePerUsd: number; asOf: string; source: string }
const CURRENCY_SYMBOL_SETTINGS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', AUD: 'A$', CAD: 'C$',
  CHF: 'Fr.', HKD: 'HK$', SGD: 'S$', KRW: '₩', INR: '₹', MXN: 'Mex$',
  BRL: 'R$', TWD: 'NT$', ZAR: 'R', AED: 'د.إ', SAR: '﷼',
}
function PreferredCurrencyPicker() {
  const { t } = useTranslation()
  const [current, setCurrent] = useState<string>('USD')
  const [rates, setRates] = useState<FxCurrencyRow[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [c, r] = await Promise.all([
        api.get<{ code: string | null }>('/auth/me/preferred-currency'),
        api.get<FxCurrencyRow[]>('/auth/fx-rates'),
      ])
      if (cancelled) return
      setCurrent(c.data?.code ?? 'USD')
      setRates(r.data ?? [])
    })()
    return () => { cancelled = true }
  }, [])
  async function persist(next: string) {
    setSaving(true)
    setCurrent(next)
    await api.put('/auth/me/preferred-currency', { code: next === 'USD' ? null : next })
    setSaving(false)
  }
  const withRates = new Set(rates.map((r) => r.currency))
  const withCached = CURRENCIES.filter((c) => withRates.has(c.code) || c.code === 'USD').map((c) => ({ ...c, hasRate: true }))
  const withCachedCodes = new Set(withCached.map((c) => c.code))
  const rest = CURRENCIES.filter((c) => !withCachedCodes.has(c.code)).map((c) => ({ ...c, hasRate: false }))
  const currencyOptions = [...withCached, ...rest]
  const asOf = rates[0]?.asOf ? new Date(rates[0].asOf).toISOString().slice(0, 10) : t('common.na', 'n/a')
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <SingleSelect
          label={t('settings.hourly_cost_rate.preferred_currency', 'Show costs in')}
          value={current}
          onChange={persist}
          options={currencyOptions.map((c) => ({
            value: c.code,
            label: `${CURRENCY_SYMBOL_SETTINGS[c.code] ?? ''} ${c.code} — ${c.name}`,
            hint: !c.hasRate && c.code !== 'USD' ? t('leader.cost_per_acv.no_rate', 'no rate') : undefined,
          }))}
        />
        {saving && <Spinner className="h-3 w-3" />}
      </div>
      <p className="text-[10px] text-gray-500 dark:text-gray-400">
        {t('settings.hourly_cost_rate.preferred_currency_hint', {
          defaultValue: 'Applies to the Weekly Revenue Impact pill and other user-facing money displays. Uses the latest FX rate table refreshed by an admin ({{asOf}}).',
          asOf,
        })}
      </p>
    </div>
  )
}

function TeamMembershipCard() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TeamMembershipRow[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await api.get<TeamMembershipRow[]>('/auth/me/teams')
      if (!cancelled) setRows(res.data ?? [])
    })()
    return () => { cancelled = true }
  }, [])

  if (rows == null) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <Spinner className="h-4 w-4" />
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
        {t('settings.teams.empty', 'You are not a member of any team yet. Ask your app admin to add you.')}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => (
        <div key={r.teamId} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">{r.teamName}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('settings.teams.role', 'Role')}: <span className="font-mono">{r.role}</span>
              </p>
            </div>
            <Badge variant="outline" className="text-[10px]">{t('settings.teams.main_team', 'Main team')}</Badge>
          </div>
          {r.subteams.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 border-t border-gray-100 pt-3 dark:border-gray-800">
              {r.subteams.map((s) => (
                <li key={s.id} className="flex items-center gap-2 pl-4 text-sm text-gray-700 dark:text-gray-300">
                  <CornerDownRight className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
                  <span>{s.name}</span>
                  {s.kind && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-500 dark:bg-gray-800 dark:text-gray-400">{s.kind}</span>}
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">
                    ({t('settings.teams.role', 'Role')}: {s.role})
                  </span>
                </li>
              ))}
            </ul>
          )}
          {r.subteams.length === 0 && (
            <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-400 dark:border-gray-800 dark:text-gray-500">
              {t('settings.teams.no_subteams', 'Not a member of any subteam on this team.')}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

// v1.263.0: self-service "default team" / "default subteam" — seeds which
// team the app opens to and, on the Scheduling page, which subteam the
// member filter defaults to. Team picker only shows once the user actually
// has more than one membership (a single-team user has nothing to pick);
// the subteam picker only shows once the CHOSEN default team has more than
// one subteam this user belongs to — a lone subteam is already implied.
function DefaultScopeCard() {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const [rows, setRows] = useState<TeamMembershipRow[] | null>(null)
  const [defaultTeamId, setDefaultTeamId] = useState<string | null>(null)
  const [defaultSubteamId, setDefaultSubteamId] = useState<string | null>(null)
  const [savingTeam, setSavingTeam] = useState(false)
  const [savingSubteam, setSavingSubteam] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await api.get<TeamMembershipRow[]>('/auth/me/teams')
      if (!cancelled) setRows(res.data ?? [])
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => { setDefaultTeamId(user?.defaultTeamId ?? null) }, [user?.defaultTeamId])
  useEffect(() => { setDefaultSubteamId(user?.defaultSubteamId ?? null) }, [user?.defaultSubteamId])

  if (!rows || rows.length === 0) return null

  const subteamsForDefaultTeam = rows.find((r) => r.teamId === defaultTeamId)?.subteams ?? []

  async function setTeam(next: string) {
    setSavingTeam(true)
    setDefaultTeamId(next)
    setDefaultSubteamId(null)
    await api.patch('/auth/me/default-team', { teamId: next || null })
    clearCurrentUserCache()
    setSavingTeam(false)
  }

  async function setSubteam(next: string) {
    setSavingSubteam(true)
    setDefaultSubteamId(next || null)
    await api.patch('/auth/me/default-subteam', { subteamId: next || null })
    clearCurrentUserCache()
    setSavingSubteam(false)
  }

  if (rows.length <= 1 && subteamsForDefaultTeam.length <= 1) return null

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('settings.default_scope.title', 'Defaults')}
      </p>
      {rows.length > 1 && (
        <div className="flex items-center gap-2">
          <SingleSelect
            label={t('settings.default_scope.team_label', 'Default team')}
            value={defaultTeamId ?? ''}
            onChange={setTeam}
            options={[
              { value: '', label: t('common.none', 'None') },
              ...rows.map((r) => ({ value: r.teamId, label: r.teamName })),
            ]}
          />
          {savingTeam && <Spinner className="h-3 w-3" />}
        </div>
      )}
      {defaultTeamId && subteamsForDefaultTeam.length > 1 && (
        <div className="flex items-center gap-2">
          <SingleSelect
            label={t('settings.default_scope.subteam_label', 'Default subteam')}
            value={defaultSubteamId ?? ''}
            onChange={setSubteam}
            options={[
              { value: '', label: t('common.none', 'None') },
              ...subteamsForDefaultTeam.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          {savingSubteam && <Spinner className="h-3 w-3" />}
        </div>
      )}
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {t('settings.default_scope.hint', 'Used to pre-select your team and subteam on pages like Scheduling.')}
      </p>
    </div>
  )
}

// v1.331.0: collapsible top-level group — each is its own disclosure, only
// "Connections" open by default (per-group state lives in the parent, driven
// by the header's single expand/collapse-all toggle).
function SettingsGroup({ title, icon: Icon, open, onToggle, children }: { title: string; icon: LucideIcon; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 border-b border-gray-200 pb-2 text-left dark:border-gray-700"
      >
        <Icon className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        <h2 className="flex-1 text-lg font-bold text-gray-900 dark:text-gray-100">{title}</h2>
        {open ? <ChevronDown className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" /> : <ChevronRight className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />}
      </button>
      {open && <div className="flex flex-col gap-8">{children}</div>}
    </div>
  )
}

const DAY_BITS = [
  { bit: 1, key: 'mon' },
  { bit: 2, key: 'tue' },
  { bit: 4, key: 'wed' },
  { bit: 8, key: 'thu' },
  { bit: 16, key: 'fri' },
  { bit: 32, key: 'sat' },
  { bit: 64, key: 'sun' },
] as const

type PerDayHours = Partial<Record<'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun', { start: number; end: number }>>

function WorkWeekCard({ microsoftConnected }: { microsoftConnected: boolean }) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const [syncing, setSyncing] = useState(false)
  const workerType = (user?.workerType ?? 'full_time') as 'full_time'|'part_time'|'contractor'
  const [workDays, setWorkDays] = useState<number>(user?.workDays ?? 31)
  const [startHour, setStartHour] = useState<number>(user?.workDayStartHour ?? 8)
  const [endHour, setEndHour] = useState<number>(user?.workDayEndHour ?? 18)
  const [perDayHours, setPerDayHours] = useState<PerDayHours>((user?.workHoursPerDay as PerDayHours) ?? {})
  const [showPerDay, setShowPerDay] = useState<boolean>(user?.workHoursPerDay ? Object.keys(user.workHoursPerDay).length > 0 : false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Pending work-week change request, if any. Loaded once on mount — we chose
  // a single fetch (not polling) because approvals are rare and the user can
  // hit Cancel or refresh to re-check; polling would just be noise.
  const [pendingReq, setPendingReq] = useState<{ id: string } | null>(null)

  useEffect(() => {
    if (user) {
      setWorkDays(user.workDays ?? 31)
      setStartHour(user.workDayStartHour ?? 8)
      setEndHour(user.workDayEndHour ?? 18)
      setPerDayHours((user.workHoursPerDay as PerDayHours) ?? {})
      setShowPerDay(user.workHoursPerDay ? Object.keys(user.workHoursPerDay).length > 0 : false)
    }
  }, [user?.id])

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ id: string } | null>('/auth/me/work-week-request')
      setPendingReq(res.data ?? null)
    })()
  }, [user?.id])

  function toggleDay(bit: number) {
    setWorkDays((d) => (d & bit ? d & ~bit : d | bit))
  }

  async function save() {
    // Shared validator — same rules as the server enforces.
    const { validateWorkWeek } = await import('../../shared/schemas/workWeek.js')
    const errKey = validateWorkWeek({
      workerType,
      workDays,
      workDayStartHour: startHour,
      workDayEndHour: endHour,
      workHoursPerDay: showPerDay ? (perDayHours as PerDayHours) : null,
    })
    if (errKey) { setErr(t(errKey)); return }
    setErr(null)
    setSaving(true)
    setSaved(false)
    const res = await api.patch<{ pending: boolean; requestId: string | null }>('/auth/me/work-week', {
      workerType,
      workDays,
      workDayStartHour: startHour,
      workDayEndHour: endHour,
      workHoursPerDay: showPerDay ? perDayHours : null,
    })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    clearCurrentUserCache()
    if (res.data?.pending && res.data.requestId) {
      setPendingReq({ id: res.data.requestId })
    } else {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  async function cancelPending() {
    if (!pendingReq) return
    const res = await api.delete(`/auth/me/work-week-request/${pendingReq.id}`)
    if (res.error) { setErr(res.error); return }
    setPendingReq(null)
  }

  // Pull working days + hours from the user's Outlook mailbox settings and
  // pre-fill the form. The user still reviews and Saves (which routes through
  // the admin-approval flow). Location is not synced.
  async function syncFromOutlook() {
    setSyncing(true)
    setErr(null)
    setSaved(false)
    const res = await api.get<{ workDays: number; workDayStartHour: number; workDayEndHour: number }>('/auth/me/outlook-working-hours')
    setSyncing(false)
    if (res.error || !res.data) { setErr(res.error ?? 'errors.outlook.no_working_hours'); return }
    setWorkDays(res.data.workDays)
    setStartHour(res.data.workDayStartHour)
    setEndHour(res.data.workDayEndHour)
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-indigo-100 p-2 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-400">
          <Clock className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('settings.work_week.title')}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('settings.work_week.subtitle')}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
          {t('settings.worker_type.label')}: {t(`settings.worker_type.${workerType}`)}
        </span>
      </div>

      {/* Outlook sync disclaimer — always shown so users know the option exists;
          the button itself only works once Outlook is connected. */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
        <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t('settings.work_week.outlook_sync_disclaimer', 'When Outlook is connected, you can sync your working days and hours from your Outlook mailbox. Work location isn’t synced, and changes still require admin approval when you Save.')}</span>
      </div>

      {pendingReq && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-center justify-between gap-2">
            <span>{t('settings.work_week.pending_approval_banner')}</span>
            <button onClick={cancelPending} className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-transparent dark:text-amber-200">
              {t('settings.work_week.cancel_pending')}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.work_week.weekdays_label')}</span>
        <div className="flex flex-wrap gap-2">
          {DAY_BITS.map((d) => {
            const on = (workDays & d.bit) !== 0
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => toggleDay(d.bit)}
                className={
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ' +
                  (on
                    ? 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800')
                }
              >
                {t(`settings.work_week.days.${d.key}`)}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 max-w-md">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-700 dark:text-gray-300">{t('settings.work_week.start_hour_label')}</span>
          <select
            value={startHour}
            onChange={(e) => setStartHour(Number(e.target.value))}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-700 dark:text-gray-300">{t('settings.work_week.end_hour_label')}</span>
          <select
            value={endHour}
            onChange={(e) => setEndHour(Number(e.target.value))}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showPerDay}
          onChange={(e) => setShowPerDay(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
        />
        <span className="text-gray-700 dark:text-gray-300">{t('settings.work_week.show_per_day')}</span>
      </label>

      {showPerDay && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {DAY_BITS.map((d) => {
            const enabled = (workDays & d.bit) !== 0
            const val = perDayHours[d.key] ?? { start: startHour, end: endHour }
            return (
              <div key={d.key} className={cn('flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-900', !enabled && 'opacity-40')}>
                <span className="w-10 shrink-0 font-medium text-gray-700 dark:text-gray-300">{t(`settings.work_week.days.${d.key}`)}</span>
                <select
                  disabled={!enabled}
                  value={val.start}
                  onChange={(e) => setPerDayHours((prev) => ({ ...prev, [d.key]: { start: Number(e.target.value), end: val.end } }))}
                  className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                  ))}
                </select>
                <span className="text-gray-400">→</span>
                <select
                  disabled={!enabled}
                  value={val.end}
                  onChange={(e) => setPerDayHours((prev) => ({ ...prev, [d.key]: { start: val.start, end: Number(e.target.value) } }))}
                  className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                >
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
                <span className="ml-auto text-[10px] text-gray-500 dark:text-gray-400">{(val.end - val.start).toFixed(1)}h</span>
              </div>
            )
          })}
        </div>
      )}

      {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}

      <div className="flex items-center gap-2">
        {pendingReq ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
            {t('settings.work_week.pending_chip')}
          </span>
        ) : (
          <>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Spinner className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
            {microsoftConnected && (
              <Button size="sm" variant="outline" onClick={syncFromOutlook} disabled={syncing || saving}>
                {syncing ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCcw className="mr-1 h-3.5 w-3.5" />}
                {t('settings.work_week.sync_from_outlook', 'Sync from Outlook')}
              </Button>
            )}
            {saved && <span className="text-xs text-green-600 dark:text-green-400">{t('common.saved')}</span>}
          </>
        )}
      </div>
    </div>
  )
}

interface HCal { id: string; code: string; name: string; locale: string }

interface MyHolidayCalendarsResponse {
  picked: string[]
  inherited: Array<{ teamId: string; teamName: string; calendarIds: string[] }>
}

function HolidayCalendarsCard() {
  const { t } = useTranslation()
  const [cals, setCals] = useState<HCal[]>([])
  const [mine, setMine] = useState<MyHolidayCalendarsResponse>({ picked: [], inherited: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      const [listRes, mineRes] = await Promise.all([
        api.get<HCal[]>('/auth/holiday-calendars'),
        api.get<MyHolidayCalendarsResponse>('/auth/me/holiday-calendars'),
      ])
      setCals(listRes.data ?? [])
      setMine(mineRes.data ?? { picked: [], inherited: [] })
      setLoading(false)
    })()
  }, [])

  if (loading) return <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>

  const byId = new Map(cals.map((c) => [c.id, c]))
  const pickedCals = mine.picked.map((id) => byId.get(id)).filter(Boolean) as HCal[]
  const inheritedGroups = mine.inherited
    .map((g) => ({ teamName: g.teamName, cals: g.calendarIds.map((id) => byId.get(id)).filter(Boolean) as HCal[] }))
    .filter((g) => g.cals.length > 0)

  const hasAny = pickedCals.length > 0 || inheritedGroups.length > 0

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-indigo-100 p-2 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-400">
          <CalendarClock className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('settings.holidays.title')}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('settings.holidays.managed_by_admin')}</p>
        </div>
      </div>
      {pickedCals.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('settings.holidays.your_picks', 'Your calendars')}
          </p>
          <div className="flex flex-wrap gap-2">
            {pickedCals.map((c) => (
              <span
                key={c.id}
                className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300"
              >
                {c.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {pickedCals.length === 0 && inheritedGroups.length > 0 && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {t('settings.holidays.using_team_calendars', 'Using your team calendars (no personal override set).')}
        </p>
      )}
      {inheritedGroups.map((g) => (
        <div key={g.teamName}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('settings.holidays.from_team', 'From team')}: {g.teamName}
          </p>
          <div className="flex flex-wrap gap-2">
            {g.cals.map((c) => (
              <span
                key={c.id}
                className="rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                title={t('settings.holidays.team_inherited_tip', 'Assigned by admin to this team. Set your own picks to override.')}
              >
                {c.name}
              </span>
            ))}
          </div>
        </div>
      ))}
      {!hasAny && (
        <p className="text-xs text-gray-400">{t('settings.holidays.none_available')}</p>
      )}
    </div>
  )
}

// v1.360.0: the light/dark/system toggle formerly lived as a sidebar icon
// button (nav.tsx) — moved here per the "settings belong in Settings" ask.
// `useTheme().preference` is the raw stored choice ('light'|'dark'|'system'),
// distinct from `.theme`, the resolved 'light'|'dark' every dark:/JS-
// conditional consumer elsewhere in the app still reads.
function ThemePreferenceCard() {
  const { t } = useTranslation()
  const { preference, setTheme } = useTheme()
  const options: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
    { value: 'light', label: t('settings.appearance.light', 'Light'), icon: Sun },
    { value: 'dark', label: t('settings.appearance.dark', 'Dark'), icon: Moon },
    { value: 'system', label: t('settings.appearance.system', 'System'), icon: Monitor },
  ]
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-blue-100 p-2 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400">
          <Palette className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('settings.appearance.title', 'Theme')}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {t('settings.appearance.system_hint', '"System" follows your OS light/dark setting and updates automatically if it changes.')}
          </p>
        </div>
      </div>
      <div className="inline-flex w-fit rounded-md border border-gray-300 p-0.5 dark:border-gray-600">
        {options.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            title={label}
            className={cn(
              'flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors',
              preference === value
                ? 'bg-blue-600 text-white dark:bg-blue-700'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function LanguagePickerCard() {
  const { t, i18n: i18nInstance } = useTranslation()
  const [lang, setLang] = useState(i18nInstance.language || 'en')
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-blue-100 p-2 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400">
          <Languages className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('settings.language.title')}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('settings.language.description')}</p>
        </div>
      </div>
      <select
        value={lang}
        onChange={(e) => {
          const next = e.target.value
          setLang(next)
          void i18n.changeLanguage(next)
        }}
        className="w-full max-w-xs rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.label}</option>
        ))}
      </select>
    </div>
  )
}

// v1.469.0: three ways to set the app timezone. Outlook (the default once it's
// connected), the active CRM's timezone (hidden when the install has no CRM),
// or any timezone picked by hand. A CRM or manual pick sticks: the hourly
// Outlook check only changes the timezone while it follows Outlook.
interface TimezoneState { timezone: string; source: TimezoneSource; outlookTimezone: string | null }
interface CrmTimezoneState { provider: string; connected: boolean; timezone: string | null }

function TimezoneSourcePicker({
  currentTz,
  outlookConnected,
  crmProvider,
}: {
  currentTz: string
  outlookConnected: boolean
  crmProvider: CrmProviderId
}) {
  const { t } = useTranslation()
  const hasCrm = crmProvider !== 'none'
  const crmCtx = crmProvider === 'hubspot' ? 'hubspot' : undefined
  const [state, setState] = useState<TimezoneState | null>(null)
  const [crmTz, setCrmTz] = useState<CrmTimezoneState | null>(null)
  const [loadingCrm, setLoadingCrm] = useState(hasCrm)
  const zones = useMemo(() => listTimeZones(), [])
  // The list holds IANA zones only; Outlook can report a Windows name
  // ("Pacific Standard Time"), so start the picker on the browser's zone then.
  const pickerStart = useCallback((tz: string) => {
    if (zones.includes(tz)) return tz
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return browserTz && zones.includes(browserTz) ? browserTz : 'UTC'
  }, [zones])
  const [manualTz, setManualTz] = useState(() => pickerStart(currentTz))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.get<TimezoneState>('/auth/me/timezone').then((res) => {
      if (cancelled || !res.data) return
      setState(res.data)
      setManualTz(pickerStart(res.data.timezone))
    })
    return () => { cancelled = true }
  }, [pickerStart])

  useEffect(() => {
    let cancelled = false
    if (!hasCrm) { setCrmTz(null); setLoadingCrm(false); return }
    setLoadingCrm(true)
    void api.get<CrmTimezoneState>('/api/crm/me/tz').then((res) => {
      if (cancelled) return
      setCrmTz(res.data ?? null)
      setLoadingCrm(false)
    })
    return () => { cancelled = true }
  }, [hasCrm])

  const tz = state?.timezone ?? currentTz
  const source: TimezoneSource = state?.source ?? 'auto'
  const outlookTz = outlookConnected ? (state?.outlookTimezone ?? null) : null
  const crmValue = crmTz?.timezone ?? null
  // A Salesforce timezone seeded at connect time (before Outlook) is stored as
  // 'auto'; it still reads as the CRM row being the one in use.
  const crmActive = source === 'crm' || (source === 'auto' && !outlookConnected && !!crmValue && crmValue === tz)
  const outlookActive = source === 'auto' && outlookConnected && !!outlookTz
  const manualActive = source === 'manual' || (!outlookActive && !crmActive)

  async function pick(body: { source: TimezoneSource; timezone?: string }) {
    if (body.source === source && (body.timezone === undefined || body.timezone === tz)) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const res = await api.patch<{ timezone: string; source: TimezoneSource }>('/auth/me/timezone', body)
    setSaving(false)
    if (res.error || !res.data) { setError(res.error ?? t('errors.timezone.invalid')); return }
    setSaved(true)
    // Every view reads the timezone from the cached current user; reload so
    // calendars and digests pick up the new one.
    const { clearCurrentUserCache } = await import('../hooks/useCurrentUser.js')
    clearCurrentUserCache()
    window.location.reload()
  }

  const crmMissingLabel = crmTz?.connected
    ? t('settings.timezone.crm_unavailable', 'Not available')
    : t('settings.connections.not_connected')

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
      <p className="text-sm">
        <span className="text-gray-500 dark:text-gray-400">{t('settings.timezone.current')}:</span>
        <span className="ml-2 font-mono text-gray-800 dark:text-gray-100">{tz}</span>
        {saving && <Spinner className="ml-2 inline h-3 w-3" />}
        {saved && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />{t('common.saved', 'Saved')}
          </span>
        )}
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        <TzRow
          label={t('settings.timezone.source_outlook', 'Outlook timezone')}
          value={outlookTz}
          disabled={!outlookConnected || !outlookTz}
          isActive={outlookActive}
          onPick={outlookTz ? () => void pick({ source: 'auto' }) : undefined}
          disabledLabel={outlookConnected ? t('settings.timezone.crm_unavailable', 'Not available') : t('settings.connections.not_connected')}
        />
        {hasCrm && (
          <TzRow
            label={t('settings.timezone.source_crm', { context: crmCtx, defaultValue: '{{crm}} timezone' })}
            value={crmValue}
            disabled={loadingCrm || !crmValue}
            loading={loadingCrm}
            isActive={crmActive}
            onPick={crmValue ? () => void pick({ source: 'crm', timezone: crmValue }) : undefined}
            disabledLabel={crmMissingLabel}
          />
        )}
        <div
          className={`flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-1.5 text-sm ${
            manualActive
              ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40'
              : 'border-gray-200 dark:border-gray-700'
          }`}
        >
          <label htmlFor="tz-manual" className="flex items-center gap-2">
            {manualActive && <CheckCircle2 className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />}
            <span className="text-gray-700 dark:text-gray-200">{t('settings.timezone.source_manual', 'Set manually')}</span>
          </label>
          <div className="flex items-center gap-2">
            <select
              id="tz-manual"
              value={manualTz}
              onChange={(e) => setManualTz(e.target.value)}
              className="max-w-[16rem] rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || (source === 'manual' && manualTz === tz)}
              onClick={() => void pick({ source: 'manual', timezone: manualTz })}
            >
              <Save className="mr-1 h-3.5 w-3.5" />
              {t('settings.timezone.use_manual', 'Use this timezone')}
            </Button>
          </div>
        </div>
      </div>
      {error && (
        <p className="mt-2 flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />{error}
        </p>
      )}
      <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
        {t('settings.timezone.source_hint', { context: hasCrm ? undefined : 'none', defaultValue: 'Follows Outlook when connected, otherwise UTC. Pick your {{crm}} timezone or set one yourself; your choice stays until you pick Outlook again or reconnect Outlook.' })}
      </p>
    </div>
  )
}

function TzRow({
  label,
  value,
  disabled,
  loading,
  isActive,
  onPick,
  disabledLabel,
}: {
  label: string
  value: string | null
  disabled: boolean
  loading?: boolean
  isActive: boolean
  onPick?: () => void
  disabledLabel: string
}) {
  return (
    <button
      type="button"
      disabled={disabled || !onPick}
      onClick={onPick}
      className={`flex items-center justify-between rounded border px-3 py-1.5 text-sm text-left ${
        isActive
          ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40'
          : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span className="flex items-center gap-2">
        {isActive && <CheckCircle2 className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />}
        <span className="text-gray-700 dark:text-gray-200">{label}</span>
      </span>
      <span className="font-mono text-xs text-gray-800 dark:text-gray-100">
        {loading ? '…' : (value ?? disabledLabel)}
      </span>
    </button>
  )
}
