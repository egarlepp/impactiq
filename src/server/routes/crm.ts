import { Router } from 'express'
import type { Request, Response, RequestHandler } from 'express'
import { rateLimit } from '../middleware/rate-limit.js'
import { crmFeatureBlock, getEffectiveCrmFeatures } from '../services/crm/features.js'
import { getActiveCrmProvider } from '../services/crm/index.js'
import type { CrmProvider, CrmUserSession } from '../services/crm/types.js'
import { HubspotError } from '../services/hubspot/client.js'
import { readSnapshot, mergePreview, isImpactIqUserName } from '../services/salesforce/preview.js'
import { getCrmProviderId } from '../services/crm/providerSetting.js'
import { getCrmTimezoneForUser } from '../services/crm/timezone.js'
import { getEvaluationSourceSetting, requireCrmProjects } from '../services/criteriaiq/evaluationSource.js'
import { getHubspotConfig } from '../services/hubspot/config.js'
import { getSfInternalDomains } from '../services/config/integrations.js'
import { listHubspotContactsOnRecord } from '../services/hubspot/attendees.js'
import { getHubspotOwnerIdForUser } from '../services/hubspot/owners.js'
import { refreshHubspotTickets, searchHubspotTickets } from '../services/hubspot/tickets.js'
import { checkLinkedRecords, hubspotObjectForLink, type LinkSlot } from '../services/hubspot/linkHealth.js'
import { canEditHubspotDeal } from '../services/hubspot/dealEditPolicy.js'
import { canWriteHubspotDeals, hubspotAssignedSeOptions, isEditableDealFieldExtra, readHubspotAssignedSe, readHubspotDealField, resolveAssignedSeField, writeHubspotAssignedSe, writeHubspotDealField } from '../services/hubspot/dealFields.js'
import { HUBSPOT_PROPERTY_RX } from '../../shared/crmExtras.js'
import { db } from '../db/index.js'
import { activities, hubspotOwners, users } from '../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { getAccessibleTeamIds } from '../middleware/rbac.js'
import { canViewActivityById } from '../services/activities/access.js'
import { HUBSPOT_ID_RX, hubspotRecordLinkBase, isHubspotProjectObject } from '../../shared/hubspot.js'
import {
  HUBSPOT_STRING_MAX, hubspotProjectOptions, listDealProjects, prependHubspotProjectField, readHubspotProjectFields,
  readPrependCurrent, resolvePrependTarget, writeHubspotProjectFields,
} from '../services/hubspot/projects.js'
import { logAudit } from '../services/audit/log.js'
import { z } from 'zod'

// CRM-neutral reads every signed-in user needs (mounted under apiRouter,
// which already applies requireAuth). The client uses this to hide CRM
// features an App Admin has switched off; the server enforces the same
// switches itself, so hiding is never the only guard.
export const crmRouter = Router()

// The switches as they apply: an App Admin's choice narrowed by what the CRM
// offers (a HubSpot portal without Marketing Hub has no Campaigns).
crmRouter.get('/features', async (_req, res) => {
  res.json({ data: await getEffectiveCrmFeatures(), error: null, meta: {} })
})

// Which CRM the install uses, so screens can show that CRM's own words
// (Deal instead of Opportunity for HubSpot). Display only; every CRM route
// enforces the provider itself.
// For HubSpot it also carries where record pages live in the portal
// (https://{domain}/contacts/{portalId}/record), so a ticket number can link
// out the way a Salesforce Id links to the org.
crmRouter.get('/provider', async (_req, res) => {
  const provider = await getCrmProviderId()
  let recordLinkBase: string | null = null
  if (provider === 'hubspot') {
    const cfg = await getHubspotConfig().catch(() => null)
    recordLinkBase = cfg ? hubspotRecordLinkBase(cfg.portalId, cfg.uiDomain) : null
  }
  res.json({ data: { provider, recordLinkBase }, error: null, meta: {} })
})

// The signed-in user's own link to the active CRM, for My Settings → My
// Connections. HubSpot has no per-user sign-in (one portal-wide connection),
// so this reports the portal and the HubSpot owner the user is matched to
// (manual link in User Management, else email). Other CRMs only report the
// provider; Salesforce keeps its own /auth/salesforce/status.
crmRouter.get('/me', async (req, res) => {
  const provider = await getCrmProviderId()
  if (provider !== 'hubspot') { res.json({ data: { provider }, error: null, meta: {} }); return }
  const cfg = await getHubspotConfig().catch(() => null)
  let owner: { id: string; name: string | null; email: string | null } | null = null
  if (cfg) {
    const ownerId = await getHubspotOwnerIdForUser(req.user!.id)
    if (ownerId) {
      const [row] = await db.select({ id: hubspotOwners.id, email: hubspotOwners.email, firstName: hubspotOwners.firstName, lastName: hubspotOwners.lastName })
        .from(hubspotOwners).where(eq(hubspotOwners.id, ownerId)).limit(1)
      if (row) owner = { id: row.id, name: [row.firstName, row.lastName].filter(Boolean).join(' ') || null, email: row.email }
    }
  }
  res.json({
    data: { provider, configured: !!cfg, portalName: cfg ? (cfg.portalName ?? cfg.uiDomain) : null, owner },
    error: null,
    meta: {},
  })
})

// GET /api/crm/me/tz — the timezone the active CRM holds for the caller, for
// My Settings → Timezone (v1.469.0): the user's own Salesforce timezone, or the
// HubSpot portal's. provider 'none' answers connected: false.
crmRouter.get('/me/tz', async (req, res) => {
  res.json({ data: await getCrmTimezoneForUser(req.user!.id), error: null, meta: {} })
})

// Where Projects come from (Admin → Integrations → Projects). Screens use
// `primary` to hide every Project feature when it is 'off'; the Project
// routes enforce the same rule themselves (requireProjectsOn).
crmRouter.get('/evaluation-source', async (_req, res) => {
  const { primary, criteriaiqSecondary } = await getEvaluationSourceSetting()
  res.json({ data: { primary, criteriaiqSecondary }, error: null, meta: {} })
})

// ── CRM-neutral search + hover preview (v1.390.0) ──────────────────────────
// The same calls as /api/salesforce/search/* and /preview, routed to
// whichever CRM the install uses. HubSpot screens call these; Salesforce
// screens keep their own routes (which also carry the dev stubs). Every call
// runs as the signed-in user's own CRM session, never an admin connection.

// Same per-user ceiling as the Salesforce router: these reach a metered CRM API.
const crmCallLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyFn: (req) => req.user!.id })

type SessionHandler = (session: CrmUserSession, req: Request, res: Response, provider: CrmProvider) => Promise<void>

function withSession(handler: SessionHandler): RequestHandler {
  return async (req, res) => {
    const provider = await getActiveCrmProvider()
    if (!provider) { res.status(409).json({ data: null, error: 'errors.crm.provider_mismatch', meta: {} }); return }
    try {
      const session = await provider.connectForUser(req.user!.id)
      if (!session) {
        // v1.424.0: on HubSpot a missing session means the user isn't matched
        // to an active HubSpot user (the portal key itself is install-wide).
        const error = provider.id === 'hubspot' && (await getHubspotConfig()) !== null ? 'errors.hubspot.no_owner_match_search' : 'errors.crm.not_connected'
        res.status(provider.id === 'hubspot' ? 403 : 401).json({ data: null, error, meta: { provider: provider.id } })
        return
      }
      await handler(session, req, res, provider)
    } catch (err) {
      const code = err instanceof HubspotError ? err.code : 'errors.crm.search_failed'
      console.error('[crm] %s %s failed:', req.method, req.path, err instanceof HubspotError ? err.code : err)
      res.status(502).json({ data: null, error: code, meta: {} })
    }
  }
}

function q(req: Request): string {
  return typeof req.query['q'] === 'string' ? req.query['q'] : ''
}

// GET /api/crm/search/opportunities?q=&teamId=&open=true&showClosed=true
crmRouter.get('/search/opportunities', crmCallLimiter, withSession(async (session, req, res) => {
  const query = q(req)
  if (query.length < 2) { res.json({ data: [], error: null, meta: {} }); return }
  const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : null
  const results = await session.searchOpportunities(query, {
    openSearch: req.query['open'] === 'true',
    showClosed: req.query['showClosed'] === 'true',
    teamId,
  })
  res.json({ data: results, error: null, meta: {} })
}))

// GET /api/crm/search/accounts?q=
crmRouter.get('/search/accounts', crmCallLimiter, withSession(async (session, req, res) => {
  const query = q(req)
  if (query.length < 2) { res.json({ data: [], error: null, meta: {} }); return }
  res.json({ data: await session.searchAccounts(query), error: null, meta: {} })
}))

// GET /api/crm/search/contacts?q=
crmRouter.get('/search/contacts', crmCallLimiter, withSession(async (session, req, res) => {
  const query = q(req)
  if (query.length < 2) { res.json({ data: [], error: null, meta: {} }); return }
  res.json({ data: await session.searchContacts(query), error: null, meta: {} })
}))

// GET /api/crm/search/leads?q= — refused while Admin → CRM features has Leads off
// or the HubSpot portal has no Leads.
crmRouter.get('/search/leads', crmCallLimiter, async (req, res, next) => {
  const blocked = await crmFeatureBlock('leads')
  if (blocked) { res.status(403).json({ data: null, error: blocked, meta: {} }); return }
  next()
}, withSession(async (session, req, res) => {
  const query = q(req)
  if (query.length < 2) { res.json({ data: [], error: null, meta: {} }); return }
  res.json({ data: await session.searchLeads(query), error: null, meta: {} })
}))

// GET /api/crm/search/campaigns?q=&attendeeEmails= — refused while Campaigns is off
// or the HubSpot portal has no Campaigns (Marketing Hub).
crmRouter.get('/search/campaigns', crmCallLimiter, async (req, res, next) => {
  const blocked = await crmFeatureBlock('campaigns')
  if (blocked) { res.status(403).json({ data: null, error: blocked, meta: {} }); return }
  next()
}, withSession(async (session, req, res) => {
  const query = q(req)
  const raw = typeof req.query['attendeeEmails'] === 'string' ? req.query['attendeeEmails'] : ''
  const attendeeEmails = raw ? raw.split(',').map((e) => e.trim()).filter(Boolean) : []
  if (query.length < 2 && attendeeEmails.length === 0) { res.json({ data: [], error: null, meta: {} }); return }
  res.json({ data: await session.searchCampaigns(query, attendeeEmails), error: null, meta: {} })
}))

// ── Attendee matching (HubSpot plan, phase 7b) ──────────────────────────
// The CRM-neutral twins of /api/salesforce/search/from-attendees and
// /api/salesforce/suggestions/by-attendees: contacts matched by email, then
// their Accounts and open Opportunities (Companies and open Deals on HubSpot).

function emailList(raw: unknown[]): string[] {
  return [...new Set(raw
    .filter((v): v is string => typeof v === 'string')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@') && e.length <= 320))].slice(0, 200)
}

// GET /api/crm/search/from-attendees?emails=a,b — the "Suggested from
// attendees" section of the CRM Link picker.
crmRouter.get('/search/from-attendees', crmCallLimiter, withSession(async (session, req, res) => {
  const raw = typeof req.query['emails'] === 'string' ? req.query['emails'] : ''
  const emails = emailList(raw.split(','))
  if (emails.length === 0) { res.json({ data: { accounts: [], opportunities: [] }, error: null, meta: {} }); return }
  const { accounts, opportunities } = await session.suggestFromAttendees(emails)
  res.json({
    data: {
      accounts: accounts.map((a) => ({ Id: a.Id, Name: a.Name, matchedEmail: a.contactEmail })),
      opportunities: opportunities.map((o) => ({ Id: o.Id, Name: o.Name, AccountId: o.AccountId, AccountName: o.AccountName, StageName: o.StageName, Amount: o.Amount, CloseDate: o.CloseDate, ForecastCategoryName: o.ForecastCategoryName, OwnerName: o.OwnerName, matchedEmail: o.contactEmail })),
    },
    error: null,
    meta: {},
  })
}))

// POST /api/crm/suggestions/by-attendees { emails } — the activity form's
// attendee quick-picks. Internal-domain addresses are dropped first, same
// as the Salesforce route.
crmRouter.post('/suggestions/by-attendees', crmCallLimiter, withSession(async (session, req, res) => {
  const body = req.body as { emails?: unknown }
  const internal = await getSfInternalDomains()
  const external = emailList(Array.isArray(body.emails) ? body.emails : [])
    .filter((e) => !internal.includes(e.split('@')[1] ?? ''))
  if (external.length === 0) { res.json({ data: { accounts: [], opportunities: [] }, error: null, meta: {} }); return }
  const result = await session.suggestFromAttendees(external)
  res.json({ data: result, error: null, meta: { emailsMatched: external.length } })
}))

// GET /api/crm/preview/:type/:id — hover popover. Same contract as the
// Salesforce route: always 200, the local snapshot on `activities` is the
// floor and a live read layers over it field by field.
crmRouter.get('/preview/:type/:id', crmCallLimiter, async (req, res) => {
  const { type, id } = req.params as { type: string; id: string }
  if (type !== 'Opportunity' && type !== 'Account') {
    res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} })
    return
  }
  const provider = await getActiveCrmProvider()
  if (!provider) { res.status(409).json({ data: null, error: 'errors.crm.provider_mismatch', meta: {} }); return }
  if (!provider.isRecordId(id)) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }
  const snapshot = await readSnapshot(id, type, { userId: req.user!.id, teamIds: await getAccessibleTeamIds(req.user!.id) })
  let session: CrmUserSession | null = null
  try { session = await provider.connectForUser(req.user!.id) } catch { session = null }
  const live = session ? await session.readPreview(id, type).catch(() => null) : null
  const merged = live ? mergePreview(snapshot, live) : snapshot
  const [assignedSeMatched, primaryEngineerMatched] = await Promise.all([
    isImpactIqUserName(merged.assignedSeName),
    isImpactIqUserName(merged.primaryEngineerName),
  ])
  res.json({ data: { ...merged, assignedSeMatched, primaryEngineerMatched }, error: null, meta: { connected: !!session, live: !!live } })
})

// ── Support Tickets on HubSpot (phase 4) ──────────────────────────────────
// The HubSpot side of /api/salesforce/tickets/*, same row shape. HubSpot
// only: Salesforce keeps its own routes, and with no CRM or another one
// these answer 409.

async function requireHubspot(res: Response): Promise<boolean> {
  if ((await getCrmProviderId()) !== 'hubspot') {
    res.status(409).json({ data: null, error: 'errors.crm.provider_mismatch', meta: {} })
    return false
  }
  if (!(await getHubspotConfig())) {
    res.status(401).json({ data: null, error: 'errors.crm.not_connected', meta: { provider: 'hubspot' } })
    return false
  }
  return true
}

// GET /api/crm/tickets/search?teamId=&accountId=&q=&includeClosed=true
// accountId (a Company id) lists that Company's tickets; without it, q
// searches every ticket. Closed-stage tickets are left out unless asked for.
crmRouter.get('/tickets/search', crmCallLimiter, async (req, res) => {
  if (!(await requireHubspot(res))) return
  const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : null
  const accountId = typeof req.query['accountId'] === 'string' ? req.query['accountId'] : null
  if (teamId && !(await getAccessibleTeamIds(req.user!.id)).includes(teamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  try {
    const rows = await searchHubspotTickets({ teamId, companyId: accountId, query: q(req), includeClosed: req.query['includeClosed'] === 'true' })
    res.json({ data: rows, error: null, meta: {} })
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.crm.search_failed'
    console.error('[crm] ticket search failed:', err instanceof HubspotError ? err.code : err)
    res.status(502).json({ data: null, error: code, meta: {} })
  }
})

// GET /api/crm/tickets/refresh?activityId= — the drawer's background
// re-read of already-attached tickets. Always answers with the stored rows
// at worst, never an error the drawer has to handle.
crmRouter.get('/tickets/refresh', crmCallLimiter, async (req, res) => {
  const activityId = typeof req.query['activityId'] === 'string' ? req.query['activityId'] : null
  if (!activityId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!(await requireHubspot(res))) return
  // Same viewer rule as the Salesforce route and GET /api/activities/:id.
  if (!(await canViewActivityById(req.user!.id, activityId))) {
    res.json({ data: [], error: null, meta: {} })
    return
  }
  const { rows, refreshFailed } = await refreshHubspotTickets(activityId)
  res.json({ data: rows, error: null, meta: refreshFailed ? { refreshFailed: true } : {} })
})

// GET /api/crm/accounts/:id/contacts?q=&kind=opportunity|account (phase 7b)
// — the Attendees section's "contacts on the linked record" search on
// HubSpot: the Company's contacts, or a Deal's primary Company's.
crmRouter.get('/accounts/:id/contacts', crmCallLimiter, async (req, res) => {
  if (!(await requireHubspot(res))) return
  const { id } = req.params as { id: string }
  if (!HUBSPOT_ID_RX.test(id)) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  const kind = req.query['kind'] === 'opportunity' ? 'opportunity' : 'account'
  const query = q(req).slice(0, 100)
  try {
    res.json({ data: await listHubspotContactsOnRecord(id, kind, query), error: null, meta: {} })
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.crm.search_failed'
    console.error('[crm] record contacts failed:', code)
    res.status(502).json({ data: null, error: code, meta: {} })
  }
})

// GET /api/crm/activity-link-status?activityId= — the HubSpot side of
// /api/salesforce/activity-link-status (phase 7): the drawer's one live check
// of the activity's linked Deal/Company/Contact/Lead/Project. Same contract:
// always 200, each link checked on its own, and a failed check leaves that
// link's flag alone. A record HubSpot merged into another is not broken: the
// link moves to the surviving record (for every activity that points at it)
// and meta.moved lists old → new ids so the open drawer can follow.
crmRouter.get('/activity-link-status', crmCallLimiter, async (req, res) => {
  const activityId = typeof req.query['activityId'] === 'string' ? req.query['activityId'] : null
  if (!activityId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  if (!(await requireHubspot(res))) return
  const cols = {
    teamId: activities.teamId, userId: activities.userId,
    crmWhatId: activities.crmWhatId, crmWhatType: activities.crmWhatType,
    crmWhoId: activities.crmWhoId, crmWhoType: activities.crmWhoType,
    crmRelatedId: activities.crmRelatedId, crmRelatedType: activities.crmRelatedType,
    crmWhatDeleted: activities.crmWhatDeleted, crmWhoDeleted: activities.crmWhoDeleted, crmRelatedDeleted: activities.crmRelatedDeleted,
  }
  const [activity] = await db.select(cols).from(activities).where(eq(activities.id, activityId)).limit(1)
  if (!activity) { res.status(404).json({ data: null, error: 'errors.activities.not_found', meta: {} }); return }
  if (!(await canViewActivityById(req.user!.id, activityId))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const flags = (a: typeof activity) => ({ crmWhatDeleted: a.crmWhatDeleted, crmWhoDeleted: a.crmWhoDeleted, crmRelatedDeleted: a.crmRelatedDeleted })
  const links: Array<{ slot: LinkSlot; id: string | null; type: string | null }> = [
    { slot: 'what', id: activity.crmWhatId, type: activity.crmWhatType },
    { slot: 'who', id: activity.crmWhoId, type: activity.crmWhoType },
    { slot: 'related', id: activity.crmRelatedId, type: activity.crmRelatedType },
  ]
  const checkable = links.flatMap((l) => {
    const objectType = hubspotObjectForLink(l.slot, l.type)
    return objectType && l.id && HUBSPOT_ID_RX.test(l.id) ? [{ slot: l.slot, objectType, id: l.id }] : []
  })
  if (checkable.length === 0) { res.json({ data: flags(activity), error: null, meta: { skipped: true } }); return }

  for (const link of checkable) {
    try {
      await checkLinkedRecords(link.slot, link.objectType, [link.id])
    } catch (err) {
      // Couldn't check: leave this link's stored flag as it was.
      console.warn('[crm] link check failed:', err instanceof HubspotError ? err.code : err)
    }
  }
  const [after] = await db.select(cols).from(activities).where(eq(activities.id, activityId)).limit(1)
  if (!after) { res.json({ data: flags(activity), error: null, meta: {} }); return }
  const moved: Record<string, { from: string; to: string }> = {}
  const afterIds = { what: after.crmWhatId, who: after.crmWhoId, related: after.crmRelatedId }
  for (const l of links) {
    const to = afterIds[l.slot]
    if (l.id && to && to !== l.id) moved[l.slot] = { from: l.id, to }
  }
  res.json({ data: flags(after), error: null, meta: Object.keys(moved).length > 0 ? { moved } : {} })
})

// ── Assigned SE on a HubSpot Deal (phase 6) ───────────────────────────────
// The HubSpot side of /api/salesforce/opportunities/:id/assigned-se and the
// Assigned SE picklist route, same shapes. Reads and writes the property the
// team maps as assigned_se_write on deals; with none mapped, meta.configured
// is false and the form hides the picker.

async function teamFromQuery(req: Request, res: Response, raw: unknown): Promise<string | null | false> {
  const teamId = typeof raw === 'string' && raw.length > 0 ? raw : null
  if (teamId && !(await getAccessibleTeamIds(req.user!.id)).includes(teamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return false
  }
  return teamId
}

// v1.424.0 (security audit M4): may the caller change this Deal? Null when
// yes, else the error key: not matched to a HubSpot user, or (under the
// "Only people named on the Deal" setting) not named in the chosen Deal
// properties. Throws when HubSpot can't be read.
async function dealEditBlock(userId: string, dealId: string): Promise<string | null> {
  if (await canEditHubspotDeal(userId, dealId)) return null
  return (await getHubspotOwnerIdForUser(userId)) ? 'errors.hubspot.deal_not_named' : 'errors.hubspot.no_owner_match'
}

crmRouter.get('/opportunities/:id/assigned-se', crmCallLimiter, async (req, res) => {
  if (!(await requireHubspot(res))) return
  const teamId = await teamFromQuery(req, res, req.query['teamId'])
  if (teamId === false) return
  const { id } = req.params as { id: string }
  try {
    const field = await resolveAssignedSeField(teamId)
    if (!field) { res.json({ data: { userId: null, userName: null, matched: null }, error: null, meta: { configured: false } }); return }
    const value = await readHubspotAssignedSe(field, id)
    // A failed check reads as read-only rather than failing the read.
    const block = await dealEditBlock(req.user!.id, id).catch(() => 'errors.hubspot.bad_response')
    res.json({ data: value, error: null, meta: { configured: true, writeField: field.property, fieldType: field.fieldType, canWrite: block === null, readOnlyReason: block } })
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.crm.search_failed'
    console.error('[crm] assigned SE read failed:', err instanceof HubspotError ? err.code : err)
    res.status(502).json({ data: null, error: code, meta: {} })
  }
})

crmRouter.patch('/opportunities/:id/assigned-se', crmCallLimiter, async (req, res) => {
  if (!(await requireHubspot(res))) return
  const body = (req.body ?? {}) as { userId?: unknown; userName?: unknown; teamId?: unknown }
  const teamId = await teamFromQuery(req, res, body.teamId)
  if (teamId === false) return
  const { id } = req.params as { id: string }
  const value = typeof body.userId === 'string' && body.userId.trim().length > 0 ? body.userId.trim().slice(0, 500) : null
  const valueName = typeof body.userName === 'string' ? body.userName.slice(0, 500) : null
  let block: string | null
  try { block = await dealEditBlock(req.user!.id, id) } catch (err) { sendHubspotFailure(res, err, 'deal edit check'); return }
  if (block) { res.status(403).json({ data: null, error: block, meta: {} }); return }
  const field = await resolveAssignedSeField(teamId).catch(() => null)
  if (!field) { res.status(409).json({ data: null, error: 'errors.hubspot.assigned_se_unmapped', meta: {} }); return }
  // An owner or option property only takes its own values.
  if (value && field.fieldType !== 'string') {
    const allowed = (await hubspotAssignedSeOptions(field)).some((o) => o.value === value)
    if (!allowed) { res.status(400).json({ data: null, error: 'errors.hubspot.assigned_se_invalid', meta: {} }); return }
  }
  const error = await writeHubspotAssignedSe({ field, dealId: id, value, valueName, userId: req.user!.id })
  if (error) { res.status(502).json({ data: null, error, meta: { field: field.property } }); return }
  res.json({ data: { id, assignedSeUserId: value, writeField: field.property }, error: null, meta: {} })
})

crmRouter.get('/picklists/opportunity/assigned-se', crmCallLimiter, async (req, res) => {
  if (!(await requireHubspot(res))) return
  const teamId = await teamFromQuery(req, res, req.query['teamId'])
  if (teamId === false) return
  try {
    const field = await resolveAssignedSeField(teamId)
    if (!field) { res.json({ data: [], error: null, meta: { fieldType: null } }); return }
    res.json({ data: await hubspotAssignedSeOptions(field), error: null, meta: { fieldType: field.fieldType === 'string' ? 'string' : 'picklist', field: field.property } })
  } catch (err) {
    const code = err instanceof HubspotError ? err.code : 'errors.crm.search_failed'
    res.status(502).json({ data: null, error: code, meta: {} })
  }
})

// ── Opp field extras on a HubSpot Deal ───────────────────────────────────
// The HubSpot side of /api/salesforce/opportunities/:id/field: an Activity
// Type's Opp field extra shows one Deal property on the activity form and,
// when the extra is read / write, edits it. A write needs a HubSpot owner
// match (as for Assigned SE) and a read / write extra naming that property
// on one of the user's teams, since ImpactIQ writes with the portal key.

crmRouter.get('/opportunities/:id/field', crmCallLimiter, async (req, res) => {
  if (!(await requireHubspot(res))) return
  const { id } = req.params as { id: string }
  const property = typeof req.query['apiName'] === 'string' ? req.query['apiName'] : ''
  if (!HUBSPOT_PROPERTY_RX.test(property)) { res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} }); return }
  if (!HUBSPOT_ID_RX.test(id)) { res.status(400).json({ data: null, error: 'errors.hubspot.invalid_object', meta: {} }); return }
  try {
    const field = await readHubspotDealField(id, property)
    const canEdit = (await dealEditBlock(req.user!.id, id).catch(() => 'errors.hubspot.bad_response')) === null
    res.json({ data: { value: field.value }, error: null, meta: { label: field.label, options: field.options, writable: field.writable, canEdit } })
  } catch (err) {
    sendHubspotFailure(res, err, 'deal field read')
  }
})

const dealFieldSchema = z.object({
  apiName: z.string().regex(HUBSPOT_PROPERTY_RX),
  value: z.union([z.string().max(65536), z.number(), z.boolean(), z.null()]),
})

crmRouter.patch('/opportunities/:id/field', crmCallLimiter, async (req, res) => {
  if (!(await requireHubspot(res))) return
  const { id } = req.params as { id: string }
  const parsed = dealFieldSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.invalid_api_name', meta: {} }); return }
  const userId = req.user!.id
  let block: string | null
  try { block = await dealEditBlock(userId, id) } catch (err) { sendHubspotFailure(res, err, 'deal edit check'); return }
  if (block) { res.status(403).json({ data: null, error: block, meta: {} }); return }
  if (!(await isEditableDealFieldExtra(await getAccessibleTeamIds(userId), parsed.data.apiName))) {
    res.status(403).json({ data: null, error: 'errors.hubspot.deal_field_not_editable', meta: {} })
    return
  }
  try {
    const result = await writeHubspotDealField({ dealId: id, property: parsed.data.apiName, value: parsed.data.value, userId })
    if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: { field: parsed.data.apiName } }); return }
    res.json({ data: { ok: true }, error: null, meta: {} })
  } catch (err) {
    sendHubspotFailure(res, err, 'deal field write')
  }
})

// ── Projects on HubSpot (phase 6b) ────────────────────────────────────────
// The HubSpot side of the Salesforce Evaluation routes, same shapes: the
// Project picker (records of the Project object associated with a Deal), the
// live field read and edit, and the dated Engineer Notes / Next Steps entry.
// The Project object is named by its objectTypeId (0-970 for HubSpot's own
// Projects, 2-… for a custom object); its fields come from the team's
// HubSpot Field Mappings. Only with Projects coming from the CRM.

function projectObjectFrom(raw: unknown): string | null {
  return typeof raw === 'string' && isHubspotProjectObject(raw) ? raw : null
}

async function projectGuards(req: Request, res: Response, rawTeamId: unknown, rawObject: unknown): Promise<{ teamId: string; objectTypeId: string } | null> {
  if (!(await requireHubspot(res))) return null
  const teamId = await teamFromQuery(req, res, rawTeamId)
  if (teamId === false) return null
  const objectTypeId = projectObjectFrom(rawObject)
  if (!teamId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return null }
  if (!objectTypeId) { res.status(400).json({ data: null, error: 'errors.hubspot.invalid_object', meta: {} }); return null }
  return { teamId, objectTypeId }
}

function sendHubspotFailure(res: Response, err: unknown, what: string): void {
  const code = err instanceof HubspotError ? err.code : 'errors.crm.search_failed'
  console.error('[crm] %s failed:', what, err instanceof HubspotError ? err.code : err)
  res.status(502).json({ data: null, error: code, meta: {} })
}

// GET /api/crm/opportunities/:id/related?sobject=&labelField= — the Project
// records associated with this Deal.
crmRouter.get('/opportunities/:id/related', crmCallLimiter, requireCrmProjects(), async (req, res) => {
  if (!(await requireHubspot(res))) return
  const { id } = req.params as { id: string }
  const objectTypeId = projectObjectFrom(req.query['sobject'])
  if (!objectTypeId) { res.status(400).json({ data: null, error: 'errors.hubspot.invalid_object', meta: {} }); return }
  const labelField = typeof req.query['labelField'] === 'string' ? req.query['labelField'] : null
  try {
    res.json({ data: await listDealProjects(id, objectTypeId, labelField), error: null, meta: {} })
  } catch (err) {
    sendHubspotFailure(res, err, 'project list')
  }
})

// GET /api/crm/evaluations/picklist-values?teamId=&sobject=&field=
crmRouter.get('/evaluations/picklist-values', crmCallLimiter, requireCrmProjects(), async (req, res) => {
  const g = await projectGuards(req, res, req.query['teamId'], req.query['sobject'])
  if (!g) return
  const field = typeof req.query['field'] === 'string' ? req.query['field'] : ''
  try {
    const options = await hubspotProjectOptions(g.teamId, g.objectTypeId, field)
    if (options === 'unmapped') { res.json({ data: [], error: null, meta: { unmapped: true } }); return }
    res.json({ data: options, error: null, meta: {} })
  } catch (err) {
    sendHubspotFailure(res, err, 'project options')
  }
})

// GET /api/crm/evaluations/:relatedId?teamId=&sobject= — data holds the raw
// values the editor sends back; meta.labels what a person reads.
crmRouter.get('/evaluations/:relatedId', crmCallLimiter, requireCrmProjects(), async (req, res) => {
  const g = await projectGuards(req, res, req.query['teamId'], req.query['sobject'])
  if (!g) return
  const { relatedId } = req.params as { relatedId: string }
  try {
    const read = await readHubspotProjectFields(g.teamId, g.objectTypeId, relatedId)
    if (read === 'unmapped') { res.json({ data: null, error: null, meta: { unmapped: true } }); return }
    if (!read) { res.json({ data: null, error: null, meta: { dropped: [] } }); return }
    res.json({ data: read.values, error: null, meta: { dropped: read.dropped, labels: read.labels } })
  } catch (err) {
    sendHubspotFailure(res, err, 'project read')
  }
})

const projectFieldsSchema = z.object({
  teamId: z.string().uuid(),
  sobject: z.string().refine(isHubspotProjectObject),
  fields: z.object({
    eval_status: z.string().max(500).nullable().optional(),
    eval_stage: z.string().max(500).nullable().optional(),
    eval_type: z.string().max(500).nullable().optional(),
    eval_start_date: z.string().max(40).nullable().optional(),
    eval_end_date: z.string().max(40).nullable().optional(),
  }),
})

// PATCH /api/crm/evaluations/:relatedId — writes the edited fields with the
// portal-wide key, so only someone matched to a HubSpot user may.
crmRouter.patch('/evaluations/:relatedId', crmCallLimiter, requireCrmProjects(), async (req, res) => {
  if (!(await requireHubspot(res))) return
  const parsed = projectFieldsSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  const { teamId, sobject, fields } = parsed.data
  if ((await teamFromQuery(req, res, teamId)) === false) return
  if (!(await canWriteHubspotDeals(req.user!.id))) { res.status(403).json({ data: null, error: 'errors.hubspot.no_owner_match_record', meta: {} }); return }
  const { relatedId } = req.params as { relatedId: string }
  const result = await writeHubspotProjectFields({ teamId, objectTypeId: sobject, recordId: relatedId, fields, userId: req.user!.id })
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: { skipped: result.skipped } }); return }
  res.json({ data: { ok: true, updated: result.updated }, error: null, meta: { skipped: result.skipped } })
})

// GET /api/crm/field-prepend/meta?teamId=&sobject=&appField=&recordId= — a
// fresh read of the field before anything is typed.
crmRouter.get('/field-prepend/meta', crmCallLimiter, requireCrmProjects(), async (req, res) => {
  const g = await projectGuards(req, res, req.query['teamId'], req.query['sobject'])
  if (!g) return
  const appField = typeof req.query['appField'] === 'string' ? req.query['appField'] : ''
  const recordId = typeof req.query['recordId'] === 'string' ? req.query['recordId'] : ''
  if (!appField || !recordId) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  try {
    const target = await resolvePrependTarget(g.teamId, g.objectTypeId, appField)
    if (target === 'unmapped') { res.json({ data: null, error: null, meta: { unmapped: true } }); return }
    if (target === 'not_prependable') { res.status(422).json({ data: null, error: 'errors.hubspot.field_not_prependable', meta: {} }); return }
    const current = await readPrependCurrent(g.objectTypeId, recordId, target.property)
    if (!current) { res.status(404).json({ data: null, error: 'errors.hubspot.record_not_found', meta: {} }); return }
    res.json({
      data: {
        fieldLabel: target.label,
        maximumCharacters: HUBSPOT_STRING_MAX,
        currentValue: current.value,
        currentLength: current.value?.length ?? 0,
        lastModifiedDate: current.lastModifiedDate,
      },
      error: null,
      meta: {},
    })
  } catch (err) {
    sendHubspotFailure(res, err, 'prepend meta')
  }
})

const prependSchema = z.object({
  teamId: z.string().uuid(),
  sobject: z.string().refine(isHubspotProjectObject),
  appField: z.string().min(1).max(80),
  recordId: z.string().regex(HUBSPOT_ID_RX),
  text: z.string().trim().min(1).max(HUBSPOT_STRING_MAX),
  expectedLastModifiedDate: z.string().max(60).nullable().optional(),
})

// POST /api/crm/field-prepend — one dated entry above the field's text. The
// date, initials and capacity are worked out on the server.
crmRouter.post('/field-prepend', crmCallLimiter, requireCrmProjects(), async (req, res) => {
  if (!(await requireHubspot(res))) return
  const parsed = prependSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} }); return }
  const { teamId, sobject, appField, recordId, text, expectedLastModifiedDate } = parsed.data
  if ((await teamFromQuery(req, res, teamId)) === false) return
  if (!(await canWriteHubspotDeals(req.user!.id))) { res.status(403).json({ data: null, error: 'errors.hubspot.no_owner_match_record', meta: {} }); return }
  const [me] = await db.select({ firstName: users.firstName, lastName: users.lastName, timezone: users.timezone })
    .from(users).where(eq(users.id, req.user!.id)).limit(1)
  const result = await prependHubspotProjectField({
    teamId, objectTypeId: sobject, recordId, appField, text, expectedLastModifiedDate,
    user: { id: req.user!.id, firstName: me?.firstName ?? null, lastName: me?.lastName ?? null, timezone: me?.timezone ?? null },
  })
  if (!result.ok) { res.status(result.status).json({ data: null, error: result.error, meta: result.meta ?? {} }); return }
  void logAudit(req, {
    action: 'salesforce.field_prepend',
    targetType: sobject,
    targetId: recordId,
    meta: { fieldApiName: result.target?.property ?? null, appField, charactersUsed: result.charactersUsed, crm: 'hubspot' },
  })
  res.json({
    data: {
      formattedEntry: result.formattedEntry,
      charactersUsed: result.charactersUsed,
      maximumCharacters: result.maximumCharacters,
      charactersRemaining: result.charactersRemaining,
    },
    error: null,
    meta: {},
  })
})
