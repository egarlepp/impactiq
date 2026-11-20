import { Router } from 'express'
import { and, asc, desc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { activities, activityAiNoteItems, activityAiNotes, activityGongCalls, activityNotes, gongCalls, teamActivityTypes, teamMembers, users } from '../../../drizzle/schema.js'
import {
  AI_NOTE_SECTIONS,
  normalizeAiNoteSections,
  type AiNoteCitation,
  type AiNoteItem,
  type AiNoteItemStatus,
  type AiNoteMeddpiccKey,
  parseSectionMeta,
  type AiNoteSectionKey,
  type AiNoteVerdict,
  type AiNotesView,
  type MyAiNoteRow,
  type MyAiNotesList,
} from '../../shared/aiNotes.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { canReadAiNote, hasAiNotesPage } from '../services/aiNotes/access.js'
import {
  aiNotesSwitchedOn,
  generateAiNote,
  generateBlockedReason,
  getAiNotesTeam,
  linkedCallIds,
  ownerNotes,
} from '../services/aiNotes/generate.js'
import { sectionBaseForOwner, sectionPlanForActivity } from '../services/aiNotes/profiles.js'
import { GongError } from '../services/gong/client.js'
import { gongReadinessForTeam } from '../services/gong/demo.js'

// The AI Notes tab on the activity drawer (Gong plan, phase 4), mounted at
// /api/ai-notes behind requireAuth. Hidden (enabled: false) unless the AI
// Assistant is on with a provider, the team's AI Notes switch is on, Role
// Management grants activities.ai_notes and the caller may read the note.
// Only the activity's owner generates, keeps, removes and copies items.

export const aiNotesRouter = Router()

// Generate costs money at the AI provider.
const generateLimit = rateLimit({ windowMs: 60_000, max: 6, keyFn: (req) => req.user!.id })

interface LoadedActivity { id: string; userId: string; teamId: string; status: string; title: string; activityTypeId: string | null; subtypeId: string | null }

async function loadActivity(id: string): Promise<LoadedActivity | null> {
  if (!z.string().uuid().safeParse(id).success) return null
  const [act] = await db.select({
    id: activities.id,
    userId: activities.userId,
    teamId: activities.teamId,
    status: activities.status,
    title: activities.title,
    activityTypeId: activities.activityTypeId,
    subtypeId: activities.subtypeId,
  }).from(activities).where(eq(activities.id, id)).limit(1)
  return act ?? null
}

function notFound(res: import('express').Response): void {
  res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
}

const HIDDEN: AiNotesView = {
  enabled: false,
  canGenerate: false,
  blockedReason: null,
  canEdit: false,
  sections: [],
  customSections: [],
  profiles: [],
  sources: { calls: [], notes: 0, transcriptsAvailable: false },
  note: null,
  items: [],
}

// The tab's whole state, or HIDDEN. null when the activity isn't visible.
async function buildView(callerId: string, act: LoadedActivity): Promise<AiNotesView | null> {
  const [note] = await db.select().from(activityAiNotes).where(eq(activityAiNotes.activityId, act.id)).limit(1)
  const callIds = await linkedCallIds(act.id)
  const readable = await canReadAiNote(callerId, act, {
    usedPrivateNotes: note?.usedPrivateNotes ?? false,
    gongCallIds: [...new Set([...callIds, ...(note?.gongCallIds ?? [])])],
  })
  if (!readable) return null
  const team = await getAiNotesTeam(act.teamId)
  if (!team || !(await hasAiNotesPage(callerId)) || !(await aiNotesSwitchedOn(team))) return HIDDEN

  const isOwner = act.userId === callerId
  const gongOn = (await gongReadinessForTeam(act.teamId)).ready
  const links = callIds.length === 0 ? [] : await db.select().from(activityGongCalls).where(eq(activityGongCalls.activityId, act.id))
  const indexed = callIds.length === 0 ? [] : await db.select({ id: gongCalls.id, title: gongCalls.title, url: gongCalls.url, startedAt: gongCalls.startedAt })
    .from(gongCalls).where(inArray(gongCalls.id, callIds))
  const byId = new Map(indexed.map((c) => [c.id, c]))
  const notes = await ownerNotes(act.id, act.userId)
  const transcriptsAvailable = gongOn && callIds.length > 0

  const itemRows = note
    ? await db.select({
      item: activityAiNoteItems,
      reviewerName: users.displayName,
    }).from(activityAiNoteItems)
      .leftJoin(users, eq(users.id, activityAiNoteItems.reviewedBy))
      .where(eq(activityAiNoteItems.aiNoteId, note.id))
      .orderBy(asc(activityAiNoteItems.sortOrder))
    : []
  const items: AiNoteItem[] = itemRows.map(({ item, reviewerName }) => ({
    id: item.id,
    section: item.section as AiNoteSectionKey,
    sectionMeta: parseSectionMeta(item.sectionMeta),
    text: item.text,
    verdict: item.verdict as AiNoteVerdict | null,
    ownerName: item.ownerName,
    meddpiccKey: item.meddpiccKey as AiNoteMeddpiccKey | null,
    citations: (Array.isArray(item.citations) ? item.citations : []) as AiNoteCitation[],
    status: item.status as AiNoteItemStatus,
    createdAt: item.createdAt.toISOString(),
    reviewedAt: item.reviewedAt?.toISOString() ?? null,
    reviewedByName: reviewerName ?? null,
    copiedNoteId: item.copiedNoteId,
  }))
  const [generator] = note?.generatedBy
    ? await db.select({ name: users.displayName }).from(users).where(eq(users.id, note.generatedBy)).limit(1)
    : []

  const blockedReason = await generateBlockedReason({ isOwner, team, noteCount: notes.length, transcriptsAvailable })
  const plan = await sectionPlanForActivity(act, act.userId, team.id)
  return {
    enabled: true,
    canGenerate: blockedReason === null,
    blockedReason,
    canEdit: isOwner,
    sections: plan.sections,
    customSections: plan.customSections,
    profiles: plan.profiles.map((p) => ({ id: p.id, name: p.name, icon: p.icon, color: p.color })),
    sources: {
      calls: links.map((l) => {
        const c = byId.get(l.gongCallId)
        return { id: l.gongCallId, title: c?.title ?? l.title, url: c?.url ?? l.url, startedAt: (c?.startedAt ?? l.startedAt)?.toISOString() ?? null }
      }),
      // Only the owner learns how many of their notes (private ones
      // included) would be read.
      notes: isOwner ? notes.length : 0,
      transcriptsAvailable,
    },
    note: note
      ? {
        generatedAt: note.generatedAt.toISOString(),
        generatedByName: generator?.name ?? null,
        model: note.model,
        usedPrivateNotes: note.usedPrivateNotes,
        fromTranscript: note.gongCallIds.length > 0,
      }
      : null,
    items,
  }
}

// GET /mine?q=: My Notes → AI (Gong plan, phase 5). One row per AI Note on
// the caller's own activities, with how many items wait for review. Only
// teams whose AI Notes switch is on, the same rule that shows the tab, so
// the list never offers an AI Note the drawer would hide. Search matches
// the activity title, its linked record names and the items' text.
aiNotesRouter.get('/mine', async (req, res) => {
  const callerId = req.user!.id
  const rawQ = typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 200) : ''
  const empty: MyAiNotesList = { enabled: false, notes: [], totals: { notes: 0, toReview: 0 } }
  if (!(await hasAiNotesPage(callerId))) { res.json({ data: empty, error: null, meta: {} }); return }

  const conds = [eq(activities.userId, callerId)]
  if (rawQ) {
    const like = `%${rawQ.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const match = or(
      ilike(activities.title, like),
      ilike(activities.crmWhatName, like),
      ilike(activities.crmWhoName, like),
      exists(db.select({ one: sql`1` }).from(activityAiNoteItems)
        .where(and(eq(activityAiNoteItems.aiNoteId, activityAiNotes.id), ilike(activityAiNoteItems.text, like)))),
    )
    if (match) conds.push(match)
  }
  const rows = await db.select({
    activityId: activities.id,
    teamId: activities.teamId,
    activityTitle: activities.title,
    activityIsPrivateMeeting: activities.isPrivateMeeting,
    activityDate: activities.startDatetime,
    activityTypeName: teamActivityTypes.name,
    activityTypeColor: teamActivityTypes.color,
    activityTypeIcon: teamActivityTypes.icon,
    crmWhatId: activities.crmWhatId,
    crmWhatType: activities.crmWhatType,
    crmWhatName: activities.crmWhatName,
    crmWhoId: activities.crmWhoId,
    crmWhoType: activities.crmWhoType,
    crmWhoName: activities.crmWhoName,
    generatedAt: activityAiNotes.generatedAt,
    gongCallIds: activityAiNotes.gongCallIds,
    usedPrivateNotes: activityAiNotes.usedPrivateNotes,
    toReview: sql<number>`(select count(*) from activity_ai_note_items i where i.ai_note_id = ${activityAiNotes.id} and i.status = 'to_review')`,
    kept: sql<number>`(select count(*) from activity_ai_note_items i where i.ai_note_id = ${activityAiNotes.id} and i.status = 'kept')`,
  }).from(activityAiNotes)
    .innerJoin(activities, eq(activities.id, activityAiNotes.activityId))
    .leftJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .where(and(...conds))
    .orderBy(desc(activityAiNotes.generatedAt))
    .limit(500)

  // The team switch (and the AI Assistant) per team, checked once each.
  const switchedOn = new Map<string, boolean>()
  for (const teamId of new Set(rows.map((r) => r.teamId))) {
    switchedOn.set(teamId, await aiNotesSwitchedOn(await getAiNotesTeam(teamId)))
  }
  const notes: MyAiNoteRow[] = rows
    .filter((r) => switchedOn.get(r.teamId))
    .map((r) => ({
      activityId: r.activityId,
      activityTitle: r.activityTitle,
      activityIsPrivateMeeting: !!r.activityIsPrivateMeeting,
      activityDate: r.activityDate ? r.activityDate.toISOString() : null,
      activityTypeName: r.activityTypeName ?? null,
      activityTypeColor: r.activityTypeColor ?? null,
      activityTypeIcon: r.activityTypeIcon ?? null,
      crmWhatId: r.crmWhatId,
      crmWhatType: r.crmWhatType,
      crmWhatName: r.crmWhatName,
      crmWhoId: r.crmWhoId,
      crmWhoType: r.crmWhoType,
      crmWhoName: r.crmWhoName,
      generatedAt: r.generatedAt.toISOString(),
      fromTranscript: r.gongCallIds.length > 0,
      usedPrivateNotes: r.usedPrivateNotes,
      toReview: Number(r.toReview),
      kept: Number(r.kept),
    }))
    // An AI Note whose items were all removed has nothing to show.
    .filter((n) => n.toReview + n.kept > 0)
  const enabled = notes.length > 0 || (await callerHasSwitchedOnTeam(callerId))
  res.json({
    data: { enabled, notes, totals: { notes: notes.length, toReview: notes.reduce((s, n) => s + n.toReview, 0) } },
    error: null,
    meta: {},
  })
})

// Whether any of the caller's teams has AI Notes on, so My Notes can show
// the AI switch (with an empty list) before the first AI Note exists.
async function callerHasSwitchedOnTeam(callerId: string): Promise<boolean> {
  const rows = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, callerId))
  for (const { teamId } of rows) {
    if (await aiNotesSwitchedOn(await getAiNotesTeam(teamId))) return true
  }
  return false
}

// GET /activities/:id: the tab's state (enabled: false hides the tab).
aiNotesRouter.get('/activities/:id', async (req, res) => {
  const act = await loadActivity(req.params['id']!)
  if (!act) return notFound(res)
  const view = await buildView(req.user!.id, act)
  if (!view) return notFound(res)
  res.json({ data: view, error: null, meta: {} })
})

// POST /activities/:id/generate: Generate or Regenerate (owner only).
aiNotesRouter.post('/activities/:id/generate', generateLimit, async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(String(req.params['id']))
  if (!act) return notFound(res)
  const before = await buildView(callerId, act)
  if (!before) return notFound(res)
  if (!before.enabled) { res.status(409).json({ data: null, error: 'errors.ai_notes.disabled', meta: {} }); return }
  if (!before.canEdit) { res.status(403).json({ data: null, error: 'errors.ai_notes.not_owner', meta: {} }); return }
  let result
  try {
    result = await generateAiNote(act, callerId)
  } catch (err) {
    if (err instanceof GongError) { res.status(502).json({ data: null, error: err.code, meta: {} }); return }
    throw err
  }
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: {} }); return }
  const view = await buildView(callerId, act)
  res.json({ data: view, error: null, meta: { items: result.items, truncated: result.truncated } })
})

// Items the caller owns (the activity's owner), with the activity.
async function loadOwnItem(callerId: string, itemId: string) {
  if (!z.string().uuid().safeParse(itemId).success) return null
  const [row] = await db.select({ item: activityAiNoteItems, note: activityAiNotes })
    .from(activityAiNoteItems)
    .innerJoin(activityAiNotes, eq(activityAiNotes.id, activityAiNoteItems.aiNoteId))
    .where(eq(activityAiNoteItems.id, itemId)).limit(1)
  if (!row) return null
  const act = await loadActivity(row.item.activityId)
  if (!act || act.userId !== callerId) return null
  const team = await getAiNotesTeam(act.teamId)
  if (!(await hasAiNotesPage(callerId)) || !(await aiNotesSwitchedOn(team))) return null
  return { ...row, act }
}

// PATCH /items/:itemId { status: 'kept' }: Keep.
aiNotesRouter.patch('/items/:itemId', async (req, res) => {
  const parsed = z.object({ status: z.literal('kept') }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation_failed', meta: {} }); return }
  const callerId = req.user!.id
  const own = await loadOwnItem(callerId, req.params['itemId']!)
  if (!own) return notFound(res)
  await db.update(activityAiNoteItems).set({ status: 'kept', reviewedBy: callerId, reviewedAt: new Date() })
    .where(eq(activityAiNoteItems.id, own.item.id))
  res.json({ data: { id: own.item.id, status: 'kept' }, error: null, meta: {} })
})

// DELETE /items/:itemId: Remove (deleted, not hidden).
aiNotesRouter.delete('/items/:itemId', async (req, res) => {
  const own = await loadOwnItem(req.user!.id, req.params['itemId']!)
  if (!own) return notFound(res)
  await db.delete(activityAiNoteItems).where(eq(activityAiNoteItems.id, own.item.id))
  res.json({ data: { id: own.item.id, deleted: true }, error: null, meta: {} })
})

// POST /activities/:id/keep-all: every item still waiting for review.
aiNotesRouter.post('/activities/:id/keep-all', async (req, res) => {
  const callerId = req.user!.id
  const act = await loadActivity(req.params['id']!)
  if (!act || act.userId !== callerId) return notFound(res)
  const team = await getAiNotesTeam(act.teamId)
  if (!(await hasAiNotesPage(callerId)) || !(await aiNotesSwitchedOn(team))) return notFound(res)
  const kept = await db.update(activityAiNoteItems).set({ status: 'kept', reviewedBy: callerId, reviewedAt: new Date() })
    .where(and(eq(activityAiNoteItems.activityId, act.id), eq(activityAiNoteItems.status, 'to_review')))
    .returning({ id: activityAiNoteItems.id })
  res.json({ data: { kept: kept.length }, error: null, meta: {} })
})

// POST /items/:itemId/copy-to-notes: the item becomes a normal note on the
// activity (and is kept). Private when the AI Note read a private note.
aiNotesRouter.post('/items/:itemId/copy-to-notes', async (req, res) => {
  const callerId = req.user!.id
  const own = await loadOwnItem(callerId, req.params['itemId']!)
  if (!own) return notFound(res)
  if (own.item.copiedNoteId) {
    res.status(409).json({ data: null, error: 'errors.ai_notes.already_copied', meta: { noteId: own.item.copiedNoteId } })
    return
  }
  const meddpicc = own.item.section === 'meddpicc' && own.item.meddpiccKey ? { [own.item.meddpiccKey]: [own.item.text.slice(0, 500)] } : {}
  const body = own.item.section === 'next_steps' && own.item.ownerName ? `${own.item.text} (${own.item.ownerName})` : own.item.text
  const noteId = await db.transaction(async (tx) => {
    const [created] = await tx.insert(activityNotes).values({
      activityId: own.act.id,
      body,
      createdBy: callerId,
      isPrivate: own.note.usedPrivateNotes,
      meddpicc,
    }).returning({ id: activityNotes.id })
    await tx.update(activityAiNoteItems).set({
      status: 'kept',
      reviewedBy: own.item.reviewedBy ?? callerId,
      reviewedAt: own.item.reviewedAt ?? new Date(),
      copiedNoteId: created!.id,
    }).where(eq(activityAiNoteItems.id, own.item.id))
    return created!.id
  })
  res.status(201).json({ data: { noteId }, error: null, meta: {} })
})

// GET /settings: the caller's sections for My Settings → AI Notes.
aiNotesRouter.get('/settings', async (req, res) => {
  const [u] = await db.select({ sections: users.aiNotesSections, teamId: users.defaultTeamId }).from(users).where(eq(users.id, req.user!.id)).limit(1)
  const team = u?.teamId ? await getAiNotesTeam(u.teamId) : null
  const own = normalizeAiNoteSections(u?.sections ?? null)
  res.json({
    data: {
      sections: own && own.length > 0 ? own : null,
      // The team's Default profile's built-in sections (all built-ins when
      // the team has none); a person's own choice is built-ins only.
      teamDefaultSections: team ? (await sectionBaseForOwner(null, team.id)).base.sections : [...AI_NOTE_SECTIONS],
      available: !!team && (await aiNotesSwitchedOn(team)),
    },
    error: null,
    meta: {},
  })
})

// PUT /settings { sections: [...] | null }: null goes back to the team default.
aiNotesRouter.put('/settings', async (req, res) => {
  const parsed = z.object({ sections: z.array(z.enum(AI_NOTE_SECTIONS)).min(1).max(AI_NOTE_SECTIONS.length).nullable() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.ai_notes.sections_required', meta: {} }); return }
  const sections = parsed.data.sections ? normalizeAiNoteSections(parsed.data.sections) : null
  await db.update(users).set({ aiNotesSections: sections }).where(eq(users.id, req.user!.id))
  res.json({ data: { sections }, error: null, meta: {} })
})
