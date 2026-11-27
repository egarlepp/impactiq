import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activities,
  activityCrmTickets,
  activityNotes,
  attachRateFields,
  capacityGroups,
  capacityGroupTeams,
  costGroups,
  costGroupTeams,
  crmHistoricalEvents,
  crmLeadAccountLink,
  crmOpportunityCoverage,
  dashboardPresets,
  nonActivityEvents,
  outlookEvents,
  sfObjectOwnerCache,
  crmUserAlignments,
  crmUsers,
  subteams,
  subteamUsers,
  systemSettings,
  teamActivityTypeCrmExtras,
  teamActivityTypes,
  teamActivityTypeSubtypes,
  teamMembers,
  teams,
  userNotificationPrefs,
  userPtoDays,
  users,
} from '../../../../drizzle/schema.js'
import { applyDefaultTeamConfig } from '../teams/defaults.js'
import { getTerminology } from '../config/terminology.js'
import { LEGACY_EVAL_WORK_NAME, defaultTypeKey, evalWorkTypeName } from '../../../shared/terminology.js'
import { deleteTeamCascade } from '../teams/deleteTeam.js'
import { seedGuideContent } from '../teams/seedGuideContent.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { decryptToken, encryptToken } from '../config/crypto.js'
import { addDaysToDate, dayOfWeek, isValidTimeZone, localDateOf, localMondayOf, localToUtc } from './timezone.js'
import { DEMO_CRM_ID_PREFIX, DEMO_TEAM_SLUG } from './ids.js'
import { applyExceptionStates, DEMO_NON_ACTIVITY_SUBJECTS } from './exceptionStates.js'
import { applyHubspotVocabulary, campaignColumns, DEMO_CAMPAIGNS, DEMO_LEADS, demoForecast, demoStage, leadColumns, type CampaignFixture, type DemoCrm, type LeadFixture } from './crmFixtures.js'
import { seedDemoAnnouncements, seedDemoNudgeHistory } from './engagement.js'
import { buildDemoGong, DEMO_GONG_MODEL, removeDemoGong, seedDemoGong } from './gongFixtures.js'
import { buildDemoAssessmentScores, removeDemoAssessments, seedDemoAssessments, seedDemoAssessmentScores } from './assessmentFixtures.js'
import { seedDemoNoteProfiles } from './profileFixtures.js'
import { getCrmProviderId } from '../crm/providerSetting.js'
import { getEffectiveCrmFeatures } from '../crm/features.js'
import { HUBSPOT_PROJECTS_OBJECT_TYPE_ID } from '../../../shared/hubspot.js'

export { DEMO_TEAM_SLUG }

// Demo rows carry stable markers so the wipe endpoint can find them without
// touching real data:
//   teams.slug            — DEMO_TEAM_SLUG; every generated activity, the
//                           demo memberships, subteams, Attach Rate fields
//                           and the team's notifications live under it, so
//                           Remove deletes the team
//   users.email           — ends with @demo.impactiq.local
//   users.okta_id         — starts with 'demo:'
//   capacity_groups.name / cost_groups.name — start with '[Demo]'
//   CRM ids               — start with 'demo-' (Opportunities, Accounts,
//                           Projects, CRM users, coverage and historical
//                           rows), see ids.ts
//   outlook_events.id     — starts with 'demo-outlook-' (demo users only)
// Activities created for the calling admin's own user_id are tagged with
// notes starting with '[DEMO]' so they can be removed without touching the
// admin's real activities.
export const DEMO_EMAIL_SUFFIX = '@demo.impactiq.local'
export const DEMO_OKTA_PREFIX = 'demo:'
export const DEMO_GROUP_PREFIX = '[Demo] '
export const DEMO_ADMIN_NOTE_PREFIX = '[DEMO]'
export const DEMO_OUTLOOK_FLAG_KEY = 'demo_outlook_enabled'
export const DEMO_TEAM_NAME = '[Demo] Sales Engineering'
const DEMO_PRODUCT_PREFIX = '[Demo] '
const DEMO_OUTLOOK_PREFIX = 'demo-outlook-'
const DEMO_HISTORY_PREFIX = `${DEMO_CRM_ID_PREFIX}hist-`
// Fixed seed so every Generate produces the same-shaped data (useful for
// screenshots). The team id is new on every run, so it can't be the seed.
const DEMO_SEED = 0x1a2b3c4d
const TARGET_HOURS_PER_WEEK = 30
const HOURLY_COST_RATE = '95.00'
const EVAL_OBJECT = 'Evaluations__c'
const ATTACH_FIELD = 'Assigned_SE__c'

// Thrown when Generate runs while demo data is already present; the route
// answers 409 with this key.
export class DemoDataExistsError extends Error {
  constructor() { super('errors.demo_data.already_present') }
}

// The settings the demo data was last generated with, kept so Reseed can
// rebuild the same data and the form starts from them.
export interface DemoSettings {
  contributorCount: number
  weeksBack: number
  createLeaderLogin: boolean
  /** IANA zone the working days are laid out in; null = UTC (older data). */
  timezone: string | null
  /** 0-100: share of loggable meetings already approved as activities. */
  approvedPct: number
  /** 0-100: share of meetings the person declined. */
  declinedPct: number
  /** 0-100: share of weekdays out of office. */
  oooPct: number
  /** PTO days per demo person across the window (plus one coming up). */
  ptoDaysPerPerson: number
  /**
   * Admin-written activity names ("Zero Trust workshop") worked into
   * meeting subjects and activity titles; empty = the built-in names.
   */
  activityNames: string[]
}

export const DEMO_ACTIVITY_NAMES_MAX = 50
export const DEMO_ACTIVITY_NAME_MAX_LENGTH = 80

/** Trimmed, de-duplicated (case-insensitive) and capped activity names. */
export function cleanDemoActivityNames(names: readonly unknown[] | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names ?? []) {
    if (typeof raw !== 'string') continue
    const name = raw.trim().replace(/\s+/g, ' ').slice(0, DEMO_ACTIVITY_NAME_MAX_LENGTH)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
    if (out.length >= DEMO_ACTIVITY_NAMES_MAX) break
  }
  return out
}

export const DEFAULT_DEMO_SETTINGS: DemoSettings = {
  contributorCount: 6,
  weeksBack: 12,
  createLeaderLogin: false,
  timezone: null,
  approvedPct: 70,
  declinedPct: 5,
  oooPct: 3,
  ptoDaysPerPerson: 3,
  activityNames: [],
}

// The value stored under DEMO_OUTLOOK_FLAG_KEY. userIds lists the real
// accounts (the admin who generated) that also get the fixture calendar;
// demo users always do. Rows written before v1.430 carry only `enabled`,
// before v1.436 no settings. leaderPassword is the demo leader's password,
// encrypted with TOKEN_ENCRYPTION_KEY, so Current state can keep showing it.
interface DemoOutlookFlag {
  enabled?: boolean
  userIds?: string[]
  settings?: Partial<DemoSettings> | undefined
  leaderPassword?: string | null
}

const FIRST_NAMES = ['Alex', 'Sam', 'Pat', 'Riley', 'Jordan', 'Morgan', 'Casey', 'Taylor', 'Drew', 'Avery']
const LAST_NAME = 'Demo'

interface AccountFixture { id: string; name: string }
const ACCOUNTS: AccountFixture[] = [
  { id: 'demo-acc-001', name: 'Foxtrot Logistics' },
  { id: 'demo-acc-002', name: 'Golf Bank' },
  { id: 'demo-acc-003', name: 'Hotel Co' },
  { id: 'demo-acc-004', name: 'India Pharma' },
  { id: 'demo-acc-005', name: 'Juliet Energy' },
  { id: 'demo-acc-006', name: 'ACME Corp' },
  { id: 'demo-acc-007', name: 'BetaCo' },
  { id: 'demo-acc-008', name: 'CtrlCo' },
  { id: 'demo-acc-009', name: 'Delta Health' },
  { id: 'demo-acc-010', name: 'Echo Industries' },
]

// Opportunity snapshot fields stamped onto linked activities, the same
// columns the nightly refresh_opp_snapshots job keeps fresh for real ones.
// closeInDays is relative to Generate's "now". eval = the Project (POC/POV)
// Eval Work activities on this Opportunity link to.
interface OppFixture {
  id: string
  name: string
  accountId: string
  stage: string
  forecast: string
  acv: number
  closeInDays: number
  isClosed: boolean
  isWon: boolean
  eval?: { id: string; name: string; type: 'POC' | 'POV'; status: string; stage: string; startInDays: number; endInDays: number }
}
const OPPS: OppFixture[] = [
  { id: 'demo-opp-001', name: 'ACME Renewal', accountId: 'demo-acc-006', stage: 'Negotiation', forecast: 'Commit', acv: 180000, closeInDays: 20, isClosed: false, isWon: false },
  { id: 'demo-opp-002', name: 'BetaCo Eval', accountId: 'demo-acc-007', stage: 'Technical Validation', forecast: 'Best Case', acv: 240000, closeInDays: 45, isClosed: false, isWon: false,
    eval: { id: 'demo-eval-001', name: 'BetaCo POC', type: 'POC', status: 'In Progress', stage: 'Testing', startInDays: -35, endInDays: 15 } },
  { id: 'demo-opp-003', name: 'CtrlCo Discovery', accountId: 'demo-acc-008', stage: 'Qualification', forecast: 'Pipeline', acv: 90000, closeInDays: 110, isClosed: false, isWon: false },
  { id: 'demo-opp-004', name: 'Delta Health POC', accountId: 'demo-acc-009', stage: 'Technical Validation', forecast: 'Best Case', acv: 320000, closeInDays: 60, isClosed: false, isWon: false,
    eval: { id: 'demo-eval-002', name: 'Delta Health POV', type: 'POV', status: 'In Progress', stage: 'Kickoff', startInDays: -14, endInDays: 30 } },
  { id: 'demo-opp-005', name: 'Echo Industries Expansion', accountId: 'demo-acc-010', stage: 'Closed Won', forecast: 'Closed', acv: 150000, closeInDays: -20, isClosed: true, isWon: true,
    eval: { id: 'demo-eval-003', name: 'Echo Industries POC', type: 'POC', status: 'Completed', stage: 'Closed - Success', startInDays: -70, endInDays: -30 } },
  { id: 'demo-opp-006', name: 'Foxtrot Logistics Platform', accountId: 'demo-acc-001', stage: 'Proposal', forecast: 'Commit', acv: 210000, closeInDays: 30, isClosed: false, isWon: false },
  { id: 'demo-opp-007', name: 'Golf Bank Security Add-on', accountId: 'demo-acc-002', stage: 'Closed Won', forecast: 'Closed', acv: 75000, closeInDays: -45, isClosed: true, isWon: true },
  { id: 'demo-opp-008', name: 'India Pharma Analytics', accountId: 'demo-acc-004', stage: 'Closed Lost', forecast: 'Omitted', acv: 130000, closeInDays: -15, isClosed: true, isWon: false },
  { id: 'demo-opp-009', name: 'Juliet Energy Integrations', accountId: 'demo-acc-005', stage: 'Prospecting', forecast: 'Pipeline', acv: 60000, closeInDays: 150, isClosed: false, isWon: false },
  { id: 'demo-opp-010', name: 'Hotel Co Mobile Rollout', accountId: 'demo-acc-003', stage: 'Closed Lost', forecast: 'Omitted', acv: 45000, closeInDays: -60, isClosed: true, isWon: false },
]
// Opportunities with no ImpactIQ activity, so Attach Rate has a real
// denominator (some covered by an Assigned SE, some not).
const PIPELINE_ONLY_OPPS: Array<{ id: string; name: string; acv: number; closeInDays: number; hasSe: boolean }> = [
  { id: 'demo-opp-011', name: 'Kilo Retail Upgrade', acv: 55000, closeInDays: 40, hasSe: true },
  { id: 'demo-opp-012', name: 'Lima Telecom Platform', acv: 260000, closeInDays: 75, hasSe: true },
  { id: 'demo-opp-013', name: 'Mike Media Analytics', acv: 35000, closeInDays: 25, hasSe: false },
  { id: 'demo-opp-014', name: 'November Air Integrations', acv: 120000, closeInDays: 90, hasSe: true },
  { id: 'demo-opp-015', name: 'Oscar Foods Renewal', acv: 40000, closeInDays: 15, hasSe: false },
  { id: 'demo-opp-016', name: 'Papa Insurance Security', acv: 95000, closeInDays: 55, hasSe: false },
  { id: 'demo-opp-017', name: 'Quebec Transit Mobile', acv: 70000, closeInDays: 120, hasSe: true },
  { id: 'demo-opp-018', name: 'Romeo Clinics Expansion', acv: 150000, closeInDays: 65, hasSe: false },
]
// Opportunities with no Assigned SE: still "attached" through ImpactIQ
// activity (the secondary signal), which the dashboard calls out.
const OPPS_WITHOUT_SE = new Set(['demo-opp-003', 'demo-opp-009'])

// Relative weight of each default activity type, so the mix looks like a
// real SE team (lots of Meeting/Demo/Discovery/Eval Work, few Marketing).
const TYPE_WEIGHTS: Record<string, number> = {
  Meeting: 18, Demo: 16, Discovery: 14, 'Eval Work': 14, Support: 8, 'RFx Work': 6,
  Enablement: 6, HealthCheck: 5, 'Executive Briefing': 4, Marketing: 3,
}

// Which activity type a fixture calendar subject is logged as, and which
// Opportunity or Account it is about. Unlisted subjects are internal.
const SUBJECT_LINKS: Array<{ match: string; type: string; opp?: string; account?: string }> = [
  { match: 'Acme Inc.', type: 'Discovery', opp: 'demo-opp-001' },
  { match: 'BetaCo', type: 'Demo', opp: 'demo-opp-002' },
  { match: 'CtrlCo', type: 'Executive Briefing', opp: 'demo-opp-003' },
  { match: 'Delta Health', type: 'Eval Work', opp: 'demo-opp-004' },
  { match: 'Echo Industries', type: 'Eval Work', opp: 'demo-opp-005' },
  { match: 'Foxtrot Logistics', type: 'RFx Work', opp: 'demo-opp-006' },
  { match: 'India Pharma', type: 'Discovery', opp: 'demo-opp-008' },
  { match: 'Golf Bank', type: 'HealthCheck', account: 'demo-acc-002' },
  { match: 'Enablement', type: 'Enablement' },
]

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)]!
}

function pickWeighted<T>(arr: T[], weight: (x: T) => number, rnd: () => number): T {
  const total = arr.reduce((s, x) => s + weight(x), 0)
  let r = rnd() * total
  for (const x of arr) {
    r -= weight(x)
    if (r <= 0) return x
  }
  return arr[arr.length - 1]!
}

function seededRandom(seed: number): () => number {
  // Mulberry32 — deterministic so re-running produces identical-shaped
  // data, useful for screenshots.
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  return Array.from(s).reduce((acc, ch) => (acc * 33 + ch.charCodeAt(0)) >>> 0, 5381) || 1
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400_000)
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export interface GenerateOpts {
  contributorCount: number
  weeksBack: number
  includeAdmin: boolean
  adminUserId: string
  /**
   * Also create a demo Team Leader who signs in with a password, so the
   * leader view can be shown as someone other than the admin. The password
   * is random, returned once, and must be changed at first sign-in.
   */
  createLeaderLogin?: boolean
  /** IANA zone for the working day; omitted or null = UTC. */
  timezone?: string | null | undefined
  /** 0-100, default 70: share of loggable meetings logged as activities. */
  approvedPct?: number | undefined
  /** 0-100, default 0: share of meetings declined. */
  declinedPct?: number | undefined
  /** 0-100, default 0: share of weekdays out of office. */
  oooPct?: number | undefined
  /** PTO days per demo person, default 0. */
  ptoDaysPerPerson?: number | undefined
  /** Admin-written activity names worked into subjects and titles. */
  activityNames?: readonly string[] | undefined
  /** Reseed: keep the demo leader's existing password. */
  leaderPassword?: string | undefined
  /**
   * Reference date — used for "current week" math. Defaults to new Date().
   * Tests can pass a fixed instant.
   */
  now?: Date | undefined
}

export interface GenerateResult {
  teamId: string
  usersCreated: number
  activitiesCreated: number
  capacityGroupId: string | null
  leaderLogin: { email: string; password: string } | null
}

export const DEMO_LEADER_EMAIL = `leader.demo${DEMO_EMAIL_SUFFIX}`

// 20 random characters plus one of each class the password rules ask for.
function randomDemoPassword(): string {
  return `${randomBytes(15).toString('base64url')}aZ7!`
}

interface TypeRow { id: string; name: string }
interface DemoPerson { id: string; name: string; email: string }

// Everything an activity row needs from its CRM link, stamped the way the
// Opportunity picker and the nightly snapshot refresh would.
// What a demo activity is about: an Opportunity, an Account, a Lead or a
// Campaign.
interface DemoLink { opp?: OppFixture; account?: AccountFixture; lead?: LeadFixture; campaign?: CampaignFixture }

function crmLinkColumns(link: DemoLink | null, now: Date, seName: (oppId: string) => string | null): Partial<typeof activities.$inferInsert> {
  if (!link) return {}
  if (link.lead) return leadColumns(link.lead)
  if (link.campaign) return campaignColumns(link.campaign)
  if (link.account) {
    return {
      crmWhatId: link.account.id,
      crmWhatType: 'Account',
      crmWhatName: link.account.name,
      crmAccountId: link.account.id,
      crmAccountName: link.account.name,
    }
  }
  const opp = link.opp!
  const account = ACCOUNTS.find((a) => a.id === opp.accountId)!
  const owner = ownerForAccount(account.id)
  const closeDate = isoDate(addDays(now, opp.closeInDays))
  return {
    crmWhatId: opp.id,
    crmWhatType: 'Opportunity',
    crmWhatName: opp.name,
    crmAccountId: account.id,
    crmAccountName: account.name,
    acv: opp.acv.toFixed(2),
    oppAmount: opp.acv.toFixed(2),
    salesStage: opp.stage,
    forecastCategory: opp.forecast,
    crmIsClosed: opp.isClosed,
    crmIsWon: opp.isWon,
    oppCloseDate: closeDate,
    crmOppCloseDate: closeDate,
    crmOppOwnerId: owner.id,
    crmOppOwnerName: owner.name,
    crmAssignedSeName: seName(opp.id),
    crmSnapshotRefreshedAt: now,
  }
}

function evalColumns(opp: OppFixture | undefined, now: Date, seName: (oppId: string) => string | null): Partial<typeof activities.$inferInsert> {
  const ev = opp?.eval
  if (!opp || !ev) return {}
  return {
    crmRelatedType: EVAL_OBJECT,
    crmRelatedId: ev.id,
    crmRelatedName: ev.name,
    crmEvalStatus: ev.status,
    crmEvalStage: ev.stage,
    crmEvalType: ev.type,
    crmEvalStartDate: isoDate(addDays(now, ev.startInDays)),
    crmEvalEndDate: isoDate(addDays(now, ev.endInDays)),
    crmEvalPrimaryEngineer: seName(opp.id),
  }
}

// Subtypes for the demo team's active types that the default content
// leaves without any (Meeting has none), so most demo activities carry one.
const DEMO_EXTRA_SUBTYPES: Record<string, string[]> = {
  Meeting: ['Internal sync', 'Customer check-in', 'Partner meeting', 'Pipeline review'],
}
const DEMO_FALLBACK_SUBTYPES = ['Customer-facing', 'Internal']

async function seedMissingDemoSubtypes(teamId: string): Promise<void> {
  const types = await db.select({ id: teamActivityTypes.id, name: teamActivityTypes.name })
    .from(teamActivityTypes)
    .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.isActive, true)))
  if (types.length === 0) return
  const existing = await db.select({ typeId: teamActivityTypeSubtypes.teamActivityTypeId })
    .from(teamActivityTypeSubtypes)
    .where(inArray(teamActivityTypeSubtypes.teamActivityTypeId, types.map((t) => t.id)))
  const covered = new Set(existing.map((r) => r.typeId))
  const rows = types
    .filter((t) => !covered.has(t.id))
    .flatMap((t) => (DEMO_EXTRA_SUBTYPES[t.name] ?? DEMO_FALLBACK_SUBTYPES).map((name, i) => ({ teamActivityTypeId: t.id, name, sortOrder: (i + 1) * 10 })))
  if (rows.length > 0) await db.insert(teamActivityTypeSubtypes).values(rows)
}

export async function generateDemoData(opts: GenerateOpts): Promise<GenerateResult> {
  const { contributorCount, weeksBack, includeAdmin, adminUserId } = opts
  const now = opts.now ?? new Date()
  const tz = opts.timezone && isValidTimeZone(opts.timezone) ? opts.timezone : null
  const pct = (v: number | undefined, fallback: number): number => Math.min(100, Math.max(0, v ?? fallback))
  const approvedPct = pct(opts.approvedPct, DEFAULT_DEMO_SETTINGS.approvedPct)
  const declinedPct = pct(opts.declinedPct, 0)
  const oooPct = pct(opts.oooPct, 0)
  const ptoDaysPerPerson = Math.min(20, Math.max(0, Math.floor(opts.ptoDaysPerPerson ?? 0)))
  const activityNames = cleanDemoActivityNames(opts.activityNames)

  // Demo data goes into its own team, never a real one, so it can't leak
  // into a real team's dashboards, compliance or nudges. One set at a time.
  const status = await demoDataStatus()
  if (status.team || status.users > 0) throw new DemoDataExistsError()

  const [team] = await db.insert(teams).values({
    name: DEMO_TEAM_NAME,
    slug: DEMO_TEAM_SLUG,
    icon: 'Sparkles',
  }).returning({ id: teams.id })
  if (!team) throw new Error('errors.teams.creation_failed')
  const teamId = team.id
  await applyDefaultTeamConfig(db, teamId)
  // Guide text and Subtypes, with the Subtype picker turned on, so the
  // Guide page and every Subtype dashboard have something to show.
  await seedGuideContent(teamId)
  // AI Notes and leader transcript access on, so the demo Gong calls and
  // their AI Notes show for everyone in the demo team (v1.459.0). An admin
  // can switch either off for the demo team like any other team.
  await db.update(teams).set({ subtypesEnabled: true, aiNotesEnabled: true, transcriptsLeaderAccess: true }).where(eq(teams.id, teamId))
  await seedMissingDemoSubtypes(teamId)
  // The generating admin joins as team admin so the demo team shows in
  // their own team selector; the membership goes with the team on Remove.
  await db.insert(teamMembers).values({ teamId, userId: adminUserId, role: 'admin' })

  // Load the team's activity types — required (we randomly pick from these).
  const types: TypeRow[] = await db
    .select({ id: teamActivityTypes.id, name: teamActivityTypes.name })
    .from(teamActivityTypes)
    .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.isActive, true)))
  if (types.length === 0) {
    throw new Error('errors.demo_data.no_activity_types')
  }
  const typeIds = types.map((t) => t.id)
  const subtypeRows = await db
    .select({ id: teamActivityTypeSubtypes.id, name: teamActivityTypeSubtypes.name, typeId: teamActivityTypeSubtypes.teamActivityTypeId })
    .from(teamActivityTypeSubtypes)
    .where(inArray(teamActivityTypeSubtypes.teamActivityTypeId, typeIds))
  const subtypesByType = new Map<string, Array<{ id: string; name: string }>>()
  for (const s of subtypeRows) {
    const list = subtypesByType.get(s.typeId) ?? []
    list.push({ id: s.id, name: s.name })
    subtypesByType.set(s.typeId, list)
  }
  const typeByName = new Map(types.map((t) => [t.name, t]))
  // The evaluation type is named from Admin → Workplace → Terminology
  // ("POx Work"); the fixtures below say "Eval Work" and map onto it.
  const evalWork = evalWorkTypeName(await getTerminology())

  // Shaped for the install's CRM (Salesforce when none is chosen), with
  // Leads and Campaigns only when those CRM features are on.
  const crm: DemoCrm = (await getCrmProviderId()) === 'hubspot' ? 'hubspot' : 'salesforce'
  const crmFeatures = await getEffectiveCrmFeatures()

  // CRM Extras, so a demo Eval Work activity shows its Project and a
  // Support activity its ticket, the way a configured team's would.
  const extras: Array<typeof teamActivityTypeCrmExtras.$inferInsert> = []
  const evalType = typeByName.get(evalWork)
  if (evalType) {
    extras.push({
      teamActivityTypeId: evalType.id,
      kind: 'related_object_picker',
      config: crm === 'hubspot'
        ? { sobject: HUBSPOT_PROJECTS_OBJECT_TYPE_ID, mode: 'read', label: 'Project' }
        : { sobject: EVAL_OBJECT, parentField: 'Opportunity__c', labelField: 'Name', mode: 'read', label: 'Project' },
    })
  }
  const supportType = typeByName.get('Support')
  if (supportType) extras.push({ teamActivityTypeId: supportType.id, kind: 'ticket_picker', config: { sobject: 'Case', label: 'Support Ticket' } })
  if (extras.length > 0) await db.insert(teamActivityTypeCrmExtras).values(extras)

  // 1. Synthetic contributors.
  const desiredCount = Math.min(Math.max(contributorCount, 1), Math.min(FIRST_NAMES.length, 20))
  const people: DemoPerson[] = Array.from({ length: desiredCount }, (_, i) => ({
    id: '',
    name: `${FIRST_NAMES[i]} ${LAST_NAME}`,
    email: `${FIRST_NAMES[i]!.toLowerCase()}.demo.${i + 1}${DEMO_EMAIL_SUFFIX}`,
  }))
  const userRows = await db.insert(users).values(
    people.map((p) => ({
      oktaId: `${DEMO_OKTA_PREFIX}${randomUUID()}`,
      email: p.email,
      displayName: p.name,
      passwordHash: null,
      mustChangePassword: false,
      authMethod: 'both' as const,
      defaultTeamId: teamId,
      timezone: tz ?? 'UTC',
    })),
  ).returning({ id: users.id, email: users.email })
  const idByEmail = new Map(userRows.map((r) => [r.email, r.id]))
  for (const p of people) p.id = idByEmail.get(p.email)!
  const demoUserIds = people.map((p) => p.id)

  // Add them to the team as contributors.
  await db.insert(teamMembers).values(
    demoUserIds.map((userId) => ({ teamId, userId, role: 'contributor' as const })),
  )

  // 1b. Optional demo Team Leader with a password sign-in. Leads the demo
  // team only, so it can never see a real team; it goes with the other
  // demo users on Remove. The password is kept (encrypted) so Current state
  // can show it again, so it isn't forced to change at first sign-in: a
  // changed password would no longer match what the page shows.
  let leaderLogin: GenerateResult['leaderLogin'] = null
  let leaderId: string | null = null
  if (opts.createLeaderLogin) {
    const password = opts.leaderPassword ?? randomDemoPassword()
    const [leader] = await db.insert(users).values({
      oktaId: `${DEMO_OKTA_PREFIX}${randomUUID()}`,
      email: DEMO_LEADER_EMAIL,
      displayName: 'Lee Leader',
      firstName: 'Lee',
      lastName: 'Leader',
      passwordHash: hashPassword(password),
      passwordChangedAt: now,
      mustChangePassword: false,
      authMethod: 'password',
      defaultTeamId: teamId,
      timezone: tz ?? 'UTC',
    }).returning({ id: users.id })
    if (leader) {
      leaderId = leader.id
      await db.insert(teamMembers).values({ teamId, userId: leader.id, role: 'leader' })
      leaderLogin = { email: DEMO_LEADER_EMAIL, password }
    }
  }

  // 2. Two regional subteams, people split between them; the first person
  // in each also leads it.
  const subteamRows = await db.insert(subteams).values([
    { teamId, name: `${DEMO_GROUP_PREFIX}East`, kind: 'region' },
    { teamId, name: `${DEMO_GROUP_PREFIX}West`, kind: 'region' },
  ]).returning({ id: subteams.id })
  const subteamMemberRows: Array<{ subteamId: string; userId: string; role: string }> = []
  people.forEach((p, i) => {
    const subteam = subteamRows[i % subteamRows.length]!
    subteamMemberRows.push({ subteamId: subteam.id, userId: p.id, role: 'member' })
    if (i < subteamRows.length) subteamMemberRows.push({ subteamId: subteam.id, userId: p.id, role: 'leader' })
  })
  // The admin sits in East too, so Scheduling's subteam view and the
  // Subteam filters include them alongside their demo teammates.
  if (includeAdmin && subteamRows[0]) subteamMemberRows.push({ subteamId: subteamRows[0].id, userId: adminUserId, role: 'member' })
  await db.insert(subteamUsers).values(subteamMemberRows)

  // 3. Capacity and cost groups attached to the demo team, so the capacity
  // dashboards have a target and every $ figure has a rate. Meeting Load
  // is on: the demo users' fixture calendars are stored below.
  const [group] = await db.insert(capacityGroups).values({
    name: `${DEMO_GROUP_PREFIX}Sales Engineers`,
    targetHoursPerWeek: TARGET_HOURS_PER_WEEK.toFixed(1),
    capacityMethod: 'fixed_hours',
    region: 'Demo',
    roleType: 'SE',
    showRealMeetingLoad: true,
  }).returning({ id: capacityGroups.id })
  if (group) {
    await db.insert(capacityGroupTeams).values({ groupId: group.id, teamId })
  }
  const [costGroup] = await db.insert(costGroups).values({
    name: `${DEMO_GROUP_PREFIX}Sales Engineers`,
    hourlyCostRate: HOURLY_COST_RATE,
    currency: 'USD',
    region: 'Demo',
    roleType: 'SE',
  }).returning({ id: costGroups.id })
  if (costGroup) {
    await db.insert(costGroupTeams).values({ groupId: costGroup.id, teamId })
  }

  // Each Opportunity's Assigned SE is one of the demo people (none on a
  // couple, which Attach Rate then shows as covered by activity only).
  const seName = (oppId: string): string | null => {
    if (OPPS_WITHOUT_SE.has(oppId)) return null
    const idx = Number(oppId.slice(-3)) - 1
    return people[idx % people.length]?.name ?? null
  }

  // 4. Activities. Weeks and days are the people's own local ones when a
  // timezone is set (UTC otherwise).
  const thisMondayDate = localMondayOf(now, tz)
  const thisMonday = localToUtc(thisMondayDate, 0, tz)
  const lastCompletedMondayDate = addDaysToDate(thisMondayDate, -7)
  const windowStartDate = addDaysToDate(thisMondayDate, -(weeksBack - 1) * 7)
  const activityRows: typeof activities.$inferInsert[] = []
  const calendarRows: typeof outlookEvents.$inferInsert[] = []
  const anomaliesOn = weeksBack >= 5 && people.length >= 2

  const typeFor = (name: string): TypeRow | null => typeByName.get(name === LEGACY_EVAL_WORK_NAME ? evalWork : name) ?? null
  const subtypeColumns = (type: TypeRow, rnd: () => number): Partial<typeof activities.$inferInsert> => {
    const list = subtypesByType.get(type.id)
    // Most activities carry a Subtype; about one in ten is left without,
    // as a contributor sometimes skips the optional picker.
    if (!list || list.length === 0 || rnd() < 0.1) return {}
    const s = pick(list, rnd)
    return { subtypeId: s.id, subtypeName: s.name }
  }
  const openOppsAt = (when: Date): OppFixture[] =>
    OPPS.filter((o) => !o.isClosed || addDays(now, o.closeInDays).getTime() > when.getTime())

  // 3b. PTO: a few weekdays per person across the window plus one coming
  // up, never in the last completed week (the "What changed" anomalies are
  // planted there). The fixture calendar shows them as all-day PTO and
  // nothing is logged on them.
  const ptoByPerson = new Map<string, Set<string>>()
  const ptoRows: Array<typeof userPtoDays.$inferInsert> = []
  if (ptoDaysPerPerson > 0) {
    const todayDate = localDateOf(now, tz)
    people.forEach((person, idx) => {
      const ptoRnd = seededRandom(DEMO_SEED + idx * 7919 + 1)
      const dates = new Set<string>()
      const span = weeksBack * 7
      for (let tries = 0; dates.size < ptoDaysPerPerson && tries < ptoDaysPerPerson * 20; tries++) {
        const date = addDaysToDate(windowStartDate, Math.floor(ptoRnd() * span))
        const dow = dayOfWeek(date)
        if (dow === 0 || dow === 6 || date >= todayDate) continue
        if (date >= lastCompletedMondayDate && date < thisMondayDate) continue
        dates.add(date)
      }
      // One upcoming day in the next two weeks, so the Scheduling grid and
      // capacity show PTO ahead too.
      for (let tries = 0; tries < 20; tries++) {
        const date = addDaysToDate(todayDate, 1 + Math.floor(ptoRnd() * 14))
        const dow = dayOfWeek(date)
        if (dow === 0 || dow === 6) continue
        dates.add(date)
        break
      }
      ptoByPerson.set(person.id, dates)
      for (const date of dates) ptoRows.push({ userId: person.id, date, note: 'Vacation' })
    })
    if (ptoRows.length > 0) await db.insert(userPtoDays).values(ptoRows).onConflictDoNothing()
  }
  const calendarOptsFor = (personId: string): DemoCalendarOpts => ({ timezone: tz, declinedPct, oooPct, ptoDates: ptoByPerson.get(personId), activityNames })
  // Titles for activities logged without a meeting: about half use one of
  // the admin's activity names. Its own stream, so a list of names leaves
  // the rest of the data where it was.
  const namesRnd = seededRandom(DEMO_SEED + 4242)
  const titleFor = (type: TypeRow, target: string): string =>
    activityNames.length > 0 && namesRnd() < 0.5
      ? `${pick(activityNames, namesRnd)} — ${target}`
      : `${type.name} — ${target}`

  for (let userIdx = 0; userIdx < people.length; userIdx++) {
    const person = people[userIdx]!
    // Per-user rng so activity distributions differ between users.
    const userRnd = seededRandom(DEMO_SEED + userIdx * 9973)
    // Each person runs at their own steady load: about 24 to 33 h a week.
    const loadFactor = 0.8 + userRnd() * 0.3
    for (let weekOffset = weeksBack - 1; weekOffset >= 0; weekOffset--) {
      const weekStartDate = addDaysToDate(thisMondayDate, -weekOffset * 7)
      const isAnomalyWeek = anomaliesOn && weekStartDate === lastCompletedMondayDate
      // Planted anomalies for the "What changed" panel: person 1 stops
      // logging (last completed week and this week), person 0 runs well
      // over capacity, the team surges on RFx Work and burns hours on one
      // Opportunity.
      if (anomaliesOn && userIdx === 1 && people.length >= 3 && weekOffset <= 1) continue
      let weekTarget = TARGET_HOURS_PER_WEEK * loadFactor * (0.85 + userRnd() * 0.3)
      if (isAnomalyWeek && userIdx === 0) weekTarget = TARGET_HOURS_PER_WEEK * 1.5 // well past the 125% over-capacity line

      const overCapacityWeek = isAnomalyWeek && userIdx === 0
      // Hours a crowded calendar left no room for roll into the next day,
      // so the planted over-capacity week always clears the threshold.
      let carry = 0
      for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
        const date = addDaysToDate(weekStartDate, dayOffset)
        const dayAt = (hours: number): number => localToUtc(date, hours, tz).getTime()
        // Nothing in the future: the current week stops at today.
        if (dayAt(0) > now.getTime()) break
        const isPto = ptoByPerson.get(person.id)?.has(date) ?? false
        // An occasional day off (never for the planted over-capacity week).
        if (!isPto && userRnd() < 0.06 && !overCapacityWeek) continue
        let dayBudget = weekTarget / 5 + carry
        carry = 0

        // 4a. Most of the person's own calendar for the day is logged as
        // activity, linked to its Outlook event so the weekly view shows
        // the "already logged" badge.
        const fixture = generateDemoOutlookEvents(
          new Date(dayAt(0)).toISOString(),
          localToUtc(addDaysToDate(date, 1), 0, tz).toISOString(),
          person.id,
          { name: person.name, email: person.email },
          calendarOptsFor(person.id),
        )
        for (const ev of fixture) {
          const start = new Date(ev.start)
          const end = new Date(ev.end)
          calendarRows.push({
            id: ev.id,
            userId: person.id,
            subject: ev.subject,
            bodyPreview: ev.bodyPreview,
            isAllDay: ev.isAllDay,
            startDatetime: start,
            endDatetime: end,
            location: ev.location,
            organizerName: ev.organizer.name,
            organizerEmail: ev.organizer.email,
            attendees: ev.attendees,
            showAs: ev.showAs,
            isCancelled: ev.isCancelled,
            responseStatus: ev.responseStatus,
            sensitivity: ev.sensitivity,
          })
          if (!isLoggableDemoEvent(ev) || DEMO_NON_ACTIVITY_SUBJECTS.includes(ev.subject)) continue
          // The rest of the meetings are left for the contributor to approve.
          if ((userRnd() < (100 - approvedPct) / 100 && !overCapacityWeek) || end.getTime() > now.getTime()) continue
          const rule = SUBJECT_LINKS.find((r) => ev.subject.includes(r.match))
          const type = typeFor(rule?.type ?? 'Meeting') ?? pick(types, userRnd)
          const opp = rule?.opp ? OPPS.find((o) => o.id === rule.opp) : undefined
          const account = rule?.account ? ACCOUNTS.find((a) => a.id === rule.account) : undefined
          const hours = (end.getTime() - start.getTime()) / 3600_000
          dayBudget -= hours
          activityRows.push(buildActivity({
            userId: person.id, teamId, type, start, end, hours, now, rnd: userRnd,
            title: ev.subject,
            outlookEventId: ev.id,
            link: opp ? { opp } : account ? { account } : null,
            withEval: !!opp?.eval && type.name === evalWork,
            seName, subtypeColumns,
          }))
        }
        // PTO and out-of-office days: the calendar is stored, nothing logged.
        if (fixture.some(isAwayDemoEvent)) continue

        // 4b. The rest of the day's effort: prep, eval work, RFx answers,
        // support, logged without a calendar event, in the free time before
        // and after the day's meetings: 7:30 to 18:30 local, or with no
        // timezone 11:30 to 23:30 UTC (a US business day in any US zone).
        const timed = fixture.filter((ev) => !ev.isAllDay)
        const firstMeeting = Math.min(...timed.map((ev) => new Date(ev.start).getTime()), dayAt(tz ? 9.5 : 14.5))
        const lastMeeting = Math.max(...timed.map((ev) => new Date(ev.end).getTime()), firstMeeting)
        // The over-capacity week works longer days.
        const dayStartH = tz ? (overCapacityWeek ? 6 : 7.5) : (overCapacityWeek ? 10 : 11.5)
        const dayEndH = tz ? (overCapacityWeek ? 20 : 18.5) : (overCapacityWeek ? 24 : 23.5)
        const slots: Array<[number, number]> = [
          [dayAt(dayStartH), firstMeeting - 10 * 60_000],
          [lastMeeting + 15 * 60_000, dayAt(dayEndH)],
        ]
        let slotIdx = 0
        let cursor = slots[0]![0]
        while (dayBudget >= 0.5 && slotIdx < slots.length) {
          const start = new Date(Math.ceil(cursor / 900_000) * 900_000)
          const roomHours = Math.floor((slots[slotIdx]![1] - start.getTime()) / 1_800_000) * 0.5
          const durationHours = Math.min(dayBudget, roomHours, 0.5 + Math.floor(userRnd() * 5) * 0.5) // 0.5 - 2.5
          if (durationHours < 0.5) {
            slotIdx += 1
            if (slotIdx < slots.length) cursor = slots[slotIdx]![0]
            continue
          }
          const end = new Date(start.getTime() + durationHours * 3600_000)
          if (end.getTime() > now.getTime()) break
          const rfx = isAnomalyWeek ? typeFor('RFx Work') : null
          const type = rfx && userRnd() < 0.45 ? rfx : pickWeighted(types, (t) => TYPE_WEIGHTS[defaultTypeKey(t.name, evalWork)] ?? 5, userRnd)
          let link: DemoLink | null = null
          if (userRnd() < 0.65) {
            if (isAnomalyWeek && userRnd() < 0.6) link = { opp: OPPS.find((o) => o.id === 'demo-opp-006')! }
            else if (type.name === evalWork) link = { opp: pick(openOppsAt(start).filter((o) => o.eval), userRnd) ?? pick(openOppsAt(start), userRnd) }
            else if (type.name === 'Marketing' && crmFeatures.campaignsEnabled) link = { campaign: pick(DEMO_CAMPAIGNS, userRnd) }
            else if (userRnd() < 0.75) link = { opp: pick(openOppsAt(start), userRnd) }
            else if (crmFeatures.leadsEnabled && ['Discovery', 'Demo'].includes(type.name) && userRnd() < 0.6) link = { lead: pick(DEMO_LEADS, userRnd) }
            else link = { account: pick(ACCOUNTS, userRnd) }
          }
          activityRows.push(buildActivity({
            userId: person.id, teamId, type, start, end, hours: durationHours, now, rnd: userRnd,
            title: titleFor(type, link?.opp?.name ?? link?.account?.name ?? link?.lead?.company ?? link?.campaign?.name ?? 'internal'),
            outlookEventId: null,
            link,
            withEval: !!link?.opp?.eval && type.name === evalWork,
            seName, subtypeColumns,
          }))
          dayBudget -= durationHours
          cursor = end.getTime() + (5 + Math.floor(userRnd() * 5) * 5) * 60_000
        }
        if (overCapacityWeek && dayBudget > 0) carry = dayBudget
      }
    }
  }

  // 5. Admin's own activities for the current + previous week, tagged with
  //    [DEMO] notes so wipe finds them without touching real activities.
  const rnd = seededRandom(DEMO_SEED)
  if (includeAdmin) {
    for (let weekOffset = 0; weekOffset <= 1; weekOffset++) {
      const weekStartDate = addDaysToDate(thisMondayDate, -weekOffset * 7)
      const perWeek = 5 + Math.floor(rnd() * 3) // 5-7
      for (let k = 0; k < perWeek; k++) {
        const type = pickWeighted(types, (t) => TYPE_WEIGHTS[defaultTypeKey(t.name, evalWork)] ?? 5, rnd)
        const date = addDaysToDate(weekStartDate, Math.floor(rnd() * 5))
        // 8:00-15:00 local, or 13:00-20:00 UTC with no timezone.
        const start = localToUtc(date, (tz ? 8 : 13) + Math.floor(rnd() * 8), tz)
        const durationHours = 0.5 + Math.floor(rnd() * 5) * 0.5
        const end = new Date(start.getTime() + durationHours * 3600_000)
        if (end.getTime() > now.getTime()) continue
        const opp = pick(openOppsAt(start), rnd)
        activityRows.push({
          ...buildActivity({
            userId: adminUserId, teamId, type, start, end, hours: durationHours, now, rnd,
            title: titleFor(type, opp.name),
            outlookEventId: null,
            link: { opp },
            withEval: !!opp.eval && type.name === evalWork,
            seName, subtypeColumns,
          }),
          notes: `${DEMO_ADMIN_NOTE_PREFIX} Demo activity for showcase`,
        })
      }
    }
  }

  // 5b. A few rows in every exception state (drafts, sync failures,
  // disconnected links, Outlook deletions, Why Meeting?, tickets, ...).
  const exceptions = applyExceptionStates({
    rows: activityRows,
    calendarRows,
    demoUserIds,
    adminUserId,
    typeNameById: new Map(types.map((t) => [t.id, t.name])),
    now,
    thisMonday,
    rnd,
  })

  if (crm === 'hubspot') applyHubspotVocabulary(activityRows, EVAL_OBJECT)

  // Seed a small demo product catalog BEFORE activities so we can attach
  // products to the freshly-inserted activity rows. Marked with a stable
  // name prefix so removeDemoData can find them. This block is idempotent:
  // any existing [Demo] products (from a prior generate that wasn't cleanly
  // wiped) are removed first so we never duplicate rows or leave stale
  // entries with no team link for the current team.
  // Generic names only: no real vendor's product catalog in demo data.
  const { products: productsTbl, productTeams, activityProducts } = await import('../../../../drizzle/schema.js')
  await db.delete(productsTbl).where(like(productsTbl.name, `${DEMO_PRODUCT_PREFIX}%`))
  const demoProductRows = [
    { name: `${DEMO_PRODUCT_PREFIX}Core Platform`, space: 'Platform', abbreviation: 'CP' },
    { name: `${DEMO_PRODUCT_PREFIX}Analytics`, space: 'Platform', abbreviation: 'AN' },
    { name: `${DEMO_PRODUCT_PREFIX}Integrations Hub`, space: 'Platform', abbreviation: 'IH' },
    { name: `${DEMO_PRODUCT_PREFIX}Security Add-on`, space: 'Add-ons', abbreviation: 'SA' },
    { name: `${DEMO_PRODUCT_PREFIX}Mobile Suite`, space: 'Add-ons', abbreviation: 'MS' },
    { name: `${DEMO_PRODUCT_PREFIX}Professional Services`, space: 'Services', abbreviation: 'PS' },
  ]
  const insertedProducts = await db.insert(productsTbl).values(demoProductRows.map((p) => ({ ...p, isActive: true }))).returning({ id: productsTbl.id })
  const demoProductIds = insertedProducts.map((p) => p.id)
  if (demoProductIds.length > 0) {
    await db.insert(productTeams).values(demoProductIds.map((id) => ({ productId: id, teamId })))
  }

  // Bulk insert in chunks of 500 to keep parameter counts sane. We collect
  // returned IDs so we can distribute product links across them.
  for (let i = 0; i < calendarRows.length; i += 500) {
    await db.insert(outlookEvents).values(calendarRows.slice(i, i + 500)).onConflictDoNothing()
  }
  let activitiesCreated = 0
  const insertedActivityIds: string[] = []
  for (let i = 0; i < activityRows.length; i += 500) {
    const chunk = activityRows.slice(i, i + 500)
    const inserted = await db.insert(activities).values(chunk).returning({ id: activities.id })
    for (const row of inserted) insertedActivityIds.push(row.id)
    activitiesCreated += chunk.length
  }

  // Ticket snapshots and Non-Activity marks need the inserted rows.
  const ticketRows = exceptions.tickets
    .map(({ rowIndex, ticket }) => ({ ...ticket, activityId: insertedActivityIds[rowIndex] }))
    .filter((t): t is typeof t & { activityId: string } => !!t.activityId)
  if (ticketRows.length > 0) await db.insert(activityCrmTickets).values(ticketRows)
  if (exceptions.nonActivity.length > 0) await db.insert(nonActivityEvents).values(exceptions.nonActivity).onConflictDoNothing()
  // Each demo person hides "Office hours" with their own Non-Activity keyword.
  await db.update(users).set({ nonActivityKeywords: ['Office hours'] }).where(inArray(users.id, demoUserIds))

  // Distribute products across approved activities: 80% get 1 product,
  // 15% get 2, 5% get 3. Uses the same seeded rng root so runs are
  // reproducible.
  if (demoProductIds.length > 0 && insertedActivityIds.length > 0) {
    const activityProductRows: { activityId: string; productId: string }[] = []
    for (const activityId of insertedActivityIds) {
      const r = rnd()
      const count = r < 0.8 ? 1 : r < 0.95 ? 2 : 3
      const pool = [...demoProductIds]
      const picked: string[] = []
      for (let k = 0; k < count && pool.length > 0; k++) {
        const idx = Math.floor(rnd() * pool.length)
        picked.push(pool.splice(idx, 1)[0]!)
      }
      for (const pid of picked) activityProductRows.push({ activityId, productId: pid })
    }
    for (let i = 0; i < activityProductRows.length; i += 1000) {
      await db.insert(activityProducts).values(activityProductRows.slice(i, i + 1000))
    }
  }

  // 5c. Notes on about a quarter of the demo people's linked activities and
  // most of the admin's, so My Notes has something for "mine" and for the
  // whole team. They go with their activities on Remove.
  const noteRows = buildDemoNotes(activityRows, insertedActivityIds, adminUserId, now)
  const insertedNotes: Array<{ id: string; activityId: string; isPrivate: boolean }> = []
  for (let i = 0; i < noteRows.length; i += 500) {
    insertedNotes.push(...await db.insert(activityNotes).values(noteRows.slice(i, i + 500))
      .returning({ id: activityNotes.id, activityId: activityNotes.activityId, isPrivate: activityNotes.isPrivate }))
  }

  // 5d. Sample Gong calls "imported" for recent customer meetings, with
  // transcripts and AI Notes in mixed review states. Never sent to Gong or
  // the AI (services/demo/gongFixtures.ts).
  {
    const typeNameById = new Map(types.map((t) => [t.id, t.name]))
    const [adminUser] = await db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, adminUserId)).limit(1)
    const gongPeople = [...people.map((p) => ({ id: p.id, name: p.name, email: p.email }))]
    if (adminUser) gongPeople.push({ id: adminUserId, name: adminUser.name, email: adminUser.email })
    const gongActivities = activityRows.flatMap((row, i) => {
      const activityId = insertedActivityIds[i]
      if (!activityId || (row.crmWhatType !== 'Opportunity' && row.crmWhatType !== 'Account')) return []
      return [{
        activityId,
        userId: row.userId,
        title: row.title,
        typeName: typeNameById.get(row.activityTypeId ?? '') ?? '',
        start: row.startDatetime as Date,
        end: row.endDatetime as Date,
        outlookEventId: row.outlookEventId ?? null,
        crmWhatId: row.crmWhatId ?? null,
        crmWhatType: row.crmWhatType ?? null,
        crmAccountId: row.crmAccountId ?? null,
        accountName: row.crmAccountName ?? row.crmWhatName ?? null,
      }]
    })
    const gong = buildDemoGong({
      activities: gongActivities,
      people: gongPeople,
      adminUserId,
      notes: insertedNotes,
      evalWork,
      crm,
      now,
      rnd: seededRandom(DEMO_SEED ^ 0x606e),
    })
    await seedDemoGong(gong)
    // AI Assessments assigned to Discovery, Demo and the evaluation type,
    // scored on the activities with a linked call (v1.464.0).
    // Settings Profiles: a starred Default plus one per assessment (v1.473.0).
    const profileIdByName = await seedDemoNoteProfiles({ teamId, adminUserId })
    const rubrics = await seedDemoAssessments({ teamId, adminUserId, types, evalWork, profileIdByName })
    await seedDemoAssessmentScores(buildDemoAssessmentScores({
      teamId,
      rubrics,
      targets: gong.scoreTargets,
      model: DEMO_GONG_MODEL,
      rnd: seededRandom(DEMO_SEED ^ 0xa55e),
    }))
  }

  // 6. Sales Team Alignment fixtures — 5 fake managers + 15 fake owners,
  // each demo person aligned to a subset — and the owner cache, so Sales
  // Team Breakdown and the Account/Opportunity roll-ups resolve.
  await seedDemoSfUsers(demoUserIds, rnd)
  await seedDemoSfObjectOwnerCache()

  // 7. Attach Rate: the demo team's Assigned SE field plus a coverage
  // snapshot of the demo pipeline. Coverage is an org-wide table, so the
  // dashboards only show these rows for the demo team (ids.ts).
  await db.insert(attachRateFields).values({
    teamId,
    crmObject: 'Opportunity',
    fieldApi: ATTACH_FIELD,
    matchType: 'equals',
    resolveUsers: false,
    roleLabel: 'Assigned SE',
  })
  await seedDemoCoverage(now, seName, rnd, crm)

  // 8. Pre-ImpactIQ history for the History tab: estimated meetings for the
  // two years before the generated window.
  await seedDemoHistory({ people, teamId, types, evalWork, start: addDays(thisMonday, -weeksBack * 7), rnd })

  // 9. Converted Leads roll up into their Accounts.
  if (crmFeatures.leadsEnabled) {
    const converted = DEMO_LEADS.filter((l) => l.convertedAccountId)
    await db.insert(crmLeadAccountLink).values(converted.map((l) => ({ leadId: l.id, accountId: l.convertedAccountId, refreshedAt: now })))
      .onConflictDoNothing()
  }

  // 10. Nudge history and a few announcements in the demo team.
  await seedDemoNudgeHistory({ teamId, people: people.map((p) => ({ id: p.id, name: p.name })), stoppedUserId: anomaliesOn && people.length >= 3 ? people[1]!.id : null, now, weeksBack, rnd })
  await seedDemoAnnouncements({ teamId, adminUserId, now, evalWork, subteamId: subteamRows[0]?.id ?? null, leaderUserId: leaderId })

  const settings: DemoSettings = {
    contributorCount: desiredCount,
    weeksBack,
    createLeaderLogin: !!opts.createLeaderLogin,
    timezone: tz,
    approvedPct,
    declinedPct,
    oooPct,
    ptoDaysPerPerson,
    activityNames,
  }
  await setDemoOutlookFlag({
    enabled: true,
    userIds: includeAdmin ? [adminUserId] : [],
    settings,
    leaderPassword: leaderLogin ? encryptToken(leaderLogin.password) : null,
  })

  return {
    teamId,
    usersCreated: demoUserIds.length,
    activitiesCreated,
    capacityGroupId: group!.id,
    leaderLogin,
  }
}

const NOTE_BODIES = [
  'Walked through the architecture with their platform team. Main concern is SSO and audit logging; sending the security pack.',
  'Good energy in the room. They want a second session focused on integrations before the eval starts.',
  'Champion confirmed budget is approved for this fiscal year. Procurement needs our standard MSA redlines by Friday.',
  'Demo landed well with the ops leads. Follow-ups: pricing for the analytics add-on, and a reference customer in their industry.',
  'Discovery: three teams, two regions, roughly 400 users at launch. Current tool is home-grown and hard to maintain.',
  'Eval checkpoint: 6 of 8 success criteria met. Remaining two depend on their data export, which slipped a week.',
  'Exec sponsor asked for a one-page ROI summary. Drafted with the AE, review before sending.',
  'Support follow-up: the import issue was a mapping problem on their side. Shared the corrected template.',
]
const NOTE_MEDDPICC: Array<Partial<Record<string, string[]>>> = [
  { metrics: ['Cut onboarding time by 40%'], champion: ['Priya Nair'] },
  { economic_buyer: ['Marcus Chen'], paper_process: ['Standard MSA, security review'] },
  { identified_pain: ['Home-grown tool, hard to maintain'], competition: ['Incumbent spreadsheet process'] },
  { decision_criteria: ['SSO', 'Audit logging', 'Regional data residency'], decision_process: ['Eval, then steering committee'] },
]

// Note rows for a share of the generated activities (by index into rows,
// matched to insertedIds). The note's author is the activity's owner.
function buildDemoNotes(rows: Array<typeof activities.$inferInsert>, insertedIds: string[], adminUserId: string, now: Date): Array<typeof activityNotes.$inferInsert> {
  const noteRnd = seededRandom(DEMO_SEED ^ 0x5eed)
  const out: Array<typeof activityNotes.$inferInsert> = []
  rows.forEach((row, i) => {
    const activityId = insertedIds[i]
    if (!activityId || !row.crmWhatId) return
    const share = row.userId === adminUserId ? 0.7 : 0.25
    if (noteRnd() >= share) return
    const created = new Date(Math.min((row.endDatetime as Date).getTime() + (10 + Math.floor(noteRnd() * 110)) * 60_000, now.getTime()))
    const body = NOTE_BODIES[Math.floor(noteRnd() * NOTE_BODIES.length)]!
    const meddpicc = row.crmWhatType === 'Opportunity' && noteRnd() < 0.5 ? NOTE_MEDDPICC[Math.floor(noteRnd() * NOTE_MEDDPICC.length)]! : {}
    out.push({
      activityId,
      body,
      createdBy: row.userId,
      createdAt: created,
      updatedAt: created,
      meddpicc,
      isPrivate: noteRnd() < 0.1,
    })
  })
  return out
}

interface BuildActivityArgs {
  userId: string
  teamId: string
  type: TypeRow
  start: Date
  end: Date
  hours: number
  now: Date
  rnd: () => number
  title: string
  outlookEventId: string | null
  link: DemoLink | null
  withEval: boolean
  seName: (oppId: string) => string | null
  subtypeColumns: (type: TypeRow, rnd: () => number) => Partial<typeof activities.$inferInsert>
}

function buildActivity(a: BuildActivityArgs): typeof activities.$inferInsert {
  // Logged anywhere from an hour to three days after the meeting ended,
  // which is what Logging Lag measures.
  const lagMs = (1 + Math.floor(a.rnd() * 72)) * 3600_000
  const createdAt = new Date(Math.min(a.end.getTime() + lagMs, a.now.getTime()))
  return {
    userId: a.userId,
    teamId: a.teamId,
    title: a.title,
    activityTypeId: a.type.id,
    ...a.subtypeColumns(a.type, a.rnd),
    status: 'submitted',
    startDatetime: a.start,
    endDatetime: a.end,
    effortHours: a.hours.toFixed(2),
    notes: null,
    outlookEventId: a.outlookEventId,
    ...crmLinkColumns(a.link, a.now, a.seName),
    ...(a.withEval ? evalColumns(a.link?.opp, a.now, a.seName) : {}),
    createdAt,
    updatedAt: createdAt,
    submittedAt: createdAt,
  }
}

const DEMO_SFU_PREFIX = `${DEMO_CRM_ID_PREFIX}sfu-`
const DEMO_MANAGER_NAMES = [
  { first: 'Kate', last: 'Manager' },
  { first: 'Leo', last: 'Boss' },
  { first: 'Nina', last: 'Director' },
  { first: 'Owen', last: 'Chief' },
  { first: 'Priya', last: 'Lead' },
]
const DEMO_OWNER_NAMES = [
  'Alma Rep', 'Bruno Seller', 'Cora Deal', 'Dario Close', 'Elin Field',
  'Finn Quota', 'Gia Pipeline', 'Hugo Book', 'Iris Prospect', 'Jonas Hunter',
  'Kaya Farmer', 'Levi Growth', 'Mira Renew', 'Noah Expand', 'Olga Upsell',
]

// Each Account (and so each of its Opportunities) belongs to one demo rep,
// assigned by position so the same rep owns it on every Generate.
function ownerForAccount(accountId: string): { id: string; name: string } {
  const idx = (Number(accountId.slice(-3)) * 3) % DEMO_OWNER_NAMES.length
  return { id: `${DEMO_SFU_PREFIX}o${idx + 1}`, name: DEMO_OWNER_NAMES[idx]! }
}

async function seedDemoSfUsers(demoUserIds: string[], rnd: () => number): Promise<void> {
  // Managers first (no manager_id), then owners referencing them. crmUsers.managerId
  // has no FK constraint but ordering here mirrors src/server/services/salesforce/users.ts.
  const managerRows = DEMO_MANAGER_NAMES.map((n, i) => {
    const id = `${DEMO_SFU_PREFIX}m${i + 1}`
    return {
      id,
      name: `${n.first} ${n.last}`,
      email: `${n.first.toLowerCase()}.mgr@demo.sales.local`,
      managerId: null,
      isActive: true,
    }
  })
  await db.insert(crmUsers).values(managerRows).onConflictDoNothing()

  const ownerRows = DEMO_OWNER_NAMES.map((name, i) => {
    const id = `${DEMO_SFU_PREFIX}o${i + 1}`
    // Roughly 3 owners per manager (owners 1-3 → m1, 4-6 → m2, ...).
    const mgrIdx = Math.floor(i / 3) % managerRows.length
    return {
      id,
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@demo.sales.local`,
      managerId: managerRows[mgrIdx]!.id,
      isActive: true,
    }
  })
  await db.insert(crmUsers).values(ownerRows).onConflictDoNothing()

  if (demoUserIds.length === 0) return

  const alignmentRows: { userId: string; crmUserId: string; role: 'manager' | 'owner' }[] = []
  for (const userId of demoUserIds) {
    // 1-2 managers per ImpactIQ user.
    const mgrCount = 1 + Math.floor(rnd() * 2)
    const mgrPool = [...managerRows]
    for (let k = 0; k < mgrCount && mgrPool.length > 0; k++) {
      const idx = Math.floor(rnd() * mgrPool.length)
      const picked = mgrPool.splice(idx, 1)[0]!
      alignmentRows.push({ userId, crmUserId: picked.id, role: 'manager' })
    }
    // 2-4 owners per ImpactIQ user.
    const ownerCount = 2 + Math.floor(rnd() * 3)
    const ownerPool = [...ownerRows]
    for (let k = 0; k < ownerCount && ownerPool.length > 0; k++) {
      const idx = Math.floor(rnd() * ownerPool.length)
      const picked = ownerPool.splice(idx, 1)[0]!
      alignmentRows.push({ userId, crmUserId: picked.id, role: 'owner' })
    }
  }
  if (alignmentRows.length > 0) {
    await db.insert(crmUserAlignments).values(alignmentRows).onConflictDoNothing()
  }
}

// Wire demo Opportunities + Accounts to demo owners so Sales Team Breakdown
// and the Account roll-ups resolve demo ids without a live CRM call.
async function seedDemoSfObjectOwnerCache(): Promise<void> {
  const acctRows = ACCOUNTS.map((a) => {
    const owner = ownerForAccount(a.id)
    return { sfId: a.id, objectType: 'Account', name: a.name, accountId: a.id, accountName: a.name, ownerId: owner.id, ownerName: owner.name }
  })
  const oppRows = OPPS.map((o) => {
    const account = ACCOUNTS.find((a) => a.id === o.accountId)!
    const owner = ownerForAccount(account.id)
    return { sfId: o.id, objectType: 'Opportunity', name: o.name, accountId: account.id, accountName: account.name, ownerId: owner.id, ownerName: owner.name }
  })
  await db.insert(sfObjectOwnerCache).values([...acctRows, ...oppRows]).onConflictDoNothing()
}

// The demo pipeline as the coverage refresh would snapshot it: every
// fixture Opportunity plus a few with no ImpactIQ activity, each credited
// to its Assigned SE by name (the field is a name picklist here).
async function seedDemoCoverage(now: Date, seName: (oppId: string) => string | null, rnd: () => number, crm: DemoCrm): Promise<void> {
  const fieldKey = `Opportunity::${ATTACH_FIELD}`
  const rows: typeof crmOpportunityCoverage.$inferInsert[] = OPPS.map((o) => {
    const owner = ownerForAccount(o.accountId)
    const se = seName(o.id)
    return {
      oppId: o.id,
      oppName: o.name,
      createdDate: isoDate(addDays(now, -60 - Math.floor(rnd() * 90))),
      closeDate: isoDate(addDays(now, o.closeInDays)),
      stageName: demoStage(o.stage, crm),
      forecastCategory: demoForecast(o.forecast, crm),
      isClosed: o.isClosed,
      fieldValues: se ? { [fieldKey]: [se] } : {},
      ownerId: owner.id,
      ownerName: owner.name,
      amount: o.acv.toFixed(2),
      totalAcv: o.acv.toFixed(2),
      snapshotAt: now,
    }
  })
  PIPELINE_ONLY_OPPS.forEach((o, i) => {
    const owner = ownerForAccount(`x-${String(i + 11).padStart(3, '0')}`)
    const se = o.hasSe ? seName(o.id) : null
    rows.push({
      oppId: o.id,
      oppName: o.name,
      createdDate: isoDate(addDays(now, -20 - Math.floor(rnd() * 100))),
      closeDate: isoDate(addDays(now, o.closeInDays)),
      stageName: demoStage(i % 2 === 0 ? 'Qualification' : 'Proposal', crm),
      forecastCategory: demoForecast(i % 3 === 0 ? 'Best Case' : 'Pipeline', crm),
      isClosed: false,
      fieldValues: se ? { [fieldKey]: [se] } : {},
      ownerId: owner.id,
      ownerName: owner.name,
      amount: o.acv.toFixed(2),
      totalAcv: o.acv.toFixed(2),
      snapshotAt: now,
    })
  })
  await db.insert(crmOpportunityCoverage).values(rows).onConflictDoNothing()
}

// Two years of pre-ImpactIQ meetings, about one per person per week, the
// way CRM Historical Import would have brought them in. A tenth have an
// owner who isn't an ImpactIQ user, so the linkage-quality pill shows a
// realistic match rate.
async function seedDemoHistory(args: { people: DemoPerson[]; teamId: string; types: TypeRow[]; evalWork: string; start: Date; rnd: () => number }): Promise<void> {
  const { people, teamId, types, evalWork, start, rnd } = args
  const rows: typeof crmHistoricalEvents.$inferInsert[] = []
  const weeks = 104
  let n = 0
  for (let w = 1; w <= weeks; w++) {
    const weekStart = addDays(start, -w * 7)
    for (const person of people) {
      if (rnd() < 0.15) continue
      const unmatched = rnd() < 0.1
      const type = pickWeighted(types, (t) => TYPE_WEIGHTS[defaultTypeKey(t.name, evalWork)] ?? 5, rnd)
      const begin = addDays(weekStart, Math.floor(rnd() * 5))
      begin.setUTCHours(14 + Math.floor(rnd() * 6), 0, 0, 0)
      const minutes = 30 * (1 + Math.floor(rnd() * 4))
      const end = new Date(begin.getTime() + minutes * 60_000)
      const useOpp = rnd() < 0.6
      const opp = useOpp ? pick(OPPS, rnd) : null
      const account = opp ? ACCOUNTS.find((a) => a.id === opp.accountId)! : pick(ACCOUNTS, rnd)
      n += 1
      rows.push({
        crmEventId: `${DEMO_HISTORY_PREFIX}${String(n).padStart(5, '0')}`,
        subject: `${type.name} — ${opp?.name ?? account.name}`,
        crmType: type.name,
        activityDate: isoDate(begin),
        startDatetime: begin,
        endDatetime: end,
        durationMinutes: minutes,
        ownerCrmUserName: unmatched ? 'Former Employee' : person.name,
        whatId: opp?.id ?? account.id,
        whatType: opp ? 'Opportunity' : 'Account',
        whatName: opp?.name ?? account.name,
        accountId: account.id,
        userId: unmatched ? null : person.id,
        // Always the demo team, matched or not: a null team would show the
        // row in every real team's History tab.
        teamId,
        activityTypeId: type.id,
        userMatchMethod: unmatched ? null : 'email',
        typeMatchMethod: 'name_exact',
        estimatedHours: (minutes / 60).toFixed(2),
        crmCreatedDate: begin,
      })
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(crmHistoricalEvents).values(rows.slice(i, i + 500)).onConflictDoNothing()
  }
}

export async function removeDemoData(): Promise<{ teams: number; users: number; activities: number; capacityGroups: number; crmUsers: number; crmUserAlignments: number; dashboardPresets: number; notificationPrefs: number }> {
  // 1. Demo user ids.
  const demoUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%${DEMO_EMAIL_SUFFIX}`))
  const demoUserIds = demoUsers.map((u) => u.id)

  // 1a. Pre-ImpactIQ history first: its team link is ON DELETE SET NULL,
  // and a null-team row would briefly show in every team's History tab.
  await db
    .delete(crmHistoricalEvents)
    .where(sql`${crmHistoricalEvents.crmEventId} LIKE ${DEMO_HISTORY_PREFIX + '%'}`)

  await db.delete(crmLeadAccountLink).where(like(crmLeadAccountLink.leadId, `${DEMO_CRM_ID_PREFIX}%`))
  // Demo Gong calls and transcripts (their links and AI Notes go with the
  // demo activities below).
  await removeDemoGong()

  // 1b. The demo team. Its activities, memberships (the admin's included)
  // and notifications go with it. Demo data generated before v1.430 lived
  // in a real team, so the per-marker cleanup below still runs.
  let activityCount = 0
  const [demoTeam] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, DEMO_TEAM_SLUG)).limit(1)
  if (demoTeam) {
    const [row] = await db.select({ n: sql<string>`count(*)` }).from(activities).where(eq(activities.teamId, demoTeam.id))
    activityCount += Number(row?.n ?? 0)
    // Its AI Assessments would otherwise outlive it with no home team.
    await removeDemoAssessments(demoTeam.id)
    await deleteTeamCascade(demoTeam.id)
  }

  // 2. Activities: cover every path that can leave a demo-flavored row behind:
  //    a) owned by a demo user (bulk-generated activities)
  //    b) admin-owned + tagged with [DEMO] in notes
  //    c) linked to a demo Outlook fixture (outlook_event_id LIKE 'demo-outlook-%')
  //       — this catches admin approvals of suggested demo events, which get
  //       created under the caller's real user id
  //    d) linked to a demo SF fixture id (crm_what_id LIKE 'demo-opp-%' or
  //       'demo-acc-%') — catches anything the admin logged manually against
  //       a demo Opportunity/Account.
  if (demoUserIds.length > 0) {
    const deleted = await db
      .delete(activities)
      .where(inArray(activities.userId, demoUserIds))
      .returning({ id: activities.id })
    activityCount += deleted.length
  }
  const adminTagged = await db
    .delete(activities)
    .where(sql`${activities.notes} LIKE ${DEMO_ADMIN_NOTE_PREFIX + '%'}`)
    .returning({ id: activities.id })
  activityCount += adminTagged.length
  const byOutlook = await db
    .delete(activities)
    .where(sql`${activities.outlookEventId} LIKE ${'demo-outlook-%'}`)
    .returning({ id: activities.id })
  activityCount += byOutlook.length
  const bySfId = await db
    .delete(activities)
    .where(sql`${activities.crmWhatId} LIKE ${DEMO_CRM_ID_PREFIX + '%'} OR ${activities.crmWhoId} LIKE ${DEMO_CRM_ID_PREFIX + '%'}`)
    .returning({ id: activities.id })
  activityCount += bySfId.length

  // 3. Capacity group memberships (cascade via group delete below would also
  //    work, but we explicitly clear here for the audit count).
  // 4. Team memberships for demo users.
  if (demoUserIds.length > 0) {
    await db.delete(teamMembers).where(inArray(teamMembers.userId, demoUserIds))
  }

  // 4a. Sales Team Alignment rows — either owned by a demo ImpactIQ user, or
  //     referencing a demo SF user id. Covers both sides of the pair.
  let alignmentCount = 0
  if (demoUserIds.length > 0) {
    const deleted = await db
      .delete(crmUserAlignments)
      .where(inArray(crmUserAlignments.userId, demoUserIds))
      .returning({ userId: crmUserAlignments.userId })
    alignmentCount += deleted.length
  }
  const alignmentBySfu = await db
    .delete(crmUserAlignments)
    .where(sql`${crmUserAlignments.crmUserId} LIKE ${DEMO_SFU_PREFIX + '%'}`)
    .returning({ userId: crmUserAlignments.userId })
  alignmentCount += alignmentBySfu.length

  // 4a2. Demo CRM snapshots: owner cache and Attach Rate coverage, both
  // keyed by 'demo-' ids.
  await db
    .delete(sfObjectOwnerCache)
    .where(sql`${sfObjectOwnerCache.sfId} LIKE ${DEMO_CRM_ID_PREFIX + '%'}`)
  await db
    .delete(crmOpportunityCoverage)
    .where(sql`${crmOpportunityCoverage.oppId} LIKE ${DEMO_CRM_ID_PREFIX + '%'}`)

  // 4a3. Demo users' stored calendars and subteam memberships (both also go
  // with the user or the team; this covers demo data from older releases).
  await db
    .delete(outlookEvents)
    .where(sql`${outlookEvents.id} LIKE ${DEMO_OUTLOOK_PREFIX + '%'}`)
  if (demoUserIds.length > 0) {
    await db.delete(subteamUsers).where(inArray(subteamUsers.userId, demoUserIds))
  }

  // 4b. Demo SF users (by id prefix).
  const deletedSfUsers = await db
    .delete(crmUsers)
    .where(sql`${crmUsers.id} LIKE ${DEMO_SFU_PREFIX + '%'}`)
    .returning({ id: crmUsers.id })

  // 4c. Dashboard presets + notification prefs for demo users. Both would
  //     cascade with the user delete via FK, but we track counts and wipe
  //     defensively in case FK is missing on either table.
  let presetCount = 0
  let notifPrefCount = 0
  if (demoUserIds.length > 0) {
    const deletedPresets = await db
      .delete(dashboardPresets)
      .where(inArray(dashboardPresets.userId, demoUserIds))
      .returning({ id: dashboardPresets.id })
    presetCount = deletedPresets.length
    const deletedNotif = await db
      .delete(userNotificationPrefs)
      .where(inArray(userNotificationPrefs.userId, demoUserIds))
      .returning({ userId: userNotificationPrefs.userId })
    notifPrefCount = deletedNotif.length
  }

  // 5. Demo capacity and cost groups (by name prefix).
  const deletedGroups = await db
    .delete(capacityGroups)
    .where(like(capacityGroups.name, `${DEMO_GROUP_PREFIX}%`))
    .returning({ id: capacityGroups.id })
  await db.delete(costGroups).where(like(costGroups.name, `${DEMO_GROUP_PREFIX}%`))

  // 6. Demo users.
  let userCount = 0
  if (demoUserIds.length > 0) {
    const deleted = await db.delete(users).where(inArray(users.id, demoUserIds)).returning({ id: users.id })
    userCount = deleted.length
  }

  // 7. Demo products (by name prefix).
  const { products: productsTbl } = await import('../../../../drizzle/schema.js')
  await db.delete(productsTbl).where(like(productsTbl.name, `${DEMO_PRODUCT_PREFIX}%`))

  // Notifications need no step of their own: demo users' rows cascade with
  // the user, and the admin's demo-team rows cascade with the team. Real
  // users' notifications are never touched.

  // 8. Flip the demo Outlook flag off. The settings stay so the form (and
  // a later Generate) starts from them; the leader's password goes.
  const previous = await readDemoOutlookFlag()
  await setDemoOutlookFlag({ enabled: false, userIds: [], settings: previous.settings, leaderPassword: null })

  return {
    teams: demoTeam ? 1 : 0,
    users: userCount,
    activities: activityCount,
    capacityGroups: deletedGroups.length,
    crmUsers: deletedSfUsers.length,
    crmUserAlignments: alignmentCount,
    dashboardPresets: presetCount,
    notificationPrefs: notifPrefCount,
  }
}

export interface DemoLeaderStatus {
  email: string
  /** Null when the stored password can't be read (e.g. the encryption key changed). */
  password: string | null
  /** False once the password no longer signs in (someone changed it). */
  passwordWorks: boolean
}

export interface DemoDataStatus {
  team: { id: string; name: string } | null
  users: number
  activities: number
  notes: number
  ptoDays: number
  capacityGroups: number
  outlookEnabled: boolean
  /** The settings the data was last generated with (defaults when none). */
  settings: DemoSettings
  /** The demo Team Leader's sign-in, while that account exists. */
  leader: DemoLeaderStatus | null
}

// The stored settings, filled in from the defaults for anything older data
// didn't record.
export async function getDemoSettings(): Promise<DemoSettings> {
  const flag = await readDemoOutlookFlag()
  return { ...DEFAULT_DEMO_SETTINGS, ...(flag.settings ?? {}) }
}

function readStoredLeaderPassword(flag: DemoOutlookFlag): string | null {
  if (!flag.leaderPassword) return null
  try {
    return decryptToken(flag.leaderPassword)
  } catch {
    return null
  }
}

async function demoLeaderStatus(flag: DemoOutlookFlag): Promise<DemoLeaderStatus | null> {
  const [leader] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, DEMO_LEADER_EMAIL)).limit(1)
  if (!leader) return null
  const password = readStoredLeaderPassword(flag)
  const passwordWorks = !!password && !!leader.passwordHash && verifyPassword(password, leader.passwordHash)
  return { email: DEMO_LEADER_EMAIL, password, passwordWorks }
}

/**
 * Reseed: remove every demo row and generate again from the stored
 * settings (with any overrides from the form). The demo leader keeps the
 * same password, so a saved sign-in still works afterwards.
 */
export async function reseedDemoData(args: { adminUserId: string; overrides?: Partial<DemoSettings>; now?: Date }): Promise<GenerateResult> {
  const flag = await readDemoOutlookFlag()
  const settings: DemoSettings = { ...DEFAULT_DEMO_SETTINGS, ...(flag.settings ?? {}), ...(args.overrides ?? {}) }
  const leaderPassword = readStoredLeaderPassword(flag) ?? undefined
  await removeDemoData()
  return generateDemoData({
    ...settings,
    includeAdmin: true,
    adminUserId: args.adminUserId,
    leaderPassword,
    now: args.now,
  })
}

/**
 * The fixture calendar for a demo-calendar user (demo people and the admin
 * who generated), laid out with the stored settings and the user's PTO.
 * Null for everyone else, whose calendar comes from Microsoft Graph.
 */
export async function demoCalendarFor(userId: string, startIso: string, endIso: string): Promise<DemoOutlookEvent[] | null> {
  // Dates arrive from query strings, which can be arrays at runtime.
  if (typeof startIso !== 'string' || typeof endIso !== 'string') return null
  if (!(await isDemoCalendarUser(userId))) return null
  const flag = await readDemoOutlookFlag()
  const s = flag.settings ?? {}
  const [viewer] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
  const from = addDaysToDate(startIso.slice(0, 10), -1)
  const to = addDaysToDate(endIso.slice(0, 10), 1)
  const pto = await db.select({ date: userPtoDays.date }).from(userPtoDays)
    .where(and(eq(userPtoDays.userId, userId), sql`${userPtoDays.date} >= ${from}`, sql`${userPtoDays.date} <= ${to}`))
  return generateDemoOutlookEvents(startIso, endIso, userId, viewer ? { name: viewer.displayName, email: viewer.email } : null, {
    timezone: s.timezone && isValidTimeZone(s.timezone) ? s.timezone : null,
    declinedPct: s.declinedPct ?? 0,
    oooPct: s.oooPct ?? 0,
    ptoDates: new Set(pto.map((r) => r.date)),
    activityNames: cleanDemoActivityNames(s.activityNames),
  })
}

export async function demoDataStatus(): Promise<DemoDataStatus> {
  const [userRow] = await db
    .select({ n: sql<string>`count(*)` })
    .from(users)
    .where(like(users.email, `%${DEMO_EMAIL_SUFFIX}`))
  const [activityRow] = await db
    .select({ n: sql<string>`count(*)` })
    .from(activities)
    .where(sql`
      (${activities.notes} LIKE ${DEMO_ADMIN_NOTE_PREFIX + '%'})
      OR (${activities.outlookEventId} LIKE ${'demo-outlook-%'})
      OR (${activities.crmWhatId} LIKE ${'demo-opp-%'})
      OR (${activities.crmWhatId} LIKE ${'demo-acc-%'})
      OR ${activities.userId} IN (SELECT id FROM users WHERE email LIKE ${'%' + DEMO_EMAIL_SUFFIX})
    `)
  const [groupRow] = await db
    .select({ n: sql<string>`count(*)` })
    .from(capacityGroups)
    .where(like(capacityGroups.name, `${DEMO_GROUP_PREFIX}%`))

  const [team] = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.slug, DEMO_TEAM_SLUG))
    .limit(1)
  const [noteRow] = team
    ? await db.select({ n: sql<string>`count(*)` }).from(activityNotes)
        .innerJoin(activities, eq(activities.id, activityNotes.activityId))
        .where(eq(activities.teamId, team.id))
    : [{ n: '0' }]
  const [ptoRow] = await db.select({ n: sql<string>`count(*)` }).from(userPtoDays)
    .innerJoin(users, eq(users.id, userPtoDays.userId))
    .where(like(users.email, `%${DEMO_EMAIL_SUFFIX}`))

  const flag = await readDemoOutlookFlag()
  return {
    team: team ?? null,
    users: Number(userRow?.n ?? 0),
    activities: Number(activityRow?.n ?? 0),
    notes: Number(noteRow?.n ?? 0),
    ptoDays: Number(ptoRow?.n ?? 0),
    capacityGroups: Number(groupRow?.n ?? 0),
    outlookEnabled: flag.enabled === true,
    settings: { ...DEFAULT_DEMO_SETTINGS, ...(flag.settings ?? {}) },
    leader: await demoLeaderStatus(flag),
  }
}

async function readDemoOutlookFlag(): Promise<DemoOutlookFlag> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, DEMO_OUTLOOK_FLAG_KEY))
    .limit(1)
  const v = row?.value
  return v && typeof v === 'object' ? (v as DemoOutlookFlag) : {}
}

export async function isDemoOutlookEnabled(): Promise<boolean> {
  return (await readDemoOutlookFlag()).enabled === true
}

// Whether this user's calendar is served from the demo fixture instead of
// Microsoft Graph: only demo users and the admin who generated the data.
// Every other account keeps its real calendar while demo data exists.
export async function isDemoCalendarUser(userId: string): Promise<boolean> {
  const flag = await readDemoOutlookFlag()
  if (flag.enabled !== true) return false
  if (Array.isArray(flag.userIds) && flag.userIds.includes(userId)) return true
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
  return !!row && row.email.endsWith(DEMO_EMAIL_SUFFIX)
}

async function setDemoOutlookFlag(value: DemoOutlookFlag): Promise<void> {
  const existing = await db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, DEMO_OUTLOOK_FLAG_KEY))
    .limit(1)
  if (existing.length > 0) {
    await db.update(systemSettings).set({ value }).where(eq(systemSettings.key, DEMO_OUTLOOK_FLAG_KEY))
  } else {
    await db.insert(systemSettings).values({ key: DEMO_OUTLOOK_FLAG_KEY, value })
  }
}

// Synthetic Outlook calendar fixture — a per-user, non-overlapping set of
// events spread across the requested window. Used by /api/outlook/calendar
// when the demo flag is on. Seeding on userId gives each demo user their own
// distinct calendar so the person switcher shows different data.
interface DemoAttendee { name: string; email: string; response: string; type: string }
// Graph's own values: showAs free/tentative/busy/oof/workingElsewhere,
// sensitivity normal/private. A few events are cancelled, Free, private or
// all-day so those card and calendar treatments show in the demo.
export interface DemoOutlookEvent {
  id: string
  subject: string
  start: string
  end: string
  body: string | null
  bodyPreview: string | null
  isAllDay: boolean
  location: string | null
  attendees: DemoAttendee[]
  organizer: { name: string; email: string }
  responseStatus: string
  showAs: string
  isCancelled: boolean
  sensitivity: string
}

// Whether a fixture event is real work a contributor would log: not
// cancelled, not Free or out of office, not private, not all-day.
export function isLoggableDemoEvent(ev: DemoOutlookEvent): boolean {
  return !ev.isCancelled && !ev.isAllDay && ev.sensitivity === 'normal' && (ev.showAs === 'busy' || ev.showAs === 'tentative')
}

// A PTO or out-of-office day from the Demo Data settings: the person is
// away, so nothing is logged that day.
export function isAwayDemoEvent(ev: DemoOutlookEvent): boolean {
  return ev.isAllDay && ev.showAs === 'oof' && (ev.id.includes('-pto-') || ev.id.includes('-ooo-'))
}

// Options for the fixture calendar, from the Demo Data settings. All are
// optional: with none, the fixture is the UTC calendar earlier releases
// generated (meetings from 14:30 UTC, no declines, no OOO or PTO days).
export interface DemoCalendarOpts {
  /** IANA zone the working day is laid out in (meetings from 9:30 local). */
  timezone?: string | null
  /** 0-100: share of meetings the person declined (Graph `declined`, shown as Free). */
  declinedPct?: number
  /** 0-100: share of weekdays the person is out of office (all-day OOF, no meetings). */
  oooPct?: number
  /** Local dates ('YYYY-MM-DD') of the person's PTO: an all-day OOF event and no meetings. */
  ptoDates?: ReadonlySet<string> | undefined
  /** Admin-written activity names; some customer meetings are named with one. */
  activityNames?: readonly string[] | undefined
}

export function generateDemoOutlookEvents(
  startIso: string,
  endIso: string,
  userId?: string | null,
  viewer?: { name: string; email: string } | null,
  opts: DemoCalendarOpts = {},
): DemoOutlookEvent[] {
  const start = new Date(startIso)
  const end = new Date(endIso)
  const tz = opts.timezone || null
  const events: DemoOutlookEvent[] = []
  const attendeePool = [
    { name: 'Priya Nair', email: 'priya.nair@example.com' },
    { name: 'Marcus Chen', email: 'marcus.chen@example.com' },
    { name: 'Sofia Rossi', email: 'sofia.rossi@example.com' },
    { name: 'Diego Alvarez', email: 'diego.alvarez@example.com' },
    { name: 'Aiko Tanaka', email: 'aiko.tanaka@example.com' },
    { name: 'James ONeill', email: 'james.oneill@example.com' },
    { name: 'Nadia Petrov', email: 'nadia.petrov@example.com' },
  ]
  const bodyPool = [
    'Follow up on Q4 discovery findings and align on eval scope.',
    'Walk through architecture, integrations, and next-step demo focus areas.',
    'Executive review of business outcomes and roadmap.',
    'Internal sync — pipeline updates and blockers.',
    'RFP walkthrough covering technical requirements and timeline.',
    'Customer success check-in: adoption, feedback, expansion.',
  ]
  const subjectPool = [
    'Acme Inc. Discovery call',
    'BetaCo Demo prep',
    'EBR with CtrlCo',
    'Internal team sync',
    'Delta Health POC kickoff',
    'Echo Industries — Eval review',
    'Foxtrot Logistics RFP walkthrough',
    'Office hours',
    'India Pharma technical deep-dive',
    'Golf Bank success review',
    'Sales weekly',
    'Enablement session',
    '1:1 with manager',
    'Peer knowledge share',
  ]
  const owner = viewer ? { name: viewer.name, email: viewer.email } : { name: 'Demo', email: 'demo@example.com' }
  const allDayEvent = (id: string, subject: string, dayStart: Date, dayEnd: Date, showAs: string): DemoOutlookEvent => ({
    id,
    subject,
    start: dayStart.toISOString(),
    end: dayEnd.toISOString(),
    body: null,
    bodyPreview: null,
    isAllDay: true,
    location: null,
    attendees: [],
    organizer: owner,
    responseStatus: 'organizer',
    showAs,
    isCancelled: false,
    sensitivity: 'normal',
  })
  // Iterate the person's local days in the window (UTC days when no zone
  // is set), laying out 1-3 non-overlapping events per weekday. Seeded per
  // (user, day), so a day's events are the same whatever window is asked
  // for: the weekly view, the calendar panel, Scheduling and the activities
  // Generate logged against them all agree on event ids.
  const who = userId ?? 'shared'
  for (let date = localDateOf(start, tz); localToUtc(date, 0, tz).getTime() < end.getTime(); date = addDaysToDate(date, 1)) {
    const dow = dayOfWeek(date)
    if (dow === 0 || dow === 6) continue // skip weekends in fixture
    const dayStart = localToUtc(date, 0, tz)
    const dayEnd = localToUtc(addDaysToDate(date, 1), 0, tz)
    const overlapsWindow = dayEnd.getTime() > start.getTime() && dayStart.getTime() < end.getTime()
    // A second stream for the status mix, so turning it on leaves the rest
    // of the day's calendar unchanged.
    const mixRnd = seededRandom(hashString(`${who}:${date}:mix`))
    if (opts.ptoDates?.has(date)) {
      if (overlapsWindow) events.push(allDayEvent(`${DEMO_OUTLOOK_PREFIX}${who}-pto-${date}`, 'PTO', dayStart, dayEnd, 'oof'))
      continue
    }
    if (opts.oooPct && mixRnd() * 100 < opts.oooPct) {
      if (overlapsWindow) events.push(allDayEvent(`${DEMO_OUTLOOK_PREFIX}${who}-ooo-${date}`, 'Out of office', dayStart, dayEnd, 'oof'))
      continue
    }
    const rnd = seededRandom(hashString(`${who}:${date}`))
    // Its own stream again: some customer meetings are named with one of
    // the admin's activity names ("Zero Trust workshop — Acme Inc.").
    const namesRnd = seededRandom(hashString(`${who}:${date}:names`))
    const names = opts.activityNames ?? []
    const perDay = 1 + Math.floor(rnd() * 3) // 1-3
    // 9:30-10:00 local, or 14:30-15:00 UTC (≈9:30-10 EDT) with no zone.
    let cursor = (tz ? 9.5 : 14.5) + rnd() * 0.5
    const lastStart = tz ? 17 : 22
    for (let k = 0; k < perDay && cursor < lastStart; k++) {
      const durH = 0.5 + Math.floor(rnd() * 3) * 0.5 // 0.5 - 2.0
      const h = Math.floor(cursor)
      const m = Math.round((cursor - h) * 60 / 15) * 15
      const s = localToUtc(date, h + m / 60, tz)
      const e = new Date(s.getTime() + durH * 60 * 60 * 1000)
      const pooled = subjectPool[Math.floor(rnd() * subjectPool.length)]!
      const customer = SUBJECT_LINKS.find((r) => (r.opp || r.account) && pooled.includes(r.match))?.match
      const subject = customer && names.length > 0 && namesRnd() < 0.5
        ? `${names[Math.floor(namesRnd() * names.length)]!} — ${customer}`
        : pooled
      const attendeeCount = 2 + Math.floor(rnd() * 3) // 2-4
      const attendees: DemoAttendee[] = []
      const picked = new Set<number>()
      // v1.240.0: these events are on the VIEWER's own calendar, so they
      // belong on every one of them — either as organizer or as an attendee,
      // never absent. Previously neither was ever true (both drawn only from
      // the fake attendeePool), so any feature keyed off "is the current
      // user required/optional on this meeting" — the Optional/Required
      // filter, the "You: Required" badge — resolved to null for literally
      // every demo event, which read as broken rather than "no data".
      const viewerOrganizes = !!viewer && rnd() < 0.35
      // v1.241.0: these are the REAL Microsoft Graph
      // `attendee.status.response` values. The fixture previously emitted
      // 'tentative', which Graph never returns — so tentative attendees
      // rendered with the fallback icon and an untranslated raw string, and
      // no demo event could exercise the tentative path at all. (Same
      // mismatch v1.239.0 fixed on the display side; the fixture was the
      // other half of it.)
      const responseOptions = ['accepted', 'accepted', 'tentativelyAccepted', 'none', 'declined']
      if (!viewerOrganizes) {
        while (attendees.length < attendeeCount && picked.size < attendeePool.length) {
          const idx = Math.floor(rnd() * attendeePool.length)
          if (picked.has(idx)) continue
          picked.add(idx)
          const src = attendeePool[idx]!
          attendees.push({ name: src.name, email: src.email, response: responseOptions[Math.floor(rnd() * responseOptions.length)]!, type: rnd() < 0.15 ? 'optional' : 'required' })
        }
      } else {
        // Organizer never appears in their own attendees list — matches
        // Graph, and matches the manual-mark-tested path this bug came from.
        while (attendees.length < attendeeCount - 1 && picked.size < attendeePool.length) {
          const idx = Math.floor(rnd() * attendeePool.length)
          if (picked.has(idx)) continue
          picked.add(idx)
          const src = attendeePool[idx]!
          attendees.push({ name: src.name, email: src.email, response: responseOptions[Math.floor(rnd() * responseOptions.length)]!, type: rnd() < 0.15 ? 'optional' : 'required' })
        }
      }
      // The viewer's OWN RSVP — what Graph reports as the event-level
      // `responseStatus.response`, and what drives the tentative hatch.
      // 'organizer' when they own it, otherwise a real attendee response with
      // enough tentatives to be visible in a demo week, and the configured
      // share of declines.
      let viewerResponse = viewerOrganizes
        ? 'organizer'
        : (['accepted', 'accepted', 'tentativelyAccepted', 'notResponded'][Math.floor(rnd() * 4)] ?? 'accepted')
      if (!viewerOrganizes && opts.declinedPct && mixRnd() * 100 < opts.declinedPct) viewerResponse = 'declined'
      if (!viewerOrganizes && viewer) {
        attendees.push({ name: viewer.name, email: viewer.email, response: viewerResponse, type: rnd() < 0.15 ? 'optional' : 'required' })
      }
      const organizerSrc = viewerOrganizes ? viewer! : attendeePool[Math.floor(rnd() * attendeePool.length)]!
      const body = bodyPool[Math.floor(rnd() * bodyPool.length)]!
      const location = rnd() < 0.5 ? 'Microsoft Teams' : null
      cursor += durH + (10 + Math.floor(rnd() * 4) * 5) / 60 // 10-25 min gap
      const isCancelled = rnd() < 0.04
      const sensitivity = subject.startsWith('1:1') && rnd() < 0.6 ? 'private' : 'normal'
      const showAs = subject === 'Office hours' || viewerResponse === 'declined'
        ? 'free'
        : viewerResponse === 'tentativelyAccepted' ? 'tentative' : 'busy'
      // Days are generated whole; keep only events that overlap the window.
      if (e.getTime() <= start.getTime() || s.getTime() >= end.getTime()) continue
      events.push({
        id: `${DEMO_OUTLOOK_PREFIX}${who}-${s.toISOString()}`,
        subject: isCancelled ? `Canceled: ${subject}` : subject,
        start: s.toISOString(),
        end: e.toISOString(),
        body,
        bodyPreview: body,
        isAllDay: false,
        location,
        attendees,
        organizer: { name: organizerSrc.name, email: organizerSrc.email },
        responseStatus: viewerResponse,
        showAs,
        isCancelled,
        sensitivity,
      })
    }
    // About one weekday in twenty carries an all-day event.
    if (rnd() < 0.05 && overlapsWindow) {
      const ooo = rnd() < 0.5
      events.push(allDayEvent(
        `${DEMO_OUTLOOK_PREFIX}${who}-allday-${date}`,
        ooo ? 'Out of office' : 'Industry conference (all day)',
        dayStart, dayEnd, ooo ? 'oof' : 'free',
      ))
    }
  }
  return events
}
