import { Router } from 'express'
import { z } from 'zod'
import { db } from '../db/index.js'
import { teams, teamActivityTypes, activityTypeTeams, teamMembers, crmFieldMappings, crmFieldMappingTeams, nudgeRules, nudgeRuleTeams, users, subteams, subteamUsers, announcements } from '../../../drizzle/schema.js'
import { and, eq, desc, inArray } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth.js'
import { requireRole, isAppAdmin, getAccessibleTeamIds } from '../middleware/rbac.js'
import { logAudit } from '../services/audit/log.js'

export const teamsRouter = Router()

teamsRouter.use(requireAuth)

// Every /:teamId/* read is limited to teams the caller can see: their own
// teams, or every team for App Admins and can-see-all-teams users. Several
// config reads (activity types, mappings, nudge rules, products) used to
// answer for any team id (security audit L2, v1.422.0).
teamsRouter.use('/:teamId', async (req, res, next) => {
  const teamId = req.params['teamId']
  if (!teamId || !(await getAccessibleTeamIds(req.user!.id)).includes(teamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  next()
})

// GET /api/teams — teams the current user can see.
// App admins and users with can_see_all_teams get the full active team list
// (with role='admin' for app admins, else the membership role if any).
teamsRouter.get('/', async (req, res) => {
  const user = req.user!

  const [u] = await db
    .select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  if (u?.isAppAdmin || u?.canSeeAllTeams) {
    const allActive = await db
      .select({
        id: teams.id, name: teams.name, slug: teams.slug, icon: teams.icon,
        defaultWorkerType: teams.defaultWorkerType,
        defaultWorkDays: teams.defaultWorkDays,
        defaultWorkDayStartHour: teams.defaultWorkDayStartHour,
        defaultWorkDayEndHour: teams.defaultWorkDayEndHour,
        // v1.256.0: read alongside activityTypes on every team switch so the
        // Log Activity form and Activity Templates know whether to show the
        // Subtype picker without an extra round-trip.
        subtypesEnabled: teams.subtypesEnabled,
      })
      .from(teams)
      .where(eq(teams.isActive, true))
    const memberships = await db
      .select({ teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.userId, user.id))
    const roleByTeam = new Map(memberships.map((m) => [m.teamId, m.role]))
    const data = allActive.map((t) => ({
      ...t,
      role: u?.isAppAdmin ? 'admin' : (roleByTeam.get(t.id) ?? 'leader'),
    }))
    res.json({ data, error: null, meta: { canSeeAll: true } })
    return
  }

  const rows = await db
    .select({
      id: teams.id, name: teams.name, slug: teams.slug, icon: teams.icon, role: teamMembers.role,
      defaultWorkerType: teams.defaultWorkerType,
      defaultWorkDays: teams.defaultWorkDays,
      defaultWorkDayStartHour: teams.defaultWorkDayStartHour,
      defaultWorkDayEndHour: teams.defaultWorkDayEndHour,
      subtypesEnabled: teams.subtypesEnabled,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(and(eq(teamMembers.userId, user.id), eq(teams.isActive, true)))

  res.json({ data: rows, error: null, meta: { canSeeAll: false } })
})

// GET /api/teams/:teamId/activity-types — returns types assigned to this team via junction.
teamsRouter.get('/:teamId/activity-types', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db
    .select({ type: teamActivityTypes })
    .from(teamActivityTypes)
    .innerJoin(activityTypeTeams, and(
      eq(activityTypeTeams.activityTypeId, teamActivityTypes.id),
      eq(activityTypeTeams.teamId, teamId),
    ))
    .where(eq(teamActivityTypes.isActive, true))
    .orderBy(teamActivityTypes.sortOrder)

  res.json({ data: rows.map((r) => r.type), error: null, meta: {} })
})

// GET /api/teams/:teamId/activity-type-subtypes — v1.255.0: bulk Subtype
// labels for every active type on this team, keyed by teamActivityTypeId
// on the client (Guide page), so it's one request instead of one per type.
teamsRouter.get('/:teamId/activity-type-subtypes', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { teamActivityTypeSubtypes } = await import('../../../drizzle/schema.js')
  const rows = await db
    .select({ subtype: teamActivityTypeSubtypes })
    .from(teamActivityTypeSubtypes)
    .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, teamActivityTypeSubtypes.teamActivityTypeId))
    .innerJoin(activityTypeTeams, and(
      eq(activityTypeTeams.activityTypeId, teamActivityTypes.id),
      eq(activityTypeTeams.teamId, teamId),
    ))
    .where(eq(teamActivityTypes.isActive, true))
    .orderBy(teamActivityTypeSubtypes.sortOrder, teamActivityTypeSubtypes.createdAt)
  res.json({ data: rows.map((r) => r.subtype), error: null, meta: {} })
})

// GET /api/teams/:teamId/guide-distinctions — the team-scoped free text
// rendered at the bottom of the Guide page.
teamsRouter.get('/:teamId/guide-distinctions', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const [row] = await db.select({ guideDistinctions: teams.guideDistinctions }).from(teams).where(eq(teams.id, teamId)).limit(1)
  res.json({ data: { guideDistinctions: row?.guideDistinctions ?? null }, error: null, meta: {} })
})

// GET /api/teams/:teamId/sf-field-mappings
teamsRouter.get('/:teamId/sf-field-mappings', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db
    .select({ m: crmFieldMappings })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(eq(crmFieldMappingTeams.teamId, teamId), eq(crmFieldMappings.isActive, true)))

  res.json({ data: rows.map((r) => r.m), error: null, meta: {} })
})

// GET /api/teams/:teamId/nudge-rules — rules assigned to this team via junction.
teamsRouter.get('/:teamId/nudge-rules', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db
    .select({ rule: nudgeRules })
    .from(nudgeRules)
    .innerJoin(nudgeRuleTeams, and(eq(nudgeRuleTeams.nudgeRuleId, nudgeRules.id), eq(nudgeRuleTeams.teamId, teamId)))
    .where(eq(nudgeRules.isActive, true))

  res.json({ data: rows.map((r) => r.rule), error: null, meta: {} })
})


// GET /api/teams/:teamId/products — active products assigned to a team.
teamsRouter.get('/:teamId/products', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { products: productsTbl, productTeams } = await import('../../../drizzle/schema.js')
  const rows = await db
    .select({ p: productsTbl })
    .from(productsTbl)
    .innerJoin(productTeams, eq(productTeams.productId, productsTbl.id))
    .where(and(eq(productTeams.teamId, teamId), eq(productsTbl.isActive, true)))
    .orderBy(productsTbl.name)
  res.json({ data: rows.map((r) => r.p), error: null, meta: {} })
})

// GET /api/teams/:teamId/members — list users on this team so the dashboard
// user-filter dropdown can populate. Any team member can call it (not just
// admins); the response includes only id/name/email for the picker.
teamsRouter.get('/:teamId/members', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  // Must be a member of this team OR canSeeAllTeams / isAppAdmin.
  const callerId = req.user!.id
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams }).from(users).where(eq(users.id, callerId)).limit(1)
  let allowed = !!caller?.isAppAdmin || !!caller?.canSeeAllTeams
  if (!allowed) {
    const [m] = await db.select({ userId: teamMembers.userId }).from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, callerId))).limit(1)
    allowed = !!m
  }
  if (!allowed) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email, role: teamMembers.role, timezone: users.timezone })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(users.displayName)
  res.json({ data: rows, error: null, meta: {} })
})

// v1.90.0: subteams for the dashboard filter. Same visibility rules as
// /members. Members are members of the subteam (not just the parent team).
teamsRouter.get('/:teamId/subteams', async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const callerId = req.user!.id
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams }).from(users).where(eq(users.id, callerId)).limit(1)
  let allowed = !!caller?.isAppAdmin || !!caller?.canSeeAllTeams
  if (!allowed) {
    const [m] = await db.select({ userId: teamMembers.userId }).from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, callerId))).limit(1)
    allowed = !!m
  }
  if (!allowed) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  const rows = await db
    .select({ id: subteams.id, name: subteams.name, kind: subteams.kind, isActive: subteams.isActive })
    .from(subteams)
    .where(and(eq(subteams.teamId, teamId), eq(subteams.isActive, true)))
    .orderBy(subteams.name)
  res.json({ data: rows, error: null, meta: {} })
})

// GET /api/teams/:teamId/subteams/:subteamId/members — the user IDs the
// dashboard should restrict to when the subteam filter is active. The
// dashboard already scopes by userId; this endpoint just returns the
// membership set so the client can send userId=$id one at a time OR the
// dashboard endpoints can pull it themselves (see subteamId query param
// support added below).
teamsRouter.get('/:teamId/subteams/:subteamId/members', async (req, res) => {
  const { teamId, subteamId } = req.params as { teamId: string; subteamId: string }
  const callerId = req.user!.id
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams }).from(users).where(eq(users.id, callerId)).limit(1)
  let allowed = !!caller?.isAppAdmin || !!caller?.canSeeAllTeams
  if (!allowed) {
    const [m] = await db.select({ userId: teamMembers.userId }).from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, callerId))).limit(1)
    allowed = !!m
  }
  if (!allowed) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  // v1.264.0: selectDistinct — subteam_users' primary key is
  // (subteamId, userId, role), so a user with more than one role on the
  // same subteam (e.g. both 'member' and 'leader') previously joined into
  // duplicate rows here, showing the same person twice in every consumer
  // of this endpoint.
  const rows = await db
    .selectDistinct({ id: users.id, displayName: users.displayName, email: users.email })
    .from(subteamUsers)
    .innerJoin(users, eq(users.id, subteamUsers.userId))
    // The subteam must belong to the team in the URL (audit L3, v1.422.0).
    .innerJoin(subteams, and(eq(subteams.id, subteamUsers.subteamId), eq(subteams.teamId, teamId)))
    .where(eq(subteamUsers.subteamId, subteamId))
    .orderBy(users.displayName)
  res.json({ data: rows, error: null, meta: {} })
})

// ─── Announcements (Admin → Workplace) ──────────────────────────────────
// Admin/Team Admin/Leader broadcasts a message to a team, subteam, or a
// specific user, shown in the top-header banner and the notification bell.
// See CLAUDE.md §14 and services/announcements/engine.ts (the viewer-local-
// day recurrence design — this file never computes "is it active", only
// CRUD + who's allowed to post which target type).
//
// Deliberately on teamsRouter (requireAuth only), NOT adminRouter — that
// router's own blanket requireGlobalAdmin gate (admin.ts) only lets in App
// Admin or a admin/team_admin role holder, which would 403 a plain Leader
// before this route's own requireRole('leader','admin') ever ran. The
// Opportunity Relink feature hit this exact same requirement and landed in
// activities.ts for the identical reason — mirrored here.
const announcementDateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')

// Equivalent to admin.ts's canManageUserAlignment (that helper is private to
// that file) — does the caller share an accessible team with the target
// user? Used only for the targetType='user' branch below.
async function sharesAccessibleTeamWith(callerUserId: string, targetUserId: string): Promise<boolean> {
  if (await isAppAdmin(callerUserId)) return true
  const accessible = await getAccessibleTeamIds(callerUserId)
  if (accessible.length === 0) return false
  const [row] = await db.select({ id: teamMembers.id }).from(teamMembers)
    .where(and(eq(teamMembers.userId, targetUserId), inArray(teamMembers.teamId, accessible))).limit(1)
  return !!row
}

// A Leader may post to a subteam they lead, or a specific user sharing an
// accessible team with them — but never team-wide (that's Team Admin/App
// Admin only).
//
// Exported (not just route-local) so it can be unit-tested against pglite
// directly, the same "export for testability" convention this codebase
// already uses for buildSfRecord()/validateOne() — see canPostAnnouncementTarget.test.ts.
export async function canPostAnnouncementTarget(
  callerUserId: string,
  teamId: string,
  targetType: 'team' | 'subteam' | 'user',
  target: { subteamId?: string | null | undefined; targetUserId?: string | null | undefined },
): Promise<boolean> {
  if (await isAppAdmin(callerUserId)) return true
  const [membership] = await db.select({ role: teamMembers.role }).from(teamMembers)
    .where(and(eq(teamMembers.userId, callerUserId), eq(teamMembers.teamId, teamId))).limit(1)
  if (!membership) return false
  if (membership.role === 'admin' || membership.role === 'team_admin') return true
  if (membership.role !== 'leader') return false
  if (targetType === 'team') return false
  if (targetType === 'subteam') {
    if (!target.subteamId) return false
    const [row] = await db.select({ subteamId: subteamUsers.subteamId }).from(subteamUsers)
      .where(and(eq(subteamUsers.subteamId, target.subteamId), eq(subteamUsers.userId, callerUserId), eq(subteamUsers.role, 'leader')))
      .limit(1)
    return !!row
  }
  // targetType === 'user'
  if (!target.targetUserId) return false
  return sharesAccessibleTeamWith(callerUserId, target.targetUserId)
}

teamsRouter.get('/:teamId/announcements', requireRole('leader', 'admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db.select().from(announcements).where(eq(announcements.teamId, teamId)).orderBy(desc(announcements.createdAt))
  res.json({ data: rows, error: null, meta: {} })
})

teamsRouter.post('/:teamId/announcements', requireRole('leader', 'admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const user = req.user!
  const schema = z.object({
    targetType: z.enum(['team', 'subteam', 'user']),
    subteamId: z.string().uuid().nullable().optional(),
    targetUserId: z.string().uuid().nullable().optional(),
    message: z.string().min(1).max(2000),
    severity: z.enum(['info', 'warning', 'critical']).default('info'),
    // Header-banner-only custom icon (see CLAUDE.md §14c) — icon is a plain
    // lucide name from IconPicker, unvalidated beyond being a string (an
    // unrecognized name just renders nothing, same as DynamicIcon's own
    // null-safe fallback). Colors are validated as real hex so a malformed
    // value can never be persisted even if the client-side check is bypassed.
    icon: z.string().nullable().optional(),
    iconColorLight: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    iconColorDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    startDate: announcementDateStr,
    endDate: announcementDateStr.nullable().optional(),
    recurringDaily: z.boolean().default(false),
    isActive: z.boolean().default(true),
    // v1.433.0: also send to Slack once it's active (services/slack/announcements.ts).
    sendSlack: z.boolean().default(false),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { targetType, subteamId, targetUserId, ...rest } = parsed.data
  if (targetType === 'subteam' && !subteamId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (targetType === 'user' && !targetUserId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!(await canPostAnnouncementTarget(user.id, teamId, targetType, { subteamId, targetUserId }))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  // Never carry a stray subteam/user id for a target type that doesn't use
  // it, even if the client sent one — same "don't leave dead config nobody
  // notices" discipline keyword_rules' action/activityTypeId pair uses.
  const resolvedSubteamId = targetType === 'subteam' ? subteamId : null
  const resolvedTargetUserId = targetType === 'user' ? targetUserId : null
  const [inserted] = await db.insert(announcements).values({
    teamId,
    targetType,
    subteamId: resolvedSubteamId,
    targetUserId: resolvedTargetUserId,
    ...rest,
    createdBy: user.id,
  }).returning()
  if (!inserted) { res.status(500).json({ data: null, error: 'errors.database.insert_failed', meta: {} }); return }
  await logAudit(req, { action: 'announcement.create', targetType: 'announcement', targetId: inserted.id, meta: { teamId, targetType: inserted.targetType, subteamId: inserted.subteamId, targetUserId: inserted.targetUserId } })
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

teamsRouter.patch('/:teamId/announcements/:id', requireRole('leader', 'admin'), async (req, res) => {
  const { teamId, id } = req.params as { teamId: string; id: string }
  const user = req.user!
  const schema = z.object({
    targetType: z.enum(['team', 'subteam', 'user']).optional(),
    subteamId: z.string().uuid().nullable().optional(),
    targetUserId: z.string().uuid().nullable().optional(),
    message: z.string().min(1).max(2000).optional(),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
    icon: z.string().nullable().optional(),
    iconColorLight: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    iconColorDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    startDate: announcementDateStr.optional(),
    endDate: announcementDateStr.nullable().optional(),
    recurringDaily: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sendSlack: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [existing] = await db.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.teamId, teamId))).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const { targetType, subteamId, targetUserId, ...rest } = parsed.data
  const effectiveTargetType = targetType ?? existing.targetType
  const effectiveSubteamId = subteamId !== undefined ? subteamId : existing.subteamId
  const effectiveTargetUserId = targetUserId !== undefined ? targetUserId : existing.targetUserId
  if (effectiveTargetType === 'subteam' && !effectiveSubteamId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (effectiveTargetType === 'user' && !effectiveTargetUserId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  // Re-check the target permission whenever any targeting field is actually
  // being touched (not just message/dates/severity/isActive edits) — a
  // Leader editing an unrelated field on an announcement they already
  // legitimately created needs no re-check, but retargeting one always does.
  if (targetType !== undefined || subteamId !== undefined || targetUserId !== undefined) {
    if (!(await canPostAnnouncementTarget(user.id, teamId, effectiveTargetType, { subteamId: effectiveSubteamId, targetUserId: effectiveTargetUserId }))) {
      res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
      return
    }
  }
  const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() }
  if (targetType !== undefined) patch['targetType'] = effectiveTargetType
  if (targetType !== undefined || subteamId !== undefined) patch['subteamId'] = effectiveTargetType === 'subteam' ? effectiveSubteamId : null
  if (targetType !== undefined || targetUserId !== undefined) patch['targetUserId'] = effectiveTargetType === 'user' ? effectiveTargetUserId : null
  const [updated] = await db.update(announcements).set(patch).where(eq(announcements.id, id)).returning()
  if (!updated) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await logAudit(req, { action: 'announcement.update', targetType: 'announcement', targetId: id, meta: { before: existing, after: updated } })
  res.json({ data: updated, error: null, meta: {} })
})

teamsRouter.delete('/:teamId/announcements/:id', requireRole('leader', 'admin'), async (req, res) => {
  const { teamId, id } = req.params as { teamId: string; id: string }
  const user = req.user!
  const [existing] = await db.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.teamId, teamId))).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  // A plain Leader may only delete an announcement they created themselves
  // — Team Admin/App Admin may delete any on their team. Small extra
  // guardrail beyond canPostAnnouncementTarget: a Leader shouldn't be able
  // to remove another Leader's posted announcement just because both hold
  // the same base role.
  if (!(await isAppAdmin(user.id))) {
    const [membership] = await db.select({ role: teamMembers.role }).from(teamMembers)
      .where(and(eq(teamMembers.userId, user.id), eq(teamMembers.teamId, teamId))).limit(1)
    const isTeamAdminPlus = membership?.role === 'admin' || membership?.role === 'team_admin'
    if (!isTeamAdminPlus && existing.createdBy !== user.id) {
      res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
      return
    }
  }
  await db.delete(announcements).where(eq(announcements.id, id))
  await logAudit(req, { action: 'announcement.delete', targetType: 'announcement', targetId: id, meta: { deleted: existing } })
  res.json({ data: { id }, error: null, meta: {} })
})
