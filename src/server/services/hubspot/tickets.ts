import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, activityCrmTickets } from '../../../../drizzle/schema.js'
import { HUBSPOT_ID_RX } from '../../../shared/hubspot.js'
import { HubspotError, hubspotJson } from './client.js'
import { getObjectPropertiesSafe, isOwnerProperty, optionLabel, resolveOwnerValue, type PropertyInfo } from './metadata.js'
import { loadHubspotMappings, mappedProperty, type HubspotMappingRow } from './mappings.js'
import { batchRead, contactName, hubspotSearch, primaryAssociations, type HubspotObject } from './search.js'

// Support Tickets on HubSpot Tickets (HubSpot plan, phase 4). The HubSpot
// counterpart of GET /api/salesforce/tickets/search and /tickets/refresh,
// returning the same row shape so the activity form's ticket picker and the
// activity_crm_tickets snapshot work unchanged. Read-only: nothing here writes
// to HubSpot.
//
// Unlike Salesforce, every portal has the same ticket object with the same
// standard properties, so the picker works without any mapping: Subject,
// Date opened, Status (the pipeline stage), Description and Owner read
// HubSpot's own properties, the ticket number is the record id, and the
// Contact is the ticket's primary associated contact. A ticket_* mapping on
// the `tickets` object (Admin → Field Mappings) replaces the default for that
// field, which is how a portal's own "Platform" or ticket number property
// shows up. Closed tickets are the ones in a closed pipeline stage, so no
// "closed status values" need configuring.

export interface HubspotTicketRow {
  id: string
  ticketNumber: string
  subject: string | null
  dateOpened: string | null
  status: string | null
  contact: string | null
  description: string | null
  platform: string | null
  owner: string | null
}

type TicketField = 'ticket_number' | 'ticket_subject' | 'ticket_date_opened' | 'ticket_status' | 'ticket_contact' | 'ticket_description' | 'ticket_platform' | 'ticket_owner'

const DEFAULT_PROPERTIES: Readonly<Partial<Record<TicketField, string>>> = {
  ticket_subject: 'subject',
  ticket_date_opened: 'createdate',
  ticket_status: 'hs_pipeline_stage',
  ticket_description: 'content',
  ticket_owner: 'hubspot_owner_id',
}

const ROW_KEY: Readonly<Record<TicketField, keyof Omit<HubspotTicketRow, 'id'>>> = {
  ticket_number: 'ticketNumber',
  ticket_subject: 'subject',
  ticket_date_opened: 'dateOpened',
  ticket_status: 'status',
  ticket_contact: 'contact',
  ticket_description: 'description',
  ticket_platform: 'platform',
  ticket_owner: 'owner',
}

const SEARCH_LIMIT = 100
const TTL_MS = 60 * 60 * 1000

export interface TicketStageInfo { label: string; isClosed: boolean }

interface TicketPipelineApi {
  id?: unknown
  stages?: Array<{ id?: unknown; label?: unknown; metadata?: { ticketState?: unknown; isClosed?: unknown } }>
}

export function ticketStagesFromPipelines(pipelines: TicketPipelineApi[]): Map<string, TicketStageInfo> {
  const out = new Map<string, TicketStageInfo>()
  for (const p of pipelines) {
    for (const s of p.stages ?? []) {
      if (s.id == null || s.id === '') continue
      const id = String(s.id)
      const state = typeof s.metadata?.ticketState === 'string' ? s.metadata.ticketState.toUpperCase() : null
      out.set(id, {
        label: typeof s.label === 'string' && s.label ? s.label : id,
        isClosed: state === 'CLOSED' || String(s.metadata?.isClosed) === 'true',
      })
    }
  }
  return out
}

let stageCache: { at: number; stages: Map<string, TicketStageInfo> } | null = null

// Ticket stage labels and closed state. A missing pipelines read leaves raw
// stage ids showing and no closed filter, never an error.
export async function getTicketStagesSafe(): Promise<Map<string, TicketStageInfo>> {
  if (stageCache && Date.now() - stageCache.at < TTL_MS) return stageCache.stages
  try {
    const body = await hubspotJson<{ results?: TicketPipelineApi[] }>('/crm/v3/pipelines/tickets')
    const stages = ticketStagesFromPipelines(Array.isArray(body.results) ? body.results : [])
    stageCache = { at: Date.now(), stages }
    return stages
  } catch (err) {
    if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
    return new Map()
  }
}

export function clearTicketStageCache(): void {
  stageCache = null
}

// Which HubSpot property each ticket field reads: the team's mapping first,
// then HubSpot's standard property. Contact and ticket number have no
// standard property (association and record id).
export function ticketPropertyPlan(mappings: readonly HubspotMappingRow[]): Map<TicketField, string> {
  const plan = new Map<TicketField, string>()
  for (const field of Object.keys(ROW_KEY) as TicketField[]) {
    const prop = mappedProperty(mappings, 'tickets', field) ?? DEFAULT_PROPERTIES[field]
    if (prop) plan.set(field, prop)
  }
  return plan
}

function rawValue(t: HubspotObject, property: string): string | null {
  const v = t.properties?.[property]
  return v == null || v === '' ? null : String(v)
}

// The tickets as picker rows: stage ids become stage labels, option values
// become option labels, owner ids become owner names, and an unmapped
// Contact comes from the ticket's primary contact association.
export async function toTicketRows(tickets: HubspotObject[], plan: Map<TicketField, string>, ctx?: {
  props?: Map<string, PropertyInfo>
  stages?: Map<string, TicketStageInfo>
}): Promise<HubspotTicketRow[]> {
  if (tickets.length === 0) return []
  const props = ctx?.props ?? await getObjectPropertiesSafe('tickets')
  const stages = ctx?.stages ?? await getTicketStagesSafe()

  const contactByTicket = new Map<string, string>()
  if (!plan.has('ticket_contact')) {
    try {
      const assoc = await primaryAssociations('tickets', 'contacts', tickets.map((t) => t.id))
      const contacts = await batchRead('contacts', [...assoc.values()], ['firstname', 'lastname', 'email'])
      for (const [ticketId, contactId] of assoc) {
        const c = contacts.get(contactId)
        if (c) contactByTicket.set(ticketId, contactName(c))
      }
    } catch (err) {
      // The Contact column is an extra; a missing contacts read leaves it blank.
      if (err instanceof HubspotError && err.code === 'errors.hubspot.unauthorized') throw err
    }
  }

  const rows: HubspotTicketRow[] = []
  for (const t of tickets) {
    const row: HubspotTicketRow = {
      id: String(t.id), ticketNumber: String(t.id), subject: null, dateOpened: null, status: null,
      contact: contactByTicket.get(String(t.id)) ?? null, description: null, platform: null, owner: null,
    }
    for (const [field, property] of plan) {
      const raw = rawValue(t, property)
      if (raw == null) continue
      const info = props.get(property)
      let value: string | null
      if (property === 'hs_pipeline_stage') value = stages.get(raw)?.label ?? raw
      else if (property === 'hubspot_owner_id' || (info && isOwnerProperty(info))) value = await resolveOwnerValue(raw)
      else value = optionLabel(props, property, raw)
      if (value != null) row[ROW_KEY[field]] = value
    }
    rows.push(row)
  }
  return rows
}

function fetchProperties(plan: Map<TicketField, string>): string[] {
  return [...new Set(['hs_pipeline_stage', 'createdate', ...plan.values()])]
}

export interface HubspotTicketSearchOptions {
  teamId: string | null
  // A Company id: the tickets associated with it. Without one, `query`
  // searches every ticket (Open Search).
  companyId?: string | null
  query?: string | null
  includeClosed?: boolean
}

export async function searchHubspotTickets(opts: HubspotTicketSearchOptions): Promise<HubspotTicketRow[]> {
  const companyId = opts.companyId && HUBSPOT_ID_RX.test(opts.companyId) ? opts.companyId : null
  const query = opts.query?.trim() ?? ''
  if (!companyId && query.length < 2) return []

  const mappings = await loadHubspotMappings(opts.teamId, ['tickets'])
  const plan = ticketPropertyPlan(mappings)
  const stages = await getTicketStagesSafe()

  const filters: Array<{ propertyName: string; operator: string; value?: string; values?: string[] }> = []
  if (companyId) filters.push({ propertyName: 'associations.company', operator: 'EQ', value: companyId })
  const closedStageIds = [...stages].filter(([, s]) => s.isClosed).map(([id]) => id)
  if (!opts.includeClosed && closedStageIds.length > 0) {
    filters.push({ propertyName: 'hs_pipeline_stage', operator: 'NOT_IN', values: closedStageIds })
  }

  const tickets = await hubspotSearch('tickets', {
    ...(query && !companyId ? { query } : {}),
    limit: SEARCH_LIMIT,
    properties: fetchProperties(plan),
    ...(filters.length > 0 ? { filterGroups: [{ filters }] } : {}),
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
  })
  return toTicketRows(tickets, plan, { stages })
}

// Re-reads an activity's attached HubSpot tickets (one batch read) and saves
// the fresh values onto activity_crm_tickets, the HubSpot side of the
// drawer-open refresh (CLAUDE.md §7, v1.341). Returns the stored rows,
// refreshed where HubSpot answered; a ticket HubSpot no longer returns keeps
// its snapshot, and any failure returns the stored rows unchanged.
export async function refreshHubspotTickets(activityId: string): Promise<{ rows: Array<typeof activityCrmTickets.$inferSelect>; refreshFailed: boolean }> {
  const existing = await db.select().from(activityCrmTickets).where(eq(activityCrmTickets.activityId, activityId))
  const ids = existing.map((t) => t.crmTicketId).filter((id) => HUBSPOT_ID_RX.test(id))
  if (ids.length === 0) return { rows: existing, refreshFailed: false }

  const [activity] = await db.select({ teamId: activities.teamId }).from(activities).where(eq(activities.id, activityId)).limit(1)
  try {
    const mappings = await loadHubspotMappings(activity?.teamId ?? null, ['tickets'])
    const plan = ticketPropertyPlan(mappings)
    const tickets = await batchRead('tickets', ids, fetchProperties(plan))
    const fresh = new Map((await toTicketRows([...tickets.values()], plan)).map((r) => [r.id, r]))

    const updated: Array<typeof activityCrmTickets.$inferSelect> = []
    for (const row of existing) {
      const f = fresh.get(row.crmTicketId)
      if (!f) { updated.push(row); continue }
      const patch = {
        crmTicketNumber: f.ticketNumber,
        crmSubject: f.subject,
        crmDateOpened: f.dateOpened ? new Date(f.dateOpened) : null,
        crmStatus: f.status,
        crmContact: f.contact,
        crmDescription: f.description,
        crmPlatform: f.platform,
        crmOwner: f.owner,
      }
      await db.update(activityCrmTickets).set(patch).where(eq(activityCrmTickets.id, row.id))
      updated.push({ ...row, ...patch })
    }
    return { rows: updated, refreshFailed: false }
  } catch {
    return { rows: existing, refreshFailed: true }
  }
}
