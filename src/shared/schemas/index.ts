import { z } from 'zod'

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema.nullable(),
    error: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()),
  })

export const ActivityStatusSchema = z.enum(['draft', 'submitted'])
export const SfSyncStatusSchema = z.enum(['pending', 'synced', 'failed'])
export const SfWhatTypeSchema = z.enum(['Opportunity', 'Account', 'Campaign'])
export const SfWhoTypeSchema = z.enum(['Contact', 'Lead'])
export const RoleSchema = z.enum(['contributor', 'leader', 'team_admin', 'admin'])
export const SfObjectTypeSchema = z.enum(['Event', 'Task'])
export const LocationModeSchema = z.enum(['remote', 'onsite'])
export const AttendeeSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
})

export const CreateActivitySchema = z.object({
  teamId: z.string().uuid(),
  title: z.string().min(1).max(500),
  activityTypeId: z.string().uuid(),
  // v1.256.0: optional finer-grained classification under activityTypeId
  // (e.g. Discovery -> Technical Discovery). ImpactIQ-only — never part of
  // the Salesforce writeback payload. The server resolves subtypeName from
  // this id rather than trusting a client-supplied string, since Subtypes
  // are ImpactIQ's own admin-managed list, unlike crmWhatName below (which
  // mirrors an external Salesforce search result).
  subtypeId: z.string().uuid().nullable().optional(),
  // v1.257.0: optional free text, only ever populated/shown by the client
  // when the chosen activity type is named "Meeting" — see
  // drizzle/schema.ts activities.meetingTypeReason for the full rationale.
  meetingTypeReason: z.string().max(2000).optional(),
  // v1.334.0: optional free text, only ever populated/shown by the client
  // when the chosen activity type is named "Marketing" — same
  // ImpactIQ-only, name-matched convention as meetingTypeReason above. See
  // drizzle/schema.ts activities.marketingEventName for the full rationale.
  marketingEventName: z.string().max(500).optional(),
  // v1.262.0: approval-time snapshot of the Outlook event's own
  // sensitivity marking (private/confidential). Drives the Private
  // Meeting card treatment client-side; never sent to Salesforce.
  isPrivateMeeting: z.boolean().optional(),
  startDatetime: z.string().datetime(),
  endDatetime: z.string().datetime(),
  effortHours: z.number().min(0).max(24),
  notes: z.string().max(5000).optional(),
  descriptionBody: z.string().max(50000).optional(),
  locationMode: LocationModeSchema.optional(),
  meetingOwner: z.string().max(500).optional(),
  meetingOwnerEmail: z.string().max(320).optional(),
  attendees: z.array(AttendeeSchema).max(500).optional(),
  acv: z.number().nonnegative().max(1e12).nullable().optional(),
  // Incidental/travel spend on a Remote activity ("Direct Costs"), entered in
  // incidentalCurrency (the contributor's display currency).
  costTransportation: z.number().nonnegative().max(1e9).nullable().optional(),
  costLodging: z.number().nonnegative().max(1e9).nullable().optional(),
  costFood: z.number().nonnegative().max(1e9).nullable().optional(),
  incidentalCurrency: z.string().length(3).nullable().optional(),
  // Snapshot fields captured when linking to an Opportunity — frozen at
  // save time so historical reporting reflects the meeting-time state.
  salesStage: z.string().max(200).nullable().optional(),
  forecastCategory: z.string().max(200).nullable().optional(),
  oppAmount: z.number().nullable().optional(),
  oppCloseDate: z.string().nullable().optional(),
  outlookEventId: z.string().optional(),
  crmWhatId: z.string().nullable().optional(),
  crmWhatType: SfWhatTypeSchema.nullable().optional(),
  crmWhatName: z.string().nullable().optional(),
  // v1.97.0: display cache for the linked Opportunity's Account and the
  // current Assigned SE picklist value. Snapshotted at save time.
  crmAccountId: z.string().nullable().optional(),
  crmAccountName: z.string().nullable().optional(),
  crmAssignedSeName: z.string().nullable().optional(),
  // v1.67.0: SF child link populated by per-activity-type Extras.
  crmRelatedType: z.string().nullable().optional(),
  crmRelatedId: z.string().nullable().optional(),
  crmRelatedName: z.string().nullable().optional(),
  crmWhoId: z.string().nullable().optional(),
  crmWhoType: SfWhoTypeSchema.nullable().optional(),
  crmWhoName: z.string().nullable().optional(),
  productIds: z.array(z.string().uuid()).optional(),
  // v1.337.0: multi-valued Salesforce ticket attachment, opt-in per Activity
  // Type via a 'ticket_picker' Extra. ImpactIQ-only — a denormalized
  // snapshot per ticket taken at attach time (see drizzle/schema.ts
  // activityCrmTickets), never part of the Salesforce writeback payload.
  // Sending the array replaces the full attached set, same convention as
  // productIds above.
  tickets: z.array(z.object({
    crmTicketId: z.string().min(1),
    crmTicketNumber: z.string().min(1),
    crmSubject: z.string().nullable().optional(),
    crmDateOpened: z.string().nullable().optional(),
    crmStatus: z.string().nullable().optional(),
    crmContact: z.string().nullable().optional(),
    crmDescription: z.string().nullable().optional(),
    crmPlatform: z.string().nullable().optional(),
    crmOwner: z.string().nullable().optional(),
  })).max(100).optional(),
})

export const UpdateActivitySchema = CreateActivitySchema.partial().extend({
  status: ActivityStatusSchema.optional(),
  // Client-driven retry: re-queue a failed sync.
  crmSyncStatus: SfSyncStatusSchema.optional(),
})

// Opportunity Relink — see CLAUDE.md §7. fromOppId/toOppId are raw
// Salesforce Ids, not local UUIDs; the server does its own live SF read of
// toOppId rather than trusting any client-supplied field values.
export const RelinkOpportunitySchema = z.object({
  teamId: z.string().uuid(),
  fromOppId: z.string().min(1),
  toOppId: z.string().min(1),
})
