// Verifies migration 0186_sf_se_filter_mappings.sql: an install already using
// Salesforce gets the fields the search and Assigned SE picker used to
// hardcode as real CRM Field Mappings, and nothing else gets them.
import { describe, it, expect } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDb } from './testDb.js'
import { crmFieldMappings, crmFieldMappingTeams, systemSettings, teams, userIntegrations, users } from '../../../drizzle/schema.js'

function readMigrationSql(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return fs.readFileSync(path.resolve(dir, '../../../drizzle/migrations/0186_sf_se_filter_mappings.sql'), 'utf8')
}

type Db = Awaited<ReturnType<typeof createTestDb>>

async function team(db: Db, name: string): Promise<string> {
  const [t] = await db.insert(teams).values({ name, slug: `${name.toLowerCase()}-${crypto.randomUUID()}` }).returning({ id: teams.id })
  return t!.id
}

async function connectSalesforce(db: Db): Promise<void> {
  const [u] = await db.insert(users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'SF User' }).returning({ id: users.id })
  await db.insert(userIntegrations).values({ userId: u!.id, provider: 'salesforce' })
}

async function mappingsFor(db: Db, teamId: string, appField: string): Promise<string[]> {
  const rows = await db.select({ api: crmFieldMappings.crmFieldApi }).from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(eq(crmFieldMappingTeams.teamId, teamId), eq(crmFieldMappings.appField, appField)))
  return rows.map((r) => r.api).sort()
}

describe('migration 0186: Salesforce SE filter mappings', () => {
  it('maps the previously hardcoded fields for every team on an install using Salesforce', async () => {
    const db = await createTestDb()
    const a = await team(db, 'Alpha')
    const b = await team(db, 'Beta')
    // Beta already has its own choices: left alone.
    const [own] = await db.insert(crmFieldMappings).values({ teamId: b, appField: 'opp_se_filter', crmFieldApi: 'Lead_SE__c', crmObject: 'Opportunity', direction: 'read' }).returning({ id: crmFieldMappings.id })
    await db.insert(crmFieldMappingTeams).values({ crmFieldMappingId: own!.id, teamId: b })
    const [w] = await db.insert(crmFieldMappings).values({ teamId: b, appField: 'assigned_se_write', crmFieldApi: 'Lead_SE__c', crmObject: 'Opportunity', direction: 'read_write' }).returning({ id: crmFieldMappings.id })
    await db.insert(crmFieldMappingTeams).values({ crmFieldMappingId: w!.id, teamId: b })
    await connectSalesforce(db)

    await db.execute(sql.raw(readMigrationSql()))

    expect(await mappingsFor(db, a, 'opp_se_filter')).toEqual(['Assigned_SE__c', 'Primary_Engineer__c', 'Specialist_Engineer__c', 'Supporting_Engineers__c'])
    expect(await mappingsFor(db, a, 'assigned_se_write')).toEqual(['Assigned_SE__c'])
    expect(await mappingsFor(db, b, 'opp_se_filter')).toEqual(['Lead_SE__c'])
    expect(await mappingsFor(db, b, 'assigned_se_write')).toEqual(['Lead_SE__c'])

    // Running it again adds nothing.
    await db.execute(sql.raw(readMigrationSql()))
    expect(await mappingsFor(db, a, 'opp_se_filter')).toHaveLength(4)
  })

  it('adds nothing when no one has connected Salesforce', async () => {
    const db = await createTestDb()
    const a = await team(db, 'Alpha')
    await db.execute(sql.raw(readMigrationSql()))
    expect(await mappingsFor(db, a, 'opp_se_filter')).toEqual([])
    expect(await mappingsFor(db, a, 'assigned_se_write')).toEqual([])
  })

  it('adds nothing on a HubSpot install', async () => {
    const db = await createTestDb()
    const a = await team(db, 'Alpha')
    await connectSalesforce(db)
    await db.insert(systemSettings).values({ key: 'crm_provider', value: { provider: 'hubspot' } })
    await db.execute(sql.raw(readMigrationSql()))
    expect(await mappingsFor(db, a, 'opp_se_filter')).toEqual([])
  })
})
