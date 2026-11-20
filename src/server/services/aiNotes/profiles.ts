import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { aiAssessments, aiNoteProfiles, users } from '../../../../drizzle/schema.js'
import {
  baseKept,
  mergeProfileSections,
  normalizeAiNoteSections,
  parseCustomSections,
  resolveSectionBase,
  type AiNoteCustomSection,
  type AiNoteProfileCombineMode,
  type AiNoteSection,
  type AiNoteSectionBase,
} from '../../../shared/aiNotes.js'
import { assessmentsForActivity, type ScoringActivity } from '../aiAssessments/score.js'

// AI Note profiles (v1.466.0): the sections an activity's AI Note gets are
// a base (the owner's own sections, else the team's Default profile
// (v1.471.0), else every built-in) plus the sections of every AI Note
// profile attached to an AI Assessment that runs on the activity (same
// assignment rules as scoring: a Subtype row wins over the type-wide row).
// A profile set to Replace drops the team default instead of adding to it.

export interface ActivityProfile {
  id: string
  name: string
  icon: string | null
  color: string | null
  sections: AiNoteSection[]
  customSections: AiNoteCustomSection[]
  combineMode: AiNoteProfileCombineMode
  isDefault: boolean
}

function toActivityProfile(row: typeof aiNoteProfiles.$inferSelect): ActivityProfile {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.iconColor,
    sections: normalizeAiNoteSections(row.sections) ?? [],
    customSections: parseCustomSections(row.customSections),
    combineMode: row.combineMode === 'replace' ? 'replace' : 'add',
    isDefault: row.isDefault,
  }
}

export async function teamDefaultProfile(teamId: string): Promise<ActivityProfile | null> {
  const [row] = await db.select().from(aiNoteProfiles)
    .where(and(eq(aiNoteProfiles.teamId, teamId), eq(aiNoteProfiles.isDefault, true))).limit(1)
  return row ? toActivityProfile(row) : null
}

// The owner's base sections, and the Default profile when that is where
// they came from.
export async function sectionBaseForOwner(ownerId: string | null, teamId: string): Promise<{ base: AiNoteSectionBase; defaultProfile: ActivityProfile | null }> {
  const [u] = ownerId ? await db.select({ sections: users.aiNotesSections }).from(users).where(eq(users.id, ownerId)).limit(1) : []
  const def = await teamDefaultProfile(teamId)
  const base = resolveSectionBase(u?.sections ?? null, def)
  return { base, defaultProfile: base.source === 'team_default' ? def : null }
}

export async function profilesForActivity(act: Pick<ScoringActivity, 'teamId' | 'activityTypeId' | 'subtypeId'>): Promise<ActivityProfile[]> {
  const rubrics = await assessmentsForActivity(act)
  if (rubrics.length === 0) return []
  const heads = await db.select({ id: aiAssessments.id, profileId: aiAssessments.aiNoteProfileId })
    .from(aiAssessments).where(inArray(aiAssessments.id, rubrics.map((r) => r.id)))
  const byAssessment = new Map(heads.map((h) => [h.id, h.profileId]))
  // Assignment order, each profile once.
  const profileIds: string[] = []
  for (const r of rubrics) {
    const pid = byAssessment.get(r.id)
    if (pid && !profileIds.includes(pid)) profileIds.push(pid)
  }
  if (profileIds.length === 0) return []
  const rows = await db.select().from(aiNoteProfiles).where(inArray(aiNoteProfiles.id, profileIds)).orderBy(asc(aiNoteProfiles.name))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: ActivityProfile[] = []
  for (const id of profileIds) {
    const row = byId.get(id)
    if (row) out.push(toActivityProfile(row))
  }
  return out
}

export interface AiNoteSectionPlan {
  sections: AiNoteSection[]
  customSections: AiNoteCustomSection[]
  // Profiles that shaped the note: the Default profile when it was the base
  // and wasn't replaced, then the assessments' profiles.
  profiles: ActivityProfile[]
}

export async function sectionPlanForActivity(
  act: Pick<ScoringActivity, 'teamId' | 'activityTypeId' | 'subtypeId'> | null,
  ownerId: string,
  teamId: string,
): Promise<AiNoteSectionPlan> {
  const { base, defaultProfile } = await sectionBaseForOwner(ownerId, teamId)
  const profiles = act ? await profilesForActivity(act) : []
  const merged = mergeProfileSections(base, profiles)
  const shown = defaultProfile && baseKept(base, profiles) && !profiles.some((p) => p.id === defaultProfile.id)
    ? [defaultProfile, ...profiles]
    : profiles
  return { ...merged, profiles: shown }
}
