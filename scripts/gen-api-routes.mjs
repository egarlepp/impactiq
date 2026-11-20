#!/usr/bin/env node
// Reads src/server/routes/*.ts plus src/server/index.ts and src/server/routes/auth.ts,
// extracts every router.METHOD('PATH', ...) line, and emits a markdown table grouped
// by file. Run on demand: `node scripts/gen-api-routes.mjs > /tmp/api-routes.md`.
//
// Output is meant to be inlined into docs/api.md. Re-run after every route change.

import fs from 'node:fs'
import path from 'node:path'

const ROUTES_DIR = 'src/server/routes'
const INDEX_FILE = 'src/server/index.ts'

// Discover the path prefix each Router is mounted under by parsing index.ts.
function discoverMounts() {
  const src = fs.readFileSync(INDEX_FILE, 'utf8')
  const mounts = {}
  const re = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z]+Router)\s*\)/g
  let m
  while ((m = re.exec(src)) !== null) mounts[m[2]] = m[1]
  // apiRouter aggregates many sub-routers under /api — read routes/index.ts:
  const apiSrc = fs.readFileSync(path.join(ROUTES_DIR, 'index.ts'), 'utf8')
  const apiRe = /apiRouter\.use\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z]+Router)\s*\)/g
  while ((m = apiRe.exec(apiSrc)) !== null) mounts[m[2]] = '/api' + m[1]
  return mounts
}

// Map a route file to the prefix it gets mounted under, by reading its
// `export const xxxRouter = Router()` and looking up that name in mounts.
function prefixFor(routerName, mounts) {
  return mounts[routerName] ?? ''
}

function extractFromFile(file, mounts) {
  const src = fs.readFileSync(file, 'utf8')
  const nameMatch = src.match(/export const (\w+Router)\s*=\s*Router\(/)
  if (!nameMatch) return []
  const routerName = nameMatch[1]
  const prefix = prefixFor(routerName, mounts)
  const re = /(\w+Router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g
  const out = []
  let m
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== routerName) continue
    const method = m[2].toUpperCase()
    const subPath = m[3]
    // Look for the preceding `requireAuth | requireRole | requireAppAdmin` middleware
    // by scanning the line and the few chars after the path.
    const after = src.slice(m.index, m.index + 400)
    let auth = 'session'
    if (/requireAppAdmin/.test(after.slice(0, 200))) auth = 'app-admin'
    else if (/requireRole\(([^)]+)\)/.test(after.slice(0, 200))) {
      const r = after.match(/requireRole\(([^)]+)\)/)
      auth = `role: ${r ? r[1] : '?'}`
    } else if (/requireAuth/.test(after.slice(0, 200)) || /Router\.use\(requireAuth\)/.test(src)) {
      auth = 'session'
    }
    // Public when neither the file applies requireAuth nor the line has any guard.
    if (!/requireAuth/.test(src) && auth === 'session') auth = 'public'
    out.push({ method, path: prefix + (subPath === '/' ? '' : subPath), auth, file: path.basename(file) })
  }
  return out
}

const mounts = discoverMounts()
const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && f !== 'index.ts').map((f) => path.join(ROUTES_DIR, f))
const all = files.flatMap((f) => extractFromFile(f, mounts))

// Group by file (= rough category).
const byFile = {}
for (const r of all) {
  byFile[r.file] = byFile[r.file] || []
  byFile[r.file].push(r)
}

console.log('# Auto-generated route inventory')
console.log()
console.log(`Total endpoints: **${all.length}**. Source: \`node scripts/gen-api-routes.mjs\`.`)
console.log()
for (const file of Object.keys(byFile).sort()) {
  console.log(`## \`${file}\` (${byFile[file].length} endpoints)`)
  console.log()
  console.log('| Method | Path | Auth |')
  console.log('|--------|------|------|')
  for (const r of byFile[file].sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`| ${r.method} | \`${r.path}\` | ${r.auth} |`)
  }
  console.log()
}
