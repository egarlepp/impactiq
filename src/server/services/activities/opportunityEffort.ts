// Logged effort on one CRM Opportunity, for GET /api/v1/effort (v1.448.0).
// CriteriaIQ reads this to show SE hours on a project page; the contract is in
// docs/effort-api.md.
//
// Totals only: no titles, notes or meeting details, so a private meeting or a
// note can never leave through it. Submitted, unarchived activities linked to
// the Opportunity as their primary record (crm_what_type = 'Opportunity'),
// limited to the teams the key's owner can see.
//
// Cost (v1.449+) is one total for the Opportunity, never per person or per
// type: a per-person figure divided by its hours would give that person's
// cost rate. Same math as the cost dashboards: hours × the rate the capacity
// resolver gives for that person, team and day, plus direct (travel) costs,
// all converted to USD.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activities, teamActivityTypes, users } from '../../../../drizzle/schema.js'
import { resolveCostBatch } from '../capacity/resolver.js'
import { directCostUsd, loadFxByCurrency, toUsd } from '../../routes/dashboards/shared.js'

export const EFFORT_API_VERSION = 1 as const

// Salesforce ids (15 or 18 chars) and HubSpot record ids (digits). Anything
// else is refused before it reaches a query.
const CRM_ID_RX = /^[A-Za-z0-9]{1,40}$/
const SF_ID_RX = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/
const HUBSPOT_ID_RX = /^\d+$/

export function parseCrmOpportunityId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return CRM_ID_RX.test(id) ? id : null
}

export interface EffortPerson {
  name: string
  email: string
  hours: number
  activityCount: number
}

export interface EffortType {
  name: string
  hours: number
  activityCount: number
}

export interface EffortCost {
  currency: 'USD'
  totalCost: number
  laborCost: number
  directCost: number
  /** Activities whose owner had no cost rate that day; their hours add no labor cost. */
  activitiesWithoutRate: number
}

export interface OpportunityEffort {
  version: typeof EFFORT_API_VERSION
  crmOpportunityId: string
  totalHours: number
  activityCount: number
  firstActivityAt: string | null
  lastActivityAt: string | null
  byPerson: EffortPerson[]
  byType: EffortType[]
  cost: EffortCost
}

function hours(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100
}

const money = hours

function emptyCost(): EffortCost {
  return { currency: 'USD', totalCost: 0, laborCost: 0, directCost: 0, activitiesWithoutRate: 0 }
}

interface CostRow {
  userId: string
  teamId: string
  startDatetime: Date
  effortHours: string
  costTransportation: string | null
  costLodging: string | null
  costFood: string | null
  incidentalCurrency: string | null
}

async function effortCost(rows: CostRow[]): Promise<EffortCost> {
  const cost = emptyCost()
  if (rows.length === 0) return cost
  const [rates, fx] = await Promise.all([
    resolveCostBatch(rows.map((r) => ({ userId: r.userId, teamId: r.teamId, asOf: new Date(r.startDatetime) }))),
    loadFxByCurrency(),
  ])
  let labor = 0
  let direct = 0
  for (const r of rows) {
    const rate = rates.get(`${r.userId}::${r.teamId}`)
    if (rate?.rate == null) cost.activitiesWithoutRate += 1
    else labor += toUsd(Number(r.effortHours) * rate.rate, rate.currency, fx)
    direct += directCostUsd(r, fx)
  }
  cost.laborCost = money(labor)
  cost.directCost = money(direct)
  cost.totalCost = money(labor + direct)
  return cost
}

function iso(value: unknown): string | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// A Salesforce id is matched on its case-sensitive 15-char form, so an 18-char
// id from CriteriaIQ finds activities saved with either form. Anything else
// (HubSpot) must match exactly.
function opportunityMatch(crmOpportunityId: string) {
  if (SF_ID_RX.test(crmOpportunityId) && !HUBSPOT_ID_RX.test(crmOpportunityId)) {
    return sql`left(${activities.crmWhatId}, 15) = ${crmOpportunityId.slice(0, 15)}`
  }
  return eq(activities.crmWhatId, crmOpportunityId)
}

export async function getOpportunityEffort(crmOpportunityId: string, teamIds: string[]): Promise<OpportunityEffort> {
  const empty: OpportunityEffort = {
    version: EFFORT_API_VERSION,
    crmOpportunityId,
    totalHours: 0,
    activityCount: 0,
    firstActivityAt: null,
    lastActivityAt: null,
    byPerson: [],
    byType: [],
    cost: emptyCost(),
  }
  if (teamIds.length === 0) return empty

  const where = and(
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    eq(activities.crmWhatType, 'Opportunity'),
    opportunityMatch(crmOpportunityId),
    inArray(activities.teamId, teamIds),
  )

  const [totals, people, types, costRows] = await Promise.all([
    db.select({
      hours: sql<string>`coalesce(sum(${activities.effortHours}), 0)`,
      count: sql<string>`count(*)`,
      first: sql<string | null>`min(${activities.startDatetime})`,
      last: sql<string | null>`max(${activities.startDatetime})`,
    }).from(activities).where(where),
    db.select({
      name: users.displayName,
      email: users.email,
      hours: sql<string>`sum(${activities.effortHours})`,
      count: sql<string>`count(*)`,
    }).from(activities).innerJoin(users, eq(users.id, activities.userId)).where(where)
      .groupBy(users.id, users.displayName, users.email),
    db.select({
      name: teamActivityTypes.name,
      hours: sql<string>`sum(${activities.effortHours})`,
      count: sql<string>`count(*)`,
    }).from(activities).innerJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId)).where(where)
      .groupBy(teamActivityTypes.name),
    db.select({
      userId: activities.userId,
      teamId: activities.teamId,
      startDatetime: activities.startDatetime,
      effortHours: activities.effortHours,
      costTransportation: activities.costTransportation,
      costLodging: activities.costLodging,
      costFood: activities.costFood,
      incidentalCurrency: activities.incidentalCurrency,
    }).from(activities).where(where),
  ])

  const total = totals[0]
  const activityCount = Number(total?.count ?? 0)
  if (activityCount === 0) return empty

  // The same type name can exist on several teams; they are one row here.
  const byTypeName = new Map<string, EffortType>()
  for (const t of types) {
    const row = byTypeName.get(t.name) ?? { name: t.name, hours: 0, activityCount: 0 }
    row.hours = hours(row.hours + Number(t.hours))
    row.activityCount += Number(t.count)
    byTypeName.set(t.name, row)
  }

  return {
    ...empty,
    totalHours: hours(total?.hours),
    activityCount,
    firstActivityAt: iso(total?.first),
    lastActivityAt: iso(total?.last),
    byPerson: people
      .map((p) => ({ name: p.name, email: p.email.trim().toLowerCase(), hours: hours(p.hours), activityCount: Number(p.count) }))
      .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name)),
    byType: [...byTypeName.values()].sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name)),
    cost: await effortCost(costRows),
  }
}
