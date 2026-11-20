import { Router } from 'express'
import { db } from '../../db/index.js'
import { teams, teamMembers, users } from '../../../../drizzle/schema.js'
import { and, eq, inArray, sql, or, ilike } from 'drizzle-orm'
import { crmUsers, crmUserAlignments } from '../../../../drizzle/schema.js'
import { runSfUserSync } from '../../services/salesforce/users.js'
import { requireAppAdmin, getAccessibleTeamIds, isAppAdmin } from '../../middleware/rbac.js'
import { loadSubteamAttribution, UNASSIGNED_SUBTEAM_ID } from '../../services/dashboards/subteamAttribution.js'
import { logAudit } from '../../services/audit/log.js'
import { z } from 'zod'

export const alignmentRoutes = Router()

// ─── Sales Team Alignment (SF users cache + per-user manager/owner picks) ──
//
// v1.320.0: opened up to team_admin (previously requireAppAdmin on every
// route here, so only App Admins could ever use this page at all). The
// adminRouter-level requireGlobalAdmin (line ~107) already lets any
// admin/team_admin in — the two routes below that touch a SPECIFIC user's
// alignment additionally verify the target shares an accessible team with
// the caller, since requireGlobalAdmin alone only proves "is an admin
// SOMEWHERE", not "of THIS user's team". /salesforce/sync-users stays
// App-Admin-only: it's a tenant-wide write via the shared admin SF
// connection, same convention as every other org-wide refresh action.
export async function canManageUserAlignment(callerUserId: string, targetUserId: string): Promise<boolean> {
  if (await isAppAdmin(callerUserId)) return true
  const accessible = await getAccessibleTeamIds(callerUserId)
  if (accessible.length === 0) return false
  const [row] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, targetUserId), inArray(teamMembers.teamId, accessible)))
    .limit(1)
  return !!row
}

// Refresh crm_users from Salesforce via the admin (org-wide) SF connection.
// On HubSpot the same button refreshes HubSpot owners, which also fills
// crm_users (phase 7b), so Sales Team Alignment works on either CRM.
alignmentRoutes.post('/salesforce/sync-users', requireAppAdmin, async (req, res) => {
  try {
    const { getCrmProviderId } = await import('../../services/crm/providerSetting.js')
    if ((await getCrmProviderId()) === 'hubspot') {
      const { runHubspotOwnerSync } = await import('../../services/hubspot/owners.js')
      const result = await runHubspotOwnerSync({ source: 'manual' })
      if (!result) { res.status(409).json({ data: null, error: 'errors.hubspot.not_configured', meta: {} }); return }
      const upserted = result.active + result.archived
      await logAudit(req, { action: 'sf_users.sync', targetType: 'sf_users', meta: { upserted, provider: 'hubspot' } })
      res.json({ data: { upserted: result.active }, error: null, meta: {} })
      return
    }
    // v1.437.0: through runSfUserSync so a manual sync shows on Scheduling,
    // as the HubSpot branch above already does.
    const result = await runSfUserSync({ source: 'manual' })
    if (!result) throw new Error('errors.salesforce.admin_connection_missing')
    const { upserted } = result
    await logAudit(req, {
      action: 'sf_users.sync',
      targetType: 'sf_users',
      meta: { upserted },
    })
    res.json({ data: { upserted }, error: null, meta: {} })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ data: null, error: msg, meta: {} })
  }
})

// v1.320.0: Team -> Subteam grouped roster for the Sales Team Alignment page,
// replacing the page's old "fetch every visible user, then N parallel
// /sf-alignment calls" pattern with one query. `teamId` query param picks a
// single team (must be in the caller's accessible set) or 'all'/omitted for
// every team the caller can see. Grouped by each user's DEFAULT team (same
// convention as User Management's "group by Default Team" view, v1.318) —
// not every team_members row they hold — so a user appears exactly once.
alignmentRoutes.get('/sales-team-alignment/roster', async (req, res) => {
  const accessibleTeamIds = await getAccessibleTeamIds(req.user!.id)
  const requestedTeamId = typeof req.query['teamId'] === 'string' && req.query['teamId'] && req.query['teamId'] !== 'all'
    ? req.query['teamId']
    : null
  if (requestedTeamId && !accessibleTeamIds.includes(requestedTeamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const scopeTeamIds = requestedTeamId ? [requestedTeamId] : accessibleTeamIds
  if (scopeTeamIds.length === 0) {
    res.json({ data: [], error: null, meta: {} })
    return
  }

  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, scopeTeamIds))
  const teamNameById = new Map(teamRows.map((t) => [t.id, t.name]))

  const usersInScope = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email, defaultTeamId: users.defaultTeamId })
    .from(users)
    .where(inArray(users.defaultTeamId, scopeTeamIds))
    .orderBy(users.displayName)

  const attribution = await loadSubteamAttribution(scopeTeamIds)
  const subteamNameById = new Map<string, string>([[UNASSIGNED_SUBTEAM_ID, 'Unassigned']])
  for (const s of attribution.activeSubteams) subteamNameById.set(s.id, s.name)

  const alignmentCounts = usersInScope.length === 0 ? [] : await db
    .select({ userId: crmUserAlignments.userId, role: crmUserAlignments.role, n: sql<number>`count(*)` })
    .from(crmUserAlignments)
    .where(inArray(crmUserAlignments.userId, usersInScope.map((u) => u.id)))
    .groupBy(crmUserAlignments.userId, crmUserAlignments.role)
  const countsByUser = new Map<string, { managerCount: number; ownerCount: number }>()
  for (const r of alignmentCounts) {
    const cur = countsByUser.get(r.userId) ?? { managerCount: 0, ownerCount: 0 }
    if (r.role === 'manager') cur.managerCount = Number(r.n)
    else if (r.role === 'owner') cur.ownerCount = Number(r.n)
    countsByUser.set(r.userId, cur)
  }

  const rows = usersInScope.map((u) => {
    const teamId = u.defaultTeamId!
    const best = attribution.bestSubteamOf(u.id, teamId)
    const subteamId = best?.id ?? UNASSIGNED_SUBTEAM_ID
    const counts = countsByUser.get(u.id) ?? { managerCount: 0, ownerCount: 0 }
    return {
      teamId,
      teamName: teamNameById.get(teamId) ?? teamId,
      subteamId,
      subteamName: subteamNameById.get(subteamId) ?? subteamId,
      userId: u.id,
      displayName: u.displayName,
      email: u.email,
      managerCount: counts.managerCount,
      ownerCount: counts.ownerCount,
    }
  })
  res.json({ data: rows, error: null, meta: {} })
})

// Substring search across crm_users.name / email, limit 50, ordered by name.
// crm_users holds both CRMs' people (phase 7b), so only the active CRM's are
// listed: HubSpot owners have numeric ids, Salesforce users don't.
alignmentRoutes.get('/sf-users', async (req, res) => {
  const q = String(req.query['q'] ?? '').trim()
  const limit = Math.min(50, Math.max(1, Number(req.query['limit'] ?? 50)))
  const { getCrmProviderId } = await import('../../services/crm/providerSetting.js')
  const { HUBSPOT_OWNER_ROW_RX } = await import('../../services/hubspot/owners.js')
  const crmRows = (await getCrmProviderId()) === 'hubspot'
    ? sql`${crmUsers.id} ~ ${HUBSPOT_OWNER_ROW_RX}`
    : sql`${crmUsers.id} !~ ${HUBSPOT_OWNER_ROW_RX}`
  const rows = await db
    .select({ id: crmUsers.id, name: crmUsers.name, email: crmUsers.email, managerId: crmUsers.managerId, isActive: crmUsers.isActive })
    .from(crmUsers)
    .where(and(
      eq(crmUsers.isActive, true),
      crmRows,
      q.length > 0 ? or(ilike(crmUsers.name, `%${q}%`), ilike(crmUsers.email, `%${q}%`)) : undefined,
    ))
    .orderBy(crmUsers.name)
    .limit(limit)
  // Return most-recent lastSyncedAt as meta so client can show "cached as of X".
  const [latest] = await db
    .select({ lastSyncedAt: sql<Date>`max(${crmUsers.lastSyncedAt})` })
    .from(crmUsers)
    .where(crmRows)
  res.json({ data: rows, error: null, meta: { lastSyncedAt: latest?.lastSyncedAt ?? null } })
})

// Load current alignment for one ImpactIQ user (managers + owners).
alignmentRoutes.get('/users/:userId/sf-alignment', async (req, res) => {
  const { userId } = req.params as { userId: string }
  if (!(await canManageUserAlignment(req.user!.id, userId))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const rows = await db
    .select({ crmUserId: crmUserAlignments.crmUserId, role: crmUserAlignments.role })
    .from(crmUserAlignments)
    .where(eq(crmUserAlignments.userId, userId))
  const managerIds = rows.filter((r) => r.role === 'manager').map((r) => r.crmUserId)
  const ownerIds = rows.filter((r) => r.role === 'owner').map((r) => r.crmUserId)
  const allIds = Array.from(new Set([...managerIds, ...ownerIds]))
  const resolved = allIds.length === 0 ? [] : await db
    .select({ id: crmUsers.id, name: crmUsers.name, email: crmUsers.email, managerId: crmUsers.managerId })
    .from(crmUsers)
    .where(inArray(crmUsers.id, allIds))
  res.json({ data: { managerIds, ownerIds, crmUsers: resolved }, error: null, meta: {} })
})

// PUT the full pair of arrays; diff against DB, delete+insert as needed.
alignmentRoutes.put('/users/:userId/sf-alignment', async (req, res) => {
  const { userId } = req.params as { userId: string }
  if (!(await canManageUserAlignment(req.user!.id, userId))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const schema = z.object({
    managerIds: z.array(z.string().min(1)).default([]),
    ownerIds: z.array(z.string().min(1)).default([]),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { managerIds, ownerIds } = parsed.data

  const before = await db
    .select({ crmUserId: crmUserAlignments.crmUserId, role: crmUserAlignments.role })
    .from(crmUserAlignments)
    .where(eq(crmUserAlignments.userId, userId))

  const targetKeys = new Set<string>([
    ...managerIds.map((id) => `manager::${id}`),
    ...ownerIds.map((id) => `owner::${id}`),
  ])
  const currentKeys = new Set<string>(before.map((r) => `${r.role}::${r.crmUserId}`))

  const toInsert: { userId: string; crmUserId: string; role: 'manager' | 'owner'; createdBy: string | null }[] = []
  for (const k of targetKeys) {
    if (currentKeys.has(k)) continue
    const [role, crmUserId] = k.split('::') as ['manager' | 'owner', string]
    toInsert.push({ userId, crmUserId, role, createdBy: req.user?.id ?? null })
  }
  const toDelete = before.filter((r) => !targetKeys.has(`${r.role}::${r.crmUserId}`))

  await db.transaction(async (tx) => {
    for (const d of toDelete) {
      await tx.delete(crmUserAlignments).where(and(
        eq(crmUserAlignments.userId, userId),
        eq(crmUserAlignments.crmUserId, d.crmUserId),
        eq(crmUserAlignments.role, d.role),
      ))
    }
    if (toInsert.length > 0) {
      await tx.insert(crmUserAlignments).values(toInsert)
    }
  })

  await logAudit(req, {
    action: 'sf_alignment.update',
    targetType: 'user',
    targetId: userId,
    meta: {
      before: {
        managerIds: before.filter((r) => r.role === 'manager').map((r) => r.crmUserId),
        ownerIds: before.filter((r) => r.role === 'owner').map((r) => r.crmUserId),
      },
      after: { managerIds, ownerIds },
      added: toInsert.length,
      removed: toDelete.length,
    },
  })

  res.json({ data: { managerIds, ownerIds }, error: null, meta: {} })
})
