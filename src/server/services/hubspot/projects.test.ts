// HubSpot Projects (phase 6b): which objects can hold Projects, the Deal's
// Project picker, the Project panel's read and edit, Engineer Notes / Next
// Steps posting and the Project snapshot (save-time and nightly). pglite for
// mappings, owners and activities; HubSpot's API mocked by path.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { TestDb } from '../../db/testDb.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})

type Req = { method?: string; body?: unknown; query?: Record<string, unknown> }
type Res = { status: number; body: unknown }
const request = vi.fn(async (_path: string, _opts?: Req): Promise<Res> => ({ status: 200, body: {} }))
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js')
  const hubspotJson = async (path: string, opts?: Req) => {
    const { status, body } = await request(path, opts)
    if (status === 403) throw new actual.HubspotError('errors.hubspot.forbidden', 403)
    if (status < 200 || status >= 300 || body === null) throw new actual.HubspotError('errors.hubspot.bad_response', status)
    return body
  }
  return { ...actual, hubspotRequest: (path: string, opts?: Req) => request(path, opts), hubspotJson }
})

const OBJ = '0-970'

const PROPS = { results: [
  { name: 'hs_name', label: 'Name', type: 'string', fieldType: 'text' },
  { name: 'proj_status', label: 'Status', type: 'enumeration', fieldType: 'select', options: [{ value: 'in_progress', label: 'In progress' }, { value: 'done', label: 'Done' }] },
  { name: 'hs_pipeline_stage', label: 'Stage', type: 'enumeration', fieldType: 'select', options: [] },
  { name: 'hs_start_date', label: 'Start', type: 'datetime', fieldType: 'date' },
  { name: 'proj_end', label: 'End', type: 'date', fieldType: 'date' },
  { name: 'proj_engineer', label: 'Engineer', type: 'enumeration', fieldType: 'select', referencedObjectType: 'OWNER', options: [] },
  { name: 'eng_notes', label: 'Engineer Notes', type: 'string', fieldType: 'textarea' },
  { name: 'proj_type', label: 'Type', type: 'enumeration', fieldType: 'select', options: [{ value: 'poc', label: 'POC' }] },
] }
const PIPELINES = { results: [{ label: 'Delivery', stages: [{ id: 's1', label: 'Kickoff' }, { id: 's2', label: 'Running' }] }] }

// Routes the mocked HubSpot API by path; `extra` answers first.
function hubspot(extra: (path: string, o?: Req) => Res | undefined = () => undefined) {
  request.mockImplementation(async (path, o) => {
    const hit = extra(path, o)
    if (hit) return hit
    if (path === `/crm/v3/properties/${OBJ}`) return { status: 200, body: PROPS }
    if (path === `/crm/v3/pipelines/${OBJ}`) return { status: 200, body: PIPELINES }
    return { status: 200, body: {} }
  })
}

let projects: typeof import('./projects.js')
let metadata: typeof import('./metadata.js')
let schema: typeof import('../../../../drizzle/schema.js')
let orm: typeof import('drizzle-orm')
let testDb: TestDb

beforeAll(async () => {
  projects = await import('./projects.js')
  metadata = await import('./metadata.js')
  schema = await import('../../../../drizzle/schema.js')
  orm = await import('drizzle-orm')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
})

let teamId = ''
let userId = ''
let typeId = ''

beforeEach(async () => {
  request.mockReset()
  hubspot()
  metadata.clearHubspotMetadataCache()
  projects.clearProjectStageCache()
  await testDb.delete(schema.activitySyncAudit)
  await testDb.delete(schema.activities)
  await testDb.delete(schema.crmFieldMappingTeams)
  await testDb.delete(schema.crmFieldMappings)
  await testDb.delete(schema.hubspotOwners)
  const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
  const [user] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'U' }).returning()
  const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Eval Work', sortOrder: 1 }).returning()
  teamId = team!.id; userId = user!.id; typeId = type!.id
})

async function map(appField: string, property: string, direction: 'read' | 'write' | 'read_write' = 'read', forTeam = teamId) {
  const [row] = await testDb.insert(schema.crmFieldMappings).values({ teamId: forTeam, appField, crmFieldApi: property, crmObject: OBJ, direction }).returning()
  await testDb.insert(schema.crmFieldMappingTeams).values({ crmFieldMappingId: row!.id, teamId: forTeam })
}

async function activity(fields: Partial<typeof schema.activities.$inferInsert>) {
  const [row] = await testDb.insert(schema.activities).values({
    userId, teamId, title: 'A', activityTypeId: typeId, status: 'submitted',
    startDatetime: new Date('2026-10-20T15:00:00Z'), endDatetime: new Date('2026-10-20T16:00:00Z'), effortHours: '1.00',
    ...fields,
  }).returning()
  return row!
}

async function reload(id: string) {
  const [row] = await testDb.select().from(schema.activities).where(orm.eq(schema.activities.id, id))
  return row!
}

describe('listHubspotProjectObjects', () => {
  it('offers the standard Projects object and live custom objects, each checked on its own', async () => {
    hubspot((path) => path === '/crm/v3/schemas'
      ? { status: 200, body: { results: [
          { objectTypeId: '2-555', labels: { singular: 'Evaluation' }, primaryDisplayProperty: 'eval_title' },
          { objectTypeId: '2-556', labels: { singular: 'Old' }, archived: true },
        ] } }
      : undefined)
    expect(await projects.listHubspotProjectObjects()).toEqual([
      { objectTypeId: '0-970', standard: true, label: null, primaryDisplayProperty: 'hs_name' },
      { objectTypeId: '2-555', standard: false, label: 'Evaluation', primaryDisplayProperty: 'eval_title' },
    ])

    // No access to Projects (or no Projects object), no custom objects.
    hubspot((path) => path === `/crm/v3/objects/${OBJ}` ? { status: 403, body: {} } : path === '/crm/v3/schemas' ? { status: 403, body: {} } : undefined)
    expect(await projects.listHubspotProjectObjects()).toEqual([])
  })
})

describe('listDealProjects', () => {
  it('reads every associated record across pages and lists them by name', async () => {
    hubspot((path, o) => {
      if (path === `/crm/v4/objects/deals/42/associations/${OBJ}`) {
        return o?.query?.['after']
          ? { status: 200, body: { results: [{ toObjectId: 9 }] } }
          : { status: 200, body: { results: [{ toObjectId: 7 }, { toObjectId: 8 }], paging: { next: { after: 'p2' } } } }
      }
      if (path === `/crm/v3/objects/${OBJ}/batch/read`) {
        return { status: 200, body: { results: [
          { id: '7', properties: { hs_name: 'Zeta POC' } },
          { id: '8', properties: { hs_name: 'Alpha POV' } },
          { id: '9', properties: { hs_name: null } },
        ] } }
      }
      return undefined
    })
    expect(await projects.listDealProjects('42', OBJ, 'Name')).toEqual([
      { id: '9', name: '9' },
      { id: '8', name: 'Alpha POV' },
      { id: '7', name: 'Zeta POC' },
    ])
    const batch = request.mock.calls.find(([p]) => p.endsWith('/batch/read'))!
    expect(batch[1]).toMatchObject({ method: 'POST', body: { properties: ['hs_name'] } })
  })

  it('lists nothing for a Salesforce id, a non-Project object or a Deal HubSpot doesn\'t know', async () => {
    expect(await projects.listDealProjects('006000000000001AAA', OBJ)).toEqual([])
    expect(await projects.listDealProjects('42', 'deals')).toEqual([])
    expect(request).not.toHaveBeenCalled()
    hubspot((path) => path.startsWith('/crm/v4/') ? { status: 404, body: {} } : undefined)
    expect(await projects.listDealProjects('42', OBJ)).toEqual([])
  })

  it('reads a custom object by its display property', () => {
    expect(projects.projectLabelProperty('2-555', 'eval_title')).toBe('eval_title')
    expect(projects.projectLabelProperty('2-555', 'Name')).toBe('hs_object_id')
    expect(projects.projectLabelProperty(OBJ, null)).toBe('hs_name')
  })
})

describe('readHubspotProjectFields', () => {
  it('returns raw values for the editor and labels for reading', async () => {
    await testDb.insert(schema.hubspotOwners).values({ id: '31', email: 'ana@example.com', firstName: 'Ana', lastName: 'Silva' })
    await map('eval_status', 'proj_status', 'write')
    await map('eval_stage', 'hs_pipeline_stage', 'write')
    await map('eval_start_date', 'hs_start_date', 'write')
    await map('eval_primary_engineer', 'proj_engineer')
    await map('eval_type', 'gone_property')
    hubspot((path) => path === `/crm/v3/objects/${OBJ}/77`
      ? { status: 200, body: { id: '77', properties: { proj_status: 'in_progress', hs_pipeline_stage: 's2', hs_start_date: '2026-11-03T00:00:00Z', proj_engineer: '31' } } }
      : undefined)

    const read = await projects.readHubspotProjectFields(teamId, OBJ, '77')
    expect(read).toEqual({
      values: { eval_status: 'in_progress', eval_stage: 's2', eval_start_date: '2026-11-03', eval_primary_engineer: 'Ana Silva' },
      labels: { eval_status: 'In progress', eval_stage: 'Running', eval_start_date: '2026-11-03', eval_primary_engineer: 'Ana Silva' },
      dropped: ['eval_type:gone_property'],
    })
  })

  it('says unmapped with no Project mapping, and null for a record HubSpot doesn\'t have', async () => {
    expect(await projects.readHubspotProjectFields(teamId, OBJ, '77')).toBe('unmapped')
    await map('eval_status', 'proj_status')
    hubspot((path) => path === `/crm/v3/objects/${OBJ}/77` ? { status: 404, body: {} } : undefined)
    expect(await projects.readHubspotProjectFields(teamId, OBJ, '77')).toBeNull()
  })

  it('offers pipeline stages for hs_pipeline_stage and options for an enumeration', async () => {
    await map('eval_stage', 'hs_pipeline_stage', 'write')
    await map('eval_status', 'proj_status', 'write')
    expect(await projects.hubspotProjectOptions(teamId, OBJ, 'eval_stage')).toEqual([{ value: 's1', label: 'Kickoff' }, { value: 's2', label: 'Running' }])
    expect(await projects.hubspotProjectOptions(teamId, OBJ, 'eval_status')).toEqual([{ value: 'in_progress', label: 'In progress' }, { value: 'done', label: 'Done' }])
    expect(await projects.hubspotProjectOptions(teamId, OBJ, 'eval_type')).toBe('unmapped')
  })
})

describe('writeHubspotProjectFields', () => {
  it('sends only writable, editable fields, then mirrors the labels onto linked activities', async () => {
    await map('eval_status', 'proj_status', 'write')
    await map('eval_start_date', 'hs_start_date', 'read_write')
    await map('eval_end_date', 'proj_end', 'write')
    await map('eval_type', 'proj_type', 'read')
    const linked = await activity({ crmRelatedType: OBJ, crmRelatedId: '77' })
    const other = await activity({ crmRelatedType: OBJ, crmRelatedId: '78', crmEvalStatus: 'Untouched' })

    const res = await projects.writeHubspotProjectFields({
      teamId, objectTypeId: OBJ, recordId: '77', userId,
      fields: { eval_status: 'done', eval_start_date: '2026-11-03', eval_end_date: '2026-12-01', eval_type: 'poc', eval_name: 'x' },
    })
    expect(res).toEqual({ ok: true, updated: ['proj_status', 'hs_start_date', 'proj_end'], skipped: ['eval_type', 'eval_name'] })
    const patch = request.mock.calls.find(([, o]) => o?.method === 'PATCH')!
    expect(patch).toEqual([`/crm/v3/objects/${OBJ}/77`, { method: 'PATCH', body: { properties: { proj_status: 'done', hs_start_date: '2026-11-03T00:00:00.000Z', proj_end: '2026-12-01' } } }])
    expect(await reload(linked.id)).toMatchObject({ crmEvalStatus: 'Done', crmEvalStartDate: '2026-11-03', crmEvalEndDate: '2026-12-01' })
    expect((await reload(other.id)).crmEvalStatus).toBe('Untouched')
  })

  it('refuses with nothing writable mapped and reports HubSpot\'s refusal without touching activities', async () => {
    await map('eval_status', 'proj_status', 'read')
    expect(await projects.writeHubspotProjectFields({ teamId, objectTypeId: OBJ, recordId: '77', userId, fields: { eval_status: 'done' } }))
      .toMatchObject({ ok: false, status: 400, error: 'errors.hubspot.project_field_unmapped' })

    await map('eval_end_date', 'proj_end', 'write')
    const linked = await activity({ crmRelatedType: OBJ, crmRelatedId: '77', crmEvalEndDate: '2026-01-01' })
    hubspot((path, o) => o?.method === 'PATCH' ? { status: 404, body: { message: 'Object not found' } } : undefined)
    expect(await projects.writeHubspotProjectFields({ teamId, objectTypeId: OBJ, recordId: '77', userId, fields: { eval_end_date: '2026-12-01' } }))
      .toEqual({ ok: false, status: 404, error: 'HubSpot 404: Object not found', skipped: [] })
    expect((await reload(linked.id)).crmEvalEndDate).toBe('2026-01-01')
  })
})

describe('prependHubspotProjectField', () => {
  const user = { id: '', firstName: 'Jane', lastName: 'Doe', timezone: 'UTC' }

  it('puts a dated entry above the current text', async () => {
    await map('eval_engineer_notes', 'eng_notes', 'write')
    hubspot((path, o) => path === `/crm/v3/objects/${OBJ}/77` && !o?.method
      ? { status: 200, body: { properties: { eng_notes: 'older note', hs_lastmodifieddate: '2026-10-01T00:00:00Z' } } }
      : undefined)
    const res = await projects.prependHubspotProjectField({
      teamId, objectTypeId: OBJ, recordId: '77', appField: 'eval_engineer_notes', text: '  Demo went well  ',
      expectedLastModifiedDate: '2026-10-01T00:00:00Z', user: { ...user, id: userId },
    })
    expect(res).toMatchObject({ ok: true, maximumCharacters: projects.HUBSPOT_STRING_MAX, target: { property: 'eng_notes', label: 'Engineer Notes' } })
    const entry = (res as { formattedEntry: string }).formattedEntry
    expect(entry).toMatch(/^\d{2}\/\d{2}\/\d{2} - EG: Demo went well$/)
    const patch = request.mock.calls.find(([, o]) => o?.method === 'PATCH')!
    expect((patch[1]!.body as { properties: Record<string, string> }).properties['eng_notes']).toBe(`${entry}\n\nolder note`)
  })

  it('writes nothing when the field changed since it was opened, or would overflow', async () => {
    await map('eval_engineer_notes', 'eng_notes', 'write')
    hubspot((path, o) => path === `/crm/v3/objects/${OBJ}/77` && !o?.method
      ? { status: 200, body: { properties: { eng_notes: 'x'.repeat(projects.HUBSPOT_STRING_MAX - 5), hs_lastmodifieddate: '2026-10-02T00:00:00Z' } } }
      : undefined)
    const base = { teamId, objectTypeId: OBJ, recordId: '77', appField: 'eval_engineer_notes', text: 'hi', user: { ...user, id: userId } }
    expect(await projects.prependHubspotProjectField({ ...base, expectedLastModifiedDate: '2026-10-01T00:00:00Z' }))
      .toMatchObject({ ok: false, status: 409, error: 'errors.hubspot.field_changed' })
    expect(await projects.prependHubspotProjectField(base)).toMatchObject({ ok: false, status: 400, error: 'errors.hubspot.field_capacity_exceeded' })
    expect(request.mock.calls.some(([, o]) => o?.method === 'PATCH')).toBe(false)
  })

  it('needs a writable plain-text mapping', async () => {
    const base = { teamId, objectTypeId: OBJ, recordId: '77', appField: 'eval_next_steps', text: 'hi', user: { ...user, id: userId } }
    expect(await projects.prependHubspotProjectField(base)).toMatchObject({ status: 400, error: 'errors.hubspot.project_field_unmapped' })
    await map('eval_next_steps', 'proj_status', 'write')
    expect(await projects.prependHubspotProjectField(base)).toMatchObject({ status: 422, error: 'errors.hubspot.field_not_prependable' })
    expect(projects.isPrependable({ type: 'string', fieldType: 'html', readOnly: false, calculated: false })).toBe(false)
    expect(projects.isPrependable({ type: 'string', fieldType: 'textarea', readOnly: true, calculated: false })).toBe(false)
  })
})

describe('Project snapshots', () => {
  it('reads the name and field labels for a new link', async () => {
    await map('eval_status', 'proj_status')
    hubspot((path) => path === `/crm/v3/objects/${OBJ}/77`
      ? { status: 200, body: { id: '77', properties: { hs_name: 'Acme POC', proj_status: 'done' } } }
      : undefined)
    expect(await projects.hubspotProjectSnapshot(teamId, OBJ, '77')).toEqual({
      crmRelatedName: 'Acme POC', crmEvalStatus: 'Done', crmEvalStage: null, crmEvalType: null,
      crmEvalStartDate: null, crmEvalEndDate: null, crmEvalPrimaryEngineer: null, crmRelatedDeleted: false,
    })
    const get = request.mock.calls.find(([p]) => p === `/crm/v3/objects/${OBJ}/77`)!
    expect(get[1]).toEqual({ query: { properties: 'hs_name,proj_status' } })
    expect(await projects.hubspotProjectSnapshot(teamId, OBJ, 'a0B000000000001')).toBeNull()
  })

  it('refreshes linked records nightly, flags ones HubSpot no longer has and leaves Salesforce links alone', async () => {
    await map('eval_status', 'proj_status')
    const found = await activity({ crmRelatedType: OBJ, crmRelatedId: '77', crmRelatedName: 'Old', crmRelatedDeleted: true })
    const gone = await activity({ crmRelatedType: OBJ, crmRelatedId: '78', crmRelatedName: 'Gone' })
    const merged = await activity({ crmRelatedType: OBJ, crmRelatedId: '79', crmRelatedName: 'Merged away' })
    const unknown = await activity({ crmRelatedType: OBJ, crmRelatedId: '80', crmRelatedName: 'Unknown', crmRelatedDeleted: true })
    const sf = await activity({ crmRelatedType: 'Evaluations__c', crmRelatedId: 'a0B000000000001', crmRelatedName: 'SF eval' })
    // HubSpot answers 207: found records, merged ids under their survivor,
    // and missing ids as OBJECT_NOT_FOUND. '80' is in neither list.
    hubspot((path) => path === `/crm/v3/objects/${OBJ}/batch/read`
      ? { status: 207, body: {
        results: [
          { id: '77', properties: { hs_name: 'Acme POC', proj_status: 'in_progress' } },
          { id: '90', properties: { hs_name: 'Survivor POC', proj_status: 'done', hs_merged_object_ids: '79' } },
        ],
        errors: [{ category: 'OBJECT_NOT_FOUND', context: { ids: ['78'] } }],
      } }
      : undefined)

    expect(await projects.refreshHubspotProjectSnapshots()).toEqual({ scanned: 4, updated: 2, notFound: 1, errors: [] })
    expect(await reload(found.id)).toMatchObject({ crmRelatedName: 'Acme POC', crmEvalStatus: 'In progress', crmRelatedDeleted: false })
    expect(await reload(gone.id)).toMatchObject({ crmRelatedName: 'Gone', crmRelatedDeleted: true })
    expect(await reload(merged.id)).toMatchObject({ crmRelatedId: '90', crmRelatedName: 'Survivor POC', crmEvalStatus: 'Done', crmRelatedDeleted: false })
    // Neither found nor reported missing: nothing is changed.
    expect(await reload(unknown.id)).toMatchObject({ crmRelatedName: 'Unknown', crmRelatedDeleted: true })
    expect(await reload(sf.id)).toMatchObject({ crmRelatedName: 'SF eval', crmRelatedDeleted: false })
  })

  it('writes nothing for a batch HubSpot fails', async () => {
    const a = await activity({ crmRelatedType: OBJ, crmRelatedId: '77', crmRelatedName: 'Kept' })
    hubspot((path) => path.endsWith('/batch/read') ? { status: 500, body: {} } : undefined)
    const res = await projects.refreshHubspotProjectSnapshots()
    expect(res).toMatchObject({ scanned: 1, updated: 0, notFound: 0 })
    expect(res.errors).toHaveLength(1)
    expect(await reload(a.id)).toMatchObject({ crmRelatedName: 'Kept', crmRelatedDeleted: false })
  })
})
