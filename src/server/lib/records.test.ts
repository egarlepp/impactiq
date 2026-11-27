import { describe, it, expect } from 'vitest'
import { changedFields, definedEntries } from './records.js'

describe('definedEntries', () => {
  it('drops undefined values and keeps the rest', () => {
    expect(definedEntries({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null })
  })
  it('keeps a "__proto__" key as a plain field', () => {
    const out = definedEntries(JSON.parse('{"__proto__": {"polluted": true}}') as object)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('changedFields', () => {
  it('lists only the fields whose value changed', () => {
    expect(changedFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ before: { b: 2 }, after: { b: 3 } })
  })
  it('skips the named keys', () => {
    expect(changedFields({ a: 1 }, { a: 2, password: 'x' }, ['password'])).toEqual({ before: { a: 1 }, after: { a: 2 } })
  })
  it('reports nothing when there is no earlier row', () => {
    expect(changedFields(undefined, { a: 1 })).toEqual({ before: {}, after: {} })
  })
})
