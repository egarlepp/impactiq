import { Router } from 'express'
import { db } from '../../db/index.js'
import { activities, users } from '../../../../drizzle/schema.js'
import { and, eq, sql, inArray } from 'drizzle-orm'
import { requireDashboardAccess } from '../../middleware/rbac.js'

import {
  resolveTeamScope,
  assertUserInTeams,
  rangeFor,
  parseDateBasis,
  dateWindow,
  parseWeekShift,
  parseProductIds,
  productFilterCond,
  parseAcvRanges,
  amountInRanges,
} from './shared.js'

export const salesTeamDashRoutes = Router()

salesTeamDashRoutes.get('/sales-team-breakdown', requireDashboardAccess('sales_team_breakdown'), async (req, res) => {
  const dateBasis = parseDateBasis(req.query['dateBasis'])
  const teamId = req.query['teamId'] as string
  const teamIds = (await resolveTeamScope(req, teamId)) ?? []
  if (teamIds.length === 0) { res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} }); return }
  const weeksBack = Number(req.query['weeks'] ?? 8)
  const weekShift = parseWeekShift(req.query['weekShift'])
  const productIds = parseProductIds(req.query['productIds'])
  const acvRanges = parseAcvRanges(req.query['acv'])
  const userIdParam = req.query['userId'] as string | undefined
  // v1.245.0: Stage / Forecast / Team-member chips render for this
  // dashboard but previously had zero effect on its output — see
  // CLAUDE.md §13. Wired the same way manager-rollup already applies them.
  const stages = String(req.query['stages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const forecast = String(req.query['forecast'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const userIdsStb = String(req.query['userIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const pivotParam = req.query['pivot']
  const pivot: 'manager' | 'owner' | 'member' =
    pivotParam === 'owner' ? 'owner' : pivotParam === 'member' ? 'member' : 'manager'
  const includeManager = req.query['includeManager'] === 'true'
  const { rangeStart, rangeEnd } = rangeFor(weeksBack, weekShift)

  if (userIdParam && !(await assertUserInTeams(userIdParam, teamIds, req.user?.id))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return
  }

  const { crmUsers: sfUsersTbl, crmUserAlignments } = await import('../../../../drizzle/schema.js')
  const conditions = [
    inArray(activities.teamId, teamIds),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    ...dateWindow(dateBasis, rangeStart, rangeEnd),
    sql`${activities.crmWhatId} IS NOT NULL`,
    inArray(activities.crmWhatType, ['Opportunity', 'Account'] as const),
  ]
  if (userIdParam) conditions.push(eq(activities.userId, userIdParam))
  if (userIdsStb.length > 0) conditions.push(inArray(activities.userId, userIdsStb))
  const productCond = productFilterCond(productIds)
  if (productCond) conditions.push(productCond)

  const rawRows = await db
    .select({
      activityId: activities.id,
      userId: activities.userId,
      userName: users.displayName,
      startDatetime: activities.startDatetime,
      effortHours: activities.effortHours,
      costTransportation: activities.costTransportation,
      costLodging: activities.costLodging,
      costFood: activities.costFood,
      incidentalCurrency: activities.incidentalCurrency,
      acv: activities.acv,
      whatId: activities.crmWhatId,
      whatType: activities.crmWhatType,
      whatName: activities.crmWhatName,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.userId))
    .where(and(...conditions))

  // ACV range: keep only Opportunities whose (max) ACV is in range; Account-
  // direct rows drop out while a range is active. Not a cost tab, so the
  // buckets are USD. Precompute per-Opp max so the guard in the row loop is a
  // simple membership test that also keeps account rollups honest.
  const oppMaxAcvStb = new Map<string, number>()
  if (acvRanges.length > 0) {
    for (const r of rawRows) {
      if (r.whatType === 'Opportunity' && r.whatId) {
        const v = Number(r.acv ?? 0)
        if (v > (oppMaxAcvStb.get(r.whatId) ?? 0)) oppMaxAcvStb.set(r.whatId, v)
      }
    }
  }
  const acvKeepsStb = (row: { whatType: string | null; whatId: string | null; salesStage: string | null; forecastCategory: string | null }): boolean => {
    const hasOppFilter = acvRanges.length > 0 || stages.length > 0 || forecast.length > 0
    if (!hasOppFilter) return true
    if (row.whatType !== 'Opportunity' || !row.whatId) return false
    if (acvRanges.length > 0 && !amountInRanges(oppMaxAcvStb.get(row.whatId) ?? 0, acvRanges)) return false
    if (stages.length > 0 && (!row.salesStage || !stages.includes(row.salesStage))) return false
    if (forecast.length > 0 && (!row.forecastCategory || !forecast.includes(row.forecastCategory))) return false
    return true
  }

  // Resolve owner + parent account for each SF id via a single admin SF call.
  const oppIds = Array.from(new Set(rawRows.filter((r) => r.whatType === 'Opportunity' && r.whatId).map((r) => r.whatId as string)))
  const acctIds = Array.from(new Set(rawRows.filter((r) => r.whatType === 'Account' && r.whatId).map((r) => r.whatId as string)))

  interface SfMeta { ownerId: string | null; ownerName: string | null; accountId: string; accountName: string | null; oppName?: string | null }
  const oppMeta = new Map<string, SfMeta>()
  const acctMeta = new Map<string, SfMeta>()

  // Fast path: local sf_object_owner_cache. Populated by demo mode and any
  // future background SF sync so demo IDs (demo-opp-*, demo-acc-*) resolve
  // without a live Salesforce call. Real SF ids fall through to the live
  // query below for any id not already in the cache.
  const { sfObjectOwnerCache } = await import('../../../../drizzle/schema.js')
  const allCacheIds = [...oppIds, ...acctIds]
  if (allCacheIds.length > 0) {
    const cached = await db
      .select({
        sfId: sfObjectOwnerCache.sfId,
        objectType: sfObjectOwnerCache.objectType,
        name: sfObjectOwnerCache.name,
        accountId: sfObjectOwnerCache.accountId,
        accountName: sfObjectOwnerCache.accountName,
        ownerId: sfObjectOwnerCache.ownerId,
        ownerName: sfObjectOwnerCache.ownerName,
      })
      .from(sfObjectOwnerCache)
      .where(inArray(sfObjectOwnerCache.sfId, allCacheIds))
    for (const r of cached) {
      if (r.objectType === 'Opportunity' && r.accountId) {
        oppMeta.set(r.sfId, {
          ownerId: r.ownerId,
          ownerName: r.ownerName,
          accountId: r.accountId,
          accountName: r.accountName,
          oppName: r.name,
        })
      } else if (r.objectType === 'Account') {
        acctMeta.set(r.sfId, {
          ownerId: r.ownerId,
          ownerName: r.ownerName,
          accountId: r.sfId,
          accountName: r.accountName ?? r.name,
        })
      }
    }
  }

  // HubSpot (phase 7b): the same owner + Company lookup, from HubSpot.
  const { getCrmProviderId: crmIdStb } = await import('../../services/crm/providerSetting.js')
  const onHubspotStb = (await crmIdStb()) === 'hubspot'
  if (onHubspotStb) {
    try {
      const { hubspotRecordOwners } = await import('../../services/hubspot/recordOwners.js')
      const found = await hubspotRecordOwners(oppIds.filter((id) => !oppMeta.has(id)), acctIds.filter((id) => !acctMeta.has(id)))
      for (const [id, m] of found.deals) oppMeta.set(id, m)
      for (const [id, m] of found.companies) acctMeta.set(id, m)
    } catch {
      // Best effort, same as Salesforce below.
    }
  }

  if (!onHubspotStb) try {
    const { getSfConnection } = await import('../../services/salesforce/client.js')
    const { safeSoqlLiteral } = await import('../../services/salesforce/soql.js')
    const conn = await getSfConnection(req.user!.id)
    if (conn) {
      const chunkSize = 200
      const oppIdsMissing = oppIds.filter((id) => !oppMeta.has(id))
      const acctIdsMissing = acctIds.filter((id) => !acctMeta.has(id))
      for (let i = 0; i < oppIdsMissing.length; i += chunkSize) {
        const chunk = oppIdsMissing.slice(i, i + chunkSize)
        const escaped = chunk.map((id) => `'${safeSoqlLiteral(id)}'`).join(',')
        const soql = `SELECT Id, Name, AccountId, Account.Name, OwnerId, Owner.Name FROM Opportunity WHERE Id IN (${escaped})`
        const q = await conn.query<{ Id: string; Name: string | null; AccountId: string | null; Account: { Name: string } | null; OwnerId: string | null; Owner: { Name: string } | null }>(soql)
        for (const r of q.records) {
          if (!r.AccountId) continue
          oppMeta.set(r.Id, {
            ownerId: r.OwnerId ?? null,
            ownerName: r.Owner?.Name ?? null,
            accountId: r.AccountId,
            accountName: r.Account?.Name ?? null,
            oppName: r.Name ?? null,
          })
        }
      }
      for (let i = 0; i < acctIdsMissing.length; i += chunkSize) {
        const chunk = acctIdsMissing.slice(i, i + chunkSize)
        const escaped = chunk.map((id) => `'${safeSoqlLiteral(id)}'`).join(',')
        const soql = `SELECT Id, Name, OwnerId, Owner.Name FROM Account WHERE Id IN (${escaped})`
        const q = await conn.query<{ Id: string; Name: string | null; OwnerId: string | null; Owner: { Name: string } | null }>(soql)
        for (const r of q.records) {
          acctMeta.set(r.Id, {
            ownerId: r.OwnerId ?? null,
            ownerName: r.Owner?.Name ?? null,
            accountId: r.Id,
            accountName: r.Name ?? null,
          })
        }
      }
    }
  } catch {
    // Best effort — a missing SF connection just leaves the tree empty.
  }

  // Load all SF users referenced (owners + their managers) in one shot for
  // display + manager grouping.
  const referencedSfIds = new Set<string>()
  for (const m of oppMeta.values()) if (m.ownerId) referencedSfIds.add(m.ownerId)
  for (const m of acctMeta.values()) if (m.ownerId) referencedSfIds.add(m.ownerId)

  const sfUserRows = referencedSfIds.size === 0 ? [] : await db
    .select({ id: sfUsersTbl.id, name: sfUsersTbl.name, managerId: sfUsersTbl.managerId })
    .from(sfUsersTbl)
    .where(inArray(sfUsersTbl.id, Array.from(referencedSfIds)))
  const sfUserById = new Map(sfUserRows.map((r) => [r.id, r] as const))
  // Also pull manager rows so we have display names.
  const managerIdsToLoad = Array.from(new Set(sfUserRows.map((r) => r.managerId).filter((x): x is string => !!x)))
  if (managerIdsToLoad.length > 0) {
    const mgrs = await db
      .select({ id: sfUsersTbl.id, name: sfUsersTbl.name, managerId: sfUsersTbl.managerId })
      .from(sfUsersTbl)
      .where(inArray(sfUsersTbl.id, managerIdsToLoad))
    for (const m of mgrs) sfUserById.set(m.id, m)
  }

  // Alignment: which SF user ids does the caller / team scope care about?
  // We collect alignments for the users represented in the activity rows
  // (so we can compute coverage and misalignment badges).
  const activityUserIds = Array.from(new Set(rawRows.map((r) => r.userId)))
  const alignmentRows = activityUserIds.length === 0 ? [] : await db
    .select({ userId: crmUserAlignments.userId, crmUserId: crmUserAlignments.crmUserId, role: crmUserAlignments.role })
    .from(crmUserAlignments)
    .where(inArray(crmUserAlignments.userId, activityUserIds))
  const alignedOwners = new Set(alignmentRows.filter((r) => r.role === 'owner').map((r) => r.crmUserId))
  const alignedManagers = new Set(alignmentRows.filter((r) => r.role === 'manager').map((r) => r.crmUserId))

  // Build tree.
  interface OppNode { id: string; name: string; hours: number; activityCount: number }
  interface AccountNode { id: string; name: string; hours: number; accountCount: number; oppCount: number; activityCount: number; opps: OppNode[] }
  interface OwnerNode { id: string; name: string; hours: number; accountCount: number; oppCount: number; activityCount: number; memberCount: number; coverage: { covered: number; total: number; state: 'green' | 'amber' | 'red' | 'none' }; accounts: Map<string, AccountNode>; _memberIds?: Set<string> }
  interface ManagerNode { id: string; name: string; hours: number; accountCount: number; oppCount: number; activityCount: number; memberCount: number; owners: Map<string, OwnerNode>; _memberIds?: Set<string> }
  interface MemberNode { id: string; name: string; hours: number; accountCount: number; oppCount: number; activityCount: number; managers?: Map<string, ManagerNode>; owners?: Map<string, OwnerNode> }

  const managers = new Map<string, ManagerNode>()
  const ownerLevel = new Map<string, OwnerNode>() // used when pivot=owner
  const memberLevel = new Map<string, MemberNode>() // used when pivot=member
  let totalHours = 0

  function ensureOwner(container: Map<string, OwnerNode>, ownerId: string, ownerName: string): OwnerNode {
    let o = container.get(ownerId)
    if (!o) {
      o = {
        id: ownerId,
        name: ownerName,
        hours: 0,
        accountCount: 0,
        oppCount: 0,
        activityCount: 0,
        memberCount: 0,
        coverage: { covered: 0, total: 0, state: 'none' },
        accounts: new Map(),
        _memberIds: new Set(),
      }
      container.set(ownerId, o)
    }
    return o
  }

  function ensureManager(container: Map<string, ManagerNode>, managerId: string, managerName: string): ManagerNode {
    let mgr = container.get(managerId)
    if (!mgr) {
      mgr = { id: managerId, name: managerName, hours: 0, accountCount: 0, oppCount: 0, activityCount: 0, memberCount: 0, owners: new Map(), _memberIds: new Set() }
      container.set(managerId, mgr)
    }
    return mgr
  }

  function accumOwner(ownerNode: OwnerNode, meta: SfMeta, row: typeof rawRows[number], hours: number) {
    const accountId = meta.accountId
    const accountName = meta.accountName ?? accountId
    let acctNode = ownerNode.accounts.get(accountId)
    if (!acctNode) {
      acctNode = { id: accountId, name: accountName, hours: 0, accountCount: 1, oppCount: 0, activityCount: 0, opps: [] }
      ownerNode.accounts.set(accountId, acctNode)
    }
    acctNode.hours += hours
    acctNode.activityCount += 1
    ownerNode.hours += hours
    ownerNode.activityCount += 1
    ownerNode._memberIds?.add(row.userId)
    if (row.whatType === 'Opportunity') {
      const oppId = row.whatId as string
      let oppNode = acctNode.opps.find((o) => o.id === oppId)
      if (!oppNode) {
        oppNode = { id: oppId, name: meta.oppName ?? row.whatName ?? oppId, hours: 0, activityCount: 0 }
        acctNode.opps.push(oppNode)
        acctNode.oppCount += 1
      }
      oppNode.hours += hours
      oppNode.activityCount += 1
    }
  }

  for (const row of rawRows) {
    if (!acvKeepsStb(row)) continue
    const meta = row.whatType === 'Opportunity'
      ? oppMeta.get(row.whatId as string)
      : acctMeta.get(row.whatId as string)
    if (!meta) continue
    const ownerId = meta.ownerId ?? 'unassigned'
    const ownerRec = ownerId === 'unassigned' ? null : sfUserById.get(ownerId)
    const ownerName = ownerRec?.name ?? meta.ownerName ?? 'Unassigned'
    const managerId = ownerRec?.managerId ?? 'unassigned'
    const managerRec = managerId === 'unassigned' ? null : sfUserById.get(managerId)
    const managerName = managerRec?.name ?? 'Unassigned'
    const hours = Number(row.effortHours)
    totalHours += hours

    if (pivot === 'manager') {
      const mgr = ensureManager(managers, managerId, managerName)
      mgr._memberIds?.add(row.userId)
      accumOwner(ensureOwner(mgr.owners, ownerId, ownerName), meta, row, hours)
    } else if (pivot === 'owner') {
      accumOwner(ensureOwner(ownerLevel, ownerId, ownerName), meta, row, hours)
    } else {
      // pivot === 'member'
      let member = memberLevel.get(row.userId)
      if (!member) {
        member = {
          id: row.userId,
          name: row.userName ?? 'Unknown',
          hours: 0,
          accountCount: 0,
          oppCount: 0,
          activityCount: 0,
          ...(includeManager ? { managers: new Map<string, ManagerNode>() } : { owners: new Map<string, OwnerNode>() }),
        }
        memberLevel.set(row.userId, member)
      }
      member.hours += hours
      member.activityCount += 1
      if (includeManager && member.managers) {
        const mgr = ensureManager(member.managers, managerId, managerName)
        accumOwner(ensureOwner(mgr.owners, ownerId, ownerName), meta, row, hours)
      } else if (member.owners) {
        accumOwner(ensureOwner(member.owners, ownerId, ownerName), meta, row, hours)
      }
    }
  }

  // Finalize counts + coverage.
  function finalizeOwner(o: OwnerNode) {
    o.accountCount = o.accounts.size
    let oppCount = 0
    for (const a of o.accounts.values()) oppCount += a.oppCount
    o.oppCount = oppCount
    o.memberCount = o._memberIds?.size ?? 0
    if (!alignedOwners.has(o.id)) {
      o.coverage = { covered: 0, total: 0, state: 'none' }
    } else {
      const total = o.accountCount + o.oppCount
      const covered = total
      o.coverage = {
        covered,
        total,
        state: total === 0 ? 'red' : covered >= total ? 'green' : covered === 0 ? 'red' : 'amber',
      }
    }
  }

  const rollupOwnerToManager = (m: ManagerNode) => {
    for (const o of m.owners.values()) finalizeOwner(o)
    const acctSet = new Set<string>()
    let oppTotal = 0
    let activityTotal = 0
    let hours = 0
    for (const o of m.owners.values()) {
      for (const [aid] of o.accounts) acctSet.add(aid)
      oppTotal += o.oppCount
      activityTotal += o.activityCount
      hours += o.hours
    }
    m.hours = hours
    m.accountCount = acctSet.size
    m.oppCount = oppTotal
    m.activityCount = activityTotal
    m.memberCount = m._memberIds?.size ?? 0
  }

  function rollupMember(mem: MemberNode) {
    const acctSet = new Set<string>()
    let oppTotal = 0
    if (mem.managers) {
      for (const mgr of mem.managers.values()) rollupOwnerToManager(mgr)
      for (const mgr of mem.managers.values()) {
        for (const o of mgr.owners.values()) {
          for (const [aid] of o.accounts) acctSet.add(aid)
          oppTotal += o.oppCount
        }
      }
    } else if (mem.owners) {
      for (const o of mem.owners.values()) finalizeOwner(o)
      for (const o of mem.owners.values()) {
        for (const [aid] of o.accounts) acctSet.add(aid)
        oppTotal += o.oppCount
      }
    }
    mem.accountCount = acctSet.size
    mem.oppCount = oppTotal
  }

  // Serialize
  function serializeOwner(o: OwnerNode) {
    const { _memberIds: _drop, ...rest } = o
    void _drop
    return {
      ...rest,
      accounts: Array.from(o.accounts.values()).sort((a, b) => b.hours - a.hours),
    }
  }
  function serializeManager(m: ManagerNode) {
    const { _memberIds: _drop, ...rest } = m
    void _drop
    return {
      ...rest,
      owners: Array.from(m.owners.values()).sort((a, b) => b.hours - a.hours).map(serializeOwner),
    }
  }

  let serialized: unknown
  if (pivot === 'manager') {
    for (const m of managers.values()) rollupOwnerToManager(m)
    serialized = Array.from(managers.values()).sort((a, b) => b.hours - a.hours).map(serializeManager)
  } else if (pivot === 'owner') {
    for (const o of ownerLevel.values()) finalizeOwner(o)
    serialized = Array.from(ownerLevel.values()).sort((a, b) => b.hours - a.hours).map(serializeOwner)
  } else {
    for (const mem of memberLevel.values()) rollupMember(mem)
    serialized = Array.from(memberLevel.values()).sort((a, b) => b.hours - a.hours).map((mem) => ({
      id: mem.id,
      name: mem.name,
      hours: mem.hours,
      accountCount: mem.accountCount,
      oppCount: mem.oppCount,
      activityCount: mem.activityCount,
      ...(mem.managers
        ? { managers: Array.from(mem.managers.values()).sort((a, b) => b.hours - a.hours).map(serializeManager) }
        : {}),
      ...(mem.owners
        ? { owners: Array.from(mem.owners.values()).sort((a, b) => b.hours - a.hours).map(serializeOwner) }
        : {}),
    }))
  }

  const alignedOwnersCount = alignedOwners.size
  const alignedManagersCount = alignedManagers.size

  const touchedOwners =
    pivot === 'manager'
      ? Array.from(managers.values()).reduce((acc, m) => acc + m.owners.size, 0)
      : pivot === 'owner'
        ? ownerLevel.size
        : Array.from(memberLevel.values()).reduce((acc, mem) => {
            if (mem.managers) return acc + Array.from(mem.managers.values()).reduce((a, mgr) => a + mgr.owners.size, 0)
            return acc + (mem.owners?.size ?? 0)
          }, 0)

  res.json({
    data: serialized,
    error: null,
    meta: {
      pivot,
      includeManager,
      totalHours,
      coverageStats: {
        alignedOwnersCount,
        alignedManagersCount,
        touchedOwners,
      },
      rangeStart: rangeStart.toISOString(),
      rangeEnd: rangeEnd.toISOString(),
    },
  })
})
