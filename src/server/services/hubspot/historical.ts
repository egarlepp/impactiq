import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activities,
  hubspotOwners,
  crmHistoricalImportRuns,
  crmHistoricalOpportunities,
  teamActivityTypeCrmExtras,
} from '../../../../drizzle/schema.js'
import { HUBSPOT_ID_RX, isHubspotProjectObject } from '../../../shared/hubspot.js'
import { crmProjectsActive } from '../../../shared/evaluationSource.js'
import { getEvaluationSourceSetting } from '../criteriaiq/evaluationSource.js'
import { writeRun } from '../jobs/writeRun.js'
import { estimateHours, resolveEventLinkage, type LinkageMaps } from '../salesforce/historical/linkage.js'
import { isExcluded, type ExclusionSet } from '../salesforce/historical/exclusions.js'
import {
  emptyStats,
  filterUnknownIds,
  insertHistoricalAccounts,
  upsertHistoricalOpportunities,
  writeHistoricalEvents,
  type HistoricalAccountRow,
  type HistoricalOppRow,
  type SliceStats,
  type StagedHistoricalEvent,
} from '../salesforce/historical/store.js'
import { HubspotError } from './client.js'
import { getDealStagesSafe, getObjectPropertiesSafe, optionLabel, ownerNames, type DealStageInfo, type PropertyInfo } from './metadata.js'
import { loadHubspotMappings, mappedProperties, mappedProperty } from './mappings.js'
import { projectLabelProperty } from './projects.js'
import { associationsFor, batchRead, hubspotSearch, primaryAssociations, type HubspotObject } from './search.js'

// The historical import on HubSpot (HubSpot plan, phase 8a): the counterpart
// of the Salesforce Event backfill in services/salesforce/historical/. The
// walker, its state, exclusions, relink and every screen that reads history
// are shared; only fetching a slice differs, and the rows land in the same
// crm_historical_* tables under HubSpot's own record ids.
//
// Meetings only, by decision (2026-10-23): no calls, emails, tasks or notes.
// See docs/crm-providers.md, "Historical import scope".
//
// A slice is HubSpot meetings whose hs_timestamp falls inside it, read with
// the CRM search API paged by record id (hs_object_id GT the last id seen,
// ascending), so a slice holding more than HubSpot's 10,000-result search
// cap still reads completely. Kept: meetings associated with a Deal, a
// Company, or a configured Project object (the same scope as Salesforce's
// Opportunity / Account / Evaluation Events). Skipped: meetings ImpactIQ
// itself wrote back (their id is on an activity), since that work is already
// in ImpactIQ.
//
// Field choices, none tuned to one portal:
// - what: the Deal first, then a Project record, then the Company. The
//   Account is the meeting's own Company, else the Deal's primary Company.
// - type: the meeting property a team maps as `activity_type` (what write-back
//   fills), else HubSpot's `hs_activity_type`. The raw value is kept, so the
//   admin type map and Relink resolve it exactly as they do Salesforce types.
// - owner: hubspot_owner_id, which Sales Team Alignment's copy of the owner
//   list in crm_users lets the linkage match to an ImpactIQ user by email.
// - created by: the owner whose HubSpot user created the meeting; else
//   `user:<HubSpot user id>`; else `source:<hs_object_source_id>` (an app or
//   integration, the Outreach case). Exclusion rules take these same values.
// - HubSpot has no all-day meetings; one 24 hours or longer is treated as
//   all-day so the admin's all-day cap applies to its estimate.

const PAGE = 200 // the search API's maximum page size
const MEETINGS = 'meetings'

const MEETING_CORE = [
  'hs_meeting_title',
  'hs_timestamp',
  'hs_meeting_start_time',
  'hs_meeting_end_time',
  'hubspot_owner_id',
  'hs_created_by_user_id',
  'hs_object_source',
  'hs_object_source_id',
  'hs_object_source_label',
  'hs_object_source_detail_1',
  'hs_meeting_body',
  'hs_meeting_location',
  'hs_activity_type',
  'hs_createdate',
  'hs_lastmodifieddate',
]

const DEAL_DETAIL = ['dealname', 'dealstage', 'amount', 'closedate', 'createdate', 'hubspot_owner_id', 'hs_manual_forecast_category', 'hs_is_closed', 'hs_is_closed_won']

const PROPERTY_RX = /^[A-Za-z0-9_]{1,100}$/
const ACTOR_SAFE_RX = /[^A-Za-z0-9_.:-]/g

export interface HubspotProjectTarget {
  objectTypeId: string
  labelProperty: string
}

export interface HubspotHistoricalContext {
  /** Meeting properties teams map as `activity_type`, in a stable order. */
  typeProperties: string[]
  projectTargets: HubspotProjectTarget[]
  acvProperty: string | null
  stages: Map<string, DealStageInfo>
  dealProps: Map<string, PropertyInfo>
  companyProps: Map<string, PropertyInfo>
}

function prop(o: HubspotObject | undefined, name: string): string | null {
  const v = o?.properties?.[name]
  return v == null || v === '' ? null : String(v).trim() || null
}

function ts(v: string | null): Date | null {
  if (!v) return null
  const d = new Date(/^[0-9]+$/.test(v) ? Number(v) : v)
  return Number.isNaN(d.getTime()) ? null : d
}

function numText(v: string | null): string | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : null
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

// Meeting notes are HTML in HubSpot; history shows plain text.
export function htmlToText(html: string | null): string | null {
  if (!html) return null
  let stripped = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
  // Strip tags until none are left: one pass over "<scr<b>ipt>" would leave
  // "<script>" behind.
  let previous: string
  do {
    previous = stripped
    stripped = stripped.replace(/<[^>]*>/g, '')
  } while (stripped !== previous)
  const text = stripped
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

/** The value Created By exclusions and the Top creators panel use. */
export function createdByKey(
  meeting: HubspotObject,
  ownerByUserId: Map<string, string>,
): string | null {
  const userId = prop(meeting, 'hs_created_by_user_id')
  if (userId) return ownerByUserId.get(userId) ?? `user:${userId.replace(ACTOR_SAFE_RX, '')}`
  const source = prop(meeting, 'hs_object_source_id') ?? prop(meeting, 'hs_object_source')
  if (source) {
    const clean = source.replace(ACTOR_SAFE_RX, '').slice(0, 100)
    return clean ? `source:${clean}` : null
  }
  return null
}

function createdByName(meeting: HubspotObject, key: string | null, names: Map<string, string>): string | null {
  if (!key) return null
  if (!key.includes(':')) return names.get(key) ?? null
  return prop(meeting, 'hs_object_source_detail_1') ?? prop(meeting, 'hs_object_source_label') ?? null
}

/** The activity type value: the first mapped meeting property with a value, else hs_activity_type. */
export function meetingTypeValue(meeting: HubspotObject, typeProperties: readonly string[]): string | null {
  for (const p of typeProperties) {
    const v = prop(meeting, p)
    if (v) return v
  }
  return prop(meeting, 'hs_activity_type')
}

export async function prepareHubspotHistorical(): Promise<HubspotHistoricalContext> {
  const meetingMappings = await loadHubspotMappings(null, [MEETINGS])
  const typeProperties = mappedProperties(meetingMappings, MEETINGS, 'activity_type').filter((p) => PROPERTY_RX.test(p)).sort()
  const dealMappings = await loadHubspotMappings(null, ['deals'])
  const acv = mappedProperty(dealMappings, 'deals', 'acv')

  const projectTargets: HubspotProjectTarget[] = []
  if (crmProjectsActive((await getEvaluationSourceSetting()).primary)) {
    const extras = await db.select({ config: teamActivityTypeCrmExtras.config })
      .from(teamActivityTypeCrmExtras)
      .where(eq(teamActivityTypeCrmExtras.kind, 'related_object_picker'))
    const seen = new Set<string>()
    for (const e of extras) {
      const cfg = (e.config ?? {}) as { sobject?: unknown; labelField?: unknown }
      const sobject = typeof cfg.sobject === 'string' ? cfg.sobject : null
      if (!isHubspotProjectObject(sobject) || seen.has(sobject)) continue
      seen.add(sobject)
      projectTargets.push({ objectTypeId: sobject, labelProperty: projectLabelProperty(sobject, typeof cfg.labelField === 'string' ? cfg.labelField : null) })
    }
  }

  return {
    typeProperties,
    projectTargets,
    acvProperty: acv && PROPERTY_RX.test(acv) ? acv : null,
    stages: await getDealStagesSafe(),
    dealProps: await getObjectPropertiesSafe('deals'),
    companyProps: await getObjectPropertiesSafe('companies'),
  }
}

function sliceSearchBody(from: Date, to: Date, lastId: string, properties: string[]) {
  return {
    limit: PAGE,
    properties,
    sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' as const }],
    filterGroups: [{
      filters: [
        { propertyName: 'hs_timestamp', operator: 'GTE', value: String(from.getTime()) },
        { propertyName: 'hs_timestamp', operator: 'LT', value: String(to.getTime()) },
        { propertyName: 'hs_object_id', operator: 'GT', value: lastId },
      ],
    }],
  }
}

// Project-object associations are optional: a portal without the scope (or
// an object since removed) simply contributes none, never fails the slice.
async function projectAssociations(target: HubspotProjectTarget, ids: string[]): Promise<Map<string, string[]>> {
  try {
    return await associationsFor(MEETINGS, target.objectTypeId, ids)
  } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
    return new Map()
  }
}

async function primaryCompanies(dealIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < dealIds.length; i += 100) {
    for (const [k, v] of await primaryAssociations('deals', 'companies', dealIds.slice(i, i + 100))) out.set(k, v)
  }
  return out
}

async function alreadyInImpactIq(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.select({ id: activities.crmRecordId }).from(activities).where(inArray(activities.crmRecordId, ids))
  return new Set(rows.map((r) => r.id).filter((v): v is string => !!v))
}

async function ownerIdsByUserId(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (userIds.length === 0) return out
  const rows = await db.select({ id: hubspotOwners.id, userId: hubspotOwners.hubspotUserId })
    .from(hubspotOwners).where(inArray(hubspotOwners.hubspotUserId, [...new Set(userIds)]))
  for (const r of rows) if (r.userId) out.set(r.userId, r.id)
  return out
}

interface PageResult {
  staged: StagedHistoricalEvent[]
  owners: Map<string, string>
  dealIds: Set<string>
  companyIds: Set<string>
}

// One search page of meetings → staged history rows.
async function stagePage(
  meetings: HubspotObject[],
  ctx: HubspotHistoricalContext,
  maps: LinkageMaps,
  exclusions: ExclusionSet,
  runId: string | null,
  stats: SliceStats,
): Promise<PageResult> {
  const out: PageResult = { staged: [], owners: new Map(), dealIds: new Set(), companyIds: new Set() }
  const ids = meetings.map((m) => String(m.id))
  const known = await alreadyInImpactIq(ids)
  const userIds = meetings.map((m) => prop(m, 'hs_created_by_user_id')).filter((v): v is string => !!v)
  const ownerByUserId = await ownerIdsByUserId(userIds)

  // Exclusions first, so excluded meetings cost no association reads.
  const candidates: HubspotObject[] = []
  for (const m of meetings) {
    const id = String(m.id)
    if (!id || known.has(id)) { stats.eventsSkipped += 1; continue }
    if (isExcluded(exclusions, createdByKey(m, ownerByUserId), prop(m, 'hubspot_owner_id'))) { stats.eventsExcluded += 1; continue }
    candidates.push(m)
  }
  if (candidates.length === 0) return out
  const candIds = candidates.map((m) => String(m.id))

  stats.crmApiCalls += 2
  const deals = await associationsFor(MEETINGS, 'deals', candIds)
  const companies = await associationsFor(MEETINGS, 'companies', candIds)
  const projects = new Map<string, { target: HubspotProjectTarget; id: string }>()
  for (const target of ctx.projectTargets) {
    stats.crmApiCalls += 1
    for (const [meetingId, recIds] of await projectAssociations(target, candIds)) {
      if (!projects.has(meetingId) && recIds[0]) projects.set(meetingId, { target, id: recIds[0] })
    }
  }

  const kept = candidates.filter((m) => {
    const id = String(m.id)
    return deals.has(id) || companies.has(id) || projects.has(id)
  })
  stats.eventsSkipped += candidates.length - kept.length
  if (kept.length === 0) return out
  const keptIds = kept.map((m) => String(m.id))

  stats.crmApiCalls += 1
  const contacts = await associationsFor(MEETINGS, 'contacts', keptIds)
  const dealIds = [...new Set(keptIds.map((id) => deals.get(id)?.[0]).filter((v): v is string => !!v))]
  const dealCompany = dealIds.length > 0 ? await primaryCompanies(dealIds) : new Map<string, string>()
  if (dealIds.length > 0) stats.crmApiCalls += Math.ceil(dealIds.length / 100)

  // Names for the "what" records, one batch read per object.
  const meetingCompanyIds = keptIds.map((id) => companies.get(id)?.[0]).filter((v): v is string => !!v)
  const companyIds = [...new Set([...meetingCompanyIds, ...dealCompany.values()])]
  const dealRecords = dealIds.length > 0 ? await batchRead('deals', dealIds, ['dealname']) : new Map<string, HubspotObject>()
  const companyRecords = companyIds.length > 0 ? await batchRead('companies', companyIds, ['name']) : new Map<string, HubspotObject>()
  stats.crmApiCalls += Math.ceil(dealIds.length / 100) + Math.ceil(companyIds.length / 100)
  const projectNames = new Map<string, string>()
  for (const target of ctx.projectTargets) {
    const recIds = [...new Set([...projects.values()].filter((p) => p.target === target).map((p) => p.id))]
    if (recIds.length === 0) continue
    stats.crmApiCalls += Math.ceil(recIds.length / 100)
    try {
      for (const [id, rec] of await batchRead(target.objectTypeId, recIds, [target.labelProperty])) {
        const name = prop(rec, target.labelProperty)
        if (name) projectNames.set(`${target.objectTypeId}:${id}`, name)
      }
    } catch (err) {
      if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
    }
  }

  const createdKeys = new Map(kept.map((m) => [String(m.id), createdByKey(m, ownerByUserId)] as const))
  const names = await ownerNames([
    ...kept.map((m) => prop(m, 'hubspot_owner_id')),
    ...[...createdKeys.values()].filter((k): k is string => !!k && !k.includes(':')),
  ])

  for (const m of kept) {
    const id = String(m.id)
    const dealId = deals.get(id)?.[0] ?? null
    const project = projects.get(id) ?? null
    const companyId = companies.get(id)?.[0] ?? (dealId ? dealCompany.get(dealId) ?? null : null)
    let whatId: string
    let whatType: string
    let whatName: string | null
    if (dealId) {
      whatId = dealId; whatType = 'Opportunity'; whatName = prop(dealRecords.get(dealId), 'dealname')
      out.dealIds.add(dealId)
    } else if (project) {
      whatId = project.id; whatType = project.target.objectTypeId; whatName = projectNames.get(`${project.target.objectTypeId}:${project.id}`) ?? null
    } else {
      whatId = companyId!; whatType = 'Account'; whatName = prop(companyRecords.get(companyId!), 'name')
    }
    if (companyId) out.companyIds.add(companyId)

    const ownerId = prop(m, 'hubspot_owner_id')
    const ownerName = ownerId ? names.get(ownerId) ?? null : null
    if (ownerId && ownerName) out.owners.set(ownerId, ownerName)
    const typeValue = meetingTypeValue(m, ctx.typeProperties)
    const link = resolveEventLinkage(maps, ownerId, typeValue)
    if (link.userId) stats.usersMatched += 1
    else {
      stats.usersUnmatched += 1
      if (ownerId && ownerName && Object.keys(stats.unmatchedOwnerSamples).length < 50) stats.unmatchedOwnerSamples[ownerId] = ownerName
    }
    if (link.activityTypeId) stats.typesMatched += 1
    else {
      stats.typesUnmatched += 1
      const k = typeValue ?? '(none)'
      stats.unmatchedTypeSamples[k] = (stats.unmatchedTypeSamples[k] ?? 0) + 1
    }

    const start = ts(prop(m, 'hs_meeting_start_time')) ?? ts(prop(m, 'hs_timestamp'))
    const end = ts(prop(m, 'hs_meeting_end_time'))
    const durationMinutes = start && end && end.getTime() > start.getTime() ? Math.round((end.getTime() - start.getTime()) / 60000) : null
    const isAllDayEvent = durationMinutes != null && durationMinutes >= 1440
    const createdKey = createdKeys.get(id) ?? null

    out.staged.push({
      crmEventId: id,
      subject: prop(m, 'hs_meeting_title'),
      crmType: typeValue,
      activityDate: start ? start.toISOString().slice(0, 10) : null,
      startDatetime: start,
      endDatetime: end,
      durationMinutes,
      isAllDayEvent,
      isRecurrence: false,
      ownerCrmUserId: ownerId,
      ownerCrmUserName: ownerName,
      createdByCrmUserId: createdKey,
      createdByCrmUserName: createdByName(m, createdKey, names),
      whatId,
      whatType,
      whatName,
      whoId: contacts.get(id)?.[0] ?? null,
      accountId: companyId,
      description: htmlToText(prop(m, 'hs_meeting_body')),
      location: prop(m, 'hs_meeting_location'),
      crmCreatedDate: ts(prop(m, 'hs_createdate')),
      crmSystemModstamp: ts(prop(m, 'hs_lastmodifieddate')),
      userId: link.userId,
      teamId: link.teamId,
      activityTypeId: link.activityTypeId,
      userMatchMethod: link.userMatchMethod,
      typeMatchMethod: link.typeMatchMethod,
      estimatedHours: estimateHours(durationMinutes, isAllDayEvent, maps.allDayCapHours),
      importRunId: runId,
    })
  }
  return out
}

/** Deal → the historical Opportunity row. Closed Deals are frozen at once. */
export function dealToHistoricalRow(
  deal: HubspotObject,
  ctx: Pick<HubspotHistoricalContext, 'stages' | 'dealProps' | 'acvProperty'>,
  company: { id: string; name: string | null } | null,
  owners: Map<string, string>,
): HistoricalOppRow {
  const stageId = prop(deal, 'dealstage')
  const stage = stageId ? ctx.stages.get(stageId) : undefined
  const closedFlag = prop(deal, 'hs_is_closed')
  const wonFlag = prop(deal, 'hs_is_closed_won')
  const isClosed = closedFlag != null ? closedFlag === 'true' : (stage?.isClosed ?? false)
  const ownerId = prop(deal, 'hubspot_owner_id')
  return {
    oppId: String(deal.id),
    oppName: prop(deal, 'dealname'),
    accountId: company?.id ?? null,
    accountName: company?.name ?? null,
    stageName: stage?.label ?? stageId,
    forecastCategory: optionLabel(ctx.dealProps, 'hs_manual_forecast_category', prop(deal, 'hs_manual_forecast_category')),
    isClosed,
    isWon: wonFlag != null ? wonFlag === 'true' : (stage?.isWon ?? false),
    amount: numText(prop(deal, 'amount')),
    totalAcv: ctx.acvProperty ? numText(prop(deal, ctx.acvProperty)) : null,
    closeDate: prop(deal, 'closedate')?.slice(0, 10) ?? null,
    createdDate: prop(deal, 'createdate')?.slice(0, 10) ?? null,
    ownerId,
    ownerName: ownerId ? owners.get(ownerId) ?? null : null,
    frozenAt: isClosed ? new Date() : null,
  }
}

async function readDealRows(ids: string[], ctx: HubspotHistoricalContext, stats?: SliceStats): Promise<HistoricalOppRow[]> {
  if (ids.length === 0) return []
  const properties = [...DEAL_DETAIL, ...(ctx.acvProperty ? [ctx.acvProperty] : [])]
  const deals = await batchRead('deals', ids, properties)
  if (deals.size === 0) return []
  const dealCompany = await primaryCompanies([...deals.keys()])
  const companies = dealCompany.size > 0 ? await batchRead('companies', [...new Set(dealCompany.values())], ['name']) : new Map<string, HubspotObject>()
  if (stats) stats.crmApiCalls += Math.ceil(ids.length / 100) * 2 + Math.ceil(companies.size / 100)
  const owners = await ownerNames([...deals.values()].map((d) => prop(d, 'hubspot_owner_id')))
  return [...deals.values()].map((d) => {
    const companyId = dealCompany.get(String(d.id))
    return dealToHistoricalRow(d, ctx, companyId ? { id: companyId, name: prop(companies.get(companyId), 'name') } : null, owners)
  })
}

async function readCompanyRows(ids: string[], ctx: HubspotHistoricalContext, stats: SliceStats): Promise<HistoricalAccountRow[]> {
  if (ids.length === 0) return []
  const companies = await batchRead('companies', ids, ['name', 'hubspot_owner_id', 'industry'])
  stats.crmApiCalls += Math.ceil(ids.length / 100)
  return [...companies.values()].map((c) => ({
    accountId: String(c.id),
    name: prop(c, 'name'),
    ownerId: prop(c, 'hubspot_owner_id'),
    industry: optionLabel(ctx.companyProps, 'industry', prop(c, 'industry')),
  }))
}

/**
 * Fetches, resolves and (unless dryRun) writes one time slice of HubSpot
 * meetings. Same contract as the Salesforce ingestSlice: a thrown error fails
 * the slice and the walker leaves the cursor where it was.
 */
export async function ingestHubspotSlice(
  ctx: HubspotHistoricalContext,
  maps: LinkageMaps,
  exclusions: ExclusionSet,
  sliceFrom: Date,
  sliceTo: Date,
  runId: string | null,
  dryRun: boolean,
): Promise<SliceStats> {
  const stats = emptyStats()
  const properties = [...new Set([...MEETING_CORE, ...ctx.typeProperties])]
  const staged: StagedHistoricalEvent[] = []
  const owners = new Map<string, string>()
  const dealIds = new Set<string>()
  const companyIds = new Set<string>()

  let lastId = '0'
  for (;;) {
    stats.crmApiCalls += 1
    const page = await hubspotSearch(MEETINGS, sliceSearchBody(sliceFrom, sliceTo, lastId, properties))
    if (page.length === 0) break
    stats.eventsFetched += page.length
    const res = await stagePage(page, ctx, maps, exclusions, runId, stats)
    staged.push(...res.staged)
    for (const [k, v] of res.owners) owners.set(k, v)
    res.dealIds.forEach((id) => dealIds.add(id))
    res.companyIds.forEach((id) => companyIds.add(id))
    lastId = String(page[page.length - 1]!.id)
    if (page.length < PAGE) break
  }

  if (dryRun) return stats

  stats.eventsInserted += await writeHistoricalEvents(staged, owners)
  stats.oppsUpserted += await upsertHistoricalOpportunities(await readDealRows(await filterUnknownIds(dealIds, 'opp'), ctx, stats))
  stats.accountsUpserted += await insertHistoricalAccounts(await readCompanyRows(await filterUnknownIds(companyIds, 'account'), ctx, stats))
  return stats
}

// ── Nightly refresh of open historical Deals ────────────────────────────────

export interface HubspotHistoricalDealRefreshResult {
  candidates: number
  refreshed: number
  frozen: number
  errors: string[]
  durationMs: number
}

const REFRESH_MAX = 5000

/**
 * The HubSpot side of refresh_historical_opps: re-reads every historical Deal
 * that hasn't closed (100 per batch read) and freezes the ones that have. A
 * Deal HubSpot no longer returns keeps its stored row. Null when there's
 * nothing to refresh, so a quiet night writes no run row.
 */
export async function refreshHubspotHistoricalDeals(jobKey: string): Promise<HubspotHistoricalDealRefreshResult | null> {
  const startedAt = new Date()
  const rows = await db.select({ oppId: crmHistoricalOpportunities.oppId })
    .from(crmHistoricalOpportunities)
    .where(isNull(crmHistoricalOpportunities.frozenAt))
    .orderBy(sql`${crmHistoricalOpportunities.refreshedAt} ASC`)
    .limit(REFRESH_MAX)
  // Ids saved while Salesforce was the CRM are never sent to HubSpot.
  const ids = rows.map((r) => r.oppId).filter((id) => HUBSPOT_ID_RX.test(id))
  if (ids.length === 0) return null

  const result: HubspotHistoricalDealRefreshResult = { candidates: ids.length, refreshed: 0, frozen: 0, errors: [], durationMs: 0 }
  const ctx = await prepareHubspotHistorical()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const fresh = await readDealRows(chunk, ctx)
      await upsertHistoricalOpportunities(fresh)
      result.refreshed += fresh.length
      result.frozen += fresh.filter((r) => r.isClosed).length
      // Rows HubSpot didn't return still rotate to the back of the queue.
      await db.update(crmHistoricalOpportunities).set({ refreshedAt: new Date() })
        .where(and(inArray(crmHistoricalOpportunities.oppId, chunk), isNull(crmHistoricalOpportunities.frozenAt)))
    } catch (err) {
      const code = err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)
      result.errors.push(`chunk_${i}: ${code}`)
      if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') break
    }
  }
  result.durationMs = Date.now() - startedAt.getTime()

  try {
    await db.insert(crmHistoricalImportRuns).values({
      status: result.errors.length > 0 ? 'error' : 'ok',
      kind: 'opp_refresh',
      startedAt,
      finishedAt: new Date(),
      durationMs: result.durationMs,
      oppsUpserted: result.refreshed,
      error: result.errors[0] ?? null,
      detail: { candidates: result.candidates, frozen: result.frozen, errors: result.errors, provider: 'hubspot' },
    })
  } catch {
    // Never let run auditing break the job.
  }
  const message = result.errors.length > 0
    ? result.errors[0] ?? null
    : `${result.refreshed}/${result.candidates} deals refreshed, ${result.frozen} newly frozen (closed)`
  await writeRun(jobKey, startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}
