import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import {
  activityAiNoteItems,
  activityAiNotes,
  activityGongCalls,
  activityNotes,
  gongCalls,
  teams,
  users,
} from '../../../../drizzle/schema.js'
import type { GongParty } from '../../../shared/gong.js'
import type { AiNotesBlockedReason } from '../../../shared/aiNotes.js'
import { isAiFeatureOn } from '../../../shared/ai.js'
import { aiAvailability, hashInput, runAi, teamSpentThisMonthUsd, type AiResult } from '../ai/gateway.js'
import { getAiSettings, providerForFeature } from '../ai/providers.js'
import { getGongTranscriptCacheDays, isGongConfigured } from '../gong/config.js'
import { getGongTranscript } from '../gong/transcripts.js'
import { DEMO_TEAM_SLUG } from '../demo/ids.js'
import { assessmentsForActivity, loadScoringActivity, scoreActivity } from '../aiAssessments/score.js'
import { sectionPlanForActivity } from './profiles.js'
import {
  aiNoteJsonSchema,
  CHUNK_SYSTEM_PROMPT,
  SINGLE_PASS_MAX_CHARS,
  chunkTranscripts,
  notesText,
  parseAiNoteAnswer,
  systemPrompt,
  transcriptText,
  userPrompt,
  type PromptCall,
  type PromptNote,
} from './prompt.js'

// Writes an activity's AI Note (Gong plan, phase 4). Runs only when the
// owner clicks Generate or Regenerate, through runAi() (provider routing,
// the app-wide budget and the usage log apply), with every call tagged with
// the activity's team so the team's monthly limit can be checked first.
// Regenerate replaces the items still waiting for review; kept items stay
// and the AI is told not to repeat them.

const MAX_CALLS = 5

export interface AiNotesTeam {
  id: string
  enabled: boolean
  monthlyLimitUsd: number | null
  // The Demo Data team (v1.459.0): its AI Notes are seeded samples, shown
  // without the AI Assistant, and Generate never runs for it.
  isDemo?: boolean
}

export async function getAiNotesTeam(teamId: string): Promise<AiNotesTeam | null> {
  const [t] = await db.select({
    id: teams.id,
    enabled: teams.aiNotesEnabled,
    limit: teams.aiNotesMonthlyLimitUsd,
    slug: teams.slug,
  }).from(teams).where(eq(teams.id, teamId)).limit(1)
  if (!t) return null
  return { id: t.id, enabled: t.enabled, monthlyLimitUsd: t.limit === null ? null : Number(t.limit), isDemo: t.slug === DEMO_TEAM_SLUG }
}

export async function teamOverLimit(team: AiNotesTeam): Promise<boolean> {
  if (team.monthlyLimitUsd === null) return false
  return (await teamSpentThisMonthUsd(team.id)) >= team.monthlyLimitUsd
}

// Whether AI Notes are switched on for this team at all: the AI Assistant
// on with a provider for the feature, and the team's switch on. The demo
// team needs only its switch: nothing there ever calls the AI.
export async function aiNotesSwitchedOn(team: AiNotesTeam | null): Promise<boolean> {
  if (!team?.enabled) return false
  if (team.isDemo) return true
  const settings = await getAiSettings()
  if (!settings.enabled || !isAiFeatureOn(settings, 'activity_ai_notes')) return false
  return !!(await providerForFeature('activity_ai_notes'))
}

export interface OwnerNote { id: string; body: string; createdAt: Date; isPrivate: boolean }

// Only the owner's own notes feed their AI Note (private ones included).
export async function ownerNotes(activityId: string, ownerId: string): Promise<OwnerNote[]> {
  return db.select({ id: activityNotes.id, body: activityNotes.body, createdAt: activityNotes.createdAt, isPrivate: activityNotes.isPrivate })
    .from(activityNotes)
    .where(and(eq(activityNotes.activityId, activityId), eq(activityNotes.createdBy, ownerId)))
    .orderBy(asc(activityNotes.createdAt))
}

export async function linkedCallIds(activityId: string): Promise<string[]> {
  const rows = await db.select({ id: activityGongCalls.gongCallId }).from(activityGongCalls)
    .where(eq(activityGongCalls.activityId, activityId)).orderBy(asc(activityGongCalls.linkedAt))
  return rows.map((r) => r.id)
}

// Why the owner can't generate right now, or null. Cheap checks only.
export async function generateBlockedReason(opts: {
  isOwner: boolean
  team: AiNotesTeam
  noteCount: number
  transcriptsAvailable: boolean
}): Promise<AiNotesBlockedReason | null> {
  if (!opts.isOwner) return 'not_owner'
  if (opts.team.isDemo) return 'demo_data'
  const availability = await aiAvailability('activity_ai_notes')
  if (!availability.ok && availability.reason === 'over_budget') return 'over_budget'
  if (await teamOverLimit(opts.team)) return 'team_over_budget'
  if (opts.noteCount === 0 && !opts.transcriptsAvailable) return 'nothing_to_read'
  return null
}

export interface GenerateActivity { id: string; userId: string; teamId: string; title: string }

// The transcripts of the activity's linked Gong calls (at most MAX_CALLS),
// in link order. Calls without a transcript yet are skipped.
export async function loadTranscriptCalls(activityId: string): Promise<PromptCall[]> {
  const calls: PromptCall[] = []
  if (!(await isGongConfigured())) return calls
  const ids = (await linkedCallIds(activityId)).slice(0, MAX_CALLS)
  const rows = ids.length === 0 ? [] : await db.select().from(gongCalls).where(inArray(gongCalls.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    const transcript = await getGongTranscript(id)
    if (!transcript || transcript.monologues.length === 0) continue
    const row = byId.get(id)
    calls.push({
      label: `C${calls.length + 1}`,
      callId: id,
      title: row?.title ?? null,
      startedAt: row?.startedAt ?? null,
      parties: (Array.isArray(row?.parties) ? row.parties : []) as GongParty[],
      monologues: transcript.monologues,
    })
  }
  return calls
}

export type AskAi = (req: Parameters<typeof runAi>[0]) => Promise<AiResult>

export type SourceText =
  | { ok: true; sourceText: string; sourceIsSummary: boolean; truncated: boolean }
  | { ok: false; result: Extract<AiResult, { ok: false }> }

// The transcript as prompt text. A long one is condensed chunk by chunk
// first (at most MAX_CHUNKS AI calls), and the summaries are used instead.
export async function condenseTranscripts(
  calls: PromptCall[],
  opts: { feature: 'activity_ai_notes' | 'activity_ai_assessments'; callerId: string; teamId: string; ask: AskAi },
): Promise<SourceText> {
  const text = calls.length > 0 ? transcriptText(calls) : ''
  if (text.length <= SINGLE_PASS_MAX_CHARS) return { ok: true, sourceText: text, sourceIsSummary: false, truncated: false }
  const split = chunkTranscripts(calls)
  const parts: string[] = []
  for (const chunk of split.chunks) {
    const r = await opts.ask({ feature: opts.feature, system: CHUNK_SYSTEM_PROMPT, user: chunk, effort: 'low', maxTokens: 4000, requestedBy: opts.callerId, teamId: opts.teamId })
    if (!r.ok) return { ok: false, result: r }
    parts.push(r.text.trim())
  }
  return { ok: true, sourceText: parts.join('\n'), sourceIsSummary: true, truncated: split.truncated }
}

export type GenerateResult =
  | { ok: true; items: number; fromTranscript: boolean; truncated: boolean; assessed: number }
  | { ok: false; status: number; error: string }

function aiFailure(result: Extract<AiResult, { ok: false }>): GenerateResult {
  if (result.reason === 'over_budget') return { ok: false, status: 503, error: 'errors.ai_notes.over_budget' }
  if (result.reason === 'disabled' || result.reason === 'no_provider') return { ok: false, status: 503, error: 'errors.ai_notes.unavailable' }
  return { ok: false, status: 502, error: 'errors.ai_notes.failed' }
}

// Thrown Gong errors (GongError) are left to the caller, which answers 502.
export async function generateAiNote(activity: GenerateActivity, callerId: string): Promise<GenerateResult> {
  const team = await getAiNotesTeam(activity.teamId)
  if (!team || !(await aiNotesSwitchedOn(team))) return { ok: false, status: 409, error: 'errors.ai_notes.disabled' }
  if (activity.userId !== callerId) return { ok: false, status: 403, error: 'errors.ai_notes.not_owner' }
  // Demo AI Notes are samples: no AI spend on demo activities.
  if (team.isDemo) return { ok: false, status: 409, error: 'errors.ai_notes.demo_data' }

  const notes = await ownerNotes(activity.id, activity.userId)
  const promptNotes: PromptNote[] = notes.map((n, i) => ({ label: `N${i + 1}`, noteId: n.id, body: n.body, createdAt: n.createdAt }))

  const calls = await loadTranscriptCalls(activity.id)
  if (calls.length === 0 && promptNotes.length === 0) return { ok: false, status: 409, error: 'errors.ai_notes.nothing_to_read' }

  const hasTranscript = calls.length > 0
  // The owner's sections (else the team's Default profile) plus those of
  // the AI Note profiles on the assessments that run here (v1.466.0).
  const scoringActivity = await loadScoringActivity(activity.id)
  const plan = await sectionPlanForActivity(scoringActivity, activity.userId, team.id)
  const { sections, customSections } = plan
  const [existing] = await db.select().from(activityAiNotes).where(eq(activityAiNotes.activityId, activity.id)).limit(1)
  const kept = existing
    ? await db.select({ section: activityAiNoteItems.section, text: activityAiNoteItems.text }).from(activityAiNoteItems)
      .where(and(eq(activityAiNoteItems.aiNoteId, existing.id), eq(activityAiNoteItems.status, 'kept')))
      .orderBy(asc(activityAiNoteItems.sortOrder))
    : []

  const ask: AskAi = async (req) => {
    if (await teamOverLimit(team)) return { ok: false, reason: 'error', message: 'team_over_budget' }
    return runAi(req)
  }
  const teamLimitHit = (r: AiResult) => !r.ok && r.reason === 'error' && r.message === 'team_over_budget'

  // Long calls: condense each chunk first, then write the note from those.
  const source = await condenseTranscripts(calls, { feature: 'activity_ai_notes', callerId, teamId: team.id, ask })
  if (!source.ok) {
    if (teamLimitHit(source.result)) return { ok: false, status: 409, error: 'errors.ai_notes.team_over_budget' }
    return aiFailure(source.result)
  }
  const { sourceText, sourceIsSummary, truncated } = source

  const system = systemPrompt(sections, hasTranscript, customSections)
  const user = userPrompt({
    activityTitle: activity.title,
    sourceText,
    sourceIsSummary,
    notes: notesText(promptNotes),
    kept: kept.map((k) => ({ section: k.section, text: k.text })),
  })
  const result = await ask({
    feature: 'activity_ai_notes',
    system,
    user,
    maxTokens: 8000,
    requestedBy: callerId,
    teamId: team.id,
    json: { name: 'ai_note', schema: aiNoteJsonSchema(customSections.map((c) => c.key)) },
  })
  if (teamLimitHit(result)) return { ok: false, status: 409, error: 'errors.ai_notes.team_over_budget' }
  if (!result.ok) return aiFailure(result)
  const items = parseAiNoteAnswer(result.text, {
    sections,
    customSections,
    hasTranscript,
    calls: new Map(calls.map((c) => [c.label, c.callId])),
    notes: new Map(promptNotes.map((n) => [n.label, n.noteId])),
  })
  if (!items) return { ok: false, status: 502, error: 'errors.ai_notes.failed' }

  const usedPrivate = notes.some((n) => n.isPrivate)
  await db.transaction(async (tx) => {
    let noteId: string
    if (existing) {
      // Kept items may come from a private note read earlier, so the flag
      // only clears once none are left.
      const sticky = existing.usedPrivateNotes && kept.length > 0
      await tx.update(activityAiNotes).set({
        generatedAt: new Date(),
        generatedBy: callerId,
        providerId: result.providerId,
        model: result.model,
        inputHash: hashInput({ system, user }),
        gongCallIds: calls.map((c) => c.callId),
        noteCount: promptNotes.length,
        usedPrivateNotes: usedPrivate || sticky,
      }).where(eq(activityAiNotes.id, existing.id))
      await tx.delete(activityAiNoteItems).where(and(eq(activityAiNoteItems.aiNoteId, existing.id), eq(activityAiNoteItems.status, 'to_review')))
      noteId = existing.id
    } else {
      const [row] = await tx.insert(activityAiNotes).values({
        activityId: activity.id,
        generatedBy: callerId,
        providerId: result.providerId,
        model: result.model,
        inputHash: hashInput({ system, user }),
        gongCallIds: calls.map((c) => c.callId),
        noteCount: promptNotes.length,
        usedPrivateNotes: usedPrivate,
      }).returning({ id: activityAiNotes.id })
      noteId = row!.id
    }
    const [{ max } = { max: 0 }] = await tx.select({ max: sql<number>`coalesce(max(${activityAiNoteItems.sortOrder}), 0)::int` })
      .from(activityAiNoteItems).where(eq(activityAiNoteItems.aiNoteId, noteId))
    if (items.length > 0) {
      await tx.insert(activityAiNoteItems).values(items.map((it, i) => ({
        aiNoteId: noteId,
        activityId: activity.id,
        section: it.section,
        sectionMeta: it.sectionMeta,
        text: it.text,
        verdict: it.verdict,
        ownerName: it.ownerName,
        meddpiccKey: it.meddpiccKey,
        citations: it.citations,
        status: 'to_review',
        sortOrder: Number(max) + i + 1,
        fromTranscript: hasTranscript,
      })))
    }
  })
  // AI Assessments (v1.462.0): always run where assigned, only when a
  // transcript was read. The owner never sees the scores, and a scoring
  // failure never fails the AI Note.
  let assessed = 0
  if (hasTranscript) {
    try {
      const scoring = scoringActivity
      const rubrics = scoring ? await assessmentsForActivity(scoring) : []
      if (scoring && rubrics.length > 0) {
        const r = await scoreActivity({ activity: scoring, rubrics, calls, sourceText, sourceIsSummary, callerId, ask })
        if (r.ok) assessed = r.scored
        else console.warn(`[ai-assessments] scoring after Generate failed for ${activity.id}: ${r.reason}`)
      }
    } catch (err) {
      console.warn(`[ai-assessments] scoring after Generate failed for ${activity.id}:`, err instanceof Error ? err.message : String(err))
    }
  }
  return { ok: true, items: items.length, fromTranscript: hasTranscript, truncated, assessed }
}

// Housekeeping: an item nobody reviewed doesn't outlive the transcript it
// was written from. Items written from notes alone have no transcript to
// expire with and stay until reviewed or regenerated.
export async function cullUnreviewedAiNoteItems(now: number = Date.now()): Promise<number> {
  const days = await getGongTranscriptCacheDays()
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000)
  return (await db.delete(activityAiNoteItems)
    .where(and(
      eq(activityAiNoteItems.status, 'to_review'),
      eq(activityAiNoteItems.fromTranscript, true),
      lt(activityAiNoteItems.createdAt, cutoff),
      // Demo samples stay until Remove Demo Data.
      sql`${activityAiNoteItems.activityId} NOT IN (SELECT a.id FROM activities a JOIN teams t ON t.id = a.team_id WHERE t.slug = ${DEMO_TEAM_SLUG})`,
    ))
    .returning({ id: activityAiNoteItems.id })).length
}
