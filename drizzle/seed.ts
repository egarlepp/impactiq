import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'
import { localDatabaseUrl } from './localDbUrl.js'
import { eq } from 'drizzle-orm'
import { DEFAULT_ACTIVITY_TYPE_STYLES } from '../src/shared/defaultActivityTypeStyles.js'
import { DEFAULT_TERMINOLOGY, defaultTypeKey, evalWorkTypeName, normalizeTerminology } from '../src/shared/terminology.js'
import { defaultGuideDistinctions } from '../src/server/services/teams/defaultGuideContent.js'

export async function runSeed() {
  const connectionString = process.env['DATABASE_URL'] ?? localDatabaseUrl()
  const client = postgres(connectionString)
  const db = drizzle(client, { schema })

  console.log('Seeding database...')

  // v1.446.0: the evaluation Activity Type is named from Admin → Workplace →
  // Terminology; a fresh install has no setting yet, so "POx Work".
  const [termRow] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, 'terminology')).limit(1)
  const evalWork = evalWorkTypeName(normalizeTerminology(termRow?.value ?? DEFAULT_TERMINOLOGY))

  const [team] = await db
    .insert(schema.teams)
    .values({
      name: 'Solutions Engineering',
      slug: 'solutions-engineering',
      description: 'Strategic function that aligns technical proof with business objectives to de-risk software investments and accelerate time-to-value.',
      // v1.255.0: Guide page "Distinctions" section — see migration 0128 for
      // the matching content on existing deployments upgrading in place.
      guideDistinctions: defaultGuideDistinctions(evalWork),
    })
    .returning()

  if (!team) throw new Error('Failed to create team')

  // v1.255.0: Guide fields (useThisWhen / usuallyAttachTo / examples) — see
  // migration 0128 for the matching content seeded on existing deployments.
  // Meeting and None are intentionally left blank (no card on the Guide page).
  const activityTypeValues = [
    {
      name: 'Demo', crmObjectType: 'Event' as const, sortOrder: 1,
      useThisWhen: "You're showing product capabilities to address a customer's stated or anticipated requirements.",
      usuallyAttachTo: 'Opportunity',
      examples: 'Product demo, use-case demo, architecture walkthrough with product, custom demo',
    },
    {
      name: 'Discovery', crmObjectType: 'Event' as const, sortOrder: 2,
      useThisWhen: "You're learning about the customer's environment, requirements, problems, priorities, or technical fit.",
      usuallyAttachTo: 'Opportunity if it exists; otherwise Account',
      examples: 'Technical discovery call, architecture discussion, requirements gathering, qualification call',
    },
    {
      name: 'Enablement', crmObjectType: 'Event' as const, sortOrder: 3,
      useThisWhen: "You're teaching someone how to use, configure, position, or understand the product rather than actively proving it for a sale.",
      usuallyAttachTo: 'Account or Opportunity, depending on context',
      examples: 'Customer training, admin walkthrough, "how do I...?", simple configuration assistance, partner enablement',
    },
    {
      name: evalWork, crmObjectType: 'Event' as const, sortOrder: 4,
      useThisWhen: "You're doing hands-on technical work required to execute an evaluation.",
      usuallyAttachTo: 'Opportunity + Evaluation record',
      examples: 'POC setup, trial configuration, workshop, CloudLAB, Assessment, installation, success-criteria testing',
    },
    {
      name: 'Executive Briefing', crmObjectType: 'Event' as const, sortOrder: 5,
      useThisWhen: "You're participating in a strategic, executive-level customer conversation focused on business priorities, security strategy, transformation initiatives, risk, outcomes, or partnership direction rather than detailed product evaluation or technical discovery.",
      usuallyAttachTo: 'Opportunity if tied to an active deal; otherwise Account.',
      examples: 'Executive briefing, CISO/CIO meeting, strategic roadmap discussion, executive sponsor meeting, business-value discussion, transformation planning, customer executive workshop.',
    },
    {
      name: 'HealthCheck', crmObjectType: 'Event' as const, sortOrder: 6,
      useThisWhen: "You're proactively reviewing an existing customer environment to assess configuration, adoption, architecture, or product health.",
      usuallyAttachTo: 'Account',
      examples: 'Deployment review, configuration assessment, adoption review, optimization session',
    },
    {
      name: 'Marketing', crmObjectType: 'Event' as const, sortOrder: 7,
      useThisWhen: "You're supporting a marketing-led activity rather than working a specific sales opportunity.",
      usuallyAttachTo: 'Marketing Campaign',
      examples: 'Webinar, trade show booth, conference session, roadshow, customer event',
    },
    { name: 'Meeting', crmObjectType: 'Event' as const, sortOrder: 8 },
    {
      name: 'RFx Work', crmObjectType: 'Event' as const, sortOrder: 9,
      useThisWhen: "You're responding to a formal or semi-formal customer requirements document.",
      usuallyAttachTo: 'Opportunity; one activity per RFx request',
      examples: 'RFP, RFI, security questionnaire, technical questionnaire, requirements matrix',
    },
    {
      name: 'Support', crmObjectType: 'Event' as const, sortOrder: 10,
      useThisWhen: "You've become involved in a customer issue that is primarily troubleshooting/support rather than presales.",
      usuallyAttachTo: 'Account, or Opportunity when directly connected to an active deal',
      examples: 'Escalation call, troubleshooting with Support, reproduction assistance, critical customer issue',
    },
    // Inactive display-only anchor for Non-Activity meetings.
    { name: 'None', crmObjectType: 'Event' as const, sortOrder: 999, isActive: false, color: '#6B7280' },
  ]

  const insertedTypes = await db
    .insert(schema.teamActivityTypes)
    .values(activityTypeValues.map((t) => ({ ...DEFAULT_ACTIVITY_TYPE_STYLES[defaultTypeKey(t.name, evalWork)], ...t, teamId: team.id })))
    .returning()

  const typeMap = Object.fromEntries(insertedTypes.map((t) => [t.name, t.id]))

  // Assign all activity types to the Sales Engineering team via junction table.
  await db.insert(schema.activityTypeTeams).values(
    insertedTypes.map((t) => ({ activityTypeId: t.id, teamId: team.id })),
  )

  // v1.255.0: display-only Subtype labels per type — see migration 0129 for
  // the matching seed on existing deployments upgrading in place. Never
  // synced to Salesforce.
  const subtypeValues: Record<string, string[]> = {
    Marketing: ['Webinar', 'Trade Show / Booth', 'Conference Session', 'Roadshow / Field Event', 'Partner Event', 'Customer Event'],
    Discovery: ['Initial Discovery', 'Technical Discovery', 'Architecture Discovery', 'Requirements Gathering', 'Success Criteria / Qualification'],
    Demo: ['Standard Demo', 'Custom Demo', 'Use-Case Demo', 'Executive Demo', 'Technical Deep Dive'],
    Enablement: ['Customer Training', 'Partner Training', 'Admin Training', 'How-To / Coaching', 'Configuration Guidance', 'Internal Enablement'],
    'RFx Work': ['RFP', 'RFI', 'Security Questionnaire', 'Technical Questionnaire', 'Requirements Matrix', 'Architecture / Compliance Response'],
    HealthCheck: ['Configuration Review', 'Architecture Review', 'Adoption Review', 'Performance / Optimization', 'Best-Practice Review', 'Upgrade / Readiness Review'],
    Support: ['Support Handoff', 'Troubleshooting', 'Escalation Call', 'Reproduction / Validation', 'Product Issue Review', 'Customer Recovery'],
    [evalWork]: ['POC', 'Trial', 'Workshop', 'CloudLAB', 'Installation / Configuration', 'Testing / Validation', 'Success Criteria Review'],
    'Executive Briefing': ['Executive Strategy', 'CISO / CIO Briefing', 'Business Value / Outcomes', 'Roadmap Discussion', 'Executive Sponsor Meeting', 'Strategic Partnership Review'],
  }
  const subtypeRows = Object.entries(subtypeValues).flatMap(([typeName, names]) => {
    const teamActivityTypeId = typeMap[typeName]
    if (!teamActivityTypeId) return []
    return names.map((name, i) => ({ teamActivityTypeId, name, sortOrder: (i + 1) * 10 }))
  })
  if (subtypeRows.length > 0) {
    await db.insert(schema.teamActivityTypeSubtypes).values(subtypeRows)
  }

  const insertedFieldMappings = await db.insert(schema.crmFieldMappings).values([
    { teamId: team.id, appField: 'title', crmFieldApi: 'Subject', crmObject: 'Event' as const },
    { teamId: team.id, appField: 'activity_type', crmFieldApi: 'Type', crmObject: 'Event' as const },
    {
      teamId: team.id,
      appField: 'start_datetime',
      crmFieldApi: 'ActivityDateTime',
      crmObject: 'Event' as const,
    },
    {
      teamId: team.id,
      appField: 'effort_hours',
      crmFieldApi: 'DurationInMinutes',
      crmObject: 'Event' as const,
    },
    {
      teamId: team.id,
      appField: 'crm_what_id',
      crmFieldApi: 'WhatId',
      crmObject: 'Event' as const,
    },
    { teamId: team.id, appField: 'notes', crmFieldApi: 'Description', crmObject: 'Event' as const },
    { teamId: team.id, appField: 'user_id', crmFieldApi: 'OwnerId', crmObject: 'Event' as const },
  ]).returning()

  if (insertedFieldMappings.length > 0) {
    await db.insert(schema.crmFieldMappingTeams).values(
      insertedFieldMappings.map((m) => ({ crmFieldMappingId: m.id, teamId: team.id })),
    )
  }

  const sfPicklistValues = [
    'Marketing',
    'Discovery',
    'Demo',
    'Enablement',
    'RFx Work',
    'HealthCheck',
    'Executive Briefing',
    'Support',
    evalWork,
  ]
  await db.insert(schema.sfEventTypeConfig).values(
    sfPicklistValues.map((v) => ({ teamId: team.id, sfPicklistValue: v, isActive: true })),
  )
  await db.insert(schema.sfEventTypeConfig).values([
    { teamId: team.id, sfPicklistValue: 'Meeting', isActive: false, fallbackValue: null },
  ])

  const demoId = typeMap['Demo']
  const discoveryId = typeMap['Discovery']
  const enablementId = typeMap['Enablement']
  const evalId = typeMap[evalWork]
  const execId = typeMap['Executive Briefing']
  const healthId = typeMap['HealthCheck']
  const marketingId = typeMap['Marketing']
  const rfxId = typeMap['RFx Work']
  const supportId = typeMap['Support']

  if (
    !demoId || !discoveryId || !enablementId || !evalId ||
    !execId || !healthId || !marketingId || !rfxId || !supportId
  ) {
    throw new Error('Missing activity type IDs')
  }

  const insertedKeywordRules = await db.insert(schema.keywordRules).values([
    {
      teamId: team.id,
      keywords: ['demo', 'demonstration', 'product demo'],
      activityTypeId: demoId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['discovery', 'disco', 'needs assessment'],
      activityTypeId: discoveryId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['enablement', 'training', 'workshop'],
      activityTypeId: enablementId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['eval', 'evaluation', 'poc', 'proof of concept', 'trial'],
      activityTypeId: evalId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['executive briefing', 'ebr', 'exec briefing', 'c-level'],
      activityTypeId: execId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['healthcheck', 'health check', 'qbr', 'quarterly business review'],
      activityTypeId: healthId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['marketing', 'webinar', 'conference', 'trade show'],
      activityTypeId: marketingId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['rfp', 'rfq', 'rfi', 'rfx', 'proposal', 'bid'],
      activityTypeId: rfxId,
      matchField: 'both' as const,
      priority: 10,
    },
    {
      teamId: team.id,
      keywords: ['support', 'troubleshoot', 'issue', 'break fix'],
      activityTypeId: supportId,
      matchField: 'both' as const,
      priority: 10,
    },
  ]).returning()

  // Assign all keyword rules to the Sales Engineering team via junction table.
  if (insertedKeywordRules.length > 0) {
    await db.insert(schema.keywordRuleTeams).values(
      insertedKeywordRules.map((r) => ({ keywordRuleId: r.id, teamId: team.id })),
    )
  }

  const insertedNudgeRules = await db.insert(schema.nudgeRules).values([
    {
      teamId: team.id,
      name: 'No Activity Days',
      triggerType: 'no_activity_days' as const,
      triggerConfig: { days: 5 },
      messageTemplate: "Nothing logged this week yet — catch up before Friday?",
    },
    {
      teamId: team.id,
      name: 'Stage No Type',
      triggerType: 'stage_no_type' as const,
      triggerConfig: { stage: 'Eval', type: evalWork, days: 14 },
      messageTemplate:
        `No ${evalWork} logged for {opp_name} in {days_overdue} days — anything to capture?`,
    },
    {
      teamId: team.id,
      name: 'Type No Followup',
      triggerType: 'type_no_followup' as const,
      triggerConfig: { fromType: 'Discovery', toType: 'Demo', days: 21 },
      messageTemplate:
        "You logged a Discovery for {account_name} {days_overdue} days ago — did a Demo follow?",
    },
  ]).returning()

  // Assign all nudge rules to the Sales Engineering team via junction table.
  if (insertedNudgeRules.length > 0) {
    await db.insert(schema.nudgeRuleTeams).values(
      insertedNudgeRules.map((r) => ({ nudgeRuleId: r.id, teamId: team.id })),
    )
  }

  // Default capacity group (top-level, attached to the seeded team).
  const [group] = await db.insert(schema.capacityGroups).values([
    {
      name: 'Global SEs',
      targetHoursPerWeek: '40.0',
      capacityMethod: 'fixed_hours' as const,
      region: 'Global',
      roleType: 'SE',
    },
  ]).returning()
  if (group) {
    await db.insert(schema.capacityGroupTeams).values([{ groupId: group.id, teamId: team.id }])
  }

  // Flight Deck jumpstart checklist — presets are ordinary rows an admin can
  // edit/reorder/delete like any custom item (isPreset only drives a
  // "Default" badge). Links point at real routes in this app, not the
  // CriteriaIQ mockup's Projects/MAP concepts. Icons are drawn from the
  // shared IconPicker curated set (src/client/components/ui/icon-picker.tsx)
  // so an admin re-editing a preset can find/reselect the same icon in the
  // picker's search grid.
  await db.insert(schema.flightDeckItems).values([
    {
      teamId: team.id,
      label: 'Complete your profile',
      tooltip: 'Set your name, timezone, and work hours so your capacity numbers are accurate.',
      icon: 'Users',
      linkType: 'app_page' as const,
      linkValue: '/settings',
      isPreset: true,
      sortOrder: 1,
    },
    {
      teamId: team.id,
      label: 'Connect your Salesforce account',
      tooltip: 'Link Salesforce so you can attach activities to Opportunities and Accounts.',
      icon: 'Handshake',
      linkType: 'app_page' as const,
      linkValue: '/settings',
      isPreset: true,
      sortOrder: 2,
    },
    {
      teamId: team.id,
      label: 'Connect your Outlook account',
      tooltip: 'Link Outlook so your calendar events show up for logging activities.',
      icon: 'CalendarDays',
      linkType: 'app_page' as const,
      linkValue: '/settings',
      isPreset: true,
      sortOrder: 3,
    },
    {
      teamId: team.id,
      label: 'Log your first activity',
      tooltip: 'Capture a Demo, Discovery, or meeting from your week.',
      icon: 'Calendar',
      linkType: 'app_page' as const,
      linkValue: '/',
      isPreset: true,
      sortOrder: 4,
    },
    {
      teamId: team.id,
      label: 'Explore your dashboard',
      tooltip: "See your team's capacity, activity mix, and account coverage.",
      icon: 'LayoutDashboard',
      linkType: 'app_page' as const,
      linkValue: '/dashboard',
      isPreset: true,
      sortOrder: 5,
    },
  ])

  console.log('Seed complete.')
  await client.end()
}

// Run directly when invoked as a script (e.g. `npm run db:seed`)
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  runSeed().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
