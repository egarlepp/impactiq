// Admin → Workplace → AI Notes (routes/admin/aiNotes.ts) against pglite: a
// Team Admin sets the switch and manages profiles (the Default one included),
// only an App Admin sets the limit.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import { eq } from 'drizzle-orm'
import type { AddressInfo } from 'node:net'
import type { TestDb } from '../../db/testDb.js'
import type { AiNoteProfile, AiNotesTeamSettings } from '../../../shared/aiNotes.js'

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js')
  const { createTestDb } = await import('../../db/testDb.js')
  return { ...actual, db: await createTestDb() }
})
vi.mock('../../services/audit/log.js', () => ({ logAudit: async () => {} }))

let schema: typeof import('../../../../drizzle/schema.js')
let testDb: TestDb
let base = ''
let currentUserId = ''

async function call<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { data: T; error: string | null } }
}

beforeAll(async () => {
  schema = await import('../../../../drizzle/schema.js')
  testDb = (await import('../../db/index.js')).db as unknown as TestDb
  const { aiNotesAdminRoutes } = await import('./aiNotes.js')
  const { aiAssessmentsAdminRoutes } = await import('./aiAssessments.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: currentUserId }; next() })
  app.use('/api/admin', aiNotesAdminRoutes)
  app.use('/api/admin', aiAssessmentsAdminRoutes)
  const server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

describe('AI Notes team settings', () => {
  it('lets a Team Admin switch AI Notes on, but not set the limit', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'T', slug: `t-${crypto.randomUUID()}` }).returning()
    const mk = async (isAppAdmin: boolean, role: 'team_admin' | 'contributor' | null) => {
      const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'A', isAppAdmin }).returning()
      if (role) await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: u!.id, role })
      return u!
    }
    const teamAdmin = await mk(false, 'team_admin')
    const contributor = await mk(false, 'contributor')
    const appAdmin = await mk(true, null)

    currentUserId = contributor.id
    expect((await call('GET', `/teams/${team!.id}/ai-notes`)).status).toBe(403)

    currentUserId = teamAdmin.id
    let r = await call<AiNotesTeamSettings>('GET', `/teams/${team!.id}/ai-notes`)
    expect(r.json.data).toMatchObject({ enabled: false, monthlyLimitUsd: null, canEditLimit: false, spentThisMonthUsd: 0 })
    r = await call<AiNotesTeamSettings>('PUT', `/teams/${team!.id}/ai-notes`, { enabled: true })
    expect(r.json.data).toMatchObject({ enabled: true })
    expect((await call('PUT', `/teams/${team!.id}/ai-notes`, { monthlyLimitUsd: 5 })).status).toBe(403)
    // Default sections live on the Default profile now (v1.471.0).
    expect((await call('PUT', `/teams/${team!.id}/ai-notes`, { defaultSections: ['summary'] })).status).toBe(400)

    currentUserId = appAdmin.id
    r = await call<AiNotesTeamSettings>('PUT', `/teams/${team!.id}/ai-notes`, { monthlyLimitUsd: 5 })
    expect(r.json.data).toMatchObject({ monthlyLimitUsd: 5, canEditLimit: true })
    const [row] = await testDb.select().from(schema.teams).where(eq(schema.teams.id, team!.id))
    expect(row!.aiNotesMonthlyLimitUsd).toBe('5.00')
  })
})

describe('AI Note profiles', () => {
  it('lets a Team Admin manage profiles on their team, and attach them only to that team\'s assessments', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'P', slug: `p-${crypto.randomUUID()}` }).returning()
    const [other] = await testDb.insert(schema.teams).values({ name: 'O', slug: `o-${crypto.randomUUID()}` }).returning()
    const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'TA' }).returning()
    await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: u!.id, role: 'team_admin' })
    currentUserId = u!.id

    const custom = { key: 'c_tech0001', name: 'Technical requirements', instructions: 'List each requirement.', icon: 'Cpu', color: '#0ea5e9' }
    expect((await call('POST', `/teams/${team!.id}/ai-note-profiles`, { name: 'Empty', sections: [], customSections: [] })).json.error).toBe('errors.ai_notes.profile_sections_required')
    expect((await call('POST', `/teams/${team!.id}/ai-note-profiles`, { name: 'Dup', sections: [], customSections: [custom, custom] })).status).toBe(400)
    expect((await call('POST', `/teams/${other!.id}/ai-note-profiles`, { name: 'X', sections: ['risks'], customSections: [] })).status).toBe(403)

    let r = await call<AiNoteProfile[]>('POST', `/teams/${team!.id}/ai-note-profiles`, { name: 'Discovery', sections: ['risks', 'summary'], customSections: [custom] })
    expect(r.status).toBe(201)
    expect(r.json.data).toMatchObject([{ name: 'Discovery', sections: ['summary', 'risks'], customSections: [custom], assessmentCount: 0, isDefault: false, combineMode: 'add' }])
    const profileId = r.json.data[0]!.id

    const [foreign] = await testDb.insert(schema.aiNoteProfiles).values({ teamId: other!.id, name: 'Foreign', sections: ['risks'] }).returning()
    const rubric = { name: 'Discovery quality', criteria: [{ name: 'Pain', weight: 10, anchors: {} }] }
    expect((await call('POST', `/teams/${team!.id}/ai-assessments`, { ...rubric, aiNoteProfileId: foreign!.id })).json.error).toBe('errors.ai_assessments.profile_not_found')
    const created = await call<{ assessments: Array<{ id: string; aiNoteProfileId: string | null; aiNoteProfileName: string | null }> }>('POST', `/teams/${team!.id}/ai-assessments`, { ...rubric, aiNoteProfileId: profileId })
    expect(created.status).toBe(201)
    expect(created.json.data.assessments[0]).toMatchObject({ aiNoteProfileId: profileId, aiNoteProfileName: 'Discovery' })

    r = await call<AiNoteProfile[]>('PUT', `/teams/${team!.id}/ai-note-profiles/${profileId}`, { name: 'Discovery v2', sections: [], customSections: [custom] })
    expect(r.json.data[0]).toMatchObject({ name: 'Discovery v2', sections: [], assessmentCount: 1 })
    expect((await call('PUT', `/teams/${team!.id}/ai-note-profiles/${foreign!.id}`, { name: 'Z', sections: ['risks'], customSections: [] })).status).toBe(404)

    r = await call<AiNoteProfile[]>('DELETE', `/teams/${team!.id}/ai-note-profiles/${profileId}`)
    expect(r.json.data).toEqual([])
    const [a] = await testDb.select().from(schema.aiAssessments).where(eq(schema.aiAssessments.id, created.json.data.assessments[0]!.id))
    expect(a!.aiNoteProfileId).toBeNull()
  })

  it('keeps one Default profile per team, and lets a profile replace the default where its assessment runs', async () => {
    const [team] = await testDb.insert(schema.teams).values({ name: 'D', slug: `d-${crypto.randomUUID()}` }).returning()
    const [type] = await testDb.insert(schema.teamActivityTypes).values({ teamId: team!.id, name: 'Demo', crmObjectType: 'Event', sortOrder: 1 }).returning()
    const [u] = await testDb.insert(schema.users).values({ oktaId: `okta-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.com`, displayName: 'TA' }).returning()
    await testDb.insert(schema.teamMembers).values({ teamId: team!.id, userId: u!.id, role: 'team_admin' })
    currentUserId = u!.id
    const { sectionPlanForActivity } = await import('../../services/aiNotes/profiles.js')
    const act = { teamId: team!.id, activityTypeId: type!.id, subtypeId: null }

    // No Default profile: every built-in section.
    expect((await sectionPlanForActivity(act, u!.id, team!.id)).sections).toEqual(['summary', 'checked', 'next_steps', 'risks', 'meddpicc'])

    const custom = { key: 'c_team0001', name: 'Team custom', instructions: 'Write it.', icon: null, color: null }
    let r = await call<AiNoteProfile[]>('POST', `/teams/${team!.id}/ai-note-profiles`, { name: 'Team default', sections: ['summary'], customSections: [custom] })
    const defaultId = r.json.data[0]!.id
    r = await call<AiNoteProfile[]>('POST', `/teams/${team!.id}/ai-note-profiles`, { name: 'Demo only', sections: ['next_steps'], customSections: [], combineMode: 'replace' })
    const replaceId = r.json.data.find((p) => p.name === 'Demo only')!.id
    expect(r.json.data.find((p) => p.id === replaceId)).toMatchObject({ combineMode: 'replace', isDefault: false })

    r = await call<AiNoteProfile[]>('PUT', `/teams/${team!.id}/ai-note-profile-default`, { profileId: defaultId })
    expect(r.json.data[0]).toMatchObject({ id: defaultId, isDefault: true })
    expect(r.json.data.filter((p) => p.isDefault)).toHaveLength(1)
    let plan = await sectionPlanForActivity(act, u!.id, team!.id)
    expect(plan).toMatchObject({ sections: ['summary'], customSections: [custom] })
    expect(plan.profiles.map((p) => p.id)).toEqual([defaultId])

    // Moving the star leaves one Default.
    r = await call<AiNoteProfile[]>('PUT', `/teams/${team!.id}/ai-note-profile-default`, { profileId: replaceId })
    expect(r.json.data.filter((p) => p.isDefault).map((p) => p.id)).toEqual([replaceId])
    r = await call<AiNoteProfile[]>('PUT', `/teams/${team!.id}/ai-note-profile-default`, { profileId: defaultId })
    expect((await call('PUT', `/teams/${team!.id}/ai-note-profile-default`, { profileId: crypto.randomUUID() })).status).toBe(404)

    // An assessment with the Replace profile on Demo drops the team default.
    const rubric = { name: 'Demo quality', criteria: [{ name: 'Flow', weight: 10, anchors: {} }], aiNoteProfileId: replaceId }
    const created = await call<{ assessments: Array<{ id: string }> }>('POST', `/teams/${team!.id}/ai-assessments`, rubric)
    expect(created.status).toBe(201)
    await testDb.insert(schema.aiAssessmentAssignments).values({ assessmentId: created.json.data.assessments[0]!.id, teamId: team!.id, activityTypeId: type!.id })
    plan = await sectionPlanForActivity(act, u!.id, team!.id)
    expect(plan).toMatchObject({ sections: ['next_steps'], customSections: [] })
    expect(plan.profiles.map((p) => p.id)).toEqual([replaceId])

    // A person's own sections are never replaced.
    await testDb.update(schema.users).set({ aiNotesSections: ['risks'] }).where(eq(schema.users.id, u!.id))
    expect((await sectionPlanForActivity(act, u!.id, team!.id)).sections).toEqual(['next_steps', 'risks'])

    // Edit without combineMode keeps it; clearing the star leaves no Default.
    r = await call<AiNoteProfile[]>('PUT', `/teams/${team!.id}/ai-note-profiles/${replaceId}`, { name: 'Demo only', sections: ['next_steps'], customSections: [] })
    expect(r.json.data.find((p) => p.id === replaceId)!.combineMode).toBe('replace')
    r = await call<AiNoteProfile[]>('PUT', `/teams/${team!.id}/ai-note-profile-default`, { profileId: null })
    expect(r.json.data.some((p) => p.isDefault)).toBe(false)
  })
})
