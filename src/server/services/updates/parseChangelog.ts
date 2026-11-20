// v1.332.0: safe, dependency-free parser for src/shared/changelog.ts's
// `CHANGELOG: ChangelogEntry[]` array literal, used to read the array out of
// the raw file content fetched from GitHub (see checkForUpdates.ts) so the
// app can tell "what's new" without checking out or building the pinned
// branch's code. Deliberately NOT `eval`/`new Function` (never execute
// fetched source, even from a repo the admin themselves configured) and NOT
// a regex/line-scrape (too fragile against multi-line strings, escaped
// quotes, or a future reordering of object keys) — this is a small
// recursive-descent parser over a relaxed-JS-literal grammar: object/array
// literals, single/double-quoted strings with backslash escapes, comments,
// and trailing commas. It only needs to understand the exact shape
// `ChangelogEntry` already is (version/date/highlights), not general
// TypeScript.
// v1.445.0: a highlight is `{ category, text }`. A plain string (any changelog
// from before v1.445.0) still parses, as an Improvement.

import { isChangelogCategory, type ChangelogItem } from '../../../shared/changelogCategories.js'

export interface ParsedChangelogEntry {
  version: string
  date: string
  highlights: ChangelogItem[]
}

class ParseError extends Error {}

type JsonlikeValue = string | number | boolean | null | JsonlikeValue[] | { [key: string]: JsonlikeValue }

// Locates `CHANGELOG: ChangelogEntry[] = [ ... ]` in the raw file source and
// returns just the array-literal substring (from the opening `[` through its
// matching closing `]`), so the tokenizer below never has to understand the
// rest of the file (imports, the interface declaration, comments, etc.).
function extractArrayLiteralSource(fileSource: string): string {
  const anchor = /CHANGELOG\s*:\s*ChangelogEntry\s*\[\s*\]\s*=\s*/
  const match = anchor.exec(fileSource)
  if (!match) {
    throw new ParseError('Could not locate the CHANGELOG array declaration in the fetched file')
  }
  const start = match.index + match[0].length
  if (fileSource[start] !== '[') {
    throw new ParseError('Expected "[" immediately after the CHANGELOG declaration')
  }
  let depth = 0
  let inString: '"' | "'" | '`' | null = null
  let i = start
  for (; i < fileSource.length; i++) {
    const ch = fileSource[i]
    if (inString) {
      if (ch === '\\') {
        i++ // skip the escaped character, whatever it is
        continue
      }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '/' && fileSource[i + 1] === '/') {
      const nl = fileSource.indexOf('\n', i)
      i = nl === -1 ? fileSource.length : nl
      continue
    }
    if (ch === '/' && fileSource[i + 1] === '*') {
      const close = fileSource.indexOf('*/', i + 2)
      i = close === -1 ? fileSource.length : close + 1
      continue
    }
    if (ch === '[') depth++
    if (ch === ']') {
      depth--
      if (depth === 0) return fileSource.slice(start, i + 1)
    }
  }
  throw new ParseError('Unterminated CHANGELOG array literal (no matching "]" found)')
}

// --- tokenizer -------------------------------------------------------------

type Token =
  | { kind: '[' | ']' | '{' | '}' | ':' | ',' }
  | { kind: 'string'; value: string }
  | { kind: 'ident'; value: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === undefined) break
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
      continue
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ':' || ch === ',') {
      tokens.push({ kind: ch })
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let out = ''
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          const next = src[i + 1]
          // v1.445.0: `\uXXXX` (some older entries use it for curly quotes and
          // dashes) used to come out as a literal "uXXXX".
          const hex = next === 'u' ? src.slice(i + 2, i + 6) : ''
          if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16))
            i += 6
            continue
          }
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`' }
          out += next !== undefined && next in map ? map[next] : (next ?? '')
          i += 2
        } else {
          out += src[i]
          i++
        }
      }
      if (i >= n) throw new ParseError('Unterminated string literal')
      i++ // closing quote
      tokens.push({ kind: 'string', value: out })
      continue
    }
    if (/[A-Za-z0-9_$.\-]/.test(ch)) {
      let out = ''
      while (i < n && /[A-Za-z0-9_$.\-]/.test(src[i] ?? '')) {
        out += src[i]
        i++
      }
      tokens.push({ kind: 'ident', value: out })
      continue
    }
    throw new ParseError(`Unexpected character "${ch}" at offset ${i}`)
  }
  return tokens
}

// --- parser ------------------------------------------------------------

class TokenStream {
  private pos = 0
  constructor(private tokens: Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.pos]
  }
  next(): Token {
    const t = this.tokens[this.pos]
    if (!t) throw new ParseError('Unexpected end of input')
    this.pos++
    return t
  }
  expect<K extends Token['kind']>(kind: K): Extract<Token, { kind: K }> {
    const t = this.next()
    if (t.kind !== kind) throw new ParseError(`Expected "${kind}" but got "${t.kind}"`)
    return t as Extract<Token, { kind: K }>
  }
}

function parseValue(ts: TokenStream): JsonlikeValue {
  const t = ts.peek()
  if (!t) throw new ParseError('Unexpected end of input while parsing a value')
  if (t.kind === '[') return parseArray(ts)
  if (t.kind === '{') return parseObject(ts)
  if (t.kind === 'string') {
    ts.next()
    return t.value
  }
  if (t.kind === 'ident') {
    ts.next()
    if (t.value === 'true') return true
    if (t.value === 'false') return false
    if (t.value === 'null' || t.value === 'undefined') return null
    const num = Number(t.value)
    if (!Number.isNaN(num)) return num
    throw new ParseError(`Unexpected identifier "${t.value}" in value position`)
  }
  throw new ParseError(`Unexpected token "${t.kind}" in value position`)
}

function parseArray(ts: TokenStream): JsonlikeValue[] {
  ts.expect('[')
  const out: JsonlikeValue[] = []
  while (ts.peek() && ts.peek()!.kind !== ']') {
    out.push(parseValue(ts))
    if (ts.peek()?.kind === ',') {
      ts.next()
    } else {
      break
    }
  }
  ts.expect(']')
  return out
}

function parseObject(ts: TokenStream): { [key: string]: JsonlikeValue } {
  ts.expect('{')
  const out: { [key: string]: JsonlikeValue } = {}
  while (ts.peek() && ts.peek()!.kind !== '}') {
    const keyTok = ts.next()
    if (keyTok.kind !== 'ident' && keyTok.kind !== 'string') {
      throw new ParseError(`Expected an object key but got "${keyTok.kind}"`)
    }
    ts.expect(':')
    const value = parseValue(ts)
    out[keyTok.value] = value
    if (ts.peek()?.kind === ',') {
      ts.next()
    } else {
      break
    }
  }
  ts.expect('}')
  return out
}

// One highlight: a `{ category, text }` object, or a legacy plain string. An
// unknown category reads as an Improvement rather than dropping the bullet;
// anything without text is dropped.
function toChangelogItem(raw: JsonlikeValue): ChangelogItem | null {
  if (typeof raw === 'string') return { category: 'improvement', text: raw }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const text = raw['text']
  if (typeof text !== 'string') return null
  const category = raw['category']
  return { category: isChangelogCategory(category) ? category : 'improvement', text }
}

// Parses the full CHANGELOG file source and returns validated entries,
// newest-first (matching the array's own convention — see CLAUDE.md §20b).
// Throws ParseError on malformed input; silently drops (does not throw for)
// any array element that isn't a well-formed {version, date, highlights[]}
// object, since a partially-malformed future entry shouldn't take down
// update checking for every other entry.
export function parseChangelogSource(fileSource: string): ParsedChangelogEntry[] {
  const arraySource = extractArrayLiteralSource(fileSource)
  const tokens = tokenize(arraySource)
  const raw = parseArray(new TokenStream(tokens))
  const entries: ParsedChangelogEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const version = item['version']
    const date = item['date']
    const highlightsRaw = item['highlights']
    if (typeof version !== 'string' || typeof date !== 'string' || !Array.isArray(highlightsRaw)) continue
    const highlights = highlightsRaw.flatMap((h) => toChangelogItem(h) ?? [])
    entries.push({ version, date, highlights })
  }
  return entries
}

// Simple dotted numeric-segment version compare (1.331.1 vs 1.332.0), same
// convention APP_VERSION already follows app-wide. Returns >0 if a is newer,
// <0 if b is newer, 0 if equal. Non-numeric segments compare as 0.
export function compareVersions(a: string, b: string): number {
  const as = a.split('.').map((p) => parseInt(p, 10) || 0)
  const bs = b.split('.').map((p) => parseInt(p, 10) || 0)
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// Entries strictly newer than currentVersion, newest-first. Prefers an exact
// index match against the (already newest-first) array — falls back to a
// full version compare only when currentVersion isn't present in the fetched
// history at all (e.g. it predates the earliest entry still in the file).
export function entriesNewerThan(entries: ParsedChangelogEntry[], currentVersion: string): ParsedChangelogEntry[] {
  const idx = entries.findIndex((e) => e.version === currentVersion)
  if (idx !== -1) return entries.slice(0, idx)
  return entries.filter((e) => compareVersions(e.version, currentVersion) > 0)
}
