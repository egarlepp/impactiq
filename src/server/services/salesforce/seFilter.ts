import type jsforce from 'jsforce'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { crmFieldMappings, crmFieldMappingTeams } from '../../../../drizzle/schema.js'
import { SF_FIELD_API_RX, SF_SE_FILTER_APP_FIELD, SF_SE_FILTER_FIELD_TYPES } from '../../../shared/salesforceSeFilter.js'
import { safeSoqlLiteral } from './soql.js'

// Which Opportunity fields name the people engaged on a deal, for the default
// ("my Opportunities") search. See shared/salesforceSeFilter.ts.

export interface SeFilterField {
  api: string
  // Salesforce field type from describe(), or null when describe failed.
  type: string | null
}

// The team's active opp_se_filter mappings on Opportunity. Without a team,
// every active row (an install-wide read). Team assignment goes through the
// crm_field_mapping_teams junction, never the base team_id column.
export async function loadSeFilterFieldApis(teamId: string | null): Promise<string[]> {
  const base = and(
    eq(crmFieldMappings.appField, SF_SE_FILTER_APP_FIELD),
    eq(crmFieldMappings.crmObject, 'Opportunity'),
    eq(crmFieldMappings.isActive, true),
  )
  const rows = teamId
    ? await db.select({ api: crmFieldMappings.crmFieldApi }).from(crmFieldMappings)
      .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
      .where(and(base, eq(crmFieldMappingTeams.teamId, teamId)))
    : await db.select({ api: crmFieldMappings.crmFieldApi }).from(crmFieldMappings).where(base)
  return [...new Set(rows.map((r) => r.api.trim()).filter((a) => SF_FIELD_API_RX.test(a)))]
}

// Opportunity describe, cached per org for a few minutes: the search runs on
// every keystroke and describe() is a full API call.
const DESCRIBE_TTL_MS = 10 * 60 * 1000
const describeCache = new Map<string, { at: number; types: Map<string, string> }>()

export function clearSeFilterDescribeCache(): void {
  describeCache.clear()
}

async function opportunityFieldTypes(conn: jsforce.Connection): Promise<Map<string, string> | null> {
  const key = conn.instanceUrl ?? ''
  const hit = describeCache.get(key)
  if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.types
  try {
    const meta = await conn.sobject('Opportunity').describe()
    const types = new Map<string, string>((meta.fields ?? []).map((f) => [String(f.name ?? '').toLowerCase(), String(f.type ?? '')]))
    describeCache.set(key, { at: Date.now(), types })
    return types
  } catch {
    return null
  }
}

// The mapped fields that exist on this org's Opportunity and hold something
// a user can be compared to. A field the org doesn't have is dropped rather
// than failing the whole search. When describe() itself fails, every mapped
// field is kept with an unknown type (compared by Id).
export async function resolveSeFilterFields(conn: jsforce.Connection, apis: readonly string[]): Promise<SeFilterField[]> {
  if (apis.length === 0) return []
  const types = await opportunityFieldTypes(conn)
  if (!types) return apis.map((api) => ({ api, type: null }))
  const allowed = new Set<string>(SF_SE_FILTER_FIELD_TYPES)
  const out: SeFilterField[] = []
  for (const api of apis) {
    const type = types.get(api.toLowerCase())
    if (type && allowed.has(type)) out.push({ api, type })
  }
  return out
}

// SOQL condition for "this user is on the Opportunity": the owner, or any
// mapped field. Picklists hold names, so they also match the user's name.
// Null when there is nothing to match on (no linked Salesforce user and no
// picklist field to match the name against): the caller returns no results.
export function buildSeFilterCondition(crmUserId: string | null, userName: string | null, fields: readonly SeFilterField[]): string | null {
  const id = crmUserId && crmUserId.trim() ? safeSoqlLiteral(crmUserId.trim()) : null
  const name = userName && userName.trim() ? safeSoqlLiteral(userName.trim()) : null
  const parts: string[] = id ? [`OwnerId = '${id}'`] : []
  for (const f of fields) {
    if (!SF_FIELD_API_RX.test(f.api)) continue
    const isPicklist = f.type === 'picklist' || f.type === 'multipicklist'
    const values = [id, isPicklist ? name : null].filter((v): v is string => !!v).map((v) => `'${v}'`)
    if (values.length === 0) continue
    if (f.type === 'multipicklist') parts.push(`${f.api} INCLUDES (${values.join(', ')})`)
    else if (values.length > 1) parts.push(`${f.api} IN (${values.join(', ')})`)
    else parts.push(`${f.api} = ${values[0]}`)
  }
  return parts.length > 0 ? `(${parts.join(' OR ')})` : null
}
