import { describe, it, expect } from 'vitest'
import { buildSfRecord, type BuildSfRecordParams } from './writeback.js'
import type { activities } from '../../../../drizzle/schema.js'

type Activity = typeof activities.$inferSelect

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  const base: Activity = {
    id: 'activity-1',
    userId: 'user-1',
    teamId: 'team-1',
    title: 'Demo with Acme',
    activityTypeId: 'type-1',
    subtypeId: null,
    subtypeName: null,
    meetingTypeReason: null,
    marketingEventName: null,
    meetingTypeReasonStatus: null,
    meetingTypeReasonReviewedBy: null,
    meetingTypeReasonReviewedAt: null,
    status: 'submitted',
    startDatetime: new Date('2026-01-15T14:00:00Z'),
    endDatetime: new Date('2026-01-15T15:00:00Z'),
    effortHours: '1.00',
    notes: null,
    location: null,
    descriptionBody: null,
    locationMode: 'remote',
    meetingOwner: null,
    meetingOwnerEmail: null,
    attendees: null,
    acv: null,
    costTransportation: null,
    costLodging: null,
    costFood: null,
    incidentalCurrency: null,
    salesStage: null,
    forecastCategory: null,
    oppAmount: null,
    crmIsClosed: false,
    crmIsWon: false,
    crmSnapshotRefreshedAt: null,
    oppCloseDate: null,
    outlookEventId: null,
    isPrivateMeeting: false,
    crmWhatId: null,
    crmWhatType: null,
    crmWhatName: null,
    crmAccountId: null,
    crmAccountName: null,
    crmAssignedSeName: null,
    crmPrimaryEngineerName: null,
    crmOppOwnerId: null,
    crmOppOwnerName: null,
    crmOppCloseDate: null,
    crmRelatedType: null,
    crmRelatedId: null,
    crmRelatedName: null,
    crmEvalStatus: null,
    crmEvalStage: null,
    crmEvalType: null,
    crmEvalStartDate: null,
    crmEvalEndDate: null,
    crmEvalPrimaryEngineer: null,
    crmWhoId: null,
    crmWhoType: null,
    crmWhoName: null,
    crmWhatDeleted: false,
    crmWhoDeleted: false,
    crmRelatedDeleted: false,
    crmDisconnectCheckedAt: null,
    crmRecordId: null,
    crmRecordAdopted: false,
    crmSyncStatus: null,
    crmSyncError: null,
    crmSyncedAt: null,
    crmSyncAttempts: 0,
    crmNextRetryAt: null,
    outlookWritebackEventId: null,
    outlookSyncStatus: null,
    outlookSyncError: null,
    outlookSyncedAt: null,
    createdAt: new Date('2026-01-15T13:00:00Z'),
    updatedAt: new Date('2026-01-15T13:00:00Z'),
    submittedAt: new Date('2026-01-15T13:05:00Z'),
    outlookDeletedAt: null,
    outlookDeletedKept: false,
    isArchived: false,
  }
  return { ...base, ...overrides }
}

function makeParams(overrides: Partial<BuildSfRecordParams> = {}): BuildSfRecordParams {
  return {
    activity: makeActivity(),
    activityTypeName: 'Demo',
    sfPicklistValueOverride: null,
    crmObjectType: 'Event',
    fieldMappings: [
      { appField: 'title', crmFieldApi: 'Subject', isActive: true, direction: 'write', constantValue: null },
      { appField: 'activity_type', crmFieldApi: 'Type', isActive: true, direction: 'write', constantValue: null },
      { appField: 'start_datetime', crmFieldApi: 'ActivityDateTime', isActive: true, direction: 'write', constantValue: null },
      { appField: 'effort_hours', crmFieldApi: 'DurationInMinutes', isActive: true, direction: 'write', constantValue: null },
      { appField: 'crm_what_id', crmFieldApi: 'WhatId', isActive: true, direction: 'write', constantValue: null },
      { appField: 'notes', crmFieldApi: 'Description', isActive: true, direction: 'write', constantValue: null },
      { appField: 'user_id', crmFieldApi: 'OwnerId', isActive: true, direction: 'write', constantValue: null },
    ],
    picklistConfig: [],
    ownerCrmUserId: 'sf-user-1',
    ...overrides,
  }
}

describe('buildSfRecord', () => {
  it('maps basic fields for an Event', () => {
    const record = buildSfRecord(makeParams({
      activity: makeActivity({ title: 'Discovery call', crmWhatId: '006xx', effortHours: '2.50' }),
      activityTypeName: 'Discovery',
    }))
    expect(record.Subject).toBe('Discovery call')
    expect(record.Type).toBe('Discovery')
    expect(record.WhatId).toBe('006xx')
    expect(record.DurationInMinutes).toBe(150)
    expect(record.ActivityDateTime).toBe('2026-01-15T14:00:00.000Z')
  })

  it('maps start_datetime to a date-only ActivityDate for Task and has no effort_hours home', () => {
    const record = buildSfRecord(makeParams({
      crmObjectType: 'Task',
      fieldMappings: [
        { appField: 'title', crmFieldApi: 'Subject', isActive: true, direction: 'write', constantValue: null },
        { appField: 'start_datetime', crmFieldApi: 'ActivityDate', isActive: true, direction: 'write', constantValue: null },
        { appField: 'effort_hours', crmFieldApi: 'DurationInMinutes', isActive: true, direction: 'write', constantValue: null },
      ],
    }))
    expect(record.ActivityDate).toBe('2026-01-15')
    // effort_hours has no native Task home in the writeback logic — the
    // mapping is simply never consulted for Task, regardless of whether
    // an admin mapped it.
    expect(record.DurationInMinutes).toBeUndefined()
  })

  it('never includes a field whose mapping direction is read or refresh-only', () => {
    const record = buildSfRecord(makeParams({
      fieldMappings: [
        { appField: 'title', crmFieldApi: 'Subject', isActive: true, direction: 'write', constantValue: null },
        { appField: 'crm_what_id', crmFieldApi: 'WhatId', isActive: true, direction: 'read', constantValue: null },
        { appField: 'notes', crmFieldApi: 'Description', isActive: true, direction: 'read_write', refreshOnlyForReports: true, constantValue: null },
      ],
      activity: makeActivity({ crmWhatId: '006xx', notes: 'some notes' }),
    }))
    expect(record.Subject).toBeDefined()
    // read-only mapping never writes
    expect(record.WhatId).toBeUndefined()
    // read_write but refreshOnlyForReports also never writes
    expect(record.Description).toBeUndefined()
  })

  it('omits a field entirely when no active mapping resolves it (no hardcoded fallback)', () => {
    const record = buildSfRecord(makeParams({
      fieldMappings: [
        { appField: 'title', crmFieldApi: 'Subject', isActive: true, direction: 'write', constantValue: null },
      ],
      activity: makeActivity({ crmWhatId: '006xx' }),
    }))
    expect(record.WhatId).toBeUndefined()
    expect(Object.keys(record)).not.toContain('WhatId')
  })

  it('an inactive mapping is treated the same as a missing one', () => {
    const record = buildSfRecord(makeParams({
      fieldMappings: [
        { appField: 'title', crmFieldApi: 'Subject', isActive: true, direction: 'write', constantValue: null },
        { appField: 'crm_what_id', crmFieldApi: 'WhatId', isActive: false, direction: 'write', constantValue: null },
      ],
      activity: makeActivity({ crmWhatId: '006xx' }),
    }))
    expect(record.WhatId).toBeUndefined()
  })

  it('a constant-value mapping writes its literal regardless of any app field value, and runs last', () => {
    const record = buildSfRecord(makeParams({
      fieldMappings: [
        { appField: 'title', crmFieldApi: 'Subject', isActive: true, direction: 'write', constantValue: null },
        { appField: '_constant_status', crmFieldApi: 'Subject', isActive: true, direction: 'write', constantValue: 'Locked Subject' },
      ],
      activity: makeActivity({ title: 'Original title' }),
    }))
    // constants run last, so they override anything earlier in the record
    expect(record.Subject).toBe('Locked Subject')
  })

  it('sfPicklistValueOverride wins over the activity type name for the Type value', () => {
    const record = buildSfRecord(makeParams({
      activityTypeName: 'Build out',
      sfPicklistValueOverride: 'Eval Work',
      picklistConfig: [
        { crmPicklistValue: 'Eval Work', isActive: true, fallbackValue: null },
      ],
    }))
    expect(record.Type).toBe('Eval Work')
  })

  it('falls back to the picklist fallbackValue when the resolved value is inactive', () => {
    const record = buildSfRecord(makeParams({
      activityTypeName: 'Meeting',
      picklistConfig: [
        { crmPicklistValue: 'Meeting', isActive: false, fallbackValue: 'General' },
      ],
    }))
    expect(record.Type).toBe('General')
  })

  it('writes no Type at all when the picklist config exists but has no row for this value', () => {
    const record = buildSfRecord(makeParams({
      activityTypeName: 'Some Unmapped Type',
      picklistConfig: [
        { crmPicklistValue: 'Demo', isActive: true, fallbackValue: null },
      ],
    }))
    expect(record.Type).toBeUndefined()
  })

  it('trusts the activity type name when no picklist config is seeded for the team at all', () => {
    const record = buildSfRecord(makeParams({
      activityTypeName: 'Whatever The Team Calls It',
      picklistConfig: [],
    }))
    expect(record.Type).toBe('Whatever The Team Calls It')
  })

  it('always writes WhoId, including a null clear, on Event/Task', () => {
    const withWho = buildSfRecord(makeParams({ activity: makeActivity({ crmWhoId: '003xx' }) }))
    expect(withWho.WhoId).toBe('003xx')

    const withoutWho = buildSfRecord(makeParams({ activity: makeActivity({ crmWhoId: null }) }))
    expect(withoutWho.WhoId).toBeNull()
  })

  it('prepends a Meeting Owner header line to the description field when mapped', () => {
    const record = buildSfRecord(makeParams({
      fieldMappings: [
        { appField: 'description', crmFieldApi: 'Description', isActive: true, direction: 'write', constantValue: null },
      ],
      activity: makeActivity({ meetingOwner: 'Jane Doe', descriptionBody: 'Body text' }),
    }))
    expect(record.Description).toBe('Meeting Owner = Jane Doe\n\nBody text')
  })

  it('omits the description field entirely when there is neither a body nor a meeting owner', () => {
    const record = buildSfRecord(makeParams({
      fieldMappings: [
        { appField: 'description', crmFieldApi: 'Description', isActive: true, direction: 'write', constantValue: null },
      ],
      activity: makeActivity({ meetingOwner: null, descriptionBody: null }),
    }))
    expect(record.Description).toBeUndefined()
  })
})
