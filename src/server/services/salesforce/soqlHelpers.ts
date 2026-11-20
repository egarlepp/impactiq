import type jsforce from 'jsforce'

// v1.213.0: shared SOQL plumbing extracted from refreshOppCoverage.ts /
// refreshOppSnapshots.ts once the historical-import jobs became a third
// consumer. Behaviour is intentionally identical to the inlined versions
// these replaced.

/**
 * Filters a candidate SELECT field list down to the fields (and relationship
 * paths like `Assigned_SE__r.Name`) that actually exist on `sobject` in this
 * org.
 *
 * This is the established defence against per-org custom-field drift: a
 * mapping that references a field the customer's org doesn't have would
 * otherwise fail every chunk with "Didn't understand relationship 'X__r' in
 * field path". Degrading to a narrower SELECT is always better than failing
 * the whole run.
 *
 * If the describe() call itself fails we return the input unchanged and hand
 * the error to `onError` — the caller records it but keeps going, matching
 * the prior inline behaviour.
 */
export async function filterKnownFields(
  conn: jsforce.Connection,
  sobject: string,
  fields: string[],
  onError?: (message: string) => void,
): Promise<string[]> {
  try {
    const meta = await conn.sobject(sobject).describe()
    const known = new Set<string>((meta.fields ?? []).map((f) => (f.name ?? '').toLowerCase()))
    const relationships = new Set<string>(
      (meta.fields ?? [])
        .filter((f) => f.relationshipName)
        .map((f) => (f.relationshipName as string).toLowerCase()),
    )
    return fields.filter((api) => {
      const lower = api.toLowerCase()
      if (known.has(lower)) return true
      // Relationship paths (`Owner.Name`) — the prefix must be a known relationship.
      const dot = lower.indexOf('.')
      if (dot > 0) return relationships.has(lower.slice(0, dot))
      return false
    })
  } catch (e) {
    onError?.(`describe_${sobject}: ${e instanceof Error ? e.message : String(e)}`)
    return fields
  }
}

export interface QueryAllPagedOptions {
  /** Stop once this many records have been consumed. Omit for unbounded. */
  max?: number
}

/**
 * Runs a SOQL query and walks every `queryMore` page, handing each batch to
 * `consume`. Returns the total number of records consumed.
 *
 * `consume` is called per page rather than accumulating internally so callers
 * can stage rows however they like without a second full copy in memory.
 */
export async function queryAllPaged<T extends Record<string, unknown>>(
  conn: jsforce.Connection,
  soql: string,
  consume: (records: T[]) => void,
  opts: QueryAllPagedOptions = {},
): Promise<number> {
  const max = opts.max ?? Number.POSITIVE_INFINITY
  let consumed = 0
  let res = await conn.query<T>(soql)
  const take = (records: T[]) => {
    if (consumed >= max) return
    const room = max - consumed
    const slice = records.length > room ? records.slice(0, room) : records
    if (slice.length > 0) consume(slice)
    consumed += slice.length
  }
  take(res.records ?? [])
  while (!res.done && res.nextRecordsUrl && consumed < max) {
    res = await conn.queryMore<T>(res.nextRecordsUrl)
    take(res.records ?? [])
  }
  return consumed
}

/** Formats a Date as a SOQL datetime literal (always UTC, no millis). */
export function soqlDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
