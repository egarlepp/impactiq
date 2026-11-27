import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { getSfConnection, getAdminSfConnectionRecord } from '../services/salesforce/client.js'
import { salesforceProvider } from '../services/crm/salesforceProvider.js'
import { requireCrmProvider } from '../services/crm/index.js'
import { requireCrmProjects } from '../services/criteriaiq/evaluationSource.js'
import { isCriteriaIqProjectLink } from '../../shared/evaluationSource.js'
import { getCrmFeatures } from '../services/crm/features.js'
import { findSuggestionsForEmails } from '../services/salesforce/contacts.js'
import { safeSoqlLiteral } from '../services/salesforce/soql.js'
import { loadSeFilterFieldApis, resolveSeFilterFields } from '../services/salesforce/seFilter.js'
import { getSfInternalDomains } from '../services/config/integrations.js'
import { readSnapshot, mergePreview, isImpactIqUserName, SF_ID_RX } from '../services/salesforce/preview.js'
import { getAccessibleTeamIds } from '../middleware/rbac.js'
import { resolveUserLookupNames, resolveOwnerLookupNames } from '../services/salesforce/resolveLookupNames.js'
import { describeFieldCapacity, formatDateMMDDYY } from '../services/salesforce/fieldPrepend.js'
import { computeInitials, formatEntry, computeCapacity } from '../../shared/sfFieldPrepend.js'
import { logAudit } from '../services/audit/log.js'
import { logSfSyncAttempt } from '../services/salesforce/syncAudit.js'
import { db } from '../db/index.js'
import { users, activities, crmFieldMappings, crmFieldMappingTeams } from '../../../drizzle/schema.js'
import { eq, and, ne } from 'drizzle-orm'
import { checkSfRecordsExist } from '../services/salesforce/referenceResolver.js'
import { canViewActivityById } from '../services/activities/access.js'
import { isDemoCrmId } from '../services/demo/ids.js'

// Stub Salesforce results were previously returned any time
// NODE_ENV === 'development' AND the caller didn't have a personal
// SF OAuth token. That meant a tenant admin who correctly wired up
// SF at the org level (and passed the Admin Test Connection) still
// saw fake "stub-001" data because their per-user OAuth was empty.
// Fix: only return stubs when SF has never been configured on this
// tenant AND an explicit opt-in env flag is set. Once the admin
// integration record exists, stubs are off — callers who haven't
// personally connected get a proper 401.
async function stubsAllowed(): Promise<boolean> {
  if (process.env['IMPACTIQ_ENABLE_SF_STUBS'] !== '1') return false
  const admin = await getAdminSfConnectionRecord()
  return !admin
}

export const salesforceRouter = Router()

salesforceRouter.use(requireAuth)

// Dedicated per-user throttle on top of the generous shared global limiter —
// real hardening follow-up from the go-live security audit. Every route on this
// router either calls out to live Salesforce (a shared, metered org-level
// API budget) or reads/writes activity-linked SF data, so it's throttled as
// a whole rather than picking out individual "expensive" endpoints — new
// routes added here later inherit the same protection with no extra step.
// 60/min per user comfortably covers real typeahead search + drawer usage.
salesforceRouter.use(rateLimit({ windowMs: 60 * 1000, max: 60, keyFn: (req) => req.user!.id }))

// One CRM per install: every route here is Salesforce-only, so when the
// install's crm_provider is anything else they all answer 409.
salesforceRouter.use(requireCrmProvider('salesforce'))

// GET /api/salesforce/search/opportunities?q=&teamId=&open=true&showClosed=true
salesforceRouter.get('/search/opportunities', async (req, res) => {
  const query = (typeof req.query['q'] === 'string' ? req.query['q'] : '')
  const openSearch = req.query['open'] === 'true'
  const showClosed = req.query['showClosed'] === 'true'
  const userId = req.user!.id

  if (query.length < 2) {
    res.json({ data: [], error: null, meta: {} })
    return
  }

  const session = await salesforceProvider.connectForUser(userId)
  if (!session) {
    // Return stub results in dev when SF not connected
    if (await stubsAllowed()) {
      res.json({
        data: [
          { Id: 'stub-001', Name: `${query} - Acme Corp`, StageName: 'Eval', AccountId: 'stub-acct-001', AccountName: 'Acme Corp', CloseDate: '2026-12-31' },
          { Id: 'stub-002', Name: `${query} - Beta Systems`, StageName: 'Discovery', AccountId: 'stub-acct-002', AccountName: 'Beta Systems', CloseDate: '2026-09-30' },
        ],
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }

  // teamId only picks which team's SE filter mappings apply (v1.474.0).
  const teamId = typeof req.query['teamId'] === 'string' && req.query['teamId'] ? req.query['teamId'] : null
  const results = await session.searchOpportunities(query, { openSearch, showClosed, teamId })
  res.json({ data: results, error: null, meta: {} })
})

// GET /api/salesforce/search/accounts?q=
salesforceRouter.get('/search/accounts', async (req, res) => {
  const query = (typeof req.query['q'] === 'string' ? req.query['q'] : '')
  const userId = req.user!.id

  if (query.length < 2) {
    res.json({ data: [], error: null, meta: {} })
    return
  }

  const session = await salesforceProvider.connectForUser(userId)
  if (!session) {
    if (await stubsAllowed()) {
      res.json({
        data: [
          { Id: 'stub-acct-001', Name: `${query} Corporation`, Industry: 'Technology' },
          { Id: 'stub-acct-002', Name: `${query} Industries`, Industry: 'Manufacturing' },
        ],
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }

  const results = await session.searchAccounts(query)
  res.json({ data: results, error: null, meta: {} })
})

// GET /api/salesforce/me/tz — returns the caller's Salesforce User
// timezone (User.TimeZoneSidKey). Used by Settings so users can see
// their SF timezone alongside their Outlook timezone. Null when the
// user hasn't personally authorized SF.
salesforceRouter.get('/me/tz', async (req, res) => {
  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.json({ data: { timezone: null }, error: null, meta: {} }); return }
  try {
    const info = await conn.identity()
    const userId = info.user_id
    const q = await conn.query(`SELECT TimeZoneSidKey FROM User WHERE Id = '${safeSoqlLiteral(userId)}' LIMIT 1`)
    const first = q.records[0] as { TimeZoneSidKey?: string } | undefined
    res.json({ data: { timezone: first?.TimeZoneSidKey ?? null }, error: null, meta: {} })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof Error ? err.message : String(err), meta: {} })
  }
})

// GET /api/salesforce/search/users?q= — non-admin SF User search used by
// the Meeting Owner picker. Any authenticated caller can hit this via
// their own per-user SF OAuth (admin fallback if the caller hasn't
// personally connected). Returns id + name + email for up to 20 rows.
salesforceRouter.get('/search/users', async (req, res) => {
  const query = ((typeof req.query['q'] === 'string' ? req.query['q'] : '')).trim()
  const userId = req.user!.id
  if (query.length < 2) { res.json({ data: [], error: null, meta: {} }); return }
  let conn = await getSfConnection(userId)
  if (!conn) {
    const { getAdminSfConnection } = await import('../services/salesforce/client.js')
    conn = await getAdminSfConnection()
  }
  if (!conn) {
    if (await stubsAllowed()) {
      res.json({
        data: [
          { Id: 'stub-user-001', Name: `${query} Nguyen`, Email: `${query}.nguyen@example.com` },
          { Id: 'stub-user-002', Name: `${query} Silva`, Email: `${query}.silva@example.com` },
        ],
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  try {
    const safe = safeSoqlLiteral(query).slice(0, 80)
    const soql = `SELECT Id, Name, Email FROM User WHERE IsActive = true AND (Name LIKE '%${safe}%' OR Email LIKE '%${safe}%') ORDER BY Name LIMIT 20`
    const result = await conn.query<{ Id: string; Name: string; Email: string | null }>(soql)
    res.json({ data: result.records, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Salesforce User query failed: ${message}`, meta: {} })
  }
})

// GET /api/salesforce/search/contacts?q=
salesforceRouter.get('/search/contacts', async (req, res) => {
  const query = (typeof req.query['q'] === 'string' ? req.query['q'] : '')
  const userId = req.user!.id
  if (query.length < 2) { res.json({ data: [], error: null, meta: {} }); return }
  const session = await salesforceProvider.connectForUser(userId)
  if (!session) {
    if (await stubsAllowed()) {
      res.json({
        data: [
          { Id: 'stub-contact-001', Name: `${query} Jones`, Email: `${query}.jones@example.com`, AccountName: 'Stub Corp', Title: 'CTO' },
          { Id: 'stub-contact-002', Name: `${query} Patel`, Email: `${query}.patel@example.com`, AccountName: 'Stub Industries', Title: 'VP Engineering' },
        ],
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  const results = await session.searchContacts(query)
  res.json({ data: results, error: null, meta: {} })
})

// GET /api/salesforce/search/leads?q=
salesforceRouter.get('/search/leads', async (req, res) => {
  if (!(await getCrmFeatures()).leadsEnabled) {
    res.status(403).json({ data: null, error: 'errors.crm.leads_disabled', meta: {} })
    return
  }
  const query = (typeof req.query['q'] === 'string' ? req.query['q'] : '')
  const userId = req.user!.id
  if (query.length < 2) { res.json({ data: [], error: null, meta: {} }); return }
  const session = await salesforceProvider.connectForUser(userId)
  if (!session) {
    if (await stubsAllowed()) {
      res.json({
        data: [
          { Id: 'stub-lead-001', Name: `${query} Prospect`, Email: `${query}@lead-inc.example`, Company: `${query} Inc`, Status: 'Working - Contacted' },
          { Id: 'stub-lead-002', Name: `${query} Contact`, Email: `hello@${query}-labs.example`, Company: `${query} Labs`, Status: 'Open - Not Contacted' },
        ],
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  const results = await session.searchLeads(query)
  res.json({ data: results, error: null, meta: {} })
})

// v1.94.0: GET /api/salesforce/search/from-attendees?emails=a,b,c
// Returns Accounts + Opportunities linked to Contacts whose Email matches
// any of the attendee emails. Powers the "Suggested from attendees" section
// at the top of the SfSearch popover so the SE sees plausible SF links
// without typing. Reuses the same primitive that outlook_events uses to
// cache chip suggestions; no new SOQL shape.
salesforceRouter.get('/search/from-attendees', async (req, res) => {
  const raw = (req.query['emails'] as string | undefined) ?? ''
  const emails = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const userId = req.user!.id
  if (emails.length === 0) { res.json({ data: { accounts: [], opportunities: [] }, error: null, meta: {} }); return }
  const conn = await getSfConnection(userId)
  if (!conn) { res.json({ data: { accounts: [], opportunities: [] }, error: null, meta: {} }); return }
  try {
    const { findSuggestionsForEmails } = await import('../services/salesforce/contacts.js')
    const { accounts, opportunities } = await findSuggestionsForEmails(conn, emails)
    res.json({
      data: {
        accounts: accounts.map((a) => ({ Id: a.Id, Name: a.Name, matchedEmail: a.contactEmail })),
        opportunities: opportunities.map((o) => ({ Id: o.Id, Name: o.Name, AccountId: o.AccountId, AccountName: o.AccountName, StageName: o.StageName, Amount: o.Amount, CloseDate: o.CloseDate, ForecastCategoryName: o.ForecastCategoryName, OwnerName: o.OwnerName, matchedEmail: o.contactEmail })),
      },
      error: null,
      meta: {},
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Attendee search failed: ${message}`, meta: {} })
  }
})

// GET /api/salesforce/search/campaigns?q=&attendeeEmails=a@x.com,b@y.com
// Combines free-text campaign search with attendee-linked campaigns via
// CampaignMember. See searchCampaigns for the ranking logic.
salesforceRouter.get('/search/campaigns', async (req, res) => {
  if (!(await getCrmFeatures()).campaignsEnabled) {
    res.status(403).json({ data: null, error: 'errors.crm.campaigns_disabled', meta: {} })
    return
  }
  const query = (typeof req.query['q'] === 'string' ? req.query['q'] : '')
  const attendeeEmailsRaw = typeof req.query['attendeeEmails'] === 'string' ? req.query['attendeeEmails'] : ''
  const attendeeEmails = attendeeEmailsRaw ? attendeeEmailsRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  const userId = req.user!.id
  if (query.length < 2 && attendeeEmails.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
  const session = await salesforceProvider.connectForUser(userId)
  if (!session) {
    if (await stubsAllowed()) {
      const baseName = query.length >= 2 ? query : 'Q1'
      res.json({
        data: [
          { Id: 'stub-camp-001', Name: `${baseName} - Product Launch`, Status: 'In Progress', Type: 'Webinar', StartDate: '2026-01-15', EndDate: '2026-03-15', CreatedByName: 'Demo User', IsActive: true, attendeeMatchCount: attendeeEmails.length > 0 ? 2 : undefined },
          { Id: 'stub-camp-002', Name: `${baseName} - Nurture Track`, Status: 'Planned', Type: 'Email', StartDate: '2026-02-01', EndDate: '2026-04-30', CreatedByName: 'Demo User', IsActive: true },
        ],
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  try {
    const results = await session.searchCampaigns(query, attendeeEmails)
    res.json({ data: results, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Campaign search failed: ${message}`, meta: {} })
  }
})

// POST /api/salesforce/opportunities/accounts { ids: string[] }
// Batch-resolve the linked Account for each Opportunity id. Used by the
// activity list to render an "Account:" chip alongside the "Opportunity:" link
// without adding new columns to the activities table.
salesforceRouter.post('/opportunities/accounts', async (req, res) => {
  const userId = req.user!.id
  const body = req.body as { ids?: unknown }
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
  if (ids.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) {
      res.json({
        data: ids.map((id, i) => ({ id, accountId: `stub-acct-${i}`, accountName: `Stub Account ${i + 1}` })),
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  const escaped = ids.map((id) => `'${safeSoqlLiteral(id)}'`).join(',')
  const soql = `SELECT Id, AccountId, Account.Name FROM Opportunity WHERE Id IN (${escaped})`
  try {
    const q = await conn.query<{ Id: string; AccountId: string | null; Account: { Name: string } | null }>(soql)
    const rows = q.records.map((r) => ({ id: r.Id, accountId: r.AccountId, accountName: r.Account?.Name ?? null }))
    res.json({ data: rows, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
  }
})

// In-memory override cache for the Opportunity's Assigned SE field — covers two cases:
//   1) dev / stub mode with no live SF connection: the PATCH can't reach SF,
//      so we cache locally and the GET returns the cached value. Makes the
//      demo feel real end-to-end.
//   2) live SF mode: a very short-lived write-through so a card that
//      re-renders immediately after save doesn't race SF's own read
//      consistency and see the pre-write value.
interface AssignedSeOverride { userId: string | null; userName: string | null; at: number }
const ASSIGNED_SE_OVERRIDE_TTL_MS = 5 * 60 * 1000
const assignedSeOverrides = new Map<string, AssignedSeOverride>()

function getAssignedSeOverride(oppId: string): AssignedSeOverride | null {
  const hit = assignedSeOverrides.get(oppId)
  if (!hit) return null
  if (Date.now() - hit.at > ASSIGNED_SE_OVERRIDE_TTL_MS) { assignedSeOverrides.delete(oppId); return null }
  return hit
}

// v1.297.0: the field the Assigned SE picker actually reads/writes, resolved
// from the team's `assigned_se_write` mapping (App Admin-configurable in
// SF Field Mappings) — see the writeup on CLAUDE.md §21's former "known
// exception". Distinct from the
// assigned_se_name mapping used by the Inline Record Preview popover and
// nightly refresh (services/salesforce/refreshOppSnapshots.ts) — that one
// may legitimately point at a read-only relationship path like
// Assigned_SE__r.Name, which can never be a write target.
//
// Resolves team assignment via the crm_field_mapping_teams junction table,
// NOT crmFieldMappings.teamId directly — same rationale as the v1.297.0
// nudge/keyword rule fix (CLAUDE.md §11): every other real consumer
// (writeback.ts's buildSfRecord, mappingValidation.ts, the Evaluation field
// editor below) already resolves team-scoped mappings through this junction,
// since that's what the admin's "Assign to teams" picker actually writes to.
// Filtering on the base column here would have silently stopped working the
// moment an admin reassigned this exact mapping to another team.
// v1.474.0: no fallback field. An org's Assigned SE field is its own custom
// field, so with nothing mapped (or no team given) the picker is simply not
// configured (meta.configured = false, which the activity form already
// handles by hiding it), same as HubSpot's assigned_se_write.
async function resolveAssignedSeWriteField(teamId: string | null): Promise<string | null> {
  if (!teamId) return null
  const [row] = await db
    .select({ api: crmFieldMappings.crmFieldApi })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(
      eq(crmFieldMappingTeams.teamId, teamId),
      eq(crmFieldMappings.appField, 'assigned_se_write'),
      eq(crmFieldMappings.isActive, true),
      ne(crmFieldMappings.direction, 'read'),
    ))
    .limit(1)
  const api = row?.api?.trim() ?? ''
  return SF_FIELD_API_NAME_RX.test(api) ? api : null
}

const SF_FIELD_API_NAME_RX = /^[A-Za-z0-9_]{1,80}$/

// GET /api/salesforce/opportunities/:id/assigned-se?teamId=
// Read the Assigned SE value + its resolved Name. Used by the activity edit
// drawer to display and prefill the Assigned SE field on Opp-linked
// activities. `teamId` (v1.297.0) resolves the team's `assigned_se_write`
// mapping (see resolveAssignedSeWriteField above) so this reads from
// whatever field the PATCH below would actually write to — falls back to
// the legacy 3-candidate fallback chain when unmapped or teamId is omitted.
salesforceRouter.get('/opportunities/:id/assigned-se', async (req, res) => {
  const userId = req.user!.id
  const { id } = req.params as { id: string }
  const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : null
  if (!id) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  const writeField = await resolveAssignedSeWriteField(teamId)
  if (!writeField) {
    res.json({ data: { userId: null, userName: null, matched: null }, error: null, meta: { configured: false, writeField: null } })
    return
  }
  // Override cache short-circuits both SF reads and stub responses — a
  // recent client PATCH wins so the UI is consistent.
  const override = getAssignedSeOverride(id)
  if (override) {
    const matched = await isImpactIqUserName(override.userName)
    res.json({ data: { userId: override.userId, userName: override.userName, matched }, error: null, meta: { writeField } })
    return
  }
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) {
      res.json({ data: { userId: null, userName: null, matched: null }, error: null, meta: { stub: true, writeField } })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  // The mapped write field is read first. When it's empty, the team's SE
  // filter fields (v1.474.0, CRM Field Mappings → opp_se_filter) are tried
  // in order, so the card doesn't say "Unassigned" just because a sibling
  // field is the one filled in. Multi-select fields are skipped (they name
  // several people), and so is any field this org doesn't have.
  const seFields = await resolveSeFilterFields(conn, await loadSeFilterFieldApis(teamId))
  const candidateFields = Array.from(new Set([
    writeField,
    ...seFields.filter((f) => f.type !== 'multipicklist' && f.type !== null).map((f) => f.api),
  ]))
  const soql = `SELECT Id, ${candidateFields.join(', ')} FROM Opportunity WHERE Id = '${safeSoqlLiteral(id)}' LIMIT 1`
  try {
    const q = await conn.query<Record<string, string | null>>(soql)
    const row = q.records[0]
    if (!row) { res.json({ data: { userId: null, userName: null, matched: null }, error: null, meta: { writeField } }); return }
    const value = candidateFields.reduce<string | null>((acc, f) => acc ?? (row[f] ?? null), null)
    // v1.279.0: usually a literal picklist string, not an SF User Id, so
    // "is this person in ImpactIQ" is matched against display names, the
    // same fallback the Attach Rate breakdowns and record preview use.
    const matched = await isImpactIqUserName(value)
    res.json({ data: { userId: value, userName: value, matched }, error: null, meta: { writeField } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: { writeField } })
  }
})

// PATCH /api/salesforce/opportunities/:id/assigned-se { userId, userName, teamId }
// Write back to the team's configured Assigned SE write-target field (409
// when none is mapped). Separate from the activity write
// pipeline because it targets Opportunity, not Event/Task.
// v1.297.0: previously always hardcoded Assigned_SE__c regardless of what
// Admin -> SF Field Mappings said — an admin who pointed the READ-side
// assigned_se_name mapping elsewhere saw their picker read from it (in
// theory; the picker's own GET was ALSO hardcoded until this same pass) but
// writes silently kept going to Assigned_SE__c. Now resolves the team's
// assigned_se_write mapping via resolveAssignedSeWriteField so read and write are finally the same
// field, and that field is surfaced back to the caller.
salesforceRouter.patch('/opportunities/:id/assigned-se', async (req, res) => {
  const userId = req.user!.id
  const { id } = req.params as { id: string }
  const body = req.body as { userId?: unknown; userName?: unknown; teamId?: unknown }
  const newAssignee = typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : null
  const newAssigneeName = typeof body.userName === 'string' ? body.userName : null
  const teamId = typeof body.teamId === 'string' && body.teamId.length > 0 ? body.teamId : null
  if (!id) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  const writeField = await resolveAssignedSeWriteField(teamId)
  if (!writeField) {
    res.status(409).json({ data: null, error: 'errors.salesforce.assigned_se_not_configured', meta: { configured: false } })
    return
  }

  // Resolve the display name — either from the client (fast path) or from
  // the local crm_users cache (fallback). Falls back to null if neither has
  // the assignee, which is fine for the Unassign path.
  let resolvedName: string | null = newAssigneeName
  if (!resolvedName && newAssignee) {
    const { crmUsers } = await import('../../../drizzle/schema.js')
    const [row] = await db.select({ name: crmUsers.name }).from(crmUsers).where(eq(crmUsers.id, newAssignee)).limit(1)
    resolvedName = row?.name ?? null
  }
  const recordOverride = () => { assignedSeOverrides.set(id, { userId: newAssignee, userName: resolvedName, at: Date.now() }) }

  const conn = await getSfConnection(userId)
  if (!conn) {
    // Dev / stub mode: still remember the write so the UI reflects it end
    // to end. Live-mode callers should have a real conn — this branch is
    // strictly for demos and local dev.
    if (await stubsAllowed()) {
      recordOverride()
      res.json({ data: { id, assignedSeUserId: newAssignee, writeField }, error: null, meta: { stub: true } })
      return
    }
    // v1.121.0: refuse instead of silently dropping the write —
    // otherwise the client-side cache reflects a value that never
    // reaches Salesforce.
    res.status(409).json({ data: null, error: 'errors.salesforce.not_connected_write', meta: { field: writeField } })
    return
  }
  try {
    await conn.sobject('Opportunity').update({ Id: id, [writeField]: newAssignee })
    recordOverride()
    void logSfSyncAttempt({
      source: 'assigned_se_update', status: 'success', operation: 'update', crmObject: 'Opportunity', crmRecordId: id,
      userId, payload: { [writeField]: newAssignee, assigneeName: resolvedName },
    })
    res.json({ data: { id, assignedSeUserId: newAssignee, writeField }, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    void logSfSyncAttempt({
      source: 'assigned_se_update', status: 'failed', operation: 'update', crmObject: 'Opportunity', crmRecordId: id,
      userId, errorMessage: message, payload: { [writeField]: newAssignee },
    })
    res.status(502).json({ data: null, error: `errors.salesforce.write_failed: ${message}`, meta: {} })
  }
})

// GET /api/salesforce/accounts/:id/contacts?q= — contacts filtered by
// v1.69.0: list of SF sobjects the caller can query. Used to populate
// the SObject dropdowns in the Admin → Activity Types → Salesforce
// Extras editor so admins don't have to type API names. Filtered to
// queryable non-deprecated objects. Custom (`__c`) objects surface
// alongside a small allowlist of standards.
salesforceRouter.get('/sobjects', async (req, res) => {
  const userId = req.user!.id
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) { res.json({ data: [], error: null, meta: { stub: true } }); return }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return
  }
  try {
    const global = await conn.describeGlobal()
    const STANDARD_ALLOW = new Set(['Opportunity', 'Account', 'Contact', 'Lead', 'Campaign', 'User', 'Case', 'Task', 'Event'])
    const rows = global.sobjects
      .filter((s) => s.queryable && !s.deprecatedAndHidden && (s.custom || STANDARD_ALLOW.has(s.name)))
      .map((s) => ({ name: s.name, label: s.label, custom: !!s.custom }))
      .sort((a, b) => a.label.localeCompare(b.label))
    res.json({ data: rows, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF describe failed: ${message}`, meta: {} })
  }
})

// v1.69.0: list fields on a given sobject. Powers the API-name field
// dropdowns in the Extras editor (apiName for opp_field_display,
// labelField / parentField for related_object_picker).
salesforceRouter.get('/sobjects/:sobject/fields', async (req, res) => {
  const userId = req.user!.id
  const { sobject } = req.params as { sobject: string }
  if (!/^[A-Za-z0-9_]{1,80}$/.test(sobject)) {
    res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} }); return
  }
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) { res.json({ data: [], error: null, meta: { stub: true } }); return }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return
  }
  try {
    const meta = await conn.sobject(sobject).describe()
    const rows = meta.fields
      .filter((f) => !f.deprecatedAndHidden)
      .map((f) => ({ name: f.name, label: f.label, type: f.type, updateable: !!f.updateable, referenceTo: f.referenceTo ?? [] }))
      .sort((a, b) => a.label.localeCompare(b.label))
    res.json({ data: rows, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF describe failed: ${message}`, meta: {} })
  }
})

// v1.69.0: write a field back to an SF Opportunity. Powers the
// read/write mode on opp_field_display extras. Path validation is
// strict — apiName must be an identifier so it can be inlined into
// the update object safely.
salesforceRouter.patch('/opportunities/:id/field', async (req, res) => {
  const userId = req.user!.id
  const { id } = req.params as { id: string }
  const parsed = z.object({ apiName: z.string().min(1).max(80).regex(/^[A-Za-z0-9_]+$/), value: z.unknown() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) { res.json({ data: { ok: true }, error: null, meta: { stub: true } }); return }
    // v1.121.0: 409 (not 401) so the client renders a reconnect
    // nudge instead of treating it as an auth failure.
    res.status(409).json({ data: null, error: 'errors.salesforce.not_connected_write', meta: { field: parsed.data.apiName } }); return
  }
  try {
    const fieldUpdate: Record<string, unknown> = Object.fromEntries([[parsed.data.apiName, parsed.data.value]])
    await conn.sobject('Opportunity').update({ ...fieldUpdate, Id: id })
    void logSfSyncAttempt({
      source: 'opportunity_field_update', status: 'success', operation: 'update', crmObject: 'Opportunity', crmRecordId: id,
      userId, payload: fieldUpdate,
    })
    res.json({ data: { ok: true }, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    void logSfSyncAttempt({
      source: 'opportunity_field_update', status: 'failed', operation: 'update', crmObject: 'Opportunity', crmRecordId: id,
      userId, errorMessage: message, payload: { apiName: parsed.data.apiName },
    })
    res.status(502).json({ data: null, error: `errors.salesforce.write_failed: ${message}`, meta: {} })
  }
})

// v1.67.0: activity-type SF Extras — generic read of a single field on
// the linked Opportunity. Powers "opp_field_display" extras (e.g. the
// RFP_Request__c checkbox surfaced on the RFx Work activity form).
// apiName is restricted to identifier characters so the value can be
// safely inlined into SOQL.
salesforceRouter.get('/opportunities/:id/field', async (req, res) => {
  const userId = req.user!.id
  const { id } = req.params as { id: string }
  const apiName = String(req.query['apiName'] ?? '')
  if (!id || !apiName) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!/^[A-Za-z0-9_]{1,80}$/.test(apiName)) {
    res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} })
    return
  }
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) { res.json({ data: { value: null }, error: null, meta: { stub: true } }); return }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return
  }
  const soql = `SELECT ${apiName} FROM Opportunity WHERE Id = '${safeSoqlLiteral(id)}' LIMIT 1`
  try {
    const q = await conn.query<Record<string, unknown>>(soql)
    const row = q.records[0] ?? null
    const value = row ? row[apiName] : null
    res.json({ data: { value: value ?? null }, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
  }
})

// v1.67.0: activity-type SF Extras — list child records of an SF object
// under an Opportunity. Powers "related_object_picker" extras (e.g. the
// Evaluations picker surfaced on the Eval Work activity form). Config
// on the extras row supplies `sobject` (child API name), `parentField`
// (the SF field on the child that references Opportunity, defaults to
// Opportunity__c), and `labelField` (defaults to Name).
salesforceRouter.get('/opportunities/:id/related', requireCrmProjects(), async (req, res) => {
  const userId = req.user!.id
  const { id } = req.params as { id: string }
  const sobject = String(req.query['sobject'] ?? '')
  const parentField = String(req.query['parentField'] ?? 'Opportunity__c')
  const labelField = String(req.query['labelField'] ?? 'Name')
  if (!id || !sobject) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  const idRx = /^[A-Za-z0-9_]{1,80}$/
  if (!idRx.test(sobject) || !idRx.test(parentField) || !idRx.test(labelField)) {
    res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} })
    return
  }
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) { res.json({ data: [], error: null, meta: { stub: true } }); return }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return
  }
  const soql = `SELECT Id, ${labelField} FROM ${sobject} WHERE ${parentField} = '${safeSoqlLiteral(id)}' ORDER BY ${labelField} LIMIT 100`
  try {
    const q = await conn.query<Record<string, unknown>>(soql)
    const rows = q.records.map((r) => ({ id: String(r['Id']), name: String(r[labelField] ?? '(unnamed)') }))
    res.json({ data: rows, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
  }
})

// v1.148.0 / v1.149.0: Evaluation ("Project") field integration. Never
// hardcode Status__c / POC_Stage__c / Evaluation_Type__c / etc. — always
// resolve the live SF API name via crm_field_mappings, per CLAUDE.md §21.
// v1.149.0 also stops hardcoding the OBJECT name: the SF object is passed
// by the client (cfg.sobject / crmRelatedType, e.g. "Evaluations__c") and
// the mappings are looked up by that object, so any tenant's Evaluation
// object API name works. `appField` keys match migration 0090: eval_name,
// eval_status, eval_stage, eval_type, eval_start_date, eval_end_date.
// v1.285.0: eval_primary_engineer is read-only display (like Assigned SE /
// Primary Engineer on an Opportunity) — it's in this list so the generic
// SELECT/output loop below picks it up, but deliberately NOT in
// EDITABLE_EVAL_FIELDS further down, since there's no in-app UI for a
// contributor to reassign a Project's engineer.
const EVAL_APP_FIELDS = ['eval_name', 'eval_status', 'eval_stage', 'eval_type', 'eval_start_date', 'eval_end_date', 'eval_primary_engineer'] as const
const SOBJECT_RX = /^[A-Za-z0-9_]{1,80}$/

async function loadEvalFieldMappings(teamId: string, sobject: string): Promise<Map<string, { crmFieldApi: string; direction: string; referenceTo: string | null }>> {
  const rows = await db
    .select({ appField: crmFieldMappings.appField, crmFieldApi: crmFieldMappings.crmFieldApi, direction: crmFieldMappings.direction, referenceTo: crmFieldMappings.referenceTo })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(
      eq(crmFieldMappingTeams.teamId, teamId),
      eq(crmFieldMappings.crmObject, sobject),
      eq(crmFieldMappings.isActive, true),
    ))
  return new Map(rows.map((r) => [r.appField, { crmFieldApi: r.crmFieldApi, direction: r.direction, referenceTo: r.referenceTo }]))
}

// In-memory describe() cache keyed by SF object — SF metadata changes
// rarely; mirrors the pattern in admin.ts's /sf/fields. Caches BOTH the
// picklist options (for the dropdowns) AND the set of valid field API
// names (case-insensitive), so we can drop a mis-seeded field name from
// the SELECT rather than failing the whole query.
const EVAL_DESCRIBE_TTL_MS = 60 * 60 * 1000
const evalDescribeCache = new Map<string, { at: number; picklists: Map<string, Array<{ value: string; label: string }>>; fieldNames: Set<string> }>()
async function describeEval(conn: import('jsforce').Connection, sobject: string) {
  const cached = evalDescribeCache.get(sobject)
  if (cached && Date.now() - cached.at < EVAL_DESCRIBE_TTL_MS) return cached
  const meta = await conn.sobject(sobject).describe()
  const picklists = new Map<string, Array<{ value: string; label: string }>>()
  const fieldNames = new Set<string>()
  for (const f of meta.fields) {
    fieldNames.add((f.name ?? '').toLowerCase())
    picklists.set(f.name, Array.isArray(f.picklistValues)
      ? f.picklistValues.filter((v) => v.active).map((v) => ({ value: v.value, label: v.label ?? v.value }))
      : [])
  }
  const entry = { at: Date.now(), picklists, fieldNames }
  evalDescribeCache.set(sobject, entry)
  return entry
}

// GET /api/salesforce/evaluations/picklist-values?teamId=&sobject=&field=eval_status
salesforceRouter.get('/evaluations/picklist-values', requireCrmProjects(), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const sobject = req.query['sobject'] as string | undefined
  const field = req.query['field'] as string | undefined
  if (!teamId || !sobject || !field) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!SOBJECT_RX.test(sobject)) { res.status(400).json({ data: null, error: 'errors.salesforce.invalid_object_type', meta: {} }); return }
  const mappings = await loadEvalFieldMappings(teamId, sobject)
  const mapping = mappings.get(field)
  if (!mapping) { res.json({ data: [], error: null, meta: { unmapped: true } }); return }
  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return }
  try {
    const { picklists } = await describeEval(conn, sobject)
    res.json({ data: picklists.get(mapping.crmFieldApi) ?? [], error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF describe failed: ${message}`, meta: {} })
  }
})

// GET /api/salesforce/evaluations/:relatedId?teamId=&sobject=
// Live read of the mapped Evaluation fields for one record — used by the
// Project panel so it shows current SF values even before the nightly
// refresh has stamped the local snapshot (e.g. a just-linked Project).
salesforceRouter.get('/evaluations/:relatedId', requireCrmProjects(), async (req, res) => {
  const { relatedId } = req.params as { relatedId: string }
  const teamId = req.query['teamId'] as string | undefined
  const sobject = req.query['sobject'] as string | undefined
  if (!teamId || !sobject) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!SOBJECT_RX.test(sobject)) { res.status(400).json({ data: null, error: 'errors.salesforce.invalid_object_type', meta: {} }); return }
  const mappings = await loadEvalFieldMappings(teamId, sobject)
  if (mappings.size === 0) { res.json({ data: null, error: null, meta: { unmapped: true } }); return }
  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return }
  // Build SELECT from the mapped API names (validated as identifiers).
  let selectPairs: Array<[typeof EVAL_APP_FIELDS[number], string]> = []
  for (const appField of EVAL_APP_FIELDS) {
    const m = mappings.get(appField)
    if (m && SOBJECT_RX.test(m.crmFieldApi)) selectPairs.push([appField, m.crmFieldApi])
  }
  if (selectPairs.length === 0) { res.json({ data: null, error: null, meta: { unmapped: true } }); return }
  // v1.150.0: describe the object once and drop any mapped field whose
  // API name doesn't actually exist on it (e.g. a mis-seeded
  // "Eval_EndDate" missing its __c). Previously one bad field failed the
  // whole SELECT and blanked every field in the Project panel.
  const dropped: string[] = []
  try {
    const { fieldNames } = await describeEval(conn, sobject)
    selectPairs = selectPairs.filter(([appField, api]) => {
      const ok = fieldNames.has(api.toLowerCase())
      if (!ok) dropped.push(`${appField}:${api}`)
      return ok
    })
  } catch {
    // If describe fails, fall through and try the SELECT as-is.
  }
  if (selectPairs.length === 0) { res.json({ data: null, error: null, meta: { dropped } }); return }
  const soql = `SELECT ${selectPairs.map(([, api]) => api).join(', ')} FROM ${sobject} WHERE Id = '${safeSoqlLiteral(relatedId)}' LIMIT 1`
  try {
    const q = await conn.query<Record<string, unknown>>(soql)
    const row = q.records[0] ?? null
    if (!row) { res.json({ data: null, error: null, meta: { dropped } }); return }
    const out: Record<string, unknown> = {}
    for (const [appField, api] of selectPairs) out[appField] = row[api] ?? null
    // v1.286.0: a field mapped straight to a Salesforce Lookup(User) (e.g.
    // Evaluations__c's Primary_Engineer__c) comes back as a raw User Id, not
    // a name — resolve it against the local crm_users cache. referenceTo was
    // already captured from describe() at mapping-save time.
    const userLookupFields = selectPairs
      .filter(([appField]) => mappings.get(appField)?.referenceTo === 'User')
      .map(([appField]) => appField)
    if (userLookupFields.length > 0) {
      const nameById = await resolveUserLookupNames(userLookupFields.map((f) => out[f] as string | null))
      for (const f of userLookupFields) {
        const raw = out[f] as string | null
        if (raw) out[f] = nameById.get(raw) ?? raw
      }
    }
    res.json({ data: out, error: null, meta: { dropped } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
  }
})

// PATCH /api/salesforce/evaluations/:relatedId
// Body: { teamId, sobject, fields: { eval_status?, ... } }
// Writes each field LIVE to Salesforce (real API name resolved via
// crm_field_mappings, never hardcoded), then mirrors the values onto every
// activity row's crm_eval_* snapshot columns for that crmRelatedId.
const EDITABLE_EVAL_FIELDS: Record<string, keyof typeof activities.$inferInsert> = {
  eval_status: 'crmEvalStatus',
  eval_stage: 'crmEvalStage',
  eval_type: 'crmEvalType',
  eval_start_date: 'crmEvalStartDate',
  eval_end_date: 'crmEvalEndDate',
}
salesforceRouter.patch('/evaluations/:relatedId', requireCrmProjects(), async (req, res) => {
  const { relatedId } = req.params as { relatedId: string }
  // v1.151.0: an explicit all-optional object, NOT z.record(z.enum,…).
  // In Zod 4 a record keyed by an enum is EXHAUSTIVE — it requires every
  // enum key, so sending a single edited field ({ eval_status }) failed
  // validation for the other four ("expected string, received
  // undefined"). Each field is optional + nullable so a one-field save
  // works and null clears the value.
  const schema = z.object({
    teamId: z.string().uuid(),
    sobject: z.string().regex(SOBJECT_RX),
    fields: z.object({
      eval_status: z.string().nullable().optional(),
      eval_stage: z.string().nullable().optional(),
      eval_type: z.string().nullable().optional(),
      eval_start_date: z.string().nullable().optional(),
      eval_end_date: z.string().nullable().optional(),
    }),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamId, sobject, fields } = parsed.data

  const mappings = await loadEvalFieldMappings(teamId, sobject)
  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return }

  const sfPatch: Record<string, unknown> = {}
  const localPatch: Record<string, unknown> = {}
  const skipped: string[] = []
  for (const [appField, value] of Object.entries(fields)) {
    const mapping = mappings.get(appField)
    // Skip fields with no mapping, or whose direction excludes write —
    // same guard writeback.ts applies for activity write-back.
    if (!mapping || (mapping.direction !== 'write' && mapping.direction !== 'read_write')) {
      skipped.push(appField)
      continue
    }
    sfPatch[mapping.crmFieldApi] = value
    const localCol = EDITABLE_EVAL_FIELDS[appField]
    if (localCol) localPatch[localCol] = value
  }
  if (Object.keys(sfPatch).length === 0) {
    res.status(400).json({ data: null, error: 'errors.validation.no_writable_fields', meta: { skipped } })
    return
  }

  try {
    await conn.sobject(sobject).update({ Id: relatedId, ...sfPatch })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    void logSfSyncAttempt({
      source: 'evaluation_field_update', status: 'failed', operation: 'update', crmObject: sobject, crmRecordId: relatedId,
      userId: req.user!.id, errorMessage: message, payload: { fields: sfPatch, skipped },
    })
    res.status(502).json({ data: null, error: `SF update failed: ${message}`, meta: { skipped } })
    return
  }

  localPatch['crmSnapshotRefreshedAt'] = new Date()
  await db.update(activities).set(localPatch).where(and(eq(activities.teamId, teamId), eq(activities.crmRelatedId, relatedId)))
  void logSfSyncAttempt({
    source: 'evaluation_field_update', status: 'success', operation: 'update', crmObject: sobject, crmRecordId: relatedId,
    userId: req.user!.id, payload: { fields: sfPatch, skipped },
  })

  res.json({ data: { ok: true, updated: Object.keys(sfPatch) }, error: null, meta: { skipped } })
})

// v1.337.0: Support-ticket attachment — search Salesforce tickets to attach
// to an activity via a 'ticket_picker' Extra (see teamActivityTypeCrmExtras
// in drizzle/schema.ts and the ActivitySfTickets storage it feeds). Same
// "never hardcode SF field API names" pattern as the Evaluation block
// above: the ticket SObject and every display field are resolved live via
// crm_field_mappings, never assumed. Read-only — nothing here writes to
// Salesforce; the attached snapshot lives ImpactIQ-side only
// (activity_crm_tickets), so there is no write-back counterpart to the
// PATCH /evaluations/:relatedId route above.
const TICKET_APP_FIELDS = ['ticket_number', 'ticket_subject', 'ticket_date_opened', 'ticket_status', 'ticket_contact', 'ticket_description', 'ticket_platform', 'ticket_owner', 'ticket_account'] as const

async function loadTicketFieldMappings(teamId: string, sobject: string): Promise<Map<string, { crmFieldApi: string; referenceTo: string | null }>> {
  const rows = await db
    .select({ appField: crmFieldMappings.appField, crmFieldApi: crmFieldMappings.crmFieldApi, referenceTo: crmFieldMappings.referenceTo })
    .from(crmFieldMappings)
    .innerJoin(crmFieldMappingTeams, eq(crmFieldMappingTeams.crmFieldMappingId, crmFieldMappings.id))
    .where(and(
      eq(crmFieldMappingTeams.teamId, teamId),
      eq(crmFieldMappings.crmObject, sobject),
      eq(crmFieldMappings.isActive, true),
    ))
  return new Map(rows.map((r) => [r.appField, { crmFieldApi: r.crmFieldApi, referenceTo: r.referenceTo }]))
}

// Own describe cache, deliberately separate from evalDescribeCache — this
// file's own convention (see the Engineer Notes prepend cache and admin.ts's
// /sf/fields cache) is one cache per feature, not a shared one, so one
// feature's describe traffic never invalidates or couples to another's.
const TICKET_DESCRIBE_TTL_MS = 60 * 60 * 1000
const ticketDescribeCache = new Map<string, { at: number; fieldNames: Set<string> }>()
async function describeTicketObject(conn: import('jsforce').Connection, sobject: string) {
  const cached = ticketDescribeCache.get(sobject)
  if (cached && Date.now() - cached.at < TICKET_DESCRIBE_TTL_MS) return cached
  const meta = await conn.sobject(sobject).describe()
  const fieldNames = new Set(meta.fields.map((f) => (f.name ?? '').toLowerCase()))
  const entry = { at: Date.now(), fieldNames }
  ticketDescribeCache.set(sobject, entry)
  return entry
}

interface TicketRow {
  id: string
  ticketNumber: string
  subject: string | null
  dateOpened: string | null
  status: string | null
  contact: string | null
  description: string | null
  platform: string | null
  owner: string | null
}

type TicketFieldMappings = Map<string, { crmFieldApi: string; referenceTo: string | null }>

// Shared by /tickets/search and /tickets/refresh below — resolving which
// mapped fields actually exist on this org's object (describe-driven
// tolerance, same as the Evaluation block: one mis-seeded mapping drops
// that field rather than failing the whole query).
function buildTicketSelectPairs(mappings: TicketFieldMappings): Array<[typeof TICKET_APP_FIELDS[number], string]> {
  const pairs: Array<[typeof TICKET_APP_FIELDS[number], string]> = []
  for (const appField of TICKET_APP_FIELDS) {
    const m = mappings.get(appField)
    if (m && SOBJECT_RX.test(m.crmFieldApi)) pairs.push([appField, m.crmFieldApi])
  }
  return pairs
}
async function filterTicketSelectPairsByDescribe(
  conn: import('jsforce').Connection,
  sobject: string,
  selectPairs: Array<[typeof TICKET_APP_FIELDS[number], string]>,
): Promise<Array<[typeof TICKET_APP_FIELDS[number], string]>> {
  try {
    const { fieldNames } = await describeTicketObject(conn, sobject)
    return selectPairs.filter(([, api]) => fieldNames.has(api.toLowerCase()))
  } catch {
    return selectPairs // describe failed — try the SELECT as mapped
  }
}

// Extracts the display fields a raw SF record resolves to via fieldByApp —
// shared between a freshly-searched record and an already-attached ticket's
// re-queried record. Contact/Owner are left as whatever raw value the
// mapped field returns; resolveTicketLookupNames() below resolves them to
// names in a second pass when needed.
function extractTicketFields(record: Record<string, unknown>, fieldByApp: Map<typeof TICKET_APP_FIELDS[number], string>) {
  const get = (appField: typeof TICKET_APP_FIELDS[number]) => {
    const api = fieldByApp.get(appField)
    return api ? (record[api] ?? null) : null
  }
  return {
    ticketNumber: (get('ticket_number') as string | null) ?? null,
    subject: (get('ticket_subject') as string | null) ?? null,
    dateOpened: (get('ticket_date_opened') as string | null) ?? null,
    status: (get('ticket_status') as string | null) ?? null,
    contact: (get('ticket_contact') as string | null) ?? null,
    description: (get('ticket_description') as string | null) ?? null,
    platform: (get('ticket_platform') as string | null) ?? null,
    owner: (get('ticket_owner') as string | null) ?? null,
  }
}

// v1.339.0 / v1.340.0: ticket_contact / ticket_owner can each be a genuine
// Salesforce lookup rather than a plain text/picklist field — same
// field-shape ambiguity §9 already handles for eval_primary_engineer.
// OwnerId in particular is POLYMORPHIC (User or Group/Queue — a ticket's
// owner genuinely flips between a person and a queue over its lifecycle),
// and the admin UI's auto-captured `referenceTo` only ever stores ONE of
// the two possible target types — so gate on "this was captured as some
// lookup" (truthy), not on an exact 'User' match, and let
// resolveOwnerLookupNames() try both User and Group. Mutates rows in place;
// shared by /tickets/search (fresh results) and /tickets/refresh
// (already-attached tickets) so the two never drift on this logic.
async function resolveTicketLookupNames(
  conn: import('jsforce').Connection,
  mappings: TicketFieldMappings,
  rows: Array<{ contact: string | null; owner: string | null }>,
): Promise<void> {
  const lookupKeys = (['contact', 'owner'] as const).filter((key) => !!mappings.get(`ticket_${key}`)?.referenceTo)
  if (lookupKeys.length === 0) return
  const rawIds = lookupKeys.flatMap((key) => rows.map((row) => row[key]))
  const nameById = await resolveOwnerLookupNames(conn, rawIds)
  for (const row of rows) {
    for (const key of lookupKeys) {
      const raw = row[key]
      if (raw) row[key] = nameById.get(raw) ?? raw
    }
  }
}

// GET /api/salesforce/tickets/search?teamId=&sobject=&accountId=&q=&includeClosed=&closedStatusValues=
// Two modes, matching the Extra's own "always available" Open Search toggle
// (CLAUDE.md §7): accountId scopes to tickets linked to that Account
// (default); omitting it and passing q instead searches ticket
// number/subject tenant-wide. closedStatusValues (comma-separated, from the
// Extra's own config — CLAUDE.md §21: caller-supplied and validated, not a
// second server-side lookup of the Extra row) excludes those Status values
// unless includeClosed=true.
salesforceRouter.get('/tickets/search', async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const sobject = req.query['sobject'] as string | undefined
  const accountId = typeof req.query['accountId'] === 'string' ? req.query['accountId'] : undefined
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined
  const includeClosed = req.query['includeClosed'] === 'true'
  const closedStatusValues = (req.query['closedStatusValues'] as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean) ?? []

  if (!teamId || !sobject) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!SOBJECT_RX.test(sobject)) { res.status(400).json({ data: null, error: 'errors.salesforce.invalid_object_type', meta: {} }); return }
  if (!accountId && (!q || q.length < 2)) { res.json({ data: [], error: null, meta: {} }); return }

  const mappings = await loadTicketFieldMappings(teamId, sobject)
  const numberField = mappings.get('ticket_number')?.crmFieldApi
  if (!numberField) { res.json({ data: [], error: null, meta: { unmapped: true } }); return }
  const accountField = mappings.get('ticket_account')?.crmFieldApi
  if (accountId && !accountField) { res.json({ data: [], error: null, meta: { accountFieldUnmapped: true } }); return }

  const conn = await getSfConnection(req.user!.id)
  if (!conn) {
    if (await stubsAllowed()) { res.json({ data: [], error: null, meta: { stub: true } }); return }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return
  }

  let selectPairs = await filterTicketSelectPairsByDescribe(conn, sobject, buildTicketSelectPairs(mappings))
  if (!selectPairs.some(([appField]) => appField === 'ticket_number')) {
    res.json({ data: [], error: null, meta: { unmapped: true } })
    return
  }

  const whereParts: string[] = []
  const subjectField = mappings.get('ticket_subject')?.crmFieldApi
  if (accountId && accountField) {
    whereParts.push(`${accountField} = '${safeSoqlLiteral(accountId)}'`)
  } else if (q) {
    const like = `%${safeSoqlLiteral(q)}%`
    const orParts = [`${numberField} LIKE '${like}'`]
    if (subjectField) orParts.push(`${subjectField} LIKE '${like}'`)
    whereParts.push(`(${orParts.join(' OR ')})`)
  }
  const statusField = mappings.get('ticket_status')?.crmFieldApi
  if (statusField && !includeClosed && closedStatusValues.length > 0) {
    const list = closedStatusValues.map((v) => `'${safeSoqlLiteral(v)}'`).join(', ')
    whereParts.push(`(${statusField} NOT IN (${list}) OR ${statusField} = null)`)
  }

  const selectClause = ['Id', ...selectPairs.map(([, api]) => api)].join(', ')
  const orderField = mappings.get('ticket_date_opened')?.crmFieldApi ?? numberField
  const soql = `SELECT ${selectClause} FROM ${sobject}${whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''} ORDER BY ${orderField} DESC LIMIT 100`
  try {
    const result = await conn.query<Record<string, unknown>>(soql)
    const fieldByApp = new Map(selectPairs)
    const rows: TicketRow[] = result.records.map((r) => ({
      id: String(r['Id']),
      ...extractTicketFields(r, fieldByApp),
      ticketNumber: extractTicketFields(r, fieldByApp).ticketNumber ?? String(r['Id']),
    }))
    await resolveTicketLookupNames(conn, mappings, rows)
    res.json({ data: rows, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
  }
})

// GET /api/salesforce/tickets/refresh?activityId=
// v1.341.0: an already-attached ticket's display fields are a snapshot
// taken at attach time (activity_crm_tickets, CLAUDE.md §7) — nothing
// re-reads it afterward, so a field that changes in Salesforce later (most
// importantly Owner, which can flip between a person and a Queue) never
// updates on its own. The Activity drawer fires this once, right after it
// hydrates the stored tickets from GET /api/activities/:id — never
// blocking that hydration or the drawer opening — and merges the fresh
// values in when this resolves. Persists the refresh back onto
// activity_crm_tickets in the same request, so the stored row is
// self-healing from here on even if this activity is never reopened again.
// Best-effort throughout: not connected, no ticket_picker Extra configured,
// or a live query failure all degrade to "return the stored snapshot
// unchanged" rather than an error — the drawer already has something to
// show, so a failed refresh is a no-op, not a problem for the contributor.
salesforceRouter.get('/tickets/refresh', async (req, res) => {
  const activityId = req.query['activityId'] as string | undefined
  if (!activityId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  // Only someone who may see the activity (security audit M2, v1.422.0).
  if (!(await canViewActivityById(req.user!.id, activityId))) { res.status(404).json({ data: null, error: 'errors.activities.not_found', meta: {} }); return }

  const { activityCrmTickets, teamActivityTypeCrmExtras } = await import('../../../drizzle/schema.js')

  const [activity] = await db
    .select({ teamId: activities.teamId, activityTypeId: activities.activityTypeId })
    .from(activities)
    .where(eq(activities.id, activityId))
    .limit(1)
  if (!activity) { res.json({ data: [], error: null, meta: {} }); return }

  const existing = await db.select().from(activityCrmTickets).where(eq(activityCrmTickets.activityId, activityId))
  if (existing.length === 0) { res.json({ data: [], error: null, meta: {} }); return }

  const [extra] = await db
    .select({ config: teamActivityTypeCrmExtras.config })
    .from(teamActivityTypeCrmExtras)
    .where(and(
      eq(teamActivityTypeCrmExtras.teamActivityTypeId, activity.activityTypeId),
      eq(teamActivityTypeCrmExtras.kind, 'ticket_picker'),
    ))
    .limit(1)
  const sobject = (extra?.config as { sobject?: string } | undefined)?.sobject
  if (!sobject || !SOBJECT_RX.test(sobject)) { res.json({ data: existing, error: null, meta: { unmapped: true } }); return }

  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.json({ data: existing, error: null, meta: { notConnected: true } }); return }

  const mappings = await loadTicketFieldMappings(activity.teamId, sobject)
  const selectPairs = await filterTicketSelectPairsByDescribe(conn, sobject, buildTicketSelectPairs(mappings))
  if (selectPairs.length === 0) { res.json({ data: existing, error: null, meta: {} }); return }

  const ids = existing.map((t) => t.crmTicketId).filter((id) => SF_ID_RX.test(id))
  if (ids.length === 0) { res.json({ data: existing, error: null, meta: {} }); return }
  const idList = ids.map((id) => `'${safeSoqlLiteral(id)}'`).join(', ')
  const selectClause = ['Id', ...selectPairs.map(([, api]) => api)].join(', ')
  const soql = `SELECT ${selectClause} FROM ${sobject} WHERE Id IN (${idList})`

  try {
    const result = await conn.query<Record<string, unknown>>(soql)
    const fieldByApp = new Map(selectPairs)
    const byId = new Map(result.records.map((r) => [String(r['Id']), extractTicketFields(r, fieldByApp)]))
    await resolveTicketLookupNames(conn, mappings, Array.from(byId.values()))

    const updated = []
    for (const row of existing) {
      const fresh = byId.get(row.crmTicketId)
      if (!fresh) { updated.push(row); continue } // deleted/inaccessible in SF — keep the stored snapshot
      const patch = {
        crmSubject: fresh.subject,
        crmDateOpened: fresh.dateOpened ? new Date(fresh.dateOpened) : null,
        crmStatus: fresh.status,
        crmContact: fresh.contact,
        crmDescription: fresh.description,
        crmPlatform: fresh.platform,
        crmOwner: fresh.owner,
      }
      await db.update(activityCrmTickets).set(patch).where(eq(activityCrmTickets.id, row.id))
      updated.push({ ...row, ...patch })
    }
    res.json({ data: updated, error: null, meta: {} })
  } catch {
    res.json({ data: existing, error: null, meta: { refreshFailed: true } })
  }
})

// GET /api/salesforce/activity-link-status?activityId=
// v1.344.0: live, per-activity companion to the nightly detect_disconnected_
// links job (services/salesforce/detectDisconnectedLinks.ts, CLAUDE.md §7) —
// fired once when the activity edit drawer opens, so whoever is actively
// looking at one record right now sees a check more current than the
// nightly batch. Always 200, never blocks the drawer: no SF links at all
// skips the SF call entirely; no per-user SF connection returns the stored
// flags unchanged. Each link checked independently so one link's failure
// (or an unmapped/invalid Related object type) never blocks the others —
// and a failed check leaves that link's stored flag untouched rather than
// treating "couldn't check" as "confirmed deleted" (see checkSfRecordsExist's
// own contract in referenceResolver.ts).
salesforceRouter.get('/activity-link-status', async (req, res) => {
  const activityId = req.query['activityId'] as string | undefined
  if (!activityId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  // Only someone who may see the activity (security audit M2, v1.422.0).
  if (!(await canViewActivityById(req.user!.id, activityId))) { res.status(404).json({ data: null, error: 'errors.activities.not_found', meta: {} }); return }

  const [activity] = await db
    .select({
      crmWhatId: activities.crmWhatId, crmWhatType: activities.crmWhatType,
      crmWhoId: activities.crmWhoId, crmWhoType: activities.crmWhoType,
      crmRelatedId: activities.crmRelatedId, crmRelatedType: activities.crmRelatedType,
      crmWhatDeleted: activities.crmWhatDeleted, crmWhoDeleted: activities.crmWhoDeleted, crmRelatedDeleted: activities.crmRelatedDeleted,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .limit(1)
  if (!activity) { res.status(404).json({ data: null, error: 'errors.activities.not_found', meta: {} }); return }

  type LinkKey = 'crmWhatDeleted' | 'crmWhoDeleted' | 'crmRelatedDeleted'
  const allLinks: Array<{ key: LinkKey; id: string | null; type: string | null }> = [
    { key: 'crmWhatDeleted', id: activity.crmWhatId, type: activity.crmWhatType },
    { key: 'crmWhoDeleted', id: activity.crmWhoId, type: activity.crmWhoType },
    // A CriteriaIQ project link isn't a Salesforce record; the nightly
    // refresh_criteriaiq_projects job checks those instead.
    ...(isCriteriaIqProjectLink(activity.crmRelatedType) ? [] : [{ key: 'crmRelatedDeleted' as const, id: activity.crmRelatedId, type: activity.crmRelatedType }]),
  ]
  // Demo Data ids are never Salesforce records; their flags stay as generated.
  const links = allLinks.filter((l) => !!l.id && !!l.type && !isDemoCrmId(l.id))

  const current = { crmWhatDeleted: activity.crmWhatDeleted, crmWhoDeleted: activity.crmWhoDeleted, crmRelatedDeleted: activity.crmRelatedDeleted }
  if (links.length === 0) { res.json({ data: current, error: null, meta: { skipped: true } }); return }

  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.json({ data: current, error: null, meta: { notConnected: true } }); return }

  const patch: Partial<typeof current> = {}
  for (const link of links) {
    if (!link.type || !SOBJECT_RX.test(link.type)) continue
    try {
      const existsById = await checkSfRecordsExist(conn, link.type, [link.id as string])
      patch[link.key] = !(existsById.get(link.id as string) ?? true)
    } catch {
      // Check failed — leave this link's flag untouched, never treat a
      // thrown query as "confirmed deleted."
    }
  }

  if (Object.keys(patch).length > 0) {
    await db.update(activities).set({ ...patch, crmDisconnectCheckedAt: new Date() }).where(eq(activities.id, activityId))
  }
  res.json({ data: { ...current, ...patch }, error: null, meta: {} })
})

// Field prepend-update — "post a dated note, keep history" (Engineer Notes /
// Situation-Next Steps on the linked Evaluation record). Deliberately an
// APPEND, not the overwrite-on-save the PATCH /evaluations/:relatedId route
// above does — see CLAUDE.md / Admin → SF Field Mappings.
//
// GET /api/salesforce/field-prepend/meta?teamId=&sobject=&appField=&recordId=
// Live meta + a FRESH read of the current field value (never cached, per
// the feature's concurrency requirement) — used to render capacity stats
// and the "view full text" modal before the user types anything.
salesforceRouter.get('/field-prepend/meta', requireCrmProjects(), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const sobject = req.query['sobject'] as string | undefined
  const appField = req.query['appField'] as string | undefined
  const recordId = req.query['recordId'] as string | undefined
  if (!teamId || !sobject || !appField || !recordId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!SOBJECT_RX.test(sobject)) { res.status(400).json({ data: null, error: 'errors.salesforce.invalid_object_type', meta: {} }); return }

  const mappings = await loadEvalFieldMappings(teamId, sobject)
  const mapping = mappings.get(appField)
  if (!mapping || (mapping.direction !== 'write' && mapping.direction !== 'read_write')) {
    res.json({ data: null, error: null, meta: { unmapped: true } })
    return
  }

  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return }

  let fieldMeta
  try {
    fieldMeta = await describeFieldCapacity(conn, sobject, mapping.crmFieldApi)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF describe failed: ${message}`, meta: {} })
    return
  }
  if (!fieldMeta) {
    res.status(422).json({ data: null, error: 'errors.salesforce.field_not_prependable', meta: {} })
    return
  }

  try {
    const soql = `SELECT ${mapping.crmFieldApi}, LastModifiedDate FROM ${sobject} WHERE Id = '${safeSoqlLiteral(recordId)}' LIMIT 1`
    const q = await conn.query<Record<string, unknown>>(soql)
    const row = q.records[0] ?? null
    if (!row) { res.status(404).json({ data: null, error: 'errors.salesforce.record_not_found', meta: {} }); return }
    const currentValue = (row[mapping.crmFieldApi] as string | null | undefined) ?? null
    res.json({
      data: {
        fieldLabel: fieldMeta.label,
        maximumCharacters: fieldMeta.length,
        currentValue,
        currentLength: currentValue?.length ?? 0,
        lastModifiedDate: row['LastModifiedDate'] ?? null,
      },
      error: null,
      meta: {},
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
  }
})

// POST /api/salesforce/field-prepend
// Body: { teamId, sobject, appField, recordId, text, expectedLastModifiedDate? }
// Backend owns date/initials/capacity — never trusts the browser for any of
// them (AC10). Re-reads the field fresh immediately before writing so a
// stale browser value can never silently clobber a newer Salesforce edit;
// when the caller supplies expectedLastModifiedDate and it no longer
// matches, aborts with 409 rather than overwriting (AC7/AC8).
salesforceRouter.post('/field-prepend', requireCrmProjects(), async (req, res) => {
  const schema = z.object({
    teamId: z.string().uuid(),
    sobject: z.string().regex(SOBJECT_RX),
    appField: z.string().min(1).max(80),
    recordId: z.string().min(1).max(30),
    text: z.string().min(1),
    expectedLastModifiedDate: z.string().nullable().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamId, sobject, appField, recordId, text, expectedLastModifiedDate } = parsed.data

  const mappings = await loadEvalFieldMappings(teamId, sobject)
  const mapping = mappings.get(appField)
  if (!mapping || (mapping.direction !== 'write' && mapping.direction !== 'read_write')) {
    res.status(400).json({ data: null, error: 'errors.validation.no_writable_fields', meta: {} })
    return
  }

  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return }

  const fieldMeta = await describeFieldCapacity(conn, sobject, mapping.crmFieldApi).catch(() => null)
  if (!fieldMeta) { res.status(422).json({ data: null, error: 'errors.salesforce.field_not_prependable', meta: {} }); return }

  // Acting user's identity + timezone — resolved server-side, never from
  // the request body (AC10).
  const [me] = await db.select({ firstName: users.firstName, lastName: users.lastName, timezone: users.timezone })
    .from(users).where(eq(users.id, req.user!.id)).limit(1)
  const initials = computeInitials(me?.firstName ?? null, me?.lastName ?? null)
  const todayStr = formatDateMMDDYY(new Date(), me?.timezone ?? 'UTC')
  const formattedEntry = formatEntry(todayStr, initials, text.trim())

  let fresh: { value: string | null; lastModifiedDate: string | null }
  try {
    const soql = `SELECT ${mapping.crmFieldApi}, LastModifiedDate FROM ${sobject} WHERE Id = '${safeSoqlLiteral(recordId)}' LIMIT 1`
    const q = await conn.query<Record<string, unknown>>(soql)
    const row = q.records[0] ?? null
    if (!row) { res.status(404).json({ data: null, error: 'errors.salesforce.record_not_found', meta: {} }); return }
    fresh = {
      value: (row[mapping.crmFieldApi] as string | null | undefined) ?? null,
      lastModifiedDate: (row['LastModifiedDate'] as string | null | undefined) ?? null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
    return
  }

  if (expectedLastModifiedDate && fresh.lastModifiedDate && expectedLastModifiedDate !== fresh.lastModifiedDate) {
    res.status(409).json({
      data: null,
      error: 'errors.salesforce.field_changed',
      meta: { currentValue: fresh.value, currentLength: fresh.value?.length ?? 0, lastModifiedDate: fresh.lastModifiedDate },
    })
    return
  }

  const capacity = computeCapacity({ existingValue: fresh.value, formattedEntry, maxLength: fieldMeta.length })
  if (!capacity.fits) {
    res.status(400).json({
      data: null,
      error: 'errors.salesforce.field_capacity_exceeded',
      meta: { maximumCharacters: capacity.maximumCharacters, charactersUsed: capacity.charactersUsed, overBy: capacity.overBy },
    })
    return
  }

  try {
    await conn.sobject(sobject).update({ Id: recordId, [mapping.crmFieldApi]: capacity.finalValue })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    void logSfSyncAttempt({
      source: 'field_prepend', status: 'failed', operation: 'update', crmObject: sobject, crmRecordId: recordId,
      userId: req.user!.id, errorMessage: message,
      payload: { fieldApiName: mapping.crmFieldApi, appField, charactersUsed: capacity.charactersUsed },
    })
    res.status(502).json({ data: null, error: `SF update failed: ${message}`, meta: {} })
    return
  }

  // Two audit trails on purpose: the general Audit Log (logAudit, below)
  // is an admin/user *action* record ("who did what"); activity_sync_audit
  // (logSfSyncAttempt) is the CRM Sync page's Salesforce *write outcome*
  // record ("did the write succeed, and if not, why"). This is the
  // "Engineer Notes checkbox" write path — same endpoint whether it's
  // triggered from ActivityForm's save or NotesDrawer's Notes tab.
  void logAudit(req, {
    action: 'salesforce.field_prepend',
    targetType: sobject,
    targetId: recordId,
    meta: { fieldApiName: mapping.crmFieldApi, appField, charactersUsed: capacity.charactersUsed },
  })
  void logSfSyncAttempt({
    source: 'field_prepend', status: 'success', operation: 'update', crmObject: sobject, crmRecordId: recordId,
    userId: req.user!.id, payload: { fieldApiName: mapping.crmFieldApi, appField, charactersUsed: capacity.charactersUsed },
  })

  res.json({
    data: {
      formattedEntry,
      charactersUsed: capacity.charactersUsed,
      maximumCharacters: capacity.maximumCharacters,
      charactersRemaining: capacity.charactersRemaining,
    },
    error: null,
    meta: {},
  })
})

// account, used by the Attendees search inside the activity edit drawer.
// Accepts an Opportunity id too: we resolve the linked Account first and
// then run the same contact query so the caller doesn't have to.
salesforceRouter.get('/accounts/:id/contacts', async (req, res) => {
  const userId = req.user!.id
  const q = ((typeof req.query['q'] === 'string' ? req.query['q'] : '')).trim()
  const kind = (req.query['kind'] as string | undefined) === 'opportunity' ? 'opportunity' : 'account'
  const { id } = req.params as { id: string }
  if (!id) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) {
      res.json({
        data: q.length >= 1 ? [
          { Id: 'stub-contact-001', Name: `${q} Jones`, Email: `${q}.jones@example.com`, Title: 'CTO', AccountName: 'Stub Corp' },
          { Id: 'stub-contact-002', Name: `${q} Patel`, Email: `${q}.patel@example.com`, Title: 'VP Engineering', AccountName: 'Stub Corp' },
        ] : [],
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  try {
    let accountId = id
    if (kind === 'opportunity') {
      const oppSoql = `SELECT AccountId FROM Opportunity WHERE Id = '${safeSoqlLiteral(id)}' LIMIT 1`
      const oppQ = await conn.query<{ AccountId: string | null }>(oppSoql)
      const linked = oppQ.records[0]?.AccountId
      if (!linked) { res.json({ data: [], error: null, meta: {} }); return }
      accountId = linked
    }
    const qFrag = q.length >= 1
      ? `AND (Name LIKE '%${safeSoqlLiteral(q)}%' OR Email LIKE '%${safeSoqlLiteral(q)}%')`
      : ''
    const soql = `SELECT Id, Name, Email, Title, Account.Name
                  FROM Contact
                  WHERE AccountId = '${safeSoqlLiteral(accountId)}' ${qFrag}
                  ORDER BY LastModifiedDate DESC
                  LIMIT 20`
    const q2 = await conn.query<{ Id: string; Name: string; Email: string | null; Title: string | null; Account: { Name: string } | null }>(soql)
    const rows = q2.records.map((r) => ({
      Id: r.Id,
      Name: r.Name,
      Email: r.Email,
      Title: r.Title,
      AccountName: r.Account?.Name ?? null,
    }))
    res.json({ data: rows, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF query failed: ${message}`, meta: {} })
  }
})

// GET /api/salesforce/preview/:type/:id — inline record preview for the
// hover popover on an activity card's Opportunity / Account link.
//
// Always answers 200 with whatever it can assemble. The local snapshot on
// `activities` is the floor, so a contributor who has never connected
// Salesforce still gets stage / owner / close date rather than an error;
// a live read over that user's OWN connection layers current values on top
// when it succeeds. Never uses the admin connection — this is a
// contributor-facing read.
salesforceRouter.get('/preview/:type/:id', async (req, res) => {
  const { type, id } = req.params as { type: string; id: string }
  if (type !== 'Opportunity' && type !== 'Account') {
    res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} })
    return
  }
  if (!SF_ID_RX.test(id)) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }
  const snapshot = await readSnapshot(id, type, { userId: req.user!.id, teamIds: await getAccessibleTeamIds(req.user!.id) })
  const session = await salesforceProvider.connectForUser(req.user!.id)
  if (!session) {
    const [assignedSeMatched, primaryEngineerMatched] = await Promise.all([
      isImpactIqUserName(snapshot.assignedSeName),
      isImpactIqUserName(snapshot.primaryEngineerName),
    ])
    res.json({ data: { ...snapshot, assignedSeMatched, primaryEngineerMatched }, error: null, meta: { connected: false } })
    return
  }
  const live = await session.readPreview(id, type)
  const merged = mergePreview(snapshot, live)
  const [assignedSeMatched, primaryEngineerMatched] = await Promise.all([
    isImpactIqUserName(merged.assignedSeName),
    isImpactIqUserName(merged.primaryEngineerName),
  ])
  res.json({ data: { ...merged, assignedSeMatched, primaryEngineerMatched }, error: null, meta: { connected: true, live: !!live } })
})

// GET /api/salesforce/users?q= — dropdown source for Assigned SE picker.
// Serves from the local crm_users cache (populated by the Sales Team
// Alignment sync) so we don't burn an SF round-trip per keystroke.
// GET /api/salesforce/picklists/opportunity/assigned-se?teamId= — returns the
// active picklist values for the team's resolved Assigned SE write field
// (empty, with meta.configured = false, when none is mapped). Since the field is usually a Picklist (not
// a User Lookup), the values are literal strings the org chose — we display
// them verbatim in the picker and write the picked string back on save.
// v1.297.0: reads the SAME resolveAssignedSeWriteField() the GET/PATCH value
// routes use, instead of hardcoding one field name — an admin-mapped write
// target used to show the wrong org's picklist values entirely. If the
// resolved field isn't a Picklist (e.g. a plain Text field), there are no
// picklistValues to offer — meta.fieldType tells the client to fall back to
// free-text entry instead of silently rendering an empty dropdown.
salesforceRouter.get('/picklists/opportunity/assigned-se', async (req, res) => {
  const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : null
  const writeField = await resolveAssignedSeWriteField(teamId)
  if (!writeField) { res.json({ data: [], error: null, meta: { configured: false, writeField: null, fieldType: null } }); return }
  const conn = await getSfConnection(req.user!.id)
  if (!conn) { res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} }); return }
  try {
    const meta = await conn.sobject('Opportunity').describe()
    const field = meta.fields.find((f) => f.name === writeField)
    const values = (field?.picklistValues ?? [])
      .filter((v) => v.active !== false)
      .map((v) => ({ value: v.value, label: v.label ?? v.value }))
    // v1.279.0: flag each picklist label that has no matching ImpactIQ user
    // (by display name — these are literal strings, not SF User Ids), so
    // the picker can show the same red "not in ImpactIQ" treatment used
    // elsewhere for a value the user is about to pick, not just the one
    // already saved on the Opportunity.
    const roster = await db.select({ name: users.displayName }).from(users)
    const rosterNames = new Set(roster.map((r) => (r.name ?? '').toLowerCase()).filter(Boolean))
    const withMatch = values.map((v) => ({ ...v, matched: rosterNames.has(v.label.toLowerCase()) }))
    res.json({ data: withMatch, error: null, meta: { writeField, fieldType: field?.type ?? null } })
  } catch (err) {
    res.status(502).json({ data: null, error: err instanceof Error ? err.message : String(err), meta: {} })
  }
})

salesforceRouter.get('/users', async (req, res) => {
  const q = ((typeof req.query['q'] === 'string' ? req.query['q'] : '')).trim().toLowerCase()
  const department = ((req.query['department'] as string | undefined) ?? '').trim()
  // With a department filter, hit SF live (the crm_users cache doesn't
  // carry Department yet). Falls back to the local cache when SF isn't
  // available so the picker still works.
  if (department) {
    const conn = await getSfConnection(req.user!.id)
    if (conn) {
      try {
        const safeDept = safeSoqlLiteral(department).slice(0, 80)
        const safeQ = safeSoqlLiteral(q).slice(0, 80)
        const nameEmailClause = q ? ` AND (Name LIKE '%${safeQ}%' OR Email LIKE '%${safeQ}%')` : ''
        const soql = `SELECT Id, Name, Email FROM User WHERE IsActive = true AND Department = '${safeDept}'${nameEmailClause} ORDER BY Name LIMIT 100`
        const result = await conn.query<{ Id: string; Name: string; Email: string | null }>(soql)
        res.json({ data: result.records.map((r) => ({ id: r.Id, name: r.Name, email: r.Email })), error: null, meta: { source: 'live', department } })
        return
      } catch (err) {
        console.warn('[/api/salesforce/users?department] SOQL failed, falling back to cache:', err instanceof Error ? err.message : String(err))
      }
    }
  }
  const { crmUsers } = await import('../../../drizzle/schema.js')
  const { or, ilike, eq: eqDrizzle, and } = await import('drizzle-orm')
  const conds = [eqDrizzle(crmUsers.isActive, true)]
  if (q.length >= 1) {
    conds.push(or(ilike(crmUsers.name, `%${q}%`), ilike(crmUsers.email, `%${q}%`))!)
  }
  const rows = await db.select({ id: crmUsers.id, name: crmUsers.name, email: crmUsers.email })
    .from(crmUsers)
    .where(and(...conds))
    .orderBy(crmUsers.name)
    .limit(50)
  res.json({ data: rows, error: null, meta: { source: 'cache' } })
})

// POST /api/salesforce/suggestions/by-attendees { emails: string[] }
// Filters out internal-domain emails, then looks up SF Contacts by email and
// returns the linked Accounts + open Opportunities. Empty on no-match; each
// row carries the matched contact for display context.
salesforceRouter.post('/suggestions/by-attendees', async (req, res) => {
  const userId = req.user!.id
  const body = req.body as { emails?: unknown }
  const raw = Array.isArray(body.emails) ? body.emails.filter((v): v is string => typeof v === 'string') : []
  const internal = await getSfInternalDomains()
  const external = Array.from(new Set(raw
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'))
    .filter((e) => {
      const domain = e.split('@')[1] ?? ''
      return !internal.includes(domain)
    })))
  if (external.length === 0) { res.json({ data: { accounts: [], opportunities: [] }, error: null, meta: {} }); return }

  const conn = await getSfConnection(userId)
  if (!conn) {
    if (await stubsAllowed()) {
      res.json({
        data: {
          accounts: external.slice(0, 2).map((e, i) => ({ Id: `stub-acct-${i}`, Name: `Stub Account for ${e}`, OwnerName: 'Demo Owner', contactName: 'Stub Contact', contactEmail: e })),
          opportunities: external.slice(0, 1).map((e, i) => ({ Id: `stub-opp-${i}`, Name: `Stub Opp for ${e}`, AccountName: 'Stub Account', StageName: 'Discovery', Amount: 50000, CloseDate: '2026-12-31', ForecastCategoryName: 'Pipeline', OwnerName: 'Demo Owner', contactName: 'Stub Contact', contactEmail: e })),
        },
        error: null,
        meta: { stub: true },
      })
      return
    }
    res.status(401).json({ data: null, error: 'errors.salesforce.not_connected', meta: {} })
    return
  }
  try {
    const result = await findSuggestionsForEmails(conn, external)
    res.json({ data: result, error: null, meta: { emailsMatched: external.length } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `SF suggestions failed: ${message}`, meta: {} })
  }
})
