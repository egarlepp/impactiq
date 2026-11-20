import { Router } from 'express'
import { db } from '../../db/index.js'
import {
  teams,
  teamMembers,
  users,
  oktaGroupRoleMappings,
  rolePermissions,
  userNotificationPrefs,
  userIntegrations,
} from '../../../../drizzle/schema.js'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { crmUsers } from '../../../../drizzle/schema.js'
import { requireAppAdmin, getAccessibleTeamIds } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { hashPassword } from '../../services/auth/password.js'
import { getAuthPolicy, saveAuthPolicy, getOktaGroupSettings, saveOktaGroupSettings } from '../../services/config/auth-policy.js'
import { validatePasswordComplexity, PASSWORD_MIN_LENGTH, authMethodNeedsPassword } from '../../../shared/schemas/password.js'
import { z } from 'zod'
import { canManageUserAlignment } from './alignment.js'
import { pruneSubteamMembershipsForLeftTeams } from '../../services/teams/userSubteams.js'

export const usersAdminRoutes = Router()

// --- Global user listing (for "add user to team" picker) ---
// v1.288.0: scoped to the caller's accessible teams (security audit finding
// B4) — this router is only gated by requireGlobalAdmin (admin/team_admin on
// ANY one team, or app admin), so without this a Team Admin scoped to one
// small team could enumerate the entire tenant's users, including MFA
// enrollment status, admin flags, and SF linkage for every team. App admins
// and canSeeAllTeams users see everyone, same as before — they need to,
// including users with no team assigned yet, which a team-intersection
// filter would otherwise hide even from them.
usersAdminRoutes.get('/users', async (req, res) => {
  const [caller] = await db
    .select({ isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams })
    .from(users)
    .where(eq(users.id, req.user!.id))
    .limit(1)
  const isGlobalScope = !!(caller?.isAppAdmin || caller?.canSeeAllTeams)
  const accessibleTeamIds = isGlobalScope ? null : new Set(await getAccessibleTeamIds(req.user!.id))
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
      isAppAdmin: users.isAppAdmin,
      canSeeAllTeams: users.canSeeAllTeams,
      isDefaultAdmin: users.isDefaultAdmin,
      authMethod: users.authMethod,
      defaultTeamId: users.defaultTeamId,
      defaultTeamName: teams.name,
      mustChangePassword: users.mustChangePassword,
      passwordChangedAt: users.passwordChangedAt,
      oktaId: users.oktaId,
      totpEnrolledAt: users.totpEnrolledAt,
      mfaBackupCodesHash: users.mfaBackupCodesHash,
      workerType: users.workerType,
      workDays: users.workDays,
      workDayStartHour: users.workDayStartHour,
      workDayEndHour: users.workDayEndHour,
      crmUserId: users.crmUserId,
      sfUserName: crmUsers.name,
      sfUserEmail: crmUsers.email,
      preferredCurrency: users.preferredCurrency,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .leftJoin(teams, eq(users.defaultTeamId, teams.id))
    .leftJoin(crmUsers, eq(users.crmUserId, crmUsers.id))
    .orderBy(users.displayName)
  const memberships = await db
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
  const teamsByUser = new Map<string, string[]>()
  // v1.318.0: also keyed by teamId so a caller can resolve a user's role on
  // a SPECIFIC team without a second round trip — needed by the "group by
  // default team" cross-team view, where a row's role comes from its own
  // team_members entry for that group's team, not just "some role somewhere".
  const rolesByUser = new Map<string, Record<string, string>>()
  for (const m of memberships) {
    const list = teamsByUser.get(m.userId) ?? []
    list.push(m.teamId)
    teamsByUser.set(m.userId, list)
    const roleMap = rolesByUser.get(m.userId) ?? {}
    roleMap[m.teamId] = m.role
    rolesByUser.set(m.userId, roleMap)
  }
  // v1.318.0: last successful login per user, for the new "Last Logged In"
  // column — same table Login History (App Admin only) already reads, just
  // reduced to one MAX(createdAt) per user rather than the full event list.
  const { loginEvents } = await import('../../../../drizzle/schema.js')
  const lastLogins = await db
    .select({ userId: loginEvents.userId, lastAt: sql<Date | null>`max(${loginEvents.createdAt})` })
    .from(loginEvents)
    .where(eq(loginEvents.success, true))
    .groupBy(loginEvents.userId)
  const lastLoginByUser = new Map<string, Date>()
  for (const l of lastLogins) {
    if (l.userId && l.lastAt) lastLoginByUser.set(l.userId, new Date(l.lastAt))
  }
  // vNext: SF/Outlook connection icons on the roster row. Deliberately just
  // ONE extra query for the whole page — same shape as lastLogins above —
  // reading only local Postgres (user_integrations, unique on
  // (userId, provider)) rather than a live SF/Graph call per user. "Connected"
  // here means "we have a stored token," not "the token is verified working
  // right now" — that stronger check is the opt-in Verify button
  // (POST /users/:userId/verify-connection below), which never fires from
  // this route.
  const integrationRows = await db
    .select({
      userId: userIntegrations.userId,
      provider: userIntegrations.provider,
      updatedAt: userIntegrations.updatedAt,
      accountLabel: userIntegrations.accountLabel,
    })
    .from(userIntegrations)
    .where(inArray(userIntegrations.provider, ['salesforce', 'microsoft']))
  const sfIntegrationByUser = new Map<string, { updatedAt: Date; accountLabel: string | null }>()
  const outlookIntegrationByUser = new Map<string, { updatedAt: Date; accountLabel: string | null }>()
  for (const row of integrationRows) {
    const target = row.provider === 'salesforce' ? sfIntegrationByUser : row.provider === 'microsoft' ? outlookIntegrationByUser : null
    if (target) target.set(row.userId, { updatedAt: row.updatedAt, accountLabel: row.accountLabel })
  }
  const enriched = rows
    .filter((r) => isGlobalScope || (teamsByUser.get(r.id) ?? []).some((t) => accessibleTeamIds!.has(t)))
    .map((r) => {
      const codes = Array.isArray(r.mfaBackupCodesHash) ? r.mfaBackupCodesHash as unknown[] : []
      const { mfaBackupCodesHash: _hash, ...rest } = r
      const sfIntegration = sfIntegrationByUser.get(r.id)
      const outlookIntegration = outlookIntegrationByUser.get(r.id)
      return {
        ...rest,
        supportedTeamIds: teamsByUser.get(r.id) ?? [],
        teamRoles: rolesByUser.get(r.id) ?? {},
        backupCodesRemaining: codes.length,
        lastLoginAt: lastLoginByUser.get(r.id)?.toISOString() ?? null,
        sfConnected: !!sfIntegration,
        sfConnectedAt: sfIntegration?.updatedAt.toISOString() ?? null,
        sfAccountLabel: sfIntegration?.accountLabel ?? null,
        outlookConnected: !!outlookIntegration,
        outlookConnectedAt: outlookIntegration?.updatedAt.toISOString() ?? null,
        outlookAccountLabel: outlookIntegration?.accountLabel ?? null,
      }
    })
  res.json({ data: enriched, error: null, meta: {} })
})

// POST /api/admin/users/:userId/verify-connection — opt-in, one-user-at-a-time
// live probe. Never called automatically (see the roster route above, which
// only ever reads user_integrations locally) — this is the ONLY code path
// that makes a live Salesforce/Graph call on behalf of another user, and it
// only runs when an admin explicitly clicks Verify on that one row. Mirrors
// the exact probe each user already runs on themselves via
// /auth/salesforce/status and /auth/microsoft/status (My Settings' own
// "healthy" signal) — same jsforce identity() / Graph /me call, just
// triggerable by an admin against someone else's stored token.
usersAdminRoutes.post('/users/:userId/verify-connection', async (req, res) => {
  const { userId } = req.params as { userId: string }
  const schema = z.object({ provider: z.enum(['salesforce', 'microsoft']) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  if (!(await canManageUserAlignment(req.user!.id, userId))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const { provider } = parsed.data
  const [row] = await db
    .select({ id: userIntegrations.id, updatedAt: userIntegrations.updatedAt, accountLabel: userIntegrations.accountLabel })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, provider)))
    .limit(1)

  let healthy = false
  let error: string | null = null
  let accountLabel = row?.accountLabel ?? null
  if (row) {
    try {
      if (provider === 'salesforce') {
        const { getSfConnection } = await import('../../services/salesforce/client.js')
        const conn = await getSfConnection(userId)
        if (conn) {
          const identity = await conn.identity() as { username?: string; email?: string; preferred_username?: string }
          healthy = true
          accountLabel = accountLabel ?? identity.username ?? identity.preferred_username ?? identity.email ?? null
        }
      } else {
        const { getMicrosoftAccessToken } = await import('../../services/outlook/client.js')
        const token = await getMicrosoftAccessToken(userId)
        if (token) {
          const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', { headers: { Authorization: `Bearer ${token}` } })
          if (meRes.ok) {
            healthy = true
            const meData = await meRes.json() as { mail?: string; userPrincipalName?: string }
            accountLabel = accountLabel ?? meData.mail ?? meData.userPrincipalName ?? null
          } else {
            error = `Graph returned ${meRes.status}`
          }
        }
      }
    } catch (err) {
      healthy = false
      error = err instanceof Error ? err.message : String(err)
    }
  }

  await logAudit(req, {
    action: 'user.verify_connection',
    targetType: 'user',
    targetId: userId,
    meta: { provider, connected: !!row, healthy },
  })

  res.json({
    data: {
      connected: !!row,
      healthy,
      accountLabel,
      connectedAt: row?.updatedAt?.toISOString() ?? null,
      verifiedAt: new Date().toISOString(),
      error,
    },
    error: null,
    meta: {},
  })
})

// GET /api/admin/auth-policy — current Okta JIT policy.
usersAdminRoutes.get('/auth-policy', requireAppAdmin, (_req, res) => {
  res.json({ data: getAuthPolicy(), error: null, meta: {} })
})

// PUT /api/admin/auth-policy — toggle "require pre-created ImpactIQ user for Okta sign-in".
usersAdminRoutes.put('/auth-policy', requireAppAdmin, async (req, res) => {
  const schema = z.object({ requirePrecreatedUser: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await saveAuthPolicy(parsed.data)
  res.json({ data: parsed.data, error: null, meta: {} })
})

// --- Okta group → role mapping ---

usersAdminRoutes.get('/okta-group-mappings', requireAppAdmin, async (_req, res) => {
  const mappings = await db.select().from(oktaGroupRoleMappings).orderBy(oktaGroupRoleMappings.sortOrder)
  res.json({ data: { settings: getOktaGroupSettings(), mappings }, error: null, meta: {} })
})

usersAdminRoutes.put('/okta-group-mappings', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    settings: z.object({
      groupClaimName: z.string().min(1),
      defaultRole: z.enum(['contributor', 'leader', 'team_admin']),
      defaultTeamId: z.string().uuid().nullable(),
      requestGroupsScope: z.boolean().default(false),
    }),
    mappings: z.array(z.object({
      oktaGroup: z.string().min(1),
      role: z.enum(['contributor', 'leader', 'team_admin']),
      teamId: z.string().uuid().nullable(),
      sortOrder: z.number().int().default(0),
    })),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  await saveOktaGroupSettings(parsed.data.settings)
  await db.delete(oktaGroupRoleMappings)
  if (parsed.data.mappings.length > 0) {
    await db.insert(oktaGroupRoleMappings).values(parsed.data.mappings)
  }
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// --- Role permissions matrix ---

usersAdminRoutes.get('/role-permissions', requireAppAdmin, async (_req, res) => {
  const rows = await db.select().from(rolePermissions)
  res.json({ data: rows, error: null, meta: {} })
})

usersAdminRoutes.put('/role-permissions', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    permissions: z.array(z.object({
      role: z.enum(['contributor', 'leader', 'team_admin']),
      pageKey: z.string().min(1),
      hasAccess: z.boolean(),
    })),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Snapshot the matrix before we touch it — used to emit a structured
  // before/after diff for the audit log so admins can see exactly which
  // (role, page) flags moved.
  const beforeRows = await db.select().from(rolePermissions)
  const beforeMap = new Map<string, boolean>()
  for (const r of beforeRows) beforeMap.set(`${r.role}:${r.pageKey}`, r.hasAccess)
  const beforeDiff: Record<string, unknown> = {}
  const afterDiff: Record<string, unknown> = {}
  // The admin role is implicitly full-access and never persisted here, so
  // we just upsert every (role, pageKey) from the payload.
  for (const p of parsed.data.permissions) {
    const key = `${p.role}:${p.pageKey}`
    const prev = beforeMap.get(key)
    if (prev !== p.hasAccess) {
      beforeDiff[key] = prev ?? null
      afterDiff[key] = p.hasAccess
    }
    const existing = await db
      .select({ role: rolePermissions.role })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.role, p.role), eq(rolePermissions.pageKey, p.pageKey)))
      .limit(1)
    if (existing.length > 0) {
      await db.update(rolePermissions).set({ hasAccess: p.hasAccess })
        .where(and(eq(rolePermissions.role, p.role), eq(rolePermissions.pageKey, p.pageKey)))
    } else {
      await db.insert(rolePermissions).values(p)
    }
  }
  if (Object.keys(afterDiff).length > 0) {
    await logAudit(req, { action: 'role_permissions.update', targetType: 'role_permissions', targetId: null, meta: { before: beforeDiff, after: afterDiff } })
  }
  res.json({ data: { ok: true }, error: null, meta: {} })
})

usersAdminRoutes.post('/users', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    // v1.127.0: accept firstName + lastName as the primary name fields;
    // fall back to displayName if only that's provided so existing
    // client callers keep working during the rollout.
    displayName: z.string().min(1).optional(),
    firstName: z.string().min(1).max(120).optional(),
    lastName: z.string().min(1).max(120).optional(),
    // Password is optional only for Okta-only accounts; required otherwise.
    password: z.string().optional(),
    teamId: z.string().uuid().optional(),
    role: z.enum(['contributor', 'leader', 'team_admin', 'admin']).optional(),
    mustChangePassword: z.boolean().optional(),
    authMethod: z.enum(['password', 'okta', 'azure', 'both']).optional(),
    // Additional teams the user can switch to from the sidebar selector.
    supportedTeamIds: z.array(z.string().uuid()).optional(),
    // When true the user sees "All Teams" in the sidebar selector and
    // dashboards aggregate across every accessible team.
    canSeeAllTeams: z.boolean().optional(),
    // Work-week baseline — admin bypasses the approval queue.
    workerType: z.enum(['full_time', 'part_time', 'contractor']).optional(),
    workDays: z.number().int().min(0).max(127).optional(),
    workDayStartHour: z.number().int().min(0).max(23).optional(),
    workDayEndHour: z.number().int().min(1).max(24).optional(),
    // v1.115.0: opt-in to the welcome or invitation email at create
    // time. Invitation carries the initial password + force-change
    // flag; welcome is a lighter "you now have access" note.
    sendWelcome: z.boolean().optional(),
    sendInvitation: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  if (parsed.data.workerType || parsed.data.workDays !== undefined) {
    const { validateWorkWeek } = await import('../../../shared/schemas/workWeek.js')
    const err = validateWorkWeek({
      workerType: parsed.data.workerType ?? 'full_time',
      workDays: parsed.data.workDays ?? 31,
      workDayStartHour: parsed.data.workDayStartHour ?? 9,
      workDayEndHour: parsed.data.workDayEndHour ?? 18,
      workHoursPerDay: null,
    })
    if (err) { res.status(400).json({ data: null, error: err, meta: {} }); return }
  }

  const authMethod = parsed.data.authMethod ?? 'both'
  const needsPassword = authMethodNeedsPassword(authMethod)

  if (needsPassword) {
    if (!parsed.data.password || parsed.data.password.length < PASSWORD_MIN_LENGTH) {
      res.status(400).json({ data: null, error: `Password is required and must be at least ${PASSWORD_MIN_LENGTH} characters`, meta: {} })
      return
    }
    const complexity = validatePasswordComplexity(parsed.data.password)
    if (!complexity.ok) {
      res.status(400).json({
        data: null,
        error: `Password must satisfy: ${complexity.failedLabels.join(', ')}`,
        meta: {},
      })
      return
    }
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.email)).limit(1)
  if (existing) {
    res.status(409).json({ data: null, error: `User with email "${parsed.data.email}" already exists`, meta: {} })
    return
  }

  // v1.127.0: compose displayName from firstName + lastName when provided
  // (so downstream renderers keep working) — fall back to the legacy
  // displayName field if the client hasn't been updated yet.
  const composedDisplay =
    (parsed.data.firstName && parsed.data.lastName)
      ? `${parsed.data.firstName.trim()} ${parsed.data.lastName.trim()}`.trim()
      : parsed.data.displayName?.trim()
  if (!composedDisplay || composedDisplay.length === 0) {
    res.status(400).json({ data: null, error: 'errors.validation.name_required', meta: {} }); return
  }
  const [created] = await db.insert(users).values({
    oktaId: `local:${randomUUID()}`,
    email: parsed.data.email,
    displayName: composedDisplay,
    firstName: parsed.data.firstName?.trim() ?? null,
    lastName: parsed.data.lastName?.trim() ?? null,
    passwordHash: needsPassword && parsed.data.password ? hashPassword(parsed.data.password) : null,
    // v1.323.0: starts the 90-day expiry clock for a brand-new password-only
    // account. No reuse check here — there's no history yet for a new user.
    passwordChangedAt: needsPassword && parsed.data.password ? new Date() : null,
    mustChangePassword: needsPassword ? (parsed.data.mustChangePassword ?? true) : false,
    authMethod,
    defaultTeamId: parsed.data.teamId ?? null,
    canSeeAllTeams: parsed.data.canSeeAllTeams ?? false,
    workerType: parsed.data.workerType ?? 'full_time',
    workDays: parsed.data.workDays ?? 31,
    workDayStartHour: parsed.data.workDayStartHour ?? 9,
    workDayEndHour: parsed.data.workDayEndHour ?? 18,
    // v1.81.0: role='admin' on the User Management dropdown grants
    // full App Admin rights (parity with the primary Admin), so flip
    // is_app_admin at create time. See also PATCH .../role which syncs
    // this on subsequent role changes.
    isAppAdmin: parsed.data.role === 'admin',
  }).returning({ id: users.id, email: users.email, displayName: users.displayName })
  if (!created) { res.status(500).json({ data: null, error: 'errors.users.creation_failed', meta: {} }); return }

  if (parsed.data.teamId && parsed.data.role) {
    await db.insert(teamMembers).values({ teamId: parsed.data.teamId, userId: created.id, role: parsed.data.role })
  }

  // Supported teams: additional memberships for teams the user can switch to
  // in the sidebar selector. Default-team membership above stays as-is, and
  // we skip it if already created. Role on supported teams defaults to the
  // primary role (or contributor if none).
  const supportedRole = parsed.data.role && parsed.data.role !== 'admin' ? parsed.data.role : 'contributor'
  if (parsed.data.supportedTeamIds && parsed.data.supportedTeamIds.length > 0) {
    const additional = parsed.data.supportedTeamIds.filter((tid) => tid !== parsed.data.teamId)
    for (const tid of additional) {
      await db.insert(teamMembers).values({ teamId: tid, userId: created.id, role: supportedRole })
    }
  }

  await logAudit(req, { action: 'user.create', targetType: 'user', targetId: created.id, meta: { email: created.email, teamId: parsed.data.teamId, role: parsed.data.role } })

  // v1.115.0: welcome + invitation emails on user create. Best-effort
  // — email failures don't roll back the created user; the admin can
  // resend later from a follow-up flow (still TBD).
  if (parsed.data.sendWelcome || parsed.data.sendInvitation) {
    try {
      const { sendByRule } = await import('../../services/email/rule-sender.js')
      let teamName = ''
      if (parsed.data.teamId) {
        const [tm] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, parsed.data.teamId)).limit(1)
        teamName = tm?.name ?? ''
      }
      const loginUrl = (process.env['APP_URL'] ?? '').replace(/\/+$/, '') + '/login'
      const tokens = {
        name: created.displayName,
        teamName,
        loginUrl,
        tempPassword: parsed.data.password ?? '',
      }
      if (parsed.data.sendInvitation) {
        await sendByRule('invitation', {
          to: created.email,
          toName: created.displayName,
          defaultSubject: 'Your ImpactIQ account is ready',
          defaultBodyHtml: '<p>Hi {{name}},</p><p>An admin created an ImpactIQ account for you on the <b>{{teamName}}</b> team.</p><p><b>Sign in URL:</b> <a href="{{loginUrl}}">{{loginUrl}}</a><br><b>Temporary password:</b> <code>{{tempPassword}}</code></p><p>You\'ll be asked to change the password on your first sign-in.</p>',
          defaultBodyText: 'Hi {{name}},\n\nAn admin created an ImpactIQ account for you on the {{teamName}} team.\nSign in URL: {{loginUrl}}\nTemporary password: {{tempPassword}}\n\nYou\'ll be asked to change the password on your first sign-in.\n',
          tokens,
        })
      } else if (parsed.data.sendWelcome) {
        await sendByRule('welcome', {
          to: created.email,
          toName: created.displayName,
          defaultSubject: 'Welcome to ImpactIQ',
          defaultBodyHtml: '<p>Hi {{name}},</p><p>Welcome to ImpactIQ. You\'ve been added to the <b>{{teamName}}</b> team.</p><p><a href="{{loginUrl}}">Sign in to get started</a>.</p>',
          defaultBodyText: 'Hi {{name}},\n\nWelcome to ImpactIQ. You\'ve been added to the {{teamName}} team.\nSign in: {{loginUrl}}\n',
          tokens,
        })
      }
    } catch (err) {
      console.warn('[user.create] welcome/invitation email failed:', err instanceof Error ? err.message : err)
    }
  }

  res.status(201).json({ data: created, error: null, meta: {} })
})

// PATCH /api/admin/users/:userId — edit user identity + admin flags.
usersAdminRoutes.patch('/users/:userId', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  const schema = z.object({
    displayName: z.string().min(1).optional(),
    // v1.127.0: first / last name write-through. When both are set,
    // displayName is recomposed as `${firstName} ${lastName}` so any
    // downstream renderer that reads displayName stays in sync.
    firstName: z.string().min(1).max(120).optional(),
    lastName: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    isAppAdmin: z.boolean().optional(),
    canSeeAllTeams: z.boolean().optional(),
    isDefaultAdmin: z.boolean().optional(),
    authMethod: z.enum(['password', 'okta', 'azure', 'both']).optional(),
    defaultTeamId: z.string().uuid().nullable().optional(),
    supportedTeamIds: z.array(z.string().uuid()).optional(),
    mustChangePassword: z.boolean().optional(),
    workerType: z.enum(['full_time', 'part_time', 'contractor']).optional(),
    workDays: z.number().int().min(0).max(127).optional(),
    workDayStartHour: z.number().int().min(0).max(23).optional(),
    workDayEndHour: z.number().int().min(1).max(24).optional(),
    // Salesforce User Id to link this ImpactIQ user to a specific SF
    // User (drives "My Opps" filters via Assigned_SE__c / etc. and
    // OwnerId resolution on write-back). Nullable to unlink.
    crmUserId: z.string().min(3).max(50).nullable().optional(),
    sfUserName: z.string().max(200).nullable().optional(),
    // v1.76.0: admins can set a user's display currency. Kept in sync
    // with the user's own My Settings picker — both paths write to
    // users.preferred_currency. NULL = raw USD (default).
    preferredCurrency: z.string().length(3).nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }

  // Load the full pre-patch snapshot — used later to compute a diff so
  // the audit log only records fields that actually changed.
  const [target] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isAppAdmin: users.isAppAdmin,
      canSeeAllTeams: users.canSeeAllTeams,
      isDefaultAdmin: users.isDefaultAdmin,
      authMethod: users.authMethod,
      defaultTeamId: users.defaultTeamId,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!target) { res.status(404).json({ data: null, error: 'errors.user_not_found', meta: {} }); return }
  const priorSupportedTeamIds = new Set(
    (await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)))
      .map((r) => r.teamId),
  )

  // Default admin can't lose admin or default-admin status without first
  // promoting someone else.
  if (target.isDefaultAdmin && (parsed.data.isAppAdmin === false || parsed.data.isDefaultAdmin === false)) {
    res.status(400).json({ data: null, error: 'errors.cannot_change_default_admin', meta: {} })
    return
  }

  // Prevent removing the last app admin.
  if (parsed.data.isAppAdmin === false && target.isAppAdmin) {
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.isAppAdmin, true))
    if (admins.length <= 1) {
      res.status(400).json({ data: null, error: 'errors.cannot_remove_last_admin', meta: {} })
      return
    }
  }

  // Check email uniqueness on rename.
  if (parsed.data.email) {
    const [conflict] = await db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.email)).limit(1)
    if (conflict && conflict.id !== userId) {
      res.status(409).json({ data: null, error: `Another user already uses ${parsed.data.email}`, meta: {} })
      return
    }
  }

  // Promoting to default admin: must also be an app admin, and we clear the
  // flag on any prior default-admin so the "exactly one" invariant holds.
  const promoting = parsed.data.isDefaultAdmin === true && !target.isDefaultAdmin
  const updates: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() }
  if (promoting) {
    updates['isAppAdmin'] = true
    await db.update(users).set({ isDefaultAdmin: false, updatedAt: new Date() }).where(eq(users.isDefaultAdmin, true))
  }

  // v1.127.0: recompose displayName when firstName / lastName changed.
  // If only one is provided, splice with the existing value so the
  // full name still lines up.
  if (parsed.data.firstName !== undefined || parsed.data.lastName !== undefined) {
    const nextFirst = parsed.data.firstName?.trim() ?? (target as unknown as { firstName?: string | null }).firstName ?? ''
    const nextLast = parsed.data.lastName?.trim() ?? (target as unknown as { lastName?: string | null }).lastName ?? ''
    const composed = `${nextFirst} ${nextLast}`.trim()
    if (composed.length > 0) updates['displayName'] = composed
    if (parsed.data.firstName !== undefined) updates['firstName'] = parsed.data.firstName.trim()
    if (parsed.data.lastName !== undefined) updates['lastName'] = parsed.data.lastName.trim()
  }

  // supportedTeamIds isn't a column on users; strip before the UPDATE.
  const supportedTeamIds = parsed.data.supportedTeamIds
  delete (updates as Record<string, unknown>)['supportedTeamIds']

  // sfUserName isn't a column either — it lives in the crm_users cache
  // table. Upsert the cache row so subsequent user-list responses can
  // render the display name without another SF call.
  const sfUserName = parsed.data.sfUserName
  delete (updates as Record<string, unknown>)['sfUserName']
  if (parsed.data.crmUserId && sfUserName) {
    await db
      .insert(crmUsers)
      .values({ id: parsed.data.crmUserId, name: sfUserName, isActive: true })
      .onConflictDoUpdate({ target: crmUsers.id, set: { name: sfUserName, isActive: true, lastSyncedAt: new Date() } })
  }

  const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning({
    id: users.id, email: users.email, displayName: users.displayName, firstName: users.firstName, lastName: users.lastName, isAppAdmin: users.isAppAdmin, canSeeAllTeams: users.canSeeAllTeams, isDefaultAdmin: users.isDefaultAdmin, authMethod: users.authMethod, defaultTeamId: users.defaultTeamId, mustChangePassword: users.mustChangePassword,
  })

  // Sync supported team memberships if explicitly provided. We never touch
  // existing memberships if the field is omitted, so this stays additive
  // for older clients.
  if (supportedTeamIds) {
    const current = await db.select({ teamId: teamMembers.teamId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.userId, userId))
    const desired = new Set<string>(supportedTeamIds)
    const currentSet = new Set(current.map((r) => r.teamId))
    const supportedRole = current[0]?.role && current[0].role !== 'admin' ? current[0].role : 'contributor'
    for (const tid of desired) {
      if (!currentSet.has(tid)) {
        await db.insert(teamMembers).values({ teamId: tid, userId, role: supportedRole })
      }
    }
    for (const m of current) {
      if (!desired.has(m.teamId) && m.teamId !== parsed.data.defaultTeamId) {
        await db.delete(teamMembers).where(and(eq(teamMembers.teamId, m.teamId), eq(teamMembers.userId, userId)))
      }
    }
  }
  // Leaving a team (or moving the default team) also leaves that team's
  // subteams (v1.470.0).
  {
    const left = new Set(priorSupportedTeamIds)
    if (target.defaultTeamId) left.add(target.defaultTeamId)
    await pruneSubteamMembershipsForLeftTeams(userId, [...left])
  }

  // Diff — only log fields that actually changed. Structured before/after so
  // the Audit Log UI can render a proper diff table.
  const beforeDiff: Record<string, unknown> = {}
  const afterDiff: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed.data)) {
    if (k === 'currentPassword' || k === 'password') continue
    if (k === 'supportedTeamIds' && Array.isArray(v)) {
      const desired = new Set(v)
      const changed = desired.size !== priorSupportedTeamIds.size
        || v.some((tid) => !priorSupportedTeamIds.has(tid))
      if (changed) {
        beforeDiff[k] = Array.from(priorSupportedTeamIds)
        afterDiff[k] = v
      }
      continue
    }
    if ((target as Record<string, unknown>)[k] !== v) {
      beforeDiff[k] = (target as Record<string, unknown>)[k]
      afterDiff[k] = v
    }
  }
  await logAudit(req, { action: 'user.update', targetType: 'user', targetId: userId, meta: { before: beforeDiff, after: afterDiff } })
  res.json({ data: updated, error: null, meta: {} })
})

// POST /api/admin/users/:userId/reset-password — set a new password.
// Defaults to forcing change on next login.
usersAdminRoutes.post('/users/:userId/reset-password', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  const schema = z.object({
    password: z.string().min(PASSWORD_MIN_LENGTH),
    mustChangePassword: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const complexity = validatePasswordComplexity(parsed.data.password)
  if (!complexity.ok) {
    res.status(400).json({ data: null, error: `Password must satisfy: ${complexity.failedLabels.join(', ')}`, meta: {} })
    return
  }
  const { setUserPassword } = await import('../../services/auth/passwordPolicy.js')
  const result = await setUserPassword(userId, parsed.data.password, parsed.data.mustChangePassword ?? true)
  if (!result.ok) { res.status(400).json({ data: null, error: result.error, meta: {} }); return }
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// POST /api/admin/users/:userId/disable and /enable (v1.425.0, security
// audit L8). Disabling blocks every sign-in path and revokes the user's
// sessions and API keys; enabling restores sign-in only. App Admin only, like
// the other account-level actions here. Nobody can disable themselves or the
// default admin.
usersAdminRoutes.post('/users/:userId/disable', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  const { disableUser, isUserDisabled } = await import('../../services/auth/userStatus.js')
  const wasDisabled = await isUserDisabled(userId)
  const result = await disableUser(userId, req.user!.id)
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: {} }); return }
  if (!wasDisabled) {
    const { emitUserDisabled } = await import('../../services/webhooks/events.js')
    void emitUserDisabled({ userId, actorId: req.user!.id, sessionsRevoked: result.sessionsRevoked, apiKeysRevoked: result.apiKeysRevoked })
  }
  await logAudit(req, {
    action: 'user.disable',
    targetType: 'user',
    targetId: userId,
    meta: { sessionsRevoked: result.sessionsRevoked, apiKeysRevoked: result.apiKeysRevoked },
  })
  res.json({ data: { ok: true, sessionsRevoked: result.sessionsRevoked, apiKeysRevoked: result.apiKeysRevoked }, error: null, meta: {} })
})

usersAdminRoutes.post('/users/:userId/enable', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  const { enableUser } = await import('../../services/auth/userStatus.js')
  if (!(await enableUser(userId))) { res.status(404).json({ data: null, error: 'errors.users.not_found', meta: {} }); return }
  await logAudit(req, { action: 'user.enable', targetType: 'user', targetId: userId })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// POST /api/admin/users/:userId/reset-mfa — wipe the user's TOTP secret and
// backup codes so they re-enroll on next password login. Doesn't affect the
// current session; use POST /admin/sessions/:id to force a re-auth.
usersAdminRoutes.post('/users/:userId/reset-mfa', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  await db.update(users).set({
    totpSecretEncrypted: null,
    totpEnrolledAt: null,
    mfaBackupCodesHash: null,
    updatedAt: new Date(),
  }).where(eq(users.id, userId))
  await logAudit(req, { action: 'user.update', targetType: 'user.mfa_reset', targetId: userId })
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// GET /api/admin/users/:userId/notification-prefs — admin fetch of a user's
// digest prefs. App admin only for simplicity (parallels reset-password /
// reset-mfa which are also app-admin only).
usersAdminRoutes.get('/users/:userId/notification-prefs', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  const [row] = await db.select().from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, userId)).limit(1)
  res.json({
    data: row ?? { userId, emailEnabled: true, emailTransport: 'graph', timezone: 'UTC', lastDigestAt: null, weeklyRecapEnabled: true },
    error: null,
    meta: {},
  })
})

// PUT /api/admin/users/:userId/notification-prefs — admin flip of the two
// email digest flags on behalf of a user. Upserts and audit-logs the delta.
usersAdminRoutes.put('/users/:userId/notification-prefs', requireAppAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string }
  const schema = z.object({ emailEnabled: z.boolean(), weeklyRecapEnabled: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [existing] = await db.select().from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, userId)).limit(1)
  const before = { emailEnabled: existing?.emailEnabled ?? true, weeklyRecapEnabled: existing?.weeklyRecapEnabled ?? true }
  const after = { emailEnabled: parsed.data.emailEnabled, weeklyRecapEnabled: parsed.data.weeklyRecapEnabled }
  if (existing) {
    await db.update(userNotificationPrefs)
      .set({ emailEnabled: after.emailEnabled, weeklyRecapEnabled: after.weeklyRecapEnabled, updatedAt: new Date() })
      .where(eq(userNotificationPrefs.userId, userId))
  } else {
    await db.insert(userNotificationPrefs).values({
      userId,
      emailEnabled: after.emailEnabled,
      weeklyRecapEnabled: after.weeklyRecapEnabled,
    })
  }
  await logAudit(req, { action: 'user.update', targetType: 'user.notification_prefs', targetId: userId, meta: { before, after } })
  res.json({ data: { ok: true }, error: null, meta: {} })
})
