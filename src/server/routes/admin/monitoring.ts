import { Router } from 'express'
import { db } from '../../db/index.js'
import { teams, nudgeRules, teamMembers, activities, users } from '../../../../drizzle/schema.js'
import { and, eq, inArray, sql, gte, lte, isNotNull, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { requireAppAdmin, isAppAdmin } from '../../middleware/rbac.js'
import { auditEvents } from '../../../../drizzle/schema.js'
import { logAudit } from '../../services/audit/log.js'
import { DESTRUCTIVE_AUDIT_ACTIONS } from '../../../shared/auditActions.js'
import { desc } from 'drizzle-orm'
import { z } from 'zod'

export const monitoringRoutes = Router()

// --- Audit log ---
// GET /api/admin/audit?limit=&before=&action=&actorUserId=
monitoringRoutes.get('/audit', requireAppAdmin, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query['limit'] ?? 50)))
  const before = req.query['before'] as string | undefined
  const actionFilter = req.query['action'] as string | undefined
  const actorFilter = req.query['actorUserId'] as string | undefined
  const conds = []
  if (before) conds.push(sql`${auditEvents.createdAt} < ${new Date(before)}`)
  if (actionFilter) conds.push(eq(auditEvents.action, actionFilter))
  if (actorFilter) conds.push(eq(auditEvents.actorUserId, actorFilter))
  const rows = await db
    .select()
    .from(auditEvents)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)

  // Resolve target ids to human-readable names by targetType. Batched by
  // type so we do at most a handful of queries regardless of row count.
  // v1.302.0: was 'team'/'user' only — every other real target type (most
  // visibly sf_field_mapping) fell through with no lookup, so the Target
  // column showed a bare UUID an admin has no way to make sense of.
  const idsByType = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.targetType || !r.targetId) continue
    if (!idsByType.has(r.targetType)) idsByType.set(r.targetType, new Set())
    idsByType.get(r.targetType)!.add(r.targetId)
  }
  const nameById = new Map<string, string>()
  for (const [type, ids] of idsByType.entries()) {
    const idList = Array.from(ids)
    if (idList.length === 0) continue
    if (type === 'team') {
      const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, idList))
      for (const t of teamRows) nameById.set(`team:${t.id}`, t.name)
    } else if (type === 'user') {
      const userRows = await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, idList))
      for (const u of userRows) nameById.set(`user:${u.id}`, u.name || u.email)
    } else if (type === 'subteam') {
      const { subteams } = await import('../../../../drizzle/schema.js')
      const subteamRows = await db.select({ id: subteams.id, name: subteams.name }).from(subteams).where(inArray(subteams.id, idList))
      for (const s of subteamRows) nameById.set(`subteam:${s.id}`, s.name)
    } else if (type === 'activity') {
      const activityRows = await db.select({ id: activities.id, title: activities.title }).from(activities).where(inArray(activities.id, idList))
      for (const a of activityRows) nameById.set(`activity:${a.id}`, a.title)
    }
  }

  // sf_field_mapping rows have no standing "name" to look up by id — a
  // delete's target row is already gone by the time this route runs, and
  // create/update rows don't have an inherent display name either. Build a
  // label ("appField → crmFieldApi") straight from the meta this route
  // already logs, which is present and shaped consistently across all four
  // call sites (manual create/update/delete, Export/Import apply).
  function sfFieldMappingLabel(action: string, meta: unknown): string | null {
    if (!meta || typeof meta !== 'object') return null
    const m = meta as Record<string, unknown>
    const row = action === 'sf_field_mapping.delete' ? m['deleted']
      : action === 'sf_field_mapping.update' ? m['after']
      : m
    if (!row || typeof row !== 'object') return null
    const appField = (row as Record<string, unknown>)['appField']
    const crmFieldApi = (row as Record<string, unknown>)['crmFieldApi']
    if (typeof appField !== 'string' || typeof crmFieldApi !== 'string') return null
    return `${appField} → ${crmFieldApi}`
  }

  // Diff of changed fields for team / user updates. Reads meta.previous
  // if present (server logs it on some routes), otherwise lists the keys
  // that were sent as the update payload. Consumers show this as a
  // human-readable summary.
  const enriched = rows.map((r) => ({
    ...r,
    targetName: r.targetType === 'sf_field_mapping'
      ? sfFieldMappingLabel(r.action, r.meta)
      : (r.targetType && r.targetId ? nameById.get(`${r.targetType}:${r.targetId}`) ?? null : null),
    changedFields: r.meta && typeof r.meta === 'object'
      ? (() => {
          const m = r.meta as Record<string, unknown>
          // If we captured a structured before/after diff, prefer that as
          // the changed-field list. Otherwise fall back to whatever payload
          // the audit call passed (excluding known scaffolding keys).
          if (m['before'] && m['after'] && typeof m['after'] === 'object') {
            return Object.keys(m['after'] as Record<string, unknown>)
          }
          return Object.keys(m).filter((k) => k !== 'previous' && k !== 'before' && k !== 'after')
        })()
      : [],
  }))
  res.json({ data: enriched, error: null, meta: { count: enriched.length } })
})

// v1.330.0: KPI row for the Audit Log page, styled like CRM Sync's. The
// existing GET /audit route only ever returns the most recent N rows (100
// on the client, 200 max) so computing a "how many destructive actions this
// week" or "who's been most active" figure from that response would silently
// undercount on any team with more admin activity than fits in that page —
// this route runs real aggregate queries instead. A 7-day window for the
// activity figures (distinct from CRM Sync's 24h, which suits a busy sync
// worker — a week is the more natural cadence for admin config changes) plus
// an all-time retention-horizon figure that a windowed query can't answer.
monitoringRoutes.get('/audit/summary', requireAppAdmin, async (_req, res) => {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [[totalRow], [destructiveRow], topActorRows, [distinctRow], [oldestRow]] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(auditEvents).where(gte(auditEvents.createdAt, since)),
    db.select({ c: sql<number>`count(*)::int` }).from(auditEvents)
      .where(and(gte(auditEvents.createdAt, since), inArray(auditEvents.action, DESTRUCTIVE_AUDIT_ACTIONS as string[]))),
    db.select({ actorUserId: auditEvents.actorUserId, c: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(and(gte(auditEvents.createdAt, since), isNotNull(auditEvents.actorUserId)))
      .groupBy(auditEvents.actorUserId)
      .orderBy(desc(sql`count(*)`))
      .limit(1),
    db.select({ c: sql<number>`count(distinct ${auditEvents.actorUserId})::int` }).from(auditEvents)
      .where(and(gte(auditEvents.createdAt, since), isNotNull(auditEvents.actorUserId))),
    db.select({ createdAt: auditEvents.createdAt }).from(auditEvents).orderBy(auditEvents.createdAt).limit(1),
  ])

  let topActor: { userId: string; name: string; count: number } | null = null
  const topActorRow = topActorRows[0]
  if (topActorRow?.actorUserId) {
    const [u] = await db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, topActorRow.actorUserId))
    topActor = { userId: topActorRow.actorUserId, name: u?.name || u?.email || topActorRow.actorUserId, count: topActorRow.c }
  }

  const retentionDays = Number(process.env['AUDIT_EVENTS_RETENTION_DAYS']) || 1095
  const oldestEventAt = oldestRow?.createdAt ?? null
  const retainedDays = oldestEventAt ? Math.floor((Date.now() - new Date(oldestEventAt).getTime()) / (24 * 60 * 60 * 1000)) : null

  res.json({
    data: {
      totalEvents7d: totalRow?.c ?? 0,
      destructiveEvents7d: destructiveRow?.c ?? 0,
      topActor7d: topActor,
      distinctActors7d: distinctRow?.c ?? 0,
      oldestEventAt,
      retainedDays,
      retentionDays,
    },
    error: null,
  })
})

// issueKey is the stable identity a resolution attaches to — see
// schema.ts's syncIssueResolutions for why it's not just the row id.
function issueKeyFor(source: 'activity_writeback' | 'note_push', row: { id: string; activityNoteId?: string; crmWhatType?: string | null; crmWhatId?: string | null }): string {
  if (source === 'activity_writeback') return row.id
  return `${row.activityNoteId}:${row.crmWhatType}:${row.crmWhatId}`
}

// GET /api/admin/sync-issues — everything currently in a failed state that
// needs attention: activities with crmSyncStatus='failed' (activity
// writeback), plus (v1.260.0) note pushes whose LATEST attempt to a given
// target is still failed. History (below) shows every attempt ever made;
// Issues is specifically "what's broken right now" — a note push that
// failed once and was later retried successfully is NOT an open issue and
// must not show up here, hence the latest-per-target filter (same
// convention as the My Notes badge fix — see latestPushesByTarget() in
// MyNotes.tsx). Used by the Admin > CRM Sync > Issues tab.
//
// v1.261.0: every row also carries `resolved` — an admin's manual
// "I've handled this" annotation (see resolve endpoint below). A
// resolution counts only if it's at least as new as the issue's own
// failure timestamp, so a fresh failure after a resolution naturally
// reopens the issue with no extra bookkeeping. Resolved rows are still
// returned (not dropped) so the client can show them de-emphasized and
// the CRM Sync KPI can report an open/resolved split, not just a count.
monitoringRoutes.get('/sync-issues', requireAppAdmin, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 200)))

  const activityRows = await db
    .select({
      id: activities.id,
      activityId: activities.id,
      title: activities.title,
      userId: activities.userId,
      userEmail: users.email,
      userName: users.displayName,
      teamId: activities.teamId,
      teamName: teams.name,
      crmWhatId: activities.crmWhatId,
      crmWhatName: activities.crmWhatName,
      crmWhatType: activities.crmWhatType,
      crmSyncError: activities.crmSyncError,
      startDatetime: activities.startDatetime,
      updatedAt: activities.updatedAt,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.userId))
    .innerJoin(teams, eq(teams.id, activities.teamId))
    .where(and(eq(activities.crmSyncStatus, 'failed'), eq(activities.isArchived, false)))
    .orderBy(desc(activities.updatedAt))
    .limit(limit)

  const { activityNotePushes, activityNotes, syncIssueResolutions } = await import('../../../../drizzle/schema.js')
  const allPushes = await db
    .select({
      id: activityNotePushes.id,
      activityNoteId: activityNotePushes.activityNoteId,
      crmTargetType: activityNotePushes.crmTargetType,
      crmTargetId: activityNotePushes.crmTargetId,
      crmTargetName: activityNotePushes.crmTargetName,
      status: activityNotePushes.status,
      error: activityNotePushes.error,
      createdAt: activityNotePushes.createdAt,
      activityId: activityNotes.activityId,
      title: activities.title,
      userId: activities.userId,
      userEmail: users.email,
      userName: users.displayName,
      teamId: activities.teamId,
      teamName: teams.name,
      startDatetime: activities.startDatetime,
    })
    .from(activityNotePushes)
    .innerJoin(activityNotes, eq(activityNotes.id, activityNotePushes.activityNoteId))
    .innerJoin(activities, eq(activities.id, activityNotes.activityId))
    .innerJoin(users, eq(users.id, activities.userId))
    .innerJoin(teams, eq(teams.id, activities.teamId))
    .where(inArray(activityNotePushes.status, ['failed', 'synced']))
    .orderBy(desc(activityNotePushes.createdAt))

  const latestByTarget = new Map<string, (typeof allPushes)[number]>()
  for (const p of allPushes) {
    const key = `${p.activityNoteId}:${p.crmTargetType}:${p.crmTargetId}`
    const existing = latestByTarget.get(key)
    if (!existing || p.createdAt > existing.createdAt) latestByTarget.set(key, p)
  }
  const notePushRows = Array.from(latestByTarget.values())
    .filter((p) => p.status === 'failed')
    .map((p) => ({
      id: p.id,
      source: 'note_push' as const,
      activityId: p.activityId,
      title: p.title,
      userId: p.userId,
      userEmail: p.userEmail,
      userName: p.userName,
      teamId: p.teamId,
      teamName: p.teamName,
      crmWhatId: p.crmTargetId,
      crmWhatName: p.crmTargetName,
      crmWhatType: p.crmTargetType,
      crmSyncError: p.error,
      startDatetime: p.startDatetime,
      updatedAt: p.createdAt,
      activityNoteId: p.activityNoteId,
    }))

  const merged = [
    ...activityRows.map((r) => ({ ...r, source: 'activity_writeback' as const })),
    ...notePushRows,
  ]

  // Resolutions: fetch every row (this table stays small — one row per
  // manual resolve click) and keep only the latest per issueKey.
  const resolutionRows = await db
    .select({
      issueKey: syncIssueResolutions.issueKey,
      resolvedAt: syncIssueResolutions.resolvedAt,
      resolvedByName: users.displayName,
    })
    .from(syncIssueResolutions)
    .leftJoin(users, eq(users.id, syncIssueResolutions.resolvedBy))
  const latestResolutionByKey = new Map<string, { resolvedAt: Date; resolvedByName: string | null }>()
  for (const r of resolutionRows) {
    const existing = latestResolutionByKey.get(r.issueKey)
    if (!existing || r.resolvedAt > existing.resolvedAt) latestResolutionByKey.set(r.issueKey, r)
  }

  const rows = merged
    .map((r) => {
      const key = issueKeyFor(r.source, r)
      const resolution = latestResolutionByKey.get(key)
      const resolved = !!resolution && resolution.resolvedAt >= r.updatedAt
      return {
        ...r,
        resolved,
        resolvedAt: resolved ? resolution!.resolvedAt : null,
        resolvedByName: resolved ? resolution!.resolvedByName : null,
      }
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)

  res.json({ data: rows, error: null, meta: { count: rows.length } })
})

// POST /api/admin/sync-issues/:source/:id/resolve — mark one CRM Sync
// issue as manually handled. Does NOT touch the underlying activity/note
// push row (see schema.ts) — purely an annotation, so it can never mask a
// real subsequent failure. `id` is whatever the /sync-issues row already
// carries as its `id` (activities.id for activity_writeback,
// activity_note_pushes.id for note_push); the route re-derives the real
// issueKey from that before writing.
monitoringRoutes.post('/sync-issues/:source/:id/resolve', requireAppAdmin, async (req, res) => {
  const { source, id } = req.params as { source: string; id: string }
  if (source !== 'activity_writeback' && source !== 'note_push') {
    res.status(400).json({ data: null, error: 'errors.validation.invalid_source', meta: {} })
    return
  }
  const { activityNotePushes, syncIssueResolutions } = await import('../../../../drizzle/schema.js')

  let issueKey: string
  if (source === 'activity_writeback') {
    const [row] = await db.select({ id: activities.id }).from(activities).where(eq(activities.id, id)).limit(1)
    if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
    issueKey = row.id
  } else {
    const [row] = await db.select({
      activityNoteId: activityNotePushes.activityNoteId,
      crmTargetType: activityNotePushes.crmTargetType,
      crmTargetId: activityNotePushes.crmTargetId,
    }).from(activityNotePushes).where(eq(activityNotePushes.id, id)).limit(1)
    if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
    issueKey = `${row.activityNoteId}:${row.crmTargetType}:${row.crmTargetId}`
  }

  await db.insert(syncIssueResolutions).values({ source, issueKey, resolvedBy: req.user!.id })
  await logAudit(req, { action: 'user.update', targetType: `${source}.resolve`, targetId: id, meta: { issueKey } })
  res.json({ data: { id, resolved: true }, error: null, meta: {} })
})

// POST /api/admin/note-pushes/:id/retry — same idea as
// /activities/:id/retry-sync but for a failed note push: reset the
// existing row back to 'pending' and kick the worker immediately, rather
// than creating a new activity_note_pushes row (which is what a
// contributor re-clicking "Push to Salesforce" from My Notes does per
// enqueuePush's dedupe rule) — an admin retry should reuse the same row
// so it doesn't grow the table with admin-triggered duplicates.
monitoringRoutes.post('/note-pushes/:id/retry', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const { activityNotePushes } = await import('../../../../drizzle/schema.js')
  const { queueCrmNotePush } = await import('../../services/crm/index.js')
  const [row] = await db.update(activityNotePushes)
    .set({ status: 'pending', error: null })
    .where(and(eq(activityNotePushes.id, id), eq(activityNotePushes.status, 'failed')))
    .returning({ id: activityNotePushes.id, pushedBy: activityNotePushes.pushedBy })
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  queueCrmNotePush(row.id)
  await logAudit(req, { action: 'user.update', targetType: 'activity_note_push.retry', targetId: id, meta: { userId: row.pushedBy } })
  res.json({ data: { id }, error: null, meta: {} })
})

// GET /api/admin/nudge-history — every nudge_events row, joined to
// user + team + rule. Filters: status/trigger/nudge rule/user; default
// order is newest first; 30-day retention (cull done inline periodically).
// v1.324.0: team-scoped like every other Nudge Rules/Dismissals route
// (this page merged with Nudge Dismissals) rather than requireAppAdmin —
// the router's own requireGlobalAdmin baseline (line ~108) only proves
// "is an admin somewhere," so a team_admin's request for a SPECIFIC team
// they don't belong to is rejected explicitly below. teamId omitted (or
// literally 'all') means tenant-wide, which stays App-Admin-only.
monitoringRoutes.get('/nudge-history', async (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query['limit'] ?? 200)))
  const triggerType = (req.query['triggerType'] as string | undefined) ?? ''
  const nudgeRuleId = (req.query['nudgeRuleId'] as string | undefined) ?? ''
  const userIdFilter = (req.query['userId'] as string | undefined) ?? ''
  const requestedTeamId = typeof req.query['teamId'] === 'string' && req.query['teamId'] && req.query['teamId'] !== 'all' ? req.query['teamId'] : null
  const appAdmin = await isAppAdmin(req.user!.id)
  if (!requestedTeamId) {
    if (!appAdmin) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  } else if (!appAdmin) {
    const [membership] = await db.select({ role: teamMembers.role }).from(teamMembers)
      .where(and(eq(teamMembers.userId, req.user!.id), eq(teamMembers.teamId, requestedTeamId))).limit(1)
    if (!membership || (membership.role !== 'admin' && membership.role !== 'team_admin')) {
      res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
    }
  }
  const { nudgeEvents } = await import('../../../../drizzle/schema.js')
  const clauses = [] as ReturnType<typeof eq>[]
  if (triggerType) clauses.push(eq(nudgeEvents.triggerType, triggerType))
  if (nudgeRuleId) clauses.push(eq(nudgeEvents.nudgeRuleId, nudgeRuleId))
  if (userIdFilter) clauses.push(eq(nudgeEvents.userId, userIdFilter))
  if (requestedTeamId) clauses.push(eq(nudgeEvents.teamId, requestedTeamId))
  const rows = await db
    .select({
      id: nudgeEvents.id,
      deliveredAt: nudgeEvents.deliveredAt,
      triggerType: nudgeEvents.triggerType,
      message: nudgeEvents.message,
      channel: nudgeEvents.channel,
      nudgeRuleId: nudgeEvents.nudgeRuleId,
      // Falls back to a Title Case version of the raw trigger_type when the
      // originating rule was later deleted (nudgeRuleId set null on delete)
      // — same formatting the migration 0143 backfill used, so an orphaned
      // row still reads as a name rather than a blank.
      ruleName: sql<string>`coalesce(${nudgeRules.name}, initcap(replace(${nudgeEvents.triggerType}, '_', ' ')))`,
      userId: nudgeEvents.userId,
      userName: users.displayName,
      userEmail: users.email,
      teamName: teams.name,
    })
    .from(nudgeEvents)
    .innerJoin(users, eq(users.id, nudgeEvents.userId))
    .innerJoin(teams, eq(teams.id, nudgeEvents.teamId))
    .leftJoin(nudgeRules, eq(nudgeRules.id, nudgeEvents.nudgeRuleId))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(nudgeEvents.deliveredAt))
    .limit(limit)
  res.json({ data: rows, error: null, meta: { count: rows.length } })
})

// GET /api/admin/sync-history — every activity_sync_audit row across the
// tenant: the activity Event/Task writeback, plus (v1.259.0) every other
// Salesforce write in the app — note pushes, the Engineer Notes prepend-
// update, Assigned SE writes, and ad-hoc Opportunity/Evaluation field
// writes (see services/salesforce/syncAudit.ts). Not every row traces
// back to one activity, so the activity join is now LEFT (a note pushed
// straight from an Opportunity, or an Evaluation shared by several
// activities, has activityId = null). User is resolved from whichever of
// the audit row's own userId or the linked activity's owner is set — the
// row carries exactly one of the two depending on source. Retention is 30
// days (enforced by the periodic cull job). Supports filters: status
// (success|failed), source, userId, from, to. Ordered by attemptedAt desc.
monitoringRoutes.get('/sync-history', requireAppAdmin, async (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query['limit'] ?? 200)))
  const status = (req.query['status'] as string | undefined) ?? ''
  const sourceFilter = (req.query['source'] as string | undefined) ?? ''
  const userIdFilter = (req.query['userId'] as string | undefined) ?? ''
  const from = req.query['from'] ? new Date(String(req.query['from'])) : null
  const to = req.query['to'] ? new Date(String(req.query['to'])) : null
  const { activitySyncAudit } = await import('../../../../drizzle/schema.js')
  const directUser = alias(users, 'sync_audit_user')
  const clauses = [] as ReturnType<typeof eq>[]
  if (status === 'success' || status === 'failed') clauses.push(eq(activitySyncAudit.status, status))
  if (sourceFilter) clauses.push(eq(activitySyncAudit.source, sourceFilter))
  if (userIdFilter) clauses.push(eq(activities.userId, userIdFilter))
  if (from && !Number.isNaN(from.getTime())) clauses.push(gte(activitySyncAudit.attemptedAt, from))
  if (to && !Number.isNaN(to.getTime())) clauses.push(lte(activitySyncAudit.attemptedAt, to))
  const rows = await db
    .select({
      id: activitySyncAudit.id,
      source: activitySyncAudit.source,
      activityId: activitySyncAudit.activityId,
      attemptedAt: activitySyncAudit.attemptedAt,
      status: activitySyncAudit.status,
      operation: activitySyncAudit.operation,
      crmObject: activitySyncAudit.crmObject,
      crmRecordId: activitySyncAudit.crmRecordId,
      errorMessage: activitySyncAudit.errorMessage,
      payload: activitySyncAudit.payload,
      activityTitle: activities.title,
      startDatetime: activities.startDatetime,
      userId: sql<string | null>`coalesce(${activitySyncAudit.userId}, ${activities.userId})`,
      userEmail: sql<string | null>`coalesce(${directUser.email}, ${users.email})`,
      userName: sql<string | null>`coalesce(${directUser.displayName}, ${users.displayName})`,
      teamName: teams.name,
    })
    .from(activitySyncAudit)
    .leftJoin(activities, eq(activities.id, activitySyncAudit.activityId))
    .leftJoin(users, eq(users.id, activities.userId))
    .leftJoin(directUser, eq(directUser.id, activitySyncAudit.userId))
    .leftJoin(teams, eq(teams.id, activities.teamId))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(activitySyncAudit.attemptedAt))
    .limit(limit)
  res.json({ data: rows, error: null, meta: { count: rows.length } })
})

// POST /api/admin/activities/:id/retry-sync — flip crm_sync_status back to
// 'pending' so the writeback worker picks it up on its next tick. Handy when
// the failure was a transient SF outage and the admin wants to kick every
// stuck row at once (loop this endpoint from the client).
monitoringRoutes.post('/activities/:id/retry-sync', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const [row] = await db.update(activities)
    .set({ crmSyncStatus: 'pending', crmSyncError: null, crmSyncAttempts: 0, crmNextRetryAt: null, updatedAt: new Date() })
    .where(and(eq(activities.id, id), eq(activities.crmSyncStatus, 'failed')))
    .returning({ id: activities.id, userId: activities.userId })
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await logAudit(req, { action: 'user.update', targetType: 'activity.retry_sync', targetId: id, meta: { userId: row.userId } })
  res.json({ data: { id }, error: null, meta: {} })
})

// POST /api/admin/activities/retry-sync-batch — flip N failed rows back to
// pending in a single request. Reuses the per-row guard (must currently be
// 'failed') so we never accidentally re-queue a healthy row. One summary
// audit entry per batch keeps the audit log readable.
monitoringRoutes.post('/activities/retry-sync-batch', requireAppAdmin, async (req, res) => {
  const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  let retried = 0
  for (const id of parsed.data.ids) {
    const [row] = await db.update(activities)
      .set({ crmSyncStatus: 'pending', crmSyncError: null, crmSyncAttempts: 0, crmNextRetryAt: null, updatedAt: new Date() })
      .where(and(eq(activities.id, id), eq(activities.crmSyncStatus, 'failed')))
      .returning({ id: activities.id })
    if (row) retried += 1
  }
  const failed = parsed.data.ids.length - retried
  await logAudit(req, {
    action: 'user.update',
    targetType: 'activity.retry_sync_batch',
    targetId: null,
    meta: { requested: parsed.data.ids.length, retried, failed, ids: parsed.data.ids },
  })
  res.json({ data: { retried, failed }, error: null, meta: {} })
})

// GET /api/admin/activity-health — every activity carrying an optional
// "Why Meeting?" reason (activities.meetingTypeReason, v1.257.0), joined to
// the submitting user + team, for the Admin > Monitoring > Activity Health
// triage queue (v1.258.0). This is product research per the PRD roadmap:
// letting admins see whether recurring reasons for picking the generic
// "Meeting" type point at a need for a more specific activity type.
// `status=new` filters to rows nobody has triaged yet (meetingTypeReasonStatus
// IS NULL) since that's not itself a stored enum value.
monitoringRoutes.get('/activity-health', requireAppAdmin, async (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query['limit'] ?? 300)))
  const statusFilter = (req.query['status'] as string | undefined) ?? ''
  const reviewer = alias(users, 'meeting_reason_reviewer')
  const clauses = [eq(activities.isArchived, false), isNotNull(activities.meetingTypeReason)]
  if (statusFilter === 'ignore' || statusFilter === 'will_watch' || statusFilter === 'addressed') {
    clauses.push(eq(activities.meetingTypeReasonStatus, statusFilter))
  } else if (statusFilter === 'new') {
    clauses.push(isNull(activities.meetingTypeReasonStatus))
  }
  const rows = await db
    .select({
      id: activities.id,
      title: activities.title,
      startDatetime: activities.startDatetime,
      submittedAt: activities.submittedAt,
      createdAt: activities.createdAt,
      meetingTypeReason: activities.meetingTypeReason,
      status: activities.meetingTypeReasonStatus,
      reviewedAt: activities.meetingTypeReasonReviewedAt,
      userId: activities.userId,
      userName: users.displayName,
      userEmail: users.email,
      teamName: teams.name,
      reviewedByName: reviewer.displayName,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.userId))
    .innerJoin(teams, eq(teams.id, activities.teamId))
    .leftJoin(reviewer, eq(reviewer.id, activities.meetingTypeReasonReviewedBy))
    .where(and(...clauses))
    .orderBy(desc(activities.createdAt))
    .limit(limit)
  res.json({ data: rows, error: null, meta: { count: rows.length } })
})

// PATCH /api/admin/activity-health/:id — set the App Admin's triage status
// for one activity's captured "Why Meeting?" reason. Records who + when so
// the row keeps an audit trail as this queue is worked over time. Guarded
// to rows that actually have a reason captured, same defensive pattern as
// retry-sync's "must currently be failed" guard above.
monitoringRoutes.patch('/activity-health/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const schema = z.object({ status: z.enum(['ignore', 'will_watch', 'addressed']) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [row] = await db.update(activities)
    .set({
      meetingTypeReasonStatus: parsed.data.status,
      meetingTypeReasonReviewedBy: req.user!.id,
      meetingTypeReasonReviewedAt: new Date(),
    })
    .where(and(eq(activities.id, id), isNotNull(activities.meetingTypeReason)))
    .returning({ id: activities.id, userId: activities.userId })
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await logAudit(req, {
    action: 'user.update',
    targetType: 'activity.meeting_reason_review',
    targetId: id,
    meta: { status: parsed.data.status, activityUserId: row.userId },
  })
  res.json({ data: { id, status: parsed.data.status }, error: null, meta: {} })
})

// --- Admin login history / active sessions (App Admin only) ---
monitoringRoutes.get('/login-history', requireAppAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 200)))
    const { loginEvents, sessions } = await import('../../../../drizzle/schema.js')
    const { gt, isNull } = await import('drizzle-orm')

    // Left-join users so failed attempts for unknown emails still show up
    // (userId is null in that case). Return success + failure_reason so
    // the client can filter and colour-code.
    const recentLogins = await db
      .select({
        id: loginEvents.id,
        userId: loginEvents.userId,
        email: users.email,
        displayName: users.displayName,
        attemptedEmail: loginEvents.attemptedEmail,
        success: loginEvents.success,
        failureReason: loginEvents.failureReason,
        method: loginEvents.method,
        ip: loginEvents.ip,
        userAgent: loginEvents.userAgent,
        isSuspicious: loginEvents.isSuspicious,
        alertSentAt: loginEvents.alertSentAt,
        createdAt: loginEvents.createdAt,
      })
      .from(loginEvents)
      .leftJoin(users, eq(users.id, loginEvents.userId))
      .orderBy(desc(loginEvents.createdAt))
      .limit(limit)

    const now = new Date()
    const activeSessions = await db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        email: users.email,
        displayName: users.displayName,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
        expiresAt: sessions.expiresAt,
        mfaMethod: sessions.mfaMethod,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .orderBy(desc(sessions.lastUsedAt))
      .limit(limit)

    res.json({ data: { logins: recentLogins, sessions: activeSessions }, error: null, meta: { logins: recentLogins.length, sessions: activeSessions.length } })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[login-history] query failed:', err)
    res.status(500).json({ data: null, error: 'errors.login_history_failed', meta: {} })
  }
})

// DELETE /api/admin/sessions/:id — force-revoke another user's session.
monitoringRoutes.delete('/sessions/:id', requireAppAdmin, async (req, res) => {
  const { id } = req.params as { id: string }
  const { sessions } = await import('../../../../drizzle/schema.js')
  const [row] = await db.update(sessions).set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, id), sql`${sessions.revokedAt} IS NULL`))
    .returning({ id: sessions.id, userId: sessions.userId })
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await logAudit(req, { action: 'user.update', targetType: 'session.revoke', targetId: row.userId, meta: { sessionId: id } })
  res.json({ data: { id }, error: null, meta: {} })
})
