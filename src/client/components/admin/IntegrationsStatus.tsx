import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { LogIn, Cloud, CalendarDays, AlertCircle, Plug, PlugZap, ChevronDown, ChevronUp, CheckCircle2, Eye, EyeOff, Mail, Save as SaveIcon, Activity as ActivityIcon, LogOut, RefreshCw, Settings as SettingsIcon, Copy, MessageSquare, Trash2, GitBranch, Lock } from 'lucide-react'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { GithubUpdatesForm } from './GithubUpdatesForm.js'
import { CrmFeaturesCard } from './CrmFeaturesCard.js'
import { CrmLockedOutNote, CrmProviderCard, InactiveCrmNote, useCrmLockedOut } from './CrmProviderCard.js'
import { EvaluationSourceCard } from './EvaluationSourceCard.js'
import { HubspotConnectionCard } from './HubspotConnectionCard.js'
import { GongConnectionCard } from './GongConnectionCard.js'
import { useCrmProvider } from '../../store/crmProvider.js'

interface AdminSfStatus {
  connected: boolean
  configured: boolean
  instanceUrl: string | null
  connectedByEmail: string | null
  connectedAt: string | null
  tokenHealthy?: boolean | null
  tokenError?: string | null
}

interface IntegrationStatuses {
  okta: { configured: boolean }
  azureSso: { configured: boolean }
  salesforce: { configured: boolean }
  microsoft: { configured: boolean }
  aiAssistant: { configured: boolean }
  smtp: { configured: boolean }
  slack: { configured: boolean }
  github: { configured: boolean }
}

interface SfConfigSummary { source: string; clientId: string; redirectUri: string; loginUrl: string; hasSecret: boolean }
interface MsConfigSummary { source: string; clientId: string; tenantId: string; hasSecret: boolean }
interface OktaConfigSummary { source: string; domain: string; clientId: string; redirectUri: string; hasSecret: boolean }
interface AzureSsoConfigSummary { source: string; tenantId: string; clientId: string; redirectUri: string; allowJit: boolean; hasSecret: boolean }
type SmtpConfigSummary =
  | {
      source: string
      authMethod: 'smtp'
      host: string
      port: number
      username: string
      fromAddress: string
      replyToAddress: string | null
      secure: boolean
      hasPassword: boolean
    }
  | {
      source: string
      authMethod: 'graph_app'
      tenantId: string
      clientId: string
      senderMailbox: string
      fromAddress: string
      replyToAddress: string | null
      hasSecret: boolean
    }

interface IntegrationConfigSummary {
  salesforce: SfConfigSummary | null
  microsoft: MsConfigSummary | null
  okta: OktaConfigSummary | null
  azureSso: AzureSsoConfigSummary | null
  smtp: SmtpConfigSummary | null
}

type IntegrationKey = 'okta' | 'azureSso' | 'salesforce' | 'microsoft' | 'smtp' | 'slack' | 'github'

interface IntegrationDef {
  key: IntegrationKey
  nameKey: string
  descKey: string
  icon: React.ComponentType<{ className?: string }>
}

const INTEGRATIONS: IntegrationDef[] = [
  { key: 'okta', nameKey: 'admin.integrations.okta.name', descKey: 'admin.integrations.okta.description', icon: LogIn },
  { key: 'azureSso', nameKey: 'admin.integrations.azure_sso.name', descKey: 'admin.integrations.azure_sso.description', icon: LogIn },
  { key: 'salesforce', nameKey: 'admin.integrations.salesforce.name', descKey: 'admin.integrations.salesforce.description', icon: Cloud },
  { key: 'microsoft', nameKey: 'admin.integrations.microsoft.name', descKey: 'admin.integrations.microsoft.description', icon: CalendarDays },
  { key: 'smtp', nameKey: 'admin.integrations.smtp.name', descKey: 'admin.integrations.smtp.description', icon: Mail },
  // v1.232.0: moved from its own standalone "Slack" admin page — see
  // SlackForm below, which talks to the same /api/admin/integrations/slack
  // endpoints the old page used, self-fetching instead of going through
  // the shared IntegrationConfigSummary (its shape — bot token status,
  // workspace URL, sync-users — doesn't fit that type).
  { key: 'slack', nameKey: 'admin.integrations.slack.name', descKey: 'admin.integrations.slack.description', icon: MessageSquare },
  // v1.332.0: App Updates — see GithubUpdatesForm.tsx, self-fetching like
  // Slack above for the same reason (owner/repo/PAT/pinned-branch doesn't
  // fit IntegrationConfigSummary).
  { key: 'github', nameKey: 'admin.integrations.github.name', descKey: 'admin.integrations.github.description', icon: GitBranch },
]

// Cards listed above the CRM group on the Integrations page; the rest of
// INTEGRATIONS (Slack, App Updates) follow the CRM group and Projects.
const BEFORE_CRM_KEYS = new Set<IntegrationKey>(['okta', 'azureSso', 'microsoft', 'smtp'])

function MaskedInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative flex items-center">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 pr-9 font-mono text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
        autoComplete="off"
      />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" tabIndex={-1}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 font-mono text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
      autoComplete="off"
    />
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 dark:text-gray-500">{hint}</p>}
    </div>
  )
}

function EnvNote({ source }: { source: string | undefined }) {
  const { t } = useTranslation()
  if (source !== 'env') return null
  return <p className="text-[10px] text-amber-600 dark:text-amber-400">{t('admin.integrations.env_source_note')}</p>
}

function TestButton({ provider, disabled, onSuccess }: { provider: string; disabled?: boolean; onSuccess?: () => void }) {
  const { t } = useTranslation()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  async function run() {
    setTesting(true); setResult(null)
    const res = await api.post<{ ok: boolean; message: string }>(`/api/admin/integrations/test/${provider}`, {})
    setTesting(false)
    if (res.error) { setResult({ ok: false, message: res.error }); return }
    const data = res.data ?? { ok: false, message: 'No response' }
    setResult(data)
    // v1.108.0: on a successful test, notify the parent so it can
    // refresh dependent status (e.g. the Admin SF token-broken banner
    // that reads from /auth/salesforce-admin/status — otherwise the
    // banner stayed red even after a green Test Connection).
    if (data.ok) onSuccess?.()
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={run} disabled={testing || disabled}>
          {testing ? <Spinner className="mr-1 h-3 w-3" /> : <ActivityIcon className="mr-1 h-3.5 w-3.5" />}
          {t('admin.integrations.test_connection')}
        </Button>
        {result && (
          <span className={result.ok ? 'text-xs text-green-600 dark:text-green-400' : 'text-xs text-red-600 dark:text-red-400'}>
            {result.ok ? '✓' : '✗'} {result.message}
          </span>
        )}
      </div>
    </div>
  )
}

function OktaForm({ existing, onSaved }: { existing: OktaConfigSummary | null; onSaved: () => void }) {
  const { t } = useTranslation()
  const [domain, setDomain] = useState(existing?.domain ?? '')
  const [clientId, setClientId] = useState(existing?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState(existing?.redirectUri ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [requirePrecreated, setRequirePrecreated] = useState<boolean>(true)
  const [policyLoaded, setPolicyLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await api.get<{ requirePrecreatedUser: boolean }>('/api/admin/auth-policy')
      if (!cancelled && res.data) {
        setRequirePrecreated(Boolean(res.data.requirePrecreatedUser))
        setPolicyLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function togglePrecreated(next: boolean) {
    setRequirePrecreated(next)
    const res = await api.put('/api/admin/auth-policy', { requirePrecreatedUser: next })
    if (res.error) {
      setErr(res.error)
      setRequirePrecreated(!next)
    }
  }

  async function save() {
    setSaving(true); setErr(null)
    const res = await api.put('/api/admin/integrations/config/okta', { domain, clientId, clientSecret, redirectUri })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    onSaved()
  }

  return (
    <div className="flex flex-col gap-3 pt-3">
      <Field label={t('admin.integrations.okta.field_domain')} hint="e.g. https://your-org.okta.com or your-org.okta.com">
        <TextInput value={domain} onChange={setDomain} placeholder="https://your-org.okta.com" />
      </Field>
      <Field label={t('admin.integrations.fields.client_id')}>
        <TextInput value={clientId} onChange={setClientId} placeholder="0oa..." />
      </Field>
      <Field label={t('admin.integrations.fields.client_secret')}>
        <MaskedInput value={clientSecret} onChange={setClientSecret} placeholder={existing?.hasSecret ? t('admin.integrations.secret_placeholder') : ''} />
      </Field>
      <Field label={t('admin.integrations.fields.redirect_uri')} hint={t('admin.integrations.fields.redirect_uri_hint')}>
        <TextInput value={redirectUri} onChange={setRedirectUri} placeholder={t('admin.integrations.fields.redirect_uri_placeholder')} />
      </Field>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || !domain || !clientId || (!existing?.hasSecret && !clientSecret) || !redirectUri}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}{t("common.save")}
        </Button>
        <EnvNote source={existing?.source} />
      </div>
      <TestButton provider="okta" disabled={!existing} />
      <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
        <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={requirePrecreated}
            disabled={!policyLoaded}
            onChange={(e) => togglePrecreated(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="font-semibold">{t('admin.integrations.okta.require_precreated_label')}</span>
            <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">
              {t('admin.integrations.okta.require_precreated_hint')}
            </span>
          </span>
        </label>
      </div>
      {!requirePrecreated && <OktaGroupMappingCard />}
    </div>
  )
}

function AzureSsoForm({ existing, onSaved }: { existing: AzureSsoConfigSummary | null; onSaved: () => void }) {
  const { t } = useTranslation()
  const [tenantId, setTenantId] = useState(existing?.tenantId ?? '')
  const [clientId, setClientId] = useState(existing?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState(existing?.redirectUri ?? `${window.location.origin}/auth/azure/callback`)
  const [allowJit, setAllowJit] = useState<boolean>(existing?.allowJit ?? false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setSaving(true); setErr(null)
    const res = await api.put('/api/admin/integrations/config/azure_sso', { tenantId, clientId, clientSecret, redirectUri, allowJit })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    onSaved()
  }

  return (
    <div className="flex flex-col gap-3 pt-3">
      <Field label={t('admin.integrations.azure_sso.field_tenant')} hint={t('admin.integrations.azure_sso.field_tenant_hint')}>
        <TextInput value={tenantId} onChange={setTenantId} placeholder="contoso.onmicrosoft.com or a tenant GUID" />
      </Field>
      <Field label={t('admin.integrations.fields.client_id')} hint={t('admin.integrations.azure_sso.field_client_hint')}>
        <TextInput value={clientId} onChange={setClientId} placeholder="Application (client) ID" />
      </Field>
      <Field label={t('admin.integrations.fields.client_secret')}>
        <MaskedInput value={clientSecret} onChange={setClientSecret} placeholder={existing?.hasSecret ? t('admin.integrations.secret_placeholder') : ''} />
      </Field>
      <Field label={t('admin.integrations.fields.redirect_uri')} hint={t('admin.integrations.azure_sso.field_redirect_hint')}>
        <TextInput value={redirectUri} onChange={setRedirectUri} placeholder={`${window.location.origin}/auth/azure/callback`} />
      </Field>
      <div className="rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
        <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={allowJit} onChange={(e) => setAllowJit(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>
            <span className="font-semibold">{t('admin.integrations.azure_sso.allow_jit_label')}</span>
            <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">{t('admin.integrations.azure_sso.allow_jit_hint')}</span>
          </span>
        </label>
      </div>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || !tenantId || !clientId || (!existing?.hasSecret && !clientSecret) || !redirectUri}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}{t('common.save')}
        </Button>
        <EnvNote source={existing?.source} />
      </div>
    </div>
  )
}

interface GroupMapping { oktaGroup: string; role: 'contributor' | 'leader' | 'team_admin'; teamId: string | null; sortOrder: number }
interface GroupSettings { groupClaimName: string; defaultRole: 'contributor' | 'leader' | 'team_admin'; defaultTeamId: string | null; requestGroupsScope: boolean }

function OktaGroupMappingCard() {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<GroupSettings>({ groupClaimName: 'groups', defaultRole: 'contributor', defaultTeamId: null, requestGroupsScope: false })
  const [mappings, setMappings] = useState<GroupMapping[]>([])
  const [teamsList, setTeamsList] = useState<{ id: string; name: string }[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [m, tms] = await Promise.all([
        api.get<{ settings: GroupSettings; mappings: GroupMapping[] }>('/api/admin/okta-group-mappings'),
        api.get<{ id: string; name: string }[]>('/api/admin/teams'),
      ])
      if (cancelled) return
      if (m.data) { setSettings(m.data.settings); setMappings(m.data.mappings) }
      if (tms.data) setTeamsList(tms.data)
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [])

  async function save() {
    setSaving(true); setErr(null)
    const res = await api.put('/api/admin/okta-group-mappings', { settings, mappings })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
  }

  function addRow() {
    setMappings((m) => [...m, { oktaGroup: '', role: 'contributor', teamId: null, sortOrder: m.length }])
  }
  function updateRow(i: number, patch: Partial<GroupMapping>) {
    setMappings((m) => m.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }
  function removeRow(i: number) {
    setMappings((m) => m.filter((_, idx) => idx !== i))
  }

  if (!loaded) return null

  return (
    <div className="mt-3 rounded border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('admin.integrations.okta.group_mapping_title')}</p>
      <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('admin.integrations.okta.group_mapping_hint')}</p>
      <label className="mt-3 flex cursor-pointer items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <input
          type="checkbox"
          checked={settings.requestGroupsScope}
          onChange={(e) => setSettings((s) => ({ ...s, requestGroupsScope: e.target.checked }))}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="font-semibold">{t('admin.integrations.okta.request_groups_label')}</span>
          <span className="mt-0.5 block text-[11px]">{t('admin.integrations.okta.request_groups_hint')}</span>
        </span>
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label={t('admin.integrations.okta.group_claim_name')}>
          <TextInput value={settings.groupClaimName} onChange={(v) => setSettings((s) => ({ ...s, groupClaimName: v }))} placeholder="groups" />
        </Field>
        <Field label={t('admin.integrations.okta.default_role')}>
          <select
            value={settings.defaultRole}
            onChange={(e) => setSettings((s) => ({ ...s, defaultRole: e.target.value as GroupSettings['defaultRole'] }))}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="contributor">Contributor</option>
            <option value="leader">Leader</option>
            <option value="team_admin">Team Admin</option>
          </select>
        </Field>
        <Field label={t('admin.integrations.okta.default_team')}>
          <select
            value={settings.defaultTeamId ?? ''}
            onChange={(e) => setSettings((s) => ({ ...s, defaultTeamId: e.target.value || null }))}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">— None —</option>
            {teamsList.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('admin.integrations.okta.group_mappings')}</p>
        {mappings.length === 0 && <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('admin.integrations.okta.no_mappings')}</p>}
        {mappings.map((m, i) => {
          const teamMissing = !!m.teamId && !teamsList.some((tm) => tm.id === m.teamId)
          const noTeam = !m.teamId && !settings.defaultTeamId
          return (
            <div key={i} className="mb-2">
              <div className="grid grid-cols-[1fr_140px_1fr_32px] items-center gap-2">
                <TextInput value={m.oktaGroup} onChange={(v) => updateRow(i, { oktaGroup: v })} placeholder="okta-group-name" />
                <select
                  value={m.role}
                  onChange={(e) => updateRow(i, { role: e.target.value as GroupMapping['role'] })}
                  className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                >
                  <option value="contributor">Contributor</option>
                  <option value="leader">Leader</option>
                  <option value="team_admin">Team Admin</option>
                </select>
                <select
                  value={m.teamId ?? ''}
                  onChange={(e) => updateRow(i, { teamId: e.target.value || null })}
                  className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                >
                  <option value="">— None —</option>
                  {teamsList.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                </select>
                <button onClick={() => removeRow(i)} className="text-gray-400 hover:text-red-600 dark:hover:text-red-400" title={t('admin.integrations.remove')}>×</button>
              </div>
              {teamMissing && (
                <div className="ml-1 mt-1 inline-block rounded bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  ⚠ {t('admin.integrations.okta.mapping_team_missing')}
                </div>
              )}
              {noTeam && (
                <div className="ml-1 mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                  {t('admin.integrations.okta.mapping_no_team_warning')}
                </div>
              )}
            </div>
          )
        })}
        <Button variant="outline" size="sm" onClick={addRow} className="mt-2">+ {t('admin.integrations.okta.add_mapping')}</Button>
      </div>

      <DryRunPanel mappings={mappings} teamsList={teamsList} defaultRole={settings.defaultRole} />

      {err && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="mt-3">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}{t('common.save')}
        </Button>
      </div>
    </div>
  )
}

function DryRunPanel({ mappings, teamsList, defaultRole }: { mappings: GroupMapping[]; teamsList: { id: string; name: string }[]; defaultRole: string }) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [result, setResult] = useState<string | null>(null)

  function run() {
    const groups = input.split(',').map((g) => g.trim()).filter(Boolean)
    const sorted = [...mappings].sort((a, b) => a.sortOrder - b.sortOrder)
    const matched = sorted.find((m) => groups.includes(m.oktaGroup))
    if (matched) {
      const teamName = matched.teamId ? teamsList.find((tm) => tm.id === matched.teamId)?.name : null
      setResult(t('admin.integrations.okta.dry_run_match', { group: matched.oktaGroup, role: matched.role, team: teamName ? ` (${teamName})` : '' }))
    } else {
      setResult(t('admin.integrations.okta.dry_run_no_match', { role: defaultRole }))
    }
  }

  return (
    <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
      <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{t('admin.integrations.okta.dry_run_title')}</p>
      <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('admin.integrations.okta.dry_run_hint')}</p>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('admin.integrations.okta.dry_run_placeholder')}
          className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <Button size="sm" variant="outline" onClick={run} disabled={!input.trim()}>
          {t('admin.integrations.okta.dry_run_button')}
        </Button>
      </div>
      {result && <p className="mt-2 text-xs text-gray-700 dark:text-gray-300">→ {result}</p>}
    </div>
  )
}

function SalesforceForm({ existing, onSaved }: { existing: SfConfigSummary | null; onSaved: () => void }) {
  const { t } = useTranslation()
  const [clientId, setClientId] = useState(existing?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState(existing?.redirectUri ?? '')
  const [loginUrl, setLoginUrl] = useState(existing?.loginUrl ?? 'https://login.salesforce.com')
  const [internalDomains, setInternalDomains] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ domains: string[] }>('/api/admin/integrations/sf-internal-domains')
      if (res.data) setInternalDomains(res.data.domains.join(', '))
    })()
  }, [])

  async function save() {
    setSaving(true); setErr(null)
    const res = await api.put('/api/admin/integrations/config/salesforce', { clientId, clientSecret, redirectUri, loginUrl })
    if (!res.error) {
      const domains = internalDomains.split(',').map((d) => d.trim()).filter(Boolean)
      await api.put('/api/admin/integrations/sf-internal-domains', { domains })
    }
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    onSaved()
  }

  return (
    <div className="flex flex-col gap-3 pt-3">
      <Field label="Consumer Key (Client ID)">
        <TextInput value={clientId} onChange={setClientId} placeholder="3MVG9..." />
      </Field>
      <Field label={t("admin.integrations.fields.consumer_secret")}>
        <MaskedInput value={clientSecret} onChange={setClientSecret} placeholder={existing?.hasSecret ? t('admin.integrations.secret_placeholder') : ''} />
      </Field>
      <Field label="Callback URL" hint="Must be registered in your Salesforce Connected App">
        <TextInput value={redirectUri} onChange={setRedirectUri} placeholder="https://impactiq.example.com/auth/salesforce/callback" />
      </Field>
      <Field label={t("admin.integrations.fields.login_url")} hint="Use https://test.salesforce.com for sandboxes">
        <TextInput value={loginUrl} onChange={setLoginUrl} placeholder="https://login.salesforce.com" />
      </Field>
      <Field label={t('admin.integrations.salesforce.internal_domains_label')} hint={t('admin.integrations.salesforce.internal_domains_hint')}>
        <TextInput value={internalDomains} onChange={setInternalDomains} placeholder="acme.com, contoso.com" />
      </Field>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || !clientId || (!existing?.hasSecret && !clientSecret) || !redirectUri}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}{t("common.save")}
        </Button>
        <EnvNote source={existing?.source} />
      </div>
      <TestButton provider="salesforce" disabled={!existing} />
    </div>
  )
}

// v1.81.0 (part 2): expose the exact Redirect URI admins must paste into
// the Azure Entra app registration. AADSTS500113 ("No reply address is
// registered") is by far the most common Outlook connect failure and the
// fix is unguessable without knowing the app's own /auth/microsoft/callback
// URL. We compute it from the current origin so it stays right across
// staging / prod tenants.
function MsRedirectUriReadout() {
  const [copied, setCopied] = useState(false)
  const uri = `${typeof window !== 'undefined' ? window.location.origin : ''}/auth/microsoft/callback`
  async function copy() {
    try {
      await navigator.clipboard.writeText(uri)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked — user can select the text */ }
  }
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-800 dark:bg-blue-950/40">
      <p className="font-medium text-blue-900 dark:text-blue-200">Redirect URI (add this to your Azure app registration)</p>
      <p className="mt-1 text-blue-800 dark:text-blue-300">
        In the Entra portal, open your app → Authentication → Add a platform → <strong>Web</strong> → paste the URI below into Redirect URIs → Configure. Then Save.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 select-all rounded border border-blue-200 bg-white px-2 py-1 font-mono text-[11px] text-blue-900 dark:border-blue-800 dark:bg-gray-900 dark:text-blue-200">{uri}</code>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

function MicrosoftForm({ existing, onSaved }: { existing: MsConfigSummary | null; onSaved: () => void }) {
  const { t } = useTranslation()
  const [clientId, setClientId] = useState(existing?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [tenantId, setTenantId] = useState(existing?.tenantId ?? '')
  const [appOnly, setAppOnly] = useState(false)
  const [forwardDays, setForwardDays] = useState<number>(30)
  const [retentionDays, setRetentionDays] = useState<number>(730)
  const [internalDomains, setInternalDomains] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ enabled: boolean }>('/api/admin/integrations/outlook-app-only')
      if (res.data) setAppOnly(res.data.enabled)
      const sync = await api.get<{ forwardDays: number; retentionDays: number; internalEmailDomains?: string[] }>('/api/admin/integrations/outlook-sync')
      if (sync.data) { setForwardDays(sync.data.forwardDays); setRetentionDays(sync.data.retentionDays); setInternalDomains((sync.data.internalEmailDomains ?? []).join(', ')) }
    })()
  }, [])

  async function save() {
    setSaving(true); setErr(null)
    const res = await api.put('/api/admin/integrations/config/microsoft', { clientId, clientSecret, tenantId })
    if (!res.error) {
      await api.put('/api/admin/integrations/outlook-app-only', { enabled: appOnly })
      await api.put('/api/admin/integrations/outlook-sync', { forwardDays: Math.round(forwardDays), retentionDays: Math.round(retentionDays), internalEmailDomains: internalDomains })
    }
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    onSaved()
  }

  return (
    <div className="flex flex-col gap-3 pt-3">
      <Field label="Application (Client) ID">
        <TextInput value={clientId} onChange={setClientId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </Field>
      <Field label={t("admin.integrations.fields.client_secret")}>
        <MaskedInput value={clientSecret} onChange={setClientSecret} placeholder={existing?.hasSecret ? t('admin.integrations.secret_placeholder') : ''} />
      </Field>
      <Field label={t("admin.integrations.fields.tenant_id")}>
        <TextInput value={tenantId} onChange={setTenantId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </Field>
      <MsRedirectUriReadout />
      {/* v1.156.0: calendar write-back permission notice. */}
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
        <p className="font-semibold">{t('admin.integrations.microsoft.writeback_title', 'Calendar write-back (optional)')}</p>
        <p className="mt-1">
          {t('admin.integrations.microsoft.writeback_hint', 'To let users write their logged activities back to their own Outlook calendar, grant the delegated Calendars.ReadWrite permission on the Azure app registration. Users must reconnect Outlook after this is added, then opt in under Settings → Connections. Reading calendars works with Calendars.Read alone.')}{' '}
          <a href="https://github.com/egarlepp/impactiq/blob/main/docs/outlook-writeback.md" target="_blank" rel="noopener noreferrer" className="underline">docs/outlook-writeback.md</a>
        </p>
      </div>
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={appOnly}
            onChange={(e) => setAppOnly(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600"
          />
          <span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.microsoft.app_only_label')}</span>
            <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">
              {t('admin.integrations.microsoft.app_only_hint')}{' '}
              <a href="https://github.com/egarlepp/impactiq/blob/main/docs/outlook-app-only.md" target="_blank" rel="noopener noreferrer" className="underline">
                docs/outlook-app-only.md
              </a>
            </span>
          </span>
        </label>
      </div>
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.microsoft.sync_settings')}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('admin.integrations.microsoft.forward_days_label')}>
            <input
              type="number" min={0} max={90} value={forwardDays}
              onChange={(e) => setForwardDays(Number(e.target.value))}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
          </Field>
          <Field label={t('admin.integrations.microsoft.retention_days_label')}>
            <input
              type="number" min={30} max={3650} value={retentionDays}
              onChange={(e) => setRetentionDays(Number(e.target.value))}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.microsoft.sync_hint')}</p>
        {/* v1.162.0: which attendee domains count as "internal" for write-back
            (internal → real Outlook invite; others → event description only). */}
        <div className="mt-3">
          <Field label={t('admin.integrations.microsoft.internal_domains_label', 'Internal email domains (write-back invites)')}>
            <input
              type="text"
              value={internalDomains}
              onChange={(e) => setInternalDomains(e.target.value)}
              placeholder="acme.com, example.com"
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
          </Field>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.microsoft.internal_domains_hint', 'Comma-separated. Attendees at these domains get a real Outlook invite when an activity is written back; everyone else is added to the event description only. Leave blank to use each user’s own login-email domain.')}</p>
        </div>
      </div>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || !clientId || (!existing?.hasSecret && !clientSecret) || !tenantId}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}{t("common.save")}
        </Button>
        <EnvNote source={existing?.source} />
      </div>
      <TestButton provider="microsoft" disabled={!existing} />
    </div>
  )
}

type AuthMethod = 'smtp' | 'graph_app'

function EmailForm({ existing, onSaved }: { existing: SmtpConfigSummary | null; onSaved: () => void }) {
  const { t } = useTranslation()
  const [authMethod, setAuthMethod] = useState<AuthMethod>(existing?.authMethod ?? 'smtp')

  // Common fields
  const [fromAddress, setFromAddress] = useState(existing?.fromAddress ?? '')
  const [replyToAddress, setReplyToAddress] = useState(existing?.replyToAddress ?? '')

  // SMTP
  const smtp = existing && existing.authMethod === 'smtp' ? existing : null
  const [host, setHost] = useState(smtp?.host ?? '')
  const [port, setPort] = useState(smtp?.port?.toString() ?? '587')
  const [username, setUsername] = useState(smtp?.username ?? '')
  const [password, setPassword] = useState('')
  const [secure, setSecure] = useState(smtp?.secure ?? false)

  // Graph App-Only
  const graph = existing && existing.authMethod === 'graph_app' ? existing : null
  const [tenantId, setTenantId] = useState(graph?.tenantId ?? '')
  const [clientId, setClientId] = useState(graph?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [senderMailbox, setSenderMailbox] = useState(graph?.senderMailbox ?? '')

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [sendingTest, setSendingTest] = useState(false)

  async function save() {
    setSaving(true); setErr(null); setSaved(false)
    const replyToNorm = replyToAddress.trim() || null
    // v1.77.0: only send clientSecret / password when the admin
    // actually typed something. Sending an empty string tripped the
    // server's "required on first save" guard even when the panel had
    // already loaded an existing secret from DB.
    const body = authMethod === 'graph_app'
      ? {
          authMethod: 'graph_app',
          tenantId,
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          senderMailbox,
          fromAddress,
          replyToAddress: replyToNorm,
        }
      : {
          authMethod: 'smtp',
          host,
          port: parseInt(port, 10),
          username,
          ...(password ? { password } : {}),
          fromAddress,
          replyToAddress: replyToNorm,
          secure,
        }
    const res = await api.put('/api/admin/integrations/config/smtp', body)
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    // v1.77.0: don't auto-close the panel. Show a Saved chip and keep
    // the admin here so they can immediately Send test email without
    // re-opening the panel. onSaved() still fires so the top-level card
    // refreshes its "Configured" pill.
    setSaved(true)
    onSaved()
    // Clear the just-typed secret so the placeholder ("saved — enter
    // new value to change") re-appears on the form.
    setClientSecret('')
    setPassword('')
  }

  async function sendTest() {
    setSendingTest(true); setTestResult(null)
    const res = await api.post<{ ok: boolean; message: string }>('/api/admin/integrations/email/send-test', { to: testTo.trim() })
    setSendingTest(false)
    if (res.error) { setTestResult({ ok: false, message: res.error }); return }
    setTestResult(res.data ?? { ok: false, message: 'No response' })
  }

  const hasExistingSecret = authMethod === 'graph_app'
    ? Boolean(graph?.hasSecret)
    : Boolean(smtp?.hasPassword)

  const canSave = authMethod === 'graph_app'
    ? !!(tenantId && clientId && senderMailbox && fromAddress && (hasExistingSecret || clientSecret))
    : !!(host && port && username && fromAddress && (hasExistingSecret || password))

  return (
    <div className="flex flex-col gap-3 pt-3">
      <Field label="Authentication method">
        <select
          value={authMethod}
          onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="smtp">SMTP relay</option>
          <option value="graph_app">Microsoft Graph API (sendMail)</option>
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="From address">
          <TextInput value={fromAddress} onChange={setFromAddress} placeholder="noreply@example.com" />
        </Field>
        <Field label="Reply-to address">
          <TextInput value={replyToAddress} onChange={setReplyToAddress} placeholder="solutionsengineering@example.com" />
        </Field>
      </div>

      {authMethod === 'graph_app' ? (
        <>
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
            <p className="font-semibold">Microsoft Graph setup (admin, one-time):</p>
            <ol className="mt-1 list-decimal pl-4">
              <li>Microsoft Entra ID → App registrations → New registration.</li>
              <li>API permissions → Microsoft Graph → Application permissions → <code>Mail.Send</code> → Grant admin consent.</li>
              <li>Add a credential: a Client secret (Certificates & secrets).</li>
              <li>Recommended: restrict the app to only the sender mailbox via an <code>Application Access Policy</code> in Exchange Online PowerShell.</li>
              <li>Ensure the sender mailbox below is a real licensed/shared mailbox in your tenant.</li>
            </ol>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("admin.integrations.fields.tenant_id")}>
              <TextInput value={tenantId} onChange={setTenantId} placeholder="00000000-0000-0000-0000-000000000000" />
            </Field>
            <Field label="Client ID (Application ID)">
              <TextInput value={clientId} onChange={setClientId} placeholder="00000000-0000-0000-0000-000000000000" />
            </Field>
          </div>
          <Field label="Sender mailbox" hint="The mailbox Graph sends as (UPN or object id). Lock the app to this mailbox with an Application Access Policy.">
            <TextInput value={senderMailbox} onChange={setSenderMailbox} placeholder="solutionsengineering@example.com" />
          </Field>
          <Field label="Client secret">
            <MaskedInput value={clientSecret} onChange={setClientSecret} placeholder={hasExistingSecret ? t('admin.integrations.secret_placeholder') : ''} />
          </Field>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Host" hint="e.g. smtp.office365.com">
              <TextInput value={host} onChange={setHost} placeholder="smtp.office365.com" />
            </Field>
            <Field label="Port" hint="465 (TLS) or 587 (STARTTLS)">
              <TextInput value={port} onChange={setPort} placeholder="587" />
            </Field>
          </div>
          <Field label="Username">
            <TextInput value={username} onChange={setUsername} placeholder="noreply@example.com" />
          </Field>
          <Field label="Password">
            <MaskedInput value={password} onChange={setPassword} placeholder={hasExistingSecret ? t('admin.integrations.secret_placeholder') : ''} />
          </Field>
          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="h-4 w-4" />
            Use TLS (port 465)
          </label>
        </>
      )}

      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || !canSave}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}{t("common.save")}
        </Button>
        {saved && !err && (
          <span className="inline-flex items-center gap-1 rounded border border-green-200 bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
            <CheckCircle2 className="h-3 w-3" />
            {t('admin.integrations.saved', 'Saved')}
          </span>
        )}
        <EnvNote source={existing?.source} />
      </div>
      <TestButton provider="smtp" disabled={!existing} />
      {/* v1.77.0: send a real test email to an arbitrary address so
          admins can verify the sender mailbox / recipient can receive
          without waiting for the daily digest. */}
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/40">
        <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">
          {t('admin.integrations.email.send_test_title', 'Send test email')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput value={testTo} onChange={setTestTo} placeholder="recipient@example.com" />
          <Button size="sm" variant="outline" onClick={sendTest} disabled={sendingTest || !testTo.includes('@') || !existing}>
            {sendingTest ? <Spinner className="mr-1 h-3 w-3" /> : <Mail className="mr-1 h-3.5 w-3.5" />}
            {t('admin.integrations.email.send_test_button', 'Send test')}
          </Button>
          {testResult && (
            <span className={testResult.ok ? 'text-xs text-green-600 dark:text-green-400' : 'text-xs text-red-600 dark:text-red-400'}>
              {testResult.ok ? '✓' : '✗'} {testResult.message}
            </span>
          )}
        </div>
        {!existing && (
          <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
            {t('admin.integrations.email.send_test_needs_save', 'Save the configuration first, then a test can be sent.')}
          </p>
        )}
      </div>
    </div>
  )
}

interface SlackSummary { configured: boolean; workspaceUrl: string | null }
interface SlackSyncResult {
  results: Array<{ email: string; slackUserId: string | null; status: 'linked' | 'unlinked' | 'skipped' | 'error'; error?: string }>
  linked: number
  unlinked: number
}

function SlackForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<SlackSummary | null>(null)
  const [botToken, setBotToken] = useState('')
  const [workspaceUrl, setWorkspaceUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SlackSyncResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function reload() {
    const res = await api.get<SlackSummary>('/api/admin/integrations/slack')
    setSummary(res.data ?? { configured: false, workspaceUrl: null })
    setWorkspaceUrl(res.data?.workspaceUrl ?? '')
  }
  useEffect(() => { void reload() }, [])

  async function save() {
    if (!botToken.trim()) return
    setSaving(true); setErr(null)
    const res = await api.put('/api/admin/integrations/slack', { botToken: botToken.trim(), workspaceUrl: workspaceUrl.trim() || null })
    setSaving(false)
    if (res.error) { setErr(res.error); return }
    setBotToken('')
    await reload()
    onSaved()
  }

  async function disconnect() {
    if (!window.confirm(t('admin.integrations.slack.disconnect_confirm'))) return
    await api.delete('/api/admin/integrations/slack')
    setSyncResult(null)
    await reload()
    onSaved()
  }

  async function syncUsers() {
    setSyncing(true); setErr(null); setSyncResult(null)
    const res = await api.post<SlackSyncResult>('/api/admin/integrations/slack/sync-users', {})
    setSyncing(false)
    if (res.error) { setErr(res.error); return }
    setSyncResult(res.data)
  }

  if (!summary) return <Spinner className="h-4 w-4" />

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="text-sm">
          <span className="text-gray-500 dark:text-gray-400">{t('admin.integrations.slack.status')}: </span>
          <span className={summary.configured ? 'text-green-700 dark:text-green-400' : 'text-gray-500'}>
            {summary.configured ? t('admin.integrations.connected') : t('admin.integrations.not_connected')}
          </span>
          {summary.workspaceUrl && <span className="ml-2 text-gray-500 dark:text-gray-400">· {summary.workspaceUrl}</span>}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('admin.integrations.slack.bot_token_label')}>
          <MaskedInput value={botToken} onChange={setBotToken} placeholder={summary.configured ? t('admin.integrations.secret_placeholder') : 'xoxb-...'} />
        </Field>
        <Field label={t('admin.integrations.slack.workspace_url_label')}>
          <TextInput value={workspaceUrl} onChange={setWorkspaceUrl} placeholder="https://your-workspace.slack.com" />
        </Field>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.slack.setup_hint')}</p>

      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving || (!botToken.trim() && !summary.configured)}>
          {saving ? <Spinner className="mr-1 h-3 w-3" /> : <SaveIcon className="mr-1 h-3.5 w-3.5" />}
          {t('common.save')}
        </Button>
        {summary.configured && (
          <>
            <Button size="sm" variant="outline" onClick={syncUsers} disabled={syncing}>
              {syncing ? <Spinner className="mr-1 h-3 w-3" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              {t('admin.integrations.slack.sync_users')}
            </Button>
            <Button size="sm" variant="outline" onClick={disconnect}>
              <Trash2 className="mr-1 h-3.5 w-3.5" />{t('admin.integrations.slack.disconnect')}
            </Button>
          </>
        )}
      </div>

      {syncResult && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800/50">
          <p className="mb-2 font-medium">{t('admin.integrations.slack.sync_summary', { linked: syncResult.linked, unlinked: syncResult.unlinked })}</p>
          <details>
            <summary className="cursor-pointer text-xs text-gray-500">{t('admin.integrations.slack.sync_details')}</summary>
            <ul className="mt-2 max-h-48 overflow-y-auto text-xs">
              {syncResult.results.map((r) => (
                <li key={r.email} className="flex gap-2">
                  <span className={`w-16 font-mono ${r.status === 'linked' ? 'text-green-600' : r.status === 'error' ? 'text-red-600' : 'text-gray-500'}`}>{r.status}</span>
                  <span>{r.email}</span>
                  {r.error && <span className="text-red-500">— {r.error}</span>}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  )
}

function IntegrationCard({
  def,
  configured,
  configData,
  onSaved,
}: {
  def: IntegrationDef
  configured: boolean
  configData: SfConfigSummary | MsConfigSummary | OktaConfigSummary | SmtpConfigSummary | null
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // The Salesforce card can't be set up while the install is locked to another CRM.
  const lockedOut = useCrmLockedOut(def.key === 'salesforce' ? 'salesforce' : null)
  const Icon = def.icon

  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <div className={`rounded-md p-2 ${configured ? 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{t(def.nameKey)}</p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t(def.descKey)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={configured ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
            {configured ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
            {configured ? t('admin.integrations.configured') : t('admin.integrations.not_configured')}
          </Badge>
          {lockedOut ? (
            <Badge variant="secondary" className="inline-flex items-center gap-1">
              <Lock className="h-3 w-3" />
              {t('admin.integrations.crm_provider.locked')}
            </Badge>
          ) : (
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <SettingsIcon className="h-3 w-3" />
              {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {t('admin.integrations.configure')}
            </button>
          )}
        </div>
      </div>

      {lockedOut && (
        <div className="px-5 pb-5">
          <CrmLockedOutNote crm="salesforce" lockedTo={lockedOut} />
        </div>
      )}
      {open && !lockedOut && (
        <div className="border-t border-gray-200 px-5 pb-5 dark:border-gray-700">
          {def.key === 'salesforce' && <div className="pt-4"><InactiveCrmNote crm="salesforce" /></div>}
          {def.key === 'okta' && (
            <OktaForm existing={configData as OktaConfigSummary | null} onSaved={() => { onSaved(); setOpen(false) }} />
          )}
          {def.key === 'azureSso' && (
            <AzureSsoForm existing={configData as AzureSsoConfigSummary | null} onSaved={() => { onSaved(); setOpen(false) }} />
          )}
          {def.key === 'salesforce' && (
            <SalesforceForm existing={configData as SfConfigSummary | null} onSaved={() => { onSaved(); setOpen(false) }} />
          )}
          {def.key === 'microsoft' && (
            <MicrosoftForm existing={configData as MsConfigSummary | null} onSaved={() => { onSaved(); setOpen(false) }} />
          )}
          {def.key === 'smtp' && (
            <EmailForm existing={configData as SmtpConfigSummary | null} onSaved={() => { onSaved() }} />
          )}
          {def.key === 'slack' && (
            <SlackForm onSaved={() => { onSaved() }} />
          )}
          {def.key === 'github' && (
            <GithubUpdatesForm onSaved={() => { onSaved() }} />
          )}
        </div>
      )}
    </div>
  )
}

export function IntegrationsStatus() {
  const { t } = useTranslation()
  // Every CRM's connection card is always listed, so a CRM can be set up
  // before or after it's chosen. The admin Salesforce connection only shows
  // while Salesforce is the CRM: its OAuth routes refuse otherwise.
  const sfIsCrm = useCrmProvider() === 'salesforce'
  // Bumped when a CRM connection is saved or cleared, so the CRM card's
  // "not configured" warning refreshes.
  const [crmConfigVersion, setCrmConfigVersion] = useState(0)
  const [statuses, setStatuses] = useState<IntegrationStatuses | null>(null)
  const [config, setConfig] = useState<IntegrationConfigSummary | null>(null)
  const [adminSf, setAdminSf] = useState<AdminSfStatus | null>(null)
  const [disconnectingAdminSf, setDisconnectingAdminSf] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function loadAll() {
    const [statusRes, cfgRes, sfRes] = await Promise.all([
      api.get<IntegrationStatuses>('/api/admin/integrations/status'),
      api.get<IntegrationConfigSummary>('/api/admin/integrations/config'),
      api.get<AdminSfStatus>('/auth/salesforce-admin/status'),
    ])
    if (statusRes.error) setError(statusRes.error)
    else setStatuses(statusRes.data ?? null)
    setConfig(cfgRes.data ?? null)
    setAdminSf(sfRes.data ?? null)
    setLoading(false)
    setCrmConfigVersion((v) => v + 1)
  }

  useEffect(() => { void loadAll() }, [])

  async function disconnectAdminSf() {
    if (!window.confirm(t('admin.integrations.admin_sf_disconnect_confirm'))) return
    setDisconnectingAdminSf(true)
    await api.post('/auth/salesforce-admin/disconnect', {})
    setDisconnectingAdminSf(false)
    await loadAll()
  }

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  if (error || !statuses) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{error ?? t('errors.network')}</span>
      </div>
    )
  }

  const card = (def: IntegrationDef) => (
    <IntegrationCard
      key={def.key}
      def={def}
      configured={statuses[def.key].configured}
      configData={config && def.key !== 'slack' && def.key !== 'github' ? config[def.key as keyof IntegrationConfigSummary] : null}
      onSaved={loadAll}
    />
  )
  const salesforceDef = INTEGRATIONS.find((d) => d.key === 'salesforce')!

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('admin.integrations.description')}</p>


      {/* Order: SSO and Microsoft/email first, then the CRM group and
          Projects, then Slack and App Updates. Rate Limiting renders after
          this component on the Integrations page. */}
      <div className="flex flex-col gap-4">
        {INTEGRATIONS.filter((def) => BEFORE_CRM_KEYS.has(def.key)).map(card)}
      </div>

      {/* The CRM group: choosing the CRM, every CRM's connection card (all
          listed whichever is chosen, so each can be set up first), the admin
          Salesforce connection, and CRM features. Expands and collapses as
          one card. */}
      <CrmProviderCard refreshKey={crmConfigVersion}>
        {card(salesforceDef)}
        <HubspotConnectionCard onChanged={() => setCrmConfigVersion((v) => v + 1)} />
        {/* Admin Salesforce connection — metadata introspection for config dropdowns */}
        {sfIsCrm && statuses.salesforce.configured && (
          <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            {/* v1.73.0: token-health banner. When the stored admin SF
                token can no longer describe (revoked, expired), SF-backed
                dropdowns silently break across the app. This surfaces
                the root cause and points admins at Reconnect. */}
            {adminSf?.connected && adminSf.tokenHealthy === false && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold">{t('admin.integrations.admin_sf.token_broken_title', 'Admin Salesforce token is not working')}</p>
                  <p className="mt-0.5">{t('admin.integrations.admin_sf.token_broken_body', 'SF-backed dropdowns and lookups across the app will silently return empty until this is fixed. Click Reconnect to re-authorize.')}</p>
                  {adminSf.tokenError && (
                    <p className="mt-1 font-mono text-[10px]">{adminSf.tokenError}</p>
                  )}
                </div>
                <Button size="sm" variant="outline" onClick={() => { window.location.href = '/auth/salesforce-admin' }}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  {t('admin.integrations.admin_sf.reconnect', 'Reconnect')}
                </Button>
              </div>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className={`rounded-md p-2 ${adminSf?.connected ? 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                  {adminSf?.connected ? <PlugZap className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
                </div>
                <div>
                  <p className="font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.admin_sf.name')}</p>
                  <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.integrations.admin_sf.description')}
                  </p>
                  {adminSf?.connected && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                      {adminSf.instanceUrl && <span className="font-mono">{adminSf.instanceUrl}</span>}
                      {adminSf.connectedByEmail && (
                        <span>{t('admin.integrations.admin_sf.connected_by', { email: adminSf.connectedByEmail })}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={adminSf?.connected ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
                  {adminSf?.connected ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                  {adminSf?.connected ? t('admin.integrations.connected') : t('admin.integrations.not_connected')}
                </Badge>
                {adminSf?.connected ? (
                  <>
                    <TestButton provider="admin-salesforce" onSuccess={() => { void loadAll() }} />
                    <Button variant="outline" size="sm" onClick={() => { window.location.href = '/auth/salesforce-admin' }} title={t('admin.integrations.admin_sf.reconnect_tip', 'Re-run the admin Salesforce OAuth flow to refresh the token')}>
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                      {t('admin.integrations.admin_sf.reconnect', 'Reconnect')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={disconnectAdminSf} disabled={disconnectingAdminSf}>
                      {disconnectingAdminSf ? <Spinner className="mr-1 h-3 w-3" /> : <LogOut className="mr-1 h-3.5 w-3.5" />}
                      {t('admin.integrations.admin_sf.disconnect')}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => { window.location.href = '/auth/salesforce-admin' }}>
                    <Plug className="mr-1 h-3.5 w-3.5" />
                    {t('admin.integrations.admin_sf.connect')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
        <CrmFeaturesCard />
      </CrmProviderCard>

      <EvaluationSourceCard />

      <GongConnectionCard />

      <div className="flex flex-col gap-4">
        {INTEGRATIONS.filter((def) => def.key !== 'salesforce' && !BEFORE_CRM_KEYS.has(def.key)).map(card)}
      </div>
    </div>
  )
}
