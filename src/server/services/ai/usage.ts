import { and, asc, desc, eq, gte, isNull, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../../db/index.js'
import { aiRequests, teams, users } from '../../../../drizzle/schema.js'
import {
  AI_USAGE_NONE,
  AI_USAGE_PAGE_SIZE,
  type AiUsageGroupBy,
  type AiUsageGroupRow,
  type AiUsageRequestRow,
  type AiUsageTotals,
  type AiUsageView,
} from '../../../shared/ai.js'
import { startOfUtcMonth } from './gateway.js'

// Admin → AI Assistant → Usage this month (v1.467.0): the month's AI
// requests grouped by feature, team or person, plus one page of the
// requests themselves. Every figure reads only ai_requests (never the
// input text, which is never stored).

export interface AiUsageQuery {
  groupBy: AiUsageGroupBy
  feature?: string | undefined
  // A team id, or AI_USAGE_NONE for requests with no team.
  teamId?: string | undefined
  // A user id, or AI_USAGE_NONE for requests nobody made (jobs).
  userId?: string | undefined
  page: number
}

const requester = alias(users, 'ai_usage_requester')
const usageTeam = alias(teams, 'ai_usage_team')

// The team a request counts for: the team it was charged to (AI Notes, AI
// Assessments), else the requester's default team.
const teamIdExpr = sql<string | null>`coalesce(${aiRequests.teamId}, ${requester.defaultTeamId})`

function baseWhere(q: AiUsageQuery, since: Date): SQL {
  const parts: SQL[] = [gte(aiRequests.createdAt, since)]
  if (q.feature) parts.push(eq(aiRequests.feature, q.feature))
  if (q.teamId === AI_USAGE_NONE) parts.push(sql`${teamIdExpr} IS NULL`)
  else if (q.teamId) parts.push(sql`${teamIdExpr} = ${q.teamId}::uuid`)
  if (q.userId === AI_USAGE_NONE) parts.push(isNull(aiRequests.requestedBy))
  else if (q.userId) parts.push(eq(aiRequests.requestedBy, q.userId))
  return and(...parts)!
}

const sums = {
  requests: sql<string>`count(*)`,
  inputTokens: sql<string>`coalesce(sum(${aiRequests.inputTokens}), 0)`,
  outputTokens: sql<string>`coalesce(sum(${aiRequests.outputTokens}), 0)`,
  costUsd: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)`,
  failed: sql<string>`count(*) filter (where ${aiRequests.status} <> 'ok')`,
}

function totalsOf(r: { requests: string | number; inputTokens: string | number; outputTokens: string | number; costUsd: string | number; failed: string | number }): AiUsageTotals {
  // Aggregates come back as strings from the postgres driver.
  return {
    requests: Number(r.requests),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costUsd: Number(r.costUsd),
    failed: Number(r.failed),
  }
}

export async function aiUsageView(q: AiUsageQuery, now: Date = new Date()): Promise<AiUsageView> {
  const since = startOfUtcMonth(now)
  const where = baseWhere(q, since)
  const joined = <T extends Record<string, unknown>>(fields: T) => db
    .select(fields as never)
    .from(aiRequests)
    .leftJoin(requester, eq(requester.id, aiRequests.requestedBy))
    .leftJoin(usageTeam, sql`${usageTeam.id} = ${teamIdExpr}`)

  const groupKey = q.groupBy === 'feature'
    ? sql<string | null>`${aiRequests.feature}`
    : q.groupBy === 'team' ? teamIdExpr : sql<string | null>`${aiRequests.requestedBy}`
  const groupLabel = q.groupBy === 'feature'
    ? sql<string | null>`null`
    : q.groupBy === 'team' ? sql<string | null>`max(${usageTeam.name})` : sql<string | null>`max(${requester.displayName})`

  const groupRows = await joined({ key: groupKey, label: groupLabel, ...sums })
    .where(where)
    .groupBy(groupKey)
    .orderBy(sql`coalesce(sum(${aiRequests.costUsd}), 0) desc`, sql`count(*) desc`) as unknown as Array<{ key: string | null; label: string | null } & Record<keyof typeof sums, string>>
  const groups: AiUsageGroupRow[] = groupRows.map((r) => ({ key: r.key, label: r.label, ...totalsOf(r) }))
  const totals = groups.reduce<AiUsageTotals>((acc, g) => ({
    requests: acc.requests + g.requests,
    inputTokens: acc.inputTokens + g.inputTokens,
    outputTokens: acc.outputTokens + g.outputTokens,
    costUsd: acc.costUsd + g.costUsd,
    failed: acc.failed + g.failed,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: 0 })

  const pages = Math.max(1, Math.ceil(totals.requests / AI_USAGE_PAGE_SIZE))
  const page = Math.min(Math.max(1, Math.floor(q.page) || 1), pages)
  const rowData = await joined({
    id: aiRequests.id,
    createdAt: aiRequests.createdAt,
    feature: aiRequests.feature,
    providerName: aiRequests.providerName,
    providerKind: aiRequests.providerKind,
    model: aiRequests.model,
    teamId: teamIdExpr,
    teamName: usageTeam.name,
    userId: aiRequests.requestedBy,
    userName: requester.displayName,
    inputTokens: aiRequests.inputTokens,
    outputTokens: aiRequests.outputTokens,
    costUsd: aiRequests.costUsd,
    itemCount: aiRequests.itemCount,
    status: aiRequests.status,
    error: aiRequests.error,
  })
    .where(where)
    .orderBy(desc(aiRequests.createdAt), asc(aiRequests.id))
    .limit(AI_USAGE_PAGE_SIZE)
    .offset((page - 1) * AI_USAGE_PAGE_SIZE) as unknown as Array<Omit<AiUsageRequestRow, 'createdAt' | 'costUsd'> & { createdAt: Date | string; costUsd: string }>
  const rows: AiUsageRequestRow[] = rowData.map((r) => ({
    ...r,
    createdAt: new Date(r.createdAt).toISOString(),
    costUsd: Number(r.costUsd),
  }))

  // Filter choices: everything seen this month, regardless of the filters.
  const monthOnly = gte(aiRequests.createdAt, since)
  const featureRows = await db.selectDistinct({ feature: aiRequests.feature }).from(aiRequests).where(monthOnly).orderBy(asc(aiRequests.feature))
  const teamRows = await joined({ id: usageTeam.id, name: usageTeam.name })
    .where(and(monthOnly, sql`${usageTeam.id} IS NOT NULL`))
    .groupBy(usageTeam.id, usageTeam.name)
    .orderBy(asc(usageTeam.name)) as unknown as Array<{ id: string; name: string }>
  const userRows = await joined({ id: requester.id, name: requester.displayName })
    .where(and(monthOnly, sql`${requester.id} IS NOT NULL`))
    .groupBy(requester.id, requester.displayName)
    .orderBy(asc(requester.displayName)) as unknown as Array<{ id: string; name: string | null }>

  return {
    since: since.toISOString(),
    groupBy: q.groupBy,
    groups,
    totals,
    rows,
    page,
    pageSize: AI_USAGE_PAGE_SIZE,
    totalRows: totals.requests,
    options: {
      features: featureRows.map((f) => f.feature),
      teams: teamRows.map((t) => ({ id: t.id, name: t.name })),
      users: userRows.map((u) => ({ id: u.id, name: u.name ?? '—' })),
    },
  }
}
