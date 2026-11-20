import { Router } from 'express'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/index.js'
import { aiAssessments, aiNoteProfiles, teams } from '../../../../drizzle/schema.js'
import {
  aiNoteProfileInputSchema,
  normalizeAiNoteSections,
  parseCustomSections,
  type AiNoteProfile,
  type AiNotesTeamSettings,
} from '../../../shared/aiNotes.js'
import { isAppAdmin, requireRole } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { teamSpentThisMonthUsd } from '../../services/ai/gateway.js'
import { getAiNotesTeam } from '../../services/aiNotes/generate.js'

// Admin → Workplace → AI Notes (v1.457.0, Gong plan phase 4): a team's AI
// Notes switch and monthly spend limit. Team Admins of the team set the
// switch; only an App Admin sets the limit, since it sits inside the
// app-wide AI budget the App Admin owns. The team's default sections are its
// Default AI Note profile (v1.471.0), managed with the other profiles below.

export const aiNotesAdminRoutes = Router()

async function settingsFor(teamId: string, callerId: string): Promise<AiNotesTeamSettings | null> {
  const team = await getAiNotesTeam(teamId)
  if (!team) return null
  return {
    enabled: team.enabled,
    monthlyLimitUsd: team.monthlyLimitUsd,
    spentThisMonthUsd: await teamSpentThisMonthUsd(teamId),
    canEditLimit: await isAppAdmin(callerId),
  }
}

aiNotesAdminRoutes.get('/teams/:teamId/ai-notes', requireRole('admin'), async (req, res) => {
  const data = await settingsFor(req.params['teamId'] as string, req.user!.id)
  if (!data) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data, error: null, meta: {} })
})

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  monthlyLimitUsd: z.number().min(0).max(1_000_000).nullable().optional(),
}).strict()

aiNotesAdminRoutes.put('/teams/:teamId/ai-notes', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation_failed', meta: {} }); return }
  const before = await getAiNotesTeam(teamId)
  if (!before) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const limitChanged = parsed.data.monthlyLimitUsd !== undefined && parsed.data.monthlyLimitUsd !== before.monthlyLimitUsd
  if (limitChanged && !(await isAppAdmin(req.user!.id))) {
    res.status(403).json({ data: null, error: 'errors.ai_notes.limit_app_admin_only', meta: {} })
    return
  }
  const set: Partial<typeof teams.$inferInsert> = {}
  if (parsed.data.enabled !== undefined) set.aiNotesEnabled = parsed.data.enabled
  if (limitChanged) set.aiNotesMonthlyLimitUsd = parsed.data.monthlyLimitUsd === null || parsed.data.monthlyLimitUsd === undefined ? null : parsed.data.monthlyLimitUsd.toFixed(2)
  if (Object.keys(set).length > 0) {
    await db.update(teams).set(set).where(eq(teams.id, teamId))
    await logAudit(req, {
      action: 'team.ai_notes.update',
      targetType: 'team',
      targetId: teamId,
      meta: {
        before: { enabled: before.enabled, monthlyLimitUsd: before.monthlyLimitUsd },
        after: { enabled: parsed.data.enabled, monthlyLimitUsd: limitChanged ? parsed.data.monthlyLimitUsd : undefined },
      },
    })
  }
  res.json({ data: await settingsFor(teamId, req.user!.id), error: null, meta: {} })
})

// ── AI Note profiles (v1.466.0) ──────────────────────────────────────────
// A team's named section sets, attached to AI Assessments from the
// assessment editor. Team Admins of the team manage them.

function profileFromRow(row: typeof aiNoteProfiles.$inferSelect, assessmentCount: number): AiNoteProfile {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    icon: row.icon,
    iconColor: row.iconColor,
    sections: normalizeAiNoteSections(row.sections) ?? [],
    customSections: parseCustomSections(row.customSections),
    isDefault: row.isDefault,
    combineMode: row.combineMode === 'replace' ? 'replace' : 'add',
    assessmentCount,
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function listProfiles(teamId: string): Promise<AiNoteProfile[]> {
  // The Default profile first, then by name.
  const rows = await db.select().from(aiNoteProfiles).where(eq(aiNoteProfiles.teamId, teamId)).orderBy(desc(aiNoteProfiles.isDefault), asc(aiNoteProfiles.name))
  if (rows.length === 0) return []
  const counts = await db.select({ id: aiAssessments.aiNoteProfileId, n: count() }).from(aiAssessments)
    .where(inArray(aiAssessments.aiNoteProfileId, rows.map((r) => r.id)))
    .groupBy(aiAssessments.aiNoteProfileId)
  const byId = new Map(counts.map((c) => [c.id, Number(c.n)]))
  return rows.map((r) => profileFromRow(r, byId.get(r.id) ?? 0))
}

async function findProfile(teamId: string, profileId: string) {
  const [row] = await db.select().from(aiNoteProfiles)
    .where(and(eq(aiNoteProfiles.id, profileId), eq(aiNoteProfiles.teamId, teamId))).limit(1)
  return row ?? null
}

function badProfileInput(res: import('express').Response, error: z.ZodError) {
  const sectionsMissing = error.issues.some((i) => i.message === 'sections_required')
  res.status(400).json({ data: null, error: sectionsMissing ? 'errors.ai_notes.profile_sections_required' : 'errors.validation_failed', meta: {} })
}

aiNotesAdminRoutes.get('/teams/:teamId/ai-note-profiles', requireRole('admin'), async (req, res) => {
  res.json({ data: await listProfiles(req.params['teamId'] as string), error: null, meta: {} })
})

aiNotesAdminRoutes.post('/teams/:teamId/ai-note-profiles', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const parsed = aiNoteProfileInputSchema.safeParse(req.body)
  if (!parsed.success) { badProfileInput(res, parsed.error); return }
  const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1)
  if (!team) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const p = parsed.data
  const [row] = await db.insert(aiNoteProfiles).values({
    teamId,
    name: p.name,
    description: p.description ? p.description : null,
    icon: p.icon ?? null,
    iconColor: p.iconColor ?? null,
    sections: normalizeAiNoteSections(p.sections) ?? [],
    customSections: p.customSections,
    combineMode: p.combineMode ?? 'add',
    createdBy: req.user!.id,
    updatedBy: req.user!.id,
  }).returning({ id: aiNoteProfiles.id })
  await logAudit(req, {
    action: 'ai_note_profile.create',
    targetType: 'ai_note_profile',
    targetId: row!.id,
    meta: { teamId, name: p.name, sections: p.sections, customSections: p.customSections.map((c) => c.name), combineMode: p.combineMode ?? 'add' },
  })
  res.status(201).json({ data: await listProfiles(teamId), error: null, meta: { id: row!.id } })
})

aiNotesAdminRoutes.put('/teams/:teamId/ai-note-profiles/:profileId', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const profileId = req.params['profileId'] as string
  const parsed = aiNoteProfileInputSchema.safeParse(req.body)
  if (!parsed.success) { badProfileInput(res, parsed.error); return }
  const existing = await findProfile(teamId, profileId)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const p = parsed.data
  await db.update(aiNoteProfiles).set({
    name: p.name,
    description: p.description ? p.description : null,
    icon: p.icon ?? null,
    iconColor: p.iconColor ?? null,
    sections: normalizeAiNoteSections(p.sections) ?? [],
    customSections: p.customSections,
    ...(p.combineMode ? { combineMode: p.combineMode } : {}),
    updatedBy: req.user!.id,
    updatedAt: new Date(),
  }).where(eq(aiNoteProfiles.id, profileId))
  await logAudit(req, {
    action: 'ai_note_profile.update',
    targetType: 'ai_note_profile',
    targetId: profileId,
    meta: {
      teamId,
      before: { name: existing.name, sections: existing.sections, customSections: parseCustomSections(existing.customSections).map((c) => c.name), combineMode: existing.combineMode },
      after: { name: p.name, sections: p.sections, customSections: p.customSections.map((c) => c.name), combineMode: p.combineMode ?? existing.combineMode },
    },
  })
  res.json({ data: await listProfiles(teamId), error: null, meta: {} })
})

// PUT /teams/:teamId/ai-note-profile-default { profileId | null }: makes a
// profile the team's Default (v1.471.0), or clears it so people without
// their own sections get every built-in section.
const defaultSchema = z.object({ profileId: z.string().uuid().nullable() }).strict()

aiNotesAdminRoutes.put('/teams/:teamId/ai-note-profile-default', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const parsed = defaultSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation_failed', meta: {} }); return }
  const { profileId } = parsed.data
  const target = profileId ? await findProfile(teamId, profileId) : null
  if (profileId && !target) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [previous] = await db.select({ id: aiNoteProfiles.id, name: aiNoteProfiles.name }).from(aiNoteProfiles)
    .where(and(eq(aiNoteProfiles.teamId, teamId), eq(aiNoteProfiles.isDefault, true))).limit(1)
  if ((previous?.id ?? null) !== profileId) {
    await db.transaction(async (tx) => {
      await tx.update(aiNoteProfiles).set({ isDefault: false, updatedBy: req.user!.id, updatedAt: new Date() })
        .where(and(eq(aiNoteProfiles.teamId, teamId), eq(aiNoteProfiles.isDefault, true)))
      if (profileId) {
        await tx.update(aiNoteProfiles).set({ isDefault: true, updatedBy: req.user!.id, updatedAt: new Date() })
          .where(eq(aiNoteProfiles.id, profileId))
      }
    })
    await logAudit(req, {
      action: 'ai_note_profile.update',
      targetType: 'ai_note_profile',
      targetId: profileId ?? previous!.id,
      meta: { teamId, defaultBefore: previous?.name ?? null, defaultAfter: target?.name ?? null },
    })
  }
  res.json({ data: await listProfiles(teamId), error: null, meta: {} })
})

// Assessments using the profile keep running; they just stop adding sections.
// Deleting the Default profile leaves the team with none (every built-in).
aiNotesAdminRoutes.delete('/teams/:teamId/ai-note-profiles/:profileId', requireRole('admin'), async (req, res) => {
  const teamId = req.params['teamId'] as string
  const profileId = req.params['profileId'] as string
  const existing = await findProfile(teamId, profileId)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const using = await db.select({ id: aiAssessments.id }).from(aiAssessments).where(eq(aiAssessments.aiNoteProfileId, profileId))
  await db.delete(aiNoteProfiles).where(eq(aiNoteProfiles.id, profileId))
  await logAudit(req, {
    action: 'ai_note_profile.delete',
    targetType: 'ai_note_profile',
    targetId: profileId,
    meta: { teamId, name: existing.name, detachedFrom: using.map((u) => u.id) },
  })
  res.json({ data: await listProfiles(teamId), error: null, meta: {} })
})
