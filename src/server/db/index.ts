import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as schema from '../../../drizzle/schema.js'
import { applyMigrations } from './migrator.js'

export type Db = PostgresJsDatabase<typeof schema>

let client: ReturnType<typeof postgres> | null = null
let _db: Db | null = null

// Resolve TLS options for the postgres client.
//
// v1.247.0: was `{ rejectUnauthorized: true }` unconditionally in
// production whenever DATABASE_SSL_CA wasn't set — this forces postgres.js
// down its OBJECT-ssl code path, which unconditionally calls
// `tls.connect()` regardless of whether the server said it can even do TLS.
// String modes ('require'/'allow'/'prefer') send an SSLRequest first and
// check the server's answer; only 'prefer' falls back to plaintext when
// the server says no (postgres/cjs/src/connection.js: `if (!canSSL && ssl
// === 'prefer') return connected()`). Forcing the object path meant ANY
// Postgres that doesn't offer TLS at all — our own bundled docker-compose
// Postgres, most "just provision me a database" resources on Dokploy/
// Railway/etc., anything on an internal Docker network — closed the socket
// mid-handshake, surfacing as "Client network socket disconnected before
// secure TLS connection was established" with zero indication that
// plaintext would have connected fine. 'prefer' encrypts opportunistically
// and never hard-fails on that alone, which is the right default for
// "works against whatever Postgres you point it at."
//
// DATABASE_SSL_CA (unchanged): supplying a CA bundle means you specifically
// want strict, certificate-verified TLS — kept exactly as before.
// DATABASE_SSL_REQUIRE=true: opt back into the old strict behavior
// (verified against Node's built-in trusted CA bundle, hard failure if the
// server can't do TLS) for a genuinely public/external Postgres with a
// proper publicly-trusted cert, where "encrypted when possible" isn't a
// strong enough guarantee.
export function pgTlsOptions(): postgres.Options<Record<string, postgres.PostgresType>>['ssl'] | undefined {
  const ca = process.env['DATABASE_SSL_CA']
  if (ca) {
    let caPem = ca
    if (!ca.includes('BEGIN CERTIFICATE')) {
      caPem = fs.readFileSync(ca, 'utf8')
    }
    return { ca: caPem, rejectUnauthorized: true }
  }
  const isProd = process.env['NODE_ENV'] === 'production'
  if (!isProd) return undefined
  if (process.env['DATABASE_SSL_REQUIRE'] === 'true') return { rejectUnauthorized: true }
  return 'prefer'
}

// Positive integer env value or a fallback.
function intEnv(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// Env-gated Drizzle query logger. Set DB_QUERY_LOG=1 to echo every SQL
// statement (truncated) — used to spot sequential scans / hot queries in a
// given flow. Off by default so production logs stay clean.
class QueryLogger {
  logQuery(query: string, params: unknown[]): void {
    const q = query.length > 500 ? `${query.slice(0, 500)}…` : query
    console.log(`[db] ${q}${params.length ? ` -- params: ${params.length}` : ''}`)
  }
}

function init() {
  const url = process.env['DATABASE_URL']
  if (!url) return null
  const ssl = pgTlsOptions()
  // Pool + safety timeouts so a runaway query can't pin a connection forever.
  // statement_timeout is per-connection (ms); 0 disables it. Pool size and
  // idle timeout are tunable via env for different deploy sizes.
  const opts: postgres.Options<Record<string, postgres.PostgresType>> = {
    max: intEnv('DB_POOL_MAX', 10),
    idle_timeout: intEnv('DB_IDLE_TIMEOUT_S', 30),
    connect_timeout: intEnv('DB_CONNECT_TIMEOUT_S', 10),
    connection: { statement_timeout: intEnv('DB_STATEMENT_TIMEOUT_MS', 30_000) },
    ...(ssl ? { ssl } : {}),
  }
  client = postgres(url, opts)
  _db = drizzle(client, { schema, ...(process.env['DB_QUERY_LOG'] === '1' ? { logger: new QueryLogger() } : {}) })
  return _db
}

export function getDb(): Db {
  if (_db) return _db
  const initialized = init()
  if (!initialized) {
    throw new Error('Database not configured. Visit /setup to configure DATABASE_URL.')
  }
  return initialized
}

// Backwards-compatible export: a Proxy that lazily resolves to the real db.
// Existing code can keep importing `db` and call methods; the first call
// triggers init().
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>
    return real[prop]
  },
}) as Db

export function isDbConfigured(): boolean {
  return !!process.env['DATABASE_URL']
}

// v1.246.0: was `path.resolve(process.cwd(), 'drizzle/migrations')`, which
// only resolves correctly when cwd happens to BE the repo root — true for
// production (Docker's WORKDIR /app + `node dist/server/src/server/index.js`)
// but not for `npm run dev --workspace=src/server`, whose cwd is `src/server`
// itself. Walking up from THIS FILE's own location instead of cwd works
// regardless of how deep tsc nests the compiled output (dev runs the .ts
// directly from `src/server/db/`; prod runs the compiled .js from
// `dist/server/src/server/db/` — different depths, same fix) or what the
// caller's cwd was when the process started.
export function findMigrationsFolder(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'drizzle', 'migrations')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Shouldn't happen (every deployment shape checked above finds it within
  // 5 hops) — fall back to the old behavior rather than throwing outright.
  return path.resolve(process.cwd(), 'drizzle/migrations')
}

export async function runMigrations(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) return
  const ssl = pgTlsOptions()
  const migrationClient = ssl ? postgres(url, { max: 1, ssl }) : postgres(url, { max: 1 })
  try {
    const migrationsFolder = findMigrationsFolder()
    await applyMigrations(migrationClient, migrationsFolder)
  } finally {
    await migrationClient.end()
  }
}
