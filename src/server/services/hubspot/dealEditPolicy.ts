import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings, users } from '../../../../drizzle/schema.js'
import { HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import {
  DEFAULT_HUBSPOT_DEAL_EDIT_POLICY, normalizeHubspotDealEditPolicy, type HubspotDealEditPolicy,
} from '../../../shared/hubspotDealEdit.js'
import { HubspotError, hubspotRequest } from './client.js'
import { getObjectPropertiesSafe } from './metadata.js'
import { getHubspotOwnerIdForUser } from './owners.js'

// Admin → Integrations → HubSpot → "Who can edit Deals" (v1.424.0, security
// audit M4). See src/shared/hubspotDealEdit.ts for the two modes. Read on
// every Deal write, so cached briefly; a save from this process clears it.
const KEY = 'hubspot_deal_edit_policy'
const CACHE_TTL_MS = 30_000
let cache: { value: HubspotDealEditPolicy; at: number } | null = null

export async function getHubspotDealEditPolicy(): Promise<HubspotDealEditPolicy> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY)).limit(1)
    const value = normalizeHubspotDealEditPolicy(row?.value)
    cache = { value, at: Date.now() }
    return value
  } catch {
    return DEFAULT_HUBSPOT_DEAL_EDIT_POLICY
  }
}

export async function setHubspotDealEditPolicy(v: HubspotDealEditPolicy): Promise<HubspotDealEditPolicy> {
  const value = normalizeHubspotDealEditPolicy(v)
  await db.insert(systemSettings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } })
  cache = { value, at: Date.now() }
  return value
}

export function clearHubspotDealEditPolicyCache(): void {
  cache = null
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

// Does one property value name this person? A value can list several people
// (multi-select properties separate them with ';'). Each entry matches the
// person's HubSpot owner id, their email, or their name; for a dropdown, the
// option's label is compared as well as its stored value.
export function valueNamesUser(
  raw: string,
  person: { ownerId: string; email: string; displayName: string },
  optionLabels?: Map<string, string>,
): boolean {
  const email = norm(person.email)
  const name = norm(person.displayName)
  for (const entry of raw.split(';')) {
    const v = entry.trim()
    if (!v) continue
    if (v === person.ownerId) return true
    const candidates = [v, optionLabels?.get(v) ?? ''].map(norm).filter(Boolean)
    if (candidates.some((c) => c === email || (name !== '' && c === name))) return true
  }
  return false
}

// May this user change this Deal from ImpactIQ? Always needs a match to an
// active HubSpot user. Under named_on_deal the Deal must also name them in one
// of the chosen properties; with none chosen, nobody may edit (fail closed).
// A failed HubSpot read throws, so the caller answers an error rather than a
// silent "no".
export async function canEditHubspotDeal(userId: string, dealId: string): Promise<boolean> {
  const ownerId = await getHubspotOwnerIdForUser(userId)
  if (!ownerId) return false
  const policy = await getHubspotDealEditPolicy()
  if (policy.mode === 'any_matched_user') return true
  if (policy.properties.length === 0 || !HUBSPOT_ID_RX.test(dealId)) return false
  const [me] = await db.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
  if (!me) return false
  const { status, body } = await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, { query: { properties: policy.properties.join(',') } })
  if (status === 404) return false
  if (status < 200 || status >= 300) throw new HubspotError(status === 403 ? 'errors.hubspot.forbidden' : 'errors.hubspot.bad_response', status)
  const props = (body as { properties?: Record<string, unknown> } | null)?.properties ?? {}
  const meta = await getObjectPropertiesSafe('deals')
  const person = { ownerId, email: me.email, displayName: me.displayName }
  return policy.properties.some((p) => {
    const raw = props[p]
    if (raw == null || raw === '') return false
    return valueNamesUser(String(raw), person, meta.get(p)?.options)
  })
}
