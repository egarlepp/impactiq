// Shared fallback for CLI tooling that runs on the HOST machine (drizzle-kit,
// the seed script), not inside a container — used only when DATABASE_URL
// isn't already set in the environment. `localhost` (not `postgres`, the
// Docker-network-only hostname docker-compose.yml's app service uses) is
// correct here because `docker compose up postgres -d` publishes the
// container's 5432 to the host (docker-compose.yml's `ports:`).
//
// Reads the same POSTGRES_USER/PASSWORD/DB vars docker-compose.yml's
// `postgres` service and its own DATABASE_URL default compose from, so a
// custom password set in .env is honored here too instead of needing to be
// duplicated into a separate hardcoded connection string.
export function localDatabaseUrl(): string {
  const user = process.env['POSTGRES_USER'] ?? 'impactiq'
  const password = process.env['POSTGRES_PASSWORD'] ?? 'impactiq'
  const db = process.env['POSTGRES_DB'] ?? 'impactiq'
  return `postgresql://${user}:${password}@localhost:5432/${db}`
}
