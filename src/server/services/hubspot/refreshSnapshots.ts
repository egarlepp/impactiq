import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, crmSnapshotState } from '../../../../drizzle/schema.js'
import { getEvaluationSourceSetting } from '../criteriaiq/evaluationSource.js'
import { crmProjectsActive } from '../../../shared/evaluationSource.js'
import { refreshHubspotProjectSnapshots } from './projects.js'
import { repointMergedLinks, resolveHubspotRecords } from './linkHealth.js'
import type { CrmRefreshResult } from '../crm/types.js'
import type { RelinkSnapshotPatch } from '../salesforce/relinkOpportunity.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import { writeRun } from '../jobs/writeRun.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { bulkUpsertLeadLinks } from '../salesforce/refreshOppSnapshots.js'
import { HubspotError } from './client.js'
import { getHubspotConfig } from './config.js'
import { getDealStagesSafe, getObjectPropertiesSafe, optionLabel, ownerNames, resolveOwnerValue, type DealStageInfo, type PropertyInfo } from './metadata.js'
import { loadHubspotMappings, mappedProperty } from './mappings.js'
import { batchRead, primaryAssociations, type HubspotObject } from './search.js'

// Nightly Deal snapshot refresh for HubSpot installs (HubSpot plan, phase 3):
// the counterpart of Salesforce's refresh_opp_snapshots. It keeps the same
// snapshot columns on `activities` current (stage, forecast, amount, closed/
// won, close date, owner, Assigned SE / Primary Engineer), so every dashboard
// filter and figure that reads them works unchanged on HubSpot.
//
// Values are stored as people read them: the stage LABEL (not HubSpot's
// stage id), the forecast option label, owner names. That matches what the
// activity form saves from a Deal search result, so a filter value picked on
// the dashboard matches rows saved either way.
//
// Also refreshed, unlike Salesforce's job: the Deal's primary Company
// (crm_account_id / crm_account_name). HubSpot re-associates a Deal with a
// different Company far more casually than Salesforce reparents an
// Opportunity, and every Account rollup reads these columns.
//
// Reads use HubSpot's batch read (100 ids per call) rather than search, so
// the 4-per-second search limit never applies; there's no incremental
// watermark because batch read can't filter by modified date, and 100 deals
// per call keeps even a large install to a few dozen calls a night.
//
// Leads (Sales Hub Professional+): each linked Lead's primary Company goes
// into crm_lead_account_link, the cache the Most Expensive Account rollup
// reads, same as a converted Salesforce Lead's account.

const JOB_KEY = 'refresh_hubspot_snapshots'
const BATCH = 100

const DEAL_CORE = ['dealstage', 'amount', 'closedate', 'hubspot_owner_id', 'hs_manual_forecast_category', 'hs_is_closed', 'hs_is_closed_won']

export interface DealSnapshotPatch {
  id: string
  salesStage: string | null
  forecastCategory: string | null
  oppAmount: string | null
  crmIsClosed: boolean
  crmIsWon: boolean
  crmOppOwnerId: string | null
  crmOppOwnerName: string | null
  crmOppCloseDate: string | null
  crmAssignedSeName: string | null
  crmPrimaryEngineerName: string | null
  crmAccountId: string | null
  crmAccountName: string | null
}

function prop(o: HubspotObject, name: string): string | null {
  const v = o.properties?.[name]
  return v == null || v === '' ? null : String(v)
}

function numOrNull(v: string | null): string | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : null
}

// An SE property is usually a "HubSpot user" property holding owner ids;
// any other enumeration reads as its option label.
async function seValue(props: Map<string, PropertyInfo>, property: string | null, raw: string | null): Promise<string | null> {
  if (!property || raw == null) return null
  const info = props.get(property)
  const labelled = info && info.options.size > 0 ? optionLabel(props, property, raw) : raw
  return resolveOwnerValue(labelled)
}

// One Deal → the snapshot columns. Pure apart from owner-name lookups.
export async function dealToPatch(
  deal: HubspotObject,
  ctx: {
    stages: Map<string, DealStageInfo>
    props: Map<string, PropertyInfo>
    owners: Map<string, string>
    assignedSeProperty: string | null
    primaryEngineerProperty: string | null
    company: { id: string; name: string | null } | null
  },
): Promise<DealSnapshotPatch> {
  const stageId = prop(deal, 'dealstage')
  const stage = stageId ? ctx.stages.get(stageId) : undefined
  const closedFlag = prop(deal, 'hs_is_closed')
  const wonFlag = prop(deal, 'hs_is_closed_won')
  const ownerId = prop(deal, 'hubspot_owner_id')
  const closeDate = prop(deal, 'closedate')
  return {
    id: String(deal.id),
    salesStage: stage?.label ?? stageId,
    forecastCategory: optionLabel(ctx.props, 'hs_manual_forecast_category', prop(deal, 'hs_manual_forecast_category')),
    oppAmount: numOrNull(prop(deal, 'amount')),
    // HubSpot's own calculated flags first; the stage metadata on a portal
    // that hides them.
    crmIsClosed: closedFlag != null ? closedFlag === 'true' : (stage?.isClosed ?? false),
    crmIsWon: wonFlag != null ? wonFlag === 'true' : (stage?.isWon ?? false),
    crmOppOwnerId: ownerId,
    crmOppOwnerName: ownerId ? (ctx.owners.get(ownerId) ?? null) : null,
    crmOppCloseDate: closeDate ? closeDate.slice(0, 10) : null,
    crmAssignedSeName: await seValue(ctx.props, ctx.assignedSeProperty, ctx.assignedSeProperty ? prop(deal, ctx.assignedSeProperty) : null),
    crmPrimaryEngineerName: await seValue(ctx.props, ctx.primaryEngineerProperty, ctx.primaryEngineerProperty ? prop(deal, ctx.primaryEngineerProperty) : null),
    crmAccountId: ctx.company?.id ?? null,
    crmAccountName: ctx.company?.name ?? null,
  }
}

async function bulkUpdateDealPatches(rows: DealSnapshotPatch[]): Promise<void> {
  if (rows.length === 0) return
  const values = sql.join(
    rows.map((r) => sql`(${r.id}, ${r.salesStage}, ${r.forecastCategory}, ${r.oppAmount}, ${r.crmIsClosed}, ${r.crmIsWon}, ${r.crmOppOwnerId}, ${r.crmOppOwnerName}, ${r.crmOppCloseDate}, ${r.crmAssignedSeName}, ${r.crmPrimaryEngineerName}, ${r.crmAccountId}, ${r.crmAccountName})`),
    sql`, `,
  )
  // A Deal read without its Company association (the association call
  // failed, or the Deal has none) keeps the Company it was saved with.
  await db.execute(sql`
    UPDATE activities AS a SET
      sales_stage = v.sales_stage,
      forecast_category = v.forecast_category,
      opp_amount = v.opp_amount::numeric,
      crm_is_closed = v.crm_is_closed::boolean,
      crm_is_won = v.crm_is_won::boolean,
      crm_snapshot_refreshed_at = now(),
      crm_opp_owner_id = v.crm_opp_owner_id,
      crm_opp_owner_name = v.crm_opp_owner_name,
      crm_opp_close_date = v.crm_opp_close_date::date,
      crm_assigned_se_name = v.crm_assigned_se_name,
      crm_primary_engineer_name = v.crm_primary_engineer_name,
      crm_account_id = COALESCE(v.crm_account_id, a.crm_account_id),
      crm_account_name = CASE WHEN v.crm_account_id IS NULL THEN a.crm_account_name ELSE COALESCE(v.crm_account_name, a.crm_account_name) END
    FROM (VALUES ${values}) AS v(id, sales_stage, forecast_category, opp_amount, crm_is_closed, crm_is_won, crm_opp_owner_id, crm_opp_owner_name, crm_opp_close_date, crm_assigned_se_name, crm_primary_engineer_name, crm_account_id, crm_account_name)
    WHERE a.crm_what_type = 'Opportunity' AND a.crm_what_id = v.id
  `)
}

// Company id + name for each Deal; an association failure leaves the batch
// without Companies rather than failing it.
async function companiesFor(fromType: string, ids: string[]): Promise<Map<string, { id: string; name: string | null }>> {
  const out = new Map<string, { id: string; name: string | null }>()
  try {
    const assoc = await primaryAssociations(fromType, 'companies', ids)
    const companies = assoc.size > 0 ? await batchRead('companies', [...assoc.values()], ['name']) : new Map<string, HubspotObject>()
    for (const [from, companyId] of assoc) {
      const company = companies.get(companyId)
      out.set(from, { id: companyId, name: company ? prop(company, 'name') : null })
    }
  } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
  }
  return out
}

async function linkedIds(kind: 'deals' | 'leads'): Promise<string[]> {
  const rows = kind === 'deals'
    ? await db.selectDistinct({ id: activities.crmWhatId }).from(activities).where(and(
      eq(activities.crmWhatType, 'Opportunity'), eq(activities.isArchived, false), sql`${activities.crmWhatId} IS NOT NULL`,
    ))
    : await db.selectDistinct({ id: activities.crmWhoId }).from(activities).where(and(
      eq(activities.crmWhoType, 'Lead'), eq(activities.isArchived, false), sql`${activities.crmWhoId} IS NOT NULL`,
    ))
  // Ids saved while Salesforce was the CRM are never sent to HubSpot.
  return rows.map((r) => r.id).filter((id): id is string => !!id && HUBSPOT_ID_RX.test(id))
}

function errorText(err: unknown): string {
  if (err instanceof HubspotError) return err.code
  return err instanceof Error ? err.message : String(err)
}

export async function refreshHubspotSnapshots(opts?: { source?: 'scheduled' | 'manual' }): Promise<CrmRefreshResult> {
  const startedAt = new Date()
  const result: CrmRefreshResult = { oppsScanned: 0, oppsUpdated: 0, leadsScanned: 0, leadsLinked: 0, evalsScanned: 0, evalsUpdated: 0, errors: [], durationMs: 0, source: opts?.source ?? 'scheduled' }
  const cfg = await getHubspotConfig()
  if (!cfg) {
    result.errors.push('errors.hubspot.not_configured')
    await writeRun(JOB_KEY, startedAt, 'error', 'errors.hubspot.not_configured', result)
    return result
  }

  let aborted = false
  const dealIds = await linkedIds('deals')
  result.oppsScanned = dealIds.length
  if (dealIds.length > 0) {
    const mappings = await loadHubspotMappings(null, ['deals'])
    const assignedSeProperty = mappedProperty(mappings, 'deals', 'assigned_se_name')
    const primaryEngineerProperty = mappedProperty(mappings, 'deals', 'primary_engineer_name')
    const properties = [...new Set([...DEAL_CORE, ...[assignedSeProperty, primaryEngineerProperty].filter((p): p is string => !!p)])]
    const [stages, props] = await Promise.all([getDealStagesSafe(), getObjectPropertiesSafe('deals').catch(() => new Map<string, PropertyInfo>())])
    for (let i = 0; i < dealIds.length && !aborted; i += BATCH) {
      const chunk = dealIds.slice(i, i + BATCH)
      try {
        // A Deal that no longer exists comes back in HubSpot's `errors`, not
        // `results`, and its activities keep their last snapshot (the
        // link-health job flags it). A merged Deal answers as the surviving
        // Deal: its activities move to that id first, then get its snapshot.
        const resolved = await resolveHubspotRecords('deals', chunk, properties)
        await repointMergedLinks('what', 'deals', resolved.merged)
        const deals = [...new Map([...resolved.records.values()].map((d) => [String(d.id), d])).values()]
        const [companies, owners] = await Promise.all([
          companiesFor('deals', deals.map((d) => String(d.id))),
          ownerNames(deals.map((d) => prop(d, 'hubspot_owner_id'))),
        ])
        const patches: DealSnapshotPatch[] = []
        for (const deal of deals) {
          patches.push(await dealToPatch(deal, { stages, props, owners, assignedSeProperty, primaryEngineerProperty, company: companies.get(String(deal.id)) ?? null }))
        }
        await bulkUpdateDealPatches(patches)
        result.oppsUpdated += patches.length
      } catch (err) {
        result.errors.push(`deal_batch_${i}: ${errorText(err)}`)
        console.error('[hubspot-refresh] deal batch failed:', err)
        // A rejected token fails every later call the same way.
        if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') aborted = true
      }
    }
  }

  // Leads: skipped when the last access check found the portal has none.
  const leadsMissing = cfg.lastCheck?.capabilities.find((c) => c.key === 'leads_read')?.status === 'missing'
  const leadIds = aborted || leadsMissing ? [] : await linkedIds('leads')
  result.leadsScanned = leadIds.length
  for (let i = 0; i < leadIds.length; i += BATCH) {
    const chunk = leadIds.slice(i, i + BATCH)
    try {
      // Not companiesFor(): a failed association read must write nothing,
      // not clear every link in the batch.
      const companyFor = await primaryAssociations('leads', 'companies', chunk)
      await bulkUpsertLeadLinks(chunk.map((leadId) => ({ leadId, accountId: companyFor.get(leadId) ?? null })))
      result.leadsLinked += chunk.filter((id) => companyFor.has(id)).length
    } catch (err) {
      result.errors.push(`lead_batch_${i}: ${errorText(err)}`)
      if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') break
    }
  }

  // Projects linked on HubSpot (phase 6b): the Project object's records, with
  // the "link broken" flag for one HubSpot no longer has. Skipped while
  // Projects come from CriteriaIQ or are off: nothing new links then.
  if (!aborted && crmProjectsActive((await getEvaluationSourceSetting()).primary)) {
    try {
      const projects = await refreshHubspotProjectSnapshots()
      result.evalsScanned = projects.scanned
      result.evalsUpdated = projects.updated
      result.errors.push(...projects.errors)
    } catch (err) {
      result.errors.push(`projects: ${errorText(err)}`)
    }
  }

  // Same state row Salesforce's job writes: the dashboard's Refresh button
  // reads it for "last refreshed", and only one CRM is ever active.
  const lastError = result.errors.length > 0 ? result.errors.join(' | ') : null
  await db.insert(crmSnapshotState).values({ key: 'opp_snapshot', refreshedAt: new Date(), lastError })
    .onConflictDoUpdate({ target: crmSnapshotState.key, set: { refreshedAt: new Date(), lastError } })

  result.durationMs = Date.now() - startedAt.getTime()
  const message = result.errors.length > 0
    ? result.errors[0] ?? null
    : `${result.oppsUpdated}/${result.oppsScanned} deals updated, ${result.leadsLinked}/${result.leadsScanned} leads linked, ${result.evalsUpdated}/${result.evalsScanned} projects updated`
  await writeRun(JOB_KEY, startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}

// One Deal read live, for Opportunity Relink on HubSpot (phase 7): the same
// snapshot the nightly refresh writes, plus the Deal's id and name. A merged
// Deal answers as the surviving Deal, so its id is what gets linked. Null
// when HubSpot says the Deal doesn't exist; other failures throw.
export async function readHubspotDealForRelink(dealId: string): Promise<RelinkSnapshotPatch | null> {
  const mappings = await loadHubspotMappings(null, ['deals'])
  const assignedSeProperty = mappedProperty(mappings, 'deals', 'assigned_se_name')
  const primaryEngineerProperty = mappedProperty(mappings, 'deals', 'primary_engineer_name')
  const properties = [...new Set(['dealname', ...DEAL_CORE, ...[assignedSeProperty, primaryEngineerProperty].filter((p): p is string => !!p)])]
  const resolved = await resolveHubspotRecords('deals', [dealId], properties)
  const deal = resolved.records.get(dealId)
  if (!deal) return null
  const [stages, props, companies, owners] = await Promise.all([
    getDealStagesSafe(),
    getObjectPropertiesSafe('deals').catch(() => new Map<string, PropertyInfo>()),
    companiesFor('deals', [String(deal.id)]),
    ownerNames([prop(deal, 'hubspot_owner_id')]),
  ])
  const { id, ...patch } = await dealToPatch(deal, { stages, props, owners, assignedSeProperty, primaryEngineerProperty, company: companies.get(String(deal.id)) ?? null })
  return { crmWhatId: id, crmWhatName: prop(deal, 'dealname') ?? id, ...patch }
}

let stopFn: (() => void) | null = null

// 24h, a quiet no-op (no job_runs row) unless HubSpot is the install's CRM
// and connected. First run a minute after boot, like Salesforce's job.
export function startHubspotSnapshotWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, 24 * 60 * 60 * 1000, async () => {
    if (!(await isCrmProviderActive('hubspot'))) return
    if (!(await getHubspotConfig())) return
    await refreshHubspotSnapshots().catch((err) => {
      console.error('[hubspot-refresh] run failed:', err)
    })
  }, { firstRunDelayMs: 60 * 1000 })
}
