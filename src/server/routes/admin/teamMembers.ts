import { Router } from 'express'
import { db } from '../../db/index.js'
import { teams, teamMembers, users } from '../../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { requireRole, isAppAdmin } from '../../middleware/rbac.js'
import { z } from 'zod'
import { pruneSubteamMembershipsForLeftTeams } from '../../services/teams/userSubteams.js'

export const teamMembersRoutes = Router()

// --- User Management ---
teamMembersRoutes.get('/teams/:teamId/users', requireRole('admin', 'team_admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const dt = alias(teams, 'default_team')
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: teamMembers.role,
      isDefaultAdmin: users.isDefaultAdmin,
      authMethod: users.authMethod,
      defaultTeamId: users.defaultTeamId,
      defaultTeamName: dt.name,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .leftJoin(dt, eq(users.defaultTeamId, dt.id))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(users.displayName)
  res.json({ data: rows, error: null, meta: {} })
})

teamMembersRoutes.post('/teams/:teamId/users', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({
    userId: z.string().uuid(),
    role: z.enum(['contributor', 'leader', 'team_admin', 'admin']),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  // Security fix (F-04, pentest 2026-09): "admin" auto-grants global App
  // Admin below — requireRole('admin') only proves the caller is
  // admin/team_admin on THIS team, which let any team_admin hand themselves
  // (or anyone) full app-wide access via this route. Only an existing App
  // Admin may grant the "admin" label now. team_admin remains available to
  // team_admin callers and is functionally identical for team-scoped
  // permissions (rbac.ts ROLE_HIERARCHY), so nothing legitimate is lost.
  if (parsed.data.role === 'admin' && !(await isAppAdmin(req.user!.id))) {
    res.status(403).json({ data: null, error: 'errors.users.admin_role_requires_app_admin', meta: {} })
    return
  }

  const [existing] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, parsed.data.userId)))
    .limit(1)
  if (existing) {
    res.status(409).json({ data: null, error: 'errors.team_member_exists', meta: {} })
    return
  }

  const [inserted] = await db.insert(teamMembers).values({ teamId, ...parsed.data }).returning()

  // v1.81.0: mirror the role=admin ⇒ is_app_admin semantics used by the
  // User Management create + role-patch endpoints.
  if (parsed.data.role === 'admin') {
    await db.update(users).set({ isAppAdmin: true, updatedAt: new Date() }).where(eq(users.id, parsed.data.userId))
  }

  res.status(201).json({ data: inserted, error: null, meta: {} })
})

teamMembersRoutes.delete('/teams/:teamId/users/:userId', requireRole('admin'), async (req, res) => {
  const { teamId, userId } = req.params as { teamId: string; userId: string }

  // Guard: the default ImpactIQ admin can never be removed from a team —
  // they need at least one membership row so the app keeps a usable owner.
  const [u] = await db.select({ isDefaultAdmin: users.isDefaultAdmin }).from(users).where(eq(users.id, userId)).limit(1)
  if (u?.isDefaultAdmin) {
    res.status(400).json({ data: null, error: 'errors.cannot_remove_default_admin', meta: {} })
    return
  }

  // Guard: don't allow removing the last admin from a team.
  const [target] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1)
  if (!target) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }

  if (target.role === 'admin') {
    const remaining = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'admin')))
    if (remaining.length <= 1) {
      res.status(400).json({ data: null, error: 'errors.cannot_remove_last_team_admin', meta: {} })
      return
    }
  }

  await db.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
  // Leaving a team also leaves its subteams (v1.470.0).
  await pruneSubteamMembershipsForLeftTeams(userId, [teamId])
  res.json({ data: { teamId, userId }, error: null, meta: {} })
})

teamMembersRoutes.patch('/teams/:teamId/users/:userId/role', requireRole('admin'), async (req, res) => {
  const { teamId, userId } = req.params as { teamId: string; userId: string }
  const schema = z.object({ role: z.enum(['contributor', 'leader', 'team_admin', 'admin']) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  // Security fix (F-04, pentest 2026-09): see POST /teams/:teamId/users
  // above — "admin" auto-grants global App Admin further down this handler,
  // so only an existing App Admin may set it (this previously let a
  // team_admin PATCH their own role to "admin" and self-escalate to full
  // app-wide access with one call).
  if (parsed.data.role === 'admin' && !(await isAppAdmin(req.user!.id))) {
    res.status(403).json({ data: null, error: 'errors.users.admin_role_requires_app_admin', meta: {} })
    return
  }

  // Guard: don't allow demoting the last admin.
  if (parsed.data.role !== 'admin') {
    const [target] = await db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1)
    if (target?.role === 'admin') {
      const admins = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'admin')))
      if (admins.length <= 1) {
        res.status(400).json({ data: null, error: 'errors.teams.cannot_demote_last_admin', meta: {} })
        return
      }
    }
  }

  const [updated] = await db.update(teamMembers).set({ role: parsed.data.role }).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).returning()

  // v1.81.0: the User Management Role dropdown's "Admin" option is expected
  // to grant the same rights as the primary App Admin — matches how the
  // user labels the option in the UI. Sync users.is_app_admin with the
  // team_members.role so setting Admin here flips the app-wide flag on
  // (and demoting away from Admin flips it off, unless the user is still
  // team_admin='admin' on another team or is the default admin).
  const [u] = await db.select({ isAppAdmin: users.isAppAdmin, isDefaultAdmin: users.isDefaultAdmin }).from(users).where(eq(users.id, userId)).limit(1)
  if (u) {
    if (parsed.data.role === 'admin') {
      if (!u.isAppAdmin) {
        await db.update(users).set({ isAppAdmin: true, updatedAt: new Date() }).where(eq(users.id, userId))
      }
    } else if (u.isAppAdmin && !u.isDefaultAdmin) {
      const otherAdminMemberships = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), eq(teamMembers.role, 'admin')))
      if (otherAdminMemberships.length === 0) {
        await db.update(users).set({ isAppAdmin: false, updatedAt: new Date() }).where(eq(users.id, userId))
      }
    }
  }

  res.json({ data: updated, error: null, meta: {} })
})
