import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  CircleSlash,
  ClipboardCheck,
  Link as LinkIcon,
  ListChecks,
  MessageSquare,
  NotebookPen,
  Pencil,
  Plug,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Route,
  Save,
  Sparkles,
  Star,
  Trash2,
  Wallet,
  X,
  XCircle,
} from 'lucide-react'
import { api, localizeError } from '../../../lib/api.js'
import { formatDateTimeInTZ } from '../../../lib/tz.js'
import { Badge } from '../../ui/badge.js'
import { Button } from '../../ui/button.js'
import { Input } from '../../ui/input.js'
import { Label } from '../../ui/label.js'
import { Select } from '../../ui/select.js'
import { Spinner } from '../../ui/spinner.js'
import {
  AI_FEATURES,
  AI_PROVIDER_DEFAULT_NAMES,
  isAiProviderKind,
  showFeatureRouting,
  type AiFeature,
  type AiModelsResult,
  type AiProviderKind,
} from '../../../../shared/ai.js'
import { FEATURE_ICONS, StatusPill, usd } from './aiUsageShared.js'
import { AiUsagePanel } from './AiUsagePanel.js'
import {
  AiProviderFields,
  aiProviderDraftBody,
  aiProviderDraftComplete,
  emptyAiProviderDraft,
  type AiProviderDraft,
} from './AiProviderFields.js'
import { AiProviderLogo } from './AiProviderLogo.js'

// Admin → Integrations → AI Assistant (CLAUDE.md §14). The master switch, the
// monthly budget, the providers (one is the default), which provider each AI
// feature uses once there are two or more, and what the AI has cost this month.

interface ProviderView {
  id: string
  kind: AiProviderKind
  name: string
  isActive: boolean
  isDefault: boolean
  model: string
  hasSecret: boolean
  endpoint: string | null
  apiVersion: string | null
  allowedCustomHost: string | null
  region: string | null
  accessKeyId: string | null
  resource: string | null
  organization: string | null
  allowPrivateNetwork: boolean
  inputPricePerMTok: number | null
  outputPricePerMTok: number | null
  priceKnown: boolean
  lastTestedAt: string | null
  lastTestOk: boolean | null
  lastTestMessage: string | null
}

interface MonthByProvider {
  providerId: string | null
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

interface AiAdminState {
  settings: { enabled: boolean; monthlyBudgetUsd: number | null; disabledFeatures: AiFeature[] }
  providers: ProviderView[]
  routes: Partial<Record<AiFeature, string>>
  month: { spentUsd: number; budgetReached: boolean; byProvider: MonthByProvider[] }
}

interface FormState {
  id: string | null
  name: string
  isActive: boolean
  draft: AiProviderDraft
  inputPrice: string
  outputPrice: string
  hasSecret: boolean
  // The prices were filled from the fetched model list, not typed, so a
  // model change may replace them. Typing a price turns this off.
  pricesAuto: boolean
}

function priceOrNull(v: string): number | null {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function formFor(p: ProviderView | null): FormState {
  if (!p) {
    const draft = emptyAiProviderDraft('anthropic')
    return { id: null, name: AI_PROVIDER_DEFAULT_NAMES.anthropic, isActive: true, draft, inputPrice: '', outputPrice: '', hasSecret: false, pricesAuto: false }
  }
  return {
    id: p.id,
    name: p.name,
    isActive: p.isActive,
    draft: {
      kind: p.kind,
      model: p.model,
      secret: '',
      endpoint: p.endpoint ?? '',
      apiVersion: p.apiVersion ?? '',
      allowedCustomHost: p.allowedCustomHost ?? '',
      region: p.region ?? '',
      accessKeyId: p.accessKeyId ?? '',
      resource: p.resource ?? '',
      organization: p.organization ?? '',
      allowPrivateNetwork: p.allowPrivateNetwork,
      clearSecret: false,
    },
    inputPrice: p.inputPricePerMTok == null ? '' : String(p.inputPricePerMTok),
    outputPrice: p.outputPricePerMTok == null ? '' : String(p.outputPricePerMTok),
    hasSecret: p.hasSecret,
    pricesAuto: false,
  }
}

// Fills the price fields from the fetched list for the form's model, unless
// the admin typed their own prices.
function withCatalogPrice(f: FormState, models: AiModelsResult | null): FormState {
  if (!models) return f
  const blank = !f.inputPrice.trim() && !f.outputPrice.trim()
  if (!blank && !f.pricesAuto) return f
  const price = models.models.find((m) => m.id === f.draft.model.trim())?.price ?? null
  if (!price) return f.pricesAuto ? { ...f, inputPrice: '', outputPrice: '' } : f
  return { ...f, inputPrice: String(price.inputPerMTok), outputPrice: String(price.outputPerMTok), pricesAuto: true }
}

const CARD = 'flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900'

export function AiAssistantConfig() {
  const { t } = useTranslation()
  const [state, setState] = useState<AiAdminState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [budgetText, setBudgetText] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [routesDraft, setRoutesDraft] = useState<Partial<Record<AiFeature, string>>>({})
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [models, setModels] = useState<AiModelsResult | null>(null)

  const load = useCallback(async () => {
    const res = await api.get<AiAdminState>('/api/admin/ai')
    if (res.error || !res.data) { setError(localizeError(res.error) ?? t('errors.network')); return }
    setState(res.data)
    setBudgetText(res.data.settings.monthlyBudgetUsd == null ? '' : String(res.data.settings.monthlyBudgetUsd))
    setRoutesDraft(res.data.routes)
  }, [t])

  useEffect(() => { void load() }, [load])

  async function run(key: string, fn: () => Promise<{ error?: string | null }>): Promise<boolean> {
    setBusy(key)
    setError(null)
    const res = await fn()
    setBusy(null)
    if (res.error) { setError(localizeError(res.error) ?? t('errors.network')); return false }
    await load()
    return true
  }

  async function toggleEnabled() {
    if (!state) return
    const next = !state.settings.enabled
    if (!window.confirm(t(next ? 'ai_assistant.enable_confirm' : 'ai_assistant.disable_confirm'))) return
    await run('enabled', () => api.put('/api/admin/ai/settings', { enabled: next }))
  }

  // v1.468.0: turn one feature's AI use on or off; it saves right away.
  async function toggleFeature(feature: AiFeature) {
    if (!state) return
    const off = new Set(state.settings.disabledFeatures)
    if (off.has(feature)) off.delete(feature)
    else off.add(feature)
    await run(`feature:${feature}`, () => api.put('/api/admin/ai/settings', { disabledFeatures: AI_FEATURES.filter((f) => off.has(f)) }))
  }

  async function saveBudget() {
    const trimmed = budgetText.trim()
    const value = trimmed ? Number(trimmed) : null
    if (value !== null && (!Number.isFinite(value) || value < 0)) { setError(t('ai_assistant.budget_invalid')); return }
    await run('budget', () => api.put('/api/admin/ai/settings', { monthlyBudgetUsd: value }))
  }

  async function saveProvider() {
    if (!form) return
    const body = {
      ...aiProviderDraftBody(form.draft),
      name: form.name.trim(),
      isActive: form.isActive,
      inputPricePerMTok: priceOrNull(form.inputPrice),
      outputPricePerMTok: priceOrNull(form.outputPrice),
    }
    const ok = await run('form', () => (form.id
      ? api.patch(`/api/admin/ai/providers/${form.id}`, body)
      : api.post('/api/admin/ai/providers', body)))
    if (ok) setForm(null)
  }

  function openForm(next: FormState | null) {
    setModels(null)
    setForm(next)
  }

  async function fetchModels() {
    if (!form) return
    setBusy('models')
    setError(null)
    const res = await api.post<AiModelsResult>('/api/admin/ai/models', {
      kind: form.draft.kind,
      providerId: form.id,
      ...(form.draft.secret.trim() ? { secret: form.draft.secret.trim() } : {}),
      organization: form.draft.organization.trim(),
      model: form.draft.model.trim(),
    })
    setBusy(null)
    if (res.error || !res.data) { setError(localizeError(res.error) ?? t('errors.network')); return }
    setModels(res.data)
    setForm(withCatalogPrice(form, res.data))
  }

  async function testProvider(p: ProviderView) {
    setBusy(`test:${p.id}`)
    setError(null)
    const res = await api.post<{ ok: boolean; message: string }>(`/api/admin/ai/providers/${p.id}/test`, {})
    setBusy(null)
    if (res.error || !res.data) { setError(localizeError(res.error) ?? t('errors.network')); return }
    setTestResults((prev) => ({ ...prev, [p.id]: res.data! }))
    await load()
  }

  async function setActive(p: ProviderView, isActive: boolean) {
    const body = { ...aiProviderDraftBody(formFor(p).draft), name: p.name, isActive }
    await run(`active:${p.id}`, () => api.patch(`/api/admin/ai/providers/${p.id}`, body))
  }

  async function deleteProvider(p: ProviderView) {
    if (!window.confirm(t('ai_assistant.delete_confirm', { name: p.name }))) return
    await run(`delete:${p.id}`, () => api.delete(`/api/admin/ai/providers/${p.id}`))
  }

  if (!state) {
    return (
      <div className={CARD}>
        {error ? <ErrorBox message={error} /> : <div className="flex justify-center py-4"><Spinner className="h-5 w-5" /></div>}
      </div>
    )
  }

  const { settings, providers, month } = state
  const monthTotals = month.byProvider.reduce(
    (acc, r) => ({ requests: acc.requests + r.requests, inputTokens: acc.inputTokens + r.inputTokens, outputTokens: acc.outputTokens + r.outputTokens }),
    { requests: 0, inputTokens: 0, outputTokens: 0 },
  )
  const activeProviders = providers.filter((p) => p.isActive)
  const routingVisible = showFeatureRouting(activeProviders.length)
  const formComplete = form ? form.name.trim().length > 0 && aiProviderDraftComplete(form.draft, form.hasSecret) : false
  const routesDirty = AI_FEATURES.some((f) => (routesDraft[f] ?? '') !== (state.routes[f] ?? ''))

  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorBox message={error} />}

      {/* Switch and budget */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-gray-100 p-2 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">{t('ai_assistant.title')}</p>
              <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.description')}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={settings.enabled ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
              {settings.enabled ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
              {settings.enabled ? t('ai_assistant.on') : t('ai_assistant.off')}
            </Badge>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void toggleEnabled() }}>
              {busy === 'enabled' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : settings.enabled ? <PowerOff className="mr-1 h-3.5 w-3.5" /> : <Power className="mr-1 h-3.5 w-3.5" />}
              {settings.enabled ? t('ai_assistant.turn_off') : t('ai_assistant.turn_on')}
            </Button>
          </div>
        </div>

        {settings.enabled && activeProviders.length === 0 && (
          <Notice tone="amber" message={t('ai_assistant.no_provider_warning')} />
        )}
        {month.budgetReached && (
          <Notice tone="red" message={t('ai_assistant.budget_reached_banner', { budget: usd(settings.monthlyBudgetUsd ?? 0) })} />
        )}

        <div className="flex flex-wrap items-end gap-4 rounded-md border border-gray-100 px-3 py-3 dark:border-gray-800">
          <div className="flex flex-col gap-1.5">
            <Label className="inline-flex items-center gap-1"><Wallet className="h-3.5 w-3.5" />{t('ai_assistant.budget_label')}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                step="1"
                value={budgetText}
                onChange={(e) => setBudgetText(e.target.value)}
                placeholder={t('ai_assistant.budget_placeholder')}
                className="w-40"
              />
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void saveBudget() }}>
                {busy === 'budget' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                {t('common.save')}
              </Button>
            </div>
            <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.budget_hint')}</p>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.spent_this_month')}</span>
            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {usd(month.spentUsd)}
              {settings.monthlyBudgetUsd != null && <span className="text-sm font-normal text-gray-500 dark:text-gray-400"> / {usd(settings.monthlyBudgetUsd)}</span>}
            </span>
          </div>
        </div>
      </div>

      {/* Providers */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-gray-100 p-2 text-gray-600 dark:bg-gray-800 dark:text-gray-300"><Plug className="h-4 w-4" /></div>
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">{t('ai_assistant.providers_title')}</p>
              <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.providers_hint')}</p>
            </div>
          </div>
          {!form && (
            <Button size="sm" onClick={() => openForm(formFor(null))} disabled={busy !== null}>
              <Plus className="mr-1 h-3.5 w-3.5" />{t('ai_assistant.add_provider')}
            </Button>
          )}
        </div>

        {providers.length === 0 && !form && (
          <p className="rounded-md border border-dashed border-gray-200 px-3 py-4 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {t('ai_assistant.no_providers')}
          </p>
        )}

        {providers.map((p) => {
          const test = testResults[p.id] ?? (p.lastTestOk == null ? null : { ok: p.lastTestOk, message: p.lastTestMessage ?? '' })
          if (form?.id === p.id) return null
          return (
            <div key={p.id} className="flex flex-col gap-2 rounded-md border border-gray-100 px-3 py-3 dark:border-gray-800">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <AiProviderLogo kind={p.kind} />
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</p>
                    {p.isDefault && (
                      <Badge variant="default" className="inline-flex items-center gap-1"><Star className="h-3 w-3" />{t('ai_assistant.default_badge')}</Badge>
                    )}
                    <Badge variant={p.isActive ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
                      {p.isActive ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
                      {p.isActive ? t('ai_assistant.active') : t('ai_assistant.inactive')}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {t(`ai_assistant.kinds.${p.kind}`)} · <span className="font-mono">{p.model}</span>
                  </p>
                  {!p.priceKnown && (
                    <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{t('ai_assistant.price_unknown')}</p>
                  )}
                  {test && (
                    <p className={`mt-1 inline-flex items-center gap-1 text-xs ${test.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                      {test.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      {test.message}
                      {p.lastTestedAt && <span className="text-gray-400 dark:text-gray-500"> · {formatDateTimeInTZ(p.lastTestedAt)}</span>}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void testProvider(p) }}>
                    {busy === `test:${p.id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Activity className="mr-1 h-3.5 w-3.5" />}
                    {t('ai_assistant.test')}
                  </Button>
                  {!p.isDefault && p.isActive && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void run(`default:${p.id}`, () => api.post(`/api/admin/ai/providers/${p.id}/default`, {})) }}>
                      {busy === `default:${p.id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Star className="mr-1 h-3.5 w-3.5" />}
                      {t('ai_assistant.set_default')}
                    </Button>
                  )}
                  {!p.isDefault && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void setActive(p, !p.isActive) }}>
                      {busy === `active:${p.id}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : p.isActive ? <PowerOff className="mr-1 h-3.5 w-3.5" /> : <Power className="mr-1 h-3.5 w-3.5" />}
                      {p.isActive ? t('ai_assistant.deactivate') : t('ai_assistant.activate')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy !== null || form !== null} onClick={() => openForm(formFor(p))} title={t('common.edit')} aria-label={t('common.edit')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null || (p.isDefault && providers.length > 1)}
                    onClick={() => { void deleteProvider(p) }}
                    title={p.isDefault && providers.length > 1 ? t('ai_assistant.cannot_delete_default_hint') : t('common.delete')}
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )
        })}

        {form && (
          <div className="flex flex-col gap-3 rounded-md border border-blue-200 bg-blue-50/40 px-4 py-4 dark:border-blue-900 dark:bg-blue-950/20">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {form.id ? t('ai_assistant.edit_provider') : t('ai_assistant.add_provider')}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label>{t('ai_assistant.fields.name')}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <AiProviderFields
              value={form.draft}
              kindLocked={form.id !== null}
              secretSaved={form.hasSecret}
              onChange={(draft) => {
                // A new provider follows its kind's name until the admin types their own.
                const kindChanged = draft.kind !== form.draft.kind
                const nameIsDefault = form.name === AI_PROVIDER_DEFAULT_NAMES[form.draft.kind]
                if (kindChanged) setModels(null)
                const next = { ...form, draft, name: kindChanged && nameIsDefault ? AI_PROVIDER_DEFAULT_NAMES[draft.kind] : form.name }
                setForm(withCatalogPrice(next, kindChanged ? null : models))
              }}
              modelOptions={models?.models.map((m) => m.id)}
              modelAction={form.draft.kind === 'webhook' ? undefined : (
                <Button size="sm" variant="outline" type="button" disabled={busy !== null} onClick={() => { void fetchModels() }}>
                  {busy === 'models' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  {t('ai_assistant.models.fetch')}
                </Button>
              )}
              modelFooter={models && (
                <div className="flex flex-col gap-0.5 text-xs">
                  <p className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
                    <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />
                    {t(`ai_assistant.models.source_${models.listSource}`, { count: models.models.length })}
                  </p>
                  {models.listError && (
                    <p className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                      <AlertCircle className="h-3 w-3" />{t(`ai_assistant.models.list_error_${models.listError}`)}
                    </p>
                  )}
                  {!models.priceListOk && (
                    <p className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                      <AlertCircle className="h-3 w-3" />{t('ai_assistant.models.price_list_unreachable')}
                    </p>
                  )}
                </div>
              )}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>{t('ai_assistant.fields.input_price')} <span className="font-normal text-gray-400 dark:text-gray-500">{t('ai_assistant.fields.optional')}</span></Label>
                <Input type="number" min={0} step="0.01" value={form.inputPrice} onChange={(e) => setForm({ ...form, inputPrice: e.target.value, pricesAuto: false })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('ai_assistant.fields.output_price')} <span className="font-normal text-gray-400 dark:text-gray-500">{t('ai_assistant.fields.optional')}</span></Label>
                <Input type="number" min={0} step="0.01" value={form.outputPrice} onChange={(e) => setForm({ ...form, outputPrice: e.target.value, pricesAuto: false })} />
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.fields.price_hint')}</p>
            {(() => {
              const option = models?.models.find((m) => m.id === form.draft.model.trim())
              if (!option?.price || !option.priceSource) return null
              const same = priceOrNull(form.inputPrice) === option.price.inputPerMTok && priceOrNull(form.outputPrice) === option.price.outputPerMTok
              return (
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <Wallet className="h-3.5 w-3.5 text-gray-400" />
                  <span>
                    {t('ai_assistant.models.industry_price', {
                      model: option.id,
                      input: option.price.inputPerMTok,
                      output: option.price.outputPerMTok,
                      source: t(`ai_assistant.models.price_source_${option.priceSource}`),
                    })}
                  </span>
                  {!same && (
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setForm({ ...form, inputPrice: String(option.price!.inputPerMTok), outputPrice: String(option.price!.outputPerMTok), pricesAuto: true })}
                    >
                      <Wallet className="mr-1 h-3.5 w-3.5" />{t('ai_assistant.models.use_price')}
                    </Button>
                  )}
                </div>
              )
            })()}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => openForm(null)} disabled={busy === 'form'}>
                <X className="mr-1 h-3.5 w-3.5" />{t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => { void saveProvider() }} disabled={!formComplete || busy !== null}>
                {busy === 'form' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* AI features: an on/off switch per feature, and its provider once there is more than one active provider */}
      <div className={CARD}>
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-gray-100 p-2 text-gray-600 dark:bg-gray-800 dark:text-gray-300"><Route className="h-4 w-4" /></div>
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{t('ai_assistant.features_title')}</p>
            <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.features_hint')}</p>
            {providers.length > 0 && (
              <p className="mt-1 max-w-prose text-xs text-gray-500 dark:text-gray-400">{t(routingVisible ? 'ai_assistant.routing_hint' : 'ai_assistant.routing_single')}</p>
            )}
            {!settings.enabled && (
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                <AlertCircle className="h-3.5 w-3.5" />
                {t('ai_assistant.features_master_off')}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
          {AI_FEATURES.map((f) => {
            const FeatureIcon = FEATURE_ICONS[f]
            const on = !settings.disabledFeatures.includes(f)
            return (
              <div key={f} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className={`flex min-w-0 items-start gap-2 ${on ? '' : 'opacity-60'}`}>
                  <FeatureIcon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800 dark:text-gray-200">{t(`ai_assistant.features.${f}`)}</p>
                    <p className="text-xs text-gray-600 dark:text-gray-300">{t(`ai_assistant.feature_about.${f}`)}</p>
                    <p className={`text-xs ${on ? 'text-gray-500 dark:text-gray-400' : 'font-medium text-amber-700 dark:text-amber-400'}`}>{t(`ai_assistant.feature_off_effect.${f}`)}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {routingVisible && (
                    <Select
                      className="w-64"
                      value={routesDraft[f] ?? ''}
                      disabled={!on}
                      onChange={(e) => setRoutesDraft((prev) => ({ ...prev, [f]: e.target.value || undefined }))}
                    >
                      <option value="">{t('ai_assistant.use_default')}</option>
                      {activeProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  )}
                  <Badge variant={on ? 'success' : 'secondary'} className="inline-flex items-center gap-1">
                    {on ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
                    {on ? t('ai_assistant.on') : t('ai_assistant.off')}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void toggleFeature(f)}
                    aria-label={`${on ? t('ai_assistant.turn_off') : t('ai_assistant.turn_on')}: ${t(`ai_assistant.features.${f}`)}`}
                  >
                    {busy === `feature:${f}` ? <Spinner className="mr-1 h-3.5 w-3.5" /> : on ? <PowerOff className="mr-1 h-3.5 w-3.5" /> : <Power className="mr-1 h-3.5 w-3.5" />}
                    {on ? t('ai_assistant.turn_off') : t('ai_assistant.turn_on')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
        {routingVisible && (
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!routesDirty || busy !== null}
              onClick={() => {
                const routes = Object.fromEntries(AI_FEATURES.map((f) => [f, routesDraft[f] ?? null]))
                void run('routes', () => api.put('/api/admin/ai/routes', { routes }))
              }}
            >
              {busy === 'routes' ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
              {t('common.save')}
            </Button>
          </div>
        )}
      </div>

      {/* Usage */}
      <div className={CARD}>
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-gray-100 p-2 text-gray-600 dark:bg-gray-800 dark:text-gray-300"><BarChart3 className="h-4 w-4" /></div>
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{t('ai_assistant.usage_title')}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.usage_description')}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { key: 'requests', label: t('ai_assistant.usage.requests'), value: monthTotals.requests.toLocaleString() },
            { key: 'input', label: t('ai_assistant.usage.input_tokens'), value: monthTotals.inputTokens.toLocaleString() },
            { key: 'output', label: t('ai_assistant.usage.output_tokens'), value: monthTotals.outputTokens.toLocaleString() },
            {
              key: 'cost',
              label: t('ai_assistant.usage.estimated_cost'),
              value: settings.monthlyBudgetUsd != null ? `${usd(month.spentUsd)} / ${usd(settings.monthlyBudgetUsd)}` : usd(month.spentUsd),
            },
          ].map((stat) => (
            <div key={stat.key} className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
              <p className="text-[11px] text-gray-500 dark:text-gray-400">{stat.label}</p>
              <p className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">{stat.value}</p>
            </div>
          ))}
        </div>
        {month.byProvider.length > 1 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('ai_assistant.usage.provider')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('ai_assistant.usage.requests')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('ai_assistant.usage.input_tokens')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('ai_assistant.usage.output_tokens')}</th>
                  <th className="py-1 text-right font-medium">{t('ai_assistant.usage.cost')}</th>
                </tr>
              </thead>
              <tbody className="text-gray-800 dark:text-gray-200">
                {month.byProvider.map((r) => (
                  <tr key={r.providerId ?? 'none'} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="py-1 pr-3">{providers.find((p) => p.id === r.providerId)?.name ?? t('ai_assistant.usage.removed_provider')}</td>
                    <td className="py-1 pr-3 text-right">{r.requests.toLocaleString()}</td>
                    <td className="py-1 pr-3 text-right">{r.inputTokens.toLocaleString()}</td>
                    <td className="py-1 pr-3 text-right">{r.outputTokens.toLocaleString()}</td>
                    <td className="py-1 text-right">{usd(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AiUsagePanel providersVersion={providers.length} />
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('ai_assistant.cost_note')}</p>
      </div>
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return <Notice tone="red" message={message} />
}

function Notice({ tone, message }: { tone: 'red' | 'amber'; message: string }) {
  const cls = tone === 'red'
    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
    : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${cls}`}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}
