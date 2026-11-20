import { Router, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { verifyApiKey } from '../services/auth/apiKeys.js'
import { db } from '../db/index.js'
import { activities, users, mcpToolCalls, systemSettings, teams, teamMembers } from '../../../drizzle/schema.js'
import { and, eq, gte, lte, desc, inArray, sql } from 'drizzle-orm'
import { mcpRateCheck } from '../middleware/mcp-rate-limit.js'
import { mcpGetRecord, mcpSearchAccounts, mcpSearchOpportunities } from '../services/crm/mcpTools.js'
import { getAccessibleTeamIds } from '../middleware/rbac.js'

// v1.145.0: ImpactIQ MCP server (read-only).
//
// Transport: Streamable HTTP (one endpoint, POST for JSON-RPC + GET for
// SSE upgrade). Stateless — every request re-auths via Bearer token,
// which lets a horizontally scaled cluster serve MCP too.
//
// Auth: iqk_ API keys with the mcp:read scope. REST-scope keys are
// rejected. Tenant-wide kill switch lives in system_settings.mcp_enabled.
//
// Every tool call writes an mcp_tool_calls row (tool, args-hash, status,
// latency, error) that surfaces on Admin → Monitoring → MCP Activity.

export const mcpRouter = Router()

// System settings key for the on/off toggle.
const MCP_ENABLED_KEY = 'mcp_enabled'

async function isMcpEnabled(): Promise<boolean> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, MCP_ENABLED_KEY)).limit(1)
  if (!row) return true // Default ON — admin explicitly turns off.
  const v = (row.value as { enabled?: boolean } | null)?.enabled
  return v !== false
}

// Build the McpServer with every read-only tool registered. We keep this
// as a factory called per-connection so each transport gets its own
// server instance (SDK requirement — a server can only be connected to
// one transport at a time).
//
// v1.288.0: security audit finding B1 — every tool below now scopes its
// query to context.userId's accessible teams (getAccessibleTeamIds, the
// same helper Admin config screens and dashboards.ts use), instead of
// reading tenant-wide with an optional, caller-chosen filter. Paired with
// B2 (mcp:read now requires a leader/admin/app-admin role to self-issue),
// this makes the MCP server's data boundary match what that same user
// could already see through the leader dashboards and REST endpoints —
// not broader.
function buildServer(context: { userId: string; apiKeyId: string }): McpServer {
  const server = new McpServer({ name: 'impactiq', version: '1.0.0' })

  // ── Dashboards ────────────────────────────────────────────────────────
  server.registerTool('dashboards.manager_rollup', {
    description: "Cross-team KPI rollup (hours, cost, ACV, activities) for teams the calling user can see. Read-only.",
    inputSchema: { weeks: z.number().int().min(1).max(52).default(8) },
  }, async ({ weeks }) => {
    const accessibleTeamIds = await getAccessibleTeamIds(context.userId)
    if (accessibleTeamIds.length === 0) return jsonResult({ data: [], weeks })
    const { rangeStart, rangeEnd } = rangeFor(weeks)
    const rows = await db.select({
      userId: activities.userId,
      teamId: activities.teamId,
      effortHours: activities.effortHours,
      acv: activities.acv,
      crmWhatId: activities.crmWhatId,
      crmWhatType: activities.crmWhatType,
    }).from(activities).where(and(
      eq(activities.status, 'submitted'),
      eq(activities.isArchived, false),
      inArray(activities.teamId, accessibleTeamIds),
      gte(activities.startDatetime, rangeStart),
      lte(activities.startDatetime, rangeEnd),
    ))
    const byTeam = new Map<string, { hours: number; activities: number; opps: Set<string>; users: Set<string> }>()
    for (const r of rows) {
      const cur = byTeam.get(r.teamId) ?? { hours: 0, activities: 0, opps: new Set<string>(), users: new Set<string>() }
      cur.hours += Number(r.effortHours)
      cur.activities += 1
      cur.users.add(r.userId)
      if (r.crmWhatType === 'Opportunity' && r.crmWhatId) cur.opps.add(r.crmWhatId)
      byTeam.set(r.teamId, cur)
    }
    const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, accessibleTeamIds))
    const nameById = new Map(teamRows.map((t) => [t.id, t.name] as const))
    const out = Array.from(byTeam.entries()).map(([teamId, agg]) => ({
      teamId,
      teamName: nameById.get(teamId) ?? teamId,
      hours: Number(agg.hours.toFixed(1)),
      activities: agg.activities,
      uniqueContributors: agg.users.size,
      uniqueOpps: agg.opps.size,
    })).sort((a, b) => b.hours - a.hours)
    return jsonResult({ data: out, weeks, rangeStart: rangeStart.toISOString(), rangeEnd: rangeEnd.toISOString() })
  })

  server.registerTool('activities.list', {
    description: "List submitted activities across the calling user's accessible teams. Optional filters: userId, teamId (must be one of the caller's own teams), from, to. Returns up to `limit` rows (default 50, max 200). Read-only.",
    inputSchema: {
      userId: z.string().uuid().optional(),
      teamId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
  }, async ({ userId, teamId, from, to, limit }) => {
    const accessibleTeamIds = await getAccessibleTeamIds(context.userId)
    if (teamId && !accessibleTeamIds.includes(teamId)) return jsonResult({ data: [], count: 0, error: 'team_not_accessible' })
    const scopeTeamIds = teamId ? [teamId] : accessibleTeamIds
    const clauses = [eq(activities.status, 'submitted'), eq(activities.isArchived, false), inArray(activities.teamId, scopeTeamIds)]
    if (userId) clauses.push(eq(activities.userId, userId))
    if (from) clauses.push(gte(activities.startDatetime, new Date(from)))
    if (to) clauses.push(lte(activities.startDatetime, new Date(to)))
    const rows = await db.select({
      id: activities.id,
      title: activities.title,
      userId: activities.userId,
      teamId: activities.teamId,
      startDatetime: activities.startDatetime,
      effortHours: activities.effortHours,
      crmWhatType: activities.crmWhatType,
      crmWhatName: activities.crmWhatName,
      crmAccountName: activities.crmAccountName,
      salesStage: activities.salesStage,
      acv: activities.acv,
    }).from(activities).where(and(...clauses)).orderBy(desc(activities.startDatetime)).limit(limit)
    return jsonResult({ data: rows, count: rows.length })
  })

  server.registerTool('activities.get', {
    description: "Fetch a single activity by id, including full description body and SF snapshot fields. Only returns the activity when it belongs to one of the caller's accessible teams. Read-only.",
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => {
    const [row] = await db.select().from(activities).where(eq(activities.id, id)).limit(1)
    if (!row) return jsonResult({ data: null, error: 'not_found' })
    const accessibleTeamIds = await getAccessibleTeamIds(context.userId)
    // Reports not_found rather than forbidden — a caller shouldn't be able to
    // tell an out-of-scope id apart from one that doesn't exist at all.
    if (!accessibleTeamIds.includes(row.teamId)) return jsonResult({ data: null, error: 'not_found' })
    return jsonResult({ data: row })
  })

  server.registerTool('users.list', {
    description: "List users who share at least one team with the calling user (id, email, displayName, defaultTeamId). Useful for resolving IDs before activities.list. Read-only.",
    inputSchema: {},
  }, async () => {
    const accessibleTeamIds = await getAccessibleTeamIds(context.userId)
    if (accessibleTeamIds.length === 0) return jsonResult({ data: [], count: 0 })
    const memberRows = await db.selectDistinct({ userId: teamMembers.userId }).from(teamMembers).where(inArray(teamMembers.teamId, accessibleTeamIds))
    const memberIds = memberRows.map((r) => r.userId)
    if (memberIds.length === 0) return jsonResult({ data: [], count: 0 })
    const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName, defaultTeamId: users.defaultTeamId }).from(users).where(inArray(users.id, memberIds))
    return jsonResult({ data: rows, count: rows.length })
  })

  server.registerTool('teams.list', {
    description: "List teams the calling user has access to (id, name, slug, isActive). Useful for resolving IDs before activities.list. Read-only.",
    inputSchema: {},
  }, async () => {
    const accessibleTeamIds = await getAccessibleTeamIds(context.userId)
    if (accessibleTeamIds.length === 0) return jsonResult({ data: [], count: 0 })
    const rows = await db.select({ id: teams.id, name: teams.name, slug: teams.slug, isActive: teams.isActive }).from(teams).where(inArray(teams.id, accessibleTeamIds))
    return jsonResult({ data: rows, count: rows.length })
  })

  // ── CRM (phase 8b) ────────────────────────────────────────────────────
  // Run on whichever CRM the install uses, as the caller's own CRM session
  // (services/crm/mcpTools.ts). Every result names the CRM in `crm`.
  // `salesforce.search_opportunities` stays as an alias of
  // crm.search_opportunities so existing agent setups keep working.
  const searchOpportunities = async ({ q, limit, includeClosed }: { q: string; limit: number; includeClosed?: boolean | undefined }) => {
    const teamId = await defaultTeamFor(context.userId)
    return jsonResult(await mcpSearchOpportunities(context.userId, { q, limit, includeClosed: includeClosed ?? false, teamId }))
  }
  const opportunityInput = {
    q: z.string().min(2).max(120),
    limit: z.number().int().min(1).max(50).default(20),
    includeClosed: z.boolean().default(false),
  }
  const opportunityFields = 'Returns Id, Name, StageName, Amount, ForecastCategoryName, AccountId, AccountName, CloseDate, OwnerName.'

  server.registerTool('crm.search_opportunities', {
    description: `Search the CRM's Opportunities (Salesforce) or Deals (HubSpot) by name, limited to the calling user's own: on Salesforce the ones they are Assigned SE / Primary / Specialist / Supporting Engineer on, on HubSpot the Deals their HubSpot owner owns or is the mapped SE on. Open records unless includeClosed. ${opportunityFields} The result's \`crm\` field says which CRM answered. Read-only.`,
    inputSchema: opportunityInput,
  }, searchOpportunities)

  server.registerTool('salesforce.search_opportunities', {
    description: `Deprecated alias of crm.search_opportunities, kept for existing setups; works on Salesforce and HubSpot. ${opportunityFields} Read-only.`,
    inputSchema: opportunityInput,
  }, searchOpportunities)

  server.registerTool('crm.search_accounts', {
    description: "Search the CRM's Accounts (Salesforce) or Companies (HubSpot) by name, the same search as the in-app Account tab. Returns Id, Name and the Account fields the CRM provides. Read-only.",
    inputSchema: { q: z.string().min(2).max(120), limit: z.number().int().min(1).max(50).default(20) },
  }, async ({ q, limit }) => jsonResult(await mcpSearchAccounts(context.userId, { q, limit })))

  server.registerTool('crm.get_record', {
    description: "Live state of one Opportunity/Deal (stage, forecast, amount, close date, owner, Assigned SE) or Account/Company (owner, industry, type, location, website) by its CRM id, the same read as the in-app hover preview. Read-only.",
    inputSchema: { type: z.enum(['Opportunity', 'Account']), id: z.string().min(1).max(40) },
  }, async ({ type, id }) => jsonResult(await mcpGetRecord(context.userId, { type, id })))

  return server
}

// The caller's default team when they can still see it: HubSpot's "my Deals"
// filter reads that team's SE property mapping, as the in-app search does.
async function defaultTeamFor(userId: string): Promise<string | null> {
  const [row] = await db.select({ teamId: users.defaultTeamId }).from(users).where(eq(users.id, userId)).limit(1)
  if (!row?.teamId) return null
  return (await getAccessibleTeamIds(userId)).includes(row.teamId) ? row.teamId : null
}

function rangeFor(weeksBack: number): { rangeStart: Date; rangeEnd: Date } {
  const now = new Date()
  const rangeStart = new Date(now.getTime() - weeksBack * 7 * 24 * 60 * 60 * 1000)
  return { rangeStart, rangeEnd: now }
}

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

// Bearer + scope + tenant-toggle + rate-limit gate. Extracted so both
// POST and GET (SSE upgrade) share the same guard.
async function authAndGate(req: Request, res: Response): Promise<{ userId: string; apiKeyId: string } | null> {
  const enabled = await isMcpEnabled()
  if (!enabled) {
    res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'mcp_disabled_by_admin' } })
    return null
  }
  const authHeader = req.headers['authorization']
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer iqk_')) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32000, message: 'missing_bearer_token' } })
    return null
  }
  const raw = authHeader.slice('Bearer '.length)
  const verified = await verifyApiKey(raw)
  if (!verified) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32000, message: 'invalid_token' } })
    return null
  }
  if (!verified.scopes.includes('mcp:read') && !verified.scopes.includes('mcp:write')) {
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'wrong_scope', data: { required: 'mcp:read' } } })
    return null
  }
  const gate = await mcpRateCheck(verified.apiKeyId)
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfterSec ?? 60))
    void logCall({ userId: verified.userId, apiKeyId: verified.apiKeyId, tool: '__any__', status: 'throttled', latencyMs: 0, error: gate.reason ?? null })
    res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'rate_limited', data: { reason: gate.reason } } })
    return null
  }
  return { userId: verified.userId, apiKeyId: verified.apiKeyId }
}

async function logCall(row: { userId: string; apiKeyId: string; tool: string; argsHash?: string | null; status: 'ok' | 'error' | 'throttled'; latencyMs: number; error?: string | null }) {
  try {
    await db.insert(mcpToolCalls).values({
      userId: row.userId,
      apiKeyId: row.apiKeyId,
      tool: row.tool,
      argsHash: row.argsHash ?? null,
      status: row.status,
      latencyMs: row.latencyMs,
      error: row.error ?? null,
    })
  } catch {
    // Audit persistence must never break a live tool call.
  }
}

// POST /api/mcp — main JSON-RPC endpoint.
mcpRouter.post('/', async (req, res) => {
  const ctx = await authAndGate(req, res)
  if (!ctx) return
  const startedAt = Date.now()
  const parsedBody = req.body
  const toolName = pickToolName(parsedBody)
  const argsHash = parsedBody ? createHash('sha256').update(JSON.stringify(parsedBody)).digest('hex').slice(0, 32) : null
  try {
    const server = buildServer(ctx)
    // SDK's stateless mode requires sessionIdGenerator === undefined.
    // exactOptionalPropertyTypes rejects that literal; cast through.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
    await server.connect(transport as unknown as Parameters<McpServer['connect']>[0])
    res.on('close', () => { void server.close().catch(() => {}) })
    await transport.handleRequest(req, res, parsedBody)
    void logCall({ userId: ctx.userId, apiKeyId: ctx.apiKeyId, tool: toolName, argsHash, status: 'ok', latencyMs: Date.now() - startedAt })
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    void logCall({ userId: ctx.userId, apiKeyId: ctx.apiKeyId, tool: toolName, argsHash, status: 'error', latencyMs: Date.now() - startedAt, error: err })
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err } })
  }
})

// GET /api/mcp — SSE upgrade path (per spec — some clients open this
// separately for server → client messages). Same gate as POST.
mcpRouter.get('/', async (req, res) => {
  const ctx = await authAndGate(req, res)
  if (!ctx) return
  try {
    const server = buildServer(ctx)
    // SDK's stateless mode requires sessionIdGenerator === undefined.
    // exactOptionalPropertyTypes rejects that literal; cast through.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
    await server.connect(transport as unknown as Parameters<McpServer['connect']>[0])
    res.on('close', () => { void server.close().catch(() => {}) })
    await transport.handleRequest(req, res)
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e instanceof Error ? e.message : String(e) } })
  }
})

// Best-effort extraction of the tool name from a JSON-RPC body so audit
// rows carry useful info without parsing the whole envelope.
function pickToolName(body: unknown): string {
  if (!body || typeof body !== 'object') return '__unknown__'
  const b = body as { method?: string; params?: { name?: string } }
  if (b.method === 'tools/call' && b.params?.name) return b.params.name
  return b.method ?? '__unknown__'
}
