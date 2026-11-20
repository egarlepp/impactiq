import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { crmFieldMappings, crmFieldMappingTeams } from '../../../../drizzle/schema.js'
import type { HubspotMappingObject } from '../../../shared/hubspot.js'

// HubSpot field mappings (phase 2b). They live in the same crm_field_mappings
// table as Salesforce's, with a HubSpot object name in crm_object ('meetings',
// 'deals', ...), so the admin screen, export/import and audit trail all
// carry over. Team assignment goes through the crm_field_mapping_teams
// junction, never the base team_id column (CLAUDE.md §9, v1.298).

export interface HubspotMappingRow {
  appField: string
  property: string
  crmObject: string
  direction: string
  isActive: boolean
  constantValue: string | null
  refreshOnlyForReports: boolean
}

// Active mappings for these HubSpot objects. With a teamId, only the rows
// assigned to that team; without one (an install-wide read such as a hover
// preview), every active row, first one per (object, app field) winning for
// single-valued fields.
export async function loadHubspotMappings(teamId: string | null, objects: readonly (HubspotMappingObject | string)[]): Promise<HubspotMappingRow[]> {
  if (objects.length === 0) return []
  const cols = {
    appField: crmFieldMappings.appField,
    property: crmFieldMappings.crmFieldApi,
    crmObject: crmFieldMappings.crmObject,
    direction: crmFieldMappings.direction,
    isActive: crmFieldMappings.isActive,
    constantValue: crmFieldMappings.constantValue,
    refreshOnlyForReports: crmFieldMappings.refreshOnlyForReports,
  }
  const base = and(inArray(crmFieldMappings.crmObject, [...objects]), eq(crmFieldMappings.isActive, true))
  const rows = teamId
    ? await db.select(cols).from(crmFieldMappings)
      .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
      .where(and(base, eq(crmFieldMappingTeams.teamId, teamId)))
    : await db.select(cols).from(crmFieldMappings).where(base)
  return rows.filter((r) => r.property.trim() !== '')
}

export function isWritable(m: Pick<HubspotMappingRow, 'direction' | 'refreshOnlyForReports'>): boolean {
  return (m.direction === 'write' || m.direction === 'read_write') && !m.refreshOnlyForReports
}

// First mapped property for one app field on one object.
export function mappedProperty(rows: readonly HubspotMappingRow[], crmObject: string, appField: string): string | null {
  return rows.find((r) => r.crmObject === crmObject && r.appField === appField)?.property ?? null
}

// Every mapped property for an app field that allows several rows.
export function mappedProperties(rows: readonly HubspotMappingRow[], crmObject: string, appField: string): string[] {
  return [...new Set(rows.filter((r) => r.crmObject === crmObject && r.appField === appField).map((r) => r.property))]
}
