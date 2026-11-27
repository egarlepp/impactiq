import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  decimal,
  integer,
  pgEnum,
  jsonb,
  date,
  unique,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('role', ['contributor', 'leader', 'team_admin', 'admin'])
export const crmObjectTypeEnum = pgEnum('crm_object_type', ['Event', 'Task'])
export const activityStatusEnum = pgEnum('activity_status', ['draft', 'submitted'])
export const crmSyncStatusEnum = pgEnum('crm_sync_status', ['pending', 'synced', 'failed'])
// v1.156.0: status of writing a logged activity back to the user's Outlook
// calendar (per-user opt-in). Mirrors crm_sync_status.
export const outlookSyncStatusEnum = pgEnum('outlook_sync_status', ['pending', 'synced', 'failed'])
export const crmWhatTypeEnum = pgEnum('crm_what_type', ['Opportunity', 'Account', 'Campaign'])
// v1.258.0: admin triage state for activities.meetingTypeReason, reviewed
// from Admin → Monitoring → Activity Health. Null = not yet reviewed.
export const meetingReasonReviewStatusEnum = pgEnum('meeting_reason_review_status', ['ignore', 'will_watch', 'addressed'])
export const matchFieldEnum = pgEnum('match_field', ['subject', 'body', 'both'])
// v1.240.0: what a keyword rule does when it matches. 'suggest_type' is the
// original behavior (requires activityTypeId). 'mark_non_activity' skips
// suggesting a type entirely and instead auto-flags the event as a
// Non-Activity — see keywordRules.activityTypeId below and CLAUDE.md §7.
export const keywordRuleActionEnum = pgEnum('keyword_rule_action', ['suggest_type', 'mark_non_activity'])
export const nudgeTriggerTypeEnum = pgEnum('nudge_trigger_type', [
  'no_activity_days',
  'stage_no_type',
  'type_no_followup',
  'weekly_hours_below_target',
  'sf_sync_failed',
  'opportunity_stale',
  'product_gap',
])
// v1.225.0: 'calendar_derived' — the group's target is auto-computed from
// members' own trailing real Outlook meeting load (see resolver.ts and
// services/capacity/meetingLoad.ts) instead of a flat admin-set number.
// CLAUDE.md §12 for the full method table and the trust-boundary note this
// method carries (reading calendars for a capacity number, not just to
// pre-fill an activity).
export const capacityMethodEnum = pgEnum('capacity_method', [
  'fixed_hours',
  'self_declared',
  'exception_adjusted',
  'calendar_derived',
])
export const integrationProviderEnum = pgEnum('integration_provider', ['salesforce', 'microsoft'])
export const crmAlignmentRoleEnum = pgEnum('crm_alignment_role', ['manager', 'owner'])

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  icon: text('icon'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Work-week defaults applied to new users on this team as starting values.
  // Users can then request changes via My Settings; the user row is the SOT.
  defaultWorkerType: text('default_worker_type').default('full_time').notNull(),
  defaultWorkDays: integer('default_work_days').default(31).notNull(),
  defaultWorkDayStartHour: integer('default_work_day_start_hour').default(9).notNull(),
  defaultWorkDayEndHour: integer('default_work_day_end_hour').default(18).notNull(),
  // Optional links to Salesforce User.Department values. Up to five.
  // Used by future dashboard scopes and by-department filters.
  crmDepartments: text('crm_departments').array().notNull().default([]),
  // Optional pointer to the ImpactIQ user who manages the team. Kept
  // nullable so an admin can create a team before picking a manager.
  managerUserId: uuid('manager_user_id'),
  // v1.88.0: per-team active theme. When a user logs in, the app applies
  // their default team's active_theme_id (falling back to app_themes.
  // is_active, then the brand palette). Nullable so a team can inherit.
  activeThemeId: uuid('active_theme_id'),
  // v1.64.0: Slack Incoming Webhook URL. When set, every in-app nudge
  // delivered to a team member also POSTs a compact card here. NULL =
  // Slack delivery off (in-app only). Not encrypted — webhooks are
  // per-team internal integrations, not user credentials.
  slackWebhookUrl: text('slack_webhook_url'),
  // v1.255.0: team-scoped free text rendered as the "Distinctions" section
  // at the bottom of the Guide page (e.g. Discovery vs Demo). Admin-edited
  // from the top of Admin → Activity Types since it isn't per-type.
  guideDistinctions: text('guide_distinctions'),
  // v1.256.0: team-wide kill switch for the Subtype picker on the Log
  // Activity form and Activity Templates (see teamActivityTypeSubtypes
  // below). Off by default — a team that hasn't configured any Subtypes
  // shouldn't suddenly grow an extra dropdown on every activity type just
  // because Subtypes shipped. Admin-toggled from Admin → Activity Types.
  subtypesEnabled: boolean('subtypes_enabled').default(false).notNull(),
  // v1.453.0 (Gong plan, phase 2): lets this team's leaders and team admins
  // read Gong transcripts on teammates' activities. Off by default; set by an
  // App Admin on Admin → Integrations → Gong. Read only by canReadTranscript().
  transcriptsLeaderAccess: boolean('transcripts_leader_access').default(false).notNull(),
  // v1.457.0 (Gong plan, phase 4): AI Notes. Off by default; a Team Admin
  // turns it on and picks the default sections, an App Admin sets the monthly
  // spend limit (USD, null = only the app-wide AI budget applies).
  aiNotesEnabled: boolean('ai_notes_enabled').default(false).notNull(),
  aiNotesMonthlyLimitUsd: decimal('ai_notes_monthly_limit_usd', { precision: 10, scale: 2 }),
  // Read until v1.471.0; now the team's Default AI Note profile holds them.
  aiNotesDefaultSections: text('ai_notes_default_sections').array(),
})

// Subteams — arbitrary sub-groupings inside a team. `kind` is admin
// categorization (region / type / other or null). Users are attached via
// subteamUsers, which carries the role (leader | member).
export const subteams = pgTable('subteams', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind'),
  // v1.177.0: subteam hierarchy — a subteam may nest under another subteam in
  // the SAME team, up to 4 levels deep. Null = top-level. Self-referential FK.
  parentSubteamId: uuid('parent_subteam_id').references((): AnyPgColumn => subteams.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const subteamUsers = pgTable('subteam_users', {
  subteamId: uuid('subteam_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.subteamId, t.userId, t.role] })])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  oktaId: text('okta_id').notNull().unique(),
  // v1.178.0: Azure AD / Entra ID object id (oid/sub) for Azure SSO users.
  // Nullable — only set for users who signed in via Azure. oktaId still
  // carries a synthetic 'azure:<oid>' value to satisfy its NOT NULL/unique.
  azureId: text('azure_id').unique(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  // v1.127.0: First / last name split out of displayName so we can
  // group / sort / display by surname (e.g. All-users notes grouped
  // by last name). displayName stays as the canonical full-name field
  // rendered everywhere else — server keeps it in sync as
  // `${firstName} ${lastName}` on every user update.
  firstName: text('first_name'),
  lastName: text('last_name'),
  passwordHash: text('password_hash'),
  mustChangePassword: boolean('must_change_password').default(false).notNull(),
  // v1.323.0: when passwordHash was last set. Drives the 90-day password
  // expiry policy (§4) — only enforced for authMethod='password' accounts.
  // See migration 0142 for the deploy-day backfill rationale.
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  // v1.425.0 (security audit L8): set when an App Admin disables the account.
  // requireAuth, every sign-in path and API keys refuse a disabled user.
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  disabledBy: uuid('disabled_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  crmUserId: text('crm_user_id'),
  // v1.453.0: a Gong user picked by an App Admin, overriding the email match.
  gongUserId: text('gong_user_id'),
  themePreference: text('theme_preference').default('system').notNull(),
  timezone: text('timezone').default('UTC').notNull(),
  timezoneCheckedAt: timestamp('timezone_checked_at', { withTimezone: true }),
  // v1.469.0: where users.timezone comes from ('auto' follows Outlook; 'crm' and
  // 'manual' are the user's own pick, which the Outlook check leaves alone) and
  // the mailbox's own timezone, kept so Settings can offer it back.
  timezoneSource: text('timezone_source').default('auto').notNull(),
  outlookTimezone: text('outlook_timezone'),
  isAppAdmin: boolean('is_app_admin').default(false).notNull(),
  canSeeAllTeams: boolean('can_see_all_teams').default(false).notNull(),
  isDefaultAdmin: boolean('is_default_admin').default(false).notNull(),
  authMethod: text('auth_method').default('both').notNull(),
  defaultTeamId: uuid('default_team_id').references(() => teams.id, { onDelete: 'set null' }),
  workDays: integer('work_days').default(31).notNull(),
  workDayStartHour: integer('work_day_start_hour').default(8).notNull(),
  workDayEndHour: integer('work_day_end_hour').default(18).notNull(),
  workHoursPerDay: jsonb('work_hours_per_day'),
  workerType: text('worker_type').default('full_time').notNull(),
  // v1.75.0: user's preferred display currency (ISO 4217 code). When
  // set, ACV/ARR/revenue pills convert from SF USD via the latest
  // fx_rates row. NULL = show raw USD.
  preferredCurrency: text('preferred_currency'),
  outlookEventsLastSyncedAt: timestamp('outlook_events_last_synced_at', { withTimezone: true }),
  // v1.156.0: per-user opt-in to write logged activities back to their own
  // Outlook calendar. Off by default — explicit, and requires reconnecting
  // Outlook to grant the Calendars.ReadWrite scope.
  outlookWritebackEnabled: boolean('outlook_writeback_enabled').default(false).notNull(),
  // v1.249.0: single flag behind both the Flight Deck modal's "Don't show
  // again" checkbox and the matching My Settings toggle — one boolean, two
  // entry points. Default true so a brand-new user sees it on first login.
  showFlightDeck: boolean('show_flight_deck').default(true).notNull(),
  // v1.243.0: personal Non-Activity subject keywords, set by the user in
  // My Settings → Data & Templates. A meeting whose subject contains any of
  // these is auto-marked Non-Activity in THIS user's ImpactIQ only — it never
  // affects anyone else, unlike the team-scoped admin keyword_rules.
  //
  // Evaluated AFTER the admin rules (so an admin rule that assigns a real
  // activity type still wins) but BEFORE the AI classifier, since an explicit
  // instruction from the user should outrank a guess.
  nonActivityKeywords: text('non_activity_keywords').array(),
  // v1.457.0: AI Notes sections this person wants (null = the team's default).
  aiNotesSections: text('ai_notes_sections').array(),
  // v1.262.0: "Private meetings → Non-Activity" — My Settings → Data &
  // Templates, next to Non-Activity Keywords, default checked. A distinct
  // rule from nonActivityKeywords above: this one consults the Outlook
  // event's sensitivity field (private/confidential), never subject text.
  // Same ordering as the keyword rule — after team keyword_rules, before
  // the AI classifier — and converges on the same non_activity_events
  // upsert as every other Non-Activity path (CLAUDE.md §7/§11).
  privateMeetingsAsNonActivity: boolean('private_meetings_as_non_activity').default(true).notNull(),
  // v1.263.0: self-service scheduling preference — My Settings → Work &
  // Notifications. Distinct from the admin-managed defaultTeamId ABOVE only
  // in that this route lets the user themselves change it (still the same
  // column/semantics everywhere else that reads it — Flight Deck, Themes,
  // cost-rate resolution). defaultSubteamId seeds the Scheduling page's
  // subteam filter and requires the user to actually belong to that subteam
  // under their default team; cleared whenever defaultTeamId changes since a
  // subteam only makes sense under the team it belongs to.
  defaultSubteamId: uuid('default_subteam_id').references(() => subteams.id, { onDelete: 'set null' }),
  totpSecretEncrypted: text('totp_secret_encrypted'),
  totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),
  mfaBackupCodesHash: jsonb('mfa_backup_codes_hash'),
  slackUserId: text('slack_user_id'),
  // v1.137.0: per-user throttle for manual SF Opp-snapshot refresh from Dashboard.
  snapshotRefreshLastAt: timestamp('snapshot_refresh_last_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.323.0: last few superseded password hashes for the reuse check —
// "can't reuse one of your last 5 passwords" checks the CURRENT hash on
// `users` plus the most recent PASSWORD_HISTORY_LIMIT-1 rows here. Only
// ever written for authMethod='password' accounts. Pruned to that count on
// every password change (see services/auth/passwordPolicy.ts) rather than
// growing unbounded.
export const passwordHistory = pgTable('password_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const outlookEvents = pgTable('outlook_events', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subject: text('subject'),
  bodyPreview: text('body_preview'),
  isAllDay: boolean('is_all_day').default(false).notNull(),
  startDatetime: timestamp('start_datetime', { withTimezone: true }).notNull(),
  endDatetime: timestamp('end_datetime', { withTimezone: true }).notNull(),
  location: text('location'),
  organizerName: text('organizer_name'),
  organizerEmail: text('organizer_email'),
  attendees: jsonb('attendees'),
  seriesMasterId: text('series_master_id'),
  eventType: text('event_type'),
  // v1.225.0: free/busy signal for calendar-derived capacity (§12). Graph
  // values verbatim, never re-encoded: showAs one of
  // free/tentative/busy/oof/workingElsewhere/unknown; responseStatus one of
  // organizer/none/tentativelyAccepted/accepted/declined/notResponded. Both
  // null on rows cached before this column existed, until the next sync
  // refreshes them — treated as "busy" by the capacity predicate in the
  // meantime (see src/server/services/capacity/meetingLoad.ts).
  showAs: text('show_as'),
  isCancelled: boolean('is_cancelled'),
  responseStatus: text('response_status'),
  // v1.262.0: Graph values normal/personal/private/confidential — see
  // GraphCalendarEvent.sensitivity in services/outlook/client.ts for the
  // full write-up. 'private' and 'confidential' both drive Private Meeting
  // treatment (CLAUDE.md §7).
  sensitivity: text('sensitivity'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  // v1.91.0: cached SF Account + Opportunity suggestions based on attendee
  // emails. Nulls when SF hasn't been consulted yet or found no matches.
  // Populated by src/server/services/outlook/sync.ts via
  // findSuggestionsForEmails; 24h TTL — rows older than that recompute on
  // the next sync. See notes in that file.
  suggestedCrmAccountId: text('suggested_crm_account_id'),
  suggestedCrmAccountName: text('suggested_crm_account_name'),
  suggestedCrmOpportunityId: text('suggested_crm_opportunity_id'),
  suggestedCrmOpportunityName: text('suggested_crm_opportunity_name'),
  // v1.117.0: cache the Opportunity's parent AccountId + Name so
  // approving the suggested card writes crmAccountId onto the activity
  // (enables the clickable Account link on ActivityCard).
  suggestedCrmOpportunityAccountId: text('suggested_crm_opportunity_account_id'),
  suggestedCrmOpportunityAccountName: text('suggested_crm_opportunity_account_name'),
  crmSuggestionComputedAt: timestamp('crm_suggestion_computed_at', { withTimezone: true }),
  crmSuggestionCandidates: jsonb('crm_suggestion_candidates'),
  userOverrideCrmWhatId: text('user_override_crm_what_id'),
  userOverrideCrmWhatType: text('user_override_crm_what_type'),
  userOverrideCrmWhatName: text('user_override_crm_what_name'),
})

export const nonActivityEvents = pgTable('non_activity_events', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  outlookEventId: text('outlook_event_id').notNull(),
  markedAt: timestamp('marked_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.outlookEventId] })])

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: roleEnum('role').notNull(),
  },
  (t) => [unique().on(t.teamId, t.userId)],
)

export const teamActivityTypes = pgTable(
  'team_activity_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id').references(() => teams.id),
    name: text('name').notNull(),
    crmObjectType: crmObjectTypeEnum('crm_object_type').default('Event').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    sortOrder: integer('sort_order').notNull(),
    color: text('color'),
    icon: text('icon'),
    // Optional override — the SF Type picklist value this activity type maps
    // to. NULL means "use the activity type name". Many activity types can
    // point at the same SF value (e.g. Build out / Test / Architect → Eval Work).
    crmPicklistValue: text('crm_picklist_value'),
    // v1.125.0: per-team typical duration used by the Estimated vs
    // Logged dashboard. When set, the orange "estimated" bar =
    // typical × activity count. Nullable — falls back to the SF
    // picklist config (sf_event_type_config.typical_duration_minutes)
    // matched by name for backwards compat.
    typicalDurationMinutes: integer('typical_duration_minutes'),
    // v1.240.0: the type the Outlook suggestion fallback picks when NO
    // keyword rule and NO AI classification produced a result. Previously
    // this fell back to "the first row an unordered query happened to
    // return", which was never actually configured — see the /suggestions
    // route. At most one true per team; enforced in the admin route, not
    // here, since teamId is a plain column on this table rather than a
    // many-to-many (see activityTypeTeams) — the per-team uniqueness is
    // therefore just "unset any other row with the same teamId".
    isDefaultSuggestion: boolean('is_default_suggestion').default(false).notNull(),
    // v1.255.0: Guide fields — free text surfaced read-only on the new
    // Guide page so reps have an in-app reference for when to use this
    // type, what it's usually attached to, and worked examples. Optional;
    // a type with all three blank is simply skipped on the Guide page.
    useThisWhen: text('use_this_when'),
    usuallyAttachTo: text('usually_attach_to'),
    examples: text('examples'),
  },
  (t) => [unique().on(t.teamId, t.name)],
)

// v1.67.0: per-activity-type Salesforce Extras — additional SF context
// surfaced on the Activity form when that type is chosen. Two kinds:
// 'opp_field_display' (read-only field readout from the linked Opp) and
// 'related_object_picker' (SE picks one related SF record; Id + Name
// stored on activities.sf_related_*).
export const teamActivityTypeCrmExtras = pgTable('team_activity_type_crm_extras', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamActivityTypeId: uuid('team_activity_type_id').notNull().references(() => teamActivityTypes.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  config: jsonb('config').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.337.0: multi-valued Salesforce ticket attachment, opt-in per Activity
// Type via a 'ticket_picker' teamActivityTypeCrmExtras row above (the kind
// column is plain text, so a new kind needs no migration here — only the
// app-level Zod/TS unions that dispatch on it). ImpactIQ-only storage: the
// ticket number links out to Salesforce for viewing, but nothing here is
// ever written back (buildSfRecord() in writeback.ts never reads this
// table) — same convention as Subtypes/Marketing Event Name. One activity
// can have many tickets, hence its own table rather than a column on
// activities — same shape as activityProducts below, but with a
// denormalized per-row snapshot (crmSubject/crmStatus/etc.) since a ticket is
// a live SF record with no local admin-managed row to join back to, the
// same reason crmWhatName/crmRelatedName are stored directly on activities
// rather than re-read live on every render.
export const activityCrmTickets = pgTable('activity_crm_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  crmTicketId: text('crm_ticket_id').notNull(),
  crmTicketNumber: text('crm_ticket_number').notNull(),
  crmSubject: text('crm_subject'),
  crmDateOpened: timestamp('crm_date_opened', { withTimezone: true }),
  crmStatus: text('crm_status'),
  crmContact: text('crm_contact'),
  crmDescription: text('crm_description'),
  crmPlatform: text('crm_platform'),
  crmOwner: text('crm_owner'),
  attachedBy: uuid('attached_by').references(() => users.id, { onDelete: 'set null' }),
  attachedAt: timestamp('attached_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.activityId, t.crmTicketId)])

// v1.255.0: free-text subtype labels an admin can attach to an activity
// type (e.g. Discovery → Initial Discovery / Technical Discovery /
// Architecture). Mirrors teamActivityTypeCrmExtras's shape.
// v1.256.0: no longer display-only — selectable on the Log Activity form
// and Activity Templates when teams.subtypes_enabled is true (see
// activities.subtype_id / activity_templates.subtype_id below). Never
// written back to Salesforce; ImpactIQ-only classification.
export const teamActivityTypeSubtypes = pgTable('team_activity_type_subtypes', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamActivityTypeId: uuid('team_activity_type_id').notNull().references(() => teamActivityTypes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').default(100).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const activities = pgTable('activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  title: text('title').notNull(),
  activityTypeId: uuid('activity_type_id')
    .notNull()
    .references(() => teamActivityTypes.id),
  // v1.256.0: optional finer-grained classification under activityTypeId
  // (e.g. Discovery → Technical Discovery). ImpactIQ-only — never part of
  // the Salesforce writeback payload (see buildSfRecord in writeback.ts).
  // subtypeName is a denormalized snapshot taken at selection time, same
  // convention as crmWhatName below: an admin renaming or deleting the
  // Subtype later must not blank out what a contributor actually picked.
  // onDelete: 'set null' so a deleted Subtype clears the FK but the
  // historical name label survives.
  subtypeId: uuid('subtype_id').references(() => teamActivityTypeSubtypes.id, { onDelete: 'set null' }),
  subtypeName: text('subtype_name'),
  // v1.257.0: optional free text captured only when the chosen activity
  // type is named "Meeting" (name-matched the same way Guide.tsx already
  // special-cases Meeting — see teamActivityTypes.name). "Meeting" is the
  // highest-volume, most generic type; this is product research (PRD §7
  // roadmap) to learn whether recurring reasons should become new/expanded
  // activity types, not a field anyone reports on yet. Optional by design —
  // requiring it on the single most common type would cut against the
  // contributor-first, low-friction logging goal in CLAUDE.md §1.
  meetingTypeReason: text('meeting_type_reason'),
  // v1.258.0: App Admin triage of the above, from Admin → Monitoring →
  // Activity Health. Null status = not yet reviewed ("New"). reviewedBy
  // uses onDelete: 'set null' — same convention as subtypeId — so deleting
  // the reviewing admin's account doesn't cascade into losing the review.
  meetingTypeReasonStatus: meetingReasonReviewStatusEnum('meeting_type_reason_status'),
  meetingTypeReasonReviewedBy: uuid('meeting_type_reason_reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  meetingTypeReasonReviewedAt: timestamp('meeting_type_reason_reviewed_at', { withTimezone: true }),
  // v1.334.0: optional free text captured only when the chosen activity
  // type is named "Marketing" (same name-matched convention as
  // meetingTypeReason above). ImpactIQ-only — never part of the Salesforce
  // writeback payload (see buildSfRecord in writeback.ts). No admin triage
  // workflow like meetingTypeReason's Activity Health page — this is just
  // a free-text label the contributor fills in (e.g. "Innovate Security
  // Summit"), not product research needing review.
  marketingEventName: text('marketing_event_name'),
  status: activityStatusEnum('status').default('draft').notNull(),
  startDatetime: timestamp('start_datetime', { withTimezone: true }).notNull(),
  endDatetime: timestamp('end_datetime', { withTimezone: true }).notNull(),
  effortHours: decimal('effort_hours', { precision: 4, scale: 2 }).notNull(),
  notes: text('notes'),
  location: text('location'),
  descriptionBody: text('description_body'),
  locationMode: text('location_mode').default('remote').notNull(),
  meetingOwner: text('meeting_owner'),
  // v1.319.0: kept alongside meetingOwner (name only) rather than folded into
  // one combined string, so cards can render the name and use the email only
  // for a hover tooltip / disambiguation — two people can share a display
  // name across different orgs. Never sent to Salesforce (writeback.ts keeps
  // using meetingOwner's plain name in its free-text notes, matching
  // Subtypes' "ImpactIQ-only, never in the SF payload" convention).
  meetingOwnerEmail: text('meeting_owner_email'),
  attendees: jsonb('attendees'),
  acv: decimal('acv', { precision: 14, scale: 2 }),
  // v1.176.0: out-of-pocket travel spend for a Remote activity ("Direct Costs").
  // Entered in the contributor's My-Settings display currency (stored in
  // incidentalCurrency) and FX-converted to USD for the cost dashboards.
  costTransportation: decimal('cost_transportation', { precision: 14, scale: 2 }),
  costLodging: decimal('cost_lodging', { precision: 14, scale: 2 }),
  costFood: decimal('cost_food', { precision: 14, scale: 2 }),
  incidentalCurrency: text('incidental_currency'),
  salesStage: text('sales_stage'),
  forecastCategory: text('forecast_category'),
  oppAmount: decimal('opp_amount', { precision: 14, scale: 2 }),
  // v1.137.0: refreshed from SF nightly + via manual endpoint. Lets the
  // User Leaderboard's Efficiency Ratio use CLOSED-WON ACV rather than
  // total ACV touched (an Opp still in Prospecting doesn't count as won).
  crmIsClosed: boolean('crm_is_closed').default(false),
  crmIsWon: boolean('crm_is_won').default(false),
  crmSnapshotRefreshedAt: timestamp('crm_snapshot_refreshed_at', { withTimezone: true }),
  oppCloseDate: date('opp_close_date'),
  outlookEventId: text('outlook_event_id'),
  // v1.262.0: snapshotted from the source Outlook event's sensitivity at
  // approval time (see outlookEvents.sensitivity), so the card can render
  // the Private Meeting treatment without a live Graph re-fetch and so it
  // survives even if outlookEventId later disconnects. Never flipped back
  // to false automatically — see CLAUDE.md §7 Private Meetings.
  isPrivateMeeting: boolean('is_private_meeting').default(false).notNull(),
  crmWhatId: text('crm_what_id'),
  crmWhatType: crmWhatTypeEnum('crm_what_type'),
  crmWhatName: text('crm_what_name'),
  // v1.97.0: display cache — Account of the linked Opportunity + current
  // Assigned SE — snapshotted from the ActivityForm's SF picker on save.
  // The card renders from these directly; the live SF fetches remain as
  // a fallback / refresh for the clickable Account URL.
  crmAccountId: text('crm_account_id'),
  crmAccountName: text('crm_account_name'),
  crmAssignedSeName: text('crm_assigned_se_name'),
  // v1.138.0: refreshed by refreshOppSnapshots when the matching
  // crm_field_mappings row has background_refresh = true.
  crmPrimaryEngineerName: text('crm_primary_engineer_name'),
  crmOppOwnerId: text('crm_opp_owner_id'),
  crmOppOwnerName: text('crm_opp_owner_name'),
  crmOppCloseDate: date('crm_opp_close_date'),
  // v1.67.0: SF child link surfaced by a per-activity-type extras
  // config (currently only Eval Work → Evaluation__c). Separate from
  // sfWhat so an activity can point at BOTH the parent Opportunity and
  // the specific Evaluation record.
  crmRelatedType: text('crm_related_type'),
  crmRelatedId: text('crm_related_id'),
  crmRelatedName: text('crm_related_name'),
  // v1.148.0: Evaluation__c ("Project") field snapshot — refreshed
  // nightly by refreshOppSnapshots and updated live whenever a user
  // edits them via PATCH /api/salesforce/evaluations/:id. Kept in the
  // sfRelated* group; avoids colliding with crmRelatedType (which holds
  // the SF object API name, e.g. "Evaluation__c").
  crmEvalStatus: text('crm_eval_status'),
  crmEvalStage: text('crm_eval_stage'),
  crmEvalType: text('crm_eval_type'),
  crmEvalStartDate: date('crm_eval_start_date'),
  crmEvalEndDate: date('crm_eval_end_date'),
  // v1.285.0: Evaluation__c Primary Engineer snapshot, same convention as
  // the other sf_eval_* fields above — refreshed nightly and by the Project
  // preview popover's live read, once a team maps eval_primary_engineer.
  crmEvalPrimaryEngineer: text('crm_eval_primary_engineer'),
  // Salesforce WhoId — accepts Contact and Lead. Free-form text with a
  // CHECK constraint so the polymorphic type can grow without an enum
  // migration if SF later adds Person Accounts as a valid Who target.
  crmWhoId: text('crm_who_id'),
  crmWhoType: text('crm_who_type'),
  crmWhoName: text('crm_who_name'),
  // v1.344.0: set by the nightly detect_disconnected_links job and by the
  // activity drawer's own live check (GET /api/salesforce/activity-link-status)
  // whenever a What/Who/Related id was requested from Salesforce but not
  // returned by a SUCCESSFUL query — never on a failed/thrown check, which
  // leaves these columns untouched. One boolean per link since each is an
  // independently-managed lookup. Self-healing: cleared back to false the
  // next time the linked record is found again.
  crmWhatDeleted: boolean('crm_what_deleted').default(false).notNull(),
  crmWhoDeleted: boolean('crm_who_deleted').default(false).notNull(),
  crmRelatedDeleted: boolean('crm_related_deleted').default(false).notNull(),
  crmDisconnectCheckedAt: timestamp('crm_disconnect_checked_at', { withTimezone: true }),
  crmRecordId: text('crm_record_id'),
  // v1.410.0: the CRM record in crm_record_id was already there and ImpactIQ
  // adopted it (a HubSpot meeting logged by HubSpot's own calendar sync)
  // rather than creating it. ImpactIQ then only fills in its own fields,
  // never the title/times/owner/body, and never deletes it.
  crmRecordAdopted: boolean('crm_record_adopted').default(false).notNull(),
  crmSyncStatus: crmSyncStatusEnum('crm_sync_status'),
  crmSyncError: text('crm_sync_error'),
  crmSyncedAt: timestamp('crm_synced_at', { withTimezone: true }),
  // v1.212.0: automatic retry of failed write-backs with exponential backoff.
  // attempts counts failed tries; nextRetryAt gates when the worker may re-pick
  // a failed row (null once it's exhausted the cap → parked for manual retry).
  crmSyncAttempts: integer('crm_sync_attempts').default(0).notNull(),
  crmNextRetryAt: timestamp('crm_next_retry_at', { withTimezone: true }),
  // v1.156.0: Outlook calendar write-back. The Graph event id we CREATED for
  // this activity (distinct from outlookEventId, which is the inbound meeting
  // an activity was created FROM). Only set for activities the user opted to
  // write to their calendar.
  outlookWritebackEventId: text('outlook_writeback_event_id'),
  outlookSyncStatus: outlookSyncStatusEnum('outlook_sync_status'),
  outlookSyncError: text('outlook_sync_error'),
  outlookSyncedAt: timestamp('outlook_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // v1.241.0: when this activity was APPROVED (status draft -> submitted).
  // Distinct from updatedAt, which any later edit moves, and from createdAt,
  // which is when the row appeared. Set once on the transition and not
  // cleared on un-approve, so a re-approve overwrites it with the newer date
  // rather than leaving a stale one.
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  // v1.242.0: the Outlook event this APPROVED activity came from (or that
  // ImpactIQ wrote back) has disappeared from the user's calendar.
  //
  // Only ever set from the deletion-reconcile pass in syncUserCalendar, which
  // runs solely after a SUCCESSFUL Graph fetch — "absent from Graph" and
  // "deleted" are not the same thing, and flagging a real activity because a
  // fetch failed would be worse than missing one. Cleared automatically if the
  // event reappears in a later sync.
  outlookDeletedAt: timestamp('outlook_deleted_at', { withTimezone: true }),
  // Set when the user picks Keep on the review card: the activity stays in
  // ImpactIQ + Salesforce and stops being re-flagged on every subsequent sync
  // (which would otherwise resurface it forever, since the event stays gone).
  // Also cleared on reappearance, so a re-created meeting starts fresh.
  outlookDeletedKept: boolean('outlook_deleted_kept').default(false).notNull(),
  isArchived: boolean('is_archived').default(false).notNull(),
  // v1.481.0: the logging tool's own id for an activity created through
  // POST /api/v1/activities/log (activities:log key), e.g. "demoiq:run:<id>".
  // Unique when set (partial index, migration 0187), so a retried call never
  // creates a second activity. Null for activities logged in ImpactIQ.
  externalRef: text('external_ref'),
})

// v1.259.0: generalized from an activity-writeback-only log into the
// tenant-wide "every Salesforce write attempt" trail behind Admin → CRM
// Sync → History. activityId is now nullable — a note push or an Engineer
// Notes prepend-update doesn't always originate from one specific activity
// row (an Evaluation record can be touched by several logged activities),
// so a row can stand on crmObject/crmRecordId/userId alone. `source`
// discriminates which subsystem wrote the row (see SyncSource in
// services/salesforce/syncAudit.ts); it defaults to 'activity_writeback'
// so every pre-existing row is correctly attributed without a backfill
// pass. `userId` is the acting user for sources that aren't necessarily
// the activity owner (e.g. an admin editing someone else's linked record).
export const activitySyncAudit = pgTable('activity_sync_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull().default('activity_writeback'),
  activityId: uuid('activity_id').references(() => activities.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).defaultNow().notNull(),
  status: text('status').notNull(),
  operation: text('operation').notNull(),
  crmObject: text('crm_object'),
  crmRecordId: text('crm_record_id'),
  errorMessage: text('error_message'),
  payload: jsonb('payload'),
})

// v1.261.0: manual "I've handled this" annotation for a CRM Sync issue —
// Admin -> CRM Sync -> Issues -> Resolve. Deliberately NOT a status flip on
// the underlying row (activities.crmSyncStatus / activity_note_pushes.status
// stay whatever they actually are) — this is a separate admin annotation
// layered on top, so a resolution can never mask a genuinely new failure.
// issueKey is source-specific: activities.id for 'activity_writeback';
// `${activityNoteId}:${crmTargetType}:${crmTargetId}` for 'note_push' (the
// same latest-per-target grouping key the Issues query already uses — see
// admin.ts's /sync-issues route). A row is "currently resolved" only if
// this resolvedAt is >= the issue's own failure timestamp (updatedAt for
// activities, createdAt for note pushes) — computed at query time, not
// stored — so a fresh failure after resolution naturally reopens the
// issue with no extra bookkeeping. Multiple rows can accumulate per
// issueKey over time (resolve -> fails again -> resolve again); callers
// only ever care about the latest one.
export const syncIssueResolutions = pgTable('sync_issue_resolutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  issueKey: text('issue_key').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
})

export const crmFieldMappings = pgTable('crm_field_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  appField: text('app_field').notNull(),
  crmFieldApi: text('crm_field_api').notNull(),
  // Free-form so admins can map into any SF SObject (Opportunity, Account,
  // custom objects) — not only Event/Task. Writeback still validates the
  // target against team_activity_types.crm_object_type for the Activity path.
  crmObject: text('crm_object').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  // 'read' | 'write' | 'read_write'. Writeback skips mappings whose direction
  // doesn't include write, letting admins pull reference data (ACV, Owner name)
  // without granting ImpactIQ authority to overwrite it.
  direction: text('direction').default('read_write').notNull(),
  // v1.138.0: when true, refreshOppSnapshots pulls this SF field on each
  // run and stamps its value back onto the linked activity row. Ignored
  // for write-only mappings.
  backgroundRefresh: boolean('background_refresh').default(false).notNull(),
  // v1.140.0: when true, this mapping is refresh-only — the SF field is
  // read from Salesforce on every refresh (implied backgroundRefresh),
  // but writeback + form-read paths skip the row entirely. Useful for
  // Opportunity metadata fields that dashboards depend on (Stage,
  // Forecast, IsWon, Assigned SE, …) which we never want to push back.
  refreshOnlyForReports: boolean('refresh_only_for_reports').default(false).notNull(),
  // Populated when the SF field is a reference type — the target SObject name
  // (e.g. OwnerId → 'User'). Enables future SOQL traversal for display.
  referenceTo: text('reference_to'),
  // When set, writeback forces crmFieldApi = constantValue and ignores appField
  // — used to hard-code fields like Activity_Status__c='Completed' or ShowAs='Busy'.
  constantValue: text('constant_value'),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

// v1.187.0: which SF fields mark an Opportunity as having a Solutions
// Engineer "attached" — drives the Attach Rate coverage dashboard. Team-
// scoped and admin-editable so an org whose engineer fields live on a
// different object (e.g. Evaluation__c) can point at them without a code
// deploy. Seeded with the four proven Opportunity fields.
export const attachRateFields = pgTable('attach_rate_fields', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  // SObject the field lives on (e.g. 'Opportunity'). Free-form to allow
  // custom objects; validated against a describe() before use.
  crmObject: text('crm_object').notNull(),
  // SF field API name (e.g. 'Assigned_SE__c').
  fieldApi: text('field_api').notNull(),
  // 'equals' → field != null; 'includes' → multi-select INCLUDES check.
  matchType: text('match_type').default('equals').notNull(),
  // v1.189.0: when true the field's values are Salesforce User Ids that the
  // dashboard resolves to display names via users.crm_user_id. When false the
  // values are already display names (e.g. a multi-select name picklist) and
  // are shown as-is. Lookup fields → true; name multi-selects → false.
  resolveUsers: boolean('resolve_users').default(true).notNull(),
  // v1.189.0: for fields on a non-Opportunity object (e.g. Evaluations__c),
  // the API name of the lookup on THAT object pointing back to Opportunity,
  // used to roll the object's rows up to their parent opp. Null for
  // Opportunity-object fields; defaults to 'Opportunity__c' server-side.
  oppLinkField: text('opp_link_field'),
  // v1.192.0: admin-editable label for the role this field represents
  // (e.g. 'Assigned SE', 'Primary Engineer'), shown in the dashboard's
  // per-role breakdown card. Falls back to a humanized field API name.
  roleLabel: text('role_label'),
  isActive: boolean('is_active').default(true).notNull(),
})

// v1.188.0: local snapshot of Salesforce opportunities used by the Attach
// Rate dashboard. Refreshed on a schedule so the dashboard, its Compare
// modes, and its trend series all read from Postgres (fast local GROUP BYs)
// instead of hammering SF with a live query per view. One row per opp.
// `fieldValues` stores the SE user ids found in each configured attach field
// ({ fieldApi: [crmUserId, …] }) rather than a precomputed boolean, so each
// team can define "attached" differently and the rate is computed at query
// time against that team's active attach_rate_fields config.
export const crmOpportunityCoverage = pgTable('crm_opportunity_coverage', {
  oppId: text('opp_id').primaryKey(),
  createdDate: date('created_date'),
  closeDate: date('close_date'),
  stageName: text('stage_name'),
  forecastCategory: text('forecast_category'),
  isClosed: boolean('is_closed').default(false).notNull(),
  fieldValues: jsonb('field_values'),
  // v1.192.0: Opportunity OwnerId (for the Sales-Team-Alignment rep-owned
  // breakdown) and Amount (for the ACV-weighted attach rate).
  ownerId: text('owner_id'),
  amount: decimal('amount', { precision: 18, scale: 2 }),
  // v1.203.0: Opportunity Total_Acv__c — the ACV figure the rest of the app
  // shows and filters on. Attach-rate ACV weighting + the ACV-range filter
  // prefer this over Amount (falling back to Amount until a refresh runs).
  totalAcv: decimal('total_acv', { precision: 18, scale: 2 }),
  // v1.193.0: Opportunity Name, so the "no Assigned SE" call-out can name
  // the opportunities that are attached only via secondary signals.
  oppName: text('opp_name'),
  // v1.194.0: Opportunity Owner Name, shown in the call-out alongside a
  // suggested SE (from Sales Team Alignment on the owner).
  ownerName: text('owner_name'),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.190.0: daily point-in-time history of the open-pipeline attach rate
// per team, so the Attach Rate dashboard's Open Pipeline basis can show
// week-over-week Compare and a weekly trend (the live snapshot alone has no
// past to compare against). Overall per team only — Stage/Forecast slices
// are not retained. Accrues from deploy onward; one row per team per day.
export const attachRateHistory = pgTable('attach_rate_history', {
  teamId: uuid('team_id').notNull().references(() => teams.id),
  snapshotDate: date('snapshot_date').notNull(),
  total: integer('total').default(0).notNull(),
  attached: integer('attached').default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.teamId, t.snapshotDate] })])

// v1.191.0: Salesforce User Id → Name cache, filled during the coverage
// refresh so the Attach Rate per-SE breakdown can show display names for
// engineer lookup fields even when the SF user isn't an ImpactIQ user.
export const sfUserNames = pgTable('sf_user_names', {
  sfUserId: text('sf_user_id').primaryKey(),
  name: text('name'),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// v1.213.0: Historical Salesforce Event import (pre-ImpactIQ activity).
//
// HARD RULE: rows in crm_historical_events are NEVER joined into cost,
// capacity, utilization, or any dollar figure. Their hours are ESTIMATES
// derived from the meeting length scheduled in Salesforce, not effort a
// person logged. There is deliberately no cost column, no FK to activities,
// and the hours column is named estimatedHours (not effortHours) so nothing
// in services/capacity/resolver.ts can pick it up by accident.
//
// These live outside `activities` because activities.userId / .teamId /
// .activityTypeId are all NOT NULL, and historical rows legitimately have
// none of the three (departed employees, unmapped SF Type values).
//
// Partial indexes for these tables are declared as raw SQL in
// drizzle/migrations/0111_historical_events.sql (Drizzle's index builder
// can't express `WHERE ...`), following the 0109_perf_indexes precedent.
// ---------------------------------------------------------------------------

// Declared before crmHistoricalEvents because that table FKs into it.
export const crmHistoricalImportRuns = pgTable('crm_historical_import_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  // 'running' | 'ok' | 'error' | 'cancelled' | 'paused'
  status: text('status').notNull(),
  triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
  // 'backfill' | 'opp_refresh' | 'relink'
  kind: text('kind').notNull(),
  // The time slice this run covered — the human-readable provenance anchor.
  sliceFrom: timestamp('slice_from', { withTimezone: true }),
  sliceTo: timestamp('slice_to', { withTimezone: true }),
  eventsFetched: integer('events_fetched').default(0).notNull(),
  eventsInserted: integer('events_inserted').default(0).notNull(),
  eventsSkipped: integer('events_skipped').default(0).notNull(),
  // v1.215.0: dropped by an exclusion rule. Deliberately separate from
  // eventsSkipped, which means "malformed, no Id".
  eventsExcluded: integer('events_excluded').default(0).notNull(),
  oppsUpserted: integer('opps_upserted').default(0).notNull(),
  accountsUpserted: integer('accounts_upserted').default(0).notNull(),
  usersMatched: integer('users_matched').default(0).notNull(),
  usersUnmatched: integer('users_unmatched').default(0).notNull(),
  typesMatched: integer('types_matched').default(0).notNull(),
  typesUnmatched: integer('types_unmatched').default(0).notNull(),
  crmApiCalls: integer('crm_api_calls').default(0).notNull(),
  durationMs: integer('duration_ms'),
  error: text('error'),
  detail: jsonb('detail'),
})

export const crmHistoricalEvents = pgTable('crm_historical_events', {
  // SF Event Id — natural key, which is what makes slice replay idempotent.
  crmEventId: text('crm_event_id').primaryKey(),

  // --- raw Salesforce payload, always kept verbatim ---
  subject: text('subject'),
  crmType: text('crm_type'), // Event.Type picklist, unmodified
  activityDate: date('activity_date'),
  startDatetime: timestamp('start_datetime', { withTimezone: true }),
  endDatetime: timestamp('end_datetime', { withTimezone: true }),
  durationMinutes: integer('duration_minutes'),
  isAllDayEvent: boolean('is_all_day_event').default(false).notNull(),
  isRecurrence: boolean('is_recurrence').default(false).notNull(),
  ownerCrmUserId: text('owner_crm_user_id'),
  ownerCrmUserName: text('owner_crm_user_name'),
  // v1.215.0: who CREATED the Event in Salesforce, as opposed to who owns it.
  // Integrations like Outreach create Events and assign them to a human owner,
  // so this is the only field that identifies machine-generated activity.
  createdByCrmUserId: text('created_by_crm_user_id'),
  createdByCrmUserName: text('created_by_crm_user_name'),
  whatId: text('what_id'),
  whatType: text('what_type'),
  whatName: text('what_name'),
  whoId: text('who_id'),
  accountId: text('account_id'),
  description: text('description'),
  location: text('location'),
  crmCreatedDate: timestamp('crm_created_date', { withTimezone: true }),
  crmSystemModstamp: timestamp('crm_system_modstamp', { withTimezone: true }),

  // --- best-effort local linkage; ALL nullable, by design ---
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  activityTypeId: uuid('activity_type_id').references(() => teamActivityTypes.id, { onDelete: 'set null' }),
  // How each link was made: 'sf_user_id' (stored value, kept) | 'email' | null, and
  // 'picklist_override' | 'name_exact' | 'admin_map' | null.
  userMatchMethod: text('user_match_method'),
  typeMatchMethod: text('type_match_method'),

  // --- derived, explicitly non-monetary ---
  estimatedHours: decimal('estimated_hours', { precision: 6, scale: 2 }),

  // --- provenance ---
  importRunId: uuid('import_run_id').references(() => crmHistoricalImportRuns.id, { onDelete: 'set null' }),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
  relinkedAt: timestamp('relinked_at', { withTimezone: true }),
})

// Local mirror of every Opportunity referenced by an imported historical
// Event. Deliberately NOT crm_opportunity_coverage: that table is
// attach-rate-config-gated, row-capped, culls closed opps after 2 years, and
// continuously re-snapshots open ones. This one is uncapped,
// config-independent, and immutable once the opp closes.
export const crmHistoricalOpportunities = pgTable('crm_historical_opportunities', {
  oppId: text('opp_id').primaryKey(),
  oppName: text('opp_name'),
  accountId: text('account_id'),
  accountName: text('account_name'),
  stageName: text('stage_name'),
  forecastCategory: text('forecast_category'),
  isClosed: boolean('is_closed').default(false).notNull(),
  isWon: boolean('is_won').default(false).notNull(),
  amount: decimal('amount', { precision: 18, scale: 2 }),
  totalAcv: decimal('total_acv', { precision: 18, scale: 2 }),
  closeDate: date('close_date'),
  createdDate: date('created_date'),
  ownerId: text('owner_id'),
  ownerName: text('owner_name'),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).defaultNow().notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  // Set once, the first time IsClosed = true is observed; never cleared.
  // A non-null frozenAt permanently excludes the row from the refresh SELECT —
  // this is the enforcement point for "closed opps are never refreshed".
  frozenAt: timestamp('frozen_at', { withTimezone: true }),
})

// Immutable account name cache so history views don't need a live SF call.
export const crmHistoricalAccounts = pgTable('crm_historical_accounts', {
  accountId: text('account_id').primaryKey(),
  name: text('name'),
  ownerId: text('owner_id'),
  industry: text('industry'),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
})

// Admin override for SF Event.Type -> local activity type, consulted after
// the picklist/name ladders. Exists so a mis-mapped 3-year history is fixable
// by re-running relink instead of re-importing from Salesforce.
export const crmHistoricalTypeMap = pgTable('crm_historical_type_map', {
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  crmTypeValue: text('crm_type_value').notNull(), // lowercased Event.Type
  activityTypeId: uuid('activity_type_id').references(() => teamActivityTypes.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.teamId, t.crmTypeValue] })])

// v1.215.0: admin-managed exclusion lists for the historical import.
//
// Two independent rules — by Salesforce CreatedById and by OwnerId — kept in
// one table with a closed two-value discriminator. They're structurally
// identical and differ only in which event column the predicate targets, so
// splitting them would duplicate the loader, routes, and types to express a
// single ternary. The composite PK is deliberate: the same SF Id can
// legitimately appear in both lists.
//
// This exists because integration users are indistinguishable from humans in
// Salesforce — Outreach has UserType 'Standard' and a System Administrator
// profile — so there is no heuristic, only an explicit list.
export const crmHistoricalExclusions = pgTable('crm_historical_exclusions', {
  // 'created_by' | 'owner' (CHECK constraint lives in migration 0112)
  kind: text('kind').notNull(),
  crmUserId: text('crm_user_id').notNull(),
  label: text('label'),
  note: text('note'),
  isActive: boolean('is_active').default(true).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  lastPurgedAt: timestamp('last_purged_at', { withTimezone: true }),
  purgedCount: integer('purged_count').default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.kind, t.crmUserId] })])

// Backward-walking cursor for the resumable backfill. Distinct from
// crm_snapshot_state, which is a forward watermark; the ongoing open-opp
// refresh does reuse that table under key 'historical_opp_refresh'.
export const crmHistoricalBackfillState = pgTable('crm_historical_backfill_state', {
  key: text('key').primaryKey(), // 'events'
  // Everything strictly OLDER than this is still to do.
  cursorBefore: timestamp('cursor_before', { withTimezone: true }).notNull(),
  // Hard floor; cursorBefore <= floorAt means the backfill is complete.
  floorAt: timestamp('floor_at', { withTimezone: true }).notNull(),
  sliceDays: integer('slice_days').default(90).notNull(),
  // 'idle' | 'running' | 'paused' | 'complete' | 'error'
  status: text('status').default('idle').notNull(),
  lastRunId: uuid('last_run_id').references(() => crmHistoricalImportRuns.id, { onDelete: 'set null' }),
  totalEventsImported: integer('total_events_imported').default(0).notNull(),
  totalSlicesDone: integer('total_slices_done').default(0).notNull(),
  lastError: text('last_error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const sfEventTypeConfig = pgTable('sf_event_type_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  sfPicklistValue: text('sf_picklist_value').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  fallbackValue: text('fallback_value'),
  typicalDurationMinutes: integer('typical_duration_minutes'),
})

export const keywordRules = pgTable('keyword_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id),
  keywords: text('keywords').array().notNull(),
  // v1.240.0: nullable — NULL when action = 'mark_non_activity', since that
  // action doesn't suggest a type at all. Required (enforced in the admin
  // route, not a DB constraint) when action = 'suggest_type'.
  activityTypeId: uuid('activity_type_id')
    .references(() => teamActivityTypes.id),
  matchField: matchFieldEnum('match_field').notNull(),
  priority: integer('priority').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  action: keywordRuleActionEnum('action').default('suggest_type').notNull(),
})

export const nudgeRules = pgTable('nudge_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id),
  // v1.324.0: admin-editable display name, used to tell apart rules that
  // share a triggerType — the Nudge History page's "Nudge" filter/column
  // and Audit Log both identify a rule by this, not the raw trigger_type.
  // Backfilled (migration 0143) to a Title Case version of trigger_type for
  // every pre-existing rule; admin can rename freely afterward.
  name: text('name').notNull(),
  triggerType: nudgeTriggerTypeEnum('trigger_type').notNull(),
  triggerConfig: jsonb('trigger_config').notNull(),
  messageTemplate: text('message_template').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  // v1.62.0 (Batch A): severity drives notification card color +
  // downstream email urgency; icon is a lucide identifier rendered as
  // a chip on the notification card. Null icon → default per trigger.
  severity: text('severity').notNull().default('info'),
  icon: text('icon'),
  // v1.63.0 (Batch B): minimum hours between deliveries of this rule to
  // the same user. NULL → no cooldown (fires whenever the trigger holds).
  cooldownHours: integer('cooldown_hours'),
  // v1.65.0 (Final batch): optional AND/OR combinator layered on top of
  // the base trigger. Shape: {op:'AND'|'OR', clauses:[{triggerType,config}]}.
  // NULL preserves single-trigger behavior.
  conditions: jsonb('conditions'),
  // v1.65.0 (Final batch): when non-null, this rule is a LEADER rollup —
  // it fires for a team leader whose direct reports have ≥ threshold total
  // overdue nudges of the same base type. Ignored for non-leaders.
  leaderRollupThreshold: integer('leader_rollup_threshold'),
  // v1.96.0: per-rule email delivery toggle. When true, the nudge is
  // ALSO sent as an email using the team's active theme email template
  // (in addition to the in-app card). Defaults false — teams opt in per
  // rule so noisy rules don't blast mailboxes.
  sendEmail: boolean('send_email').default(false).notNull(),
  // v1.433.0: per-rule "Also send as a Slack DM" toggle. Delivered by the
  // workspace bot (Admin → Integrations → Slack) to the user's linked
  // users.slack_user_id, unless they turned Slack DMs off in My Settings.
  // Defaults false, same opt-in reasoning as sendEmail.
  sendSlackDm: boolean('send_slack_dm').default(false).notNull(),
})

// v1.125.0: per-locale translations for a nudge rule's message_template.
// Admin adds one row per language they want to support. Server picks the
// row matching the recipient's locale; if missing, falls back to the
// base nudge_rules.message_template. Deleting the parent rule cascades.
export const nudgeRuleTranslations = pgTable('nudge_rule_translations', {
  id: uuid('id').primaryKey().defaultRandom(),
  nudgeRuleId: uuid('nudge_rule_id').notNull().references(() => nudgeRules.id, { onDelete: 'cascade' }),
  locale: text('locale').notNull(),
  messageTemplate: text('message_template').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.nudgeRuleId, t.locale)])

export const nudgeEvents = pgTable('nudge_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  nudgeRuleId: uuid('nudge_rule_id').references(() => nudgeRules.id, { onDelete: 'set null' }),
  triggerType: text('trigger_type').notNull(),
  message: text('message').notNull(),
  channel: text('channel').notNull().default('in_app'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
})

export const nudgeDismissals = pgTable('nudge_dismissals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  nudgeRuleId: uuid('nudge_rule_id')
    .notNull()
    .references(() => nudgeRules.id),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow().notNull(),
  // v1.287.0: nullable — NULL means "closed out permanently" (never
  // re-fire this rule for this user), as opposed to a snooze that expires
  // at a specific time. See migration 0140.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
})

// "Closed Lost — Needs Review" dashboard dismissals. A leader/admin marking
// one Opportunity as "reviewed, genuinely nothing to relink" so it stops
// resurfacing in that team's queue. Modeled on nudgeDismissals above but
// simpler — no expiresAt/nullable-permanent split, since this is a one-time
// judgment call about an already-closed Opportunity, not a recurring
// reminder that needs re-surfacing on a schedule. crmOppName is denormalized
// (same convention as activities.crmWhatName) so the Show Dismissed view
// never needs a live SF read just to render.
export const oppReviewDismissals = pgTable('opp_review_dismissals', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id),
  crmOppId: text('crm_opp_id').notNull(),
  crmOppName: text('crm_opp_name').notNull(),
  dismissedBy: uuid('dismissed_by').notNull().references(() => users.id),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.teamId, t.crmOppId)])

// Capacity groups — a named policy setting a weekly-hour target. Attached
// to any number of teams via capacity_group_teams. Overrides in
// capacity_user_overrides beat the group target for specific users +
// dated windows (PTO, ramp, rotation, etc.). Resolved through a single
// server-side function: src/server/services/capacity/resolver.ts.
export const capacityGroups = pgTable('capacity_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  targetHoursPerWeek: decimal('target_hours_per_week', { precision: 4, scale: 1 }),
  capacityMethod: capacityMethodEnum('capacity_method').notNull(),
  region: text('region'),
  roleType: text('role_type'),
  // v1.225.0: admin opt-in, per group — shows the calendar-derived "Meeting
  // Load" figure alongside logged/target hours on leader dashboards for this
  // group's members. Independent of capacityMethod: a fixed_hours group can
  // still show the signal without switching its target-setting method.
  showRealMeetingLoad: boolean('show_real_meeting_load').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const capacityGroupTeams = pgTable(
  'capacity_group_teams',
  {
    groupId: uuid('group_id').notNull().references(() => capacityGroups.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.teamId] }),
    // A team belongs to at most one capacity group — the constraint that
    // makes the resolver deterministic.
    teamUnique: unique('capacity_group_teams_team_id_unique').on(t.teamId),
  }),
)

export const capacityUserOverrides = pgTable('capacity_user_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  targetHoursPerWeek: decimal('target_hours_per_week', { precision: 4, scale: 1 }).notNull(),
  reason: text('reason').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Cost groups — mirror of capacity_groups but for hourly cost + currency.
// Same resolver pattern (override → group-via-team → unset).
export const costGroups = pgTable('cost_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  hourlyCostRate: decimal('hourly_cost_rate', { precision: 10, scale: 2 }).notNull(),
  currency: text('currency').default('USD').notNull(),
  region: text('region'),
  roleType: text('role_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const costGroupTeams = pgTable(
  'cost_group_teams',
  {
    groupId: uuid('group_id').notNull().references(() => costGroups.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.teamId] }),
    teamUnique: unique('cost_group_teams_team_id_unique').on(t.teamId),
  }),
)

export const costUserOverrides = pgTable('cost_user_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  hourlyCostRate: decimal('hourly_cost_rate', { precision: 10, scale: 2 }).notNull(),
  currency: text('currency').default('USD').notNull(),
  reason: text('reason').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Daily FX rates fetched from the European Central Bank (or manually
// entered). Every rate is quoted vs USD as the reference so dashboards can
// convert any cost currency to a single display currency.
//   rate = value in `currency` per 1 USD
// Refreshed by an admin-triggered POST /api/admin/fx-rates/refresh.
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    currency: text('currency').notNull(),
    ratePerUsd: decimal('rate_per_usd', { precision: 20, scale: 8 }).notNull(),
    source: text('source').notNull(), // 'ecb' | 'manual'
    asOf: date('as_of').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.currency, t.asOf)],
)

export const userIntegrations = pgTable(
  'user_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: integrationProviderEnum('provider').notNull(),
    accessTokenEncrypted: text('access_token_encrypted'),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Per-user instance URL returned by the provider's OAuth token endpoint.
    // SF uses *.my.salesforce.com for production, *.sandbox.my.salesforce.com for sandboxes.
    instanceUrl: text('instance_url'),
    // v1.78.0: friendly label for the connected OAuth account
    // (Salesforce username, Microsoft UPN, …). Populated on the OAuth
    // callback so My Settings can show "Connected as X" and admins
    // can debug which mailbox / SF user is wired up.
    accountLabel: text('account_label'),
    // v1.444.0: the last token refresh failure (App Health counts these as
    // users who need to reconnect). Cleared by a successful refresh or reconnect.
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.userId, t.provider)],
)

// Junction tables: many-to-many team assignments for shared configs.
// A rule/type with no entries here is unassigned and invisible to all teams.
export const activityTypeTeams = pgTable(
  'activity_type_teams',
  {
    activityTypeId: uuid('activity_type_id').notNull().references(() => teamActivityTypes.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.activityTypeId, t.teamId] })],
)

export const keywordRuleTeams = pgTable(
  'keyword_rule_teams',
  {
    keywordRuleId: uuid('keyword_rule_id').notNull().references(() => keywordRules.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.keywordRuleId, t.teamId] })],
)

export const nudgeRuleTeams = pgTable(
  'nudge_rule_teams',
  {
    nudgeRuleId: uuid('nudge_rule_id').notNull().references(() => nudgeRules.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.nudgeRuleId, t.teamId] })],
)

export const crmFieldMappingTeams = pgTable(
  'crm_field_mapping_teams',
  {
    crmFieldMappingId: uuid('crm_field_mapping_id').notNull().references(() => crmFieldMappings.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.crmFieldMappingId, t.teamId] })],
)

export const appThemes = pgTable('app_themes', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  colors: jsonb('colors').notNull(),
  isActive: boolean('is_active').default(false).notNull(),
  logoLight: text('logo_light'),
  logoDark: text('logo_dark'),
  // v1.85.0: outbound email template — per-theme so switching theme swaps
  // email look too. Nulls fall back to a system default in the renderer.
  emailTopBarColor: text('email_top_bar_color'),
  emailBottomBarColor: text('email_bottom_bar_color'),
  emailFooterLeftText: text('email_footer_left_text'),
  emailHeaderLogoVariant: text('email_header_logo_variant'), // 'light' | 'dark'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.450.0: accepted CriteriaIQ live-refresh webhooks, keyed by signature,
// so a replay inside the signature's five-minute window is refused on every
// replica (routes/criteriaiqWebhook.ts).
export const criteriaiqWebhookReceipts = pgTable('criteriaiq_webhook_receipts', {
  signature: text('signature').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.386.0: the CriteriaIQ project a person picked for a CRM Evaluation
// record, when several CriteriaIQ projects point at it (CriteriaIQ as the
// secondary Project source, CLAUDE.md §9). An Evaluation with exactly one
// match links on its own and has no row here.
export const criteriaiqEvaluationLinks = pgTable('criteriaiq_evaluation_links', {
  crmRecordId: text('crm_record_id').primaryKey(),
  criteriaiqProjectId: integer('criteriaiq_project_id').notNull(),
  linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.389.0: the HubSpot portal's owners (HubSpot plan, phase 2a), copied by
// the daily hubspot_owner_sync job. HubSpot has no per-user logins in
// ImpactIQ: a user's HubSpot owner is the owner with the same email, which is
// how write-back (phase 2b) sets hubspot_owner_id. Keyed by HubSpot's owner id.
export const hubspotOwners = pgTable('hubspot_owners', {
  id: text('id').primaryKey(),
  hubspotUserId: text('hubspot_user_id'),
  email: text('email'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  archived: boolean('archived').default(false).notNull(),
  // v1.406.0: the owner's HubSpot teams, as the owners list reports them.
  teams: jsonb('teams').$type<HubspotOwnerTeam[]>().default([]).notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.452.0 (Gong plan, phase 1): the Gong tenant's users, refreshed daily by
// gong_user_sync. ImpactIQ users match a Gong user by email
// (case-insensitive), which is how a call's participants are tied to
// ImpactIQ people. Inactive Gong users stay listed so older calls still
// resolve their speakers.
export const gongUsers = pgTable('gong_users', {
  id: text('id').primaryKey(),
  email: text('email'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  title: text('title'),
  active: boolean('active').default(true).notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.453.0 (Gong plan, phase 2): ImpactIQ's index of Gong calls, filled by
// gong_call_index. Metadata only, never transcript text, so suggestions and
// search run locally without spending Gong's daily request allowance.
export const gongCalls = pgTable('gong_calls', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id'),
  title: text('title'),
  url: text('url'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  durationS: integer('duration_s'),
  scope: text('scope'),
  isPrivate: boolean('is_private').default(false).notNull(),
  calendarEventId: text('calendar_event_id'),
  primaryUserId: text('primary_user_id'),
  // [{ name, email, affiliation, speakerId, userId, title }]
  parties: jsonb('parties').notNull().default([]),
  partyEmails: text('party_emails').array().notNull().default([]),
  partyUserIds: text('party_user_ids').array().notNull().default([]),
  // [{ system, objectType, objectId }]
  crmObjects: jsonb('crm_objects').notNull().default([]),
  crmObjectIds: text('crm_object_ids').array().notNull().default([]),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).defaultNow().notNull(),
})

// Which Gong calls an activity links to. The title/start/duration snapshot
// keeps the link readable after the call drops out of the index.
export const activityGongCalls = pgTable('activity_gong_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  gongCallId: text('gong_call_id').notNull(),
  title: text('title'),
  url: text('url'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  durationS: integer('duration_s'),
  linkMethod: text('link_method').notNull(), // manual | calendar_event | auto
  matchScore: integer('match_score'),
  linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique('activity_gong_calls_activity_call_uq').on(t.activityId, t.gongCallId)])

// v1.457.0 (Gong plan, phase 4): one AI Note per activity, written from its
// linked Gong transcript(s) and its owner's own notes when the owner clicks
// Generate. used_private_notes limits who can read it to the owner and App
// Admins.
export const activityAiNotes = pgTable('activity_ai_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
  generatedBy: uuid('generated_by').references(() => users.id, { onDelete: 'set null' }),
  providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
  model: text('model'),
  inputHash: text('input_hash'),
  gongCallIds: text('gong_call_ids').array().notNull().default([]),
  noteCount: integer('note_count').default(0).notNull(),
  usedPrivateNotes: boolean('used_private_notes').default(false).notNull(),
}, (t) => [unique('activity_ai_notes_activity_uq').on(t.activityId)])

// The items of an AI Note. to_review items are replaced by Regenerate and
// culled with the transcript cache; kept items stay.
export const activityAiNoteItems = pgTable('activity_ai_note_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  aiNoteId: uuid('ai_note_id').notNull().references(() => activityAiNotes.id, { onDelete: 'cascade' }),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  section: text('section').notNull(), // AiNoteSection
  text: text('text').notNull(),
  verdict: text('verdict'), // checked section: confirmed | not_in_notes | differs
  ownerName: text('owner_name'), // next_steps section
  meddpiccKey: text('meddpicc_key'), // meddpicc section
  // A custom (profile) section's { name, icon, color } when it was written (v1.466.0).
  sectionMeta: jsonb('section_meta'),
  citations: jsonb('citations').notNull().default([]),
  status: text('status').notNull().default('to_review'), // to_review | kept
  sortOrder: integer('sort_order').default(0).notNull(),
  fromTranscript: boolean('from_transcript').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  copiedNoteId: uuid('copied_note_id').references(() => activityNotes.id, { onDelete: 'set null' }),
})

// v1.461.0: AI Assessments (Admin → Activities & Rules → AI Assessments). A
// scored rubric a team defines and assigns to Activity Types / Subtypes. The
// home team_id is only where it was created; real team assignment is
// ai_assessment_teams (same split as keyword_rules / keyword_rule_teams).
// v1.466.0: AI Note profiles. A named set of AI Note sections (built-in keys
// plus custom sections with their own instructions) attached to AI
// Assessments; its sections are added to the owner's own for that AI Note.
export const aiNoteProfiles = pgTable('ai_note_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  iconColor: text('icon_color'),
  sections: text('sections').array().notNull().default([]),
  customSections: jsonb('custom_sections').notNull().default([]),
  // The team's Default profile (v1.471.0, at most one per team): the
  // sections of anyone who hasn't picked their own.
  isDefault: boolean('is_default').default(false).notNull(),
  // What this profile does to the default sections where its assessment
  // runs: 'add' to them or 'replace' them (never a person's own sections).
  combineMode: text('combine_mode').$type<'add' | 'replace'>().default('add').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Partial unique index ai_note_profiles_one_default_idx (migration 0184).
})

export const aiAssessments = pgTable('ai_assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  // Lucide icon name and hex color (v1.465.0); null = default clipboard icon.
  icon: text('icon'),
  iconColor: text('icon_color'),
  // AI Note profile whose sections this assessment adds (v1.466.0).
  aiNoteProfileId: uuid('ai_note_profile_id').references(() => aiNoteProfiles.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').default(true).notNull(),
  // Only an App Admin changes or deletes a locked rubric.
  isLocked: boolean('is_locked').default(false).notNull(),
  // Bumped on every rubric change; stored with each score.
  version: integer('version').default(1).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const aiAssessmentTeams = pgTable('ai_assessment_teams', {
  assessmentId: uuid('assessment_id').notNull().references(() => aiAssessments.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ name: 'ai_assessment_teams_pk', columns: [t.assessmentId, t.teamId] })])

export const aiAssessmentCriteria = pgTable('ai_assessment_criteria', {
  id: uuid('id').primaryKey().defaultRandom(),
  assessmentId: uuid('assessment_id').notNull().references(() => aiAssessments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  lookFor: text('look_for'),
  weight: integer('weight').default(10).notNull(),
  // AiAssessmentAnchors: { "1": "...", "5": "..." }, what each level means.
  anchors: jsonb('anchors').notNull().default({}),
  sortOrder: integer('sort_order').default(0).notNull(),
})

// Which rubric runs for an Activity Type (subtype_id null = every Subtype
// without its own row) on a team. Unique on (team, type, subtype, assessment)
// via a COALESCE index in migration 0178.
export const aiAssessmentAssignments = pgTable('ai_assessment_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  activityTypeId: uuid('activity_type_id').notNull().references(() => teamActivityTypes.id, { onDelete: 'cascade' }),
  subtypeId: uuid('subtype_id').references(() => teamActivityTypeSubtypes.id, { onDelete: 'cascade' }),
  assessmentId: uuid('assessment_id').notNull().references(() => aiAssessments.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.462.0: one AI Assessment score per activity and rubric, with a
// snapshot of the rubric it was scored against. Leaders only (see
// services/aiAssessments/access.ts).
export const activityAiAssessmentScores = pgTable('activity_ai_assessment_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  assessmentId: uuid('assessment_id').references(() => aiAssessments.id, { onDelete: 'set null' }),
  assessmentName: text('assessment_name').notNull(),
  assessmentVersion: integer('assessment_version').notNull(),
  zeroedScore: integer('zeroed_score').notNull(),
  observedScore: integer('observed_score'),
  notObservedCount: integer('not_observed_count').notNull(),
  criteriaCount: integer('criteria_count').notNull(),
  // AiAssessmentCriterionResult[]
  criteria: jsonb('criteria').notNull().default([]),
  gongCallIds: text('gong_call_ids').array().notNull().default([]),
  providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
  model: text('model'),
  runBy: uuid('run_by').references(() => users.id, { onDelete: 'set null' }),
  runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique('activity_ai_assessment_scores_uq').on(t.activityId, t.assessmentId)])

// v1.456.0 (Gong plan, phase 3): a call someone unlinked from an activity.
// Auto-linking skips these pairs; linking the call by hand removes the row.
export const gongLinkDismissals = pgTable('gong_link_dismissals', {
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  gongCallId: text('gong_call_id').notNull(),
  dismissedBy: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ name: 'gong_link_dismissals_pk', columns: [t.activityId, t.gongCallId] })])

// Accepted Gong webhooks, keyed by a SHA-256 of the signed token, so a replay
// is refused on every replica (routes/gongWebhook.ts). Kept for a day.
export const gongWebhookReceipts = pgTable('gong_webhook_receipts', {
  tokenHash: text('token_hash').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
})

// Transcripts fetched from Gong, kept for the admin-set cache period (1-365
// days) and culled by the housekeeping sweep. Never sent in an event webhook
// or an MCP response.
export const gongTranscriptCache = pgTable('gong_transcript_cache', {
  gongCallId: text('gong_call_id').primaryKey(),
  // [{ speakerId, topic, sentences: [{ start, end, text }] }]
  monologues: jsonb('monologues').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
})

export interface HubspotOwnerTeam {
  id: string
  name: string
  primary: boolean
}

// v1.391.0: AI providers for the AI Assistant (Admin → Integrations → AI
// Assistant, CLAUDE.md §14). Replaces the single Azure OpenAI integration
// (system_settings.integration_config_azure_openai, moved here by migration
// 0156). `secret_encrypted` is the provider's one credential (an API key, or
// the AWS secret access key for Bedrock), AES-256-GCM like every other stored
// secret. At most one row is the default (partial unique index), and only an
// active provider is ever used.
export const aiProviders = pgTable('ai_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  model: text('model').notNull(),
  secretEncrypted: text('secret_encrypted'),
  endpoint: text('endpoint'),
  apiVersion: text('api_version'),
  allowedCustomHost: text('allowed_custom_host'),
  region: text('region'),
  accessKeyId: text('access_key_id'),
  resource: text('resource'),
  organization: text('organization'),
  // Webhook providers only: the URL may be a private-network address
  // (v1.426.0). Loopback and link-local stay blocked.
  allowPrivateNetwork: boolean('allow_private_network').default(false).notNull(),
  // USD per million tokens; null uses the built-in price for the model, if any.
  inputPricePerMTok: decimal('input_price_per_mtok', { precision: 10, scale: 4 }),
  outputPricePerMTok: decimal('output_price_per_mtok', { precision: 10, scale: 4 }),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestOk: boolean('last_test_ok'),
  lastTestMessage: text('last_test_message'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Which provider a feature uses. No row (or an inactive provider) means the
// default provider.
export const aiFeatureRoutes = pgTable('ai_feature_routes', {
  feature: text('feature').primaryKey(),
  providerId: uuid('provider_id').notNull().references(() => aiProviders.id, { onDelete: 'cascade' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// One row per AI call: usage, estimated cost and a hash of the input, never
// the input itself. Feeds the monthly budget and the usage table.
export const aiRequests = pgTable('ai_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  feature: text('feature').notNull(),
  providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
  providerKind: text('provider_kind'),
  providerName: text('provider_name'),
  model: text('model'),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  // v1.457.0: the team a call was made for (AI Notes), so a team's monthly
  // spend can be summed. Null for calls that aren't charged to a team.
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  inputHash: text('input_hash'),
  // v1.473.0: how many items one request covered (batched calendar
  // suggestions). Null = one.
  itemCount: integer('item_count'),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  costUsd: decimal('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Calendar-event classifications already answered, so the same meeting isn't
// sent to the AI again on every sync. The hash covers the provider, model,
// the team's active activity types and the event text, so changing any of
// them asks again. A null activity type caches "no type fits".
export const aiClassificationCache = pgTable('ai_classification_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  inputHash: text('input_hash').notNull(),
  providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'cascade' }),
  activityTypeId: uuid('activity_type_id').references(() => teamActivityTypes.id, { onDelete: 'cascade' }),
  confidence: decimal('confidence', { precision: 4, scale: 3 }),
  hitCount: integer('hit_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique('ai_classification_cache_team_hash').on(t.teamId, t.inputHash)])

// v1.427.0: outbound event webhooks (Admin → Integrations → Event Webhooks,
// docs/event-webhooks.md). Each row is one subscriber URL: which event types
// it gets, optionally only for some teams, signed with its own secret.
export const eventWebhooks = pgTable('event_webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secretEncrypted: text('secret_encrypted').notNull(),
  events: text('events').array().notNull(),
  // Empty = every team. Events with no team (job.failed) go only to a
  // webhook with no team filter.
  teamIds: uuid('team_ids').array().notNull().default([]),
  // Empty = everyone. Events not about one person (job failures, the AI
  // budget, a team's anomalies) ignore it.
  userIds: uuid('user_ids').array().notNull().default([]),
  allowPrivateNetwork: boolean('allow_private_network').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// One row per event per subscribed webhook, worked by the
// event_webhook_worker job with retries. `event_id` is the same for every
// webhook that got the event, so a receiver can de-duplicate.
export const eventWebhookDeliveries = pgTable('event_webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  webhookId: uuid('webhook_id').notNull().references(() => eventWebhooks.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  // pending | delivered | failed
  status: text('status').default('pending').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Which (team, week) the anomaly_webhook_scan job has already checked, so a
// team's anomaly.found event goes out at most once per completed week.
export const eventWebhookAnomalyScans = pgTable('event_webhook_anomaly_scans', {
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  weekStart: date('week_start').notNull(),
  findings: integer('findings').notNull(),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.teamId, t.weekStart] })])

export const userNotificationPrefs = pgTable('user_notification_prefs', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  emailEnabled: boolean('email_enabled').default(true).notNull(),
  emailTransport: text('email_transport').default('graph').notNull(),
  timezone: text('timezone').default('UTC').notNull(),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  weeklyRecapEnabled: boolean('weekly_recap_enabled').default(true).notNull(),
  lastWeeklyRecapAt: timestamp('last_weekly_recap_at', { withTimezone: true }),
  // v1.433.0: the user's own switch for Slack DMs (nudges and announcements).
  slackDmEnabled: boolean('slack_dm_enabled').default(true).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const dashboardPresets = pgTable('dashboard_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  filters: jsonb('filters').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniquePerUser: unique().on(t.userId, t.name),
}))

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  link: text('link'),
  isRead: boolean('is_read').default(false).notNull(),
  dedupeKey: text('dedupe_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // v1.62.0: propagated from nudge_rules so the bell card can render an
  // icon + colored border without a second query.
  severity: text('severity').notNull().default('info'),
  icon: text('icon'),
  // vNext: light/dark icon colors for kind='announcement' rows only — see
  // announcements.iconColorLight/iconColorDark. Populated exclusively by
  // syncAnnouncementNotifications(); left null for every other kind
  // (nudges use icon alone, with no color override).
  iconColorLight: text('icon_color_light'),
  iconColorDark: text('icon_color_dark'),
})

export const oktaGroupRoleMappings = pgTable('okta_group_role_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  oktaGroup: text('okta_group').notNull(),
  role: roleEnum('role').notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const rolePermissions = pgTable(
  'role_permissions',
  {
    role: roleEnum('role').notNull(),
    pageKey: text('page_key').notNull(),
    hasAccess: boolean('has_access').default(false).notNull(),
  },
  (t) => [primaryKey({ columns: [t.role, t.pageKey] })],
)

// --- Holiday calendars (assignable to users; days on the calendar are excluded from capacity math) ---
export const holidayCalendars = pgTable('holiday_calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  locale: text('locale').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const holidayDates = pgTable('holiday_dates', {
  id: uuid('id').primaryKey().defaultRandom(),
  calendarId: uuid('calendar_id').notNull().references(() => holidayCalendars.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  name: text('name').notNull(),
}, (t) => [unique().on(t.calendarId, t.date)])

export const userHolidayCalendars = pgTable('user_holiday_calendars', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  calendarId: uuid('calendar_id').notNull().references(() => holidayCalendars.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.userId, t.calendarId] })])

// --- Per-user PTO days (excluded from that user's weekly capacity) ---
export const userPtoDays = pgTable('user_pto_days', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.date] })])

// --- Team → holiday calendar assignments (up to 3 per team; user picks take precedence) ---
export const teamHolidayCalendars = pgTable('team_holiday_calendars', {
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  calendarId: uuid('calendar_id').notNull().references(() => holidayCalendars.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.teamId, t.calendarId] })])

// --- Products (app-owned, no SF link) ---
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  space: text('space'),
  abbreviation: text('abbreviation'),
  isActive: boolean('is_active').default(true).notNull(),
  // v1.93.0: PNG/SVG/BMP up to ~1MB decoded, stored as a data URL so
  // product pills across the app can render "icon + label".
  iconDataUrl: text('icon_data_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const productTeams = pgTable('product_teams', {
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.productId, t.teamId] })])

export const activityProducts = pgTable('activity_products', {
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.activityId, t.productId] })])

// --- Audit log ---
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorEmail: text('actor_email'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  meta: jsonb('meta'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Personal API keys ---
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keySalt: text('key_salt').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // v1.145.0: scoped API keys. `rest:full` = legacy full-access; MCP keys
  // carry `mcp:read` (and later `mcp:write`). Existing keys default to
  // rest:full via migration 0089 so nothing breaks.
  scopes: text('scopes').array().notNull().default(['rest:full']),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.145.0: per-MCP-call audit trail. args_hash is a SHA-256 of the JSON
// args — never the raw args — so PII stays out. Retained 30 days.
export const mcpToolCalls = pgTable('mcp_tool_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  tool: text('tool').notNull(),
  argsHash: text('args_hash'),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  calledAt: timestamp('called_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Activity templates ---
export const activityTemplates = pgTable('activity_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  activityTypeId: uuid('activity_type_id').references(() => teamActivityTypes.id, { onDelete: 'set null' }),
  // v1.256.0: pre-fills the Log Activity form's Subtype picker when this
  // template is applied. Same denormalized-name convention as
  // activities.subtype_name above.
  subtypeId: uuid('subtype_id').references(() => teamActivityTypeSubtypes.id, { onDelete: 'set null' }),
  subtypeName: text('subtype_name'),
  titleTemplate: text('title_template').notNull(),
  notesTemplate: text('notes_template'),
  effortHoursDefault: decimal('effort_hours_default', { precision: 4, scale: 2 }),
  locationModeDefault: text('location_mode_default'),
  productIds: jsonb('product_ids'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Salesforce Users cache + alignment (Sales Team Breakdown) ---
export const crmUsers = pgTable('crm_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  managerId: text('manager_id'),
  title: text('title'),
  isActive: boolean('is_active').default(true).notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).defaultNow().notNull(),
})

export const crmUserAlignments = pgTable('crm_user_alignments', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  crmUserId: text('crm_user_id').notNull().references(() => crmUsers.id, { onDelete: 'cascade' }),
  role: crmAlignmentRoleEnum('role').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.crmUserId, t.role] })])

// --- SF object → owner cache ---
// Local mirror of Opportunity/Account → OwnerId + parent Account for the
// Sales Team Breakdown dashboard. Populated by demo mode (so demo opps
// resolve without a live SF call) and, in the future, by a background SF
// sync. The dashboard endpoint checks this table before issuing SOQL.
export const sfObjectOwnerCache = pgTable('sf_object_owner_cache', {
  sfId: text('sf_id').primaryKey(),
  objectType: text('object_type').notNull(), // 'Opportunity' | 'Account'
  name: text('name'),
  accountId: text('account_id'),
  accountName: text('account_name'),
  ownerId: text('owner_id'),
  ownerName: text('owner_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Server-side sessions ---
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // password | okta | totp | backup_code — how this session was minted.
  mfaMethod: text('mfa_method'),
})

// --- Suspicious-login detection audit trail ---
export const loginEvents = pgTable('login_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  // userId is nullable so failed logins for unknown emails can still be
  // recorded (audit trail for brute-force attempts).
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  // Email typed by the caller, kept even when userId is null so the admin
  // sees what account was being tried.
  attemptedEmail: text('attempted_email'),
  success: boolean('success').default(true).notNull(),
  // Free-text failure reason when success = false (invalid_password,
  // mfa_required_no_code, unknown_user, etc.).
  failureReason: text('failure_reason'),
  method: text('method').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  isSuspicious: boolean('is_suspicious').default(false).notNull(),
  alertSentAt: timestamp('alert_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.440.0: one row per outbound email the app tried to send through the
// admin-configured transport (SMTP or Graph App-Only), so App Health can show
// when email stops going out. Never holds the body. `category` is the email
// rule key, or 'daily_digest' / 'weekly_recap' / 'test' for the senders that
// aren't rules. Culled by sync_audit_cull (EMAIL_DELIVERIES_RETENTION_DAYS).
export const emailDeliveries = pgTable('email_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(),
  recipient: text('recipient').notNull(),
  subject: text('subject').notNull(),
  transport: text('transport').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.444.0: last successful and failed call per integration, recorded from the
// app's own calls (recordIntegrationCall, services/health/integrationStatus.ts)
// for App Health's Integrations tile. One row per integration key.
export const integrationStatus = pgTable('integration_status', {
  integration: text('integration').primaryKey(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Work-Week change requests queue. When a contributor edits their work-week
// on Settings, we create a pending request instead of mutating `users`
// directly; an app admin approves or rejects it from User Management.
export const workWeekChangeRequests = pgTable('work_week_change_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  beforeSnapshot: jsonb('before_snapshot').notNull(),
  afterSnapshot: jsonb('after_snapshot').notNull(),
  status: text('status').default('pending').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  notes: text('notes'),
})

// Timestamped notes stream per activity. Rolled up to Opportunity /
// Account at read time via joins on activities.sf_what_*.
export const activityNotes = pgTable('activity_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Per-note MEDDPICC tags, shape { metrics: [...], champion: [...], … }.
  meddpicc: jsonb('meddpicc').notNull().default({}),
  // v1.127.0: private note — visible only to the creator and App
  // Admins. Team Admins / Team Leaders / peers on the team CANNOT
  // see private notes. Default false so existing notes stay shared.
  isPrivate: boolean('is_private').default(false).notNull(),
})

// Audit log of notes pushed to Salesforce as ContentNote records. One
// row per push target (a single note can be pushed to both an
// Opportunity and its Account — two rows). Kept out of activity_notes
// so re-editing a note doesn't reset the audit trail.
export const activityNotePushes = pgTable('activity_note_pushes', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityNoteId: uuid('activity_note_id').notNull().references(() => activityNotes.id, { onDelete: 'cascade' }),
  pushedBy: uuid('pushed_by').references(() => users.id, { onDelete: 'set null' }),
  crmTargetType: text('crm_target_type').notNull(),
  crmTargetId: text('crm_target_id').notNull(),
  crmTargetName: text('crm_target_name'),
  crmContentNoteId: text('crm_content_note_id'),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

// v1.113.0: Email Communications registry. Each outbound email code
// path checks this table before dispatching; admins can disable a
// rule from Admin → Integrations → Email Communications.
export const emailRules = pgTable("email_rules", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  subjectTemplate: text("subject_template"),
  bodyTemplate: text("body_template"),
  // v1.436.0: also DM the recipient on Slack (only rules in
  // SLACK_DM_EMAIL_RULES, src/shared/emailRuleSlack.ts).
  sendSlack: boolean("send_slack").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})


// v1.116.0: one-shot password-reset tokens. Token itself is never
// stored — only sha256(token). Rows are considered spent once
// used_at is set; 60-minute expiry from creation.
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  ip: text('ip'),
  userAgent: text('user_agent'),
})

// v1.137.0: refresh-state and Lead→Account cache tables used by
// refreshOppSnapshots() to keep activities.salesStage / forecastCategory
// fresh against SF, and to roll up Lead-linked activity cost under the
// Account it converted to.
export const crmSnapshotState = pgTable('crm_snapshot_state', {
  key: text('key').primaryKey(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
  lastError: text('last_error'),
})

export const crmLeadAccountLink = pgTable('crm_lead_account_link', {
  leadId: text('lead_id').primaryKey(),
  accountId: text('account_id'),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).defaultNow().notNull(),
})

// v1.138.0: rolling log of background job runs, surfaced by the new
// Admin → Monitoring → Scheduling page. Each successful or failed
// invocation of a cron/interval worker writes one row here so admins can
// spot silent regressions (e.g. digest worker throwing since last deploy).
export const jobRuns = pgTable('job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobKey: text('job_key').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  status: text('status').notNull(),
  message: text('message'),
  detail: jsonb('detail'),
})

// v1.141.0: per-job admin config. When notifyOnError is on, the job's
// runner sends a summary email to app admins on failure — deduped to at
// most one email per job per day via lastErrorEmailAt.
//
// v1.227.0: enabled + intervalMs — see src/server/services/jobs/scheduler.ts.
// A missing row (or enabled=null-equivalent default true) behaves exactly
// like today: every job runs, on its hardcoded default interval. intervalMs
// is only honored for jobs the Scheduling admin page marks
// `cadenceEditable: true` — the two time-of-day-gated jobs (digest,
// weekly-recap) and the manually-triggered historical backfill ignore it.
export const jobConfig = pgTable('job_config', {
  jobKey: text('job_key').primaryKey(),
  notifyOnError: boolean('notify_on_error').default(false).notNull(),
  lastErrorEmailAt: timestamp('last_error_email_at', { withTimezone: true }),
  enabled: boolean('enabled').default(true).notNull(),
  intervalMs: integer('interval_ms'),
  // v1.230.0: local send-time override for the two clock-gated jobs
  // (digest_worker, weekly_recap_worker) — see CLAUDE.md §14. Null means
  // "use the hardcoded default" (digest: 08:00; weekly recap: Friday
  // 17:00), same fallback contract as intervalMs. scheduleDayOfWeek is
  // Sunday-indexed (0=Sun…6=Sat), matching Date#getDay(), and is only
  // consulted by weekly_recap_worker.
  scheduleHour: integer('schedule_hour'),
  scheduleMinute: integer('schedule_minute'),
  scheduleDayOfWeek: integer('schedule_day_of_week'),
})

// v1.249.0: Flight Deck — a login welcome modal with a team-configurable
// onboarding checklist (see CLAUDE.md §14, Workplace admin category).
// Team-scoped like every other admin ruleset in this app.
export const flightDeckLinkTypeEnum = pgEnum('flight_deck_link_type', ['app_page', 'external_url'])

export const flightDeckItems = pgTable('flight_deck_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tooltip: text('tooltip'),
  icon: text('icon').notNull(),
  // v1.250.0: optional hex color tint for the icon, same convention as
  // team_activity_types.color — a plain text hex string, no enum.
  iconColor: text('icon_color'),
  // v1.250.0: optional screenshots shown as thumbnails on the checklist item,
  // click to expand. Stored as data-URI strings (same approach as app_themes
  // logo upload) — no separate file storage/bucket to stand up for this.
  screenshots: text('screenshots').array(),
  linkType: flightDeckLinkTypeEnum('link_type').notNull(),
  linkValue: text('link_value').notNull(),
  // Seeded default items are ordinary rows — an admin can edit, reorder,
  // deactivate, or delete them exactly like a custom item. This flag only
  // drives a "Default" badge in the admin list, never an edit restriction.
  isPreset: boolean('is_preset').default(false).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').default(true).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Per-locale translations for a Flight Deck item's label/tooltip — same
// shape and fallback contract as nudge_rule_translations (see that table):
// admin adds one row per language on top of the base item text, which stays
// as the fallback. Server resolves to the viewer's active locale; if
// missing, falls back to the base flight_deck_items row.
export const flightDeckItemTranslations = pgTable('flight_deck_item_translations', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull().references(() => flightDeckItems.id, { onDelete: 'cascade' }),
  locale: text('locale').notNull(),
  label: text('label').notNull(),
  tooltip: text('tooltip'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.itemId, t.locale)])

// Per-user, per-item completion state. Persists across logins even as an
// admin adds new items later — checking off item #3 today doesn't get lost
// when item #4 is added next month. Deleting the parent item cascades.
export const flightDeckCompletions = pgTable('flight_deck_completions', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  itemId: uuid('item_id').notNull().references(() => flightDeckItems.id, { onDelete: 'cascade' }),
  completedAt: timestamp('completed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.itemId] })])

// Announcements — Admin/Team Admin/Leader broadcasts a message to a team, a
// subteam, or a specific user, shown in the top-header banner and the
// notification bell. Exactly one of subteamId/targetUserId is set, matching
// targetType — enforced in the admin route (Zod refine), not a DB CHECK
// constraint, same convention keyword_rules.action='mark_non_activity'
// already uses for its own conditional-NULL invariant (see keywordRules
// below). teamId is always required — the "home"/creating-context team,
// same convention nudge_rules.team_id and capacity_user_overrides.team_id
// already use, even when the actual target is a subteam or a single user.
export const announcementTargetTypeEnum = pgEnum('announcement_target_type', ['team', 'subteam', 'user'])

export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  targetType: announcementTargetTypeEnum('target_type').notNull(),
  subteamId: uuid('subteam_id').references(() => subteams.id, { onDelete: 'cascade' }),
  targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),
  // Plain text + default, NOT a pgEnum — matches notifications.severity's
  // exact existing convention so the bell and the header banner can share
  // one severity->color/icon styling map with no translation layer.
  severity: text('severity').notNull().default('info'),
  // Optional custom icon for the top-header banner ONLY (never the bell or
  // the bottom toast, which always use the plain severity icon) — a lucide
  // icon name, same IconPicker/DynamicIcon convention as
  // flight_deck_items.icon. iconColorLight/iconColorDark are separate hex
  // values (not one value assumed to work in both themes, unlike
  // flight_deck_items.iconColor) because an icon color chosen in light mode
  // frequently reads poorly against a dark banner and vice versa. All three
  // null = fall back to the plain severity icon/color, unchanged.
  icon: text('icon'),
  iconColorLight: text('icon_color_light'),
  iconColorDark: text('icon_color_dark'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  // Reappears at each viewer's own local midnight until endDate. When
  // false, a single dismiss suppresses it forever for that viewer — see
  // services/announcements/engine.ts for the exact read-time semantics.
  recurringDaily: boolean('recurring_daily').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  // v1.433.0: also send to Slack once, when the announcement first becomes
  // active (services/slack/announcements.ts). slackSentAt is the claim that
  // makes it send-once; editing the message afterwards doesn't resend.
  sendSlack: boolean('send_slack').notNull().default(false),
  slackSentAt: timestamp('slack_sent_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// One row per (user, announcement) — an UPSERT target, not an insert-many
// table like nudge_dismissals. There is only ever ONE piece of state per
// viewer per announcement ("the local calendar day I last dismissed this"),
// and whether that suppresses it for just that day or forever is entirely
// determined by announcements.recurringDaily at READ time (see engine.ts) —
// so flipping that flag later immediately changes behavior for every
// existing dismissal with no data migration needed.
export const announcementDismissals = pgTable('announcement_dismissals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  announcementId: uuid('announcement_id').notNull().references(() => announcements.id, { onDelete: 'cascade' }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow().notNull(),
  // YYYY-MM-DD in the viewer's OWN timezone at dismiss time (via the shared
  // localDayKeyFor() helper in src/server/lib/localDate.ts) — not a UTC
  // expiresAt timestamp, so "tomorrow" means the viewer's own local
  // tomorrow, not a fixed UTC cutoff.
  dismissedLocalDate: text('dismissed_local_date').notNull(),
}, (t) => [unique().on(t.userId, t.announcementId)])
