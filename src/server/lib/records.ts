// Building objects whose keys come from a request (a validated body, CSV
// headers, a team id). Object.fromEntries defines own properties, so a key such
// as "__proto__" becomes a plain field instead of changing the object's
// prototype, which a `record[key] = value` assignment would do.

// The entries of `source` whose value is not undefined, as a new object.
export function definedEntries(source: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined))
}

// The fields of `after` that differ from `before`, as { before, after } maps
// for the audit log. Keys in `skip` are left out.
export function changedFields(
  before: object | undefined,
  after: object,
  skip: readonly string[] = [],
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const prior = new Map<string, unknown>(before ? Object.entries(before) : [])
  const changed = Object.entries(after).filter(([k, v]) => !skip.includes(k) && before !== undefined && prior.get(k) !== v)
  return {
    before: Object.fromEntries(changed.map(([k]) => [k, prior.get(k)])),
    after: Object.fromEntries(changed),
  }
}
