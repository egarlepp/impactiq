import { Router } from 'express'
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { activityNotes, activityNotePushes, activities, users, teamMembers, teamActivityTypes, sfObjectOwnerCache } from '../../../drizzle/schema.js'
import { requireAuth } from '../middleware/auth.js'
import { canViewActivity } from '../services/activities/access.js'
import { enqueuePush } from '../services/crm/notePush.js'
import { getActiveCrmProvider } from '../services/crm/index.js'
import { ilike, isNull, or } from 'drizzle-orm'

export const notesRouter = Router()

notesRouter.use(requireAuth)

async function isAppAdmin(userId: string): Promise<boolean> {
  const [row] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, userId)).limit(1)
  return !!row?.isAppAdmin
}

// Team access check: the caller must be a member of the activity's team.
// App admins get through unconditionally. Returns the activity row on
// success, null on deny.
// v1.422.0: uses the shared viewer rule, so a teammate's draft and its notes
// stay private to its owner (CLAUDE.md §5, security audit L4).
async function loadActivityIfAccessible(activityId: string, userId: string) {
  const [act] = await db.select().from(activities).where(eq(activities.id, activityId)).limit(1)
  if (!act) return null
  return (await canViewActivity(userId, act)) ? act : null
}

// Other people's drafts (and their notes) are never shown to teammates.
function ownOrSubmitted(callerId: string) {
  return or(eq(activities.userId, callerId), eq(activities.status, 'submitted'), eq(activityNotes.createdBy, callerId))!
}

export type MeddpiccMap = Partial<Record<'metrics' | 'economic_buyer' | 'decision_criteria' | 'decision_process' | 'paper_process' | 'identified_pain' | 'champion' | 'competition', string[]>>

interface EnrichedNoteRow {
  id: string
  activityId: string
  teamId: string | null
  activityTitle: string | null
  // v1.262.0: named distinctly from the note's own `isPrivate` (below) —
  // that flag is the note's own private/shared visibility, this one is
  // whether the underlying MEETING is marked Private/Confidential in
  // Outlook. The two are unrelated. Drives the same title-masking + lock
  // icon treatment used everywhere else. See CLAUDE.md §7 Private Meetings.
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
  // v1.260.0: so My Notes can offer the same "Also post to Engineer Notes"
  // checkbox the activity Notes tab already has — the checkbox's gate is
  // whether a Project (Eval-type SF record) is linked, not the activity
  // type's name (see NotesDrawer.tsx canPostEngineerNotes).
  crmRelatedType: string | null
  crmRelatedId: string | null
  body: string
  meddpicc: MeddpiccMap
  isPrivate: boolean
  createdAt: string
  updatedAt: string
  // v1.127.0: firstName / lastName so the client can group by
  // surname on the All Users toggle.
  createdBy: { userId: string | null; displayName: string | null; firstName: string | null; lastName: string | null }
  canEdit: boolean
}

interface RawRow {
  id: string
  activityId: string
  teamId: string | null
  body: string
  meddpicc: unknown
  isPrivate: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
  activityTitle: string | null
  activityIsPrivateMeeting: boolean | null
  activityDate: Date | null
  activityTypeName: string | null
  activityTypeColor: string | null
  activityTypeIcon: string | null
  crmWhatId: string | null
  crmWhatType: string | null
  crmWhatName: string | null
  crmWhoId: string | null
  crmWhoType: string | null
  crmWhoName: string | null
  crmRelatedType: string | null
  crmRelatedId: string | null
  authorName: string | null
  authorFirstName: string | null
  authorLastName: string | null
}

const baseSelect = {
  id: activityNotes.id,
  activityId: activityNotes.activityId,
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
  crmRelatedType: activities.crmRelatedType,
  crmRelatedId: activities.crmRelatedId,
  body: activityNotes.body,
  meddpicc: activityNotes.meddpicc,
  isPrivate: activityNotes.isPrivate,
  createdAt: activityNotes.createdAt,
  updatedAt: activityNotes.updatedAt,
  createdBy: activityNotes.createdBy,
  authorName: users.displayName,
  authorFirstName: users.firstName,
  authorLastName: users.lastName,
} as const

async function enrichNotes(rows: RawRow[], callerId: string, callerIsAppAdmin: boolean): Promise<EnrichedNoteRow[]> {
  return rows.map((r) => ({
    id: r.id,
    activityId: r.activityId,
    teamId: r.teamId,
    activityTitle: r.activityTitle,
    activityIsPrivateMeeting: !!r.activityIsPrivateMeeting,
    activityDate: r.activityDate ? r.activityDate.toISOString() : null,
    activityTypeName: r.activityTypeName,
    activityTypeColor: r.activityTypeColor,
    activityTypeIcon: r.activityTypeIcon,
    crmWhatId: r.crmWhatId,
    crmWhatType: r.crmWhatType,
    crmWhatName: r.crmWhatName,
    crmWhoId: r.crmWhoId,
    crmWhoType: r.crmWhoType,
    crmWhoName: r.crmWhoName,
    crmRelatedType: r.crmRelatedType,
    crmRelatedId: r.crmRelatedId,
    body: r.body,
    meddpicc: (r.meddpicc && typeof r.meddpicc === 'object' ? r.meddpicc : {}) as MeddpiccMap,
    isPrivate: !!r.isPrivate,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    createdBy: { userId: r.createdBy, displayName: r.authorName, firstName: r.authorFirstName, lastName: r.authorLastName },
    // v1.129.0: owner-only. App Admins can still SEE every note (and
    // still see private ones) but the Edit / Delete / Private / AI /
    // Push buttons only enable for the note's original author. That's
    // what the user asked for after seeing another App Admin get a
    // full toolbar on someone else's notes.
    canEdit: !!r.createdBy && r.createdBy === callerId,
  }))
}

// v1.127.0: apply the private-note visibility rule to a list of rows.
// Private notes are visible only to their creator and to App Admins;
// team peers and team admins never see them.
function filterPrivate<T extends { createdBy: string | null; isPrivate: boolean }>(rows: T[], callerId: string, callerIsAppAdmin: boolean): T[] {
  if (callerIsAppAdmin) return rows
  return rows.filter((r) => !r.isPrivate || r.createdBy === callerId)
}

function noteQueryByActivityIds(activityIds: string[]) {
  return db.select(baseSelect)
    .from(activityNotes)
    .leftJoin(activities, eq(activities.id, activityNotes.activityId))
    .leftJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .leftJoin(users, eq(users.id, activityNotes.createdBy))
    .where(inArray(activityNotes.activityId, activityIds))
    .orderBy(desc(activityNotes.createdAt))
}

// GET /api/notes?scope=activity|opportunity|account|campaign|lead&…
notesRouter.get('/', async (req, res) => {
  const scope = (req.query['scope'] as string | undefined) ?? 'activity'
  const callerId = req.user!.id
  const callerIsAppAdmin = await isAppAdmin(callerId)

  if (scope === 'mine') {
    // My Notes page — every note the caller has written across all
    // activities. Supports optional filters: q (ILIKE body),
    // linkType (opportunity/account/campaign/lead/none), pushState
    // (any/pushed/unpushed/failed).
    // v1.127.0: `allUsers=1` widens the query to every note on every
    // activity the caller has team access to (or every note, for
    // App Admins). Private notes still filter out per the shared
    // visibility rule.
    const q = (req.query['q'] as string | undefined)?.trim() ?? ''
    const linkType = req.query['linkType'] as string | undefined
    const pushState = req.query['pushState'] as string | undefined
    const allUsers = req.query['allUsers'] === '1' || req.query['allUsers'] === 'true'
    const conds: Array<ReturnType<typeof eq>> = []
    if (!allUsers) {
      conds.push(eq(activityNotes.createdBy, callerId))
    } else if (!callerIsAppAdmin) {
      // Team access gate: caller must be a member of the activity's
      // team. Scoped to the caller's teams via team_members.
      const memberTeamIds = await db.select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, callerId))
      const teamIds = memberTeamIds.map((r) => r.teamId)
      if (teamIds.length === 0) {
        // No team memberships → still show the caller's own notes so
        // the page is never empty for a fresh account.
        conds.push(eq(activityNotes.createdBy, callerId))
      } else {
        conds.push(inArray(activities.teamId, teamIds))
        conds.push(ownOrSubmitted(callerId))
      }
    }
    if (q) {
      const like = `%${q}%`
      const compound = or(
        ilike(activityNotes.body, like),
        ilike(activities.crmWhatName, like),
        ilike(activities.crmWhoName, like),
        ilike(activities.title, like),
      )
      if (compound) conds.push(compound)
    }
    if (linkType === 'none') {
      conds.push(isNull(activities.crmWhatId))
      conds.push(isNull(activities.crmWhoId))
    }
    else if (linkType === 'opportunity') conds.push(eq(activities.crmWhatType, 'Opportunity'))
    else if (linkType === 'account') conds.push(eq(activities.crmWhatType, 'Account'))
    else if (linkType === 'campaign') conds.push(eq(activities.crmWhatType, 'Campaign'))
    else if (linkType === 'lead') conds.push(eq(activities.crmWhoType, 'Lead'))
    const rows = await db.select(baseSelect)
      .from(activityNotes)
      .leftJoin(activities, eq(activities.id, activityNotes.activityId))
      .leftJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
      .leftJoin(users, eq(users.id, activityNotes.createdBy))
      .where(conds.length > 0 ? and(...conds) : sql`true`)
      .orderBy(desc(activityNotes.createdAt))
      .limit(500)
    const visible = filterPrivate(rows, callerId, callerIsAppAdmin)
    const enriched = await enrichNotes(visible, callerId, callerIsAppAdmin)
    // Attach push history so the UI can render "Pushed to SF" chips.
    const noteIds = enriched.map((n) => n.id)
    const pushes = noteIds.length === 0 ? [] : await db.select().from(activityNotePushes).where(inArray(activityNotePushes.activityNoteId, noteIds))
    const pushesByNote = new Map<string, typeof pushes>()
    for (const p of pushes) {
      const list = pushesByNote.get(p.activityNoteId) ?? []
      list.push(p)
      pushesByNote.set(p.activityNoteId, list)
    }
    const withPushes = enriched.map((n) => ({
      ...n,
      pushes: (pushesByNote.get(n.id) ?? []).map((p) => ({
        id: p.id,
        crmTargetType: p.crmTargetType,
        crmTargetId: p.crmTargetId,
        crmTargetName: p.crmTargetName,
        crmContentNoteId: p.crmContentNoteId,
        status: p.status,
        error: p.error,
        createdAt: p.createdAt.toISOString(),
        syncedAt: p.syncedAt ? p.syncedAt.toISOString() : null,
      })),
    }))
    // Filter by push state after enrichment (cheaper than joining).
    const filtered = pushState === 'pushed'
      ? withPushes.filter((n) => n.pushes.some((p) => p.status === 'synced'))
      : pushState === 'unpushed'
      ? withPushes.filter((n) => n.pushes.every((p) => p.status !== 'synced'))
      : pushState === 'failed'
      ? withPushes.filter((n) => n.pushes.some((p) => p.status === 'failed'))
      : withPushes
    res.json({ data: filtered, error: null, meta: {} })
    return
  }

  if (scope === 'activity') {
    const activityId = req.query['activityId'] as string | undefined
    if (!activityId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
    const act = await loadActivityIfAccessible(activityId, callerId)
    if (!act) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
    const rows = await db.select(baseSelect)
      .from(activityNotes)
      .leftJoin(activities, eq(activities.id, activityNotes.activityId))
      .leftJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
      .leftJoin(users, eq(users.id, activityNotes.createdBy))
      .where(eq(activityNotes.activityId, activityId))
      .orderBy(desc(activityNotes.createdAt))
    const visible = filterPrivate(rows, callerId, callerIsAppAdmin)
    res.json({ data: await enrichNotes(visible, callerId, callerIsAppAdmin), error: null, meta: {} })
    return
  }

  const teamId = req.query['teamId'] as string | undefined
  if (!teamId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!callerIsAppAdmin) {
    const [membership] = await db.select({ id: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, callerId), eq(teamMembers.teamId, teamId)))
      .limit(1)
    if (!membership) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  }

  // App Admins see everything; everyone else sees their own activities and
  // teammates' submitted ones (audit L4, v1.422.0).
  const draftFilter = callerIsAppAdmin ? sql`true` : or(eq(activities.userId, callerId), eq(activities.status, 'submitted'))!
  let activityIds: string[]
  if (scope === 'opportunity') {
    const crmWhatId = req.query['crmWhatId'] as string | undefined
    if (!crmWhatId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
    const acts = await db.select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.teamId, teamId), draftFilter, eq(activities.crmWhatId, crmWhatId), eq(activities.crmWhatType, 'Opportunity')))
    activityIds = acts.map((a) => a.id)
  } else if (scope === 'campaign') {
    const crmWhatId = req.query['crmWhatId'] as string | undefined
    if (!crmWhatId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
    const acts = await db.select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.teamId, teamId), draftFilter, eq(activities.crmWhatId, crmWhatId), eq(activities.crmWhatType, 'Campaign')))
    activityIds = acts.map((a) => a.id)
  } else if (scope === 'lead') {
    // Leads live on the Who side of the record — different param name so the
    // API is honest about which link it's rolling up.
    const crmWhoId = req.query['crmWhoId'] as string | undefined
    if (!crmWhoId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
    const acts = await db.select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.teamId, teamId), draftFilter, eq(activities.crmWhoId, crmWhoId), eq(activities.crmWhoType, 'Lead')))
    activityIds = acts.map((a) => a.id)
  } else if (scope === 'account') {
    const crmWhatId = req.query['crmWhatId'] as string | undefined
    if (!crmWhatId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
    // Account rollup — direct Account links plus every Opp whose parent
    // Account is this one (resolved via sf_object_owner_cache).
    const direct = await db.select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.teamId, teamId), draftFilter, eq(activities.crmWhatId, crmWhatId), eq(activities.crmWhatType, 'Account')))
    const oppIds = await db.select({ sfId: sfObjectOwnerCache.sfId })
      .from(sfObjectOwnerCache)
      .where(and(eq(sfObjectOwnerCache.objectType, 'Opportunity'), eq(sfObjectOwnerCache.accountId, crmWhatId)))
    const oppLinked = oppIds.length === 0 ? [] : await db.select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.teamId, teamId), draftFilter, eq(activities.crmWhatType, 'Opportunity'), inArray(activities.crmWhatId, oppIds.map((o) => o.sfId))))
    activityIds = [...direct.map((a) => a.id), ...oppLinked.map((a) => a.id)]
  } else {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }

  if (activityIds.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
  const rows = await noteQueryByActivityIds(activityIds)
  const visible = filterPrivate(rows, callerId, callerIsAppAdmin)
  res.json({ data: await enrichNotes(visible, callerId, callerIsAppAdmin), error: null, meta: {} })
})

// POST /api/notes { activityId, body, isPrivate? }
notesRouter.post('/', async (req, res) => {
  const parsed = z.object({
    activityId: z.string().uuid(),
    body: z.string().min(1).max(20000),
    isPrivate: z.boolean().optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const callerId = req.user!.id
  const act = await loadActivityIfAccessible(parsed.data.activityId, callerId)
  if (!act) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  const [inserted] = await db.insert(activityNotes).values({
    activityId: parsed.data.activityId,
    body: parsed.data.body,
    createdBy: callerId,
    isPrivate: parsed.data.isPrivate ?? false,
  }).returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

// PATCH /api/notes/:id { body?, meddpicc? }
const MeddpiccSchema = z.object({
  metrics: z.array(z.string().max(500)).optional(),
  economic_buyer: z.array(z.string().max(500)).optional(),
  decision_criteria: z.array(z.string().max(500)).optional(),
  decision_process: z.array(z.string().max(500)).optional(),
  paper_process: z.array(z.string().max(500)).optional(),
  identified_pain: z.array(z.string().max(500)).optional(),
  champion: z.array(z.string().max(500)).optional(),
  competition: z.array(z.string().max(500)).optional(),
}).strict()

notesRouter.patch('/:id', async (req, res) => {
  const { id } = req.params as { id: string }
  const parsed = z.object({
    body: z.string().min(1).max(20000).optional(),
    meddpicc: MeddpiccSchema.optional(),
    // v1.127.0: allow toggling privacy without editing the body.
    isPrivate: z.boolean().optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  if (!parsed.data.body && !parsed.data.meddpicc && parsed.data.isPrivate === undefined) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return
  }
  const callerId = req.user!.id
  const [existing] = await db.select().from(activityNotes).where(eq(activityNotes.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const isAuthor = existing.createdBy === callerId
  const isAdmin = await isAppAdmin(callerId)
  if (!isAuthor && !isAdmin) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  // MEDDPICC is strictly author-only — even App Admins may not overwrite another
  // user's MEDDPICC entries (they can still moderate body/privacy/delete).
  if (parsed.data.meddpicc && !isAuthor) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  const patch: Record<string, unknown> = { updatedAt: sql`now()` }
  if (parsed.data.body) patch['body'] = parsed.data.body
  if (parsed.data.meddpicc) patch['meddpicc'] = parsed.data.meddpicc
  if (parsed.data.isPrivate !== undefined) patch['isPrivate'] = parsed.data.isPrivate
  const [updated] = await db.update(activityNotes)
    .set(patch)
    .where(eq(activityNotes.id, id))
    .returning()
  res.json({ data: updated, error: null, meta: {} })
})

// DELETE /api/notes/:id
notesRouter.delete('/:id', async (req, res) => {
  const { id } = req.params as { id: string }
  const callerId = req.user!.id
  const [existing] = await db.select().from(activityNotes).where(eq(activityNotes.id, id)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const isAuthor = existing.createdBy === callerId
  const isAdmin = await isAppAdmin(callerId)
  if (!isAuthor && !isAdmin) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  await db.delete(activityNotes).where(eq(activityNotes.id, id))
  res.json({ data: { id }, error: null, meta: {} })
})

// POST /api/notes/:id/push — publish a note to the CRM: a Salesforce
// ContentNote, or a HubSpot note (phase 4), linked to the given
// Opportunity/Account (Deal/Company). Body accepts a
// single target or an array (bulk push to both Opp and Account in one
// call).
notesRouter.post('/:id/push', async (req, res) => {
  const { id } = req.params as { id: string }
  const parsed = z.object({
    targets: z.array(z.object({
      crmType: z.enum(['Opportunity', 'Account']),
      sfId: z.string().min(1),
      sfName: z.string().nullable().optional(),
    })).min(1).max(4),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const callerId = req.user!.id
  const [note] = await db.select().from(activityNotes).where(eq(activityNotes.id, id)).limit(1)
  if (!note) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const isAuthor = note.createdBy === callerId
  const admin = await isAppAdmin(callerId)
  if (!isAuthor && !admin) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  // A push goes to whichever CRM the install uses (Salesforce ContentNote or
  // HubSpot note); with none, there is nowhere to send it.
  if (!(await getActiveCrmProvider())) { res.status(409).json({ data: null, error: 'errors.crm.provider_mismatch', meta: {} }); return }
  // v1.424.0 (security audit M4): a note only goes to the records its own
  // activity is linked to (the Opportunity/Deal, and its Account/Company),
  // the two targets the Notes drawer offers. On HubSpot the push runs on the
  // portal-wide key, so without this a note could land on any record.
  const [act] = await db.select({ crmWhatId: activities.crmWhatId, crmWhatType: activities.crmWhatType, crmAccountId: activities.crmAccountId })
    .from(activities).where(eq(activities.id, note.activityId)).limit(1)
  const allowed = {
    Opportunity: act?.crmWhatType === 'Opportunity' ? act.crmWhatId : null,
    Account: act?.crmWhatType === 'Account' ? act.crmWhatId : (act?.crmWhatType === 'Opportunity' ? act.crmAccountId : null),
  }
  if (parsed.data.targets.some((t) => !allowed[t.crmType] || allowed[t.crmType] !== t.sfId)) {
    res.status(400).json({ data: null, error: 'errors.notes.push_target_not_linked', meta: {} })
    return
  }
  const results = []
  for (const t of parsed.data.targets) {
    const r = await enqueuePush({
      activityNoteId: id,
      pushedBy: callerId,
      crmTargetType: t.crmType,
      crmTargetId: t.sfId,
      crmTargetName: t.sfName ?? null,
    })
    results.push({ target: t, ...r })
  }
  res.status(202).json({ data: results, error: null, meta: {} })
})
