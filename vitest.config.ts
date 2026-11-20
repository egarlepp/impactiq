import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

// Imports in this repo name the `.js` file the server build emits. Vite only maps
// `./x.js` to `./x.ts` when no `x.js` exists, so a local `tsc` build that left a
// compiled `drizzle/schema.js` behind made tests load that stale copy instead of
// the source (v1.393.1: the AI Assistant tests failed with `delete from ` because
// the old build had no AI tables). Prefer the `.ts` source whenever one exists.
function preferTsSource(): Plugin {
  return {
    name: 'prefer-ts-source',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null
      const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + '.ts')
      return fs.existsSync(candidate) ? candidate : null
    },
  }
}

// v1.311.0: widened from the original src/shared-only scope now that
// src/server has real test coverage too — see src/server/db/testDb.ts for
// the pglite wiring those suites use. hookTimeout is raised because
// createTestDb() runs the full migration history (140+ files) against a
// fresh in-memory Postgres in beforeAll/module-level setup for every
// DB-backed suite; the default 5s is comfortably enough in practice but this
// gives headroom rather than a flaky timeout on a slower CI runner.
export default defineConfig({
  plugins: [preferTsSource()],
  test: {
    include: ['src/shared/**/*.test.ts', 'src/server/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})
