import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.js'
import * as schema from '../../../../drizzle/schema.js'
import { DEFAULT_ACTIVITY_TYPE_STYLES } from '../../../shared/defaultActivityTypeStyles.js'
import { LEGACY_EVAL_WORK_NAME, evalTermLabel, evalWorkTypeName } from '../../../shared/terminology.js'
import { getTerminology } from '../config/terminology.js'

// The lists below name the evaluation type by its original "Eval Work"; a new
// team gets the install's own name from Admin → Workplace → Terminology
// ("POx Work" by default), resolved in applyDefaultTeamConfig.

const DEFAULT_ACTIVITY_TYPES = [
  { name: 'Demo', sortOrder: 1 },
  { name: 'Discovery', sortOrder: 2 },
  { name: 'Enablement', sortOrder: 3 },
  { name: 'Eval Work', sortOrder: 4 },
  { name: 'Executive Briefing', sortOrder: 5 },
  { name: 'HealthCheck', sortOrder: 6 },
  { name: 'Marketing', sortOrder: 7 },
  { name: 'Meeting', sortOrder: 8 },
  { name: 'RFx Work', sortOrder: 9 },
  { name: 'Support', sortOrder: 10 },
] as const

// App-side field names are aligned with the SF API names so the mapping reads
// consistently. The DB column may have a different physical name (e.g. notes
// → Description) but the mapping uses the SF-style name for clarity.
interface DefaultMapping { appField: string; crmFieldApi: string; constantValue?: string }
const DEFAULT_SF_FIELD_MAPPINGS: DefaultMapping[] = [
  { appField: 'title', crmFieldApi: 'Subject' },
  { appField: 'activity_type', crmFieldApi: 'Type' },
  { appField: 'startdatetime', crmFieldApi: 'StartDateTime' },
  { appField: 'enddatetime', crmFieldApi: 'EndDateTime' },
  { appField: 'effort_hours', crmFieldApi: 'DurationInMinutes' },
  { appField: 'description', crmFieldApi: 'Description' },
  { appField: 'location', crmFieldApi: 'Location' },
  { appField: 'crm_what_id', crmFieldApi: 'WhatId' },
  { appField: 'user_id', crmFieldApi: 'OwnerId' },
  { appField: 'created_date__c', crmFieldApi: 'Created_Date__c' },
  { appField: 'assigned_to_name__c', crmFieldApi: 'Assigned_To_Name__c' },
  { appField: 'account_name__c', crmFieldApi: 'Account_Name__c' },
  { appField: 'account_owner', crmFieldApi: 'Account_Owner' },
  { appField: 'account_owner_manager', crmFieldApi: 'Account_Owner_Manager' },
  { appField: 'acv', crmFieldApi: 'Total_Acv__c' },
  // Constants — the writeback forces the literal value regardless of appField.
  { appField: '_constant', crmFieldApi: 'Activity_Status__c', constantValue: 'Completed' },
  { appField: '_constant', crmFieldApi: 'ShowAs', constantValue: 'Busy' },
]

const DEFAULT_SF_PICKLIST_ACTIVE = [
  'Marketing', 'Discovery', 'Demo', 'Enablement', 'RFx Work',
  'HealthCheck', 'Executive Briefing', 'Support', 'Eval Work',
]

const DEFAULT_NUDGE_RULES = [
  {
    name: 'No Activity Days',
    triggerType: 'no_activity_days' as const,
    triggerConfig: { days: 5 },
    messageTemplate: 'Nothing logged this week yet — catch up before Friday?',
  },
  {
    name: 'Stage No Type',
    triggerType: 'stage_no_type' as const,
    triggerConfig: { stage: 'Eval', type: 'Eval Work', days: 14 },
    messageTemplate: 'No Eval Work logged for {opp_name} in {days_overdue} days — anything to capture?',
  },
  {
    name: 'Type No Followup',
    triggerType: 'type_no_followup' as const,
    triggerConfig: { fromType: 'Discovery', toType: 'Demo', days: 21 },
    messageTemplate: 'You logged a Discovery for {account_name} {days_overdue} days ago — did a Demo follow?',
  },
]

const DEFAULT_KEYWORD_RULES_BY_TYPE: Record<string, string[]> = {
  'Demo': ['demo', 'demonstration', 'product demo'],
  'Discovery': ['discovery', 'disco', 'needs assessment'],
  'Enablement': ['enablement', 'training', 'workshop'],
  'Eval Work': ['eval', 'evaluation', 'poc', 'proof of concept', 'trial'],
  'Executive Briefing': ['executive briefing', 'ebr', 'exec briefing', 'c-level'],
  'HealthCheck': ['healthcheck', 'health check', 'qbr', 'quarterly business review'],
  'Marketing': ['marketing', 'webinar', 'conference', 'trade show'],
  'RFx Work': ['rfp', 'rfq', 'rfi', 'rfx', 'proposal', 'bid'],
  'Support': ['support', 'troubleshoot', 'issue', 'break fix'],
}

// v1.249.0/v1.251.0: same default Flight Deck checklist items seed.ts inserts
// for the very first team on a fresh install (CLAUDE.md §14, Workplace admin
// category) — duplicated in seed.ts rather than shared (matching how every
// other default list above — activity types, nudge rules, keyword rules — is
// already independently maintained in both files), but exported here so
// admin.ts's "Add Default Items" endpoint (the on-demand fix for a team that
// never got these, e.g. because it existed before Flight Deck shipped) reads
// from this single copy instead of a third one.
export const DEFAULT_FLIGHT_DECK_ITEMS = [
  {
    label: 'Complete your profile',
    tooltip: 'Set your name, timezone, and work hours so your capacity numbers are accurate.',
    icon: 'Users',
    linkType: 'app_page' as const,
    linkValue: '/settings',
    sortOrder: 1,
  },
  {
    label: 'Connect your Salesforce account',
    tooltip: 'Link Salesforce so you can attach activities to Opportunities and Accounts.',
    icon: 'Handshake',
    linkType: 'app_page' as const,
    linkValue: '/settings',
    sortOrder: 2,
  },
  {
    label: 'Connect your Outlook account',
    tooltip: 'Link Outlook so your calendar events show up for logging activities.',
    icon: 'CalendarDays',
    linkType: 'app_page' as const,
    linkValue: '/settings',
    sortOrder: 3,
  },
  {
    label: 'Log your first activity',
    tooltip: 'Capture a Demo, Discovery, or meeting from your week.',
    icon: 'Calendar',
    linkType: 'app_page' as const,
    linkValue: '/',
    sortOrder: 4,
  },
  {
    label: 'Explore your dashboard',
    tooltip: "See your team's capacity, activity mix, and account coverage.",
    icon: 'LayoutDashboard',
    linkType: 'app_page' as const,
    linkValue: '/dashboard',
    sortOrder: 5,
  },
]

// Seeds activity types, SF field mappings, SF picklist values, nudge rules, keyword rules,
// and the Flight Deck checklist for a freshly created team. Safe to call once per team —
// does not check for existing rows.
export async function applyDefaultTeamConfig(db: Db, teamId: string): Promise<void> {
  const terminology = await getTerminology(db)
  const evalWork = evalWorkTypeName(terminology)
  const nameOf = (name: string) => (name === LEGACY_EVAL_WORK_NAME ? evalWork : name)
  // After a Terminology rename the existing evaluation types keep writing the
  // CRM's old picklist value (their override); a new team follows them, so
  // its write-back sends a value the CRM picklist actually has.
  const [existingEval] = await db.select({ value: schema.teamActivityTypes.crmPicklistValue })
    .from(schema.teamActivityTypes)
    .where(and(eq(schema.teamActivityTypes.name, evalWork), sql`coalesce(trim(${schema.teamActivityTypes.crmPicklistValue}), '') <> ''`))
    .limit(1)
  const evalPicklistValue = existingEval?.value?.trim() || null
  const picklistOf = (name: string) => (name === LEGACY_EVAL_WORK_NAME ? (evalPicklistValue ?? evalWork) : name)
  const insertedTypes = await db
    .insert(schema.teamActivityTypes)
    .values(
      DEFAULT_ACTIVITY_TYPES.map((t) => ({
        teamId,
        name: nameOf(t.name),
        crmObjectType: 'Event' as const,
        crmPicklistValue: t.name === LEGACY_EVAL_WORK_NAME ? evalPicklistValue : null,
        sortOrder: t.sortOrder,
        icon: DEFAULT_ACTIVITY_TYPE_STYLES[t.name]?.icon ?? null,
        color: DEFAULT_ACTIVITY_TYPE_STYLES[t.name]?.color ?? null,
      })),
    )
    .returning()

  const insertedMappings = await db.insert(schema.crmFieldMappings).values(
    DEFAULT_SF_FIELD_MAPPINGS.map((m) => ({
      teamId,
      appField: m.appField,
      crmFieldApi: m.crmFieldApi,
      crmObject: 'Event' as const,
      constantValue: m.constantValue ?? null,
    })),
  ).returning()

  if (insertedMappings.length > 0) {
    await db.insert(schema.crmFieldMappingTeams).values(
      insertedMappings.map((m) => ({ crmFieldMappingId: m.id, teamId })),
    )
  }

  const picklistRows = [
    ...DEFAULT_SF_PICKLIST_ACTIVE.map((v) => ({ teamId, sfPicklistValue: picklistOf(v), isActive: true })),
    { teamId, sfPicklistValue: 'Meeting', isActive: false, fallbackValue: null as string | null },
  ]
  await db.insert(schema.sfEventTypeConfig).values(picklistRows)

  // Assign all newly created activity types to this team via junction table.
  await db.insert(schema.activityTypeTeams).values(
    insertedTypes.map((t) => ({ activityTypeId: t.id, teamId })),
  )

  const insertedNudgeRules = await db.insert(schema.nudgeRules).values(
    DEFAULT_NUDGE_RULES.map((r) => ({
      teamId,
      name: r.name,
      triggerType: r.triggerType,
      triggerConfig: 'type' in r.triggerConfig ? { ...r.triggerConfig, type: nameOf(r.triggerConfig.type) } : r.triggerConfig,
      messageTemplate: r.messageTemplate.replace(LEGACY_EVAL_WORK_NAME, evalWork),
    })),
  ).returning()

  // Assign nudge rules to this team.
  if (insertedNudgeRules.length > 0) {
    await db.insert(schema.nudgeRuleTeams).values(
      insertedNudgeRules.map((r) => ({ nudgeRuleId: r.id, teamId })),
    )
  }

  const typesByName = Object.fromEntries(insertedTypes.map((t) => [t.name, t.id]))
  // The org's own word for an evaluation is a keyword too ("pox", "pov"),
  // except "project", which would match far too many meetings.
  const termKeyword = evalTermLabel(terminology).toLowerCase()
  const keywordRows = Object.entries(DEFAULT_KEYWORD_RULES_BY_TYPE)
    .map(([typeName, baseKeywords]) => {
      const activityTypeId = typesByName[nameOf(typeName)]
      const keywords = typeName === LEGACY_EVAL_WORK_NAME && terminology.evalTerm !== 'project' && !baseKeywords.includes(termKeyword)
        ? [...baseKeywords, termKeyword]
        : baseKeywords
      if (!activityTypeId) return null
      return {
        teamId,
        keywords,
        activityTypeId,
        matchField: 'both' as const,
        priority: 10,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (keywordRows.length > 0) {
    const insertedKeywordRules = await db.insert(schema.keywordRules).values(keywordRows).returning()
    // Assign keyword rules to this team.
    await db.insert(schema.keywordRuleTeams).values(
      insertedKeywordRules.map((r) => ({ keywordRuleId: r.id, teamId })),
    )
  }

  await db.insert(schema.flightDeckItems).values(
    DEFAULT_FLIGHT_DECK_ITEMS.map((i) => ({
      teamId,
      label: i.label,
      tooltip: i.tooltip,
      icon: i.icon,
      linkType: i.linkType,
      linkValue: i.linkValue,
      isPreset: true,
      sortOrder: i.sortOrder,
    })),
  )
}
