// AI Notes (v1.457.0, Gong plan phase 4): shared between the server and the
// activity drawer's AI Notes tab.

import { z } from 'zod'

// The sections an AI Note can have. "checked" (the transcript checked against
// the owner's notes) only appears when a transcript was read.
export const AI_NOTE_SECTIONS = ['summary', 'checked', 'next_steps', 'risks', 'meddpicc'] as const
export type AiNoteSection = typeof AI_NOTE_SECTIONS[number]

export const AI_NOTE_VERDICTS = ['confirmed', 'not_in_notes', 'differs'] as const
export type AiNoteVerdict = typeof AI_NOTE_VERDICTS[number]

// Same keys as a note's MEDDPICC tags (activity_notes.meddpicc).
export const AI_NOTE_MEDDPICC_KEYS = [
  'metrics', 'economic_buyer', 'decision_criteria', 'decision_process',
  'paper_process', 'identified_pain', 'champion', 'competition',
] as const
export type AiNoteMeddpiccKey = typeof AI_NOTE_MEDDPICC_KEYS[number]

export const AI_NOTE_ITEM_STATUSES = ['to_review', 'kept'] as const
export type AiNoteItemStatus = typeof AI_NOTE_ITEM_STATUSES[number]

// Where an item came from: a point in a transcript (ms from the call's
// start) or one of the owner's notes.
export type AiNoteCitation =
  | { kind: 'transcript'; callId: string; startMs: number }
  | { kind: 'note'; noteId: string }

// A section of an AI Note: a built-in one, or a profile's custom section
// ("c_" + random id, v1.466.0).
export type AiNoteSectionKey = AiNoteSection | `c_${string}`

export function isBuiltInAiNoteSection(key: string): key is AiNoteSection {
  return (AI_NOTE_SECTIONS as readonly string[]).includes(key)
}

// How a custom section looked when its item was written.
export interface AiNoteSectionMeta { name: string; icon: string | null; color: string | null }

export interface AiNoteItem {
  id: string
  section: AiNoteSectionKey
  // Set for a custom section's items.
  sectionMeta: AiNoteSectionMeta | null
  text: string
  verdict: AiNoteVerdict | null
  ownerName: string | null
  meddpiccKey: AiNoteMeddpiccKey | null
  citations: AiNoteCitation[]
  status: AiNoteItemStatus
  createdAt: string
  reviewedAt: string | null
  reviewedByName: string | null
  copiedNoteId: string | null
}

// Why Generate can't run right now. The tab stays readable either way.
export type AiNotesBlockedReason =
  | 'not_owner'
  | 'over_budget'
  | 'team_over_budget'
  | 'nothing_to_read'
  // A Demo Data activity: its AI Note is a sample, Generate is off.
  | 'demo_data'

export interface AiNotesCallSource { id: string; title: string | null; url: string | null; startedAt: string | null }

export interface AiNotesView {
  // false: the tab is hidden for this person on this activity.
  enabled: boolean
  canGenerate: boolean
  blockedReason: AiNotesBlockedReason | null
  // Only the owner keeps, removes and copies items.
  canEdit: boolean
  sections: AiNoteSection[]
  // Custom sections the activity's AI Note profiles add (v1.466.0).
  customSections: AiNoteCustomSection[]
  // The profiles adding sections to this activity's AI Note.
  profiles: Array<{ id: string; name: string; icon: string | null; color: string | null }>
  sources: { calls: AiNotesCallSource[]; notes: number; transcriptsAvailable: boolean }
  note: {
    generatedAt: string
    generatedByName: string | null
    model: string | null
    usedPrivateNotes: boolean
    fromTranscript: boolean
  } | null
  items: AiNoteItem[]
}

// My Notes → AI (phase 5): one row per AI Note on the caller's activities.
export interface MyAiNoteRow {
  activityId: string
  activityTitle: string | null
  activityIsPrivateMeeting: boolean
  activityDate: string | null
  activityTypeName: string | null
  activityTypeColor: string | null
  activityTypeIcon: string | null
  crmWhatId: string | null
  crmWhatType: string | null
  crmWhatName: string | null
  crmWhoId: string | null
  crmWhoType: string | null
  crmWhoName: string | null
  generatedAt: string
  fromTranscript: boolean
  usedPrivateNotes: boolean
  toReview: number
  kept: number
}

export interface MyAiNotesList {
  // false: My Notes hides the Written / AI switch.
  enabled: boolean
  notes: MyAiNoteRow[]
  totals: { notes: number; toReview: number }
}

// Team settings (Admin → Workplace → AI Notes).
export interface AiNotesTeamSettings {
  enabled: boolean
  monthlyLimitUsd: number | null
  spentThisMonthUsd: number
  // Only an App Admin changes the spend limit.
  canEditLimit: boolean
}

export function normalizeAiNoteSections(raw: readonly string[] | null | undefined): AiNoteSection[] | null {
  if (!raw) return null
  const set = new Set(raw)
  return AI_NOTE_SECTIONS.filter((s) => set.has(s))
}

// ── AI Note profiles (v1.466.0) ──────────────────────────────────────────
// A team's named set of AI Note sections, attached to AI Assessments. When
// an assessment runs on an activity, its profile's sections are added to the
// owner's own sections; several profiles combine.

export const AI_NOTE_CUSTOM_KEY_RX = /^c_[a-z0-9]{6,16}$/
export const AI_NOTE_PROFILE_MAX_CUSTOM = 8
export const AI_NOTE_CUSTOM_NAME_MAX = 60
export const AI_NOTE_CUSTOM_INSTRUCTIONS_MAX = 1000

export interface AiNoteCustomSection {
  key: string
  name: string
  // What the AI writes in this section.
  instructions: string
  icon: string | null
  color: string | null
}

export const AI_NOTE_PROFILE_COMBINE_MODES = ['add', 'replace'] as const
export type AiNoteProfileCombineMode = typeof AI_NOTE_PROFILE_COMBINE_MODES[number]

export interface AiNoteProfile {
  id: string
  teamId: string
  name: string
  description: string | null
  icon: string | null
  iconColor: string | null
  sections: AiNoteSection[]
  customSections: AiNoteCustomSection[]
  // The team's Default profile (v1.471.0): the base sections of anyone who
  // hasn't picked their own. At most one per team.
  isDefault: boolean
  // Where this profile's assessment runs: add to the default sections, or
  // replace them. A person's own sections are always kept.
  combineMode: AiNoteProfileCombineMode
  // Assessments (any team) that use this profile.
  assessmentCount: number
  updatedAt: string
}

const iconSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/).nullable()
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable()

export const aiNoteCustomSectionSchema = z.object({
  key: z.string().regex(AI_NOTE_CUSTOM_KEY_RX),
  name: z.string().trim().min(1).max(AI_NOTE_CUSTOM_NAME_MAX),
  instructions: z.string().trim().min(1).max(AI_NOTE_CUSTOM_INSTRUCTIONS_MAX),
  icon: iconSchema.optional().default(null),
  color: colorSchema.optional().default(null),
})

export const aiNoteProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  icon: iconSchema.optional(),
  iconColor: colorSchema.optional(),
  sections: z.array(z.enum(AI_NOTE_SECTIONS)).max(AI_NOTE_SECTIONS.length),
  customSections: z.array(aiNoteCustomSectionSchema).max(AI_NOTE_PROFILE_MAX_CUSTOM),
  // Left out on an edit: the profile keeps its current mode.
  combineMode: z.enum(AI_NOTE_PROFILE_COMBINE_MODES).optional(),
}).refine((v) => v.sections.length + v.customSections.length > 0, { message: 'sections_required', path: ['sections'] })
  .refine((v) => new Set(v.customSections.map((c) => c.key)).size === v.customSections.length, { message: 'duplicate_key', path: ['customSections'] })
export type AiNoteProfileInput = z.infer<typeof aiNoteProfileInputSchema>

// Reads custom sections stored as jsonb; anything malformed is dropped.
export function parseCustomSections(raw: unknown): AiNoteCustomSection[] {
  if (!Array.isArray(raw)) return []
  const out: AiNoteCustomSection[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const parsed = aiNoteCustomSectionSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.key)) continue
    seen.add(parsed.data.key)
    out.push(parsed.data)
  }
  return out
}

export function parseSectionMeta(raw: unknown): AiNoteSectionMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || !r.name) return null
  return {
    name: r.name,
    icon: typeof r.icon === 'string' ? r.icon : null,
    color: typeof r.color === 'string' ? r.color : null,
  }
}

// Where an AI Note's base sections came from (v1.471.0): the person's own
// choice in My Settings, the team's Default profile, or all built-ins when
// the team has no Default profile.
export type AiNoteSectionBaseSource = 'personal' | 'team_default' | 'builtin'

export interface AiNoteSectionBase {
  sections: AiNoteSection[]
  customSections: AiNoteCustomSection[]
  source: AiNoteSectionBaseSource
}

// A person's own sections win; else the team's Default profile (built-in
// and custom sections); else every built-in section. A Default profile with
// nothing usable in it falls through too, so a note always has sections.
export function resolveSectionBase(
  userSections: readonly string[] | null | undefined,
  teamDefault: { sections: readonly string[] | null; customSections: readonly AiNoteCustomSection[] } | null,
): AiNoteSectionBase {
  const own = normalizeAiNoteSections(userSections)
  if (own && own.length > 0) return { sections: own, customSections: [], source: 'personal' }
  if (teamDefault) {
    const sections = normalizeAiNoteSections(teamDefault.sections) ?? []
    if (sections.length + teamDefault.customSections.length > 0) {
      return { sections, customSections: [...teamDefault.customSections], source: 'team_default' }
    }
  }
  return { sections: [...AI_NOTE_SECTIONS], customSections: [], source: 'builtin' }
}

// Whether the base survives the profiles that apply: a Replace profile drops
// the team default (or the built-in fallback), never a person's own choice.
export function baseKept(
  base: Pick<AiNoteSectionBase, 'source'>,
  profiles: ReadonlyArray<{ combineMode?: AiNoteProfileCombineMode }>,
): boolean {
  if (base.source === 'personal') return true
  return !profiles.some((p) => p.combineMode === 'replace')
}

// The base sections plus every profile's: built-ins in their usual order,
// then custom sections (base first, then profile order). The same custom key
// twice (a copied profile) counts once. A Replace profile drops the base
// unless it is the person's own (see baseKept).
export function mergeProfileSections(
  base: Pick<AiNoteSectionBase, 'sections' | 'customSections' | 'source'>,
  profiles: ReadonlyArray<{ sections: readonly string[]; customSections: readonly AiNoteCustomSection[]; combineMode?: AiNoteProfileCombineMode }>,
): { sections: AiNoteSection[]; customSections: AiNoteCustomSection[] } {
  const keep = baseKept(base, profiles)
  const builtIn = new Set<string>(keep ? base.sections : [])
  const custom: AiNoteCustomSection[] = []
  const seen = new Set<string>()
  for (const c of keep ? base.customSections : []) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    custom.push(c)
  }
  for (const p of profiles) {
    for (const s of p.sections) builtIn.add(s)
    for (const c of p.customSections) {
      if (seen.has(c.key)) continue
      seen.add(c.key)
      custom.push(c)
    }
  }
  return { sections: AI_NOTE_SECTIONS.filter((s) => builtIn.has(s)), customSections: custom }
}

export function newCustomSectionKey(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return `c_${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}
