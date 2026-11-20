import { createHash } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { aiProviders, aiRequests, users } from '../../../../drizzle/schema.js'
import { estimateCostUsd, isAiFeatureOn, monthKey, type AiFeature, type AiRequestFeature, type AiRequestStatus } from '../../../shared/ai.js'
import { sendByRule } from '../email/rule-sender.js'
import { callProvider, type AiEffort, type ProviderOutcome } from './adapters.js'
import { getAiSettings, providerForFeature, resolveProvider, saveAiSettings, type AiProviderRow, type ResolvedAiProvider } from './providers.js'

// The one way the app calls an AI provider (CLAUDE.md §14, AI Assistant).
// Checks the master switch, picks the provider (the feature's route, else the
// default), stops at the monthly budget, calls, and logs one ai_requests row
// per attempt: usage, estimated cost and a hash of the input, never the input.

export interface AiRequest {
  feature: AiFeature
  system?: string
  user: string
  maxTokens?: number
  effort?: AiEffort
  json?: { name: string; schema: Record<string, unknown> }
  requestedBy?: string | null
  // v1.457.0: the team the call is charged to (AI Notes' per-team limit).
  teamId?: string | null
  // v1.473.0: how many items this one request covers (a batch of meetings).
  itemCount?: number | null
}

export type AiUnavailableReason = 'disabled' | 'no_provider' | 'over_budget'

export type AiResult =
  | { ok: true; text: string; providerId: string; model: string }
  | { ok: false; reason: AiUnavailableReason | 'error' | 'refused'; message: string }

// Claude models always think, and thinking counts against max_tokens, so the
// default leaves room for it.
const DEFAULT_MAX_TOKENS = 4000

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

export async function spentThisMonthUsd(now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)` })
    .from(aiRequests)
    .where(gte(aiRequests.createdAt, startOfUtcMonth(now)))
  return Number(row?.total ?? 0)
}

// What one team's AI calls cost this calendar month (rows tagged with it).
export async function teamSpentThisMonthUsd(teamId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)` })
    .from(aiRequests)
    .where(and(eq(aiRequests.teamId, teamId), gte(aiRequests.createdAt, startOfUtcMonth(now))))
  return Number(row?.total ?? 0)
}

export function hashInput(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

interface RecordInput {
  feature: AiRequestFeature
  provider: Pick<ResolvedAiProvider, 'id' | 'kind' | 'name' | 'model' | 'price'> | null
  requestedBy: string | null
  teamId?: string | null
  itemCount?: number | null
  inputHash: string | null
  status: AiRequestStatus
  inputTokens: number
  outputTokens: number
  error: string | null
  durationMs: number | null
}

export async function recordAiRequest(r: RecordInput): Promise<void> {
  try {
    await db.insert(aiRequests).values({
      feature: r.feature,
      providerId: r.provider?.id ?? null,
      providerKind: r.provider?.kind ?? null,
      providerName: r.provider?.name ?? null,
      model: r.provider?.model ?? null,
      requestedBy: r.requestedBy,
      teamId: r.teamId ?? null,
      itemCount: r.itemCount ?? null,
      inputHash: r.inputHash,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: estimateCostUsd(r.provider?.price ?? null, r.inputTokens, r.outputTokens).toFixed(6),
      status: r.status,
      error: r.error ? r.error.slice(0, 1000) : null,
      durationMs: r.durationMs,
    })
  } catch (err) {
    console.warn('[ai] could not record request:', err instanceof Error ? err.message : String(err))
  }
}

// One email to every App Admin the first time a month's budget is reached.
async function alertBudgetReached(budgetUsd: number, spentUsd: number, now: Date): Promise<void> {
  const settings = await getAiSettings()
  const month = monthKey(now)
  if (settings.budgetAlertSentFor === month) return
  await saveAiSettings({ ...settings, budgetAlertSentFor: month })
  const { emitAiBudgetReached } = await import('../webhooks/events.js')
  await emitAiBudgetReached({ month, budgetUsd, spentUsd })
  try {
    const admins = await db.select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.isAppAdmin, true))
    const budget = `$${budgetUsd.toFixed(2)}`
    const spent = `$${spentUsd.toFixed(2)}`
    for (const a of admins) {
      if (!a.email) continue
      await sendByRule('ai_budget_reached', {
        to: a.email,
        toName: a.displayName ?? undefined,
        defaultSubject: '[ImpactIQ] AI monthly budget reached',
        defaultBodyHtml: `<p>ImpactIQ's AI requests reached this month's budget of <strong>${budget}</strong> (spent so far: ${spent}).</p><p>AI features now fall back to their non-AI behavior until next month, or until the budget is raised on Admin → Integrations → AI Assistant.</p>`,
        defaultBodyText: `ImpactIQ's AI requests reached this month's budget of ${budget} (spent so far: ${spent}). AI features fall back to their non-AI behavior until next month, or until the budget is raised on Admin → Integrations → AI Assistant.`,
        tokens: { budget, spent, month },
        userId: a.id,
        severity: 'warning',
      }).catch((err: unknown) => {
        // One admin's failed send must not stop the next admin's email or DM.
        console.warn('[ai] budget alert failed for an admin:', err instanceof Error ? err.message : String(err))
      })
    }
  } catch (err) {
    console.warn('[ai] budget email failed:', err instanceof Error ? err.message : String(err))
  }
}

// Whether a feature could call AI right now, without calling it. Routes use it
// to answer "AI unavailable" before doing any work.
export async function aiAvailability(feature: AiFeature): Promise<{ ok: true; provider: AiProviderRow } | { ok: false; reason: AiUnavailableReason }> {
  const settings = await getAiSettings()
  if (!settings.enabled || !isAiFeatureOn(settings, feature)) return { ok: false, reason: 'disabled' }
  const provider = await providerForFeature(feature)
  if (!provider) return { ok: false, reason: 'no_provider' }
  if (settings.monthlyBudgetUsd !== null && (await spentThisMonthUsd()) >= settings.monthlyBudgetUsd) {
    return { ok: false, reason: 'over_budget' }
  }
  return { ok: true, provider }
}

export async function callResolvedProvider(
  provider: ResolvedAiProvider,
  feature: AiRequestFeature,
  call: { system?: string | undefined; user: string; maxTokens: number; effort: AiEffort; json?: AiRequest['json'] },
  requestedBy: string | null,
  teamId: string | null = null,
  itemCount: number | null = null,
): Promise<ProviderOutcome> {
  const started = Date.now()
  const outcome = await callProvider(provider, { ...call, feature })
  await recordAiRequest({
    feature,
    provider,
    requestedBy,
    teamId,
    itemCount,
    inputHash: hashInput({ system: call.system ?? null, user: call.user }),
    status: outcome.status,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    error: outcome.status === 'ok' ? null : outcome.message,
    durationMs: Date.now() - started,
  })
  if (outcome.status !== 'ok') console.warn(`[ai] ${feature} via ${provider.kind}: ${outcome.message}`)
  return outcome
}

export async function runAi(req: AiRequest): Promise<AiResult> {
  const settings = await getAiSettings()
  if (!settings.enabled) return { ok: false, reason: 'disabled', message: 'The AI assistant is turned off' }
  // A feature turned off by an App Admin answers like the master switch, so
  // every caller already falls back to its no-AI behavior.
  if (!isAiFeatureOn(settings, req.feature)) return { ok: false, reason: 'disabled', message: 'This AI feature is turned off' }
  const row = await providerForFeature(req.feature)
  if (!row) return { ok: false, reason: 'no_provider', message: 'No active AI provider' }

  let provider: ResolvedAiProvider
  try {
    provider = resolveProvider(row)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordAiRequest({ feature: req.feature, provider: null, requestedBy: req.requestedBy ?? null, teamId: req.teamId ?? null, inputHash: null, status: 'error', inputTokens: 0, outputTokens: 0, error: message, durationMs: null })
    return { ok: false, reason: 'error', message: "The provider's saved key can't be read; enter it again" }
  }

  if (settings.monthlyBudgetUsd !== null) {
    const spent = await spentThisMonthUsd()
    if (spent >= settings.monthlyBudgetUsd) {
      await recordAiRequest({ feature: req.feature, provider, requestedBy: req.requestedBy ?? null, teamId: req.teamId ?? null, inputHash: null, status: 'over_budget', inputTokens: 0, outputTokens: 0, error: null, durationMs: null })
      await alertBudgetReached(settings.monthlyBudgetUsd, spent, new Date())
      return { ok: false, reason: 'over_budget', message: "This month's AI budget has been used up" }
    }
  }

  const outcome = await callResolvedProvider(provider, req.feature, {
    system: req.system,
    user: req.user,
    maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    effort: req.effort ?? 'medium',
    json: req.json,
  }, req.requestedBy ?? null, req.teamId ?? null, req.itemCount ?? null)
  if (outcome.status !== 'ok') return { ok: false, reason: outcome.status, message: outcome.message }
  return { ok: true, text: outcome.text, providerId: provider.id, model: provider.model }
}

// A tiny real call used by the admin Test button and the Setup wizard. It
// ignores the master switch and the budget, and is logged as connection_test.
export async function testAiProvider(provider: ResolvedAiProvider, requestedBy: string | null): Promise<{ ok: boolean; message: string }> {
  const outcome = await callResolvedProvider(provider, 'connection_test', {
    user: 'Reply with the word OK.',
    maxTokens: 2000,
    effort: 'low',
  }, requestedBy)
  if (outcome.status === 'ok') return { ok: true, message: `Connected to ${provider.model}` }
  return { ok: false, message: outcome.message }
}

export async function recordProviderTest(id: string, result: { ok: boolean; message: string }): Promise<void> {
  await db.update(aiProviders)
    .set({ lastTestedAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message.slice(0, 500) })
    .where(eq(aiProviders.id, id))
}
