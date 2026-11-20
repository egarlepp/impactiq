// The REAL regression guard for the no_activity_days bug (see CLAUDE.md
// §11/§18 v1.308): Number(recent?.count ?? 0) === 0 was, before that fix,
// (recent?.count ?? 0) === 0 — comparing the raw driver value against the
// number 0 directly. Postgres's count(*) returns bigint, and the `postgres`
// driver returns bigint columns as a JS STRING at runtime, so that
// comparison was always "0" === 0, i.e. always false.
//
// This can't be caught with a pglite-backed runtime test: pglite's own type
// parser returns count(*) as a real JS number (see testDb.test.ts), so a
// runtime test would pass identically whether or not the Number(...) wrap
// is present — it would give false confidence, not real coverage.
//
// Instead this is a static source check, directly encoding the manual grep
// this investigation ended on (CLAUDE.md's own "Lesson" callout): every
// `count(*)`-backed value must be wrapped in Number(...) before any
// numeric comparison. Structural, not exhaustive — it will not catch every
// possible variant of this mistake, but it catches the exact shape that
// shipped, and it's cheap enough to run on every commit.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const engineSourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine.ts')

describe('engine.ts aggregate coercion', () => {
  it('wraps every count(*)-backed comparison in Number(...) before comparing', () => {
    const raw = fs.readFileSync(engineSourcePath, 'utf8')
    // Strip full-line `//` comments so a comment that quotes the OLD buggy
    // shape (as this file's own history/lesson comments do) doesn't
    // trigger a false positive. Blanked, not removed, so match offsets
    // stay meaningful for the failure message.
    const source = raw.split('\n').map((line) => (line.trim().startsWith('//') ? '' : line)).join('\n')
    // Find every `sql<number>`/`sql<string>` aggregate destination alias
    // (e.g. `{ n: sql<number>\`count(*)\` }` or `{ count: sql<...>\`count(*)\` }`)
    // and confirm every later use of that alias in a numeric comparison
    // (`=== `/`!== `/`>= `/`<= `/`> `/`< ` immediately after `?? 0)` or the
    // bare alias) is preceded by `Number(`.
    const aliasPattern = /\{\s*(\w+):\s*sql<(?:number|string)>`count\(/g
    const aliases = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = aliasPattern.exec(source))) {
      if (m[1]) aliases.add(m[1])
    }
    expect(aliases.size).toBeGreaterThan(0) // sanity check the pattern still matches this file's style

    for (const alias of aliases) {
      // Every `(<expr>?.<alias> ?? 0)` compared numerically must be
      // preceded by `Number(` — i.e. the opening paren belongs to
      // `Number(`, not a bare grouping paren. Both the buggy shape
      // `(recent?.count ?? 0) === 0` and the fixed shape
      // `Number(recent?.count ?? 0) === 0` share the SAME opening paren
      // character; what differs is only what precedes it, so this checks
      // that directly by index rather than trying to express both shapes
      // in one regex.
      const exprPattern = new RegExp(`\\(\\w+(?:\\?\\.\\w+)*\\?\\.${alias}\\s*\\?\\?\\s*0\\)\\s*(?:===|!==|>=|<=|>|<)`, 'g')
      let match: RegExpExecArray | null
      while ((match = exprPattern.exec(source))) {
        const parenIndex = match.index
        const guarded = source.slice(Math.max(0, parenIndex - 6), parenIndex + 1) === 'Number('
        expect(guarded, `found an unguarded numeric comparison on aggregate alias "${alias}" near offset ${parenIndex} — wrap it in Number(...) before comparing`).toBe(true)
      }
    }
  })
})
