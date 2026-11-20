import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../ui/input.js'
import { Label } from '../../ui/label.js'
import { Select } from '../../ui/select.js'
import {
  AI_PROVIDER_KIND_INFO,
  AI_PROVIDER_KINDS,
  AZURE_OPENAI_DEFAULT_API_VERSION,
  type AiProviderField,
  type AiProviderKind,
} from '../../../../shared/ai.js'

// The provider form shared by the Setup wizard (step 8) and Admin →
// Integrations → AI Assistant. Shows only the settings the chosen kind uses.

export interface AiProviderDraft {
  kind: AiProviderKind
  model: string
  secret: string
  endpoint: string
  apiVersion: string
  allowedCustomHost: string
  region: string
  accessKeyId: string
  resource: string
  organization: string
  allowPrivateNetwork: boolean
  // Webhook only: drop the saved secret instead of keeping it.
  clearSecret: boolean
}

export function emptyAiProviderDraft(kind: AiProviderKind = 'anthropic'): AiProviderDraft {
  return {
    kind,
    model: AI_PROVIDER_KIND_INFO[kind].defaultModel,
    secret: '',
    endpoint: '',
    apiVersion: '',
    allowedCustomHost: '',
    region: '',
    accessKeyId: '',
    resource: '',
    organization: '',
    allowPrivateNetwork: false,
    clearSecret: false,
  }
}

const WEBHOOK_URL_PLACEHOLDER = 'https://n8n.example.com/webhook/impactiq-ai'

const FIELD_PLACEHOLDERS: Partial<Record<AiProviderField, string>> = {
  endpoint: 'https://your-resource.openai.azure.com/',
  apiVersion: AZURE_OPENAI_DEFAULT_API_VERSION,
  allowedCustomHost: 'ai.example.com',
  region: 'us-east-1',
  accessKeyId: 'AKIA…',
  resource: 'my-foundry-resource',
}

// Whether every setting the kind requires is filled in. `secretSaved` lets an
// edit leave the key blank to keep the stored one.
export function aiProviderDraftComplete(d: AiProviderDraft, secretSaved = false): boolean {
  const info = AI_PROVIDER_KIND_INFO[d.kind]
  if (!d.model.trim()) return false
  if (!d.secret.trim() && !secretSaved && !info.secretOptional) return false
  return info.required.every((f) => d[f].trim().length > 0)
}

interface Props {
  value: AiProviderDraft
  onChange: (next: AiProviderDraft) => void
  // The kind can't change on an existing provider: its saved key belongs to it.
  kindLocked?: boolean
  // An existing provider with a saved key; blank keeps it.
  secretSaved?: boolean
  // Setup has no custom-host allowance; only the admin page offers it.
  hideFields?: AiProviderField[]
  // The kinds offered (Setup leaves out the webhook).
  kinds?: readonly AiProviderKind[]
  // Models fetched from the provider, replacing the built-in suggestions.
  modelOptions?: string[]
  // Shown beside the model label (the admin page's Fetch latest models).
  modelAction?: ReactNode
  // Shown under the model box.
  modelFooter?: ReactNode
}

export function AiProviderFields({ value, onChange, kindLocked, secretSaved, hideFields = [], kinds = AI_PROVIDER_KINDS, modelOptions, modelAction, modelFooter }: Props) {
  const { t } = useTranslation()
  const listId = useId()
  const info = AI_PROVIDER_KIND_INFO[value.kind]
  const fields = [...info.required, ...info.optional].filter((f) => !hideFields.includes(f))

  function set<K extends keyof AiProviderDraft>(key: K, v: AiProviderDraft[K]) {
    onChange({ ...value, [key]: v })
  }

  function changeKind(kind: AiProviderKind) {
    onChange({ ...emptyAiProviderDraft(kind), secret: '' })
  }

  const isWebhook = value.kind === 'webhook'
  const secretLabel = value.kind === 'bedrock'
    ? t('ai_assistant.fields.aws_secret')
    : isWebhook ? t('ai_assistant.fields.webhook_secret') : t('ai_assistant.fields.api_key')
  const modelLabel = info.modelIsDeployment
    ? t('ai_assistant.fields.deployment')
    : isWebhook ? t('ai_assistant.fields.model_label') : t('ai_assistant.fields.model')
  const modelHint = info.modelIsDeployment
    ? t('ai_assistant.fields.deployment_hint')
    : isWebhook ? t('ai_assistant.fields.model_label_hint') : t('ai_assistant.fields.model_hint')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label>{t('ai_assistant.fields.provider')}</Label>
        <Select value={value.kind} disabled={kindLocked} onChange={(e) => changeKind(e.target.value as AiProviderKind)}>
          {kinds.map((k) => (
            <option key={k} value={k}>{t(`ai_assistant.kinds.${k}`)}</option>
          ))}
        </Select>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t(`ai_assistant.kind_hints.${value.kind}`)}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>{modelLabel}</Label>
          {modelAction}
        </div>
        <Input
          value={value.model}
          list={listId}
          onChange={(e) => set('model', e.target.value.trim())}
          className="font-mono text-xs"
        />
        <datalist id={listId}>
          {(modelOptions ?? info.modelSuggestions).map((m) => <option key={m} value={m} />)}
        </datalist>
        <p className="text-xs text-gray-500 dark:text-gray-400">{modelHint}</p>
        {modelFooter}
      </div>

      {fields.map((f) => (
        <div key={f} className="flex flex-col gap-1.5">
          <Label>
            {isWebhook && f === 'endpoint' ? t('ai_assistant.fields.webhook_url') : t(`ai_assistant.fields.${f}`)}
            {!info.required.includes(f) && <span className="ml-1 font-normal text-gray-400 dark:text-gray-500">{t('ai_assistant.fields.optional')}</span>}
          </Label>
          <Input
            value={value[f]}
            onChange={(e) => set(f, e.target.value.trim())}
            placeholder={isWebhook && f === 'endpoint' ? WEBHOOK_URL_PLACEHOLDER : FIELD_PLACEHOLDERS[f] ?? ''}
            className="font-mono text-xs"
          />
          {f === 'allowedCustomHost' && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.fields.allowedCustomHost_hint')}</p>
          )}
        </div>
      ))}

      {info.privateNetworkOption && (
        <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.allowPrivateNetwork}
            onChange={(e) => set('allowPrivateNetwork', e.target.checked)}
          />
          <span>{t('ai_assistant.fields.allowPrivateNetwork')}</span>
        </label>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>
          {secretLabel}
          {info.secretOptional && <span className="ml-1 font-normal text-gray-400 dark:text-gray-500">{t('ai_assistant.fields.optional')}</span>}
        </Label>
        <Input
          type="password"
          autoComplete="new-password"
          value={value.secret}
          disabled={value.clearSecret}
          onChange={(e) => set('secret', e.target.value)}
          placeholder={secretSaved && !value.clearSecret ? t('ai_assistant.fields.secret_saved') : ''}
          className="font-mono text-xs"
        />
        {isWebhook && <p className="text-xs text-gray-500 dark:text-gray-400">{t('ai_assistant.fields.webhook_secret_hint')}</p>}
        {info.secretOptional && secretSaved && (
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={value.clearSecret}
              onChange={(e) => onChange({ ...value, clearSecret: e.target.checked, secret: '' })}
            />
            {t('ai_assistant.fields.clear_secret')}
          </label>
        )}
      </div>
    </div>
  )
}

// The body the server's provider routes expect, without empty settings.
export function aiProviderDraftBody(d: AiProviderDraft) {
  const info = AI_PROVIDER_KIND_INFO[d.kind]
  const body: Record<string, string | boolean> = { kind: d.kind, model: d.model.trim() }
  if (d.secret.trim()) body['secret'] = d.secret.trim()
  else if (info.secretOptional && d.clearSecret) body['clearSecret'] = true
  for (const f of [...info.required, ...info.optional]) {
    body[f] = d[f].trim()
  }
  if (info.privateNetworkOption) body['allowPrivateNetwork'] = d.allowPrivateNetwork
  return body
}
