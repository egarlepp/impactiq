import type jsforce from 'jsforce'
import { desc, eq, and, or, inArray, sql, ilike, type SQL } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, users } from '../../../../drizzle/schema.js'
import { safeSoqlLiteral } from './soql.js'
import { filterKnownFields } from './soqlHelpers.js'
import { CORE_SELECT, collectExtraSelect, resolveAppFieldPaths, resolveFieldPath, ASSIGNED_SE_FALLBACK_FIELD, PRIMARY_ENGINEER_FALLBACK_FIELD } from './refreshOppSnapshots.js'

// v1.218.0: backing reads for the inline SF record preview — the popover an
// SE gets by hovering the Opportunity / Account name on an activity card.
//
// Two sources, in this order:
//   1. The local snapshot already on `activities` (written by the form at
//      save time and kept current by the nightly refresh_opp_snapshots job).
//      Always available, costs one indexed SELECT, and works for a
//      contributor who has never connected Salesforce.
//   2. A live read over the requesting user's OWN SF connection. Never the
//      admin connection — this is a contributor-facing surface, and the
//      admin connection is reserved for admin pages and headless jobs.
//
// The live read is best-effort: any failure (not connected, revoked token,
// SF down, field the org doesn't have) degrades to the snapshot with
// `source: 'snapshot'` rather than erroring the popover. A preview that
// shows slightly stale data beats a preview that shows a red box.

export type PreviewType = 'Opportunity' | 'Account'

/** 15- or 18-char Salesforce Id. Anything else never reaches SOQL. */
export const SF_ID_RX = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/

export interface SfPreview {
  id: string
  type: PreviewType
  name: string | null
  // Opportunity
  accountId: string | null
  accountName: string | null
  stageName: string | null
  forecastCategory: string | null
  amount: string | null
  acv: string | null
  closeDate: string | null
  isClosed: boolean | null
  isWon: boolean | null
  ownerName: string | null
  assignedSeName: string | null
  primaryEngineerName: string | null
  // v1.293.0: Total Bookings breakdown — live-only (no persisted snapshot
  // column), so these are null unless the caller has a working SF
  // connection and the team's admin has mapped the 4 app fields under
  // Admin -> SF Field Mappings. Backs the Opportunity Info panel's
  // expandable business-breakdown section on the activity form.
  newBusinessAcv: string | null
  newBusinessTcv: string | null
  renewalAcv: string | null
  renewalTcv: string | null
  // Account
  industry: string | null
  accountType: string | null
  website: string | null
  city: string | null
  country: string | null
  // Provenance
  source: 'live' | 'snapshot'
  /** When source === 'snapshot': when that snapshot was last refreshed. */
  asOf: string | null
}

function emptyPreview(id: string, type: PreviewType): SfPreview {
  return {
    id, type, name: null,
    accountId: null, accountName: null, stageName: null, forecastCategory: null,
    amount: null, acv: null, closeDate: null, isClosed: null, isWon: null,
    ownerName: null, assignedSeName: null, primaryEngineerName: null,
    newBusinessAcv: null, newBusinessTcv: null, renewalAcv: null, renewalTcv: null,
    industry: null, accountType: null, website: null, city: null, country: null,
    source: 'snapshot', asOf: null,
  }
}

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v)
  return s.length > 0 ? s : null
}

function num(v: unknown): string | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : null
}

// ── Snapshot ───────────────────────────────────────────────────────────

/**
 * Newest local snapshot for this CRM record, drawn from an activity that
 * links to it. Ordered by refresh time so the row the nightly job touched
 * most recently wins over one that has only the save-time values.
 *
 * v1.425.0 (security audit L7): only from activities the viewer may read,
 * their own (draft or submitted) or a submitted one on a team they can see
 * (`getAccessibleTeamIds()`). It used to read any team's activity, so a
 * record id alone exposed another team's deal values.
 */
function snapshotVisibleTo(viewer: SnapshotViewer): SQL {
  const own = eq(activities.userId, viewer.userId)
  if (viewer.teamIds.length === 0) return own
  return or(own, and(inArray(activities.teamId, viewer.teamIds), eq(activities.status, 'submitted')))!
}

export interface SnapshotViewer {
  userId: string
  teamIds: string[]
}

export async function readSnapshot(id: string, type: PreviewType, viewer: SnapshotViewer): Promise<SfPreview> {
  const out = emptyPreview(id, type)
  const [row] = await db
    .select({
      name: activities.crmWhatName,
      accountId: activities.crmAccountId,
      accountName: activities.crmAccountName,
      stageName: activities.salesStage,
      forecastCategory: activities.forecastCategory,
      amount: activities.oppAmount,
      acv: activities.acv,
      closeDate: activities.crmOppCloseDate,
      formCloseDate: activities.oppCloseDate,
      isClosed: activities.crmIsClosed,
      isWon: activities.crmIsWon,
      ownerName: activities.crmOppOwnerName,
      assignedSeName: activities.crmAssignedSeName,
      primaryEngineerName: activities.crmPrimaryEngineerName,
      refreshedAt: activities.crmSnapshotRefreshedAt,
    })
    .from(activities)
    .where(and(eq(activities.crmWhatId, id), eq(activities.crmWhatType, type), snapshotVisibleTo(viewer)))
    // NULLS LAST: a row the refresh job has touched beats one that only has
    // the values the form captured at save time.
    .orderBy(sql`${activities.crmSnapshotRefreshedAt} DESC NULLS LAST`, desc(activities.updatedAt))
    .limit(1)
  if (!row) return out
  out.name = row.name
  out.asOf = row.refreshedAt ? row.refreshedAt.toISOString() : null
  if (type === 'Account') {
    // An Account-linked activity puts the Account in crmWhatName; the
    // sfAccount* columns are the Opportunity's parent and don't apply.
    out.accountId = id
    out.accountName = row.name
    return out
  }
  out.accountId = row.accountId
  out.accountName = row.accountName
  out.stageName = row.stageName
  out.forecastCategory = row.forecastCategory
  out.amount = row.amount
  out.acv = row.acv
  out.closeDate = row.closeDate ?? row.formCloseDate
  out.isClosed = row.isClosed
  out.isWon = row.isWon
  out.ownerName = row.ownerName
  out.assignedSeName = row.assignedSeName
  out.primaryEngineerName = row.primaryEngineerName
  return out
}

// ── Live ───────────────────────────────────────────────────────────────

// Account fields are all standard, but still run through filterKnownFields —
// a field can be removed from a profile's FLS, which fails the query the same
// way a missing field does.
const ACCOUNT_CORE = [
  'Id', 'Name', 'OwnerId', 'Owner.Name', 'Industry', 'Type', 'Website',
  'BillingCity', 'BillingCountry',
]

// The Opportunity SELECT is CORE_SELECT (shared with refresh_opp_snapshots)
// plus the three display fields the refresh job doesn't need because it
// snapshots them elsewhere.
const OPP_EXTRA_DISPLAY = ['Name', 'AccountId', 'Account.Name']

// Resolving the SELECT list costs a describe() plus a mappings read. Without
// a cache that's two extra round-trips per hover, which is a real API-limit
// problem on a surface designed to be glanced at. Field metadata changes on
// the scale of deploys, so an hour is generous.
const FIELDS_TTL_MS = 60 * 60 * 1000
const fieldsCache = new Map<PreviewType, { at: number; fields: string[] }>()

async function resolveFields(conn: jsforce.Connection, type: PreviewType): Promise<string[]> {
  const core = type === 'Opportunity' ? [...CORE_SELECT, ...OPP_EXTRA_DISPLAY] : ACCOUNT_CORE
  const hit = fieldsCache.get(type)
  if (hit && Date.now() - hit.at < FIELDS_TTL_MS) return hit.fields
  try {
    const configuredExtras = await collectExtraSelect(type, core)
    const extras = type === 'Opportunity'
      ? Array.from(new Set([...configuredExtras, ASSIGNED_SE_FALLBACK_FIELD, PRIMARY_ENGINEER_FALLBACK_FIELD]))
      : configuredExtras
    const fields = await filterKnownFields(conn, type, [...core, ...extras])
    // Don't cache a degenerate result — filterKnownFields returns its input
    // unchanged when describe() fails, and an empty list would poison the
    // cache for an hour.
    if (fields.length > 0) fieldsCache.set(type, { at: Date.now(), fields })
    return fields
  } catch {
    // describe / mapping lookup failed — fall back to the core list, which is
    // standard fields only and safe on any org. Not cached, so a transient
    // failure doesn't cost the custom fields for the next hour.
    return core
  }
}

/**
 * Reads the record live over `conn`. Returns null on any failure so the
 * caller falls back to the snapshot.
 */
export async function readLive(
  conn: jsforce.Connection,
  id: string,
  type: PreviewType,
): Promise<SfPreview | null> {
  const fields = await resolveFields(conn, type)
  if (fields.length === 0) return null
  const soql = `SELECT ${fields.join(', ')} FROM ${type} WHERE Id = '${safeSoqlLiteral(id)}' LIMIT 1`
  let rec: Record<string, unknown> | undefined
  try {
    const q = await conn.query<Record<string, unknown>>(soql)
    rec = q.records[0]
  } catch {
    return null
  }
  if (!rec) return null

  const out = emptyPreview(id, type)
  out.source = 'live'
  out.name = str(rec['Name'])
  const owner = rec['Owner'] as { Name?: unknown } | null | undefined
  out.ownerName = str(owner?.Name)
  if (type === 'Account') {
    out.accountId = id
    out.accountName = out.name
    out.industry = str(rec['Industry'])
    out.accountType = str(rec['Type'])
    out.website = str(rec['Website'])
    out.city = str(rec['BillingCity'])
    out.country = str(rec['BillingCountry'])
    return out
  }
  const acct = rec['Account'] as { Name?: unknown } | null | undefined
  out.accountId = str(rec['AccountId'])
  out.accountName = str(acct?.Name)
  out.stageName = str(rec['StageName'])
  out.forecastCategory = str(rec['ForecastCategoryName'])
  out.amount = num(rec['Amount'])
  // Total_Acv__c is the ACV figure the rest of the app filters on, but it's a
  // custom field — present only if the org has it and an admin mapped it.
  out.acv = num(rec['Total_Acv__c']) ?? null
  out.closeDate = str(rec['CloseDate'])
  out.isClosed = rec['IsClosed'] === true
  out.isWon = rec['IsWon'] === true
  const appFieldPaths = await resolveAppFieldPaths()
  const assignedSePath = appFieldPaths.get('assigned_se_name')
  const primaryEngineerPath = appFieldPaths.get('primary_engineer_name')
  out.assignedSeName = (assignedSePath ? resolveFieldPath(rec, assignedSePath) : null) ?? resolveFieldPath(rec, ASSIGNED_SE_FALLBACK_FIELD)
  out.primaryEngineerName = (primaryEngineerPath ? resolveFieldPath(rec, primaryEngineerPath) : null) ?? resolveFieldPath(rec, PRIMARY_ENGINEER_FALLBACK_FIELD)
  // v1.293.0: no fallback field for these — inert until an admin maps them,
  // same convention as eval_engineer_notes/eval_primary_engineer (§9).
  const newBusinessAcvPath = appFieldPaths.get('opp_new_business_acv')
  const newBusinessTcvPath = appFieldPaths.get('opp_new_business_tcv')
  const renewalAcvPath = appFieldPaths.get('opp_renewal_acv')
  const renewalTcvPath = appFieldPaths.get('opp_renewal_tcv')
  out.newBusinessAcv = newBusinessAcvPath ? num(resolveFieldPath(rec, newBusinessAcvPath)) : null
  out.newBusinessTcv = newBusinessTcvPath ? num(resolveFieldPath(rec, newBusinessTcvPath)) : null
  out.renewalAcv = renewalAcvPath ? num(resolveFieldPath(rec, renewalAcvPath)) : null
  out.renewalTcv = renewalTcvPath ? num(resolveFieldPath(rec, renewalTcvPath)) : null
  return out
}

/**
 * Merges a live read over the snapshot. Live wins field-by-field rather than
 * wholesale: an org that hasn't mapped Total_Acv__c or Assigned_SE__r would
 * otherwise *lose* those values on hover, having shown them a moment earlier
 * from the snapshot.
 */
export function mergePreview(snapshot: SfPreview, live: SfPreview | null): SfPreview {
  if (!live) return snapshot
  const out: Record<string, unknown> = { ...snapshot, source: 'live', asOf: null }
  for (const [k, v] of Object.entries(live)) {
    if (k === 'source' || k === 'asOf') continue
    if (v != null) out[k] = v
  }
  return out as unknown as SfPreview
}

// v1.277.0: is there an ImpactIQ user with this exact display name? Used to
// flag a credited SF person (Assigned SE / Primary Engineer) shown on the
// preview who has no ImpactIQ account, so the client can render them in
// red — same "not in ImpactIQ" idea as the Attach Rate dashboard.
//
// Matched by NAME rather than Salesforce User Id: Assigned_SE__c /
// Primary_Engineer__c are admin-configurable field API paths (via
// crm_field_mappings), and neither this preview's snapshot columns
// (crm_assigned_se_name / crm_primary_engineer_name) nor the live SOQL here
// persist the underlying User Id today — only the relationship's Name.
// Re-deriving an `.Id` SOQL path from an arbitrary configured `.Name` path
// would need its own describe()-driven resolution; a name lookup is a
// reasonable, much cheaper stand-in for a "glance" surface like this one.
// Collision risk (two different people sharing a display name) exists but
// is low for a single team's roster.
export async function isImpactIqUserName(name: string | null): Promise<boolean | null> {
  if (!name) return null
  const [row] = await db.select({ id: users.id }).from(users).where(ilike(users.displayName, name)).limit(1)
  return !!row
}
