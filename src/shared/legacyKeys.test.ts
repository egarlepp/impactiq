import { describe, expect, it } from 'vitest'
import { renameLegacyKeys, LEGACY_FIELD_MAPPING_KEYS, LEGACY_ACTIVITY_TYPE_KEYS } from './legacyKeys.js'

describe('renameLegacyKeys', () => {
  it('moves old export keys to their crm names', () => {
    expect(renameLegacyKeys({ appField: 'title', sfFieldApi: 'Subject', sfObject: 'Event' }, LEGACY_FIELD_MAPPING_KEYS))
      .toEqual({ appField: 'title', crmFieldApi: 'Subject', crmObject: 'Event' })
    expect(renameLegacyKeys({ name: 'Demo', sfObjectType: 'Task', sfPicklistValue: null }, LEGACY_ACTIVITY_TYPE_KEYS))
      .toEqual({ name: 'Demo', crmObjectType: 'Task', crmPicklistValue: null })
  })

  it('keeps a new key over an old one and leaves current files alone', () => {
    expect(renameLegacyKeys({ crmObject: 'deals', sfObject: 'Opportunity' }, LEGACY_FIELD_MAPPING_KEYS)).toEqual({ crmObject: 'deals' })
    const current = { crmFieldApi: 'Subject', crmObject: 'Event' }
    expect(renameLegacyKeys(current, LEGACY_FIELD_MAPPING_KEYS)).toEqual(current)
  })

  it('passes non-objects through', () => {
    expect(renameLegacyKeys(null, LEGACY_FIELD_MAPPING_KEYS)).toBeNull()
    expect(renameLegacyKeys([1], LEGACY_FIELD_MAPPING_KEYS)).toEqual([1])
  })
})
