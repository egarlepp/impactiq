import type jsforce from 'jsforce'

// Server-side support for the "post a dated update, keep history" feature
// (Engineer Notes / Situation-Next Steps on the linked Evaluation record).
// Reuses the existing SF connection/describe conventions established by
// admin.ts's /sf/fields and salesforce.ts's describeEval — a small,
// independent describe cache here rather than a shared one, matching the
// precedent those two already set (each route file keeps its own).

// Field types this feature is safe to prepend into. Salesforce's describe()
// reports Long Text Area / Rich Text Area as 'textarea', plain Text as
// 'string'. Anything else (picklist, number, reference, …) is rejected —
// "fail gracefully and tell the user why" rather than corrupting an
// unrelated field type.
const PREPENDABLE_TYPES = new Set(['textarea', 'string'])

export interface FieldCapacityMeta {
  label: string | null
  type: string
  length: number | null
  updateable: boolean
}

const DESCRIBE_TTL_MS = 60 * 60 * 1000
const describeCache = new Map<string, { at: number; fields: Map<string, FieldCapacityMeta> }>()

async function describeSobjectFields(conn: jsforce.Connection, sobject: string): Promise<Map<string, FieldCapacityMeta>> {
  const cached = describeCache.get(sobject)
  if (cached && Date.now() - cached.at < DESCRIBE_TTL_MS) return cached.fields
  const meta = await conn.sobject(sobject).describe()
  const fields = new Map<string, FieldCapacityMeta>()
  for (const f of meta.fields ?? []) {
    const name = f.name ?? ''
    if (!name) continue
    fields.set(name.toLowerCase(), {
      label: f.label ?? null,
      type: String(f.type ?? ''),
      length: typeof f.length === 'number' && f.length > 0 ? f.length : null,
      updateable: f.updateable !== false,
    })
  }
  describeCache.set(sobject, { at: Date.now(), fields })
  return fields
}

/**
 * Resolves one field's capacity metadata (label/type/length/updateable) for
 * the prepend feature. Returns `null` if the field doesn't exist on the
 * object, isn't updateable, or isn't a text-ish type this feature supports
 * — every case the caller should surface as "can't prepend here, and here's
 * why" rather than attempting a write that would either fail or silently do
 * the wrong thing.
 */
export async function describeFieldCapacity(
  conn: jsforce.Connection,
  sobject: string,
  fieldApi: string,
): Promise<FieldCapacityMeta | null> {
  const fields = await describeSobjectFields(conn, sobject)
  const meta = fields.get(fieldApi.toLowerCase())
  if (!meta) return null
  if (!meta.updateable) return null
  if (!PREPENDABLE_TYPES.has(meta.type)) return null
  return meta
}

/**
 * `MM/DD/YY` in the acting user's own timezone — never derived from the
 * browser alone (avoids a UTC/local boundary bug at day edges). Dependency-
 * free `Intl.DateTimeFormat`, mirroring the approach src/client/lib/tz.ts
 * already uses client-side; there's no server-side date-fns-tz usage
 * anywhere else in this codebase to extend instead.
 */
export function formatDateMMDDYY(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: '2-digit',
      day: '2-digit',
      year: '2-digit',
    }).formatToParts(date)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    return `${get('month')}/${get('day')}/${get('year')}`
  } catch {
    // Unknown/invalid timezone string — fall back to UTC rather than throw;
    // a slightly-off date beats a hard failure on this whole feature.
    return formatDateMMDDYY(date, 'UTC')
  }
}
