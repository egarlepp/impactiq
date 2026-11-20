// The AI Assistant's webhook provider (docs/ai-webhook.md): what ImpactIQ
// sends, how it signs it, and how it reads the answer.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callProvider, parseWebhookAnswer, webhookRequestBody, type ProviderCall } from './adapters.js'
import type { ResolvedAiProvider } from './providers.js'
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '../webhooks/signing.js'
// safeFetch pins DNS through undici's own fetch and never follows a redirect;
// these tests stub the global fetch, so the mock keeps the redirect rule.
vi.mock('../net/safeFetch.js', () => ({ safeFetch: (url: string | URL, init?: RequestInit) => globalThis.fetch(url, { ...init, redirect: 'manual' }) }))


function webhook(overrides: Partial<ResolvedAiProvider> = {}): ResolvedAiProvider {
  return {
    id: 'p1', kind: 'webhook', name: 'n8n', model: 'default', secret: 's3cret',
    // TEST-NET-3: a public address that needs no DNS lookup.
    endpoint: 'https://203.0.113.10/webhook/ai',
    apiVersion: null, allowedCustomHost: null, region: null, accessKeyId: null, resource: null, organization: null,
    allowPrivateNetwork: false, price: null,
    ...overrides,
  }
}

const call: ProviderCall = { feature: 'activity_classify', system: 'sys', user: 'hello', maxTokens: 100, effort: 'low' }

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { vi.unstubAllGlobals() })

describe('webhook request', () => {
  it('sends the contract body, signed with the shared secret', async () => {
    const fetchMock = respond(200, { text: 'Demo', usage: { inputTokens: 12, outputTokens: 3 } })
    const out = await callProvider(webhook(), call)
    expect(out).toEqual({ status: 'ok', text: 'Demo', inputTokens: 12, outputTokens: 3 })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://203.0.113.10/webhook/ai')
    expect(init.redirect).toBe('manual')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ version: 1, feature: 'activity_classify', model: 'default', system: 'sys', user: 'hello', maxTokens: 100, responseFormat: { type: 'text' } })
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer s3cret')
    expect(verifyWebhookSignature('s3cret', headers[WEBHOOK_TIMESTAMP_HEADER]!, String(init.body), headers[WEBHOOK_SIGNATURE_HEADER]!)).toBe(true)
  })

  it('sends no token or signature without a secret', async () => {
    const fetchMock = respond(200, { text: 'ok' })
    await callProvider(webhook({ secret: null }), call)
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined()
  })

  it('describes a JSON answer with its schema', () => {
    const body = webhookRequestBody(webhook(), { ...call, json: { name: 'pick', schema: { type: 'object' } } }, 'r1')
    expect(body.requestId).toBe('r1')
    expect(body.responseFormat).toEqual({ type: 'json_schema', name: 'pick', schema: { type: 'object' } })
  })
})

describe('webhook host checks', () => {
  it('refuses a private address unless the provider allows it', async () => {
    const fetchMock = respond(200, { text: 'ok' })
    const blocked = await callProvider(webhook({ endpoint: 'https://10.0.0.5/ai' }), call)
    expect(blocked.status).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()

    const allowed = await callProvider(webhook({ endpoint: 'http://10.0.0.5/ai', allowPrivateNetwork: true }), call)
    expect(allowed.status).toBe('ok')
  })

  it('never allows loopback or cloud metadata, even on a private network', async () => {
    const fetchMock = respond(200, { text: 'ok' })
    for (const endpoint of ['http://127.0.0.1/ai', 'http://169.254.169.254/latest']) {
      const out = await callProvider(webhook({ endpoint, allowPrivateNetwork: true }), call)
      expect(out.status).toBe('error')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses plain http to a public address', async () => {
    respond(200, { text: 'ok' })
    const out = await callProvider(webhook({ endpoint: 'http://203.0.113.10/ai', allowPrivateNetwork: true }), call)
    expect(out.status).toBe('error')
  })
})

describe('webhook answers', () => {
  it('does not follow a redirect', async () => {
    respond(302, '', { location: 'https://203.0.113.11/' })
    const out = await callProvider(webhook(), call)
    expect(out).toMatchObject({ status: 'error', message: expect.stringContaining('redirect') })
  })

  it('reports rejected credentials and other HTTP errors', async () => {
    respond(401, {})
    expect(await callProvider(webhook(), call)).toMatchObject({ status: 'error', message: 'The webhook rejected the credentials' })
    respond(500, {})
    expect(await callProvider(webhook(), call)).toMatchObject({ status: 'error', message: 'The webhook returned an error (500)' })
  })

  it('refuses an answer over the size limit', async () => {
    respond(200, JSON.stringify({ text: 'x'.repeat(1_100_000) }))
    expect(await callProvider(webhook(), call)).toMatchObject({ status: 'error', message: expect.stringContaining('larger than') })
  })

  it('reads text, JSON objects and refusals', () => {
    expect(parseWebhookAnswer('{"text":"hi"}', false)).toEqual({ status: 'ok', text: 'hi', inputTokens: 0, outputTokens: 0 })
    expect(parseWebhookAnswer('{"json":{"a":1}}', true)).toMatchObject({ status: 'ok', text: '{"a":1}' })
    expect(parseWebhookAnswer('{"json":{"a":1}}', false).status).toBe('error')
    expect(parseWebhookAnswer('{"refused":true,"message":"No"}', false)).toMatchObject({ status: 'refused', message: 'No' })
    expect(parseWebhookAnswer('not json', false).status).toBe('error')
    expect(parseWebhookAnswer('[1]', false).status).toBe('error')
    expect(parseWebhookAnswer('{"text":"a","usage":{"inputTokens":-4,"outputTokens":"9"}}', false)).toMatchObject({ inputTokens: 0, outputTokens: 0 })
  })
})
