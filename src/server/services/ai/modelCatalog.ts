import { knownModelPrice, AI_PROVIDER_KIND_INFO, type AiPrice, type AiProviderKind } from '../../../shared/ai.js'
import type { AiModelListError, AiModelListSource, AiModelOption, AiModelsResult } from '../../../shared/ai.js'

// "Fetch latest models" on Admin → Integrations → AI Assistant (v1.464.0).
// The model list comes from the provider's own API when it has one and a key
// was given, else from the LiteLLM price list, else the built-in
// suggestions. Prices come from the LiteLLM price list (an open, maintained
// file on GitHub covering every provider), falling back to the built-in
// table in shared/ai.ts. Listing models is not an AI call: nothing goes
// through runAi() and nothing is logged in ai_requests.

export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PRICE_LIST_TTL_MS = 12 * 60 * 60 * 1000
// After a failed download, wait before trying GitHub again.
const PRICE_LIST_RETRY_MS = 10 * 60 * 1000
const PRICE_LIST_MAX_BYTES = 30 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const MAX_MODELS = 80

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000'
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/models'
const XAI_MODELS_URL = 'https://api.x.ai/v1/models'

export interface LiteLlmEntry {
  inputPerToken: number | null
  outputPerToken: number | null
  provider: string | null
  mode: string | null
  deprecationDate: string | null
}
export type PriceCatalog = Map<string, LiteLlmEntry>

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Reads the LiteLLM JSON, keeping only what pricing and listing need. */
export function parseLiteLlmCatalog(raw: unknown): PriceCatalog {
  const out: PriceCatalog = new Map()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'sample_spec' || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const v = value as Record<string, unknown>
    out.set(key, {
      inputPerToken: num(v['input_cost_per_token']),
      outputPerToken: num(v['output_cost_per_token']),
      provider: str(v['litellm_provider']),
      mode: str(v['mode']),
      deprecationDate: str(v['deprecation_date']),
    })
  }
  return out
}

let cached: { at: number; catalog: PriceCatalog | null } | null = null
let inflight: Promise<PriceCatalog | null> | null = null

/** For tests. */
export function clearPriceCatalogCache(): void {
  cached = null
  inflight = null
}

async function downloadCatalog(fetchImpl: FetchLike): Promise<PriceCatalog | null> {
  try {
    const res = await fetchImpl(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' })
    if (!res.ok) return null
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > PRICE_LIST_MAX_BYTES) return null
    const text = await res.text()
    if (text.length > PRICE_LIST_MAX_BYTES) return null
    const catalog = parseLiteLlmCatalog(JSON.parse(text))
    return catalog.size > 0 ? catalog : null
  } catch {
    return null
  }
}

/** The LiteLLM price list, cached for 12 hours; null when GitHub can't be reached. */
export async function loadPriceCatalog(fetchImpl: FetchLike = fetch, now: number = Date.now()): Promise<PriceCatalog | null> {
  if (cached && now - cached.at < (cached.catalog ? PRICE_LIST_TTL_MS : PRICE_LIST_RETRY_MS)) return cached.catalog
  if (!inflight) {
    inflight = downloadCatalog(fetchImpl).then((catalog) => {
      // Keep a good list over a failed refresh.
      if (catalog || !cached?.catalog) cached = { at: now, catalog }
      else cached = { at: now - PRICE_LIST_TTL_MS + PRICE_LIST_RETRY_MS, catalog: cached.catalog }
      return cached.catalog
    }).finally(() => { inflight = null })
  }
  return inflight
}

// The LiteLLM keys to try for a model id, most specific first.
export function catalogKeysFor(kind: AiProviderKind, model: string): string[] {
  const id = model.trim()
  switch (kind) {
    case 'anthropic': return [id]
    case 'openai': return [id]
    case 'gemini': return [`gemini/${id}`, id]
    case 'xai': return [`xai/${id}`, id]
    // ImpactIQ calls Bedrock through the Mantle endpoint.
    case 'bedrock': return [`bedrock_mantle/${id}`, id, `bedrock/${id}`]
    case 'azure_openai': return [`azure/${id}`, `azure_ai/${id}`, id]
    case 'foundry': return [`azure_ai/${id}`, id]
    case 'webhook': return []
  }
}

function roundPrice(perToken: number): number {
  return Math.round(perToken * 1_000_000 * 10_000) / 10_000
}

/** Input and output price per million tokens from the LiteLLM list. */
export function priceFromCatalog(catalog: PriceCatalog | null, kind: AiProviderKind, model: string): AiPrice | null {
  if (!catalog) return null
  for (const key of catalogKeysFor(kind, model)) {
    const e = catalog.get(key)
    if (e && e.inputPerToken !== null && e.outputPerToken !== null) {
      return { inputPerMTok: roundPrice(e.inputPerToken), outputPerMTok: roundPrice(e.outputPerToken) }
    }
  }
  return null
}

// Models that can't answer a chat prompt, or that are dated snapshots of a
// model already in the list.
const NOT_CHAT_RX = /(embed|audio|realtime|transcribe|tts|whisper|dall-e|image|moderation|search|computer-use|deep-research|codex|live|native-audio|customtools|lyria|veo|imagen|learnlm)/i
const DATED_RX = /(-\d{8}|-\d{4}-\d{2}-\d{2}|-\d{2}-\d{4}|-\d{4})$/
const OLD_CLAUDE_RX = /claude-(instant|2|3)/
const XAI_NOISE_RX = /(beta|experimental|gv2|multi-agent|-\d{4}(-|$)|latest)/

/** Whether a model id from a provider's list is worth offering. */
export function isOfferedModel(kind: AiProviderKind, id: string): boolean {
  if (NOT_CHAT_RX.test(id)) return false
  switch (kind) {
    case 'anthropic':
    case 'foundry':
      return /^claude-/.test(id) && !OLD_CLAUDE_RX.test(id) && !DATED_RX.test(id)
    case 'bedrock':
      return /^anthropic\.claude-/.test(id) && !OLD_CLAUDE_RX.test(id) && !/-v\d(:\d+)?$/.test(id)
    case 'openai':
    case 'azure_openai':
      return /^(gpt-|o\d|chatgpt-)/.test(id) && !/^gpt-(3|4)(?![.]1)/.test(id) && !DATED_RX.test(id) && !/-(instruct|preview)/.test(id)
    case 'gemini':
      return /^gemini-/.test(id) && !/^gemini-(1|2\.0)/.test(id) && !/-\d{2}-\d{4}$|-\d{3}$|exp/.test(id)
    case 'xai':
      return /^grok-/.test(id) && !XAI_NOISE_RX.test(id) && !/^grok-(2|3)/.test(id)
    case 'webhook':
      return false
  }
}

const CHAT_MODES = new Set(['chat', 'responses'])

/** Current models for a kind, read from the LiteLLM list. */
export function catalogModelsFor(catalog: PriceCatalog | null, kind: AiProviderKind, today: string): string[] {
  if (!catalog) return []
  const ids = new Set<string>()
  for (const [key, e] of catalog) {
    if (e.mode && !CHAT_MODES.has(e.mode)) continue
    if (e.deprecationDate && e.deprecationDate <= today) continue
    let id: string | null = null
    if (kind === 'anthropic' && e.provider === 'anthropic' && !key.includes('/')) id = key
    else if (kind === 'openai' && e.provider === 'openai' && !key.includes('/')) id = key
    else if (kind === 'gemini' && e.provider === 'gemini' && key.startsWith('gemini/')) id = key.slice('gemini/'.length)
    else if (kind === 'xai' && e.provider === 'xai' && key.startsWith('xai/')) id = key.slice('xai/'.length)
    else if (kind === 'azure_openai' && e.provider === 'azure' && /^azure\/[^/]+$/.test(key)) id = key.slice('azure/'.length)
    else if (kind === 'foundry' && e.provider === 'azure_ai' && /^azure_ai\/claude-/.test(key)) id = key.slice('azure_ai/'.length)
    else if (kind === 'bedrock') {
      if (e.provider === 'bedrock_mantle' && /^bedrock_mantle\/anthropic\./.test(key)) id = key.slice('bedrock_mantle/'.length)
      else if (e.provider === 'bedrock_converse' && /^anthropic\./.test(key)) id = key
    }
    if (id && isOfferedModel(kind, id)) ids.add(id)
  }
  return sortModels([...ids])
}

/** Newest-looking first: higher version numbers sort ahead. */
export function sortModels(ids: string[]): string[] {
  return [...ids].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
}

export class ModelListError extends Error {
  constructor(readonly code: AiModelListError) { super(code) }
}

function modelIdsFromBody(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((m) => {
    const id = m && typeof m === 'object' ? (m as { id?: unknown }).id : null
    return typeof id === 'string' && id.length > 0 && id.length <= 200 ? [id] : []
  })
}

/** Kinds whose own API lists models with just the API key. */
export function providerListsModels(kind: AiProviderKind): boolean {
  return kind === 'anthropic' || kind === 'openai' || kind === 'gemini' || kind === 'xai'
}

/**
 * The provider's own model list. Hosts are fixed per kind (no admin-supplied
 * URL is called). Throws ModelListError.
 */
export async function listProviderModels(
  p: { kind: AiProviderKind; secret: string | null; organization: string | null },
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  if (!providerListsModels(p.kind)) throw new ModelListError('unsupported')
  if (!p.secret) throw new ModelListError('no_key')
  let url: string
  const headers: Record<string, string> = { accept: 'application/json' }
  if (p.kind === 'anthropic') {
    url = ANTHROPIC_MODELS_URL
    headers['x-api-key'] = p.secret
    headers['anthropic-version'] = '2023-06-01'
  } else {
    url = p.kind === 'openai' ? OPENAI_MODELS_URL : p.kind === 'gemini' ? GEMINI_MODELS_URL : XAI_MODELS_URL
    headers['authorization'] = `Bearer ${p.secret}`
    if (p.kind === 'openai' && p.organization) headers['openai-organization'] = p.organization
  }
  let res: Response
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' })
  } catch {
    throw new ModelListError('unreachable')
  }
  if (res.status === 401 || res.status === 403) throw new ModelListError('auth')
  if (!res.ok) throw new ModelListError('unreachable')
  let body: unknown
  try { body = await res.json() } catch { throw new ModelListError('unreachable') }
  const ids = modelIdsFromBody(body).map((id) => (p.kind === 'gemini' ? id.replace(/^models\//, '') : id))
  return sortModels([...new Set(ids.filter((id) => isOfferedModel(p.kind, id)))])
}

function priced(kind: AiProviderKind, id: string, catalog: PriceCatalog | null): AiModelOption {
  const fromList = priceFromCatalog(catalog, kind, id)
  if (fromList) return { id, price: fromList, priceSource: 'litellm' }
  const builtIn = knownModelPrice(id)
  return { id, price: builtIn, priceSource: builtIn ? 'built_in' : null }
}

/** Everything the button shows: the model list and a price for each model. */
export async function fetchLatestModels(
  p: { kind: AiProviderKind; secret: string | null; organization: string | null; currentModel?: string | null },
  opts: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<AiModelsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? new Date()
  const [catalog, listed] = await Promise.all([
    loadPriceCatalog(fetchImpl, now.getTime()),
    providerListsModels(p.kind) && p.secret
      ? listProviderModels(p, fetchImpl).then((ids) => ({ ids, error: null }), (err: unknown) => ({ ids: null, error: err instanceof ModelListError ? err.code : 'unreachable' as const }))
      : Promise.resolve({ ids: null, error: providerListsModels(p.kind) ? 'no_key' as const : 'unsupported' as const }),
  ])

  let ids: string[]
  let listSource: AiModelListSource
  const fromCatalog = catalogModelsFor(catalog, p.kind, now.toISOString().slice(0, 10))
  if (listed.ids && listed.ids.length > 0) { ids = listed.ids; listSource = 'provider' }
  else if (fromCatalog.length > 0) { ids = fromCatalog; listSource = 'catalog' }
  else { ids = sortModels(AI_PROVIDER_KIND_INFO[p.kind].modelSuggestions); listSource = 'built_in' }

  const current = p.currentModel?.trim()
  const models = ids.slice(0, MAX_MODELS).map((id) => priced(p.kind, id, catalog))
  if (current && !models.some((m) => m.id === current)) models.unshift(priced(p.kind, current, catalog))

  return {
    models,
    listSource,
    // 'unsupported' is the normal case for Azure, Bedrock and Foundry.
    listError: listed.error === 'unsupported' ? null : listed.error,
    priceListOk: catalog !== null,
  }
}
