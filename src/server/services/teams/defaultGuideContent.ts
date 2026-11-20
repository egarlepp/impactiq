// v1.255.4: the Guide content originally seeded for the default "Solutions
// Engineering" team by migrations 0128/0129 and drizzle/seed.ts. Kept here
// too as a single source of truth for the *admin-triggered* "Seed Default
// Guide Content" action (POST /api/admin/teams/:teamId/seed-guide-content).
//
// Why a separate trigger exists at all: the migrations match the team to
// seed by a hardcoded slug ('solutions-engineering'). If a real deployment's
// Solutions Engineering team was created by hand (Admin → Teams) rather than
// through drizzle/seed.ts, its slug won't match, and the migration silently
// no-ops — it completes without error (nothing to seed is not a failure),
// gets recorded as applied, and the content never appears. There's no way
// to detect that class of mismatch from the migration alone. This lets an
// admin explicitly seed the CURRENTLY SELECTED team instead of relying on a
// slug guess — safe because every write here is additive/COALESCE-style
// (never overwrites a field or replaces existing subtypes) and is only
// ever run when an admin clicks the button.
//
// Content is intentionally Solutions-Engineering-flavored example copy, so
// this is never wired into `applyDefaultTeamConfig` (which runs
// automatically for every newly created team, generic or not) — it's an
// opt-in action an admin takes deliberately, most usefully on the actual
// default SE team.
export const DEFAULT_GUIDE_CONTENT: Record<string, { useThisWhen: string; usuallyAttachTo: string; examples: string; subtypes: string[] }> = {
  Marketing: {
    useThisWhen: "You're supporting a marketing-led activity rather than working a specific sales opportunity.",
    usuallyAttachTo: 'Marketing Campaign',
    examples: 'Webinar, trade show booth, conference session, roadshow, customer event',
    subtypes: ['Webinar', 'Trade Show / Booth', 'Conference Session', 'Roadshow / Field Event', 'Partner Event', 'Customer Event'],
  },
  Discovery: {
    useThisWhen: "You're learning about the customer's environment, requirements, problems, priorities, or technical fit.",
    usuallyAttachTo: 'Opportunity if it exists; otherwise Account',
    examples: 'Technical discovery call, architecture discussion, requirements gathering, qualification call',
    subtypes: ['Initial Discovery', 'Technical Discovery', 'Architecture Discovery', 'Requirements Gathering', 'Success Criteria / Qualification'],
  },
  Demo: {
    useThisWhen: "You're showing product capabilities to address a customer's stated or anticipated requirements.",
    usuallyAttachTo: 'Opportunity',
    examples: 'Product demo, use-case demo, architecture walkthrough with product, custom demo',
    subtypes: ['Standard Demo', 'Custom Demo', 'Use-Case Demo', 'Executive Demo', 'Technical Deep Dive'],
  },
  Enablement: {
    useThisWhen: "You're teaching someone how to use, configure, position, or understand the product rather than actively proving it for a sale.",
    usuallyAttachTo: 'Account or Opportunity, depending on context',
    examples: 'Customer training, admin walkthrough, "how do I...?", simple configuration assistance, partner enablement',
    subtypes: ['Customer Training', 'Partner Training', 'Admin Training', 'How-To / Coaching', 'Configuration Guidance', 'Internal Enablement'],
  },
  'RFx Work': {
    useThisWhen: "You're responding to a formal or semi-formal customer requirements document.",
    usuallyAttachTo: 'Opportunity; one activity per RFx request',
    examples: 'RFP, RFI, security questionnaire, technical questionnaire, requirements matrix',
    subtypes: ['RFP', 'RFI', 'Security Questionnaire', 'Technical Questionnaire', 'Requirements Matrix', 'Architecture / Compliance Response'],
  },
  HealthCheck: {
    useThisWhen: "You're proactively reviewing an existing customer environment to assess configuration, adoption, architecture, or product health.",
    usuallyAttachTo: 'Account',
    examples: 'Deployment review, configuration assessment, adoption review, optimization session',
    subtypes: ['Configuration Review', 'Architecture Review', 'Adoption Review', 'Performance / Optimization', 'Best-Practice Review', 'Upgrade / Readiness Review'],
  },
  'Executive Briefing': {
    useThisWhen: "You're participating in a strategic, executive-level customer conversation focused on business priorities, security strategy, transformation initiatives, risk, outcomes, or partnership direction rather than detailed product evaluation or technical discovery.",
    usuallyAttachTo: 'Opportunity if tied to an active deal; otherwise Account.',
    examples: 'Executive briefing, CISO/CIO meeting, strategic roadmap discussion, executive sponsor meeting, business-value discussion, transformation planning, customer executive workshop.',
    subtypes: ['Executive Strategy', 'CISO / CIO Briefing', 'Business Value / Outcomes', 'Roadmap Discussion', 'Executive Sponsor Meeting', 'Strategic Partnership Review'],
  },
  Support: {
    useThisWhen: "You've become involved in a customer issue that is primarily troubleshooting/support rather than presales.",
    usuallyAttachTo: 'Account, or Opportunity when directly connected to an active deal',
    examples: 'Escalation call, troubleshooting with Support, reproduction assistance, critical customer issue',
    subtypes: ['Support Handoff', 'Troubleshooting', 'Escalation Call', 'Reproduction / Validation', 'Product Issue Review', 'Customer Recovery'],
  },
  // Keyed by the original name; seedGuideContent maps the install's own
  // evaluation type name onto it (shared/terminology.ts defaultTypeKey).
  'Eval Work': {
    useThisWhen: "You're doing hands-on technical work required to execute an evaluation.",
    usuallyAttachTo: 'Opportunity + Evaluation record',
    examples: 'POC setup, trial configuration, workshop, CloudLAB, Assessment, installation, success-criteria testing',
    subtypes: ['POC', 'Trial', 'Workshop', 'CloudLAB', 'Installation / Configuration', 'Testing / Validation', 'Success Criteria Review'],
  },
}

// v1.446.0: the evaluation type's name follows Admin → Workplace →
// Terminology ("POx Work" by default), so this is built per install.
export function defaultGuideDistinctions(evalWork: string): string {
  return (
    'Discovery vs Demo:\n' +
    'Discovery = "Tell me about your world."\n' +
    'Demo = "Let me show you how we address what we learned."\n\n' +
    "A discovery call that includes five minutes of product doesn't suddenly become a Demo.\n\n" +
    `Demo vs ${evalWork}:\n` +
    'Demo = SE shows it.\n' +
    `${evalWork} = customer is proving it, and the SE is installing, configuring, testing, or otherwise facilitating the proof.\n\n` +
    'Enablement vs Support:\n' +
    'Enablement = "Here\'s how you do it."\n' +
    "Support = \"Something isn't working; let's figure out why.\"\n\n" +
    'Health Check vs Support:\n' +
    'Health Check = proactive/preventative.\n' +
    'Support = reactive/problem-driven.\n\n' +
    `Discovery vs ${evalWork}:\n` +
    `A success-criteria planning conversation can still be Discovery. Once the SE starts executing the technical evaluation—install, configure, test, validate—that is ${evalWork}.`
  )
}

