import { Router } from 'express'
import { db } from '../../db/index.js'
import { users } from '../../../../drizzle/schema.js'
import { and, eq, sql, or, ilike } from 'drizzle-orm'
import { crmUsers } from '../../../../drizzle/schema.js'
import { getCrmProviderId } from '../../services/crm/providerSetting.js'
import { HubspotError } from '../../services/hubspot/client.js'
import {
  HUBSPOT_OWNER_ROW_RX,
  runHubspotOwnerSync,
  getUserForHubspotOwner,
  getHubspotOwnerDetailsForUser,
  listHubspotTeamNames,
} from '../../services/hubspot/owners.js'
import { requireAppAdmin } from '../../middleware/rbac.js'
import { isOktaConfigured } from '../../services/auth/okta.js'
import { isSalesforceConfigured } from '../../services/auth/salesforce.js'
import { isMicrosoftConfigured } from '../../services/auth/microsoft.js'
import { getAdminSfConnection, getSfConnection } from '../../services/salesforce/client.js'
import { getIntegrationConfigSummary } from '../../services/config/integrations.js'
import { safeSoqlLiteral } from '../../services/salesforce/soql.js'

export const crmMetadataRoutes = Router()

// GET /api/admin/integrations/status — returns which external integrations are configured via env vars.
crmMetadataRoutes.get('/integrations/status', requireAppAdmin, async (_req, res) => {
  // v1.232.0: Slack moved from its own standalone admin page onto this
  // page's card list — see IntegrationsStatus.tsx's SlackForm.
  const { getSlackConfigSummary } = await import('../../services/slack/client.js')
  const slack = await getSlackConfigSummary()
  // v1.332.0: App Updates card — see GithubUpdatesForm.tsx, which
  // self-fetches its own richer /api/admin/updates/settings summary; this
  // just needs the boolean for the card's badge, same as every other row.
  const { getUpdateConfigSummary } = await import('../../services/updates/checkForUpdates.js')
  const github = await getUpdateConfigSummary()
  const { getAiSettings, providerForFeature } = await import('../../services/ai/providers.js')
  const aiConfigured = (await getAiSettings()).enabled && !!(await providerForFeature('activity_classify'))
  res.json({
    data: {
      okta: { configured: isOktaConfigured() },
      azureSso: { configured: !!getIntegrationConfigSummary().azureSso },
      salesforce: { configured: isSalesforceConfigured() },
      microsoft: { configured: isMicrosoftConfigured() },
      aiAssistant: { configured: aiConfigured },
      smtp: { configured: !!getIntegrationConfigSummary().smtp },
      slack: { configured: slack.configured },
      github: { configured: github.configured },
    },
    error: null,
    meta: {},
  })
})

// --- Salesforce metadata introspection (uses admin SF connection) ---
// These endpoints help populate config dropdowns instead of requiring admins
// to type SF API field names by hand. They run as the admin's SF identity
// and never act on contributor data.

// Cache describeGlobal() and per-object describe() calls in memory for an
// hour — SF metadata changes rarely and the payloads are large.
const SF_META_TTL_MS = 60 * 60 * 1000
interface CachedGlobal { at: number; data: Array<{ name: string; label: string; queryable: boolean; createable: boolean; updateable: boolean; custom: boolean }> }
let globalCache: CachedGlobal | null = null
interface CachedDescribe { at: number; fields: Array<{ apiName: string; label: string; type: string; isCustom: boolean; referenceTo: string[]; picklistValues: Array<{ value: string; label: string }> }> }
const describeCache = new Map<string, CachedDescribe>()

crmMetadataRoutes.get('/sf/objects', requireAppAdmin, async (req, res) => {
  // Prefer the org-wide admin SF connection; fall back to the
  // caller's per-user connection when the admin flow hasn't been
  // completed. Both are safe for read-only describe / metadata.
  const conn = (await getAdminSfConnection()) ?? (await getSfConnection(req.user!.id))
  if (!conn) {
    res.status(412).json({ data: null, error: 'errors.salesforce.admin_not_configured', meta: {} })
    return
  }
  if (globalCache && Date.now() - globalCache.at < SF_META_TTL_MS) {
    res.json({ data: globalCache.data, error: null, meta: { cached: true } })
    return
  }
  try {
    const meta = await conn.describeGlobal()
    const data = meta.sobjects
      .filter((s) => s.queryable)
      .map((s) => ({
        name: s.name,
        label: s.label ?? s.name,
        queryable: !!s.queryable,
        createable: !!s.createable,
        updateable: !!s.updateable,
        custom: !!s.custom,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    globalCache = { at: Date.now(), data }
    res.json({ data, error: null, meta: { cached: false } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Salesforce describeGlobal failed: ${message}`, meta: {} })
  }
})

crmMetadataRoutes.get('/sf/fields', requireAppAdmin, async (req, res) => {
  const objectParam = req.query['object']
  if (typeof objectParam !== 'string' || !/^[A-Za-z0-9_]+$/.test(objectParam)) {
    res.status(400).json({ data: null, error: 'errors.salesforce.invalid_object_type', meta: {} })
    return
  }
  const cached = describeCache.get(objectParam)
  if (cached && Date.now() - cached.at < SF_META_TTL_MS) {
    res.json({ data: { object: objectParam, fields: cached.fields }, error: null, meta: { cached: true } })
    return
  }
  const conn = (await getAdminSfConnection()) ?? (await getSfConnection(req.user!.id))
  if (!conn) {
    res.status(412).json({ data: null, error: 'errors.salesforce.admin_not_configured', meta: {} })
    return
  }
  try {
    const meta = await conn.sobject(objectParam).describe()
    const fields = meta.fields.map((f) => ({
      apiName: f.name,
      label: f.label,
      type: f.type,
      isCustom: f.custom,
      referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo : [],
      picklistValues: Array.isArray(f.picklistValues)
        ? f.picklistValues.filter((v) => v.active).map((v) => ({ value: v.value, label: v.label ?? v.value }))
        : [],
    }))
    // Sort alphabetically by label so the client dropdown reads naturally.
    fields.sort((a, b) => (a.label ?? a.apiName).localeCompare(b.label ?? b.apiName))
    describeCache.set(objectParam, { at: Date.now(), fields })
    res.json({ data: { object: objectParam, fields }, error: null, meta: { cached: false } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Salesforce describe failed: ${message}`, meta: {} })
  }
})

// GET /api/admin/sf/users?q=&refresh=1 — Salesforce User picker for
// the User Management admin page. Reads a small live SOQL slice and
// upserts into crm_users cache so re-opens are instant. When q is
// blank we still return a page of active users so admins can
// browse. `refresh=1` bypasses the local crm_users cache and always
// hits Salesforce; otherwise a cached slice is returned if present
// and non-empty.
crmMetadataRoutes.get('/sf/users', requireAppAdmin, async (req, res) => {
  const q = (typeof req.query['q'] === 'string' ? req.query['q'] : '').trim()
  const refresh = req.query['refresh'] === '1'
  const like = `%${q}%`
  const nameOrEmail = q ? or(ilike(crmUsers.name, like), ilike(crmUsers.email, like)) : sql`true`
  // v1.406.0: on HubSpot the picker lists HubSpot owners (copied into
  // crm_users under their owner id by the owner sync); Refresh re-syncs them.
  if ((await getCrmProviderId()) === 'hubspot') {
    if (refresh) {
      try {
        await runHubspotOwnerSync({ source: 'manual' })
      } catch (err) {
        res.status(502).json({ data: null, error: err instanceof HubspotError ? err.code : 'errors.hubspot.bad_response', meta: {} })
        return
      }
    }
    const owners = await db.select({ id: crmUsers.id, name: crmUsers.name, email: crmUsers.email, isActive: crmUsers.isActive })
      .from(crmUsers)
      .where(and(eq(crmUsers.isActive, true), sql`${crmUsers.id} ~ ${HUBSPOT_OWNER_ROW_RX}`, nameOrEmail))
      .orderBy(crmUsers.name)
      .limit(50)
    res.json({ data: owners, error: null, meta: { source: 'hubspot_owners' } })
    return
  }
  if (!refresh) {
    // Serve cached rows for the common case (admin opens the picker
    // and starts typing). Cache is populated by the refresh path
    // below and by successful assignments. HubSpot owner rows are
    // left out (crm_users holds both CRMs' people).
    const cached = await db.select({ id: crmUsers.id, name: crmUsers.name, email: crmUsers.email, isActive: crmUsers.isActive })
      .from(crmUsers)
      .where(and(sql`${crmUsers.id} !~ ${HUBSPOT_OWNER_ROW_RX}`, nameOrEmail))
      .orderBy(crmUsers.name)
      .limit(50)
    if (cached.length > 0) {
      res.json({ data: cached, error: null, meta: { source: 'cache' } })
      return
    }
  }
  const conn = (await getAdminSfConnection()) ?? (await getSfConnection(req.user!.id))
  if (!conn) {
    res.status(412).json({ data: null, error: 'errors.salesforce.admin_not_configured', meta: {} })
    return
  }
  try {
    const safe = safeSoqlLiteral(q.slice(0, 80))
    const where = safe ? `WHERE IsActive = true AND (Name LIKE '%${safe}%' OR Email LIKE '%${safe}%')` : 'WHERE IsActive = true'
    const soql = `SELECT Id, Name, Email, IsActive, ManagerId, Title FROM User ${where} ORDER BY Name LIMIT 50`
    const result = await conn.query<{ Id: string; Name: string; Email: string | null; IsActive: boolean; ManagerId: string | null; Title: string | null }>(soql)
    const rows = result.records.map((r) => ({ id: r.Id, name: r.Name, email: r.Email, isActive: r.IsActive }))
    if (rows.length > 0) {
      // Cache upsert is best-effort — a mid-deploy schema mismatch or
      // read-only replica shouldn't hide search results from the admin.
      try {
        await db
          .insert(crmUsers)
          .values(result.records.map((r) => ({ id: r.Id, name: r.Name, email: r.Email, managerId: r.ManagerId, title: r.Title, isActive: r.IsActive })))
          .onConflictDoUpdate({
            target: crmUsers.id,
            set: {
              name: sql`excluded.name`,
              email: sql`excluded.email`,
              managerId: sql`excluded.manager_id`,
              title: sql`excluded.title`,
              isActive: sql`excluded.is_active`,
              lastSyncedAt: new Date(),
            },
          })
      } catch (err) {
        console.warn('[/sf/users] upsert failed (returning search results anyway):', err instanceof Error ? err.message : String(err))
      }
    }
    res.json({ data: rows, error: null, meta: { source: 'live' } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Salesforce User query failed: ${message}`, meta: {} })
  }
})

// GET /api/admin/users/by-sf/:crmUserId — resolves a Salesforce User Id
// to the linked ImpactIQ user (via users.crmUserId). Used by the Team
// Manager picker: admin picks in the SF results list, we translate to
// the ImpactIQ user id that the teams.manager_user_id FK expects.
crmMetadataRoutes.get('/users/by-sf/:crmUserId', requireAppAdmin, async (req, res) => {
  const crmUserId = String(req.params['crmUserId'] ?? '')
  // v1.406.0: on HubSpot the id is an owner id, and an owner stands for a
  // user by manual link or, failing that, by email.
  if ((await getCrmProviderId()) === 'hubspot') {
    res.json({ data: await getUserForHubspotOwner(crmUserId), error: null, meta: {} })
    return
  }
  const [row] = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(eq(users.crmUserId, crmUserId)).limit(1)
  res.json({ data: row ?? null, error: null, meta: {} })
})

// GET /api/admin/users/:userId/sf-details — returns the SF Title and
// Manager Name for the user's linked Salesforce User, read from the
// crm_users cache. If the manager row isn't cached locally, we hit
// Salesforce once to fetch it and upsert. Returns nulls when the user
// isn't linked or SF isn't reachable.
crmMetadataRoutes.get('/users/:userId/sf-details', requireAppAdmin, async (req, res) => {
  try {
  const userId = String(req.params['userId'] ?? '')
  // v1.406.0: HubSpot owners have no Title or Manager; show their teams.
  if ((await getCrmProviderId()) === 'hubspot') {
    const owner = await getHubspotOwnerDetailsForUser(userId)
    res.json({ data: { title: null, managerName: null, managerId: null, teams: (owner?.teams ?? []).map((t) => t.name) }, error: null, meta: {} })
    return
  }
  const [row] = await db.select({ crmUserId: users.crmUserId }).from(users).where(eq(users.id, userId)).limit(1)
  if (!row?.crmUserId) { res.json({ data: { title: null, managerName: null, managerId: null }, error: null, meta: {} }); return }
  let [sfu] = await db.select({ title: crmUsers.title, managerId: crmUsers.managerId, name: crmUsers.name, email: crmUsers.email, isActive: crmUsers.isActive }).from(crmUsers).where(eq(crmUsers.id, row.crmUserId)).limit(1)

  // If the cache row predates migration 0061 (title added later) or hasn't
  // been refreshed since Salesforce backfilled the Title/ManagerId, hit
  // Salesforce once now and upsert. Ensures the Title chip populates for
  // users linked before this feature shipped.
  const needsRefresh = !sfu || sfu.title == null || sfu.managerId == null
  if (needsRefresh) {
    const conn = (await getAdminSfConnection()) ?? (await getSfConnection(req.user!.id))
    if (conn) {
      try {
        const q = await conn.query<{ Id: string; Name: string; Email: string | null; IsActive: boolean; Title: string | null; ManagerId: string | null }>(
          `SELECT Id, Name, Email, IsActive, Title, ManagerId FROM User WHERE Id = '${safeSoqlLiteral(row.crmUserId)}' LIMIT 1`,
        )
        const live = q.records[0]
        if (live) {
          await db
            .insert(crmUsers)
            .values({ id: live.Id, name: live.Name, email: live.Email, title: live.Title, managerId: live.ManagerId, isActive: live.IsActive })
            .onConflictDoUpdate({
              target: crmUsers.id,
              set: {
                name: sql`excluded.name`,
                email: sql`excluded.email`,
                title: sql`excluded.title`,
                managerId: sql`excluded.manager_id`,
                isActive: sql`excluded.is_active`,
                lastSyncedAt: new Date(),
              },
            })
          sfu = { title: live.Title, managerId: live.ManagerId, name: live.Name, email: live.Email, isActive: live.IsActive }
        }
      } catch (err) {
        console.warn('[admin/sf-details] user refresh failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  let managerName: string | null = null
  if (sfu?.managerId) {
    const [m] = await db.select({ name: crmUsers.name }).from(crmUsers).where(eq(crmUsers.id, sfu.managerId)).limit(1)
    if (m) {
      managerName = m.name
    } else {
      // Manager not cached — one-off SF fetch and upsert so subsequent
      // opens don't re-query.
      const conn = (await getAdminSfConnection()) ?? (await getSfConnection(req.user!.id))
      if (conn) {
        try {
          const q = await conn.query<{ Id: string; Name: string; Email: string | null; IsActive: boolean; Title: string | null }>(
            `SELECT Id, Name, Email, IsActive, Title FROM User WHERE Id = '${safeSoqlLiteral(sfu.managerId)}' LIMIT 1`,
          )
          const mgr = q.records[0]
          if (mgr) {
            managerName = mgr.Name
            await db
              .insert(crmUsers)
              .values({ id: mgr.Id, name: mgr.Name, email: mgr.Email, title: mgr.Title, isActive: mgr.IsActive })
              .onConflictDoUpdate({
                target: crmUsers.id,
                set: { name: sql`excluded.name`, email: sql`excluded.email`, title: sql`excluded.title`, isActive: sql`excluded.is_active`, lastSyncedAt: new Date() },
              })
          }
        } catch (err) {
          console.warn('[admin/sf-details] manager lookup failed:', err instanceof Error ? err.message : String(err))
        }
      }
    }
  }
  res.json({ data: { title: sfu?.title ?? null, managerName, managerId: sfu?.managerId ?? null }, error: null, meta: {} })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/admin/users/:userId/sf-details] failed:', msg)
    res.json({ data: { title: null, managerName: null, managerId: null }, error: msg, meta: {} })
  }
})

// GET /api/admin/sf/departments?q= — distinct User.Department values
// on the connected SF org. Used by the Team Management picker to
// link an ImpactIQ team to a Salesforce Department. Cached per-tenant
// via the sfObjects TTL is not necessary — this is a small SOQL
// query that runs once per admin edit.
crmMetadataRoutes.get('/sf/departments', requireAppAdmin, async (req, res) => {
  const q = (typeof req.query['q'] === 'string' ? req.query['q'] : '').trim()
  // v1.406.0: on HubSpot a team links to HubSpot teams, read from the owner
  // copy; Refresh re-syncs the owners first.
  if ((await getCrmProviderId()) === 'hubspot') {
    if (req.query['refresh'] === '1') {
      try {
        await runHubspotOwnerSync({ source: 'manual' })
      } catch (err) {
        res.status(502).json({ data: null, error: err instanceof HubspotError ? err.code : 'errors.hubspot.bad_response', meta: {} })
        return
      }
    }
    res.json({ data: await listHubspotTeamNames(q.slice(0, 80)), error: null, meta: { source: 'hubspot_owners' } })
    return
  }
  const conn = (await getAdminSfConnection()) ?? (await getSfConnection(req.user!.id))
  if (!conn) {
    res.status(412).json({ data: null, error: 'errors.salesforce.admin_not_configured', meta: {} })
    return
  }
  try {
    const safe = safeSoqlLiteral(q.slice(0, 80))
    const where = safe
      ? `WHERE Department != null AND IsActive = true AND Department LIKE '%${safe}%'`
      : `WHERE Department != null AND IsActive = true`
    const soql = `SELECT Department FROM User ${where} GROUP BY Department ORDER BY Department LIMIT 200`
    const result = await conn.query<{ Department: string }>(soql)
    const departments = Array.from(new Set(result.records.map((r) => r.Department).filter(Boolean))).sort((a, b) => a.localeCompare(b))
    res.json({ data: departments, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Salesforce Department query failed: ${message}`, meta: {} })
  }
})

crmMetadataRoutes.get('/sf/picklist-values', requireAppAdmin, async (req, res) => {
  const objectParam = req.query['object']
  const fieldParam = req.query['field']
  if (objectParam !== 'Event' && objectParam !== 'Task') {
    res.status(400).json({ data: null, error: 'errors.salesforce.invalid_object_type', meta: {} })
    return
  }
  if (typeof fieldParam !== 'string' || !fieldParam) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }
  const conn = (await getAdminSfConnection()) ?? (await getSfConnection(req.user!.id))
  if (!conn) {
    res.status(412).json({ data: null, error: 'errors.salesforce.admin_not_configured', meta: {} })
    return
  }
  try {
    const meta = await conn.sobject(objectParam).describe()
    const field = meta.fields.find((f) => f.name === fieldParam)
    if (!field) {
      res.status(404).json({ data: null, error: `Field ${fieldParam} not found on ${objectParam}`, meta: {} })
      return
    }
    const values = Array.isArray(field.picklistValues)
      ? field.picklistValues.map((v) => ({ value: v.value, label: v.label ?? v.value, active: v.active !== false }))
      : []
    res.json({ data: { object: objectParam, field: fieldParam, values }, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Salesforce describe failed: ${message}`, meta: {} })
  }
})
