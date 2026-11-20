// AI Assistant (Admin → Integrations → AI Assistant, CLAUDE.md §14). One
// install can configure several AI providers; one is the default, and each
// AI feature can be routed to a specific active provider. Shared by the
// server (validation, routing, cost) and the admin page (forms, labels).

export const AI_PROVIDER_KINDS = ['anthropic', 'azure_openai', 'openai', 'bedrock', 'foundry', 'gemini', 'xai', 'webhook'] as const
export type AiProviderKind = typeof AI_PROVIDER_KINDS[number]

export function isAiProviderKind(v: string): v is AiProviderKind {
  return (AI_PROVIDER_KINDS as readonly string[]).includes(v)
}

// Which API shape a kind speaks. Claude providers use the Anthropic Messages
// API (Claude API, Amazon Bedrock, Microsoft Foundry); the rest use the
// OpenAI Chat Completions API (Gemini and xAI through their OpenAI-compatible
// endpoints). A webhook is the app's own JSON contract (docs/ai-webhook.md),
// answered by whatever the admin points it at: n8n, an AI gateway, an
// in-house model.
export type AiApiFamily = 'anthropic' | 'openai' | 'webhook'

// The provider settings an admin fills in. `secret` is the one credential each
// kind needs (an API key, or the AWS secret access key for Bedrock); it is
// write-only and never sent back to the browser.
export type AiProviderField = 'endpoint' | 'apiVersion' | 'allowedCustomHost' | 'region' | 'accessKeyId' | 'resource' | 'organization'

export interface AiProviderKindInfo {
  kind: AiProviderKind
  family: AiApiFamily
  // Settings this kind needs besides the model and the secret.
  required: AiProviderField[]
  optional: AiProviderField[]
  // Suggestions for the model box; the admin can type any other model id.
  modelSuggestions: string[]
  defaultModel: string
  // Azure OpenAI addresses a deployment, not a model, so the box is labelled
  // "Deployment" there.
  modelIsDeployment?: boolean
  // The secret can be left out (a webhook that needs no token).
  secretOptional?: boolean
  // The admin can allow a private-network address (a webhook on the same
  // Docker network or VNet).
  privateNetworkOption?: boolean
}

export const AI_PROVIDER_KIND_INFO: Record<AiProviderKind, AiProviderKindInfo> = {
  anthropic: {
    kind: 'anthropic', family: 'anthropic', required: [], optional: [],
    modelSuggestions: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-opus-5-5',
  },
  azure_openai: {
    kind: 'azure_openai', family: 'openai', required: ['endpoint'], optional: ['apiVersion', 'allowedCustomHost'],
    modelSuggestions: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    defaultModel: 'gpt-6.1-sol', modelIsDeployment: true,
  },
  openai: {
    kind: 'openai', family: 'openai', required: [], optional: ['organization'],
    modelSuggestions: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    defaultModel: 'gpt-6.1-sol',
  },
  bedrock: {
    kind: 'bedrock', family: 'anthropic', required: ['region', 'accessKeyId'], optional: [],
    modelSuggestions: ['anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5', 'anthropic.claude-haiku-5-5', 'anthropic.claude-fable-5-1'],
    defaultModel: 'anthropic.claude-opus-5-5',
  },
  foundry: {
    kind: 'foundry', family: 'anthropic', required: ['resource'], optional: [],
    modelSuggestions: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-opus-5-5',
  },
  gemini: {
    kind: 'gemini', family: 'openai', required: [], optional: [],
    modelSuggestions: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-3.8-flash',
  },
  xai: {
    kind: 'xai', family: 'openai', required: [], optional: [],
    modelSuggestions: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20'],
    defaultModel: 'grok-4.7',
  },
  webhook: {
    kind: 'webhook', family: 'webhook', required: ['endpoint'], optional: [],
    modelSuggestions: ['default'],
    defaultModel: 'default',
    secretOptional: true, privateNetworkOption: true,
  },
}

// The Setup wizard runs before anyone signs in, so it never offers a webhook:
// an unauthenticated form must not be able to make the server call an
// arbitrary (possibly private) URL.
export const AI_SETUP_PROVIDER_KINDS = ['anthropic', 'azure_openai', 'openai', 'bedrock', 'foundry', 'gemini', 'xai'] as const satisfies readonly AiProviderKind[]

// The name a provider gets when nobody types one (the Setup wizard).
export const AI_PROVIDER_DEFAULT_NAMES: Record<AiProviderKind, string> = {
  anthropic: 'Anthropic (Claude)',
  azure_openai: 'Azure OpenAI',
  openai: 'OpenAI',
  bedrock: 'Amazon Bedrock (Claude)',
  foundry: 'Microsoft Foundry (Claude)',
  gemini: 'Google Gemini',
  xai: 'xAI (Grok)',
  webhook: 'Webhook',
}

export const AZURE_OPENAI_DEFAULT_API_VERSION = '2024-10-21'

// Every AI feature in the app. A feature can be routed to its own provider;
// with no route it uses the default provider. Add a feature here when it
// starts calling the gateway.
export const AI_FEATURES = ['activity_classify', 'note_organize', 'note_link_suggest', 'notes_chat', 'activity_ai_notes', 'activity_ai_assessments'] as const
export type AiFeature = typeof AI_FEATURES[number]
// connection_test is recorded in the usage log but is never routed.
export type AiRequestFeature = AiFeature | 'connection_test'

export const AI_REQUEST_STATUSES = ['ok', 'error', 'refused', 'over_budget'] as const
export type AiRequestStatus = typeof AI_REQUEST_STATUSES[number]

// App-wide switch and budget (system_settings.ai_settings).
export interface AiSettings {
  enabled: boolean
  // USD per calendar month across every provider; null means no limit.
  monthlyBudgetUsd: number | null
  // 'YYYY-MM' of the month the "budget reached" email went out, so App
  // Admins get one email per month, not one per blocked request.
  budgetAlertSentFor: string | null
  // v1.468.0: features an App Admin turned off. Each falls back to its
  // no-AI behavior (Activity type suggestions use keyword rules only).
  disabledFeatures: AiFeature[]
}

export const DEFAULT_AI_SETTINGS: AiSettings = { enabled: false, monthlyBudgetUsd: null, budgetAlertSentFor: null, disabledFeatures: [] }

export function isAiFeature(v: unknown): v is AiFeature {
  return typeof v === 'string' && (AI_FEATURES as readonly string[]).includes(v)
}

// Whether one feature may call AI (the master switch is checked separately).
export function isAiFeatureOn(settings: Pick<AiSettings, 'disabledFeatures'>, feature: AiFeature): boolean {
  return !settings.disabledFeatures.includes(feature)
}

export function normalizeAiSettings(raw: unknown): AiSettings {
  const v = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const budget = v['monthlyBudgetUsd']
  return {
    enabled: v['enabled'] === true,
    monthlyBudgetUsd: typeof budget === 'number' && Number.isFinite(budget) && budget >= 0 ? budget : null,
    budgetAlertSentFor: typeof v['budgetAlertSentFor'] === 'string' ? v['budgetAlertSentFor'] : null,
    disabledFeatures: Array.isArray(v['disabledFeatures'])
      ? [...new Set((v['disabledFeatures'] as unknown[]).filter(isAiFeature))]
      : [],
  }
}

// USD per million tokens, the built-in fallback when the LiteLLM price list
// (services/ai/modelCatalog.ts) can't be reached. Claude prices are
// Anthropic's list prices; the others are the providers' list prices as of
// v1.464.0. Each provider can override them, which is the only way a model
// missing here counts toward the monthly budget.
export interface AiPrice { inputPerMTok: number; outputPerMTok: number }

const KNOWN_PRICES: Array<[RegExp, AiPrice]> = [
  [/claude-fable-5-1/, { inputPerMTok: 10, outputPerMTok: 50 }],
  [/claude-opus-5-5/, { inputPerMTok: 4, outputPerMTok: 20 }],
  [/claude-opus-(5|4-8)(?![-.]\d)/, { inputPerMTok: 5, outputPerMTok: 25 }],
  [/claude-sonnet-5(-5)?(?![-.]\d)/, { inputPerMTok: 2, outputPerMTok: 10 }],
  [/claude-sonnet-4-6/, { inputPerMTok: 3, outputPerMTok: 15 }],
  [/claude-haiku-5-5/, { inputPerMTok: 0.1, outputPerMTok: 0.5 }],
  [/claude-haiku-4-5/, { inputPerMTok: 1, outputPerMTok: 5 }],
  [/^gpt-6\.1-sol/, { inputPerMTok: 2, outputPerMTok: 10 }],
  [/^gpt-6\.1-terra/, { inputPerMTok: 1, outputPerMTok: 5 }],
  [/^gpt-6-astra/, { inputPerMTok: 10, outputPerMTok: 50 }],
  [/^gpt-6-sol/, { inputPerMTok: 2, outputPerMTok: 10 }],
  [/^gpt-6-luna/, { inputPerMTok: 0.1, outputPerMTok: 0.5 }],
  [/^gpt-5\.6-terra/, { inputPerMTok: 2, outputPerMTok: 12 }],
  [/^gpt-5\.6-luna/, { inputPerMTok: 0.2, outputPerMTok: 1.2 }],
  [/^gpt-5\.6(-sol)?(?![-.\w])/, { inputPerMTok: 4, outputPerMTok: 20 }],
  [/^gpt-5\.5(?![-.\w])/, { inputPerMTok: 5, outputPerMTok: 30 }],
  [/^gpt-5\.4-mini/, { inputPerMTok: 0.75, outputPerMTok: 4.5 }],
  [/^gpt-5\.4-nano/, { inputPerMTok: 0.2, outputPerMTok: 1.25 }],
  [/^gpt-5\.4(?![-.\w])/, { inputPerMTok: 2.5, outputPerMTok: 15 }],
  [/^gpt-4o-mini/, { inputPerMTok: 0.15, outputPerMTok: 0.6 }],
  [/^gpt-4o/, { inputPerMTok: 2.5, outputPerMTok: 10 }],
  [/^gpt-4\.1-mini/, { inputPerMTok: 0.4, outputPerMTok: 1.6 }],
  [/^gpt-4\.1/, { inputPerMTok: 2, outputPerMTok: 8 }],
  [/^gemini-3\.[678]-flash/, { inputPerMTok: 0.75, outputPerMTok: 3.75 }],
  [/^gemini-3\.5-flash-lite/, { inputPerMTok: 0.3, outputPerMTok: 2.5 }],
  [/^gemini-3\.5-flash/, { inputPerMTok: 1.5, outputPerMTok: 9 }],
  [/^gemini-3\.1-pro/, { inputPerMTok: 2, outputPerMTok: 12 }],
  [/^gemini-2\.5-flash-lite/, { inputPerMTok: 0.1, outputPerMTok: 0.4 }],
  [/^gemini-2\.5-pro/, { inputPerMTok: 1.25, outputPerMTok: 10 }],
  [/^gemini-2\.5-flash/, { inputPerMTok: 0.3, outputPerMTok: 2.5 }],
  [/^grok-4\.[5-7]/, { inputPerMTok: 2, outputPerMTok: 6 }],
  [/^grok-4\.(3|20)/, { inputPerMTok: 1.25, outputPerMTok: 2.5 }],
  [/^grok-4/, { inputPerMTok: 3, outputPerMTok: 15 }],
]

// "Fetch latest models" (POST /api/admin/ai/models, v1.464.0).
export type AiModelListSource = 'provider' | 'catalog' | 'built_in'
// Why the provider's own list wasn't used.
export type AiModelListError = 'no_key' | 'auth' | 'unreachable' | 'unsupported'
export type AiPriceSource = 'litellm' | 'built_in'

export interface AiModelOption {
  id: string
  price: AiPrice | null
  priceSource: AiPriceSource | null
}

export interface AiModelsResult {
  models: AiModelOption[]
  listSource: AiModelListSource
  listError: AiModelListError | null
  // false when the LiteLLM price list couldn't be downloaded.
  priceListOk: boolean
}

export function knownModelPrice(model: string): AiPrice | null {
  for (const [re, price] of KNOWN_PRICES) if (re.test(model)) return price
  return null
}

export function estimateCostUsd(price: AiPrice | null, inputTokens: number, outputTokens: number): number {
  if (!price) return 0
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000
}

// The per-feature provider picker only appears once there is a real choice.
export function showFeatureRouting(activeProviderCount: number): boolean {
  return activeProviderCount >= 2
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// ── AI Assistant → Usage this month (v1.467.0) ──────────────────────────
// The month's requests grouped by feature, team or person, and a paged list
// of the requests themselves. A request's team is the team it was charged
// to (AI Notes, AI Assessments) or else the requester's default team.

export const AI_USAGE_GROUP_BYS = ['feature', 'team', 'user'] as const
export type AiUsageGroupBy = typeof AI_USAGE_GROUP_BYS[number]
export const AI_USAGE_PAGE_SIZE = 20
// Filter value for requests with no team / no person (scheduled jobs, tests).
export const AI_USAGE_NONE = 'none'

export interface AiUsageTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  failed: number
}

export interface AiUsageGroupRow extends AiUsageTotals {
  // Feature key, team id or user id; null = no team / no person.
  key: string | null
  label: string | null
}

export interface AiUsageRequestRow {
  id: string
  createdAt: string
  feature: string
  providerName: string | null
  providerKind: string | null
  model: string | null
  teamId: string | null
  teamName: string | null
  userId: string | null
  userName: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  // v1.473.0: how many items (meetings) the request covered; null = one.
  itemCount: number | null
  status: string
  error: string | null
}

export interface AiUsageView {
  since: string
  groupBy: AiUsageGroupBy
  groups: AiUsageGroupRow[]
  totals: AiUsageTotals
  rows: AiUsageRequestRow[]
  page: number
  pageSize: number
  totalRows: number
  // Choices for the filters: everything seen this month.
  options: {
    features: string[]
    teams: Array<{ id: string; name: string }>
    users: Array<{ id: string; name: string }>
  }
}
