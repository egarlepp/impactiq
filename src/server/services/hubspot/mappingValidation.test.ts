// Validate & dry run for HubSpot field mappings: the pure per-object checks
// with fixture mapping rows and portal properties, plus the property-to-picker
// conversion the mappings screen uses. No HubSpot calls.
import { describe, it, expect } from 'vitest'
import { validateHubspotObject, type HubspotValidationRow } from './mappingValidation.js'
import { toPropertyField, type PropertyInfo } from './metadata.js'

function prop(name: string, over: Partial<PropertyInfo> = {}): PropertyInfo {
  return {
    name,
    label: name,
    type: 'string',
    fieldType: 'text',
    readOnly: false,
    calculated: false,
    hubspotDefined: true,
    referencedObjectType: null,
    options: new Map(),
    ...over,
  }
}

let seq = 0
function row(appField: string, property: string, over: Partial<HubspotValidationRow> = {}): HubspotValidationRow {
  seq += 1
  return {
    id: `m${seq}`,
    appField,
    property,
    crmObject: 'meetings',
    direction: 'write',
    isActive: true,
    constantValue: null,
    refreshOnlyForReports: false,
    ...over,
  }
}

const demo = { id: 't1', name: 'Demo', crmObjectType: 'Event', crmPicklistValue: null }
const discovery = { id: 't2', name: 'Discovery', crmObjectType: 'Event', crmPicklistValue: 'DISCOVERY' }

const meetingProps = new Map<string, PropertyInfo>([
  ['hs_meeting_title', prop('hs_meeting_title')],
  ['hs_meeting_start_time', prop('hs_meeting_start_time', { type: 'datetime' })],
  ['hs_meeting_outcome', prop('hs_meeting_outcome', { type: 'enumeration', fieldType: 'select', options: new Map([['COMPLETED', 'Completed'], ['DEMO', 'Demo']]) })],
  ['meeting_kind', prop('meeting_kind', { type: 'enumeration', fieldType: 'select', hubspotDefined: false, options: new Map([['Demo', 'Demo'], ['DISCOVERY', 'Discovery']]) })],
  ['effort_hours', prop('effort_hours', { type: 'number', hubspotDefined: false })],
  ['hs_createdate', prop('hs_createdate', { type: 'datetime', readOnly: true })],
  ['hs_rollup', prop('hs_rollup', { type: 'number', calculated: true })],
])

function codes(result: ReturnType<typeof validateHubspotObject>): string[] {
  return result.result.findings.map((f) => f.code)
}

describe('validateHubspotObject: static checks', () => {
  it('flags a second row for the same app field as an error naming the winner', () => {
    const rows = [row('title', 'hs_meeting_title'), row('title', 'custom_title')]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo], props: null, connected: false })
    const f = r.result.findings.find((x) => x.code === 'duplicate_app_field')
    expect(f?.level).toBe('error')
    expect(f?.params).toMatchObject({ appField: 'title', count: 2, winner: 'hs_meeting_title' })
  })

  it('reports an app field nothing reads as info', () => {
    const r = validateHubspotObject({ object: 'meetings', mappingRows: [row('sales_stage', 'dealstage')], activeTypes: [demo], props: null, connected: false })
    expect(codes(r)).toContain('unknown_app_field')
  })

  it('warns when a read-only row switches off a standard meeting property', () => {
    const r = validateHubspotObject({ object: 'meetings', mappingRows: [row('title', 'hs_meeting_title', { direction: 'read' })], activeTypes: [demo], props: null, connected: false })
    const f = r.result.findings.find((x) => x.code === 'read_only_on_required')
    expect(f?.level).toBe('warning')
  })

  it('notes that activity type and effort hours only reach HubSpot when mapped', () => {
    const r = validateHubspotObject({ object: 'meetings', mappingRows: [], activeTypes: [demo], props: null, connected: false })
    const optional = r.result.findings.filter((x) => x.code === 'hubspot_unmapped_optional').map((x) => x.params.appField)
    expect(optional.sort()).toEqual(['activity_type', 'effort_hours'])
  })

  it('says a constant on a Deal is ignored, since only meetings and tasks are written', () => {
    const rows = [row('_constant', 'dealtype', { crmObject: 'deals', constantValue: 'newbusiness' })]
    const r = validateHubspotObject({ object: 'deals', mappingRows: rows, activeTypes: [demo], props: null, connected: false })
    expect(codes(r)).toContain('hubspot_constant_ignored')
    expect(codes(r)).toContain('dry_run_unavailable')
    expect(r.isEngagement).toBe(false)
  })

  it('reports no activity types for an engagement object nothing writes to', () => {
    const r = validateHubspotObject({ object: 'tasks', mappingRows: [], activeTypes: [demo], props: null, connected: false })
    expect(codes(r)).toContain('no_activity_types')
    expect(codes(r)).not.toContain('hubspot_unmapped_optional')
  })
})

describe('validateHubspotObject: property checks', () => {
  it('warns that property checks were skipped when HubSpot could not be read', () => {
    const r = validateHubspotObject({ object: 'meetings', mappingRows: [], activeTypes: [demo], props: null, connected: true })
    expect(codes(r)).toContain('describe_failed')
    expect(r.result.describeOk).toBe(false)
  })

  it('flags a property that does not exist in the portal', () => {
    const r = validateHubspotObject({ object: 'meetings', mappingRows: [row('title', 'no_such_prop')], activeTypes: [demo], props: meetingProps, connected: true })
    const f = r.result.findings.find((x) => x.code === 'field_not_found')
    expect(f?.level).toBe('error')
    expect(f?.crmFieldApi).toBe('no_such_prop')
  })

  it('flags writing to a read-only or calculated property', () => {
    const rows = [row('start_datetime', 'hs_createdate'), row('effort_hours', 'hs_rollup')]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo], props: meetingProps, connected: true })
    expect(r.result.findings.filter((x) => x.code === 'hubspot_property_read_only')).toHaveLength(2)
  })

  it('does not flag a read-only property on a row that only reads', () => {
    const rows = [row('start_datetime', 'hs_createdate', { direction: 'read' })]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo], props: meetingProps, connected: true })
    expect(codes(r)).not.toContain('hubspot_property_read_only')
  })

  it('flags a value type the property cannot hold', () => {
    const r = validateHubspotObject({ object: 'meetings', mappingRows: [row('effort_hours', 'hs_meeting_title')], activeTypes: [demo], props: meetingProps, connected: true })
    const f = r.result.findings.find((x) => x.code === 'type_mismatch')
    expect(f?.params).toMatchObject({ crmType: 'string', expected: 'number' })
  })

  it('flags an activity type whose value is not one of the enumeration options', () => {
    const rows = [row('activity_type', 'hs_meeting_outcome')]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo, discovery], props: meetingProps, connected: true })
    const misses = r.result.findings.filter((x) => x.code === 'type_not_in_picklist')
    // Demo → "Demo" isn't an option (only "DEMO"); Discovery → "DISCOVERY" isn't either.
    expect(misses.map((x) => x.params.type).sort()).toEqual(['Demo', 'Discovery'])
  })

  it('accepts activity types that use the picklist override value', () => {
    const rows = [row('activity_type', 'meeting_kind')]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo, discovery], props: meetingProps, connected: true })
    expect(codes(r)).not.toContain('type_not_in_picklist')
  })

  it('flags a constant that is not an enumeration option', () => {
    const rows = [row('_constant', 'hs_meeting_outcome', { constantValue: 'NO_SHOW' })]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo], props: meetingProps, connected: true })
    expect(codes(r)).toContain('constant_not_in_picklist')
  })

  it('flags a non-numeric constant on a number property', () => {
    const rows = [row('_constant', 'effort_hours', { constantValue: 'two' })]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo], props: meetingProps, connected: true })
    expect(codes(r)).toContain('type_mismatch')
  })

  it('passes a clean meeting mapping with no errors', () => {
    const rows = [row('title', 'hs_meeting_title'), row('start_datetime', 'hs_meeting_start_time'), row('activity_type', 'meeting_kind'), row('effort_hours', 'effort_hours')]
    const r = validateHubspotObject({ object: 'meetings', mappingRows: rows, activeTypes: [demo, discovery], props: meetingProps, connected: true })
    expect(r.result.findings.filter((x) => x.level === 'error')).toEqual([])
    expect(r.result.describeOk).toBe(true)
    expect(r.result.mappingCount).toBe(4)
  })

  it('warns when the SE deal filter does not point at an owner property', () => {
    const dealProps = new Map<string, PropertyInfo>([
      ['se_owner', prop('se_owner', { type: 'enumeration', referencedObjectType: 'OWNER' })],
      ['se_name', prop('se_name')],
      ['amount', prop('amount', { type: 'number' })],
    ])
    const rows = [
      row('deal_se_owner', 'se_owner', { crmObject: 'deals', direction: 'read' }),
      row('deal_se_owner', 'se_name', { crmObject: 'deals', direction: 'read' }),
      row('acv', 'se_name', { crmObject: 'deals', direction: 'read' }),
      row('opp_renewal_acv', 'amount', { crmObject: 'deals', direction: 'read' }),
    ]
    const r = validateHubspotObject({ object: 'deals', mappingRows: rows, activeTypes: [demo], props: dealProps, connected: true })
    const notOwner = r.result.findings.filter((x) => x.code === 'hubspot_not_owner_property')
    expect(notOwner.map((x) => x.crmFieldApi)).toEqual(['se_name'])
    // Several SE filter rows are allowed; they aren't duplicates.
    expect(codes(r)).not.toContain('duplicate_app_field')
    // ACV on a text property can't be read as a number.
    expect(r.result.findings.filter((x) => x.code === 'type_mismatch').map((x) => x.appField)).toEqual(['acv'])
  })

  it('checks the Deal fields ImpactIQ writes: ACV and Assigned SE (phase 6a)', () => {
    // Deals never get a payload preview; leave that note out.
    const found = (r: ReturnType<typeof validateHubspotObject>) => codes(r).filter((c) => c !== 'dry_run_unavailable')
    const dealProps = new Map<string, PropertyInfo>([
      ['impactiq_acv', prop('impactiq_acv', { type: 'number', hubspotDefined: false })],
      ['amount_rollup', prop('amount_rollup', { type: 'number', calculated: true })],
      ['se_owner', prop('se_owner', { type: 'enumeration', referencedObjectType: 'OWNER' })],
    ])
    const ok = validateHubspotObject({ object: 'deals', mappingRows: [row('acv', 'impactiq_acv', { crmObject: 'deals' }), row('assigned_se_write', 'se_owner', { crmObject: 'deals' })], activeTypes: [demo], props: dealProps, connected: true })
    // A writable deal write field is a real write: no "only reads" note.
    expect(found(ok)).toEqual([])

    const calc = validateHubspotObject({ object: 'deals', mappingRows: [row('acv', 'amount_rollup', { crmObject: 'deals' })], activeTypes: [demo], props: dealProps, connected: true })
    expect(found(calc)).toEqual(['hubspot_property_read_only'])

    const off = validateHubspotObject({ object: 'deals', mappingRows: [row('acv', 'impactiq_acv', { crmObject: 'deals', direction: 'read' })], activeTypes: [demo], props: dealProps, connected: true })
    expect(found(off)).toEqual(['hubspot_deal_write_off'])

    // A read-only deal field set to write still only gets the note.
    const readField = validateHubspotObject({ object: 'deals', mappingRows: [row('assigned_se_name', 'se_owner', { crmObject: 'deals' })], activeTypes: [demo], props: dealProps, connected: true })
    expect(found(readField)).toEqual(['hubspot_deal_read_only'])
  })
})

describe('toPropertyField', () => {
  it('maps HubSpot types to the picker types', () => {
    expect(toPropertyField(prop('a', { type: 'bool', fieldType: 'booleancheckbox' })).type).toBe('boolean')
    expect(toPropertyField(prop('b', { type: 'enumeration', fieldType: 'select' })).type).toBe('picklist')
    expect(toPropertyField(prop('c', { type: 'enumeration', fieldType: 'checkbox' })).type).toBe('multipicklist')
    expect(toPropertyField(prop('d', { type: 'enumeration', referencedObjectType: 'OWNER' })).type).toBe('owner')
    expect(toPropertyField(prop('e', { type: 'number' })).type).toBe('double')
    expect(toPropertyField(prop('f', { type: 'datetime' })).type).toBe('datetime')
    expect(toPropertyField(prop('g', { fieldType: 'textarea' })).type).toBe('textarea')
    expect(toPropertyField(prop('h')).type).toBe('string')
  })

  it('marks calculated properties read-only, portal properties custom, and lists options', () => {
    const f = toPropertyField(prop('x', { type: 'enumeration', calculated: true, hubspotDefined: false, options: new Map([['A', 'Alpha']]) }))
    expect(f.readOnly).toBe(true)
    expect(f.isCustom).toBe(true)
    expect(f.picklistValues).toEqual([{ value: 'A', label: 'Alpha' }])
  })
})

describe('validateHubspotObject: Project objects (phase 6b)', () => {
  const projectProps = new Map<string, PropertyInfo>([
    ['hs_name', prop('hs_name')],
    ['proj_status', prop('proj_status', { type: 'enumeration', fieldType: 'select', options: new Map([['done', 'Done']]) })],
    ['hs_createdate', prop('hs_createdate', { type: 'datetime', readOnly: true })],
    ['eng_notes', prop('eng_notes', { fieldType: 'textarea' })],
    ['rich_notes', prop('rich_notes', { fieldType: 'html' })],
  ])
  const p = (appField: string, property: string, over: Partial<HubspotValidationRow> = {}) => row(appField, property, { crmObject: '0-970', ...over })

  it('notes a read-only editable field, a write direction on a read-only field, and that there is no dry run', () => {
    const rows = [p('eval_status', 'proj_status', { direction: 'read' }), p('eval_name', 'hs_name', { direction: 'write' })]
    const r = validateHubspotObject({ object: '0-970', mappingRows: rows, activeTypes: [demo], props: projectProps, connected: true })
    expect(codes(r)).toEqual(expect.arrayContaining(['hubspot_project_write_off', 'hubspot_project_read_only', 'hubspot_project_no_dry_run']))
    expect(codes(r)).not.toContain('dry_run_unavailable')
    expect(codes(r)).not.toContain('unknown_app_field')
  })

  it('needs Engineer Notes on a writable plain-text property, and flags writing a read-only one', () => {
    const rows = [p('eval_engineer_notes', 'rich_notes'), p('eval_next_steps', 'eng_notes'), p('eval_start_date', 'hs_createdate')]
    const r = validateHubspotObject({ object: '0-970', mappingRows: rows, activeTypes: [demo], props: projectProps, connected: true })
    const errors = r.result.findings.filter((f) => f.level === 'error')
    expect(errors.map((f) => f.code)).toEqual(expect.arrayContaining(['hubspot_not_prependable', 'hubspot_property_read_only']))
    expect(errors.find((f) => f.code === 'hubspot_not_prependable')?.params).toMatchObject({ crmFieldApi: 'rich_notes' })
    expect(errors.filter((f) => f.code === 'hubspot_not_prependable')).toHaveLength(1)
  })
})
