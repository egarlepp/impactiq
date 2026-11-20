import { eq, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '../../db/index.js'
import { activities, teams } from '../../../../drizzle/schema.js'

// Every CRM id the Demo Data generator invents (Opportunities, Accounts,
// Projects, CRM users, historical events) starts with this prefix. Real
// Salesforce ids are 15/18 alphanumerics and HubSpot ids are numeric, so the
// prefix can never collide with a real record.
export const DEMO_CRM_ID_PREFIX = 'demo-'
export const DEMO_TEAM_SLUG = 'demo-sales-engineering'

export function isDemoCrmId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DEMO_CRM_ID_PREFIX)
}

// For jobs that send linked ids to the CRM: a demo id in a Salesforce
// `Id IN (...)` batch fails the whole query, which would also stop every
// real id in that batch from being refreshed or checked.
export function notDemoCrmId(col: AnyPgColumn): SQL {
  return sql`${col} NOT LIKE ${DEMO_CRM_ID_PREFIX + '%'}`
}

export async function getDemoTeamId(): Promise<string | null> {
  const [row] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, DEMO_TEAM_SLUG)).limit(1)
  return row?.id ?? null
}

// crm_opportunity_coverage is an org-wide snapshot, not team-scoped, so the
// demo pipeline would otherwise leak into every team's Attach Rate. Demo
// rows show only when the scope is the demo team alone; a real team never
// sees them. Undefined = no filter needed (no demo team, or a mixed scope
// that includes it).
export async function demoCoverageCond(oppIdCol: AnyPgColumn, scopeTeamIds: readonly string[]): Promise<SQL | undefined> {
  const demoTeamId = await getDemoTeamId()
  return demoCoverageCondFor(oppIdCol, scopeTeamIds, demoTeamId)
}

export function demoCoverageCondFor(oppIdCol: AnyPgColumn, scopeTeamIds: readonly string[], demoTeamId: string | null): SQL | undefined {
  if (!demoTeamId) return undefined
  const includesDemo = scopeTeamIds.includes(demoTeamId)
  if (!includesDemo) return notDemoCrmId(oppIdCol)
  if (scopeTeamIds.every((id) => id === demoTeamId)) return sql`${oppIdCol} LIKE ${DEMO_CRM_ID_PREFIX + '%'}`
  return undefined
}

export const DEMO_SYNC_ERROR = 'Demo record: not sent to the CRM.'

// Write-back stops here for an activity linked to a demo record (or in the
// demo team): it's parked as failed with no retry instead of being sent to
// Salesforce or HubSpot, where a demo id would only be rejected. Returns
// true when it parked the row. Called by both CRMs' sync before any API call.
export async function parkDemoActivitySync(activityId: string): Promise<boolean> {
  const [row] = await db
    .select({ teamId: activities.teamId, whatId: activities.crmWhatId, whoId: activities.crmWhoId, relatedId: activities.crmRelatedId })
    .from(activities)
    .where(eq(activities.id, activityId))
    .limit(1)
  if (!row) return false
  const demoTeamId = await getDemoTeamId()
  const isDemo = row.teamId === demoTeamId || isDemoCrmId(row.whatId) || isDemoCrmId(row.whoId) || isDemoCrmId(row.relatedId)
  if (!isDemo) return false
  await db.update(activities).set({
    crmSyncStatus: 'failed',
    crmSyncError: DEMO_SYNC_ERROR,
    crmNextRetryAt: null,
    updatedAt: new Date(),
  }).where(eq(activities.id, activityId))
  return true
}
