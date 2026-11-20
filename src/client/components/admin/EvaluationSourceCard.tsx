import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  Activity, AlertCircle, Ban, BookOpenCheck, CheckCircle2, ClipboardCheck, Cloud, ExternalLink, Layers, Lock, Plug, PlugZap, Save, Search, Trash2, Unlock, type LucideIcon,
} from 'lucide-react'
import { api } from '../../lib/api.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Spinner } from '../ui/spinner.js'
import { CollapsibleCard } from './CollapsibleCard.js'
import { howToUseHref } from '../../lib/howToUse.js'
import { CriteriaIqLiveRefresh, type CriteriaIqLiveRefreshSummary } from './CriteriaIqLiveRefresh.js'
import { evaluationSourceChangeAllowed, type EvaluationSourceId, type EvaluationSourceSetting } from '../../../shared/evaluationSource.js'
import { setEvaluationSourceState } from '../../store/evaluationSource.js'

interface EvaluationSourceState extends EvaluationSourceSetting {
  available: EvaluationSourceId[]
  secondaryAvailable: boolean
  criteriaiqConfigured: boolean
  projectLinks: number
  locked: boolean
}

interface CriteriaIqSummary {
  configured: boolean
  baseUrl: string | null
  allowPrivateNetwork: boolean
  apiKeyHint: string | null
  liveRefresh: CriteriaIqLiveRefreshSummary
}

interface CriteriaIqProject {
  id: number
  name: string
  customerName: string | null
  opportunityName: string | null
  status: string | null
  url: string
}

const OPTIONS: Array<{ id: EvaluationSourceId; icon: LucideIcon }> = [
  { id: 'crm', icon: Cloud },
  { id: 'criteriaiq', icon: ClipboardCheck },
  { id: 'off', icon: Ban },
]

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

// Admin → Integrations → Projects (Evaluations). Where activities' Projects
// come from (the CRM's Evaluation object, CriteriaIQ, or off), whether
// CriteriaIQ also runs beside the CRM object, and the CriteriaIQ connection.
// The primary source is locked once activities link to Projects.
export function EvaluationSourceCard() {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<EvaluationSourceState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const [cfg, setCfg] = useState<CriteriaIqSummary | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [allowPrivate, setAllowPrivate] = useState(false)
  const [connError, setConnError] = useState<string | null>(null)
  const [connBusy, setConnBusy] = useState<'save' | 'test' | 'remove' | null>(null)
  const [testOk, setTestOk] = useState(false)

  const [recordId, setRecordId] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [matches, setMatches] = useState<CriteriaIqProject[] | null>(null)

  async function loadState() {
    const res = await api.get<EvaluationSourceState>('/api/admin/integrations/evaluation-source')
    if (res.error) setError(res.error)
    else setState(res.data ?? null)
  }

  function applyCfg(summary: CriteriaIqSummary) {
    setCfg(summary)
    setBaseUrl(summary.baseUrl ?? '')
    setAllowPrivate(summary.allowPrivateNetwork)
    setApiKey('')
  }

  useEffect(() => {
    void loadState()
    void api.get<CriteriaIqSummary>('/api/admin/integrations/criteriaiq').then((res) => {
      if (res.error) setConnError(res.error)
      else if (res.data) applyCfg(res.data)
    })
  }, [])

  const name = (id: EvaluationSourceId) => t(`admin.integrations.evaluation_source.option_${id}`)

  async function change(body: { primary?: EvaluationSourceId; criteriaiqSecondary?: boolean }, key: string, confirmText: string) {
    if (!window.confirm(confirmText)) return
    setSaving(key)
    setError(null)
    const res = await api.put<EvaluationSourceState>('/api/admin/integrations/evaluation-source', body)
    setSaving(null)
    if (res.error || !res.data) { setError(res.error ?? t('errors.network')); return }
    setState(res.data)
    // Screens open in this tab (dashboard tabs, Project chips) follow at once.
    setEvaluationSourceState({ primary: res.data.primary, criteriaiqSecondary: res.data.criteriaiqSecondary })
  }

  async function saveConnection() {
    setConnBusy('save')
    setConnError(null)
    setTestOk(false)
    const res = await api.put<CriteriaIqSummary>('/api/admin/integrations/criteriaiq', {
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() || null,
      allowPrivateNetwork: allowPrivate,
    })
    setConnBusy(null)
    if (res.error || !res.data) { setConnError(res.error ?? t('errors.network')); return }
    applyCfg(res.data)
    void loadState()
  }

  async function testConnection() {
    setConnBusy('test')
    setConnError(null)
    setTestOk(false)
    const res = await api.post<{ ok: boolean }>('/api/admin/integrations/criteriaiq/test', {})
    setConnBusy(null)
    if (res.error || !res.data?.ok) { setConnError(res.error ?? t('errors.network')); return }
    setTestOk(true)
  }

  async function removeConnection() {
    if (!window.confirm(t('admin.integrations.criteriaiq.remove_confirm'))) return
    setConnBusy('remove')
    setConnError(null)
    setTestOk(false)
    const res = await api.delete<{ ok: boolean }>('/api/admin/integrations/criteriaiq')
    setConnBusy(null)
    if (res.error) { setConnError(res.error); return }
    applyCfg({ configured: false, baseUrl: null, allowPrivateNetwork: false, apiKeyHint: null, liveRefresh: { enabled: false, secretHint: null, lastWebhookAt: null } })
    setMatches(null)
    void loadState()
  }

  async function lookup() {
    setLookupBusy(true)
    setLookupError(null)
    setMatches(null)
    const res = await api.get<CriteriaIqProject[]>(`/api/admin/integrations/criteriaiq/lookup?recordId=${encodeURIComponent(recordId.trim())}`)
    setLookupBusy(false)
    if (res.error || !res.data) { setLookupError(res.error ?? t('errors.network')); return }
    setMatches(res.data)
  }

  const canSave = baseUrl.trim() !== '' && (apiKey.trim() !== '' || !!cfg?.configured)

  // Shown on the header while collapsed (collapsed by default): whether
  // Projects are on, and whether the source is locked.
  const badges = state && (
    <>
      <Badge variant={state.primary === 'off' ? 'secondary' : 'success'} className="inline-flex items-center gap-1">
        {state.primary === 'off' ? <Ban className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
        {state.primary === 'off' ? t('admin.integrations.state_inactive') : t('admin.integrations.state_active')}
      </Badge>
      <Badge variant={state.locked ? 'secondary' : 'success'} className="inline-flex items-center gap-1">
        {state.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
        {state.locked ? t('admin.integrations.evaluation_source.locked') : t('admin.integrations.evaluation_source.unlocked')}
      </Badge>
    </>
  )

  return (
    <CollapsibleCard
      icon={ClipboardCheck}
      title={t('admin.integrations.evaluation_source.title')}
      description={t('admin.integrations.evaluation_source.description')}
      badges={badges}
    >

      {error && <ErrorBox message={error} />}

      {!state && !error ? (
        <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
      ) : state && (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.evaluation_source.primary_label')}</p>
            <div className="flex flex-wrap gap-2">
              {OPTIONS.map(({ id, icon: Icon }) => {
                const current = id === state.primary
                const available = state.available.includes(id)
                const allowed = evaluationSourceChangeAllowed(state, id, state.locked)
                // CriteriaIQ as primary needs the connection below first.
                const needsConnection = id === 'criteriaiq' && !state.criteriaiqConfigured
                const reason = !available
                  ? t('admin.integrations.evaluation_source.not_available_yet')
                  : !allowed
                    ? t('admin.integrations.evaluation_source.locked_reason', { source: name(state.dataSource) })
                    : needsConnection
                      ? t('admin.integrations.evaluation_source.secondary_needs_connection')
                      : undefined
                return (
                  <Button
                    key={id}
                    size="sm"
                    variant={current ? 'default' : 'outline'}
                    disabled={!current && (!available || !allowed || needsConnection || saving !== null)}
                    title={reason}
                    aria-pressed={current}
                    onClick={() => {
                      if (current) return
                      void change({ primary: id }, `primary:${id}`, id === 'off'
                        ? t('admin.integrations.evaluation_source.off_confirm')
                        : t('admin.integrations.evaluation_source.change_confirm', { from: name(state.primary), to: name(id) }))
                    }}
                  >
                    {saving === `primary:${id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : current ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <Icon className="mr-1 h-3.5 w-3.5" />}
                    {name(id)}
                    {!available && <span className="ml-1 text-[10px] opacity-70">({t('admin.integrations.evaluation_source.coming_soon')})</span>}
                  </Button>
                )
              })}
            </div>
            <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">
              {state.locked
                ? t('admin.integrations.evaluation_source.locked_body', { source: name(state.dataSource), formatted: state.projectLinks.toLocaleString(i18n.language) })
                : t('admin.integrations.evaluation_source.unlocked_body')}
            </p>
            {state.primary === 'criteriaiq' && (
              <p className="flex max-w-prose items-start gap-1.5 rounded-md bg-blue-50 px-2.5 py-2 text-xs text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
                <ClipboardCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('admin.integrations.evaluation_source.criteriaiq_primary_body')}
              </p>
            )}
            {state.primary === 'off' && (
              <p className="flex max-w-prose items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('admin.integrations.evaluation_source.off_body')}
              </p>
            )}
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
            <div className="flex items-start gap-2">
              <Layers className="mt-0.5 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.evaluation_source.secondary_label')}</p>
                <p className="mt-0.5 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.evaluation_source.secondary_hint')}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={state.criteriaiqSecondary ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
                {state.criteriaiqSecondary ? <CheckCircle2 className="h-3 w-3" /> : <Ban className="h-3 w-3" />}
                {state.criteriaiqSecondary ? t('admin.integrations.crm_features.on') : t('admin.integrations.crm_features.off')}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={saving !== null || state.primary !== 'crm' || (!state.criteriaiqSecondary && (!state.secondaryAvailable || !state.criteriaiqConfigured))}
                title={!state.secondaryAvailable ? t('admin.integrations.evaluation_source.not_available_yet') : !state.criteriaiqConfigured ? t('admin.integrations.evaluation_source.secondary_needs_connection') : undefined}
                onClick={() => {
                  const next = !state.criteriaiqSecondary
                  void change({ criteriaiqSecondary: next }, 'secondary', t(next ? 'admin.integrations.evaluation_source.secondary_on_confirm' : 'admin.integrations.evaluation_source.secondary_off_confirm'))
                }}
              >
                {saving === 'secondary' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Layers className="mr-1 h-3.5 w-3.5" />}
                {state.criteriaiqSecondary ? t('admin.integrations.crm_features.turn_off') : t('admin.integrations.crm_features.turn_on')}
                {!state.secondaryAvailable && !state.criteriaiqSecondary && <span className="ml-1 text-[10px] opacity-70">({t('admin.integrations.evaluation_source.coming_soon')})</span>}
              </Button>
            </div>
          </div>
        </>
      )}

      <div className="flex flex-col gap-3 border-t border-gray-100 pt-4 dark:border-gray-800">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.criteriaiq.title')}</p>
            <p className="mt-0.5 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.criteriaiq.description')}</p>
            <Link
              to={howToUseHref('criteriaiq')}
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              <BookOpenCheck className="h-3.5 w-3.5" />
              {t('admin.integrations.criteriaiq.setup_guide')}
            </Link>
          </div>
          <Badge variant={cfg?.configured ? 'success' : 'secondary'} className="inline-flex shrink-0 items-center gap-1">
            {cfg?.configured ? <Plug className="h-3 w-3" /> : <PlugZap className="h-3 w-3" />}
            {cfg?.configured ? t('admin.integrations.criteriaiq.connected') : t('admin.integrations.criteriaiq.not_connected')}
          </Badge>
        </div>

        {connError && <ErrorBox message={connError} />}
        {testOk && (
          <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('admin.integrations.criteriaiq.test_ok')}</span>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="criteriaiq-url">{t('admin.integrations.criteriaiq.url_label')}</Label>
            <Input id="criteriaiq-url" type="url" value={baseUrl} placeholder={t('admin.integrations.criteriaiq.url_placeholder')} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="criteriaiq-key">{t('admin.integrations.criteriaiq.key_label')}</Label>
            <Input
              id="criteriaiq-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={cfg?.apiKeyHint ? t('admin.integrations.criteriaiq.key_on_file', { hint: cfg.apiKeyHint }) : t('admin.integrations.criteriaiq.key_placeholder')}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>
        <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.criteriaiq.key_hint')}</p>
        <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
          <input type="checkbox" className="mt-0.5" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} />
          <span>{t('admin.integrations.criteriaiq.private_network_label')}</span>
        </label>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => { void saveConnection() }} disabled={!canSave || connBusy !== null}>
            {connBusy === 'save' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
            {t('common.save')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => { void testConnection() }} disabled={!cfg?.configured || connBusy !== null}>
            {connBusy === 'test' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Activity className="mr-1 h-3.5 w-3.5" />}
            {t('admin.integrations.criteriaiq.test')}
          </Button>
          {cfg?.configured && (
            <Button size="sm" variant="outline" onClick={() => { void removeConnection() }} disabled={connBusy !== null}>
              {connBusy === 'remove' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
              {t('admin.integrations.criteriaiq.remove')}
            </Button>
          )}
        </div>

        {cfg?.configured && (
          <CriteriaIqLiveRefresh summary={cfg.liveRefresh} onChange={(liveRefresh) => setCfg((prev) => prev ? { ...prev, liveRefresh } : prev)} />
        )}

        {cfg?.configured && (
          <div className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-2.5 dark:border-gray-800">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('admin.integrations.criteriaiq.lookup_title')}</p>
            <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.criteriaiq.lookup_hint')}</p>
            <div className="flex flex-wrap gap-2">
              <Input className="max-w-xs" value={recordId} placeholder={t('admin.integrations.criteriaiq.lookup_placeholder')} onChange={(e) => setRecordId(e.target.value)} />
              <Button size="sm" variant="outline" onClick={() => { void lookup() }} disabled={recordId.trim() === '' || lookupBusy}>
                {lookupBusy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Search className="mr-1 h-3.5 w-3.5" />}
                {t('admin.integrations.criteriaiq.lookup_button')}
              </Button>
            </div>
            {lookupError && <ErrorBox message={lookupError} />}
            {matches && matches.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('admin.integrations.criteriaiq.lookup_none')}</p>
            )}
            {matches && matches.length > 0 && (
              <ul className="flex flex-col gap-1">
                {matches.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400">
                      <ExternalLink className="h-3 w-3" />
                      {p.name}
                    </a>
                    {p.customerName && <span>{p.customerName}</span>}
                    {p.status && <Badge variant="secondary">{p.status}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </CollapsibleCard>
  )
}
