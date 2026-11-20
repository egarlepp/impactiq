import { asc, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { aiFeatureRoutes, aiProviders, systemSettings } from '../../../../drizzle/schema.js'
import { decryptToken } from '../config/crypto.js'
import {
  isAiProviderKind,
  knownModelPrice,
  normalizeAiSettings,
  type AiFeature,
  type AiPrice,
  type AiProviderKind,
  type AiSettings,
} from '../../../shared/ai.js'

// AI Assistant settings and providers (CLAUDE.md §14). Read on every AI call,
// so they sit behind a short in-memory cache that every write clears, as does
// a backup restore.

export const AI_SETTINGS_KEY = 'ai_settings'
const CACHE_TTL_MS = 30_000

export type AiProviderRow = typeof aiProviders.$inferSelect

// A provider ready to call: the stored row plus its decrypted secret.
export interface ResolvedAiProvider {
  id: string
  kind: AiProviderKind
  name: string
  model: string
  secret: string | null
  endpoint: string | null
  apiVersion: string | null
  allowedCustomHost: string | null
  region: string | null
  accessKeyId: string | null
  resource: string | null
  organization: string | null
  allowPrivateNetwork: boolean
  price: AiPrice | null
}

interface Snapshot {
  at: number
  settings: AiSettings
  providers: AiProviderRow[]
  routes: Map<string, string>
}

let snapshot: Snapshot | null = null

export function clearAiCache(): void {
  snapshot = null
}

async function load(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < CACHE_TTL_MS) return snapshot
  const [settingsRow] = await db.select().from(systemSettings).where(eq(systemSettings.key, AI_SETTINGS_KEY)).limit(1)
  const providers = await db.select().from(aiProviders).orderBy(asc(aiProviders.createdAt))
  const routeRows = await db.select().from(aiFeatureRoutes)
  snapshot = {
    at: Date.now(),
    settings: normalizeAiSettings(settingsRow?.value),
    providers,
    routes: new Map(routeRows.map((r) => [r.feature, r.providerId])),
  }
  return snapshot
}

export async function getAiSettings(): Promise<AiSettings> {
  return (await load()).settings
}

export async function saveAiSettings(next: AiSettings): Promise<void> {
  await db.insert(systemSettings)
    .values({ key: AI_SETTINGS_KEY, value: next })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: next, updatedAt: new Date() } })
  clearAiCache()
}

export { isAiProviderKind }

export function providerPrice(row: Pick<AiProviderRow, 'model' | 'inputPricePerMTok' | 'outputPricePerMTok'>): AiPrice | null {
  if (row.inputPricePerMTok != null && row.outputPricePerMTok != null) {
    return { inputPerMTok: Number(row.inputPricePerMTok), outputPerMTok: Number(row.outputPricePerMTok) }
  }
  return knownModelPrice(row.model)
}

// Throws when the stored secret no longer decrypts (a database restored under
// a different TOKEN_ENCRYPTION_KEY); callers treat that as a failed call.
export function resolveProvider(row: AiProviderRow): ResolvedAiProvider {
  if (!isAiProviderKind(row.kind)) throw new Error(`Unknown AI provider kind: ${row.kind}`)
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    model: row.model,
    secret: row.secretEncrypted ? decryptToken(row.secretEncrypted) : null,
    endpoint: row.endpoint,
    apiVersion: row.apiVersion,
    allowedCustomHost: row.allowedCustomHost,
    region: row.region,
    accessKeyId: row.accessKeyId,
    resource: row.resource,
    organization: row.organization,
    allowPrivateNetwork: row.kind === 'webhook' && row.allowPrivateNetwork,
    price: providerPrice(row),
  }
}

// The feature's routed provider when it is active, else the default provider
// when it is active, else none.
export function pickProviderRow(
  providers: AiProviderRow[],
  routes: Map<string, string>,
  feature: AiFeature,
): AiProviderRow | null {
  const routedId = routes.get(feature)
  const routed = routedId ? providers.find((p) => p.id === routedId && p.isActive) : undefined
  if (routed) return routed
  return providers.find((p) => p.isDefault && p.isActive) ?? null
}

export async function providerForFeature(feature: AiFeature): Promise<AiProviderRow | null> {
  const s = await load()
  return pickProviderRow(s.providers, s.routes, feature)
}
