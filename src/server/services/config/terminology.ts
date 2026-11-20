import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/index.js'
import {
  activityTypeTeams, nudgeRuleTeams, nudgeRuleTranslations, nudgeRules, systemSettings, teamActivityTypes, teams,
} from '../../../../drizzle/schema.js'
import {
  DEFAULT_TERMINOLOGY, evalWorkTypeName, normalizeTerminology, replaceTypeName, type Terminology,
} from '../../../shared/terminology.js'

// Admin → Workplace → Terminology (src/shared/terminology.ts). Stored in
// system_settings like the other app-wide settings and cached briefly, since
// new-team defaults, the demo generator and the client all read it; a write
// from this process clears the cache, a restore or another instance's write
// shows up within the TTL.
const KEY_TERMINOLOGY = 'terminology'
const CACHE_TTL_MS = 30_000
let cache: { value: Terminology; at: number } | null = null

type DbLike = Pick<Db, 'select' | 'insert' | 'update'>

export async function getTerminology(dbx: DbLike = defaultDb): Promise<Terminology> {
  if (dbx === defaultDb && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const [row] = await dbx.select().from(systemSettings).where(eq(systemSettings.key, KEY_TERMINOLOGY)).limit(1)
    const value = normalizeTerminology(row?.value ?? DEFAULT_TERMINOLOGY)
    if (dbx === defaultDb) cache = { value, at: Date.now() }
    return value
  } catch {
    return DEFAULT_TERMINOLOGY
  }
}

export function clearTerminologyCache(): void {
  cache = null
}

export interface TerminologyRenamePlan {
  from: string
  to: string
  // Activity Types named `from` that would be renamed.
  types: Array<{ id: string; teamNames: string[] }>
  // Activity Types named `from` left alone because a type named `to` already
  // exists on one of their teams.
  conflicts: Array<{ id: string; teamNames: string[] }>
}

// Which Activity Types a change from `before` to `after` would rename. Only
// the exact old name matches: a type an admin already renamed is theirs.
export async function planTerminologyRename(before: Terminology, after: Terminology, dbx: DbLike = defaultDb): Promise<TerminologyRenamePlan> {
  const from = evalWorkTypeName(before)
  const to = evalWorkTypeName(after)
  const plan: TerminologyRenamePlan = { from, to, types: [], conflicts: [] }
  if (from === to) return plan

  const candidates = await dbx.select({ id: teamActivityTypes.id, teamId: teamActivityTypes.teamId })
    .from(teamActivityTypes).where(eq(teamActivityTypes.name, from))
  if (candidates.length === 0) return plan

  // Every team each candidate shows on: its own team plus junction teams.
  const ids = candidates.map((c) => c.id)
  const junction = await dbx.select({ typeId: activityTypeTeams.activityTypeId, teamId: activityTypeTeams.teamId })
    .from(activityTypeTeams).where(inArray(activityTypeTeams.activityTypeId, ids))
  const teamsByType = new Map<string, Set<string>>()
  for (const c of candidates) teamsByType.set(c.id, new Set(c.teamId ? [c.teamId] : []))
  for (const j of junction) teamsByType.get(j.typeId)?.add(j.teamId)
  const allTeamIds = [...new Set([...teamsByType.values()].flatMap((s) => [...s]))]

  // Teams that already see a type named `to` (case-insensitive, matching how
  // Activity Type import matches names).
  const taken = new Set<string>()
  if (allTeamIds.length > 0) {
    const own = await dbx.select({ teamId: teamActivityTypes.teamId }).from(teamActivityTypes)
      .where(and(sql`lower(${teamActivityTypes.name}) = lower(${to})`, inArray(teamActivityTypes.teamId, allTeamIds)))
    for (const r of own) if (r.teamId) taken.add(r.teamId)
    const shared = await dbx.select({ teamId: activityTypeTeams.teamId }).from(activityTypeTeams)
      .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, activityTypeTeams.activityTypeId))
      .where(and(sql`lower(${teamActivityTypes.name}) = lower(${to})`, inArray(activityTypeTeams.teamId, allTeamIds)))
    for (const r of shared) taken.add(r.teamId)
  }

  const names = allTeamIds.length > 0
    ? await dbx.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, allTeamIds))
    : []
  const teamName = new Map(names.map((n) => [n.id, n.name]))
  for (const c of candidates) {
    const teamIds = [...(teamsByType.get(c.id) ?? [])]
    const entry = { id: c.id, teamNames: teamIds.map((id) => teamName.get(id) ?? id).sort() }
    if (teamIds.some((id) => taken.has(id))) plan.conflicts.push(entry)
    else plan.types.push(entry)
  }
  return plan
}

export interface TerminologyRenameResult {
  typesRenamed: number
  typesSkipped: number
  picklistValuesKept: number
  nudgeRulesUpdated: number
  distinctionsUpdated: number
}

// Rewrites Activity Type name references inside a nudge rule's trigger config
// or AND/OR conditions (type / fromType / toType), at any depth.
function renameTypeRefs(value: unknown, from: string, to: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => { const r = renameTypeRefs(v, from, to); changed ||= r.changed; return r.value })
    return { value: out, changed }
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((k === 'type' || k === 'fromType' || k === 'toType') && v === from) { out[k] = to; changed = true; continue }
      const r = renameTypeRefs(v, from, to)
      out[k] = r.value
      changed ||= r.changed
    }
    return { value: out, changed }
  }
  return { value, changed: false }
}

// Saves the setting and, when `renameTypes` is set, renames the old
// "{term} Work" Activity Types to the new name in the same transaction:
//  - a type with no CRM picklist override gets the old name as its override,
//    so write-back keeps sending the value the CRM picklist already has;
//  - nudge rules on the renamed teams that name the old type (trigger config,
//    conditions) point at the new name, and their message text follows;
//  - Guide Distinctions on those teams have the old name replaced.
// Activities, templates, keyword rules and the historical import map point at
// the type by id, so they need nothing.
export async function saveTerminology(
  next: Terminology,
  opts: { renameTypes: boolean },
  dbx: Db = defaultDb,
): Promise<{ before: Terminology; after: Terminology; plan: TerminologyRenamePlan; result: TerminologyRenameResult }> {
  const out = await dbx.transaction(async (tx) => {
    const before = await getTerminology(tx)
    const after = normalizeTerminology(next)
    const plan = await planTerminologyRename(before, after, tx)
    const result: TerminologyRenameResult = { typesRenamed: 0, typesSkipped: plan.conflicts.length, picklistValuesKept: 0, nudgeRulesUpdated: 0, distinctionsUpdated: 0 }

    await tx.insert(systemSettings).values({ key: KEY_TERMINOLOGY, value: after })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: after, updatedAt: new Date() } })

    if (opts.renameTypes && plan.types.length > 0) {
      const ids = plan.types.map((t) => t.id)
      const kept = await tx.update(teamActivityTypes)
        .set({ crmPicklistValue: plan.from })
        .where(and(inArray(teamActivityTypes.id, ids), sql`coalesce(trim(${teamActivityTypes.crmPicklistValue}), '') = ''`))
        .returning({ id: teamActivityTypes.id })
      result.picklistValuesKept = kept.length
      const renamed = await tx.update(teamActivityTypes).set({ name: plan.to })
        .where(inArray(teamActivityTypes.id, ids)).returning({ id: teamActivityTypes.id, teamId: teamActivityTypes.teamId })
      result.typesRenamed = renamed.length

      const junction = await tx.select({ teamId: activityTypeTeams.teamId }).from(activityTypeTeams)
        .where(inArray(activityTypeTeams.activityTypeId, ids))
      const renamedTeams = [...new Set([...renamed.map((r) => r.teamId), ...junction.map((j) => j.teamId)].filter((x): x is string => !!x))]
      const conflictTeams = new Set<string>()
      if (plan.conflicts.length > 0) {
        const cIds = plan.conflicts.map((c) => c.id)
        const own = await tx.select({ teamId: teamActivityTypes.teamId }).from(teamActivityTypes).where(inArray(teamActivityTypes.id, cIds))
        const shared = await tx.select({ teamId: activityTypeTeams.teamId }).from(activityTypeTeams).where(inArray(activityTypeTeams.activityTypeId, cIds))
        for (const r of [...own, ...shared]) if (r.teamId) conflictTeams.add(r.teamId)
      }
      const safeTeams = renamedTeams.filter((id) => !conflictTeams.has(id))

      if (safeTeams.length > 0) {
        // Nudge rules assigned to a renamed team and to no team that kept the
        // old name.
        const ruleTeams = await tx.select({ ruleId: nudgeRuleTeams.nudgeRuleId, teamId: nudgeRuleTeams.teamId }).from(nudgeRuleTeams)
        const teamsByRule = new Map<string, string[]>()
        for (const r of ruleTeams) teamsByRule.set(r.ruleId, [...(teamsByRule.get(r.ruleId) ?? []), r.teamId])
        const ruleIds = [...teamsByRule.entries()]
          .filter(([, ts]) => ts.some((t) => safeTeams.includes(t)) && !ts.some((t) => conflictTeams.has(t)))
          .map(([id]) => id)
        if (ruleIds.length > 0) {
          const rules = await tx.select({ id: nudgeRules.id, triggerConfig: nudgeRules.triggerConfig, conditions: nudgeRules.conditions, messageTemplate: nudgeRules.messageTemplate })
            .from(nudgeRules).where(inArray(nudgeRules.id, ruleIds))
          for (const rule of rules) {
            const cfg = renameTypeRefs(rule.triggerConfig, plan.from, plan.to)
            const cond = renameTypeRefs(rule.conditions, plan.from, plan.to)
            if (!cfg.changed && !cond.changed) continue
            await tx.update(nudgeRules).set({
              triggerConfig: cfg.value as Record<string, unknown>,
              conditions: cond.value as Record<string, unknown> | null,
              messageTemplate: replaceTypeName(rule.messageTemplate, plan.from, plan.to),
            }).where(eq(nudgeRules.id, rule.id))
            const translations = await tx.select({ id: nudgeRuleTranslations.id, messageTemplate: nudgeRuleTranslations.messageTemplate })
              .from(nudgeRuleTranslations).where(eq(nudgeRuleTranslations.nudgeRuleId, rule.id))
            for (const tr of translations) {
              const text = replaceTypeName(tr.messageTemplate, plan.from, plan.to)
              if (text !== tr.messageTemplate) await tx.update(nudgeRuleTranslations).set({ messageTemplate: text }).where(eq(nudgeRuleTranslations.id, tr.id))
            }
            result.nudgeRulesUpdated++
          }
        }

        const teamRows = await tx.select({ id: teams.id, guideDistinctions: teams.guideDistinctions }).from(teams)
          .where(and(inArray(teams.id, safeTeams), ne(sql`coalesce(${teams.guideDistinctions}, '')`, '')))
        for (const team of teamRows) {
          const text = replaceTypeName(team.guideDistinctions ?? '', plan.from, plan.to)
          if (text === team.guideDistinctions) continue
          await tx.update(teams).set({ guideDistinctions: text }).where(eq(teams.id, team.id))
          result.distinctionsUpdated++
        }
      }
    }
    if (!opts.renameTypes) result.typesSkipped = 0
    return { before, after, plan, result }
  })
  cache = { value: out.after, at: Date.now() }
  return out
}
