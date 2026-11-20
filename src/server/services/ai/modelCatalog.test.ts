import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LITELLM_PRICES_URL,
  catalogModelsFor,
  clearPriceCatalogCache,
  fetchLatestModels,
  isOfferedModel,
  loadPriceCatalog,
  parseLiteLlmCatalog,
  priceFromCatalog,
} from './modelCatalog.js'

const LITELLM = {
  sample_spec: { input_cost_per_token: 0, litellm_provider: 'one of …' },
  'claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, litellm_provider: 'anthropic', mode: 'chat' },
  'claude-sonnet-4-5': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, litellm_provider: 'anthropic', mode: 'chat', deprecation_date: '2026-10-30' },
  'claude-3-haiku-20240307': { input_cost_per_token: 2.5e-7, output_cost_per_token: 1.25e-6, litellm_provider: 'anthropic', mode: 'chat' },
  'gpt-6.1-sol': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, litellm_provider: 'openai', mode: 'chat' },
  'gpt-6.1-sol-2026-09-29': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, litellm_provider: 'openai', mode: 'chat' },
  'text-embedding-3-large': { input_cost_per_token: 1.3e-7, output_cost_per_token: 0, litellm_provider: 'openai', mode: 'embedding' },
  'gpt-realtime': { input_cost_per_token: 4e-6, output_cost_per_token: 1.6e-5, litellm_provider: 'openai', mode: 'chat' },
  'azure/gpt-6.1-sol': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, litellm_provider: 'azure', mode: 'chat' },
  'azure/eu/gpt-6.1-sol': { input_cost_per_token: 2.4e-6, output_cost_per_token: 1.2e-5, litellm_provider: 'azure', mode: 'chat' },
  'gemini/gemini-3.8-flash': { input_cost_per_token: 7.5e-7, output_cost_per_token: 3.75e-6, litellm_provider: 'gemini', mode: 'chat' },
  'xai/grok-4.7': { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6, litellm_provider: 'xai', mode: 'chat' },
  'xai/grok-4.20-beta-0309': { input_cost_per_token: 1.25e-6, output_cost_per_token: 2.5e-6, litellm_provider: 'xai', mode: 'chat' },
  'anthropic.claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, litellm_provider: 'bedrock_converse', mode: 'chat' },
  'bedrock_mantle/anthropic.claude-opus-5-5': { input_cost_per_token: 4.4e-6, output_cost_per_token: 2.2e-5, litellm_provider: 'bedrock_mantle', mode: 'chat' },
  'azure_ai/claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, litellm_provider: 'azure_ai', mode: 'chat' },
}

const TODAY = '2026-11-02'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('LiteLLM price list', () => {
  const catalog = parseLiteLlmCatalog(LITELLM)

  it('skips the sample entry and reads per-million-token prices per provider', () => {
    expect(catalog.has('sample_spec')).toBe(false)
    expect(priceFromCatalog(catalog, 'anthropic', 'claude-opus-5-5')).toEqual({ inputPerMTok: 4, outputPerMTok: 20 })
    expect(priceFromCatalog(catalog, 'gemini', 'gemini-3.8-flash')).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75 })
    // Bedrock is called through Mantle, so its price wins over the Converse one.
    expect(priceFromCatalog(catalog, 'bedrock', 'anthropic.claude-opus-5-5')).toEqual({ inputPerMTok: 4.4, outputPerMTok: 22 })
    expect(priceFromCatalog(catalog, 'azure_openai', 'gpt-6.1-sol')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 })
    expect(priceFromCatalog(catalog, 'foundry', 'claude-opus-5-5')).toEqual({ inputPerMTok: 4, outputPerMTok: 20 })
    expect(priceFromCatalog(catalog, 'openai', 'no-such-model')).toBeNull()
    expect(priceFromCatalog(null, 'openai', 'gpt-6.1-sol')).toBeNull()
  })

  it('lists current chat models per kind, without dated, retired or non-chat ids', () => {
    expect(catalogModelsFor(catalog, 'anthropic', TODAY)).toEqual(['claude-opus-5-5'])
    expect(catalogModelsFor(catalog, 'openai', TODAY)).toEqual(['gpt-6.1-sol'])
    expect(catalogModelsFor(catalog, 'azure_openai', TODAY)).toEqual(['gpt-6.1-sol'])
    expect(catalogModelsFor(catalog, 'xai', TODAY)).toEqual(['grok-4.7'])
    expect(catalogModelsFor(catalog, 'bedrock', TODAY)).toEqual(['anthropic.claude-opus-5-5'])
    expect(catalogModelsFor(catalog, 'foundry', TODAY)).toEqual(['claude-opus-5-5'])
    expect(catalogModelsFor(catalog, 'webhook', TODAY)).toEqual([])
  })

  it('filters provider model ids', () => {
    expect(isOfferedModel('openai', 'gpt-6.1-sol')).toBe(true)
    expect(isOfferedModel('openai', 'gpt-4o')).toBe(false)
    expect(isOfferedModel('openai', 'gpt-4.1')).toBe(true)
    expect(isOfferedModel('openai', 'text-embedding-3-small')).toBe(false)
    expect(isOfferedModel('anthropic', 'claude-sonnet-5-5')).toBe(true)
    expect(isOfferedModel('anthropic', 'claude-3-5-sonnet-20241022')).toBe(false)
    expect(isOfferedModel('gemini', 'gemini-3.8-flash')).toBe(true)
    expect(isOfferedModel('gemini', 'gemini-2.5-flash-preview-tts')).toBe(false)
  })

  it('caches the download and falls back to null when GitHub is unreachable', async () => {
    clearPriceCatalogCache()
    const failing = vi.fn(async () => { throw new Error('offline') })
    expect(await loadPriceCatalog(failing, 1_000)).toBeNull()
    expect(await loadPriceCatalog(failing, 2_000)).toBeNull()
    expect(failing).toHaveBeenCalledTimes(1)
    const ok = vi.fn(async (_url: string) => jsonResponse(LITELLM))
    // Retried after the short failure back-off.
    const later = 1_000 + 11 * 60 * 1000
    expect((await loadPriceCatalog(ok, later))?.size).toBeGreaterThan(0)
    await loadPriceCatalog(ok, later + 60_000)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(ok.mock.calls[0]![0]).toBe(LITELLM_PRICES_URL)
  })
})

describe('fetchLatestModels', () => {
  beforeEach(() => clearPriceCatalogCache())

  it("uses the provider's own list with the key, priced from LiteLLM, keeping the current model", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === LITELLM_PRICES_URL) return jsonResponse(LITELLM)
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000')
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-test')
      return jsonResponse({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }, { id: 'claude-3-haiku-20240307' }] })
    })
    const r = await fetchLatestModels({ kind: 'anthropic', secret: 'sk-test', organization: null, currentModel: 'claude-custom' }, { fetchImpl, now: new Date(`${TODAY}T12:00:00Z`) })
    expect(r.listSource).toBe('provider')
    expect(r.listError).toBeNull()
    expect(r.priceListOk).toBe(true)
    expect(r.models.map((m) => m.id)).toEqual(['claude-custom', 'claude-opus-5-5', 'claude-haiku-5-5'])
    expect(r.models.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({ priceSource: 'litellm', price: { inputPerMTok: 4, outputPerMTok: 20 } })
    // Not in this LiteLLM file: the built-in table answers.
    expect(r.models.find((m) => m.id === 'claude-haiku-5-5')).toMatchObject({ priceSource: 'built_in', price: { inputPerMTok: 0.1, outputPerMTok: 0.5 } })
    expect(r.models.find((m) => m.id === 'claude-custom')).toMatchObject({ priceSource: null, price: null })
  })

  it('falls back to the LiteLLM list when the key is refused, and to built-ins when offline', async () => {
    const refused = vi.fn(async (url: string) => (url === LITELLM_PRICES_URL ? jsonResponse(LITELLM) : jsonResponse({ error: 'bad key' }, 401)))
    const r = await fetchLatestModels({ kind: 'openai', secret: 'bad', organization: null }, { fetchImpl: refused, now: new Date(`${TODAY}T12:00:00Z`) })
    expect(r).toMatchObject({ listSource: 'catalog', listError: 'auth', priceListOk: true })
    expect(r.models.map((m) => m.id)).toEqual(['gpt-6.1-sol'])

    clearPriceCatalogCache()
    const offline = vi.fn(async () => { throw new Error('offline') })
    const o = await fetchLatestModels({ kind: 'bedrock', secret: null, organization: null }, { fetchImpl: offline, now: new Date(`${TODAY}T12:00:00Z`) })
    expect(o).toMatchObject({ listSource: 'built_in', listError: null, priceListOk: false })
    expect(o.models.length).toBeGreaterThan(0)
    expect(o.models.every((m) => m.priceSource === 'built_in')).toBe(true)
    // Bedrock has no key-only model list, so nothing but the price list is fetched.
    expect(offline).toHaveBeenCalledTimes(1)
  })

  it('reports a missing key without calling the provider', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LITELLM))
    const r = await fetchLatestModels({ kind: 'gemini', secret: null, organization: null }, { fetchImpl, now: new Date(`${TODAY}T12:00:00Z`) })
    expect(r).toMatchObject({ listSource: 'catalog', listError: 'no_key' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
