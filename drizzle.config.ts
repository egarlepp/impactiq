import type { Config } from 'drizzle-kit'
import { localDatabaseUrl } from './drizzle/localDbUrl.js'

export default {
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? localDatabaseUrl(),
  },
} satisfies Config
