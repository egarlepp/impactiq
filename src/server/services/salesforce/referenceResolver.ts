import type jsforce from 'jsforce'

// Resolve a Salesforce ID (Owner, Account, custom object row) to a human
// display name. Graceful by design:
//  - Deleted references and rows the caller can't read (field-level security
//    or row-level sharing) return null. Callers should render "—" or the raw
//    ID rather than crash.
//  - Polymorphic lookups (WhatId, Owner) must be given the correct target
//    object by the caller — this service does NOT sniff the object type from
//    the ID prefix (which requires an extra describeGlobal call and doesn't
//    disambiguate User vs Group for OwnerId).
//  - Results are cached in-process for 5 minutes to keep dashboard loads fast
//    without pushing sync into the write path.
//
// Not wired into dashboards yet — see follow-up PR. Landing the service here
// so future consumers have a single choke point for caching + failure
// handling. Delete-safe: this file has no external effects until called.

interface CacheEntry {
  displayName: string | null
  at: number
}
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

function cacheKey(objectType: string, id: string): string {
  return `${objectType}:${id}`
}

// Pick the best label field per SObject. SF standard objects use "Name" for
// almost everything; User uses "Name" too but the "email" secondary is useful
// for disambiguation. Custom objects usually expose "Name" as the primary
// unless the admin renamed it, in which case describe() would tell us — for
// now trust "Name" and fall back to Id if it's null.
function labelSoqlFor(objectType: string): string {
  if (objectType === 'User') return 'Name, Email'
  return 'Name'
}

export async function resolveSfReference(
  conn: jsforce.Connection,
  objectType: string,
  id: string,
): Promise<{ id: string; displayName: string | null } | null> {
  if (!id || !objectType) return null
  const key = cacheKey(objectType, id)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { id, displayName: hit.displayName }
  }
  try {
    const soql = `SELECT Id, ${labelSoqlFor(objectType)} FROM ${objectType} WHERE Id = '${escapeSoqlLiteral(id)}' LIMIT 1`
    const result = await conn.query<{ Id: string; Name?: string | null; Email?: string | null }>(soql)
    const row = result.records[0]
    const displayName = row ? (row.Name ?? row.Email ?? null) : null
    cache.set(key, { displayName, at: Date.now() })
    return { id, displayName }
  } catch (err) {
    // INVALID_TYPE for deleted objects, INSUFFICIENT_ACCESS for FLS/sharing —
    // neither should throw. Cache the null so a repeated read doesn't hammer
    // SF, but with a short TTL in case the admin fixes permissions.
    const message = err instanceof Error ? err.message : String(err)
    if (process.env['NODE_ENV'] !== 'test') {
      console.warn(`[sf-reference-resolver] ${objectType}/${id} → null (${message.slice(0, 120)})`)
    }
    cache.set(key, { displayName: null, at: Date.now() })
    return { id, displayName: null }
  }
}

// Bulk variant: one SOQL round-trip per object type. Prefer this over calling
// resolveSfReference in a loop.
export async function resolveSfReferences(
  conn: jsforce.Connection,
  objectType: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const misses: string[] = []
  const now = Date.now()
  for (const id of ids) {
    if (!id) continue
    const hit = cache.get(cacheKey(objectType, id))
    if (hit && now - hit.at < CACHE_TTL_MS) {
      out.set(id, hit.displayName)
    } else {
      misses.push(id)
    }
  }
  if (misses.length === 0) return out
  try {
    const idList = misses.map((id) => `'${escapeSoqlLiteral(id)}'`).join(',')
    const soql = `SELECT Id, ${labelSoqlFor(objectType)} FROM ${objectType} WHERE Id IN (${idList})`
    const result = await conn.query<{ Id: string; Name?: string | null; Email?: string | null }>(soql)
    const found = new Set<string>()
    for (const row of result.records) {
      const name = row.Name ?? row.Email ?? null
      out.set(row.Id, name)
      cache.set(cacheKey(objectType, row.Id), { displayName: name, at: now })
      found.add(row.Id)
    }
    // Anything requested but not returned is either deleted or unreadable.
    // Cache null so repeated loads don't retry every request.
    for (const id of misses) {
      if (!found.has(id)) {
        out.set(id, null)
        cache.set(cacheKey(objectType, id), { displayName: null, at: now })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (process.env['NODE_ENV'] !== 'test') {
      console.warn(`[sf-reference-resolver] bulk ${objectType} → null (${message.slice(0, 120)})`)
    }
    for (const id of misses) out.set(id, null)
  }
  return out
}

// SOQL string literals are single-quoted; escape the quotes and backslashes.
function escapeSoqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// Bulk existence check for the deleted-link-detection use case (see
// services/salesforce/detectDisconnectedLinks.ts and
// GET /api/salesforce/activity-link-status). Unlike resolveSfReferences
// above — which gracefully degrades a query failure to "name unknown" — this
// is authoritative about found vs. not-found and does NOT swallow a thrown
// query/network error into "not found." Flagging an activity as disconnected
// is a much higher-stakes false positive than a blank display name (see
// CLAUDE.md §10's Deleted Outlook Activities precedent: "absent from a
// failed fetch is not the same as deleted"), so this deliberately lets a
// query exception propagate — callers MUST catch it themselves and treat a
// thrown error as "check failed, leave existing state alone," never as
// "confirmed deleted." No cache, unlike the functions above: both callers
// already batch per distinct object type (one query covers many rows), and
// caching here would risk masking the "check right now" intent that both
// call sites exist for.
export async function checkSfRecordsExist(
  conn: jsforce.Connection,
  objectType: string,
  ids: string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (ids.length === 0) return out
  const idList = ids.map((id) => `'${escapeSoqlLiteral(id)}'`).join(',')
  const soql = `SELECT Id FROM ${objectType} WHERE Id IN (${idList})`
  const result = await conn.query<{ Id: string }>(soql)
  const found = new Set(result.records.map((r) => r.Id))
  for (const id of ids) out.set(id, found.has(id))
  return out
}
