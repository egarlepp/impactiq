import { Router } from 'express'
import { db } from '../../db/index.js'
import {
  keywordRules,
  attachRateFields,
  keywordRuleTeams,
  nudgeRules,
  nudgeRuleTeams,
  teamMembers,
  activities,
  nudgeDismissals,
  users,
} from '../../../../drizzle/schema.js'
import { and, eq, inArray, sql, or, gte, isNull } from 'drizzle-orm'
import { requireRole, isAppAdmin, getAccessibleTeamIds } from '../../middleware/rbac.js'
import { typesVisibleToTeam, typeNamesById, resolveTypeForTeam, teamsMissingRuleType, replaceCoveredRules, type ReplacedRule } from '../../services/keywordRules/scope.js'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { startOfDay, subDays } from 'date-fns'

export const rulesRoutes = Router()

// --- Keyword Rules ---
rulesRoutes.get('/teams/:teamId/keyword-rules', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db
    .select({ rule: keywordRules })
    .from(keywordRules)
    .innerJoin(keywordRuleTeams, and(eq(keywordRuleTeams.keywordRuleId, keywordRules.id), eq(keywordRuleTeams.teamId, teamId)))
    .orderBy(keywordRules.priority)
  const ruleIds = rows.map((r) => r.rule.id)
  const assignments = ruleIds.length > 0 ? await db.select().from(keywordRuleTeams).where(inArray(keywordRuleTeams.keywordRuleId, ruleIds)) : []
  const teamIdsMap = assignments.reduce<Record<string, string[]>>((acc, a) => { ;(acc[a.keywordRuleId] ??= []).push(a.teamId); return acc }, {})
  // v1.468.0: a rule shared from another team stores THAT team's type id.
  // Resolve it to this team's type (by name when the id isn't visible here)
  // so the list shows "POx Work", not an id, and the edit form preselects it.
  const teamTypes = await typesVisibleToTeam(teamId)
  const storedNames = await typeNamesById(rows.map((r) => r.rule.activityTypeId).filter((x): x is string => !!x))
  res.json({
    data: rows.map((r) => {
      const resolved = resolveTypeForTeam(r.rule.activityTypeId, r.rule.activityTypeId ? storedNames.get(r.rule.activityTypeId) : undefined, teamTypes)
      return {
        ...r.rule,
        teamIds: teamIdsMap[r.rule.id] ?? [],
        teamActivityTypeId: resolved?.id ?? null,
        activityTypeName: resolved?.name ?? (r.rule.activityTypeId ? storedNames.get(r.rule.activityTypeId) ?? null : null),
      }
    }),
    error: null,
    meta: {},
  })
})

// v1.468.0: a Team Admin may only add or remove teams they can see. The
// editor only shows the scope picker to App Admins, but the route took any
// teamIds from any admin before this.
async function scopeChangeAllowed(userId: string, before: string[], after: string[]): Promise<boolean> {
  if (await isAppAdmin(userId)) return true
  const changed = [...after.filter((t) => !before.includes(t)), ...before.filter((t) => !after.includes(t))]
  if (changed.length === 0) return true
  const accessible = new Set(await getAccessibleTeamIds(userId))
  return changed.every((t) => accessible.has(t))
}

function sendMissingType(res: import('express').Response, missing: { teamId: string; teamName: string }[]): void {
  // 'errors.key|param=value' is how localizeError() takes parameters.
  const names = missing.map((m) => m.teamName.replace(/[|=]/g, ' ')).join(', ')
  res.status(400).json({ data: null, error: `errors.keyword_rules.type_missing_in_teams|teams=${names}`, meta: { teamIds: missing.map((m) => m.teamId) } })
}

rulesRoutes.post('/teams/:teamId/keyword-rules', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({
    keywords: z.array(z.string()),
    // v1.240.0: nullable — required for 'suggest_type', forced null for
    // 'mark_non_activity'. Cross-field validation below (Zod's own
    // .refine would fire before the mark_non_activity default is applied).
    activityTypeId: z.string().uuid().nullable().optional(),
    matchField: z.enum(['subject', 'body', 'both']),
    priority: z.number().int(),
    isActive: z.boolean().default(true),
    action: z.enum(['suggest_type', 'mark_non_activity']).default('suggest_type'),
    teamIds: z.array(z.string().uuid()).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamIds, action, activityTypeId, ...rest } = parsed.data
  if (action === 'suggest_type' && !activityTypeId) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }
  // mark_non_activity never carries a type, even if the client sent one —
  // that action doesn't suggest anything, so a stray id here would be dead
  // config nobody notices, exactly the failure mode CLAUDE.md §9's mapping
  // validator exists to catch in a different feature.
  const resolvedTypeId = action === 'mark_non_activity' ? null : (activityTypeId ?? null)
  const assignTeams = [...new Set(teamIds ?? [teamId])]
  if (!(await scopeChangeAllowed(req.user!.id, [teamId], assignTeams))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }
  const missing = await teamsMissingRuleType({ action, activityTypeId: resolvedTypeId }, assignTeams)
  if (missing.length > 0) { sendMissingType(res, missing); return }
  const result = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(keywordRules).values({ teamId, action, activityTypeId: resolvedTypeId, ...rest }).returning()
    if (!inserted) return null
    if (assignTeams.length > 0) await tx.insert(keywordRuleTeams).values(assignTeams.map((tid) => ({ keywordRuleId: inserted.id, teamId: tid }))).onConflictDoNothing()
    const replaced = await replaceCoveredRules(inserted, assignTeams, teamId, tx)
    return { inserted, replaced }
  })
  if (!result) { res.status(500).json({ data: null, error: 'errors.database.insert_failed', meta: {} }); return }
  res.status(201).json({ data: { ...result.inserted, teamIds: assignTeams }, error: null, meta: { replaced: result.replaced } })
})

// Security fix (F-03, pentest 2026-09), extracted for pglite testability
// (same convention as buildSfRecord()/validateOne()): a rule's "home"
// team_id (the base row's own column) is only where it was created — real,
// current team assignment lives in the keyword_rule_teams / nudge_rule_teams
// junction tables (CLAUDE.md §11 v1.297's fix for the SAME split, which
// evaluateNudges()/matchKeywords() already resolve correctly). Checking
// team_id alone would incorrectly 404 a rule that's validly multi-assigned
// to a different team via that junction — these helpers check both, exactly
// mirroring how the admin list routes already resolve "which team(s) does
// this rule belong to".
export async function isKeywordRuleVisibleToTeam(homeTeamId: string | null, ruleId: string, teamId: string): Promise<boolean> {
  if (homeTeamId === teamId) return true
  const [assigned] = await db.select({ id: keywordRuleTeams.keywordRuleId }).from(keywordRuleTeams)
    .where(and(eq(keywordRuleTeams.keywordRuleId, ruleId), eq(keywordRuleTeams.teamId, teamId))).limit(1)
  return !!assigned
}

export async function isNudgeRuleVisibleToTeam(homeTeamId: string | null, ruleId: string, teamId: string): Promise<boolean> {
  if (homeTeamId === teamId) return true
  const [assigned] = await db.select({ id: nudgeRuleTeams.nudgeRuleId }).from(nudgeRuleTeams)
    .where(and(eq(nudgeRuleTeams.nudgeRuleId, ruleId), eq(nudgeRuleTeams.teamId, teamId))).limit(1)
  return !!assigned
}

rulesRoutes.patch('/teams/:teamId/keyword-rules/:ruleId', requireRole('admin'), async (req, res) => {
  const { teamId, ruleId } = req.params as { teamId: string; ruleId: string }
  const schema = z.object({
    keywords: z.array(z.string()).optional(),
    activityTypeId: z.string().uuid().nullable().optional(),
    matchField: z.enum(['subject', 'body', 'both']).optional(),
    priority: z.number().int().optional(),
    isActive: z.boolean().optional(),
    action: z.enum(['suggest_type', 'mark_non_activity']).optional(),
    teamIds: z.array(z.string().uuid()).optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamIds, action, activityTypeId, ...rest } = parsed.data
  // Validate against the EFFECTIVE action/type — a patch that changes only
  // one of the two still has to leave the row in a valid state. Loads the
  // existing row rather than trusting the client to resend both fields.
  const [existing] = await db.select().from(keywordRules).where(eq(keywordRules.id, ruleId)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): verify the rule is actually
  // visible from :teamId before mutating it. A rule's "home" team_id is
  // only where it was created; real assignment lives in the
  // keyword_rule_teams junction — see isKeywordRuleVisibleToTeam() below.
  if (!(await isKeywordRuleVisibleToTeam(existing.teamId, ruleId, teamId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return
  }
  const effectiveAction = action ?? existing.action
  const effectiveTypeId = activityTypeId !== undefined ? activityTypeId : existing.activityTypeId
  if (effectiveAction === 'suggest_type' && !effectiveTypeId) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }
  const patch: Record<string, unknown> = { ...rest }
  if (action !== undefined) patch['action'] = action
  if (activityTypeId !== undefined || action !== undefined) {
    patch['activityTypeId'] = effectiveAction === 'mark_non_activity' ? null : effectiveTypeId
  }
  const currentTeams = (await db.select({ teamId: keywordRuleTeams.teamId }).from(keywordRuleTeams).where(eq(keywordRuleTeams.keywordRuleId, ruleId))).map((r) => r.teamId)
  const nextTeams = teamIds !== undefined ? [...new Set(teamIds)] : currentTeams
  if (!(await scopeChangeAllowed(req.user!.id, currentTeams, nextTeams))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }
  const nextTypeId = effectiveAction === 'mark_non_activity' ? null : (effectiveTypeId ?? null)
  // Only checked when the scope or the type changes, so a toggle of Active
  // on a rule that predates this check still saves.
  if (teamIds !== undefined || activityTypeId !== undefined || action !== undefined) {
    const missing = await teamsMissingRuleType({ action: effectiveAction, activityTypeId: nextTypeId }, nextTeams)
    if (missing.length > 0) { sendMissingType(res, missing); return }
  }
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx.update(keywordRules).set(patch).where(eq(keywordRules.id, ruleId)).returning()
    if (teamIds !== undefined) {
      await tx.delete(keywordRuleTeams).where(eq(keywordRuleTeams.keywordRuleId, ruleId))
      if (nextTeams.length > 0) await tx.insert(keywordRuleTeams).values(nextTeams.map((tid) => ({ keywordRuleId: ruleId, teamId: tid }))).onConflictDoNothing()
    }
    const replaced: ReplacedRule[] = updated ? await replaceCoveredRules(updated, nextTeams, teamId, tx) : []
    return { updated, replaced }
  })
  const assignments = await db.select().from(keywordRuleTeams).where(eq(keywordRuleTeams.keywordRuleId, ruleId))
  const teamTypes = await typesVisibleToTeam(teamId)
  const storedName = result.updated?.activityTypeId ? (await typeNamesById([result.updated.activityTypeId])).get(result.updated.activityTypeId) : undefined
  const resolved = resolveTypeForTeam(result.updated?.activityTypeId ?? null, storedName, teamTypes)
  res.json({
    data: { ...result.updated, teamIds: assignments.map((a) => a.teamId), teamActivityTypeId: resolved?.id ?? null, activityTypeName: resolved?.name ?? storedName ?? null },
    error: null,
    meta: { replaced: result.replaced },
  })
})

rulesRoutes.delete('/teams/:teamId/keyword-rules/:ruleId', requireRole('admin'), async (req, res) => {
  const { teamId, ruleId } = req.params as { teamId: string; ruleId: string }
  // Security fix (F-03, pentest 2026-09): see the PATCH handler above.
  const [existing] = await db.select({ teamId: keywordRules.teamId }).from(keywordRules).where(eq(keywordRules.id, ruleId)).limit(1)
  if (!existing) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (!(await isKeywordRuleVisibleToTeam(existing.teamId, ruleId, teamId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return
  }
  await db.delete(keywordRules).where(eq(keywordRules.id, ruleId))
  res.json({ data: { id: ruleId }, error: null, meta: {} })
})

// --- Attach Rate Fields ---
// v1.187.0: team-scoped config of which SF fields mark an Opportunity as
// having a Solutions Engineer attached (drives the Attach Rate dashboard).
rulesRoutes.get('/teams/:teamId/attach-rate-fields', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db.select().from(attachRateFields).where(eq(attachRateFields.teamId, teamId))
  res.json({ data: rows, error: null, meta: {} })
})

rulesRoutes.post('/teams/:teamId/attach-rate-fields', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({
    crmObject: z.string().min(1).max(80),
    // SF field API name / relationship path (e.g. Evaluation__r.Primary_Engineer__c).
    fieldApi: z.string().regex(/^[A-Za-z0-9_.]{1,80}$/),
    matchType: z.enum(['equals', 'includes']).default('equals'),
    resolveUsers: z.boolean().default(true),
    oppLinkField: z.string().regex(/^[A-Za-z0-9_]{1,80}$/).nullish(),
    roleLabel: z.string().max(60).nullish(),
    isActive: z.boolean().default(true),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [inserted] = await db.insert(attachRateFields).values({ teamId, ...parsed.data, oppLinkField: parsed.data.oppLinkField ?? null, roleLabel: parsed.data.roleLabel ?? null }).returning()
  res.status(201).json({ data: inserted, error: null, meta: {} })
})

rulesRoutes.patch('/teams/:teamId/attach-rate-fields/:fieldId', requireRole('admin'), async (req, res) => {
  const { teamId, fieldId } = req.params as { teamId: string; fieldId: string }
  const schema = z.object({
    crmObject: z.string().min(1).max(80).optional(),
    fieldApi: z.string().regex(/^[A-Za-z0-9_.]{1,80}$/).optional(),
    matchType: z.enum(['equals', 'includes']).optional(),
    resolveUsers: z.boolean().optional(),
    oppLinkField: z.string().regex(/^[A-Za-z0-9_]{1,80}$/).nullish(),
    roleLabel: z.string().max(60).nullish(),
    isActive: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): scope the update to a row that
  // actually belongs to :teamId — requireRole('admin') only checks the
  // caller's role on the claimed team, not that this resource is in it.
  const [updated] = await db.update(attachRateFields).set(parsed.data).where(and(eq(attachRateFields.id, fieldId), eq(attachRateFields.teamId, teamId))).returning()
  if (!updated) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: updated, error: null, meta: {} })
})

rulesRoutes.delete('/teams/:teamId/attach-rate-fields/:fieldId', requireRole('admin'), async (req, res) => {
  const { teamId, fieldId } = req.params as { teamId: string; fieldId: string }
  // Security fix (F-03, pentest 2026-09): see the PATCH handler above.
  const [deleted] = await db.delete(attachRateFields).where(and(eq(attachRateFields.id, fieldId), eq(attachRateFields.teamId, teamId))).returning()
  if (!deleted) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: { id: fieldId }, error: null, meta: {} })
})

// --- Nudge Rules ---
rulesRoutes.get('/teams/:teamId/nudge-rules', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const rows = await db
    .select({ rule: nudgeRules })
    .from(nudgeRules)
    .innerJoin(nudgeRuleTeams, and(eq(nudgeRuleTeams.nudgeRuleId, nudgeRules.id), eq(nudgeRuleTeams.teamId, teamId)))
  const ruleIds = rows.map((r) => r.rule.id)
  const assignments = ruleIds.length > 0 ? await db.select().from(nudgeRuleTeams).where(inArray(nudgeRuleTeams.nudgeRuleId, ruleIds)) : []
  const teamIdsMap = assignments.reduce<Record<string, string[]>>((acc, a) => { ;(acc[a.nudgeRuleId] ??= []).push(a.teamId); return acc }, {})
  res.json({ data: rows.map((r) => ({ ...r.rule, teamIds: teamIdsMap[r.rule.id] ?? [] })), error: null, meta: {} })
})

rulesRoutes.post('/teams/:teamId/nudge-rules', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  const schema = z.object({
    name: z.string().min(1),
    triggerType: z.enum(['no_activity_days', 'stage_no_type', 'type_no_followup', 'weekly_hours_below_target', 'sf_sync_failed', 'opportunity_stale', 'product_gap']),
    triggerConfig: z.record(z.string(), z.unknown()),
    messageTemplate: z.string().min(1),
    isActive: z.boolean().default(true),
    teamIds: z.array(z.string().uuid()).optional(),
    severity: z.enum(['info', 'warning', 'critical']).default('info'),
    icon: z.string().nullable().optional(),
    cooldownHours: z.number().int().min(0).nullable().optional(),
    conditions: z.object({
      op: z.enum(['AND', 'OR']),
      clauses: z.array(z.object({
        triggerType: z.string(),
        config: z.record(z.string(), z.unknown()).default({}),
      })).min(1).max(6),
    }).nullable().optional(),
    leaderRollupThreshold: z.number().int().min(1).max(1000).nullable().optional(),
    sendEmail: z.boolean().optional(),
    sendSlackDm: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamIds, ...rest } = parsed.data
  const [inserted] = await db.insert(nudgeRules).values({ teamId, ...rest }).returning()
  if (!inserted) { res.status(500).json({ data: null, error: 'errors.database.insert_failed', meta: {} }); return }
  const assignTeams = teamIds ?? [teamId]
  await db.insert(nudgeRuleTeams).values(assignTeams.map((tid) => ({ nudgeRuleId: inserted.id, teamId: tid }))).onConflictDoNothing()
  res.status(201).json({ data: { ...inserted, teamIds: assignTeams }, error: null, meta: {} })
})

rulesRoutes.patch('/teams/:teamId/nudge-rules/:ruleId', requireRole('admin'), async (req, res) => {
  const { teamId, ruleId } = req.params as { teamId: string; ruleId: string }
  const schema = z.object({
    name: z.string().min(1).optional(),
    messageTemplate: z.string().optional(),
    triggerType: z.enum(['no_activity_days', 'stage_no_type', 'type_no_followup', 'weekly_hours_below_target', 'sf_sync_failed', 'opportunity_stale', 'product_gap']).optional(),
    triggerConfig: z.record(z.string(), z.unknown()).optional(),
    isActive: z.boolean().optional(),
    teamIds: z.array(z.string().uuid()).optional(),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
    icon: z.string().nullable().optional(),
    cooldownHours: z.number().int().min(0).nullable().optional(),
    conditions: z.object({
      op: z.enum(['AND', 'OR']),
      clauses: z.array(z.object({
        triggerType: z.string(),
        config: z.record(z.string(), z.unknown()).default({}),
      })).min(1).max(6),
    }).nullable().optional(),
    leaderRollupThreshold: z.number().int().min(1).max(1000).nullable().optional(),
    sendEmail: z.boolean().optional(),
    sendSlackDm: z.boolean().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): verify the rule is actually
  // visible from :teamId before mutating it — same team_id-vs-junction
  // split as keyword rules (CLAUDE.md §11 v1.297): a rule's "home" team_id
  // is only where it was created, real assignment lives in the
  // nudge_rule_teams junction, so both are checked.
  const [existingRule] = await db.select({ teamId: nudgeRules.teamId }).from(nudgeRules).where(eq(nudgeRules.id, ruleId)).limit(1)
  if (!existingRule) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (!(await isNudgeRuleVisibleToTeam(existingRule.teamId, ruleId, teamId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return
  }
  const { teamIds, ...rest } = parsed.data
  const [updated] = await db.update(nudgeRules).set(rest).where(eq(nudgeRules.id, ruleId)).returning()
  if (teamIds !== undefined) {
    await db.delete(nudgeRuleTeams).where(eq(nudgeRuleTeams.nudgeRuleId, ruleId))
    if (teamIds.length > 0) await db.insert(nudgeRuleTeams).values(teamIds.map((tid) => ({ nudgeRuleId: ruleId, teamId: tid }))).onConflictDoNothing()
  }
  const assignments = await db.select().from(nudgeRuleTeams).where(eq(nudgeRuleTeams.nudgeRuleId, ruleId))
  res.json({ data: { ...updated, teamIds: assignments.map((a) => a.teamId) }, error: null, meta: {} })
})

rulesRoutes.delete('/teams/:teamId/nudge-rules/:ruleId', requireRole('admin'), async (req, res) => {
  const { teamId, ruleId } = req.params as { teamId: string; ruleId: string }
  // Security fix (F-03, pentest 2026-09): see the PATCH handler above.
  const [existingRule] = await db.select({ teamId: nudgeRules.teamId }).from(nudgeRules).where(eq(nudgeRules.id, ruleId)).limit(1)
  if (!existingRule) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (!(await isNudgeRuleVisibleToTeam(existingRule.teamId, ruleId, teamId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return
  }
  await db.delete(nudgeRules).where(eq(nudgeRules.id, ruleId))
  res.json({ data: { id: ruleId }, error: null, meta: {} })
})

// v1.125.0: per-locale message overrides for a nudge rule. Admin picks
// a language from a dropdown, types the localized copy, and saves —
// the server upserts a row into nudge_rule_translations. When absent,
// the caller falls back to the rule's base messageTemplate.
rulesRoutes.get('/teams/:teamId/nudge-rules/:ruleId/translations', requireRole('admin'), async (req, res) => {
  const { ruleId } = req.params as { ruleId: string }
  const { nudgeRuleTranslations } = await import('../../../../drizzle/schema.js')
  const rows = await db.select().from(nudgeRuleTranslations).where(eq(nudgeRuleTranslations.nudgeRuleId, ruleId))
  res.json({ data: rows, error: null, meta: {} })
})

rulesRoutes.put('/teams/:teamId/nudge-rules/:ruleId/translations/:locale', requireRole('admin'), async (req, res) => {
  const { teamId, ruleId, locale } = req.params as { teamId: string; ruleId: string; locale: string }
  const schema = z.object({ messageTemplate: z.string().min(1).max(2000) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): verify the rule this translation
  // belongs to is actually visible from :teamId — same check as the rule's
  // own PATCH/DELETE handlers above.
  const [existingRule] = await db.select({ teamId: nudgeRules.teamId }).from(nudgeRules).where(eq(nudgeRules.id, ruleId)).limit(1)
  if (!existingRule) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (!(await isNudgeRuleVisibleToTeam(existingRule.teamId, ruleId, teamId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return
  }
  const { nudgeRuleTranslations } = await import('../../../../drizzle/schema.js')
  const [existing] = await db.select().from(nudgeRuleTranslations)
    .where(and(eq(nudgeRuleTranslations.nudgeRuleId, ruleId), eq(nudgeRuleTranslations.locale, locale)))
    .limit(1)
  if (existing) {
    await db.update(nudgeRuleTranslations).set({ messageTemplate: parsed.data.messageTemplate, updatedAt: new Date() }).where(eq(nudgeRuleTranslations.id, existing.id))
  } else {
    await db.insert(nudgeRuleTranslations).values({ nudgeRuleId: ruleId, locale, messageTemplate: parsed.data.messageTemplate })
  }
  res.json({ data: { ok: true }, error: null, meta: {} })
})

rulesRoutes.delete('/teams/:teamId/nudge-rules/:ruleId/translations/:locale', requireRole('admin'), async (req, res) => {
  const { teamId, ruleId, locale } = req.params as { teamId: string; ruleId: string; locale: string }
  // Security fix (F-03, pentest 2026-09): see the PUT handler above.
  const [existingRule] = await db.select({ teamId: nudgeRules.teamId }).from(nudgeRules).where(eq(nudgeRules.id, ruleId)).limit(1)
  if (!existingRule) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (!(await isNudgeRuleVisibleToTeam(existingRule.teamId, ruleId, teamId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return
  }
  const { nudgeRuleTranslations } = await import('../../../../drizzle/schema.js')
  await db.delete(nudgeRuleTranslations)
    .where(and(eq(nudgeRuleTranslations.nudgeRuleId, ruleId), eq(nudgeRuleTranslations.locale, locale)))
  res.json({ data: { ok: true }, error: null, meta: {} })
})

// v1.64.0: dry-run preview — evaluate this rule against every member of
// the team RIGHT NOW and return the users who would receive the nudge.
// Read-only; nothing is written to notifications or audit. Used by the
// "Preview" button on the Admin Nudge Rules row so the admin can gut-check
// a change before enabling it.
rulesRoutes.get('/teams/:teamId/nudge-rules/:ruleId/preview', requireRole('admin'), async (req, res) => {
  const { teamId, ruleId } = req.params as { teamId: string; ruleId: string }
  const { evaluateNudges } = await import('../../services/nudge/engine.js')
  const [rule] = await db.select({
    triggerType: nudgeRules.triggerType,
    isActive: nudgeRules.isActive,
    triggerConfig: nudgeRules.triggerConfig,
    leaderRollupThreshold: nudgeRules.leaderRollupThreshold,
    cooldownHours: nudgeRules.cooldownHours,
    conditions: nudgeRules.conditions,
  }).from(nudgeRules).where(eq(nudgeRules.id, ruleId)).limit(1)
  // v1.306.0: the per-member dismissal pill (v1.305) came back blank for
  // every sampled member — ruling out a stale snooze/close-out as the cause
  // of a "0 of N" that's uniform across members with provably-true
  // recentCount. A per-member cause can't explain a SYMMETRIC 0-for-everyone
  // result; only a rule-level gate can. leaderRollupThreshold is the one
  // gate that's rule-wide, not per-user: when non-null, evaluateNudges()
  // skips the entire per-user emission path for EVERY member unconditionally
  // (engine.ts line 234) — the rule then only ever fires as a single
  // aggregated nudge to a leader once enough distinct users have been
  // nudged with this trigger type via nudge_events in the last 7 days,
  // which can never happen if the per-user path that WRITES those events
  // never runs in the first place. Surfaced as ground truth (the raw column
  // value, not an inference from the admin form) exactly like
  // ruleEligibleForTeam — so "is this rule secretly configured as a leader
  // rollup" stops being something the admin has to eyeball a form field for.
  const isLeaderRollupRule = rule?.leaderRollupThreshold != null
  const hasConditions = !!(rule?.conditions && typeof rule.conditions === 'object' && Array.isArray((rule.conditions as { clauses?: unknown[] }).clauses) && ((rule.conditions as { clauses: unknown[] }).clauses.length > 0))
  // v1.303.0: the literal same junction join evaluateNudges() uses to decide
  // whether this rule is even a candidate for this team — surfaced directly
  // rather than inferred, so "0 of N match" can be told apart from "this
  // rule was never in the candidate set for this team at all" (isActive
  // false, or no nudge_rule_teams row for this team) without reading code.
  const [junctionCheck] = await db
    .select({ ok: sql<boolean>`true` })
    .from(nudgeRuleTeams)
    .where(and(eq(nudgeRuleTeams.nudgeRuleId, ruleId), eq(nudgeRuleTeams.teamId, teamId)))
    .limit(1)
  const ruleEligibleForTeam = !!junctionCheck && !!rule?.isActive
  const members = await db
    .select({ userId: teamMembers.userId, name: users.displayName, email: users.email })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
  const hits: Array<{ userId: string; name: string; email: string; message: string }> = []
  // Cap the fanout so a huge team can't OOM the API — 200 users is the
  // largest tenant we've seen; anything beyond that gets a "sampled" flag
  // in meta so the UI can warn.
  const CAP = 200
  const sample = members.slice(0, CAP)
  let errorCount = 0
  for (const m of sample) {
    try {
      const nudges = await evaluateNudges(m.userId, teamId)
      const hit = nudges.find((n) => n.ruleId === ruleId)
      if (hit) hits.push({ userId: m.userId, name: m.name, email: m.email, message: hit.message })
    } catch (err) {
      errorCount++
      console.warn('[nudge-preview] evaluate failed for', m.userId, err instanceof Error ? err.message : String(err))
    }
  }
  // v1.291.0: evaluateNudges silently excludes any member with an active
  // dismissal (a snooze that hasn't expired, or a permanent close-out) for
  // this exact rule — which from the admin's side looks identical to "this
  // member genuinely doesn't match right now." A Preview showing 0 hits was
  // indistinguishable from a broken rule when it was really N members who'd
  // already snoozed/closed it out during earlier testing. Surface that
  // count (and evaluate errors, previously only console.warn'd) separately
  // so the admin can tell the difference at a glance.
  const sampleIds = sample.map((m) => m.userId)
  const now = new Date()
  const dismissedRows = sampleIds.length > 0
    ? await db.select({ userId: nudgeDismissals.userId, expiresAt: nudgeDismissals.expiresAt }).from(nudgeDismissals)
        .where(and(
          eq(nudgeDismissals.nudgeRuleId, ruleId),
          inArray(nudgeDismissals.userId, sampleIds),
          or(isNull(nudgeDismissals.expiresAt), gte(nudgeDismissals.expiresAt, now)),
        ))
    : []
  const dismissedCount = new Set(dismissedRows.map((r) => r.userId)).size
  // v1.305.0: per-member dismissal state, keyed by user, for the same rule.
  // The aggregate dismissedCount above already exists but only renders when
  // >0 as a single "N members have this snoozed/closed out" note — it can't
  // tell the admin WHICH members, so a member whose recentCount independently
  // proves the trigger condition true but who ALSO has an active dismissal
  // here reads, from the note alone, identically to "genuinely 0 matches."
  // null value = an active dismissal with no expiry (permanent close-out);
  // an ISO string = snoozed until that timestamp; absent from the map =
  // not dismissed at all right now.
  const dismissedUntilByUser = new Map<string, string | null>(
    dismissedRows.map((r) => [r.userId, r.expiresAt ? new Date(r.expiresAt).toISOString() : null]),
  )
  // v1.295.0: no_activity_days is the trigger that generates the most "why
  // is this showing 0" confusion, because whether it matches depends on a
  // number (days since the user's own most recent activities row) nobody
  // can see anywhere else in the UI. Rather than tell the admin to trust the
  // logic, hand back the actual number per sampled member so they can verify
  // it themselves — this is the one piece of ground truth that actually
  // settles "is this a bug or is it my data."
  let activityDiagnostics: Array<{ userId: string; name: string; lastActivityAt: string | null; recentCount?: number; dismissed?: 'permanent' | 'snoozed' | null; dismissedUntil?: string | null }> | undefined
  if (rule?.triggerType === 'no_activity_days' && sampleIds.length > 0) {
    const rows = await db
      .select({ userId: activities.userId, lastAt: sql<Date | null>`max(${activities.createdAt})` })
      .from(activities)
      .where(and(eq(activities.teamId, teamId), inArray(activities.userId, sampleIds)))
      .groupBy(activities.userId)
    const lastAtByUser = new Map(rows.map((r) => [r.userId, r.lastAt ? new Date(r.lastAt).toISOString() : null]))
    // v1.304.0: the "smoking gun" query — run the EXACT same count(*) query
    // no_activity_days itself runs per user (same table, same columns, same
    // gte(createdAt, since) comparison), grouped in one round trip instead
    // of one query per user. If this ever disagrees with lastActivityAt
    // above (e.g. a "38 days ago" member showing a non-zero recentCount),
    // that's proof the discrepancy is a live-query anomaly, not the trigger
    // logic — every hypothesis about the logic itself has been individually
    // ruled out already (dismissals, cooldown, AND/OR conditions, the
    // day-comparison direction, team eligibility).
    const days = Number((rule.triggerConfig as Record<string, unknown> | null)?.['days'] ?? 5)
    const since = startOfDay(subDays(now, days))
    const recentRows = await db
      .select({ userId: activities.userId, n: sql<number>`count(*)` })
      .from(activities)
      .where(and(eq(activities.teamId, teamId), inArray(activities.userId, sampleIds), gte(activities.createdAt, since)))
      .groupBy(activities.userId)
    const recentCountByUser = new Map(recentRows.map((r) => [r.userId, Number(r.n)]))
    activityDiagnostics = sample.map((m) => {
      const hasDismissal = dismissedUntilByUser.has(m.userId)
      const until = dismissedUntilByUser.get(m.userId) ?? null
      return {
        userId: m.userId,
        name: m.name,
        lastActivityAt: lastAtByUser.get(m.userId) ?? null,
        recentCount: recentCountByUser.get(m.userId) ?? 0,
        dismissed: hasDismissal ? (until === null ? 'permanent' : 'snoozed') : null,
        dismissedUntil: until,
      }
    })
  }
  res.json({
    data: hits,
    error: null,
    meta: { evaluated: sample.length, total: members.length, sampled: members.length > CAP, dismissedCount, errorCount, activityDiagnostics, ruleEligibleForTeam, isLeaderRollupRule, leaderRollupThreshold: rule?.leaderRollupThreshold ?? null, hasConditions, cooldownHours: rule?.cooldownHours ?? null },
  })
})

// v1.309.0: admin visibility into who has snoozed/permanently closed out
// which nudge rules — until now the only place a dismissal was ever
// surfaced to an admin was the Preview modal's per-member pill above
// (sampled, one rule at a time, no clear action). Team-scoped the same way
// Preview is (nudge_dismissals has no team_id column — resolve the team's
// member ids via team_members first, then filter dismissals by userId IN
// (...), never a direct column filter), and requireRole('admin') matches
// every other nudge-rules route rather than the tenant-wide requireAppAdmin
// NudgeHistory uses, since "why isn't so-and-so getting this nudge" is a
// team-admin's day-to-day debugging task, not a cross-tenant audit.
rulesRoutes.get('/teams/:teamId/nudge-dismissals', requireRole('admin'), async (req, res) => {
  const { teamId } = req.params as { teamId: string }
  // v1.324.0: the merged Nudge History page's "most snoozed" KPI cards need
  // the FULL historical set of snooze rows (an already-expired snooze is
  // still evidence someone snoozed it), not just what's currently active —
  // opt-in via ?includeExpired=true so the Dismissals tab's own "what's live
  // right now" behavior is unchanged by default.
  const includeExpired = req.query['includeExpired'] === 'true'
  const members = await db
    .select({ userId: teamMembers.userId, name: users.displayName, email: users.email })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
  const memberIds = members.map((m) => m.userId)
  if (memberIds.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
  const nameByUserId = new Map(members.map((m) => [m.userId, { name: m.name, email: m.email }]))

  const now = new Date()
  const rows = await db
    .select({
      id: nudgeDismissals.id,
      userId: nudgeDismissals.userId,
      nudgeRuleId: nudgeDismissals.nudgeRuleId,
      dismissedAt: nudgeDismissals.dismissedAt,
      expiresAt: nudgeDismissals.expiresAt,
      triggerType: nudgeRules.triggerType,
      ruleName: nudgeRules.name,
      messageTemplate: nudgeRules.messageTemplate,
    })
    .from(nudgeDismissals)
    .innerJoin(nudgeRules, eq(nudgeRules.id, nudgeDismissals.nudgeRuleId))
    .where(includeExpired
      ? inArray(nudgeDismissals.userId, memberIds)
      : and(
        inArray(nudgeDismissals.userId, memberIds),
        or(isNull(nudgeDismissals.expiresAt), gte(nudgeDismissals.expiresAt, now)),
      ))
    .orderBy(desc(nudgeDismissals.dismissedAt))

  // A user can accumulate multiple dismissal rows against the same rule
  // over time (no unique constraint, no upsert on insert — see
  // dismissals.ts) — evaluateNudges() folds all of them into a Set, so the
  // "current state" for a (user, rule) pair is just "the most recent still-
  // active row," collapsed here the same way. Skipped when includeExpired:
  // the KPI callers want every historical snooze counted, not just the
  // current state per pair.
  const dedupedRows = includeExpired ? rows : (() => {
    const latestByPair = new Map<string, typeof rows[number]>()
    for (const r of rows) {
      const key = `${r.userId}:${r.nudgeRuleId}`
      const existing = latestByPair.get(key)
      if (!existing || r.dismissedAt > existing.dismissedAt) latestByPair.set(key, r)
    }
    return Array.from(latestByPair.values())
  })()

  const data = dedupedRows.map((r) => {
    const member = nameByUserId.get(r.userId)
    return {
      userId: r.userId,
      userName: member?.name ?? null,
      userEmail: member?.email ?? null,
      nudgeRuleId: r.nudgeRuleId,
      triggerType: r.triggerType,
      ruleName: r.ruleName,
      messageTemplate: r.messageTemplate,
      dismissed: r.expiresAt === null ? 'permanent' as const : 'snoozed' as const,
      dismissedAt: r.dismissedAt.toISOString(),
      dismissedUntil: r.expiresAt ? r.expiresAt.toISOString() : null,
    }
  })
  res.json({ data, error: null, meta: {} })
})

// Clears EVERY dismissal row for this (user, rule) pair — not just the
// latest — since a stale earlier row would otherwise still suppress the
// rule for that user even after "clearing" the one the admin saw.
rulesRoutes.delete('/teams/:teamId/nudge-dismissals/:userId/:ruleId', requireRole('admin'), async (req, res) => {
  const { teamId, userId, ruleId } = req.params as { teamId: string; userId: string; ruleId: string }
  const [membership] = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1)
  if (!membership) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  // Security fix (F-03, pentest 2026-09): userId was already checked
  // against :teamId above, but ruleId never was — a team_admin could clear
  // a same-team member's dismissal of a rule belonging to a different team.
  const [existingRule] = await db.select({ teamId: nudgeRules.teamId }).from(nudgeRules).where(eq(nudgeRules.id, ruleId)).limit(1)
  if (!existingRule) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  if (!(await isNudgeRuleVisibleToTeam(existingRule.teamId, ruleId, teamId))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return
  }
  await db.delete(nudgeDismissals).where(and(eq(nudgeDismissals.userId, userId), eq(nudgeDismissals.nudgeRuleId, ruleId)))
  res.json({ data: { userId, nudgeRuleId: ruleId }, error: null, meta: {} })
})
