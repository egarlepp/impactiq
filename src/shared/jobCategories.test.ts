import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JOB_CATEGORIES, JOB_CATEGORY, jobCategory, parseRecentRunLimit, parseRecentRunPage } from './jobCategories.js'

describe('jobCategory', () => {
  it('files every job listed on Admin → Scheduling under a real category', () => {
    const route = readFileSync(fileURLToPath(new URL('../server/routes/admin/scheduling.ts', import.meta.url)), 'utf8')
    const listed = [...route.matchAll(/\{ jobKey: '([a-z_]+)'/g)].map((m) => m[1]!)
    expect(listed.length).toBeGreaterThan(20)
    for (const key of listed) expect(jobCategory(key), key).not.toBe('other')
  })

  it('only uses known categories', () => {
    for (const category of Object.values(JOB_CATEGORY)) expect(JOB_CATEGORIES).toContain(category)
  })

  it('puts an unknown job under Other', () => {
    expect(jobCategory('some_new_job')).toBe('other')
    expect(jobCategory('__proto__')).toBe('other')
  })
})

describe('parseRecentRunLimit', () => {
  it('accepts 20, 50 and 100 and falls back to 20', () => {
    expect(parseRecentRunLimit('50')).toBe(50)
    expect(parseRecentRunLimit('100')).toBe(100)
    expect(parseRecentRunLimit('20')).toBe(20)
    expect(parseRecentRunLimit('1000')).toBe(20)
    expect(parseRecentRunLimit(undefined)).toBe(20)
    expect(parseRecentRunLimit(['50'])).toBe(20)
  })
})

describe('parseRecentRunPage', () => {
  it('accepts a positive whole page number and falls back to 1', () => {
    expect(parseRecentRunPage('3')).toBe(3)
    expect(parseRecentRunPage('0')).toBe(1)
    expect(parseRecentRunPage('-2')).toBe(1)
    expect(parseRecentRunPage('1.5')).toBe(1)
    expect(parseRecentRunPage('abc')).toBe(1)
    expect(parseRecentRunPage(undefined)).toBe(1)
    expect(parseRecentRunPage(['2'])).toBe(1)
  })
})
