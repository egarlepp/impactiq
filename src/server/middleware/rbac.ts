import type { Request, Response, NextFunction } from 'express'
import { db } from '../db/index.js'
import { teamMembers, teams, users, rolePermissions } from '../../../drizzle/schema.js'
import { and, eq, inArray } from 'drizzle-orm'

export type Role = 'contributor' | 'leader' | 'team_admin' | 'admin'

// team_admin and admin both grant team-level admin permissions. The two labels
// exist for organizational clarity; permissions are equivalent.
const ROLE_HIERARCHY: Record<Role, number> = {
  contributor: 1,
  leader: 2,
  team_admin: 3,
  admin: 3,
}

export async function isAppAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isAppAdmin: users.isAppAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return !!row?.isAppAdmin
}

// Returns the set of team IDs the user can see config/data for. For app admins
// and users with can_see_all_teams, this is every active team. For everyone else,
// it's just the teams they belong to.
export async function getAccessibleTeamIds(userId: string): Promise<string[]> {
  const [u] = await db
    .select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (u?.isAppAdmin || u?.canSeeAllTeams) {
    const allActive = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.isActive, true))
    return allActive.map((r) => r.id)
  }
  const memberships = await db
    .select({ id: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
  return memberships.map((r) => r.id)
}

export async function requireAppAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ data: null, error: 'Unauthorized', meta: {} })
    return
  }
  if (!(await isAppAdmin(req.user.id))) {
    res.status(403).json({ data: null, error: 'App admin access required', meta: {} })
    return
  }
  next()
}

// v1.332.0: the app-update feature (Admin → Integrations → App Updates, and
// the sidebar Update pill) is deliberately gated tighter than every other
// App Admin action — see CLAUDE.md. App Admins can VIEW (status, the
// configured owner/repo/branch) via the usual requireAppAdmin. Every ACTION —
// triggering a live GitHub check, saving or clearing the PAT, and (once
// Phase 2 lands) an actual redeploy — is restricted to the one designated
// `users.is_default_admin` account, not the whole App Admin population,
// since App Admin is a flag any number of accounts can hold (§5) but this is
// the one surface this app treats as "the owner's call, not any admin's."
export async function isDefaultAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isDefaultAdmin: users.isDefaultAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return !!row?.isDefaultAdmin
}

export async function requireDefaultAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ data: null, error: 'Unauthorized', meta: {} })
    return
  }
  if (!(await isDefaultAdmin(req.user.id))) {
    res.status(403).json({ data: null, error: 'errors.default_admin_required', meta: {} })
    return
  }
  next()
}

// Allows access when the user holds the admin role on at least one team OR is an app admin.
// Used for admin endpoints that don't carry a teamId in the path.
export async function requireGlobalAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ data: null, error: 'Unauthorized', meta: {} })
    return
  }

  if (await isAppAdmin(req.user.id)) {
    next()
    return
  }

  const [row] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, req.user.id), inArray(teamMembers.role, ['admin', 'team_admin'])))
    .limit(1)

  if (!row) {
    res.status(403).json({ data: null, error: 'Admin access required', meta: {} })
    return
  }

  next()
}

// Boolean form of the check requireAnyLeaderOrAdmin enforces — is the user an
// app admin, or does he/she hold leader/admin/team_admin on at least one
// team? Extracted so non-middleware call sites (e.g. gating which scopes a
// user can self-issue an API key for) can reuse the exact same rule instead
// of re-deriving it.
export async function hasAnyLeaderOrAdminRole(userId: string): Promise<boolean> {
  if (await isAppAdmin(userId)) return true
  const [row] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.role, ['leader', 'admin', 'team_admin'])))
    .limit(1)
  return !!row
}

// Allows access when the user is an app admin OR holds any leader/admin role
// on at least one team. For NON-team-scoped endpoints (e.g. the global SF
// refresh) that leaders may trigger but which carry no teamId to scope by.
export async function requireAnyLeaderOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ data: null, error: 'Unauthorized', meta: {} })
    return
  }
  if (!(await hasAnyLeaderOrAdminRole(req.user.id))) {
    res.status(403).json({ data: null, error: 'Leader or admin access required', meta: {} })
    return
  }
  next()
}

// The team a request is about, for the role checks below. Reads the path,
// then the body, then the query, and refuses a request where two of them name
// different teams: a check that passed on one team while the handler read
// another would let a leader on team A read team B (security audit H1,
// v1.422.0). Returns null when no team is named.
export function requestTeamId(req: Request): string | null | 'conflict' {
  const candidates: unknown[] = [
    req.params['teamId'],
    (req.body as Record<string, unknown> | undefined)?.['teamId'],
    req.query['teamId'],
  ]
  let teamId: string | null = null
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue
    if (typeof c !== 'string') return 'conflict'
    if (teamId !== null && teamId !== c) return 'conflict'
    teamId = c
  }
  return teamId
}

export function requireRole(...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ data: null, error: 'Unauthorized', meta: {} })
      return
    }

    const resolved = requestTeamId(req)
    if (resolved === 'conflict') {
      res.status(400).json({ data: null, error: 'errors.teams.conflicting_team_ids', meta: {} })
      return
    }
    const teamId = resolved

    if (!teamId) {
      // No dev bypass — a missing teamId means the endpoint isn't team-scoped
      // properly and MUST fail closed. The earlier bypass silently granted
      // access on any deployment where NODE_ENV wasn't explicitly set.
      res.status(400).json({ data: null, error: 'teamId required for role check', meta: {} })
      return
    }

    // App admins have full access to every team (CLAUDE.md §5) whether or not
    // they hold a team_members row on that team — matches getAccessibleTeamIds
    // and the /admin/* app-admin routes. Without this, an app admin who isn't a
    // member of a team (e.g. Channel) got 403 on that team's config endpoints
    // (Activity Types, SF Mappings, …) and the screen rendered empty.
    if (await isAppAdmin(req.user.id)) {
      next()
      return
    }

    const [membership] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, req.user.id), eq(teamMembers.teamId, teamId)))
      .limit(1)

    if (!membership) {
      res.status(403).json({ data: null, error: 'Forbidden', meta: {} })
      return
    }

    const userRoleLevel = ROLE_HIERARCHY[membership.role]
    const requiredLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r]))

    if (userRoleLevel < requiredLevel) {
      res.status(403).json({ data: null, error: 'Insufficient permissions', meta: {} })
      return
    }

    next()
  }
}

// v1.322.0: a leader-group dashboard route previously hardcoded
// requireRole('leader', 'admin') — so an App Admin granting a Contributor
// role visibility into a specific dashboard tab via Role Management (the
// `dashboard.<key>` page-permission matrix Dashboard.tsx's tab filter
// already reads via hasPermission()) made the tab appear, but every data
// request behind it still 403'd, since the matrix was never consulted
// server-side. This wraps requireRole('leader', 'admin') and adds a second
// path: if the caller isn't leader+ on the requested team, check whether
// ANY role they hold (across any team) has this dashboard key granted —
// the same union-across-memberships logic /auth/me already uses to decide
// whether the tab is visible in the first place, so "the tab shows" and
// "the data loads" can never disagree again. dashboardKey matches the
// `dashboard.<key>` keys already used by Dashboard.tsx's per-tab
// hasPermission() check and Role Management's own page list.
export function requireDashboardAccess(dashboardKey: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ data: null, error: 'Unauthorized', meta: {} })
      return
    }
    const resolved = requestTeamId(req)
    if (resolved === 'conflict') {
      res.status(400).json({ data: null, error: 'errors.teams.conflicting_team_ids', meta: {} })
      return
    }
    const teamId = resolved
    if (!teamId) {
      res.status(400).json({ data: null, error: 'teamId required for role check', meta: {} })
      return
    }
    if (await isAppAdmin(req.user.id)) {
      next()
      return
    }
    const [membership] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, req.user.id), eq(teamMembers.teamId, teamId)))
      .limit(1)
    if (!membership) {
      res.status(403).json({ data: null, error: 'Forbidden', meta: {} })
      return
    }
    if (ROLE_HIERARCHY[membership.role] >= ROLE_HIERARCHY['leader']) {
      next()
      return
    }
    const memberships = await db.select({ role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.userId, req.user.id))
    const roles = Array.from(new Set(memberships.map((m) => m.role)))
    if (roles.length === 0) {
      res.status(403).json({ data: null, error: 'Forbidden', meta: {} })
      return
    }
    const [grant] = await db
      .select()
      .from(rolePermissions)
      .where(and(inArray(rolePermissions.role, roles), eq(rolePermissions.pageKey, `dashboard.${dashboardKey}`), eq(rolePermissions.hasAccess, true)))
      .limit(1)
    if (!grant) {
      res.status(403).json({ data: null, error: 'Forbidden', meta: {} })
      return
    }
    next()
  }
}
