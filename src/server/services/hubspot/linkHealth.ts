import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '../../db/index.js'
import { activities } from '../../../../drizzle/schema.js'
import { HUBSPOT_ID_RX, isHubspotProjectObject } from '../../../shared/hubspot.js'
import { logSystemAudit } from '../audit/log.js'
import { isCrmProviderActive } from '../crm/providerSetting.js'
import { scheduleJob } from '../jobs/scheduler.js'
import { writeRun } from '../jobs/writeRun.js'
import { HubspotError, hubspotJson } from './client.js'
import { getHubspotConfig } from './config.js'
import type { HubspotObject } from './search.js'

// Link health on HubSpot (HubSpot plan, phase 7): the counterpart of
// Salesforce's detect_disconnected_links job and the drawer's live check
// (CLAUDE.md §7, "Activities Disconnected from SF"), plus merge handling,
// which Salesforce has no equivalent of.
//
// When two HubSpot records are merged, HubSpot keeps one record (on Deals it
// even creates a new id) and every read of an old id answers with the
// surviving record, listing the old ids in `hs_merged_object_ids`. Checked
// live on a developer portal (2026-10-22): a batch read of a merged-away Deal
// id returns the surviving Deal once, under its own id. So a merged id is not
// a broken link: ImpactIQ moves every activity on it to the surviving id
// (HubSpot already moved the associations on its side) and logs that. Only
// an id HubSpot reports as OBJECT_NOT_FOUND counts as gone. A failed request
// changes nothing: absent from a failed fetch is not the same as deleted.

const BATCH = 100
const JOB_KEY = 'hubspot_detect_disconnected_links'

export type LinkSlot = 'what' | 'who' | 'related'

// The HubSpot object an ImpactIQ link type lives on, or null when the link
// isn't a HubSpot CRM record ImpactIQ can check (Campaigns are marketing
// assets with UUID ids, read through a different API).
export function hubspotObjectForLink(slot: LinkSlot, type: string | null | undefined): string | null {
  if (!type) return null
  if (slot === 'what') return type === 'Opportunity' ? 'deals' : type === 'Account' ? 'companies' : null
  if (slot === 'who') return type === 'Contact' ? 'contacts' : type === 'Lead' ? 'leads' : null
  return isHubspotProjectObject(type) ? type : null
}

export interface RecordResolution {
  // Keyed by the id asked for; a merged id maps to the surviving record.
  records: Map<string, HubspotObject>
  // Asked-for id → surviving id, for ids HubSpot merged into another record.
  merged: Map<string, string>
  // Ids HubSpot reported as not found.
  gone: Set<string>
}

interface BatchReadResponse {
  results?: HubspotObject[]
  errors?: Array<{ category?: unknown; context?: { ids?: unknown } }>
}

function mergedIdsOf(o: HubspotObject): string[] {
  const raw = o.properties?.['hs_merged_object_ids']
  if (raw == null || raw === '') return []
  return String(raw).split(';').map((s) => s.trim()).filter(Boolean)
}

// Batch-reads ids (100 per call) and sorts each into found, merged or gone.
// An id in none of the three (HubSpot answered without mentioning it) is
// left unknown. Throws when a request fails, so callers can leave state alone.
export async function resolveHubspotRecords(objectType: string, ids: string[], properties: string[]): Promise<RecordResolution> {
  const out: RecordResolution = { records: new Map(), merged: new Map(), gone: new Set() }
  const unique = [...new Set(ids)]
  const props = [...new Set([...properties, 'hs_merged_object_ids'])]
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH)
    const asked = new Set(chunk)
    const res = await hubspotJson<BatchReadResponse>(`/crm/v3/objects/${objectType}/batch/read`, {
      method: 'POST', body: { inputs: chunk.map((id) => ({ id })), properties: props },
    })
    for (const r of res.results ?? []) {
      const id = String(r.id)
      if (asked.has(id)) out.records.set(id, r)
      for (const old of mergedIdsOf(r)) {
        if (old === id || !asked.has(old) || out.records.has(old)) continue
        out.records.set(old, r)
        out.merged.set(old, id)
      }
    }
    for (const e of res.errors ?? []) {
      if (e.category !== 'OBJECT_NOT_FOUND' || !Array.isArray(e.context?.ids)) continue
      for (const raw of e.context.ids) {
        const id = String(raw)
        if (asked.has(id) && !out.records.has(id)) out.gone.add(id)
      }
    }
  }
  return out
}

// Where each slot keeps its link, and which type value marks a HubSpot object.
const SLOT_SQL: Record<LinkSlot, { id: string; type: string; flag: string }> = {
  what: { id: 'crm_what_id', type: 'crm_what_type', flag: 'crm_what_deleted' },
  who: { id: 'crm_who_id', type: 'crm_who_type', flag: 'crm_who_deleted' },
  related: { id: 'crm_related_id', type: 'crm_related_type', flag: 'crm_related_deleted' },
}

const LINK_TYPES: Record<LinkSlot, Record<string, string>> = {
  what: { deals: 'Opportunity', companies: 'Account' },
  who: { contacts: 'Contact', leads: 'Lead' },
  related: {},
}

function linkTypeFor(slot: LinkSlot, objectType: string): string {
  return slot === 'related' ? objectType : (LINK_TYPES[slot][objectType] ?? objectType)
}

// Moves every activity linked to a merged-away record onto the surviving one
// (and clears that link's broken flag). A merged Company also updates the
// Company stored on Deal-linked activities, and a merged Deal carries its
// Closed Lost review dismissal over. Logs one system audit row per merge.
// Returns the number of activities moved.
export async function repointMergedLinks(slot: LinkSlot, objectType: string, merged: Map<string, string>): Promise<number> {
  if (merged.size === 0) return 0
  const cols = SLOT_SQL[slot]
  const linkType = linkTypeFor(slot, objectType)
  let total = 0
  for (const [fromId, toId] of merged) {
    const moved = await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        UPDATE activities SET
          ${sql.raw(cols.id)} = ${toId},
          ${sql.raw(cols.flag)} = false,
          crm_disconnect_checked_at = now(),
          updated_at = now()
        WHERE ${sql.raw(cols.type)} = ${linkType} AND ${sql.raw(cols.id)} = ${fromId}
        RETURNING id
      `)
      if (slot === 'what' && objectType === 'companies') {
        await tx.execute(sql`UPDATE activities SET crm_account_id = ${toId} WHERE crm_account_id = ${fromId}`)
      }
      if (slot === 'what' && objectType === 'deals') {
        // Keep a dismissal unless the surviving Deal already has its own.
        await tx.execute(sql`
          UPDATE opp_review_dismissals d SET crm_opp_id = ${toId}
          WHERE d.crm_opp_id = ${fromId}
            AND NOT EXISTS (SELECT 1 FROM opp_review_dismissals x WHERE x.team_id = d.team_id AND x.crm_opp_id = ${toId})
        `)
        await tx.execute(sql`DELETE FROM opp_review_dismissals WHERE crm_opp_id = ${fromId}`)
      }
      return rowCount(rows)
    })
    total += moved
    if (moved > 0) {
      await logSystemAudit({
        action: 'activity.crm_merge_relink',
        targetType: 'hubspot_record',
        targetId: fromId,
        meta: { crm: 'hubspot', objectType, fromId, toId, activitiesUpdated: moved },
      })
    }
  }
  return total
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length
  const r = result as { rows?: unknown[]; rowCount?: number | null; count?: number }
  if (Array.isArray(r.rows)) return r.rows.length
  return Number(r.rowCount ?? r.count ?? 0)
}

// Writes the broken flag for ids whose state is known; unknown ids keep theirs.
async function writeFlags(slot: LinkSlot, objectType: string, rows: Array<{ id: string; deleted: boolean }>): Promise<void> {
  if (rows.length === 0) return
  const cols = SLOT_SQL[slot]
  const values = sql.join(rows.map((r) => sql`(${r.id}::text, ${r.deleted}::boolean)`), sql`, `)
  await db.execute(sql`
    UPDATE activities AS a SET
      ${sql.raw(cols.flag)} = v.deleted,
      crm_disconnect_checked_at = now()
    FROM (VALUES ${values}) AS v(link_id, deleted)
    WHERE a.${sql.raw(cols.type)} = ${linkTypeFor(slot, objectType)} AND a.${sql.raw(cols.id)} = v.link_id
  `)
}

export interface CheckOutcome { checked: number; gone: number; merged: number; moved: number }

// Resolves one object's ids, moves merged links, then flags what's gone.
export async function checkLinkedRecords(slot: LinkSlot, objectType: string, ids: string[]): Promise<CheckOutcome> {
  const res = await resolveHubspotRecords(objectType, ids, ['hs_object_id'])
  const moved = await repointMergedLinks(slot, objectType, res.merged)
  const flags: Array<{ id: string; deleted: boolean }> = []
  for (const id of ids) {
    if (res.merged.has(id)) continue
    if (res.gone.has(id)) flags.push({ id, deleted: true })
    else if (res.records.has(id)) flags.push({ id, deleted: false })
  }
  await writeFlags(slot, objectType, flags)
  return { checked: ids.length, gone: res.gone.size, merged: res.merged.size, moved }
}

export interface HubspotLinkHealthResult {
  scanned: number
  goneFound: number
  mergedFound: number
  activitiesMoved: number
  errors: string[]
  durationMs: number
  source: 'scheduled' | 'manual'
}

// Distinct HubSpot links per (slot, object), skipping ids saved while
// Salesforce was the CRM (they aren't HubSpot ids).
async function linkGroups(skipLeads: boolean): Promise<Array<{ slot: LinkSlot; objectType: string; ids: string[] }>> {
  const groups = new Map<string, { slot: LinkSlot; objectType: string; ids: string[] }>()
  const sources: Array<[LinkSlot, AnyPgColumn, AnyPgColumn]> = [
    ['what', activities.crmWhatType, activities.crmWhatId],
    ['who', activities.crmWhoType, activities.crmWhoId],
    ['related', activities.crmRelatedType, activities.crmRelatedId],
  ]
  for (const [slot, typeCol, idCol] of sources) {
    const rows = await db.selectDistinct({ type: typeCol, id: idCol }).from(activities)
      .where(and(eq(activities.isArchived, false), isNotNull(idCol), isNotNull(typeCol)))
    for (const r of rows) {
      const objectType = hubspotObjectForLink(slot, r.type)
      if (!objectType || !r.id || !HUBSPOT_ID_RX.test(r.id)) continue
      if (skipLeads && objectType === 'leads') continue
      const key = `${slot}:${objectType}`
      const g = groups.get(key) ?? { slot, objectType, ids: [] }
      g.ids.push(r.id)
      groups.set(key, g)
    }
  }
  return [...groups.values()]
}

function errorText(err: unknown): string {
  if (err instanceof HubspotError) return err.code
  return err instanceof Error ? err.message : String(err)
}

export async function detectHubspotDisconnectedLinks(opts?: { source?: 'scheduled' | 'manual' }): Promise<HubspotLinkHealthResult> {
  const startedAt = new Date()
  const result: HubspotLinkHealthResult = { scanned: 0, goneFound: 0, mergedFound: 0, activitiesMoved: 0, errors: [], durationMs: 0, source: opts?.source ?? 'scheduled' }
  const cfg = await getHubspotConfig()
  if (!cfg) {
    result.errors.push('errors.hubspot.not_configured')
    await writeRun(JOB_KEY, startedAt, 'error', 'errors.hubspot.not_configured', result)
    return result
  }
  const leadsMissing = cfg.lastCheck?.capabilities.find((c) => c.key === 'leads_read')?.status === 'missing'
  outer: for (const g of await linkGroups(leadsMissing)) {
    result.scanned += g.ids.length
    for (let i = 0; i < g.ids.length; i += BATCH) {
      try {
        const o = await checkLinkedRecords(g.slot, g.objectType, g.ids.slice(i, i + BATCH))
        result.goneFound += o.gone
        result.mergedFound += o.merged
        result.activitiesMoved += o.moved
      } catch (err) {
        result.errors.push(`${g.slot}_${g.objectType}_batch_${i}: ${errorText(err)}`)
        if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') break outer
      }
    }
  }
  result.durationMs = Date.now() - startedAt.getTime()
  const message = result.errors.length > 0
    ? result.errors[0] ?? null
    : `${result.goneFound}/${result.scanned} links flagged disconnected, ${result.mergedFound} merged (${result.activitiesMoved} activities moved)`
  await writeRun(JOB_KEY, startedAt, result.errors.length > 0 ? 'error' : 'ok', message, result)
  return result
}

let stopFn: (() => void) | null = null

// 24h, a quiet no-op (no job_runs row) unless HubSpot is the install's CRM
// and connected.
export function startHubspotLinkHealthWorker(): void {
  if (stopFn) return
  stopFn = scheduleJob(JOB_KEY, 24 * 60 * 60 * 1000, async () => {
    if (!(await isCrmProviderActive('hubspot'))) return
    if (!(await getHubspotConfig())) return
    await detectHubspotDisconnectedLinks().catch((err) => console.error('[hubspot-link-health] run failed:', err))
  }, { firstRunDelayMs: 2 * 60 * 1000 })
}
