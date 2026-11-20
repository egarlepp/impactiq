// pglite-backed tests for validateOne() — the static + describe-layer
// pre-flight checks behind Admin → SF Field Mappings → Validate & Dry Run
// (CLAUDE.md §9). validateOne() takes its mapping/activity-type/picklist
// data as plain arguments (no internal query for those), but its dry-run
// preview step (buildPreview, only reached for Event/Task) does query
// `activities`/`users` directly — hence pglite rather than a pure-function
// test, matching engine.test.ts's convention.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'
import type jsforce from 'jsforce'

let testDb: TestDb
vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

let validateOne: typeof import('./mappingValidation.js')['validateOne']
let buildSfRecord: typeof import('./writeback.js')['buildSfRecord']
let schema: typeof import('../../../../drizzle/schema.js')

beforeAll(async () => {
  ;({ validateOne } = await import('./mappingValidation.js'))
  ;({ buildSfRecord } = await import('./writeback.js'))
  schema = await import('../../../../drizzle/schema.js')
  const dbModule = await import('../../db/index.js')
  testDb = dbModule.db as unknown as TestDb
})

type MappingRow = Parameters<typeof validateOne>[0]['mappingRows'][number]
type ActiveType = Parameters<typeof validateOne>[0]['activeTypes'][number]

function mapping(overrides: Partial<MappingRow> & Pick<MappingRow, 'appField' | 'crmFieldApi'>): MappingRow {
  return {
    id: `map-${crypto.randomUUID()}`,
    crmObject: 'Event',
    direction: 'write',
    isActive: true,
    constantValue: null,
    backgroundRefresh: false,
    refreshOnlyForReports: false,
    ...overrides,
  }
}

function activityType(overrides: Partial<ActiveType> = {}): ActiveType {
  return {
    id: crypto.randomUUID(),
    name: 'Demo',
    crmObjectType: 'Event',
    crmPicklistValue: null,
    ...overrides,
  }
}

// Fakes just enough of jsforce.Connection for describeFields() to work —
// validateOne() only ever calls conn.sobject(x).describe().
function fakeConn(fields: Array<Partial<{
  name: string; label: string; type: string; createable: boolean; updateable: boolean
  length: number; picklistValues: Array<{ value: string; active: boolean }>
}>>): jsforce.Connection {
  const describeResult = {
    fields: fields.map((f) => ({
      name: f.name,
      label: f.label ?? f.name,
      type: f.type ?? 'string',
      createable: f.createable ?? true,
      updateable: f.updateable ?? true,
      length: f.length ?? 255,
      picklistValues: f.picklistValues ?? [],
    })),
  }
  return {
    sobject: () => ({ describe: async () => describeResult }),
  } as unknown as jsforce.Connection
}

const baseArgs = {
  teamId: crypto.randomUUID(),
  picklistConfig: [] as Array<{ crmPicklistValue: string; isActive: boolean; fallbackValue: string | null }>,
}

describe('validateOne — static checks', () => {
  it('flags a duplicate appField mapping and names the winner', async () => {
    const m1 = mapping({ appField: 'title', crmFieldApi: 'Subject' })
    const m2 = mapping({ appField: 'title', crmFieldApi: 'Name' })
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn: null,
      mappingRows: [m1, m2],
      activeTypes: [activityType()],
    })
    const found = result.findings.find((f) => f.code === 'duplicate_app_field')
    expect(found).toBeDefined()
    expect(found!.params.winner).toBe('Subject')
  })

  it('allows several SE filter rows on Opportunity and checks each field type', async () => {
    const rows = [
      mapping({ appField: 'opp_se_filter', crmFieldApi: 'Lead_SE__c', crmObject: 'Opportunity', direction: 'read' }),
      mapping({ appField: 'opp_se_filter', crmFieldApi: 'Engineers__c', crmObject: 'Opportunity', direction: 'read' }),
      mapping({ appField: 'opp_se_filter', crmFieldApi: 'Amount', crmObject: 'Opportunity', direction: 'read' }),
    ]
    const result = await validateOne({
      ...baseArgs, sobject: 'Opportunity',
      conn: fakeConn([{ name: 'Lead_SE__c', type: 'reference' }, { name: 'Engineers__c', type: 'multipicklist' }, { name: 'Amount', type: 'currency' }]),
      mappingRows: rows,
      activeTypes: [],
    })
    expect(result.findings.some((f) => f.code === 'duplicate_app_field')).toBe(false)
    expect(result.findings.some((f) => f.code === 'unknown_app_field')).toBe(false)
    const mismatches = result.findings.filter((f) => f.code === 'type_mismatch')
    expect(mismatches.map((f) => f.crmFieldApi)).toEqual(['Amount'])
  })

  it('flags two different app fields both targeting the same SF field', async () => {
    const m1 = mapping({ appField: 'title', crmFieldApi: 'Subject' })
    const m2 = mapping({ appField: 'notes', crmFieldApi: 'Subject' })
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn: null,
      mappingRows: [m1, m2],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'duplicate_sf_field')).toBe(true)
  })

  it('errors when a required app field for Event has no mapping at all', async () => {
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn: null,
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'Subject' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'missing_required_app_field' && f.params.appField === 'crm_what_id')).toBe(true)
  })

  it('does not demand Task-required fields when no active activity type routes to Task', async () => {
    const result = await validateOne({
      ...baseArgs, sobject: 'Task', conn: null,
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'Subject', crmObject: 'Task' })],
      activeTypes: [activityType({ crmObjectType: 'Event' })], // only Event types active
    })
    expect(result.findings.some((f) => f.code === 'missing_required_app_field')).toBe(false)
    expect(result.findings.some((f) => f.code === 'no_activity_types')).toBe(true)
  })

  it('warns instead of erroring when a required field is mapped but read-only', async () => {
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn: null,
      mappingRows: [
        mapping({ appField: 'title', crmFieldApi: 'Subject' }),
        mapping({ appField: 'activity_type', crmFieldApi: 'Type' }),
        mapping({ appField: 'start_datetime', crmFieldApi: 'ActivityDateTime' }),
        mapping({ appField: 'crm_what_id', crmFieldApi: 'WhatId', direction: 'read' }),
      ],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'read_only_on_required' && f.params.appField === 'crm_what_id')).toBe(true)
    expect(result.findings.some((f) => f.code === 'missing_required_app_field')).toBe(false)
  })

  it('flags an appField buildSfRecord never reads as unknown/inert', async () => {
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn: null,
      mappingRows: [mapping({ appField: 'some_typo_field', crmFieldApi: 'Custom_Field__c' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'unknown_app_field' && f.appField === 'some_typo_field')).toBe(true)
  })

  it('does NOT flag a recognized OTHER_WRITE_APP_FIELDS field as unknown when it is write-capable', async () => {
    const result = await validateOne({
      ...baseArgs, sobject: 'Opportunity', conn: null,
      mappingRows: [mapping({ appField: 'acv', crmFieldApi: 'Total_Acv__c', crmObject: 'Opportunity', direction: 'write' })],
      activeTypes: [],
    })
    expect(result.findings.some((f) => f.code === 'unknown_app_field' && f.appField === 'acv')).toBe(false)
  })

  it('DOES flag a real OTHER_WRITE_APP_FIELDS field as unknown when its direction is read-only (genuinely inert)', async () => {
    const result = await validateOne({
      ...baseArgs, sobject: 'Opportunity', conn: null,
      mappingRows: [mapping({ appField: 'acv', crmFieldApi: 'Total_Acv__c', crmObject: 'Opportunity', direction: 'read' })],
      activeTypes: [],
    })
    expect(result.findings.some((f) => f.code === 'unknown_app_field' && f.appField === 'acv')).toBe(true)
  })

  it('does NOT flag a KNOWN_READ_APP_FIELDS field (e.g. ticket_status) as unknown even though it is read-only', async () => {
    // v1.338.0: Support Ticket attachment's ticket_* fields are read-only
    // by design (never written back) but ARE actively read by
    // GET /api/salesforce/tickets/search — unlike OTHER_WRITE_APP_FIELDS
    // above (which only clears the flag for direction write/read_write),
    // a read-only appField with a real reader must clear it regardless of
    // direction, since 'read' is the only direction these ever have.
    const result = await validateOne({
      ...baseArgs, sobject: 'Case', conn: null,
      mappingRows: [mapping({ appField: 'ticket_status', crmFieldApi: 'Status', crmObject: 'Case', direction: 'read' })],
      activeTypes: [],
    })
    expect(result.findings.some((f) => f.code === 'unknown_app_field' && f.appField === 'ticket_status')).toBe(false)
  })

  it('flags dry_run_unavailable for a non-Event/Task object', async () => {
    const result = await validateOne({
      ...baseArgs, sobject: 'Opportunity', conn: null,
      mappingRows: [mapping({ appField: 'acv', crmFieldApi: 'Total_Acv__c', crmObject: 'Opportunity' })],
      activeTypes: [],
    })
    expect(result.findings.some((f) => f.code === 'dry_run_unavailable')).toBe(true)
    expect(result.preview).toBeNull()
  })
})

describe('validateOne — describe-layer checks', () => {
  it('flags a mapping whose target field does not exist on the org', async () => {
    const conn = fakeConn([{ name: 'Subject', type: 'string' }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'DoesNotExist__c' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'field_not_found')).toBe(true)
  })

  it('flags a write mapping onto a non-createable field', async () => {
    const conn = fakeConn([{ name: 'Subject', type: 'string', createable: false }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'Subject' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'not_createable')).toBe(true)
  })

  it('warns (not errors) on a non-updateable field', async () => {
    const conn = fakeConn([{ name: 'Subject', type: 'string', createable: true, updateable: false }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'Subject' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'not_updateable')).toBe(true)
    expect(result.findings.some((f) => f.code === 'not_createable')).toBe(false)
  })

  it('accepts a combobox field for a string app field (the Subject false-positive fix)', async () => {
    const conn = fakeConn([{ name: 'Subject', type: 'combobox' }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'Subject' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'type_mismatch')).toBe(false)
  })

  it('flags a genuine type mismatch (number app field onto a picklist SF field)', async () => {
    const conn = fakeConn([{ name: 'DurationInMinutes', type: 'picklist' }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: 'effort_hours', crmFieldApi: 'DurationInMinutes' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'type_mismatch')).toBe(true)
  })

  it('flags a constant value that exceeds the SF field length', async () => {
    const conn = fakeConn([{ name: 'Subject', type: 'string', length: 5 }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: '_constant_x', crmFieldApi: 'Subject', constantValue: 'This is way too long' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'constant_too_long')).toBe(true)
  })

  it('flags a constant value not present in the target picklist', async () => {
    const conn = fakeConn([{ name: 'Status__c', type: 'picklist', picklistValues: [{ value: 'Open', active: true }] }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: '_constant_status', crmFieldApi: 'Status__c', constantValue: 'Closed' })],
      activeTypes: [activityType()],
    })
    expect(result.findings.some((f) => f.code === 'constant_not_in_picklist')).toBe(true)
  })

  it('checks every active activity type\'s Type value against the real picklist', async () => {
    const conn = fakeConn([{ name: 'Type', type: 'picklist', picklistValues: [{ value: 'Demo', active: true }] }])
    const result = await validateOne({
      ...baseArgs, sobject: 'Event', conn,
      mappingRows: [mapping({ appField: 'activity_type', crmFieldApi: 'Type' })],
      activeTypes: [activityType({ name: 'NotInPicklist' })],
    })
    expect(result.findings.some((f) => f.code === 'type_not_in_picklist' && f.params.type === 'NotInPicklist')).toBe(true)
  })
})

describe('validateOne and buildSfRecord agree on picklist fallback semantics', () => {
  // Direct regression guard for the "mirror buildSfRecord's fallback
  // semantics exactly" comment in mappingValidation.ts — the same
  // sf_event_type_config fixture is run through both functions and must
  // reach the same conclusion about what Type value (if any) gets written.
  it('an inactive picklist config row resolves to its fallbackValue in both functions', async () => {
    const picklistConfig = [{ crmPicklistValue: 'Meeting', isActive: false, fallbackValue: 'General' }]
    const conn = fakeConn([{ name: 'Type', type: 'picklist', picklistValues: [{ value: 'General', active: true }] }])

    const validation = await validateOne({
      teamId: crypto.randomUUID(), sobject: 'Event', conn, picklistConfig,
      mappingRows: [mapping({ appField: 'activity_type', crmFieldApi: 'Type' })],
      activeTypes: [activityType({ name: 'Meeting' })],
    })
    // No type_not_in_picklist / type_dropped finding — General IS in the picklist.
    expect(validation.findings.some((f) => f.code === 'type_not_in_picklist' || f.code === 'type_dropped')).toBe(false)

    const record = buildSfRecord({
      activity: { effortHours: '1.00', startDatetime: new Date(), meetingOwner: null, descriptionBody: null } as never,
      activityTypeName: 'Meeting',
      sfPicklistValueOverride: null,
      crmObjectType: 'Event',
      fieldMappings: [{ appField: 'activity_type', crmFieldApi: 'Type', isActive: true, direction: 'write', constantValue: null }],
      picklistConfig,
      ownerCrmUserId: null,
    })
    expect(record.Type).toBe('General')
  })

  it('a value missing from the picklist config (when other rows exist) drops the Type in both functions', async () => {
    const picklistConfig = [{ crmPicklistValue: 'Demo', isActive: true, fallbackValue: null }]
    const conn = fakeConn([{ name: 'Type', type: 'picklist', picklistValues: [{ value: 'Demo', active: true }] }])

    const validation = await validateOne({
      teamId: crypto.randomUUID(), sobject: 'Event', conn, picklistConfig,
      mappingRows: [mapping({ appField: 'activity_type', crmFieldApi: 'Type' })],
      activeTypes: [activityType({ name: 'Meeting' })], // "Meeting" has no config row
    })
    expect(validation.findings.some((f) => f.code === 'type_dropped' && f.params.type === 'Meeting')).toBe(true)

    const record = buildSfRecord({
      activity: { effortHours: '1.00', startDatetime: new Date(), meetingOwner: null, descriptionBody: null } as never,
      activityTypeName: 'Meeting',
      sfPicklistValueOverride: null,
      crmObjectType: 'Event',
      fieldMappings: [{ appField: 'activity_type', crmFieldApi: 'Type', isActive: true, direction: 'write', constantValue: null }],
      picklistConfig,
      ownerCrmUserId: null,
    })
    expect(record.Type).toBeUndefined()
  })
})

describe('validateOne — dry-run preview (Event/Task, requires real activity data)', () => {
  it('returns a null-activity preview when the team has no submitted activity for this object yet', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    const result = await validateOne({
      teamId: team!.id, sobject: 'Event', conn: null, picklistConfig: [],
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'Subject' })],
      activeTypes: [activityType({ id: type!.id })],
    })
    expect(result.preview).toEqual({ activityId: null, activityTitle: null, fields: [] })
  })

  it('builds a real preview payload from the team\'s most recent submitted activity', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const [user] = await testDb.insert(schema.users).values({
      oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U',
    }).returning()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', sortOrder: 1 }).returning()
    await testDb.insert(schema.activities).values({
      userId: user!.id, teamId: team!.id, title: 'Real Activity', activityTypeId: type!.id, status: 'submitted',
      startDatetime: new Date(), endDatetime: new Date(), effortHours: '1.00',
    })
    const result = await validateOne({
      teamId: team!.id, sobject: 'Event', conn: null, picklistConfig: [],
      mappingRows: [mapping({ appField: 'title', crmFieldApi: 'Subject' })],
      activeTypes: [activityType({ id: type!.id, name: 'Demo' })],
    })
    expect(result.preview?.activityTitle).toBe('Real Activity')
    expect(result.preview?.fields.some((f) => f.crmFieldApi === 'Subject' && f.value === 'Real Activity')).toBe(true)
  })
})
