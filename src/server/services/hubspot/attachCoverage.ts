import { eq, inArray, lt } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { attachRateFields, hubspotOwners, crmOpportunityCoverage, users } from '../../../../drizzle/schema.js'
import { isHubspotProjectObject } from '../../../shared/hubspot.js'
import { writeRun } from '../jobs/writeRun.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import {
  cullAgedCoverage, LOOKBACK_DAYS, MAX_OPPS, recordAttachRateHistory, upsertCoverageRows,
  type CoverageRefreshResult, type CoverageRow,
} from '../salesforce/refreshOppCoverage.js'
import { HubspotError } from './client.js'
import { getHubspotConfig } from './config.js'
import { getDealStagesSafe, getObjectPropertiesSafe, isOwnerProperty, ownerNames, type DealStageInfo, type PropertyInfo } from './metadata.js'
import { loadHubspotMappings, mappedProperty } from './mappings.js'
import { associationsFor, batchRead, hubspotSearch, type HubspotObject } from './search.js'
import { userIsHubspotOwner } from './owners.js'

// Attach Rate coverage on HubSpot (HubSpot plan, phase 7b): the counterpart
// of Salesforce's refresh_opp_coverage. It fills the same crm_opportunity_coverage
// snapshot from Deals, so the Attach Rate dashboard, its Compare/trend and the
// weekly view's "touched" tiles work unchanged.
//
// Which fields count as "SE attached" is the team's Admin → Attach Rate
// fields config, on HubSpot naming either a Deal property (object `deals`)
// or a property on the team's Project object (`0-970` or a custom object
// `2-…`), rolled up onto every Deal that Project is associated with. HubSpot
// relates records by association, so the Salesforce "link field" isn't used.
//
// Values are stored as people read them, because the dashboard credits a
// value either by Salesforce User Id or by name:
//   - an owner ("HubSpot user") property → the ImpactIQ user whose email
//     matches the owner's (their display name, so the roster match is exact),
//     else the owner's own name;
//   - an enumeration → its option labels;
//   - anything else → the raw text, split on `;` like Salesforce multi-selects.
//
// Deals in scope: every open Deal plus any created or closed in the last two
// years, the Salesforce query's scope. Paged by record id (hs_object_id
// ascending, `GT` the last id seen) instead of the search API's `after`
// cursor, which stops at 10,000 results. Every run is a full refresh, so a
// row this run didn't see (a deleted Deal, or a leftover from another CRM) is
// dropped afterwards, but only when the scan finished cleanly.

const JOB_KEY = 'refresh_hubspot_opp_coverage'
const PAGE = 100
const DEALS = 'deals'
const DEAL_CORE = ['dealname', 'createdate', 'closedate', 'dealstage', 'hs_manual_forecast_category', 'hs_is_closed', 'hubspot_owner_id', 'amount']
const PROPERTY_RX = /^[A-Za-z0-9_]{1,80}$/

function prop(o: HubspotObject | undefined, name: string): string | null {
  const v = o?.properties?.[name]
  return v == null || v === '' ? null : String(v)
}

function numText(v: string | null): string | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : null
}

interface FieldPlan {
  // Deal properties to read, and per related object the properties to fold in.
  deal: string[]
  related: Map<string, string[]>
}

async function loadFieldPlan(errors: string[]): Promise<FieldPlan> {
  const rows = await db.select({ fieldApi: attachRateFields.fieldApi, crmObject: attachRateFields.crmObject })
    .from(attachRateFields).where(eq(attachRateFields.isActive, true))
  const deal = new Set<string>()
  const related = new Map<string, Set<string>>()
  for (const r of rows) {
    const obj = r.crmObject ?? ''
    if (!PROPERTY_RX.test(r.fieldApi)) continue
    if (obj === DEALS) deal.add(r.fieldApi)
    else if (isHubspotProjectObject(obj)) related.set(obj, (related.get(obj) ?? new Set()).add(r.fieldApi))
  }
  // Drop properties the portal doesn't have, so one typo can't fail the run.
  const keep = async (object: string, names: Set<string>): Promise<string[]> => {
    const props = await getObjectPropertiesSafe(object)
    if (props.size === 0) return [...names]
    const out: string[] = []
    for (const n of names) {
      if (props.has(n)) out.push(n)
      else errors.push(`${object}: unknown property ${n}`)
    }
    return out
  }
  const plan: FieldPlan = { deal: await keep(DEALS, deal), related: new Map() }
  for (const [obj, names] of related) {
    const kept = await keep(obj, names)
    if (kept.length > 0) plan.related.set(obj, kept)
  }
  return plan
}

// Owner id → the matched ImpactIQ user's display name, else the owner's name.
async function ownerDisplayNames(ids: Iterable<string>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)]
  const out = await ownerNames(wanted)
  if (wanted.length === 0) return out
  const matched = await db.select({ id: hubspotOwners.id, name: users.displayName })
    .from(hubspotOwners)
    .innerJoin(users, userIsHubspotOwner)
    .where(inArray(hubspotOwners.id, wanted))
  for (const m of matched) if (m.name) out.set(m.id, m.name)
  return out
}

function splitValues(raw: string | null): string[] {
  if (!raw) return []
  return [...new Set(raw.split(';').map((s) => s.trim()).filter(Boolean))]
}

// The values one property holds on one record, as the dashboard reads them.
// Owner ids are left as-is here and swapped for names in one pass per page.
export function readAttachValues(info: PropertyInfo | undefined, raw: string | null): { values: string[]; ownerIds: string[] } {
  const parts = splitValues(raw)
  if (parts.length === 0) return { values: [], ownerIds: [] }
  if (info && isOwnerProperty(info)) return { values: parts, ownerIds: parts.filter((p) => /^[0-9]+$/.test(p)) }
  if (info && info.options.size > 0) return { values: [...new Set(parts.map((p) => info.options.get(p) ?? p))], ownerIds: [] }
  return { values: parts, ownerIds: [] }
}

function dealSearchBody(lastId: string, cutoffMs: number, properties: string[]) {
  const after = { propertyName: 'hs_object_id', operator: 'GT', value: lastId }
  const cutoff = String(cutoffMs)
  return {
    limit: PAGE,
    properties,
    sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' as const }],
    filterGroups: [
      { filters: [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }, after] },
      { filters: [{ propertyName: 'hs_is_closed', operator: 'NOT_HAS_PROPERTY' }, after] },
      { filters: [{ propertyName: 'createdate', operator: 'GTE', value: cutoff }, after] },
      { filters: [{ propertyName: 'closedate', operator: 'GTE', value: cutoff }, after] },
    ],
  }
}

interface PageContext {
  stages: Map<string, DealStageInfo>
  dealProps: Map<string, PropertyInfo>
  relatedProps: Map<string, Map<string, PropertyInfo>>
  plan: FieldPlan
  acvProperty: string | null
  startedAt: Date
}

// One page of Deals → coverage rows, with related-object values folded in.
async function pageToRows(deals: HubspotObject[], ctx: PageContext, errors: string[]): Promise<CoverageRow[]> {
  const dealIds = deals.map((d) => String(d.id))
  const pending = new Map<string, Record<string, string[]>>()
  const ownerIds = new Set<string>()
  const ownerKeys = new Set<string>()
  const add = (dealId: string, key: string, info: PropertyInfo | undefined, raw: string | null) => {
    const { values, ownerIds: ids } = readAttachValues(info, raw)
    if (values.length === 0) return
    if (ids.length > 0) ownerKeys.add(key)
    ids.forEach((id) => ownerIds.add(id))
    const fv = pending.get(dealId) ?? {}
    fv[key] = [...new Set([...(fv[key] ?? []), ...values])]
    pending.set(dealId, fv)
  }
  for (const d of deals) {
    for (const f of ctx.plan.deal) add(String(d.id), `${DEALS}::${f}`, ctx.dealProps.get(f), prop(d, f))
  }
  for (const [obj, fields] of ctx.plan.related) {
    try {
      const byDeal = await associationsFor(DEALS, obj, dealIds)
      const relatedIds = [...new Set([...byDeal.values()].flat())]
      if (relatedIds.length === 0) continue
      const records = await batchRead(obj, relatedIds, fields)
      const props = ctx.relatedProps.get(obj) ?? new Map<string, PropertyInfo>()
      for (const [dealId, ids] of byDeal) {
        for (const id of ids) {
          const rec = records.get(id)
          if (!rec) continue
          for (const f of fields) add(dealId, `${obj}::${f}`, props.get(f), prop(rec, f))
        }
      }
    } catch (err) {
      if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
      errors.push(`rel_${obj}: ${err instanceof HubspotError ? err.code : String(err)}`)
    }
  }
  const dealOwners = deals.map((d) => prop(d, 'hubspot_owner_id')).filter((v): v is string => !!v)
  const names = await ownerDisplayNames([...ownerIds, ...dealOwners])
  return deals.map((d) => {
    const id = String(d.id)
    const fv = pending.get(id) ?? {}
    for (const [key, vals] of Object.entries(fv)) {
      if (ownerKeys.has(key)) fv[key] = [...new Set(vals.map((v) => names.get(v) ?? v))]
    }
    const stageId = prop(d, 'dealstage')
    const stage = stageId ? ctx.stages.get(stageId) : undefined
    const closedFlag = prop(d, 'hs_is_closed')
    const forecast = prop(d, 'hs_manual_forecast_category')
    const ownerId = prop(d, 'hubspot_owner_id')
    return {
      oppId: id,
      createdDate: prop(d, 'createdate')?.slice(0, 10) ?? null,
      closeDate: prop(d, 'closedate')?.slice(0, 10) ?? null,
      stageName: stage?.label ?? stageId,
      forecastCategory: forecast ? (ctx.dealProps.get('hs_manual_forecast_category')?.options.get(forecast) ?? forecast) : null,
      isClosed: closedFlag != null ? closedFlag === 'true' : !!stage?.isClosed,
      ownerId,
      ownerName: ownerId ? (names.get(ownerId) ?? null) : null,
      amount: numText(prop(d, 'amount')),
      totalAcv: ctx.acvProperty ? numText(prop(d, ctx.acvProperty)) : null,
      oppName: prop(d, 'dealname'),
      fieldValues: fv,
      snapshotAt: ctx.startedAt,
    }
  })
}

// Null when there's nothing to do (no HubSpot connection, or no Attach Rate
// field configured for HubSpot), so a quiet tick writes no run row.
export async function refreshHubspotOppCoverage(): Promise<CoverageRefreshResult | null> {
  if (!(await getHubspotConfig())) return null
  const startedAt = new Date()
  const result: CoverageRefreshResult = { fieldsUsed: [], oppsScanned: 0, oppsStored: 0, errors: [], durationMs: 0 }
  const plan = await loadFieldPlan(result.errors)
  if (plan.deal.length === 0 && plan.related.size === 0) return null
  result.fieldsUsed = [...plan.deal.map((f) => `${DEALS}::${f}`), ...[...plan.related].flatMap(([o, fs]) => fs.map((f) => `${o}::${f}`))]

  const mappings = await loadHubspotMappings(null, [DEALS])
  const acvProperty = mappedProperty(mappings, DEALS, 'acv')
  const ctx: PageContext = {
    stages: await getDealStagesSafe(),
    dealProps: await getObjectPropertiesSafe(DEALS),
    relatedProps: new Map(await Promise.all([...plan.related.keys()].map(async (o) => [o, await getObjectPropertiesSafe(o)] as const))),
    plan,
    acvProperty: acvProperty && PROPERTY_RX.test(acvProperty) ? acvProperty : null,
    startedAt,
  }
  const properties = [...new Set([...DEAL_CORE, ...plan.deal, ...(ctx.acvProperty ? [ctx.acvProperty] : [])])]
  const cutoffMs = startedAt.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000

  let lastId = '0'
  let complete = false
  try {
    while (result.oppsScanned < MAX_OPPS) {
      const deals = await hubspotSearch(DEALS, dealSearchBody(lastId, cutoffMs, properties))
      if (deals.length === 0) { complete = true; break }
      const rows = await pageToRows(deals, ctx, result.errors)
      result.oppsScanned += rows.length
      const up = await upsertCoverageRows(rows)
      result.oppsStored += up.stored
      result.errors.push(...up.errors)
      lastId = String(deals[deals.length - 1]!.id)
      if (deals.length < PAGE) { complete = true; break }
    }
  } catch (err) {
    result.errors.push(`query: ${err instanceof HubspotError ? err.code : err instanceof Error ? err.message : String(err)}`)
  }

  // A full, clean scan replaces the table: anything it didn't touch is gone
  // from HubSpot (or came from another CRM).
  if (complete && !result.errors.some((e) => e.startsWith('upsert_'))) {
    try {
      await db.delete(crmOpportunityCoverage).where(lt(crmOpportunityCoverage.snapshotAt, startedAt))
    } catch (e) {
      result.errors.push(`stale: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try { await cullAgedCoverage(startedAt) } catch (e) { result.errors.push(`cull: ${e instanceof Error ? e.message : String(e)}`) }
  try { await recordAttachRateHistory(startedAt) } catch (e) { result.errors.push(`history: ${e instanceof Error ? e.message : String(e)}`) }

  result.durationMs = Date.now() - startedAt.getTime()
  const message = result.errors.length > 0 ? result.errors[0] ?? null : `${result.oppsStored}/${result.oppsScanned} deals stored`
  await writeRun(JOB_KEY, startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}

// The dashboard's "Primary" tier: on Salesforce the Assigned_SE__c field; on
// HubSpot the Deal property a scope team maps as its Assigned SE.
export async function hubspotPrimaryAttachKey(teamIds: readonly string[], keys: readonly string[]): Promise<string | null> {
  for (const teamId of teamIds) {
    const rows = await loadHubspotMappings(teamId, [DEALS])
    for (const appField of ['assigned_se_write', 'assigned_se_name']) {
      const property = mappedProperty(rows, DEALS, appField)
      const key = property ? `${DEALS}::${property}` : null
      if (key && keys.includes(key)) return key
    }
  }
  return null
}

let stopFn: (() => void) | null = null
export function startHubspotOppCoverageWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, 24 * 60 * 60 * 1000, async () => {
    if (!(await isCrmProviderActive('hubspot'))) return
    await refreshHubspotOppCoverage().catch((err) => {
      console.error('[hubspot-coverage] run failed:', err)
    })
  }, { firstRunDelayMs: 120 * 1000 })
}
