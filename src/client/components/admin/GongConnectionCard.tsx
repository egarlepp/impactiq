import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, AlertCircle, CheckCircle2, CircleHelp, Copy, KeyRound, LayoutGrid, Link2, MessageCircleText, RefreshCw, Save,
  ShieldAlert, ShieldCheck, Trash2, Users, XCircle,
} from 'lucide-react'
import { api } from '../../lib/api.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { CollapsibleCard } from './CollapsibleCard.js'
import { GongTranscriptSettings } from './GongTranscriptSettings.js'
import {
  DEFAULT_GONG_API_BASE_URL,
  GONG_CAPABILITY_KEYS,
  GONG_CAPABILITY_SCOPES,
  GONG_TRANSCRIPT_CACHE_DAYS_MAX,
  GONG_TRANSCRIPT_CACHE_DAYS_MIN,
  REQUIRED_GONG_CAPABILITIES,
  type GongAuthMethod,
  type GongCapabilityReport,
  type GongCapabilityStatus,
  type GongConnectionSummary,
  type GongWorkspace,
} from '../../../shared/gong.js'

const UNMATCHED_SHOWN = 20

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function StatusIcon({ status }: { status: GongCapabilityStatus }) {
  if (status === 'ok') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
  if (status === 'missing') return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
  return <CircleHelp className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
}

// The result of the OAuth round trip comes back on the Admin URL
// (?gongConnect=ok|error&reason=<i18n key>). Read once, then dropped from
// the address bar so a reload doesn't show it again.
function readConnectResult(): { ok: boolean; reason: string | null } | null {
  const params = new URLSearchParams(window.location.search)
  const result = params.get('gongConnect')
  if (result !== 'ok' && result !== 'error') return null
  const reason = params.get('reason')
  params.delete('gongConnect')
  params.delete('reason')
  const qs = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`)
  return { ok: result === 'ok', reason: reason && /^errors\.[a-z_.]+$/.test(reason) ? reason : null }
}

// Admin → Integrations → Gong (Gong plan, phase 1): the tenant's Gong
// connection, by access key (default) or OAuth app, a check of what it can
// read, the workspaces to use, how long transcripts are kept, and the Gong
// user list ImpactIQ users are matched to by email.
export function GongConnectionCard() {
  const { t, i18n } = useTranslation()
  const [connectResult] = useState(readConnectResult)
  const [summary, setSummary] = useState<GongConnectionSummary | null>(null)
  const [error, setError] = useState<string | null>(connectResult && !connectResult.ok ? t(connectResult.reason ?? 'errors.gong.oauth_failed') : null)
  const [notice, setNotice] = useState<string | null>(connectResult?.ok ? t('admin.integrations.gong.oauth_connected_notice') : null)
  const [busy, setBusy] = useState<'save' | 'check' | 'users' | 'remove' | 'workspaces' | null>(null)
  const [method, setMethod] = useState<GongAuthMethod>('access_key')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [cacheDays, setCacheDays] = useState('30')
  const [workspaces, setWorkspaces] = useState<GongWorkspace[] | null>(null)
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  function adopt(s: GongConnectionSummary) {
    setSummary(s)
    setMethod(s.authMethod)
    setApiBaseUrl(s.apiBaseUrl ?? DEFAULT_GONG_API_BASE_URL)
    setClientId(s.oauth.clientId ?? '')
    setCacheDays(String(s.transcriptCacheDays))
    setSelectedWorkspaces(s.workspaceIds)
  }

  useEffect(() => {
    void api.get<GongConnectionSummary>('/api/admin/integrations/gong').then((res) => {
      if (res.error) setError(res.error)
      else if (res.data) adopt(res.data)
    })
  }, [])

  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language)
  const configured = !!summary?.configured
  const check = summary?.lastCheck ?? null
  const users = summary?.users ?? null
  const cacheDaysNum = Number(cacheDays)
  const cacheDaysValid = Number.isInteger(cacheDaysNum) && cacheDaysNum >= GONG_TRANSCRIPT_CACHE_DAYS_MIN && cacheDaysNum <= GONG_TRANSCRIPT_CACHE_DAYS_MAX

  async function save() {
    setBusy('save')
    setError(null)
    setNotice(null)
    const body: Record<string, unknown> = {
      authMethod: method,
      transcriptCacheDays: cacheDaysNum,
      workspaceIds: selectedWorkspaces,
    }
    if (method === 'access_key') {
      body['apiBaseUrl'] = apiBaseUrl.trim() || DEFAULT_GONG_API_BASE_URL
      if (accessKey.trim()) body['accessKey'] = accessKey.trim()
      if (accessKeySecret.trim()) body['accessKeySecret'] = accessKeySecret.trim()
    } else {
      if (clientId.trim()) body['oauthClientId'] = clientId.trim()
      if (clientSecret.trim()) body['oauthClientSecret'] = clientSecret.trim()
    }
    const res = await api.put<GongConnectionSummary>('/api/admin/integrations/gong', body)
    setBusy(null)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    adopt(res.data)
    setAccessKey('')
    setAccessKeySecret('')
    setClientSecret('')
    setNotice(t('admin.integrations.gong.saved'))
  }

  async function runCheck() {
    setBusy('check')
    setError(null)
    setNotice(null)
    const res = await api.post<GongCapabilityReport>('/api/admin/integrations/gong/test', {})
    setBusy(null)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    const report = res.data
    setSummary((s) => (s ? { ...s, lastCheck: report } : s))
  }

  async function loadWorkspaces() {
    setBusy('workspaces')
    setError(null)
    const res = await api.get<GongWorkspace[]>('/api/admin/integrations/gong/workspaces')
    setBusy(null)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    setWorkspaces(res.data)
  }

  async function syncUsers() {
    setBusy('users')
    setError(null)
    setNotice(null)
    const res = await api.post<GongConnectionSummary>('/api/admin/integrations/gong/sync-users', {})
    setBusy(null)
    if (res.error || !res.data) { setError(t(res.error ?? 'errors.network')); return }
    adopt(res.data)
  }

  async function remove() {
    if (!window.confirm(t('admin.integrations.gong.remove_confirm'))) return
    setBusy('remove')
    setError(null)
    setNotice(null)
    const res = await api.delete<{ ok: boolean }>('/api/admin/integrations/gong')
    setBusy(null)
    if (res.error) { setError(t(res.error)); return }
    const refreshed = await api.get<GongConnectionSummary>('/api/admin/integrations/gong')
    if (refreshed.data) adopt(refreshed.data)
    setWorkspaces(null)
  }

  async function copyRedirect(uri: string) {
    try {
      await navigator.clipboard.writeText(uri)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const toggleWorkspace = (id: string) =>
    setSelectedWorkspaces((cur) => (cur.includes(id) ? cur.filter((w) => w !== id) : [...cur, id]))

  const badges = (
    <Badge variant={configured ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
      {configured ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {configured ? t('admin.integrations.configured') : t('admin.integrations.not_configured')}
    </Badge>
  )

  const oauthReady = !!summary?.oauth.clientId && !!summary.oauth.clientSecretOnFile && !!summary.oauth.redirectUri
  const methodButton = (m: GongAuthMethod, Icon: typeof KeyRound, label: string) => (
    <button
      type="button"
      onClick={() => setMethod(m)}
      aria-pressed={method === m}
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${method === m
        ? 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500'
        : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )

  return (
    <CollapsibleCard
      icon={MessageCircleText}
      title={t('admin.integrations.gong.title')}
      description={t('admin.integrations.gong.description')}
      badges={badges}
      defaultOpen={connectResult !== null}
    >
      {error && <ErrorBox message={error} />}
      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {!summary && !error ? (
        <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
      ) : (
        <>
          <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.privacy_note')}</p>

          <div className="flex flex-col gap-1.5">
            <Label>{t('admin.integrations.gong.method_label')}</Label>
            <div className="flex flex-wrap gap-2">
              {methodButton('access_key', KeyRound, t('admin.integrations.gong.method_access_key'))}
              {methodButton('oauth', Link2, t('admin.integrations.gong.method_oauth'))}
            </div>
          </div>

          {method === 'access_key' ? (
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="gong-base-url">{t('admin.integrations.gong.base_url_label')}</Label>
                <Input id="gong-base-url" value={apiBaseUrl} placeholder={DEFAULT_GONG_API_BASE_URL} onChange={(e) => setApiBaseUrl(e.target.value)} />
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.base_url_hint')}</p>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="gong-access-key">{t('admin.integrations.gong.access_key_label')}</Label>
                <Input
                  id="gong-access-key"
                  autoComplete="off"
                  value={accessKey}
                  placeholder={summary?.authMethod === 'access_key' && summary.credentialHint ? t('admin.integrations.gong.on_file', { hint: summary.credentialHint }) : ''}
                  onChange={(e) => setAccessKey(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="gong-access-secret">{t('admin.integrations.gong.access_key_secret_label')}</Label>
                <Input id="gong-access-secret" type="password" autoComplete="off" value={accessKeySecret} onChange={(e) => setAccessKeySecret(e.target.value)} />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 sm:col-span-2">{t('admin.integrations.gong.access_key_hint')}</p>
            </div>
          ) : (
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="gong-client-id">{t('admin.integrations.gong.client_id_label')}</Label>
                <Input id="gong-client-id" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="gong-client-secret">{t('admin.integrations.gong.client_secret_label')}</Label>
                <Input
                  id="gong-client-secret"
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  placeholder={summary?.oauth.clientSecretOnFile ? t('admin.integrations.gong.secret_on_file') : ''}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label>{t('admin.integrations.gong.redirect_uri_label')}</Label>
                {summary?.oauth.redirectUri ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">{summary.oauth.redirectUri}</code>
                    <Button size="sm" variant="outline" onClick={() => { void copyRedirect(summary.oauth.redirectUri ?? '') }}>
                      <Copy className="mr-1 h-3.5 w-3.5" />
                      {copied ? t('admin.integrations.gong.copied') : t('admin.integrations.gong.copy')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{t('admin.integrations.gong.redirect_uri_missing')}</p>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.oauth_hint')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <Button
                  size="sm"
                  onClick={() => { window.location.href = '/auth/gong' }}
                  disabled={!oauthReady || busy !== null || summary?.authMethod !== 'oauth'}
                  title={oauthReady && summary?.authMethod === 'oauth' ? undefined : t('admin.integrations.gong.connect_needs_save')}
                >
                  <Link2 className="mr-1 h-3.5 w-3.5" />
                  {summary?.oauth.connected ? t('admin.integrations.gong.reconnect') : t('admin.integrations.gong.connect')}
                </Button>
                {summary?.oauth.connected && summary.oauth.connectedAt && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.connected_at', { when: when(summary.oauth.connectedAt) })}</span>
                )}
              </div>
              {summary?.authMethod === 'oauth' && summary.apiBaseUrl && summary.oauth.connected && (
                <p className="text-xs text-gray-500 dark:text-gray-400 sm:col-span-2">{t('admin.integrations.gong.tenant_host', { host: summary.apiBaseUrl })}</p>
              )}
            </div>
          )}

          <div className="flex max-w-xs flex-col gap-1">
            <Label htmlFor="gong-cache-days">{t('admin.integrations.gong.cache_days_label')}</Label>
            <Input
              id="gong-cache-days"
              type="number"
              min={GONG_TRANSCRIPT_CACHE_DAYS_MIN}
              max={GONG_TRANSCRIPT_CACHE_DAYS_MAX}
              value={cacheDays}
              onChange={(e) => setCacheDays(e.target.value)}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.cache_days_hint', { min: GONG_TRANSCRIPT_CACHE_DAYS_MIN, max: GONG_TRANSCRIPT_CACHE_DAYS_MAX })}</p>
          </div>

          {configured && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                  <LayoutGrid className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                  {t('admin.integrations.gong.workspaces_title')}
                </p>
                <Button size="sm" variant="outline" onClick={() => { void loadWorkspaces() }} disabled={busy !== null}>
                  {busy === 'workspaces' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  {t('admin.integrations.gong.load_workspaces')}
                </Button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.workspaces_hint')}</p>
              {workspaces === null ? (
                selectedWorkspaces.length > 0 && (
                  <p className="text-xs text-gray-600 dark:text-gray-300">{t('admin.integrations.gong.workspaces_selected', { n: selectedWorkspaces.length })}</p>
                )
              ) : workspaces.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.workspaces_none')}</p>
              ) : (
                <ul className="grid gap-1 sm:grid-cols-2">
                  {workspaces.map((w) => (
                    <li key={w.id}>
                      <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                        <input
                          type="checkbox"
                          checked={selectedWorkspaces.includes(w.id)}
                          onChange={() => toggleWorkspace(w.id)}
                          className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600"
                        />
                        {w.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!configured && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                <KeyRound className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                {t('admin.integrations.gong.scopes_title')}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.scopes_hint')}</p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {GONG_CAPABILITY_KEYS.map((key) => (
                  <li key={key} className="text-xs text-gray-700 dark:text-gray-300">
                    {t(`admin.integrations.gong.cap.${key}`)}
                    {!REQUIRED_GONG_CAPABILITIES.has(key) && <span className="ml-1 text-gray-400 dark:text-gray-500">({t('admin.integrations.gong.optional')})</span>}
                    <code className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">{GONG_CAPABILITY_SCOPES[key]}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => { void save() }} disabled={!cacheDaysValid || busy !== null}>
              {busy === 'save' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { void runCheck() }} disabled={!configured || busy !== null}>
              {busy === 'check' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Activity className="mr-1 h-3.5 w-3.5" />}
              {t('admin.integrations.gong.check')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { void syncUsers() }} disabled={!configured || busy !== null}>
              {busy === 'users' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              {t('admin.integrations.gong.sync_users')}
            </Button>
            {(configured || summary?.credentialHint || summary?.oauth.clientId) && (
              <Button size="sm" variant="outline" onClick={() => { void remove() }} disabled={busy !== null}>
                {busy === 'remove' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                {t('admin.integrations.gong.remove')}
              </Button>
            )}
          </div>

          {configured && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.gong.check_title')}</p>
                {check && (
                  <Badge variant={check.ready ? 'success' : 'destructive'} className="inline-flex items-center gap-1">
                    {check.ready ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                    {check.ready ? t('admin.integrations.gong.ready') : t('admin.integrations.gong.not_ready')}
                  </Badge>
                )}
              </div>
              {!check ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.check_none')}</p>
              ) : (
                <>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.checked_at', { when: when(check.checkedAt) })}</p>
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {check.capabilities.map((c) => (
                      <li key={c.key} className="flex items-start gap-1.5 text-xs text-gray-700 dark:text-gray-300" title={t(`admin.integrations.gong.status_${c.status}`)}>
                        <span className="mt-0.5"><StatusIcon status={c.status} /></span>
                        <span>
                          {t(`admin.integrations.gong.cap.${c.key}`)}
                          {!c.required && <span className="ml-1 text-gray-400 dark:text-gray-500">({t('admin.integrations.gong.optional')})</span>}
                          <code className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">{c.scope}</code>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {configured && users && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Users className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                {t('admin.integrations.gong.users_title')}
              </p>
              {!users.lastSyncedAt ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.users_none')}</p>
              ) : (
                <>
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    {t('admin.integrations.gong.users_summary', { n: users.gongUsers, when: when(users.lastSyncedAt) })}
                    {' '}
                    {t('admin.integrations.gong.matched', { n: users.matchedUsers })}
                  </p>
                  {users.unmatchedUsers.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{t('admin.integrations.gong.unmatched_title', { n: users.unmatchedUsers.length })}</p>
                      <ul className="flex flex-col gap-0.5">
                        {users.unmatchedUsers.slice(0, UNMATCHED_SHOWN).map((u) => (
                          <li key={u.id} className="text-xs text-gray-600 dark:text-gray-400">{u.displayName} <span className="text-gray-400 dark:text-gray-500">{u.email}</span></li>
                        ))}
                      </ul>
                      {users.unmatchedUsers.length > UNMATCHED_SHOWN && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.gong.unmatched_more', { n: users.unmatchedUsers.length - UNMATCHED_SHOWN })}</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {configured && summary && <GongTranscriptSettings summary={summary} onSummary={adopt} />}
        </>
      )}
    </CollapsibleCard>
  )
}
