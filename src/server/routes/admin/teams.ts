import { Router } from 'express'
import { typeNamesById } from '../../services/keywordRules/scope.js'
import { db } from '../../db/index.js'
import {
  teams,
  teamActivityTypes,
  crmFieldMappings,
  crmFieldMappingTeams,
  sfEventTypeConfig,
  keywordRules,
  keywordRuleTeams,
  nudgeRules,
  nudgeRuleTeams,
  teamMembers,
  users,
} from '../../../../drizzle/schema.js'
import { and, eq, ne, inArray, ilike } from 'drizzle-orm'
import { requireAppAdmin, getAccessibleTeamIds } from '../../middleware/rbac.js'
import { logAudit } from '../../services/audit/log.js'
import { applyDefaultTeamConfig } from '../../services/teams/defaults.js'
import { deleteTeamCascade } from '../../services/teams/deleteTeam.js'
import { subteamMembershipsForUser, subteamOptionsForUser, disallowedSubteamIds } from '../../services/teams/userSubteams.js'
import { z } from 'zod'
import { changedFields } from '../../lib/records.js'
import { trimChar } from '../../lib/strings.js'

export const teamsAdminRoutes = Router()

function slugify(name: string): string {
  return trimChar(name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-'), '-')
    .slice(0, 64) || 'team'
}

// --- Teams ---
// v1.288.0: scoped to the caller's accessible teams (security audit finding
// B5). NOT locked to requireAppAdmin, unlike this resource's create/patch/
// delete routes — several Team-Admin-accessible config screens (Cost
// Groups, Capacity Groups, User Management, Holiday Calendars, Activity
// Templates) fetch this to populate their own team picker, so an
// app-admin-only gate would break those for every non-app-admin Team Admin.
// Scoping the result set (same pattern as GET /admin/users, B4) closes the
// leak without touching who can call the route.
teamsAdminRoutes.get('/teams', async (req, res) => {
  const accessibleTeamIds = await getAccessibleTeamIds(req.user!.id)
  const rows = await db.select().from(teams).where(inArray(teams.id, accessibleTeamIds)).orderBy(teams.name)
  res.json({ data: rows, error: null, meta: {} })
})

// Returns true if another team already uses `name` (case-insensitive, trimmed),
// optionally excluding a team id (for renames). Team names are meant to be
// unique — duplicate names produced silent bugs (e.g. two "Channel" teams, one
// empty, so the team switcher landed on the empty one and its config looked
// missing).
async function teamNameTaken(name: string, excludeId?: string): Promise<boolean> {
  const trimmed = name.trim()
  const [dup] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(
      ilike(teams.name, trimmed),
      excludeId ? ne(teams.id, excludeId) : undefined,
    ))
    .limit(1)
  return !!dup
}

teamsAdminRoutes.post('/teams', requireAppAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers, and dashes only').optional(),
    description: z.string().max(500).optional(),
    icon: z.string().max(64).optional(),
    defaultWorkerType: z.enum(['full_time', 'part_time', 'contractor']).optional(),
    defaultWorkDays: z.number().int().min(1).max(127).optional(),
    defaultWorkDayStartHour: z.number().int().min(0).max(23).optional(),
    defaultWorkDayEndHour: z.number().int().min(1).max(24).optional(),
    managerUserId: z.string().uuid().nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Team-level defaults are suggestions for a possibly mixed workforce, so we
  // only run base sanity checks — no full_time-specific 5-days/45-hours rule.
  const dStart = parsed.data.defaultWorkDayStartHour
  const dEnd = parsed.data.defaultWorkDayEndHour
  if (dStart !== undefined && dEnd !== undefined && dEnd <= dStart) {
    res.status(400).json({ data: null, error: 'errors.workweek.end_after_start', meta: {} }); return
  }

  const user = req.user!
  const slug = parsed.data.slug ?? slugify(parsed.data.name)

  if (await teamNameTaken(parsed.data.name)) {
    res.status(409).json({ data: null, error: 'errors.teams.duplicate_name', meta: {} })
    return
  }

  const [existing] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1)
  if (existing) {
    res.status(409).json({ data: null, error: `Slug "${slug}" already exists`, meta: {} })
    return
  }

  const [team] = await db
    .insert(teams)
    .values({
      name: parsed.data.name,
      slug,
      description: parsed.data.description,
      icon: parsed.data.icon,
      ...(parsed.data.defaultWorkerType !== undefined ? { defaultWorkerType: parsed.data.defaultWorkerType } : {}),
      ...(parsed.data.defaultWorkDays !== undefined ? { defaultWorkDays: parsed.data.defaultWorkDays } : {}),
      ...(parsed.data.defaultWorkDayStartHour !== undefined ? { defaultWorkDayStartHour: parsed.data.defaultWorkDayStartHour } : {}),
      ...(parsed.data.defaultWorkDayEndHour !== undefined ? { defaultWorkDayEndHour: parsed.data.defaultWorkDayEndHour } : {}),
      ...(parsed.data.managerUserId !== undefined ? { managerUserId: parsed.data.managerUserId } : {}),
    })
    .returning()
  if (!team) { res.status(500).json({ data: null, error: 'errors.teams.creation_failed', meta: {} }); return }

  // Seed default configuration so the team is usable immediately.
  await applyDefaultTeamConfig(db, team.id)

  // Grant the creating admin admin-role membership on the new team.
  await db.insert(teamMembers).values({ teamId: team.id, userId: user.id, role: 'admin' })

  await logAudit(req, { action: 'team.create', targetType: 'team', targetId: team.id, meta: { name: team.name, slug: team.slug } })
  res.status(201).json({ data: team, error: null, meta: {} })
})

teamsAdminRoutes.patch('/teams/:teamId', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    icon: z.string().max(64).optional(),
    isActive: z.boolean().optional(),
    defaultWorkerType: z.enum(['full_time', 'part_time', 'contractor']).optional(),
    defaultWorkDays: z.number().int().min(1).max(127).optional(),
    defaultWorkDayStartHour: z.number().int().min(0).max(23).optional(),
    defaultWorkDayEndHour: z.number().int().min(1).max(24).optional(),
    crmDepartments: z.array(z.string().min(1).max(200)).max(5).optional(),
    managerUserId: z.string().uuid().nullable().optional(),
    slackWebhookUrl: z
      .string()
      .url()
      .startsWith('https://hooks.slack.com/')
      .nullable()
      .optional()
      .or(z.literal('')),
    // v1.88.0: per-team active theme. null = inherit org-wide isActive.
    activeThemeId: z.string().uuid().nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Empty string → clear the webhook (UX: user pastes then blanks the input).
  if ((parsed.data as { slackWebhookUrl?: string | null }).slackWebhookUrl === '') {
    ;(parsed.data as { slackWebhookUrl?: string | null }).slackWebhookUrl = null
  }
  const dStart = parsed.data.defaultWorkDayStartHour
  const dEnd = parsed.data.defaultWorkDayEndHour
  if (dStart !== undefined && dEnd !== undefined && dEnd <= dStart) {
    res.status(400).json({ data: null, error: 'errors.workweek.end_after_start', meta: {} }); return
  }
  if (parsed.data.name !== undefined && await teamNameTaken(parsed.data.name, teamId)) {
    res.status(409).json({ data: null, error: 'errors.teams.duplicate_name', meta: {} }); return
  }
  // Only audit fields that actually changed — the client always POSTs the
  // full form, so a naive `meta: parsed.data` claims everything changed
  // even when the admin only edited one field.
  const [before] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1)
  const [updated] = await db.update(teams).set(parsed.data).where(eq(teams.id, teamId)).returning()
  const diff = changedFields(before, parsed.data)
  await logAudit(req, { action: 'team.update', targetType: 'team', targetId: teamId, meta: { before: diff.before, after: diff.after } })
  res.json({ data: updated, error: null, meta: {} })
})

// POST /api/admin/teams/:teamId/clone — deep-copy a team's *configuration*
// (activity types, SF mappings, picklist, keyword rules, nudge rules) into a
// new team. Users, memberships, integrations, and activities are NOT copied.
// Runs in a transaction so a partial clone can never leave orphan child rows.
teamsAdminRoutes.post('/teams/:teamId/clone', requireAppAdmin, async (req, res) => {
  const { teamId: sourceId } = req.params as { teamId: string }
  const schema = z.object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers, and dashes only').optional(),
    description: z.string().max(500).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [source] = await db.select().from(teams).where(eq(teams.id, sourceId)).limit(1)
  if (!source) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (await teamNameTaken(parsed.data.name)) {
    res.status(409).json({ data: null, error: 'errors.teams.duplicate_name', meta: {} }); return
  }
  const newSlug = parsed.data.slug ?? slugify(parsed.data.name)
  const [slugConflict] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, newSlug)).limit(1)
  if (slugConflict) { res.status(409).json({ data: null, error: `Slug "${newSlug}" already exists`, meta: {} }); return }

  const cloned = await db.transaction(async (tx) => {
    const [newTeam] = await tx.insert(teams).values({
      name: parsed.data.name,
      slug: newSlug,
      description: parsed.data.description ?? source.description,
      icon: source.icon,
      isActive: source.isActive,
    }).returning()
    if (!newTeam) throw new Error('team_insert_failed')

    // Activity types — remember the id map so keyword_rules can be remapped.
    const sourceTypes = await tx.select().from(teamActivityTypes).where(eq(teamActivityTypes.teamId, sourceId))
    const typeIdMap = new Map<string, string>()
    for (const t of sourceTypes) {
      const [inserted] = await tx.insert(teamActivityTypes).values({
        teamId: newTeam.id,
        name: t.name,
        crmObjectType: t.crmObjectType,
        isActive: t.isActive,
        sortOrder: t.sortOrder,
        color: t.color,
        icon: t.icon,
      }).returning({ id: teamActivityTypes.id })
      if (inserted) typeIdMap.set(t.id, inserted.id)
    }

    // SF field mappings — v1.298.0: same junction-sourced clone +
    // junction-row-per-copy fix as the Keyword/Nudge Rule clone above
    // (v1.297.0). crm_field_mappings has the identical team_id-column vs.
    // crm_field_mapping_teams-junction split; every real consumer
    // (writeback.ts, mappingValidation.ts) already reads via the junction,
    // so a mapping only junction-assigned to sourceId used to be silently
    // skipped by this clone, and copies never got a junction row at all
    // (invisible in the new team's own admin list, which is junction-backed).
    const mappings = (await tx
      .select({ m: crmFieldMappings })
      .from(crmFieldMappings)
      .innerJoin(crmFieldMappingTeams, and(eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id), eq(crmFieldMappingTeams.teamId, sourceId))))
      .map((r) => r.m)
    for (const m of mappings) {
      const [insertedMapping] = await tx.insert(crmFieldMappings).values({
        teamId: newTeam.id,
        appField: m.appField,
        crmFieldApi: m.crmFieldApi,
        crmObject: m.crmObject,
        isActive: m.isActive,
        constantValue: m.constantValue,
        updatedBy: req.user?.id ?? null,
        updatedAt: new Date(),
      }).returning()
      if (insertedMapping) {
        await tx.insert(crmFieldMappingTeams).values({ crmFieldMappingId: insertedMapping.id, teamId: newTeam.id })
      }
    }

    // SF picklist config
    const picklist = await tx.select().from(sfEventTypeConfig).where(eq(sfEventTypeConfig.teamId, sourceId))
    if (picklist.length > 0) {
      await tx.insert(sfEventTypeConfig).values(picklist.map((p) => ({
        teamId: newTeam.id,
        sfPicklistValue: p.sfPicklistValue,
        isActive: p.isActive,
        fallbackValue: p.fallbackValue,
        typicalDurationMinutes: p.typicalDurationMinutes,
      })))
    }

    // Keyword rules — remap activity_type_id via typeIdMap. A
    // mark_non_activity rule (v1.240.0) has no activityTypeId to remap and
    // clones through unchanged.
    // v1.297.0: source rules are resolved via the keyword_rule_teams
    // junction (same fix as classify.ts) since a rule assigned to sourceId
    // only via that table — not its own legacy teamId column — used to be
    // silently skipped by this clone. Every newly-inserted row ALSO gets a
    // junction row for newTeam.id, or it would clone through invisible to
    // the new team's own admin list (which itself reads via the junction).
    const kRules = (await tx
      .select({ rule: keywordRules })
      .from(keywordRules)
      .innerJoin(keywordRuleTeams, and(eq(keywordRuleTeams.keywordRuleId, keywordRules.id), eq(keywordRuleTeams.teamId, sourceId))))
      .map((r) => r.rule)
    for (const k of kRules) {
      // v1.468.0: a rule shared in from another team stores that team's
      // type id, so fall back to the copied type with the same name.
      let remapped = k.activityTypeId ? typeIdMap.get(k.activityTypeId) : null
      if (k.activityTypeId && !remapped) {
        const storedName = (await typeNamesById([k.activityTypeId], tx)).get(k.activityTypeId)?.trim().toLowerCase()
        const src = storedName ? sourceTypes.find((t) => t.name.trim().toLowerCase() === storedName) : undefined
        remapped = src ? typeIdMap.get(src.id) ?? null : null
      }
      if (k.action === 'suggest_type' && !remapped) continue
      const [insertedKeywordRule] = await tx.insert(keywordRules).values({
        teamId: newTeam.id,
        keywords: k.keywords,
        activityTypeId: remapped ?? null,
        matchField: k.matchField,
        priority: k.priority,
        isActive: k.isActive,
        action: k.action,
      }).returning()
      if (insertedKeywordRule) {
        await tx.insert(keywordRuleTeams).values({ keywordRuleId: insertedKeywordRule.id, teamId: newTeam.id })
      }
    }

    // Nudge rules — same junction-sourced clone + junction-row-per-copy
    // pattern as keyword rules above.
    const nRules = (await tx
      .select({ rule: nudgeRules })
      .from(nudgeRules)
      .innerJoin(nudgeRuleTeams, and(eq(nudgeRuleTeams.nudgeRuleId, nudgeRules.id), eq(nudgeRuleTeams.teamId, sourceId))))
      .map((r) => r.rule)
    for (const n of nRules) {
      const [insertedNudgeRule] = await tx.insert(nudgeRules).values({
        teamId: newTeam.id,
        name: n.name,
        triggerType: n.triggerType,
        triggerConfig: n.triggerConfig,
        messageTemplate: n.messageTemplate,
        isActive: n.isActive,
      }).returning()
      if (insertedNudgeRule) {
        await tx.insert(nudgeRuleTeams).values({ nudgeRuleId: insertedNudgeRule.id, teamId: newTeam.id })
      }
    }

    // Grant the cloning admin admin-role membership on the new team so they
    // can immediately open it.
    await tx.insert(teamMembers).values({ teamId: newTeam.id, userId: req.user!.id, role: 'admin' })

    return newTeam
  })

  await logAudit(req, {
    action: 'team.create',
    targetType: 'team',
    targetId: cloned.id,
    meta: { clonedFrom: sourceId, sourceName: source.name, name: cloned.name, slug: cloned.slug },
  })
  res.status(201).json({ data: cloned, error: null, meta: {} })
})

// GET /api/admin/teams/:teamId/subteams — list subteams on this team,
// each carrying its leaders + member counts. Rendered under the team's
// edit form so admins can add/remove without leaving the page.
// Max subteam nesting depth (top-level subteam = depth 1).
const MAX_SUBTEAM_DEPTH = 4

// Validate a proposed parent for a subteam within a team: parent must be in the
// same team, must not create a cycle (parent can't be the node itself or one of
// its descendants), and the resulting tree must not exceed MAX_SUBTEAM_DEPTH —
// accounting for the height of the moved subteam's own descendant subtree.
async function validateSubteamParent(
  teamId: string,
  targetId: string | null,
  parentId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!parentId) return { ok: true } // top-level, always fine
  const { subteams } = await import('../../../../drizzle/schema.js')
  const all = await db
    .select({ id: subteams.id, parentSubteamId: subteams.parentSubteamId })
    .from(subteams)
    .where(eq(subteams.teamId, teamId))
  const parentOf = new Map(all.map((s) => [s.id, s.parentSubteamId]))
  if (!parentOf.has(parentId)) return { ok: false, error: 'errors.subteams.cycle' } // not in team
  if (parentId === targetId) return { ok: false, error: 'errors.subteams.cycle' }
  // Walk parent's ancestor chain: detect cycles + count depth of the parent.
  const seen = new Set<string>()
  let cur: string | null = parentId
  let ancestors = 0
  while (cur) {
    if (cur === targetId) return { ok: false, error: 'errors.subteams.cycle' } // target is an ancestor of parent
    if (seen.has(cur)) break
    seen.add(cur)
    ancestors += 1
    cur = parentOf.get(cur) ?? null
  }
  const newDepth = ancestors + 1 // parent-chain length + the node itself
  // Height of the target's existing descendant subtree (0 for a leaf/new node).
  const childrenOf = new Map<string, string[]>()
  for (const s of all) {
    if (s.parentSubteamId) {
      const arr = childrenOf.get(s.parentSubteamId) ?? []
      arr.push(s.id)
      childrenOf.set(s.parentSubteamId, arr)
    }
  }
  const height = (id: string, guard = new Set<string>()): number => {
    if (guard.has(id)) return 0
    guard.add(id)
    const kids = childrenOf.get(id) ?? []
    return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => height(k, guard)))
  }
  const subtreeHeight = targetId ? height(targetId) : 0
  if (newDepth + subtreeHeight > MAX_SUBTEAM_DEPTH) return { ok: false, error: 'errors.subteams.depth_exceeded' }
  return { ok: true }
}

teamsAdminRoutes.get('/teams/:teamId/subteams', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const { subteams, subteamUsers } = await import('../../../../drizzle/schema.js')
  const rows = await db
    .select({ id: subteams.id, name: subteams.name, kind: subteams.kind, isActive: subteams.isActive, parentSubteamId: subteams.parentSubteamId })
    .from(subteams)
    .where(eq(subteams.teamId, teamId))
    .orderBy(subteams.name)
  if (rows.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
  // Depth per subteam (top-level = 1) by walking the parent chain.
  const parentOf = new Map(rows.map((r) => [r.id, r.parentSubteamId]))
  const depthOf = (id: string): number => {
    let d = 1
    let cur = parentOf.get(id) ?? null
    const guard = new Set<string>([id])
    while (cur && !guard.has(cur)) { d += 1; guard.add(cur); cur = parentOf.get(cur) ?? null }
    return d
  }
  const links = await db
    .select({ subteamId: subteamUsers.subteamId, userId: subteamUsers.userId, role: subteamUsers.role, name: users.displayName, email: users.email })
    .from(subteamUsers)
    .innerJoin(users, eq(users.id, subteamUsers.userId))
    .where(inArray(subteamUsers.subteamId, rows.map((r) => r.id)))
  const linksBy = new Map<string, { leaders: { userId: string; name: string; email: string }[]; members: { userId: string; name: string; email: string }[] }>()
  for (const r of rows) linksBy.set(r.id, { leaders: [], members: [] })
  for (const l of links) {
    const bucket = linksBy.get(l.subteamId)
    if (!bucket) continue
    if (l.role === 'leader') bucket.leaders.push({ userId: l.userId, name: l.name, email: l.email })
    else bucket.members.push({ userId: l.userId, name: l.name, email: l.email })
  }
  res.json({
    data: rows.map((r) => {
      const bucket = linksBy.get(r.id) ?? { leaders: [], members: [] }
      return { ...r, depth: depthOf(r.id), leaders: bucket.leaders, members: bucket.members, memberCount: bucket.members.length }
    }),
    error: null,
    meta: {},
  })
})

teamsAdminRoutes.post('/teams/:teamId/subteams', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({
    name: z.string().min(1).max(120),
    kind: z.enum(['region', 'type', 'leader', 'product', 'other']).nullable().optional(),
    parentSubteamId: z.string().uuid().nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const parentId = parsed.data.parentSubteamId ?? null
  const depthCheck = await validateSubteamParent(teamId, null, parentId)
  if (!depthCheck.ok) { res.status(400).json({ data: null, error: depthCheck.error, meta: {} }); return }
  const { subteams } = await import('../../../../drizzle/schema.js')
  try {
    const [row] = await db.insert(subteams).values({ teamId, name: parsed.data.name, kind: parsed.data.kind ?? null, parentSubteamId: parentId }).returning()
    await logAudit(req, { action: 'team.update', targetType: 'subteam', targetId: row!.id, meta: { teamId, name: row!.name } })
    res.status(201).json({ data: row, error: null, meta: {} })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/unique/i.test(msg)) { res.status(409).json({ data: null, error: 'errors.subteams.duplicate_name', meta: {} }); return }
    res.status(500).json({ data: null, error: msg, meta: {} })
  }
})

teamsAdminRoutes.patch('/teams/:teamId/subteams/:subteamId', requireAppAdmin, async (req, res) => {
  const { teamId, subteamId } = req.params as { teamId: string; subteamId: string }
  const schema = z.object({
    name: z.string().min(1).max(120).optional(),
    kind: z.enum(['region', 'type', 'leader', 'product', 'other']).nullable().optional(),
    isActive: z.boolean().optional(),
    parentSubteamId: z.string().uuid().nullable().optional(),
    leaderUserIds: z.array(z.string().uuid()).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { subteams, subteamUsers } = await import('../../../../drizzle/schema.js')
  // Security fix (F-03, pentest 2026-09): verify the subteam actually
  // belongs to :teamId before mutating it — the route's gate only checks
  // the caller's role, never that this resource is in the claimed team.
  const [owned] = await db.select({ id: subteams.id }).from(subteams).where(and(eq(subteams.id, subteamId), eq(subteams.teamId, teamId))).limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (parsed.data.parentSubteamId !== undefined) {
    const depthCheck = await validateSubteamParent(teamId, subteamId, parsed.data.parentSubteamId)
    if (!depthCheck.ok) { res.status(400).json({ data: null, error: depthCheck.error, meta: {} }); return }
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (parsed.data.name !== undefined) patch['name'] = parsed.data.name
  if (parsed.data.kind !== undefined) patch['kind'] = parsed.data.kind
  if (parsed.data.isActive !== undefined) patch['isActive'] = parsed.data.isActive
  if (parsed.data.parentSubteamId !== undefined) patch['parentSubteamId'] = parsed.data.parentSubteamId
  await db.update(subteams).set(patch).where(eq(subteams.id, subteamId))
  if (parsed.data.leaderUserIds !== undefined) {
    // Replace-in-place: drop existing leader rows and re-insert. Members
    // (role='member') are untouched.
    await db.delete(subteamUsers).where(and(eq(subteamUsers.subteamId, subteamId), eq(subteamUsers.role, 'leader')))
    if (parsed.data.leaderUserIds.length > 0) {
      await db.insert(subteamUsers).values(parsed.data.leaderUserIds.map((userId) => ({ subteamId, userId, role: 'leader' })))
    }
  }
  await logAudit(req, { action: 'team.update', targetType: 'subteam', targetId: subteamId, meta: parsed.data })
  res.json({ data: { id: subteamId }, error: null, meta: {} })
})

teamsAdminRoutes.delete('/teams/:teamId/subteams/:subteamId', requireAppAdmin, async (req, res) => {
  const { teamId, subteamId } = req.params as { teamId: string; subteamId: string }
  const { subteams } = await import('../../../../drizzle/schema.js')
  // Security fix (F-03, pentest 2026-09): verify ownership before deleting —
  // see the PATCH handler above for the full rationale.
  const [owned] = await db.select({ id: subteams.id }).from(subteams).where(and(eq(subteams.id, subteamId), eq(subteams.teamId, teamId))).limit(1)
  if (!owned) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  await db.delete(subteams).where(eq(subteams.id, subteamId))
  await logAudit(req, { action: 'team.delete', targetType: 'subteam', targetId: subteamId, meta: {} })
  res.json({ data: { id: subteamId }, error: null, meta: {} })
})

// GET /api/admin/users/:userId/subteams — subteams the user is a member
// of, each flagged `outsideTeams` when it sits on a team the user is no longer
// part of. PUT replaces the membership set.
teamsAdminRoutes.get('/users/:userId/subteams', requireAppAdmin, async (req, res) => {
  const userId = String(req.params['userId'] ?? '')
  res.json({ data: await subteamMembershipsForUser(userId), error: null, meta: {} })
})

// GET /api/admin/users/:userId/subteam-options — active subteams on the
// user's own teams (memberships plus default team): what the picker offers.
teamsAdminRoutes.get('/users/:userId/subteam-options', requireAppAdmin, async (req, res) => {
  const userId = String(req.params['userId'] ?? '')
  res.json({ data: await subteamOptionsForUser(userId), error: null, meta: {} })
})

teamsAdminRoutes.put('/users/:userId/subteams', requireAppAdmin, async (req, res) => {
  const userId = String(req.params['userId'] ?? '')
  // Cap at 4 subteams per user, matching the max subteam nesting depth.
  const schema = z.object({ subteamIds: z.array(z.string().uuid()).max(4, 'errors.subteams.user_limit') })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.message === 'errors.subteams.user_limit')
    res.status(400).json({ data: null, error: tooMany ? 'errors.subteams.user_limit' : parsed.error.message, meta: {} }); return
  }
  // A subteam belongs to one team: refuse one on a team the user isn't part of
  // (an existing stale assignment may be kept until an admin removes it).
  const disallowed = await disallowedSubteamIds(userId, parsed.data.subteamIds)
  if (disallowed.length > 0) {
    res.status(400).json({ data: null, error: 'errors.subteams.not_user_team', meta: { subteamIds: disallowed } }); return
  }
  const { subteamUsers } = await import('../../../../drizzle/schema.js')
  await db.delete(subteamUsers).where(and(eq(subteamUsers.userId, userId), eq(subteamUsers.role, 'member')))
  if (parsed.data.subteamIds.length > 0) {
    await db.insert(subteamUsers).values(parsed.data.subteamIds.map((subteamId) => ({ subteamId, userId, role: 'member' })))
  }
  await logAudit(req, { action: 'user.update', targetType: 'user.subteams', targetId: userId, meta: { count: parsed.data.subteamIds.length } })
  res.json({ data: { userId, count: parsed.data.subteamIds.length }, error: null, meta: {} })
})

teamsAdminRoutes.delete('/teams/:teamId', requireAppAdmin, async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const [existing] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }

  await deleteTeamCascade(teamId)
  await logAudit(req, { action: 'team.delete', targetType: 'team', targetId: teamId })
  res.json({ data: { id: teamId }, error: null, meta: {} })
})
