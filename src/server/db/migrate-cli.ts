// `npm run db:migrate` — applies pending migrations with the same per-file
// runner the server uses on boot (see migrator.ts). drizzle-kit's own
// `migrate` command applies everything in one transaction and fails on an
// empty database, so it isn't used for this.
import { runMigrations } from './index.js'

if (!process.env['DATABASE_URL']) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
await runMigrations()
console.log('Migrations applied')
