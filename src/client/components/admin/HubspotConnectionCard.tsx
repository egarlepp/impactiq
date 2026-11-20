import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, AlertCircle, CheckCircle2, ChevronDown, ChevronUp, CircleHelp, Database, KeyRound, Lock, RefreshCw, Save,
  Settings as SettingsIcon, ShieldCheck, ShieldAlert, Trash2, Users, XCircle,
} from 'lucide-react'
import { api } from '../../lib/api.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { CrmLockedOutNote, InactiveCrmNote, useCrmLockedOut } from './CrmProviderCard.js'
import { HubspotDealEditSection } from './HubspotDealEditSection.js'
import { useCrmProvider } from '../../store/crmProvider.js'
import {
  HUBSPOT_CAPABILITY_KEYS,
  HUBSPOT_CAPABILITY_SCOPES,
  REQUIRED_HUBSPOT_CAPABILITIES,
  type HubspotCapabilityReport,
  type HubspotCapabilityStatus,
  type HubspotConnectionSummary,
} from '../../../shared/hubspot.js'

const UNMATCHED_SHOWN = 20

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function StatusIcon({ status }: { status: HubspotCapabilityStatus }) {
  if (status === 'ok') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
  if (status === 'missing') return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
  return <CircleHelp className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
}

// Admin → Integrations → HubSpot (HubSpot plan, phase 2a): the portal's
// service key or private app token, a check of what it can do, and the owner
// list users are matched to by email. Always listed, laid out like the other
// integration cards, so HubSpot can be connected and checked before it is
// chosen as the CRM.
export function HubspotConnectionCard({ onChanged }: { onChanged?: () => void }) {
  const { t, i18n } = useTranslation()
  // v1.437.1: owners only sync while HubSpot is the active CRM.
  const hubspotActive = useCrmProvider() === 'hubspot'
  const [summary, setSummary] = useState<HubspotConnectionSummary | null>(null)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'check' | 'owners' | 'remove' | null>(null)
  const [open, setOpen] = useState(false)
  // Can't be set up while the install is locked to another CRM.
  const lockedOut = useCrmLockedOut('hubspot')

  useEffect(() => {
    void api.get<HubspotConnectionSummary>('/api/admin/integrations/hubspot').then((res) => {
      if (res.error) setError(res.error)
      else setSummary(res.data ?? null)
    })
  }, [])

  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language)

  async function save() {
    setBusy('save')
    setError(null)
    const res = await api.put<HubspotConnectionSummary>('/api/admin/integrations/hubspot', { accessToken: token.trim() })
    setBusy(null)
    if (res.error || !res.data) { setError(res.error ?? t('errors.network')); return }
    setSummary(res.data)
    setToken('')
    onChanged?.()
  }

  async function check() {
    setBusy('check')
    setError(null)
    const res = await api.post<HubspotCapabilityReport>('/api/admin/integrations/hubspot/test', {})
    setBusy(null)
    if (res.error || !res.data) { setError(res.error ?? t('errors.network')); return }
    const report = res.data
    setSummary((s) => (s ? { ...s, lastCheck: report } : s))
  }

  async function syncOwners() {
    setBusy('owners')
    setError(null)
    const res = await api.post<HubspotConnectionSummary>('/api/admin/integrations/hubspot/sync-owners', {})
    setBusy(null)
    if (res.error || !res.data) { setError(res.error ?? t('errors.network')); return }
    setSummary(res.data)
  }

  async function remove() {
    if (!window.confirm(t('admin.integrations.hubspot.remove_confirm'))) return
    setBusy('remove')
    setError(null)
    const res = await api.delete<{ ok: boolean }>('/api/admin/integrations/hubspot')
    setBusy(null)
    if (res.error) { setError(res.error); return }
    const refreshed = await api.get<HubspotConnectionSummary>('/api/admin/integrations/hubspot')
    setSummary(refreshed.data ?? null)
    onChanged?.()
  }

  const configured = !!summary?.configured
  const check_ = summary?.lastCheck ?? null
  const owners = summary?.owners ?? null

  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <div className={`rounded-md p-2 ${configured ? 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
            <Database className="h-4 w-4" />
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.hubspot.title')}</p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.description')}</p>
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
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
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
          <CrmLockedOutNote crm="hubspot" lockedTo={lockedOut} />
        </div>
      )}
      {open && !lockedOut && (
      <div className="flex flex-col gap-4 border-t border-gray-200 px-5 pb-5 pt-4 dark:border-gray-700">
      <InactiveCrmNote crm="hubspot" />

      {error && <ErrorBox message={error} />}

      {!summary && !error ? (
        <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
      ) : (
        <>
          {configured && summary && (
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {summary.portalId !== null
                ? t('admin.integrations.hubspot.portal_line', { id: summary.portalId, name: summary.portalName ?? summary.uiDomain ?? '—', type: summary.accountType ?? '—' })
                : t('admin.integrations.hubspot.portal_unknown')}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <Label htmlFor="hubspot-token">{t('admin.integrations.hubspot.token_label')}</Label>
            <Input
              id="hubspot-token"
              type="password"
              autoComplete="off"
              className="max-w-md"
              value={token}
              placeholder={summary?.tokenHint ? t('admin.integrations.hubspot.token_on_file', { hint: summary.tokenHint }) : t('admin.integrations.hubspot.token_placeholder')}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.token_hint')}</p>
          </div>

          {!configured && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                <KeyRound className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                {t('admin.integrations.hubspot.scopes_title')}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.scopes_hint')}</p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {HUBSPOT_CAPABILITY_KEYS.map((key) => (
                  <li key={key} className="text-xs text-gray-700 dark:text-gray-300">
                    {t(`admin.integrations.hubspot.cap.${key}`)}
                    {!REQUIRED_HUBSPOT_CAPABILITIES.has(key) && <span className="ml-1 text-gray-400 dark:text-gray-500">({t('admin.integrations.hubspot.optional')})</span>}
                    <code className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">{HUBSPOT_CAPABILITY_SCOPES[key]}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => { void save() }} disabled={token.trim() === '' || busy !== null}>
              {busy === 'save' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { void check() }} disabled={!configured || busy !== null}>
              {busy === 'check' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Activity className="mr-1 h-3.5 w-3.5" />}
              {t('admin.integrations.hubspot.check')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { void syncOwners() }} disabled={!configured || !hubspotActive || busy !== null}
              title={hubspotActive ? undefined : t('errors.hubspot.owner_sync_inactive_crm')}>
              {busy === 'owners' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              {t('admin.integrations.hubspot.sync_owners')}
            </Button>
            {configured && (
              <Button size="sm" variant="outline" onClick={() => { void remove() }} disabled={busy !== null}>
                {busy === 'remove' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                {t('admin.integrations.hubspot.remove')}
              </Button>
            )}
          </div>

          {configured && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.hubspot.check_title')}</p>
                {check_ && (
                  <Badge variant={check_.ready ? 'success' : 'destructive'} className="inline-flex items-center gap-1">
                    {check_.ready ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                    {check_.ready ? t('admin.integrations.hubspot.ready') : t('admin.integrations.hubspot.not_ready')}
                  </Badge>
                )}
              </div>
              {!check_ ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.check_none')}</p>
              ) : (
                <>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.checked_at', { when: when(check_.checkedAt) })}</p>
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {check_.capabilities.map((c) => (
                      <li key={c.key} className="flex items-start gap-1.5 text-xs text-gray-700 dark:text-gray-300" title={t(`admin.integrations.hubspot.status_${c.status}`)}>
                        <span className="mt-0.5"><StatusIcon status={c.status} /></span>
                        <span>
                          {t(`admin.integrations.hubspot.cap.${c.key}`)}
                          {!c.required && <span className="ml-1 text-gray-400 dark:text-gray-500">({t('admin.integrations.hubspot.optional')})</span>}
                          <code className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">{c.scope}</code>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {configured && <HubspotDealEditSection />}

          {configured && owners && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                <Users className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                {t('admin.integrations.hubspot.owners_title')}
              </p>
              {!owners.lastSyncedAt ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.owners_none')}</p>
              ) : (
                <>
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    {t('admin.integrations.hubspot.owners_summary', { n: owners.owners, when: when(owners.lastSyncedAt) })}
                    {' '}
                    {t('admin.integrations.hubspot.matched', { n: owners.matchedUsers })}
                  </p>
                  {owners.unmatchedUsers.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{t('admin.integrations.hubspot.unmatched_title', { n: owners.unmatchedUsers.length })}</p>
                      <ul className="flex flex-col gap-0.5">
                        {owners.unmatchedUsers.slice(0, UNMATCHED_SHOWN).map((u) => (
                          <li key={u.id} className="text-xs text-gray-600 dark:text-gray-400">{u.displayName} <span className="text-gray-400 dark:text-gray-500">{u.email}</span></li>
                        ))}
                      </ul>
                      {owners.unmatchedUsers.length > UNMATCHED_SHOWN && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.hubspot.unmatched_more', { n: owners.unmatchedUsers.length - UNMATCHED_SHOWN })}</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
      </div>
      )}
    </div>
  )
}
