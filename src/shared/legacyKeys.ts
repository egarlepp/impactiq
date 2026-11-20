// v1.413.0: export files written before the sf_* → crm_* rename carry the old
// key names (sfFieldApi, sfObject, sfObjectType, sfPicklistValue). Import
// schemas run each row through this first, so an older file still imports.
// A key already present under its new name wins over the old one.
export function renameLegacyKeys(value: unknown, renames: Readonly<Record<string, string>>): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const row = { ...(value as Record<string, unknown>) }
  for (const [oldKey, newKey] of Object.entries(renames)) {
    if (oldKey in row) {
      if (!(newKey in row)) row[newKey] = row[oldKey]
      delete row[oldKey]
    }
  }
  return row
}

export const LEGACY_FIELD_MAPPING_KEYS = { sfFieldApi: 'crmFieldApi', sfObject: 'crmObject' } as const
export const LEGACY_ACTIVITY_TYPE_KEYS = { sfObjectType: 'crmObjectType', sfPicklistValue: 'crmPicklistValue' } as const
