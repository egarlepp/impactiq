import { sql, type SQL } from 'drizzle-orm'

// A text[] literal for raw SQL. Drizzle expands a JS array inside sql`` into
// a list of parameters, so `${arr}::text[]` renders as `($1, $2)::text[]`
// (a row cast, an error) or `()::text[]` when empty. Build ARRAY[...]
// explicitly instead, with '{}' for an empty list.
export function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`
}
