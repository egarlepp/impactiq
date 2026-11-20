import { Router } from 'express'
import { z } from 'zod'
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { aiFeatureRoutes, aiProviders, aiRequests } from '../../../drizzle/schema.js'
import { requireAppAdmin } from '../middleware/rbac.js'
import { logAudit } from '../services/audit/log.js'
import { assertProviderHost } from '../services/ai/adapters.js'
import { recordProviderTest, spentThisMonthUsd, startOfUtcMonth, testAiProvider } from '../services/ai/gateway.js'
import { fetchLatestModels } from '../services/ai/modelCatalog.js'
import { aiUsageView } from '../services/ai/usage.js'
import { decryptToken, encryptToken } from '../services/config/crypto.js'
import {
  clearAiCache,
  getAiSettings,
  providerPrice,
  resolveProvider,
  saveAiSettings,
  type AiProviderRow,
} from '../services/ai/providers.js'
import {
  AI_FEATURES,
  AI_PROVIDER_KIND_INFO,
  AI_PROVIDER_KINDS,
  AI_USAGE_GROUP_BYS,
  AI_USAGE_NONE,
  type AiProviderField,
  type AiProviderKind,
} from '../../shared/ai.js'

// Admin → Integrations → AI Assistant (CLAUDE.md §14). App Admin only: these
// settings decide whether people's meeting and note text leaves the app, and
// where it goes. Mounted at /api/admin/ai.
export const aiAdminRouter = Router()
aiAdminRouter.use(requireAppAdmin)

const FIELD_COLUMNS: Record<AiProviderField, keyof AiProviderRow> = {
  endpoint: 'endpoint',
  apiVersion: 'apiVersion',
  allowedCustomHost: 'allowedCustomHost',
  region: 'region',
  accessKeyId: 'accessKeyId',
  resource: 'resource',
  organization: 'organization',
}


// What the browser sees of a provider: everything but the secret.
function publicProvider(row: AiProviderRow) {
  const price = providerPrice(row)
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isActive: row.isActive,
    isDefault: row.isDefault,
    model: row.model,
    hasSecret: !!row.secretEncrypted,
    endpoint: row.endpoint,
    apiVersion: row.apiVersion,
    allowedCustomHost: row.allowedCustomHost,
    region: row.region,
    accessKeyId: row.accessKeyId,
    resource: row.resource,
    organization: row.organization,
    allowPrivateNetwork: row.allowPrivateNetwork,
    inputPricePerMTok: row.inputPricePerMTok == null ? null : Number(row.inputPricePerMTok),
    outputPricePerMTok: row.outputPricePerMTok == null ? null : Number(row.outputPricePerMTok),
    priceKnown: price !== null,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
    updatedAt: row.updatedAt,
  }
}

// Audit meta for a provider: the same view the browser gets, no secret.
const auditView = publicProvider

function blankToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

const optionalText = z.string().max(500).nullable().optional()
const optionalPrice = z.number().min(0).max(100000).nullable().optional()

const ProviderBody = z.object({
  kind: z.enum(AI_PROVIDER_KINDS),
  name: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  isActive: z.boolean().optional(),
  // Blank keeps the stored secret on an update.
  secret: z.string().max(8000).optional(),
  // Removes the stored secret; only for kinds whose secret is optional.
  clearSecret: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  endpoint: optionalText,
  apiVersion: optionalText,
  allowedCustomHost: optionalText,
  region: optionalText,
  accessKeyId: optionalText,
  resource: optionalText,
  organization: optionalText,
  inputPricePerMTok: optionalPrice,
  outputPricePerMTok: optionalPrice,
})
type ProviderBodyT = z.infer<typeof ProviderBody>

// Builds the column values for an insert or update and checks the kind's
// required settings against the provider as it will be after the write.
async function providerValues(body: ProviderBodyT, existing: AiProviderRow | null): Promise<
  { ok: true; values: Partial<typeof aiProviders.$inferInsert> } | { ok: false; error: string }
> {
  const kind = body.kind as AiProviderKind
  const info = AI_PROVIDER_KIND_INFO[kind]
  const allowed = new Set<AiProviderField>([...info.required, ...info.optional])
  const values: Partial<typeof aiProviders.$inferInsert> = {
    kind,
    name: body.name,
    model: body.model,
  }
  if (body.isActive !== undefined) values.isActive = body.isActive

  for (const field of Object.keys(FIELD_COLUMNS) as AiProviderField[]) {
    const column = FIELD_COLUMNS[field]
    if (!allowed.has(field)) {
      ;(values as Record<string, unknown>)[column] = null
      continue
    }
    const next = blankToNull(body[field])
    if (next !== undefined) (values as Record<string, unknown>)[column] = next
  }

  const effective = (field: AiProviderField): string | null => {
    const column = FIELD_COLUMNS[field]
    const v = (values as Record<string, unknown>)[column]
    if (v !== undefined) return (v as string | null)
    return existing && existing.kind === kind ? (existing[column] as string | null) : null
  }
  for (const field of info.required) {
    if (!effective(field)) return { ok: false, error: `errors.ai.missing_${field}` }
  }

  const secret = body.secret?.trim()
  if (secret) values.secretEncrypted = encryptToken(secret)
  else if (info.secretOptional && (body.clearSecret || !existing || existing.kind !== kind)) values.secretEncrypted = null
  else if (!existing || existing.kind !== kind) return { ok: false, error: 'errors.ai.missing_secret' }

  if (info.privateNetworkOption) {
    if (body.allowPrivateNetwork !== undefined) values.allowPrivateNetwork = body.allowPrivateNetwork
  } else {
    values.allowPrivateNetwork = false
  }
  const allowPrivateNetwork = values.allowPrivateNetwork
    ?? (existing && existing.kind === kind ? existing.allowPrivateNetwork : false)

  if (body.inputPricePerMTok !== undefined) values.inputPricePerMTok = body.inputPricePerMTok == null ? null : String(body.inputPricePerMTok)
  if (body.outputPricePerMTok !== undefined) values.outputPricePerMTok = body.outputPricePerMTok == null ? null : String(body.outputPricePerMTok)

  try {
    await assertProviderHost({
      kind,
      endpoint: effective('endpoint'),
      allowedCustomHost: effective('allowedCustomHost'),
      region: effective('region'),
      resource: effective('resource'),
      allowPrivateNetwork,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, values }
}

aiAdminRouter.get('/', async (_req, res) => {
  const settings = await getAiSettings()
  const providers = await db.select().from(aiProviders).orderBy(aiProviders.createdAt)
  const routes = await db.select().from(aiFeatureRoutes)
  const spent = await spentThisMonthUsd()
  const since = startOfUtcMonth(new Date())
  const monthByProvider = await db
    .select({
      providerId: aiRequests.providerId,
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${aiRequests.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${aiRequests.outputTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)`,
    })
    .from(aiRequests)
    .where(gte(aiRequests.createdAt, since))
    .groupBy(aiRequests.providerId)

  res.json({
    data: {
      settings: { enabled: settings.enabled, monthlyBudgetUsd: settings.monthlyBudgetUsd, disabledFeatures: settings.disabledFeatures },
      providers: providers.map(publicProvider),
      routes: Object.fromEntries(routes.map((r) => [r.feature, r.providerId])),
      month: {
        spentUsd: spent,
        budgetReached: settings.monthlyBudgetUsd !== null && spent >= settings.monthlyBudgetUsd,
        byProvider: monthByProvider.map((r) => ({
          providerId: r.providerId,
          requests: Number(r.requests),
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          costUsd: Number(r.costUsd),
        })),
      },
    },
    error: null,
    meta: {},
  })
})

// GET /usage: this month's requests grouped by feature, team or person, and
// one page (20) of the requests, filtered by feature / team / person.
const usageQuerySchema = z.object({
  groupBy: z.enum(AI_USAGE_GROUP_BYS).default('feature'),
  feature: z.string().trim().min(1).max(64).optional(),
  teamId: z.union([z.literal(AI_USAGE_NONE), z.string().uuid()]).optional(),
  userId: z.union([z.literal(AI_USAGE_NONE), z.string().uuid()]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
})

aiAdminRouter.get('/usage', async (req, res) => {
  const pick = (k: string) => { const v = req.query[k]; return typeof v === 'string' && v !== '' ? v : undefined }
  const parsed = usageQuerySchema.safeParse({
    groupBy: pick('groupBy'), feature: pick('feature'), teamId: pick('teamId'), userId: pick('userId'), page: pick('page'),
  })
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation_failed', meta: {} }); return }
  res.json({ data: await aiUsageView(parsed.data), error: null, meta: {} })
})

aiAdminRouter.put('/settings', async (req, res) => {
  const parsed = z.object({
    enabled: z.boolean().optional(),
    monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
    // v1.468.0: the features turned off (the whole list, not a diff).
    disabledFeatures: z.array(z.enum(AI_FEATURES)).max(AI_FEATURES.length).optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const before = await getAiSettings()
  const after = { ...before }
  if (parsed.data.enabled !== undefined) after.enabled = parsed.data.enabled
  if (parsed.data.monthlyBudgetUsd !== undefined) {
    after.monthlyBudgetUsd = parsed.data.monthlyBudgetUsd
    // A changed budget may be reached again this month; let it email again.
    if (parsed.data.monthlyBudgetUsd !== before.monthlyBudgetUsd) after.budgetAlertSentFor = null
  }
  if (parsed.data.disabledFeatures !== undefined) after.disabledFeatures = [...new Set(parsed.data.disabledFeatures)]
  await saveAiSettings(after)
  await logAudit(req, {
    action: 'ai.settings.update',
    targetType: 'integration',
    targetId: 'ai_settings',
    meta: {
      before: { enabled: before.enabled, monthlyBudgetUsd: before.monthlyBudgetUsd, disabledFeatures: before.disabledFeatures },
      after: { enabled: after.enabled, monthlyBudgetUsd: after.monthlyBudgetUsd, disabledFeatures: after.disabledFeatures },
    },
  })
  res.json({ data: { enabled: after.enabled, monthlyBudgetUsd: after.monthlyBudgetUsd, disabledFeatures: after.disabledFeatures }, error: null, meta: {} })
})

aiAdminRouter.post('/providers', async (req, res) => {
  const parsed = ProviderBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const built = await providerValues(parsed.data, null)
  if (!built.ok) { res.status(400).json({ data: null, error: built.error, meta: {} }); return }
  const [{ count }] = await db.select({ count: sql<string>`count(*)` }).from(aiProviders) as [{ count: string }]
  const isFirst = Number(count) === 0
  const [row] = await db.insert(aiProviders).values({
    ...built.values,
    kind: parsed.data.kind,
    name: parsed.data.name,
    model: parsed.data.model,
    isActive: parsed.data.isActive ?? true,
    isDefault: isFirst,
    updatedBy: req.user!.id,
  }).returning()
  clearAiCache()
  await logAudit(req, { action: 'ai.provider.create', targetType: 'ai_provider', targetId: row!.id, meta: { after: auditView(row!) } })
  res.status(201).json({ data: publicProvider(row!), error: null, meta: {} })
})

aiAdminRouter.patch('/providers/:id', async (req, res) => {
  const id = String(req.params['id'])
  const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.ai.provider_not_found', meta: {} }); return }
  const parsed = ProviderBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // The default provider stays active; another one has to be made default first.
  if (existing.isDefault && parsed.data.isActive === false) {
    res.status(409).json({ data: null, error: 'errors.ai.default_must_be_active', meta: {} }); return
  }
  const built = await providerValues(parsed.data, existing)
  if (!built.ok) { res.status(400).json({ data: null, error: built.error, meta: {} }); return }
  const changed = built.values.kind !== existing.kind || built.values.model !== existing.model
    || built.values.secretEncrypted !== undefined || built.values.endpoint !== existing.endpoint
  const [row] = await db.update(aiProviders)
    .set({
      ...built.values,
      // A new model, kind or key needs a fresh test.
      ...(changed ? { lastTestedAt: null, lastTestOk: null, lastTestMessage: null } : {}),
      updatedBy: req.user!.id,
      updatedAt: new Date(),
    })
    .where(eq(aiProviders.id, id))
    .returning()
  clearAiCache()
  await logAudit(req, { action: 'ai.provider.update', targetType: 'ai_provider', targetId: id, meta: { before: auditView(existing), after: auditView(row!) } })
  res.json({ data: publicProvider(row!), error: null, meta: {} })
})

aiAdminRouter.delete('/providers/:id', async (req, res) => {
  const id = String(req.params['id'])
  const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.ai.provider_not_found', meta: {} }); return }
  const others = await db.select({ id: aiProviders.id }).from(aiProviders).where(ne(aiProviders.id, id))
  if (existing.isDefault && others.length > 0) {
    res.status(409).json({ data: null, error: 'errors.ai.cannot_delete_default', meta: {} }); return
  }
  await db.delete(aiProviders).where(eq(aiProviders.id, id))
  clearAiCache()
  await logAudit(req, { action: 'ai.provider.delete', targetType: 'ai_provider', targetId: id, meta: { before: auditView(existing) } })
  res.json({ data: { id }, error: null, meta: {} })
})

aiAdminRouter.post('/providers/:id/default', async (req, res) => {
  const id = String(req.params['id'])
  const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.ai.provider_not_found', meta: {} }); return }
  if (!existing.isActive) { res.status(409).json({ data: null, error: 'errors.ai.default_must_be_active', meta: {} }); return }
  const [previous] = await db.select({ id: aiProviders.id, name: aiProviders.name }).from(aiProviders).where(eq(aiProviders.isDefault, true)).limit(1)
  await db.transaction(async (tx) => {
    await tx.update(aiProviders).set({ isDefault: false }).where(and(eq(aiProviders.isDefault, true), ne(aiProviders.id, id)))
    await tx.update(aiProviders).set({ isDefault: true, updatedAt: new Date() }).where(eq(aiProviders.id, id))
  })
  clearAiCache()
  await logAudit(req, {
    action: 'ai.provider.set_default',
    targetType: 'ai_provider',
    targetId: id,
    meta: { before: { defaultProvider: previous?.name ?? null }, after: { defaultProvider: existing.name } },
  })
  res.json({ data: { id }, error: null, meta: {} })
})

aiAdminRouter.post('/providers/:id/test', async (req, res) => {
  const id = String(req.params['id'])
  const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.ai.provider_not_found', meta: {} }); return }
  let result: { ok: boolean; message: string }
  try {
    result = await testAiProvider(resolveProvider(existing), req.user!.id)
  } catch {
    result = { ok: false, message: "The saved key can't be read; enter it again" }
  }
  await recordProviderTest(id, result)
  clearAiCache()
  await logAudit(req, { action: 'ai.provider.test', targetType: 'ai_provider', targetId: id, meta: { ok: result.ok, message: result.message } })
  res.json({ data: result, error: null, meta: {} })
})

// "Fetch latest models" on the provider form: the provider's own model list
// (with the typed key, else the saved one) and an input/output price per
// model from the LiteLLM price list. The prices only fill the form; the
// admin can change them before saving. Read-only, so not audited.
const ModelsBody = z.object({
  kind: z.enum(AI_PROVIDER_KINDS),
  providerId: z.string().uuid().nullable().optional(),
  secret: z.string().max(8000).optional(),
  organization: optionalText,
  model: z.string().trim().max(200).optional(),
}).strict()

aiAdminRouter.post('/models', async (req, res) => {
  const parsed = ModelsBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const body = parsed.data
  if (body.kind === 'webhook') { res.status(400).json({ data: null, error: 'errors.ai.models_unsupported', meta: {} }); return }
  let secret = body.secret?.trim() || null
  let organization = blankToNull(body.organization) ?? null
  if (body.providerId) {
    const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.id, body.providerId)).limit(1)
    if (!existing) { res.status(404).json({ data: null, error: 'errors.ai.provider_not_found', meta: {} }); return }
    // A saved key only goes to the kind it was saved for.
    if (existing.kind === body.kind) {
      if (!secret && existing.secretEncrypted) {
        try { secret = decryptToken(existing.secretEncrypted) } catch { secret = null }
      }
      if (body.organization === undefined) organization = existing.organization
    }
  }
  const result = await fetchLatestModels({ kind: body.kind, secret, organization, currentModel: body.model ?? null })
  res.json({ data: result, error: null, meta: {} })
})

aiAdminRouter.put('/routes', async (req, res) => {
  const parsed = z.object({
    routes: z.record(z.enum(AI_FEATURES), z.string().uuid().nullable()),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const providerIds = new Set((await db.select({ id: aiProviders.id }).from(aiProviders)).map((p) => p.id))
  for (const pid of Object.values(parsed.data.routes)) {
    if (pid && !providerIds.has(pid)) { res.status(400).json({ data: null, error: 'errors.ai.provider_not_found', meta: {} }); return }
  }
  const before = Object.fromEntries((await db.select().from(aiFeatureRoutes)).map((r) => [r.feature, r.providerId]))
  await db.transaction(async (tx) => {
    for (const [feature, pid] of Object.entries(parsed.data.routes)) {
      if (pid) {
        await tx.insert(aiFeatureRoutes).values({ feature, providerId: pid })
          .onConflictDoUpdate({ target: aiFeatureRoutes.feature, set: { providerId: pid, updatedAt: new Date() } })
      } else {
        await tx.delete(aiFeatureRoutes).where(eq(aiFeatureRoutes.feature, feature))
      }
    }
  })
  const after = Object.fromEntries((await db.select().from(aiFeatureRoutes)).map((r) => [r.feature, r.providerId]))
  clearAiCache()
  await logAudit(req, { action: 'ai.feature_route.update', targetType: 'integration', targetId: 'ai_feature_routes', meta: { before, after } })
  res.json({ data: after, error: null, meta: {} })
})

