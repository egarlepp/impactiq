import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compareVersions, entriesNewerThan, parseChangelogSource } from './parseChangelog.js'
import { CHANGELOG } from '../../../shared/changelog.js'

const FIXTURE = `// header comment
export interface ChangelogEntry {
  version: string
  date: string
  highlights: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.332.0',
    date: '2026-08-28',
    highlights: [
      { category: 'feature', text: 'Ships the self-update check, gated to the default admin\\'s account' },
      { category: "fix", text: "Second bullet with a \\"double-quoted\\" phrase inside it" },
    ],
  },
  {
    version: '1.331.1',
    date: '2026-08-27',
    highlights: [
      { category: 'security', text: 'Single bullet, no escapes' },
    ],
  },
  {
    // a comment sitting inside the array, between entries
    version: '1.300.0',
    date: '2026-01-01',
    highlights: ['Older entry, a plain string from before categories'],
  },
]
`

describe('parseChangelogSource', () => {
  it('parses every entry, newest-first, in order', () => {
    const entries = parseChangelogSource(FIXTURE)
    expect(entries.map((e) => e.version)).toEqual(['1.332.0', '1.331.1', '1.300.0'])
  })

  it('handles a backslash-escaped apostrophe inside a single-quoted string', () => {
    const entries = parseChangelogSource(FIXTURE)
    expect(entries[0]?.highlights[0]).toEqual({ category: 'feature', text: "Ships the self-update check, gated to the default admin's account" })
  })

  it('handles an escaped double quote inside a double-quoted string', () => {
    const entries = parseChangelogSource(FIXTURE)
    expect(entries[0]?.highlights[1]).toEqual({ category: 'fix', text: 'Second bullet with a "double-quoted" phrase inside it' })
  })

  it('tolerates a comment inside the array between object entries', () => {
    const entries = parseChangelogSource(FIXTURE)
    expect(entries[2]?.version).toBe('1.300.0')
    expect(entries[2]?.highlights).toEqual([{ category: 'improvement', text: 'Older entry, a plain string from before categories' }])
  })

  it('decodes a \\uXXXX escape', () => {
    const entries = parseChangelogSource("export const CHANGELOG: ChangelogEntry[] = [{ version: '1.0.0', date: '2026-01-01', highlights: [{ category: 'fix', text: 'didn\\u2019t' }] }]")
    expect(entries[0]?.highlights[0]?.text).toBe('didn\u2019t')
  })

  it('reads an unknown category as an Improvement and drops a highlight with no text', () => {
    const entries = parseChangelogSource(`export const CHANGELOG: ChangelogEntry[] = [
      { version: '2.0.0', date: '2026-01-01', highlights: [{ category: 'misc', text: 'Kept' }, { category: 'fix' }, 42] },
    ]`)
    expect(entries[0]?.highlights).toEqual([{ category: 'improvement', text: 'Kept' }])
  })

  it('parses the real changelog file exactly as the app imports it', () => {
    const source = readFileSync(new URL('../../../shared/changelog.ts', import.meta.url), 'utf8')
    expect(parseChangelogSource(source)).toEqual(CHANGELOG)
  })

  it('throws when the CHANGELOG declaration cannot be found', () => {
    expect(() => parseChangelogSource('export const NOT_IT = []')).toThrow()
  })

  it('never executes the source — a malicious payload in a highlight stays inert data', () => {
    const malicious = `export const CHANGELOG: ChangelogEntry[] = [
      { version: '9.9.9', date: '2026-01-01', highlights: [{ category: 'fix', text: '\`+String(process.exit(1))+\`' }] },
    ]`
    const entries = parseChangelogSource(malicious)
    expect(entries[0]?.version).toBe('9.9.9')
    expect(entries[0]?.highlights[0]?.text).toContain('process.exit')
  })
})

describe('compareVersions', () => {
  it('orders by major/minor/patch numerically, not lexicographically', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('1.331.1', '1.331.0')).toBeGreaterThan(0)
    expect(compareVersions('1.300.0', '1.300.0')).toBe(0)
  })
})

describe('entriesNewerThan', () => {
  it('returns only entries strictly newer than the given version, by index when present', () => {
    const entries = parseChangelogSource(FIXTURE)
    const newer = entriesNewerThan(entries, '1.331.1')
    expect(newer.map((e) => e.version)).toEqual(['1.332.0'])
  })

  it('falls back to a real version compare when currentVersion is absent from the fetched history', () => {
    const entries = parseChangelogSource(FIXTURE)
    const newer = entriesNewerThan(entries, '1.310.0')
    expect(newer.map((e) => e.version)).toEqual(['1.332.0', '1.331.1'])
  })

  it('returns nothing when already on the latest version', () => {
    const entries = parseChangelogSource(FIXTURE)
    expect(entriesNewerThan(entries, '1.332.0')).toEqual([])
  })
})
