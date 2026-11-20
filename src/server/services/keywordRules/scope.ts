// Keyword rule scope across teams (v1.468.0).
//
// A keyword rule is one row shared to any number of teams through
// keyword_rule_teams, but it points at ONE activity type id, and activity
// types are per team: "POx Work" on [Demo] Sales Engineering and "POx Work" on
// Solutions Engineering are different rows with different ids. Before this
// file, sharing a rule to a second team left that team with a rule whose type
// it couldn't see. The admin list showed the raw id, matchKeywords() silently
// skipped the rule, and the team's own rule for the same type stayed beside it.
//
// The rules here:
//  - A rule's type is resolved per team: the stored id when that team can see
//    it, else the team's type with the same name (case-insensitive).
//  - Saving a rule's scope refuses a team that has no type with that name.
//  - Saving a rule's scope replaces, in every other team in the scope, a rule
//    the saved one fully covers (same action and type, keywords a subset,
//    match field covered). Nothing is lost: every meeting the replaced rule
//    matched, the saved rule still matches with the same result. A rule that
//    isn't fully covered is left alone.
import { and, eq, inArray, ne, or } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { activityTypeTeams, keywordRules, keywordRuleTeams, teamActivityTypes, teams } from '../../../../drizzle/schema.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Db = typeof db | Tx

export interface VisibleType { id: string; name: string; isActive: boolean }

/** Every activity type a team can see: types it owns plus types shared to it. */
export async function typesVisibleToTeam(teamId: string, q: Db = db): Promise<VisibleType[]> {
  const rows = await q
    .selectDistinct({ id: teamActivityTypes.id, name: teamActivityTypes.name, isActive: teamActivityTypes.isActive })
    .from(teamActivityTypes)
    .leftJoin(activityTypeTeams, and(eq(activityTypeTeams.activityTypeId, teamActivityTypes.id), eq(activityTypeTeams.teamId, teamId)))
    .where(or(eq(teamActivityTypes.teamId, teamId), eq(activityTypeTeams.teamId, teamId)))
  return rows
}

/** Names of the given activity type ids, whatever team owns them. */
export async function typeNamesById(ids: string[], q: Db = db): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await q.select({ id: teamActivityTypes.id, name: teamActivityTypes.name }).from(teamActivityTypes).where(inArray(teamActivityTypes.id, unique))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/**
 * The type a rule suggests on one team: the stored id if the team can see it,
 * else the team's type with the same name. Null when the team has neither.
 */
export function resolveTypeForTeam(
  storedTypeId: string | null,
  storedTypeName: string | undefined,
  teamTypes: VisibleType[],
): VisibleType | null {
  if (!storedTypeId) return null
  const byId = teamTypes.find((t) => t.id === storedTypeId)
  if (byId) return byId
  if (!storedTypeName) return null
  const key = storedTypeName.trim().toLowerCase()
  return teamTypes.find((t) => t.name.trim().toLowerCase() === key) ?? null
}

const norm = (k: string) => k.trim().toLowerCase()

/** True when every keyword of `inner` is also a keyword of `outer`. */
export function keywordsCovered(inner: string[], outer: string[]): boolean {
  const set = new Set(outer.map(norm).filter(Boolean))
  return inner.map(norm).filter(Boolean).every((k) => set.has(k))
}

/** True when a rule matching `outer` reads at least the text `inner` reads. */
export function matchFieldCovered(inner: string, outer: string): boolean {
  return outer === 'both' || outer === inner
}

export interface ScopeTeamProblem { teamId: string; teamName: string }
export interface ReplacedRule { ruleId: string; teamId: string; teamName: string; deleted: boolean }

/**
 * Teams in `teamIds` that have no type matching the rule's type. A rule saved
 * to such a team would never fire there, so the route refuses the save.
 */
export async function teamsMissingRuleType(
  rule: { action: string; activityTypeId: string | null },
  teamIds: string[],
  q: Db = db,
): Promise<ScopeTeamProblem[]> {
  if (rule.action !== 'suggest_type' || !rule.activityTypeId || teamIds.length === 0) return []
  const names = await typeNamesById([rule.activityTypeId], q)
  const storedName = names.get(rule.activityTypeId)
  const missing: string[] = []
  for (const tid of teamIds) {
    const resolved = resolveTypeForTeam(rule.activityTypeId, storedName, await typesVisibleToTeam(tid, q))
    if (!resolved) missing.push(tid)
  }
  if (missing.length === 0) return []
  const teamRows = await q.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, missing))
  const nameById = new Map(teamRows.map((t) => [t.id, t.name]))
  return missing.map((id) => ({ teamId: id, teamName: nameById.get(id) ?? id }))
}

/**
 * Remove the saved rule's duplicates from each team in `teamIds` except
 * `editingTeamId` (the admin is looking at that team's list, so its rules are
 * theirs to judge). A duplicate is another active-or-not rule on that team
 * with the same action and type, whose keywords and match field the saved rule
 * covers. The team is taken off the duplicate; a duplicate left with no team
 * is deleted. Does nothing when the saved rule is inactive, since replacing an
 * active rule with an inactive one would turn the behavior off.
 */
export async function replaceCoveredRules(
  saved: { id: string; action: string; activityTypeId: string | null; keywords: string[]; matchField: string; isActive: boolean },
  teamIds: string[],
  editingTeamId: string,
  q: Db = db,
): Promise<ReplacedRule[]> {
  if (!saved.isActive) return []
  const targets = [...new Set(teamIds)].filter((t) => t !== editingTeamId)
  if (targets.length === 0) return []
  const savedName = saved.activityTypeId ? (await typeNamesById([saved.activityTypeId], q)).get(saved.activityTypeId) : undefined
  const teamRows = await q.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, targets))
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]))
  const replaced: ReplacedRule[] = []

  for (const tid of targets) {
    const others = await q
      .select({ rule: keywordRules })
      .from(keywordRules)
      .innerJoin(keywordRuleTeams, and(eq(keywordRuleTeams.keywordRuleId, keywordRules.id), eq(keywordRuleTeams.teamId, tid)))
      .where(and(ne(keywordRules.id, saved.id), eq(keywordRules.action, saved.action as 'suggest_type' | 'mark_non_activity')))
    if (others.length === 0) continue
    const teamTypes = await typesVisibleToTeam(tid, q)
    const savedType = resolveTypeForTeam(saved.activityTypeId, savedName, teamTypes)
    const otherNames = await typeNamesById(others.map((o) => o.rule.activityTypeId).filter((x): x is string => !!x), q)

    for (const { rule } of others) {
      if (saved.action === 'suggest_type') {
        const otherType = resolveTypeForTeam(rule.activityTypeId, rule.activityTypeId ? otherNames.get(rule.activityTypeId) : undefined, teamTypes)
        if (!savedType || !otherType || otherType.id !== savedType.id) continue
      }
      if (!keywordsCovered(rule.keywords, saved.keywords)) continue
      if (!matchFieldCovered(rule.matchField, saved.matchField)) continue

      await q.delete(keywordRuleTeams).where(and(eq(keywordRuleTeams.keywordRuleId, rule.id), eq(keywordRuleTeams.teamId, tid)))
      const [left] = await q.select({ id: keywordRuleTeams.keywordRuleId }).from(keywordRuleTeams).where(eq(keywordRuleTeams.keywordRuleId, rule.id)).limit(1)
      if (!left) await q.delete(keywordRules).where(eq(keywordRules.id, rule.id))
      replaced.push({ ruleId: rule.id, teamId: tid, teamName: teamName.get(tid) ?? tid, deleted: !left })
    }
  }
  return replaced
}

/**
 * Before a team is deleted: a rule created there but shared to other teams
 * moves to one of them instead of disappearing from them, and any rule that
 * points at one of the deleted team's types is re-pointed at the same-named
 * type its home team can see. A rule left with no team, or a type rule left
 * with no matching type, is deleted.
 */
export async function detachKeywordRulesFromTeam(teamId: string, q: Db): Promise<void> {
  const ownTypeIds = (await q.select({ id: teamActivityTypes.id }).from(teamActivityTypes).where(eq(teamActivityTypes.teamId, teamId))).map((r) => r.id)
  const affected = await q.select().from(keywordRules).where(
    ownTypeIds.length > 0 ? or(eq(keywordRules.teamId, teamId), inArray(keywordRules.activityTypeId, ownTypeIds)) : eq(keywordRules.teamId, teamId),
  )
  if (affected.length === 0) return
  const names = await typeNamesById(affected.map((r) => r.activityTypeId).filter((x): x is string => !!x), q)
  const ownTypes = new Set(ownTypeIds)

  for (const rule of affected) {
    const remaining = (await q.select({ teamId: keywordRuleTeams.teamId }).from(keywordRuleTeams)
      .where(and(eq(keywordRuleTeams.keywordRuleId, rule.id), ne(keywordRuleTeams.teamId, teamId)))).map((r) => r.teamId)
    const home = rule.teamId === teamId ? remaining[0] : rule.teamId
    if (!home) { await q.delete(keywordRules).where(eq(keywordRules.id, rule.id)); continue }
    let typeId = rule.activityTypeId
    if (typeId && ownTypes.has(typeId)) {
      const homeTypes = (await typesVisibleToTeam(home, q)).filter((t) => !ownTypes.has(t.id))
      typeId = resolveTypeForTeam(typeId, names.get(typeId), homeTypes)?.id ?? null
      if (!typeId && rule.action === 'suggest_type') { await q.delete(keywordRules).where(eq(keywordRules.id, rule.id)); continue }
    }
    await q.update(keywordRules).set({ teamId: home, activityTypeId: typeId }).where(eq(keywordRules.id, rule.id))
  }
}
