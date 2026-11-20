import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk'
import AnthropicFoundry from '@anthropic-ai/foundry-sdk'
import { randomUUID } from 'node:crypto'
import OpenAI, { AzureOpenAI } from 'openai'
import { AI_PROVIDER_KIND_INFO, AZURE_OPENAI_DEFAULT_API_VERSION } from '../../../shared/ai.js'
import { assertAllowedAzureOpenAiEndpoint, assertServiceUrl } from '../net/ssrfGuard.js'
import { safeFetch } from '../net/safeFetch.js'
import { readCappedText, webhookHeaders } from '../webhooks/signing.js'
import type { ResolvedAiProvider } from './providers.js'

// One call to one provider, in either API shape. Everything about budgets,
// routing and logging lives in gateway.ts; this file only speaks to the
// provider and reports back what came out.

const REQUEST_TIMEOUT_MS = 2 * 60 * 1000
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'
const XAI_BASE_URL = 'https://api.x.ai/v1'
const FOUNDRY_RESOURCE_RX = /^[a-z0-9-]{2,64}$/i
const AWS_REGION_RX = /^[a-z]{2}(-gov)?-[a-z]+-\d$/
const WEBHOOK_MAX_RESPONSE_BYTES = 1_000_000
export const AI_WEBHOOK_CONTRACT_VERSION = 1

export type AiEffort = 'low' | 'medium' | 'high'

export interface ProviderCall {
  // Sent to a webhook provider so one endpoint can serve every feature.
  feature?: string | undefined
  system?: string | undefined
  user: string
  maxTokens: number
  effort: AiEffort
  // When set, the answer must be JSON matching this schema. Every property
  // must be listed in `required` and objects must set additionalProperties
  // false, which is what OpenAI's strict mode asks for.
  json?: { name: string; schema: Record<string, unknown> } | undefined
}

export type ProviderOutcome =
  | { status: 'ok'; text: string; inputTokens: number; outputTokens: number }
  | { status: 'refused' | 'error'; message: string; inputTokens: number; outputTokens: number }

// Rejects a provider whose host settings could send people's data somewhere
// other than the provider (SSRF guard, pentest F-02). Every other kind calls a
// fixed host chosen here.
export async function assertProviderHost(p: Pick<ResolvedAiProvider, 'kind' | 'endpoint' | 'allowedCustomHost' | 'region' | 'resource' | 'allowPrivateNetwork'>): Promise<void> {
  if (p.kind === 'webhook') {
    if (!p.endpoint) throw new Error('A webhook URL is required')
    await assertServiceUrl(p.endpoint, p.allowPrivateNetwork)
  } else if (p.kind === 'azure_openai') {
    if (!p.endpoint) throw new Error('An endpoint is required')
    await assertAllowedAzureOpenAiEndpoint(p.endpoint, p.allowedCustomHost)
  } else if (p.kind === 'foundry') {
    if (!p.resource || !FOUNDRY_RESOURCE_RX.test(p.resource)) throw new Error('The Foundry resource name must be letters, digits and hyphens')
  } else if (p.kind === 'bedrock') {
    if (!p.region || !AWS_REGION_RX.test(p.region)) throw new Error('The AWS region must look like us-east-1')
  }
}

// Older Claude models don't accept the effort setting.
function supportsEffort(model: string): boolean {
  return !/claude-3|haiku-4-5|sonnet-4-5|opus-4-1|opus-4-5/.test(model)
}

type MessagesClient = { beta: { messages: Pick<Anthropic['beta']['messages'], 'stream'> } }

function anthropicClient(p: ResolvedAiProvider): MessagesClient {
  const common = { timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 }
  if (p.kind === 'bedrock') {
    return new AnthropicBedrockMantle({
      awsRegion: p.region ?? undefined,
      awsAccessKey: p.accessKeyId,
      awsSecretAccessKey: p.secret,
      ...common,
    }) as unknown as MessagesClient
  }
  if (p.kind === 'foundry') {
    return new AnthropicFoundry({ resource: p.resource ?? undefined, apiKey: p.secret ?? undefined, ...common }) as unknown as MessagesClient
  }
  return new Anthropic({ apiKey: p.secret ?? undefined, ...common })
}

function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The provider rejected the credentials'
  if (err instanceof Anthropic.PermissionDeniedError) return "The credentials aren't allowed to use this model"
  if (err instanceof Anthropic.NotFoundError) return "The provider doesn't know this model"
  if (err instanceof Anthropic.RateLimitError) return 'The provider is rate limiting requests; try again shortly'
  if (err instanceof Anthropic.BadRequestError) return `The provider refused the request: ${err.message}`
  if (err instanceof Anthropic.APIError) return `The provider returned an error (${err.status ?? 'no status'})`
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

async function callAnthropicFamily(p: ResolvedAiProvider, call: ProviderCall): Promise<ProviderOutcome> {
  const client = anthropicClient(p)
  const outputConfig: Anthropic.Beta.BetaOutputConfig = {}
  if (supportsEffort(p.model)) outputConfig.effort = call.effort
  if (call.json) outputConfig.format = { type: 'json_schema', schema: call.json.schema }
  let message: Anthropic.Beta.BetaMessage
  try {
    message = await client.beta.messages
      .stream({
        model: p.model,
        max_tokens: call.maxTokens,
        ...(call.system ? { system: call.system } : {}),
        messages: [{ role: 'user', content: call.user }],
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        // On the Claude API a declined request is retried on Anthropic's
        // recommended fallback model; Bedrock and Foundry don't accept it.
        ...(p.kind === 'anthropic' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      })
      .finalMessage()
  } catch (err) {
    return { status: 'error', message: describeAnthropicError(err), inputTokens: 0, outputTokens: 0 }
  }
  const inputTokens = message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0)
  const outputTokens = message.usage.output_tokens
  if (message.stop_reason === 'refusal') {
    return { status: 'refused', message: 'The AI declined to answer this request', inputTokens, outputTokens }
  }
  if (message.stop_reason === 'max_tokens') {
    return { status: 'error', message: 'The answer was cut off', inputTokens, outputTokens }
  }
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  return { status: 'ok', text, inputTokens, outputTokens }
}

function openAiClient(p: ResolvedAiProvider): OpenAI {
  const common = { apiKey: p.secret ?? '', timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 }
  if (p.kind === 'azure_openai') {
    return new AzureOpenAI({
      ...common,
      endpoint: p.endpoint ?? '',
      apiVersion: p.apiVersion || AZURE_OPENAI_DEFAULT_API_VERSION,
      deployment: p.model,
    })
  }
  if (p.kind === 'gemini') return new OpenAI({ ...common, baseURL: GEMINI_BASE_URL })
  if (p.kind === 'xai') return new OpenAI({ ...common, baseURL: XAI_BASE_URL })
  return new OpenAI({ ...common, ...(p.organization ? { organization: p.organization } : {}) })
}

function describeOpenAiError(err: unknown): string {
  if (err instanceof OpenAI.AuthenticationError) return 'The provider rejected the credentials'
  if (err instanceof OpenAI.PermissionDeniedError) return "The credentials aren't allowed to use this model"
  if (err instanceof OpenAI.NotFoundError) return "The provider doesn't know this model or deployment"
  if (err instanceof OpenAI.RateLimitError) return 'The provider is rate limiting requests; try again shortly'
  if (err instanceof OpenAI.BadRequestError) return `The provider refused the request: ${err.message}`
  if (err instanceof OpenAI.APIError) return `The provider returned an error (${err.status ?? 'no status'})`
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

async function callOpenAiFamily(p: ResolvedAiProvider, call: ProviderCall): Promise<ProviderOutcome> {
  const client = openAiClient(p)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (call.system) messages.push({ role: 'system', content: call.system })
  messages.push({ role: 'user', content: call.user })
  // OpenAI and Azure reasoning models only take max_completion_tokens; the
  // Gemini and xAI compatibility endpoints document max_tokens.
  const limit = p.kind === 'openai' || p.kind === 'azure_openai'
    ? { max_completion_tokens: call.maxTokens }
    : { max_tokens: call.maxTokens }
  let completion: OpenAI.Chat.ChatCompletion
  try {
    completion = await client.chat.completions.create({
      model: p.model,
      messages,
      ...limit,
      ...(call.json
        ? { response_format: { type: 'json_schema' as const, json_schema: { name: call.json.name, schema: call.json.schema, strict: true } } }
        : {}),
    })
  } catch (err) {
    return { status: 'error', message: describeOpenAiError(err), inputTokens: 0, outputTokens: 0 }
  }
  const inputTokens = completion.usage?.prompt_tokens ?? 0
  const outputTokens = completion.usage?.completion_tokens ?? 0
  const choice = completion.choices[0]
  if (choice?.message.refusal) {
    return { status: 'refused', message: 'The AI declined to answer this request', inputTokens, outputTokens }
  }
  if (choice?.finish_reason === 'content_filter') {
    return { status: 'refused', message: "The provider's content filter blocked the answer", inputTokens, outputTokens }
  }
  if (choice?.finish_reason === 'length') {
    return { status: 'error', message: 'The answer was cut off', inputTokens, outputTokens }
  }
  return { status: 'ok', text: choice?.message.content ?? '', inputTokens, outputTokens }
}

// The webhook contract (docs/ai-webhook.md). One signed POST per call; the
// endpoint answers with the text (or JSON) and, optionally, token usage.
// Redirects are refused so a checked URL can't hand the request to another
// host.
export function webhookRequestBody(p: Pick<ResolvedAiProvider, 'model'>, call: ProviderCall, requestId: string = randomUUID()) {
  return {
    version: AI_WEBHOOK_CONTRACT_VERSION,
    requestId,
    feature: call.feature ?? null,
    model: p.model,
    system: call.system ?? null,
    user: call.user,
    maxTokens: call.maxTokens,
    effort: call.effort,
    responseFormat: call.json
      ? { type: 'json_schema' as const, name: call.json.name, schema: call.json.schema }
      : { type: 'text' as const },
  }
}

function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0
}

export function parseWebhookAnswer(raw: string, wantsJson: boolean): ProviderOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'error', message: 'The webhook did not answer with JSON', inputTokens: 0, outputTokens: 0 }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'error', message: 'The webhook answer must be a JSON object', inputTokens: 0, outputTokens: 0 }
  }
  const v = parsed as Record<string, unknown>
  const usage = (v['usage'] && typeof v['usage'] === 'object') ? v['usage'] as Record<string, unknown> : {}
  const inputTokens = tokenCount(usage['inputTokens'])
  const outputTokens = tokenCount(usage['outputTokens'])
  if (v['refused'] === true) {
    const message = typeof v['message'] === 'string' && v['message'].trim() ? v['message'].slice(0, 500) : 'The AI declined to answer this request'
    return { status: 'refused', message, inputTokens, outputTokens }
  }
  let text: string | null = null
  if (typeof v['text'] === 'string') text = v['text']
  else if (wantsJson && v['json'] !== undefined && v['json'] !== null) text = JSON.stringify(v['json'])
  if (text === null) {
    return { status: 'error', message: wantsJson ? 'The webhook answer has no "text" or "json" field' : 'The webhook answer has no "text" field', inputTokens, outputTokens }
  }
  return { status: 'ok', text, inputTokens, outputTokens }
}

async function callWebhook(p: ResolvedAiProvider, call: ProviderCall): Promise<ProviderOutcome> {
  const body = JSON.stringify(webhookRequestBody(p, call))
  let res: Response
  try {
    res = await safeFetch(p.endpoint ?? '', {
      method: 'POST',
      headers: webhookHeaders(p.secret, body),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { allowPrivateNetwork: p.allowPrivateNetwork })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { status: 'error', message: timedOut ? 'The webhook did not answer in time' : "The webhook couldn't be reached", inputTokens: 0, outputTokens: 0 }
  }
  if (res.status >= 300 && res.status < 400) {
    return { status: 'error', message: 'The webhook answered with a redirect, which is not followed', inputTokens: 0, outputTokens: 0 }
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'error', message: 'The webhook rejected the credentials', inputTokens: 0, outputTokens: 0 }
  }
  if (!res.ok) {
    return { status: 'error', message: `The webhook returned an error (${res.status})`, inputTokens: 0, outputTokens: 0 }
  }
  let raw: string
  try {
    raw = await readCappedText(res, WEBHOOK_MAX_RESPONSE_BYTES)
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err), inputTokens: 0, outputTokens: 0 }
  }
  return parseWebhookAnswer(raw, !!call.json)
}

export async function callProvider(p: ResolvedAiProvider, call: ProviderCall): Promise<ProviderOutcome> {
  try {
    await assertProviderHost(p)
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err), inputTokens: 0, outputTokens: 0 }
  }
  const info = AI_PROVIDER_KIND_INFO[p.kind]
  if (!p.secret && !info.secretOptional) return { status: 'error', message: 'No API key is saved for this provider', inputTokens: 0, outputTokens: 0 }
  if (info.family === 'webhook') return callWebhook(p, call)
  return info.family === 'anthropic'
    ? callAnthropicFamily(p, call)
    : callOpenAiFamily(p, call)
}
