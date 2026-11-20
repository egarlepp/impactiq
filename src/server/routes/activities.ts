import { Router } from 'express'
import { z } from 'zod'
import { db } from '../db/index.js'
import { activities, activitySyncAudit, teamActivityTypes, teamMembers, users, activityProducts, products, activityNotes, activityCrmTickets, crmLeadAccountLink, activityGongCalls } from '../../../drizzle/schema.js'
import { and, eq, gte, lte, desc, inArray, sql, or, ilike } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth.js'
import { getAccessibleTeamIds, requireRole } from '../middleware/rbac.js'
import { activityTypeVisibleToTeams, canViewActivity } from '../services/activities/access.js'
import { CreateActivitySchema, UpdateActivitySchema, RelinkOpportunitySchema } from '../../shared/schemas/index.js'
import { crmLinkBlockError, getEffectiveCrmFeatures } from '../services/crm/features.js'
import { areProjectsOn, requireProjectsOn } from '../services/criteriaiq/evaluationSource.js'
import { checkProjectLink } from '../services/criteriaiq/primaryProjects.js'
import { startOfWeek } from 'date-fns'
import { queueCrmActivitySync } from '../services/crm/index.js'
import { emitActivityEvent } from '../services/webhooks/events.js'
import { getCrmProviderId } from '../services/crm/providerSetting.js'
import { kickOutlookWriteback } from '../services/outlook/writeback.js'
import { logAudit } from '../services/audit/log.js'
import { getAdminSfConnection } from '../services/salesforce/client.js'
import { fetchLiveOpportunitySnapshot, applyOpportunityRelink, type RelinkSnapshotPatch } from '../services/salesforce/relinkOpportunity.js'
import { readHubspotDealForRelink } from '../services/hubspot/refreshSnapshots.js'
import { HubspotError } from '../services/hubspot/client.js'
import { getHubspotConfig } from '../services/hubspot/config.js'
import { HUBSPOT_ID_RX } from '../../shared/hubspot.js'
import { isActivityTypeExtraShownOn } from '../../shared/crmExtras.js'

export const activitiesRouter = Router()

activitiesRouter.use(requireAuth)

// v1.156.0: if the activity's OWNER opted in to Outlook write-back and this is
// a submitted activity that wasn't created from an existing meeting, flag it
// pending and kick the worker. Gated on the owner's opt-in (not the caller's)
// so admin-on-behalf edits still respect the owner's choice.
// v1.256.0: resolves a chosen Subtype id to its current name, snapshotted
// onto activities.subtype_name at write time — same denormalization
// convention as crm_what_name, except resolved server-side rather than
// trusted from the client, since Subtypes are ImpactIQ's own admin-managed
// list (drizzle/schema.ts's teamActivityTypeSubtypes) rather than an
// external Salesforce search result. Returns null for a null/undefined id
// so callers can assign both subtypeId and subtypeName in one pass.
async function resolveSubtypeName(subtypeId: string | null | undefined): Promise<string | null> {
  if (!subtypeId) return null
  const { teamActivityTypeSubtypes } = await import('../../../drizzle/schema.js')
  const [row] = await db.select({ name: teamActivityTypeSubtypes.name }).from(teamActivityTypeSubtypes).where(eq(teamActivityTypeSubtypes.id, subtypeId)).limit(1)
  return row?.name ?? null
}

async function maybeKickOutlookWriteback(row: { id: string; userId: string; status: string; outlookEventId: string | null } | undefined): Promise<void> {
  if (!row || row.status !== 'submitted' || row.outlookEventId) return
  const [owner] = await db.select({ enabled: users.outlookWritebackEnabled }).from(users).where(eq(users.id, row.userId)).limit(1)
  if (!owner?.enabled) return
  await db.update(activities).set({ outlookSyncStatus: 'pending', outlookSyncError: null }).where(eq(activities.id, row.id))
  kickOutlookWriteback(row.id)
}

// v1.244.0: the mirror image of the above. maybeKickOutlookWriteback handles
// activities with NO outlookEventId (ImpactIQ creates the event, and the create
// payload carries the ImpactIQ category). This handles the opposite case — an
// activity approved FROM an existing meeting invite, where there's nothing to
// create but the meeting should still be marked as logged in Outlook.
//
// That gap is why the category appeared on ImpactIQ-authored events but never on
// meetings someone else organized: the only code that set it was the create
// payload, and this path never reaches it.
//
// v1.336.0: also syncs the title/subject, using the same mailbox-local-write
// contract as the category sync above — see ensureEventTitleSynced()'s own
// comment in client.ts. Skipped for a Private/Confidential meeting
// (isPrivateMeeting): activities.title already holds the meeting's real
// subject even when the UI substitutes "Private meeting" for display, so
// there's technically nothing to leak here, but a contributor-edited Title
// on a flagged-private meeting gets an extra guard rather than assuming the
// display substitution is the only thing standing between it and Outlook.
//
// Fire-and-forget on purpose. Approval must not get slower, and must never fail,
// because of a calendar cosmetic — so errors are logged and dropped. A later
// re-approve retries, and both operations are idempotent.
function maybeSyncOutlookEvent(row: { id: string; userId: string; status: string; outlookEventId: string | null; title: string; isPrivateMeeting: boolean | null } | undefined): void {
  if (!row || row.status !== 'submitted' || !row.outlookEventId) return
  const eventId = row.outlookEventId
  void (async () => {
    try {
      // Gated on the same opt-in as write-back: it's the flag that means
      // "ImpactIQ may write to my calendar", and it's what caused the
      // Calendars.ReadWrite scope to be granted in the first place. Without it
      // this would 403 on every approval.
      const [owner] = await db.select({ enabled: users.outlookWritebackEnabled }).from(users).where(eq(users.id, row.userId)).limit(1)
      if (!owner?.enabled) return
      const { ensureEventCategorized, ensureEventTitleSynced } = await import('../services/outlook/client.js')
      await ensureEventCategorized(row.userId, eventId)
      if (!row.isPrivateMeeting) await ensureEventTitleSynced(row.userId, eventId, row.title)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[outlook-sync] failed for activity', row.id, err instanceof Error ? err.message : err)
    }
  })()
}

// Returns the effective user id to query for — either the caller (default) or
// another user, when the caller is an app admin or a team_admin on a team the
// target belongs to. Returns null when access is denied.
async function resolveTargetUserId(callerId: string, requested: string | null): Promise<string | null> {
  if (!requested || requested === callerId) return callerId
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  if (caller?.isAppAdmin) return requested
  const shared = await db.select({ role: teamMembers.role, teamId: teamMembers.teamId })
    .from(teamMembers).where(eq(teamMembers.userId, callerId))
  const callerAdminTeams = shared.filter((m) => m.role === 'admin' || m.role === 'team_admin').map((m) => m.teamId)
  if (callerAdminTeams.length === 0) return null
  const [match] = await db.select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, requested), inArray(teamMembers.teamId, callerAdminTeams)))
    .limit(1)
  return match ? requested : null
}

// GET /api/activities/by-sf?teamId=&whatId=
// Returns submitted activities across all team members for a given SF Opportunity/Account.
// Drafts excluded — only finalized activities are visible cross-user.
// v1.67.0: Activity form asks "for the type the user just picked, are
// there any Salesforce Extras to render?" Returns the raw rows from
// team_activity_type_crm_extras so the client can dispatch to the right
// component (opp_field_display or related_object_picker).
activitiesRouter.get('/sf-extras/:typeId', async (req, res) => {
  const { typeId } = req.params as { typeId: string }
  // Only a type on one of the caller's teams (audit L1, v1.422.0).
  if (!(await activityTypeVisibleToTeams(typeId, await getAccessibleTeamIds(req.user!.id)))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
    return
  }
  const { teamActivityTypeCrmExtras } = await import('../../../drizzle/schema.js')
  const rows = await db.select().from(teamActivityTypeCrmExtras).where(eq(teamActivityTypeCrmExtras.teamActivityTypeId, typeId))
  // v1.387.0: with Projects off (Admin → Integrations → Projects), the
  // Project picker is left out, which hides it everywhere the form, the
  // suggested-meeting card and the activity card render Extras.
  const projectsOn = await areProjectsOn()
  // An Opp field or related picker reads one CRM's records, so only the
  // active CRM's extras are shown (shared/crmExtras.ts).
  const provider = await getCrmProviderId()
  const visible = rows.filter((r) => (projectsOn || r.kind !== 'related_object_picker') && isActivityTypeExtraShownOn(r.kind, r.config, provider))
  res.json({ data: visible, error: null, meta: {} })
})

activitiesRouter.get('/by-sf', async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const whatId = req.query['whatId'] as string | undefined
  // Optional CSV list of additional whatIds (e.g. Opportunities under an
  // Account) so the drawer can show the same rolled-up set the parent
  // dashboard already aggregated. Deduped against `whatId`.
  const whatIdsParam = req.query['whatIds'] as string | undefined
  // v1.67.0: relatedId filter — when set, we look up activities where
  // crm_related_id matches (used by the "Evaluation clickable" flow that
  // opens the SF Activities modal scoped to one Evaluation record).
  const relatedId = req.query['relatedId'] as string | undefined
  const startDate = req.query['startDate'] as string | undefined
  const endDate = req.query['endDate'] as string | undefined
  if (!teamId || (!whatId && !whatIdsParam && !relatedId)) {
    res.status(400).json({ data: null, error: 'errors.validation.activity_params_required', meta: {} })
    return
  }
  // Only a team the caller can see (security audit H3, v1.422.0; same
  // check as the account drill-in).
  if (!(await getAccessibleTeamIds(req.user!.id)).includes(teamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const allIds = Array.from(new Set([
    ...(whatId ? [whatId] : []),
    ...(whatIdsParam ? whatIdsParam.split(',').filter(Boolean) : []),
  ]))

  // Optional date-range filter — the drawer uses this to show the
  // dashboard's active window ("Filtered") vs the full history ("All").
  const rangeConds = []
  if (startDate) {
    const s = new Date(startDate)
    if (!Number.isNaN(s.getTime())) rangeConds.push(gte(activities.startDatetime, s))
  }
  if (endDate) {
    const e = new Date(endDate)
    if (!Number.isNaN(e.getTime())) {
      e.setUTCHours(23, 59, 59, 999)
      rangeConds.push(lte(activities.startDatetime, e))
    }
  }

  const rows = await db
    .select({
      id: activities.id,
      title: activities.title,
      startDatetime: activities.startDatetime,
      endDatetime: activities.endDatetime,
      effortHours: activities.effortHours,
      notes: activities.notes,
      descriptionBody: activities.descriptionBody,
      locationMode: activities.locationMode,
      meetingOwner: activities.meetingOwner,
      meetingOwnerEmail: activities.meetingOwnerEmail,
      attendees: activities.attendees,
      acv: activities.acv,
      costTransportation: activities.costTransportation,
      costLodging: activities.costLodging,
      costFood: activities.costFood,
      incidentalCurrency: activities.incidentalCurrency,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
      oppAmount: activities.oppAmount,
      oppCloseDate: activities.oppCloseDate,
      crmWhatId: activities.crmWhatId,
      crmWhatType: activities.crmWhatType,
      crmWhatName: activities.crmWhatName,
      crmAccountId: activities.crmAccountId,
      crmAccountName: activities.crmAccountName,
      crmAssignedSeName: activities.crmAssignedSeName,
      crmWhoId: activities.crmWhoId,
      crmWhoType: activities.crmWhoType,
      crmWhoName: activities.crmWhoName,
      crmRecordId: activities.crmRecordId,
      crmSyncStatus: activities.crmSyncStatus,
      activityTypeName: teamActivityTypes.name,
      activityTypeColor: teamActivityTypes.color,
      activityTypeIcon: teamActivityTypes.icon,
      userId: activities.userId,
      userDisplayName: users.displayName,
      userEmail: users.email,
      createdAt: activities.createdAt,
    })
    .from(activities)
    .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .innerJoin(users, eq(activities.userId, users.id))
    .where(
      and(
        eq(activities.teamId, teamId),
        // Either match on crm_what_id (Opp/Account/Campaign) OR on
        // crm_related_id (Evaluation and future child-object pickers).
        relatedId
          ? eq(activities.crmRelatedId, relatedId)
          : inArray(activities.crmWhatId, allIds),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        ...rangeConds,
      ),
    )
    .orderBy(desc(activities.startDatetime))

  const totalHours = rows.reduce((sum, r) => sum + Number(r.effortHours), 0)
  res.json({
    data: rows,
    error: null,
    meta: { count: rows.length, totalHours: Math.round(totalHours * 100) / 100 },
  })
})

// v1.148.0: GET /api/activities/eval-fields?teamId=&relatedId=
// Reads the LOCAL Evaluation__c snapshot (crm_eval_* columns) off any one
// activity sharing crmRelatedId — no live Salesforce call. Kept fresh by
// the nightly refreshOppSnapshots job and by PATCH
// /api/salesforce/evaluations/:relatedId on every live edit. Powers both
// the ActivityForm compact info box and the drill-in Project modal.
activitiesRouter.get('/eval-fields', requireProjectsOn(), async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const relatedId = req.query['relatedId'] as string | undefined
  if (!teamId || !relatedId) {
    res.status(400).json({ data: null, error: 'errors.validation.activity_params_required', meta: {} })
    return
  }
  // Only a team the caller can see (audit L1, v1.422.0).
  if (!(await getAccessibleTeamIds(req.user!.id)).includes(teamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const [row] = await db
    .select({
      crmRelatedName: activities.crmRelatedName,
      crmEvalStatus: activities.crmEvalStatus,
      crmEvalStage: activities.crmEvalStage,
      crmEvalType: activities.crmEvalType,
      crmEvalStartDate: activities.crmEvalStartDate,
      crmEvalEndDate: activities.crmEvalEndDate,
      crmEvalPrimaryEngineer: activities.crmEvalPrimaryEngineer,
      crmSnapshotRefreshedAt: activities.crmSnapshotRefreshedAt,
    })
    .from(activities)
    .where(and(eq(activities.teamId, teamId), eq(activities.crmRelatedId, relatedId)))
    .orderBy(desc(activities.updatedAt))
    .limit(1)
  res.json({ data: row ?? null, error: null, meta: {} })
})

// v1.122.0: GET /api/activities/account-drill?teamId=&accountId=&mode=direct|include_all[&startDate&endDate]
// Powers the Account drill-down modal's Direct vs Include All toggle.
//
// - direct: activities where crm_what_type='Account' AND crm_what_id=accountId
// - include_all: union of
//     1. direct (as above)
//     2. Opportunities under this Account:     crm_what_type='Opportunity' AND crm_account_id=accountId
//     3. Campaigns tied to Opps under this Account (SF SOQL to resolve
//        Opportunity.CampaignId → then match crm_what_type='Campaign' AND crm_what_id IN (...))
//     4. Leads with ConvertedAccountId=accountId (SF SOQL to resolve,
//        then match crm_what_type='Lead' AND crm_what_id IN (...))
//
// Response includes a `breakdown` meta field with count + hours per SF
// object type (Account / Opportunity / Campaign / Lead). Empty buckets
// are omitted so the client can hide them entirely.
activitiesRouter.get('/account-drill', async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const accountId = req.query['accountId'] as string | undefined
  const mode = (req.query['mode'] as string | undefined) === 'include_all' ? 'include_all' : 'direct'
  const startDate = req.query['startDate'] as string | undefined
  const endDate = req.query['endDate'] as string | undefined
  if (!teamId || !accountId) {
    res.status(400).json({ data: null, error: 'errors.validation.activity_params_required', meta: {} })
    return
  }
  // Only a team the caller can see (its own teams, or every team for App
  // Admins and can-see-all-teams users), same rule as the other team reads.
  if (!(await getAccessibleTeamIds(req.user!.id)).includes(teamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }

  const rangeConds = []
  if (startDate) {
    const s = new Date(startDate)
    if (!Number.isNaN(s.getTime())) rangeConds.push(gte(activities.startDatetime, s))
  }
  if (endDate) {
    const e = new Date(endDate)
    if (!Number.isNaN(e.getTime())) {
      e.setUTCHours(23, 59, 59, 999)
      rangeConds.push(lte(activities.startDatetime, e))
    }
  }

  // Resolve Campaign + Lead ids via SF when include_all is asked for. If
  // SF isn't connected the buckets stay empty — the toggle still works
  // for Direct + Opps.
  let campaignIds: string[] = []
  let leadIds: string[] = []
  const onHubspot = mode === 'include_all' && (await getCrmProviderId()) === 'hubspot'
  if (onHubspot) {
    // HubSpot: a Lead's Company comes from crm_lead_account_link, which the
    // nightly HubSpot snapshot refresh fills from each Lead's primary
    // Company. HubSpot has no Deal → Campaign link like Salesforce's
    // Opportunity.CampaignId, so the Campaign bucket stays empty there.
    if ((await getEffectiveCrmFeatures()).leadsEnabled) {
      const links = await db.select({ leadId: crmLeadAccountLink.leadId }).from(crmLeadAccountLink)
        .where(eq(crmLeadAccountLink.accountId, accountId)).limit(500)
      leadIds = links.map((l) => l.leadId)
    }
  } else if (mode === 'include_all') {
    const { getSfConnection } = await import('../services/salesforce/client.js')
    const { safeSoqlLiteral } = await import('../services/salesforce/soql.js')
    const conn = await getSfConnection(req.user!.id)
    if (conn) {
      const safeAcc = safeSoqlLiteral(accountId)
      // A switched-off Campaigns or Leads feature gets no bucket at all.
      const features = await getEffectiveCrmFeatures()
      if (features.campaignsEnabled) try {
        const q = await conn.query<{ Id: string; CampaignId: string | null }>(
          `SELECT Id, CampaignId FROM Opportunity WHERE AccountId = '${safeAcc}' AND CampaignId != null LIMIT 500`,
        )
        campaignIds = Array.from(new Set((q.records ?? []).map((r) => r.CampaignId).filter((v): v is string => !!v)))
      } catch { /* ignore */ }
      if (features.leadsEnabled) try {
        const q = await conn.query<{ Id: string }>(
          `SELECT Id FROM Lead WHERE ConvertedAccountId = '${safeAcc}' LIMIT 500`,
        )
        leadIds = (q.records ?? []).map((r) => r.Id).filter(Boolean)
      } catch { /* ignore */ }
    }
  }

  // Build the SQL OR clause dynamically per mode. Lead activities live
  // in crm_who_id/crm_who_type (Contact/Lead), everything else is
  // crm_what_id/crm_what_type (Opportunity/Account/Campaign).
  const clauses: Array<ReturnType<typeof and>> = [
    and(eq(activities.crmWhatType, 'Account'), eq(activities.crmWhatId, accountId)),
  ]
  if (mode === 'include_all') {
    clauses.push(and(eq(activities.crmWhatType, 'Opportunity'), eq(activities.crmAccountId, accountId)))
    if (campaignIds.length > 0) {
      clauses.push(and(eq(activities.crmWhatType, 'Campaign'), inArray(activities.crmWhatId, campaignIds)))
    }
    if (leadIds.length > 0) {
      clauses.push(and(eq(activities.crmWhoType, 'Lead'), inArray(activities.crmWhoId, leadIds)))
    }
  }
  const compoundOr = sql`(${sql.join(clauses.filter(Boolean).map((c) => sql`(${c})`), sql` OR `)})`

  const rows = await db
    .select({
      id: activities.id,
      title: activities.title,
      startDatetime: activities.startDatetime,
      endDatetime: activities.endDatetime,
      effortHours: activities.effortHours,
      notes: activities.notes,
      descriptionBody: activities.descriptionBody,
      locationMode: activities.locationMode,
      meetingOwner: activities.meetingOwner,
      meetingOwnerEmail: activities.meetingOwnerEmail,
      attendees: activities.attendees,
      acv: activities.acv,
      costTransportation: activities.costTransportation,
      costLodging: activities.costLodging,
      costFood: activities.costFood,
      incidentalCurrency: activities.incidentalCurrency,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
      oppAmount: activities.oppAmount,
      oppCloseDate: activities.oppCloseDate,
      crmWhatId: activities.crmWhatId,
      crmWhatType: activities.crmWhatType,
      crmWhatName: activities.crmWhatName,
      crmAccountId: activities.crmAccountId,
      crmAccountName: activities.crmAccountName,
      crmAssignedSeName: activities.crmAssignedSeName,
      crmWhoId: activities.crmWhoId,
      crmWhoType: activities.crmWhoType,
      crmWhoName: activities.crmWhoName,
      crmRecordId: activities.crmRecordId,
      crmSyncStatus: activities.crmSyncStatus,
      activityTypeName: teamActivityTypes.name,
      activityTypeColor: teamActivityTypes.color,
      activityTypeIcon: teamActivityTypes.icon,
      userId: activities.userId,
      userDisplayName: users.displayName,
      userEmail: users.email,
      createdAt: activities.createdAt,
    })
    .from(activities)
    .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .innerJoin(users, eq(activities.userId, users.id))
    .where(
      and(
        eq(activities.teamId, teamId),
        eq(activities.status, 'submitted'),
        eq(activities.isArchived, false),
        compoundOr,
        ...rangeConds,
      ),
    )
    .orderBy(desc(activities.startDatetime))

  // Breakdown by SF object type — omit empty buckets so the UI can hide them.
  const buckets: Record<'Account' | 'Opportunity' | 'Campaign' | 'Lead', { count: number; hours: number }> = {
    Account: { count: 0, hours: 0 },
    Opportunity: { count: 0, hours: 0 },
    Campaign: { count: 0, hours: 0 },
    Lead: { count: 0, hours: 0 },
  }
  for (const r of rows) {
    // Lead activities are keyed on crm_who_type — bucket them there
    // first, then fall back to crm_what_type for the rest.
    const key: keyof typeof buckets | null =
      r.crmWhoType === 'Lead' ? 'Lead'
      : (r.crmWhatType as keyof typeof buckets | null) ?? null
    if (key && buckets[key]) {
      buckets[key].count += 1
      buckets[key].hours += Number(r.effortHours)
    }
  }
  const totalHours = rows.reduce((sum, r) => sum + Number(r.effortHours), 0)
  const breakdown = (Object.entries(buckets) as Array<[keyof typeof buckets, { count: number; hours: number }]>)
    .filter(([, v]) => v.count > 0)
    .map(([type, v]) => ({ type, count: v.count, hours: Math.round(v.hours * 100) / 100 }))

  res.json({
    data: rows,
    error: null,
    meta: {
      count: rows.length,
      totalHours: Math.round(totalHours * 100) / 100,
      breakdown,
      mode,
      campaignIds,
      leadIds,
    },
  })
})

// GET /api/activities/month-heatmap?userId=&year=&month=
// month is 1..12. Returns per-day submitted activity count for the calendar
// month, capped by isArchived=false. userId defaults to the caller; admins /
// team_admins may query other users on shared teams.
activitiesRouter.get('/month-heatmap', async (req, res) => {
  const callerId = req.user!.id
  const requestedUserId = (req.query['userId'] as string | undefined) || null
  const teamId = (req.query['teamId'] as string | undefined) || null
  const yearParam = Number(req.query['year'])
  const monthParam = Number(req.query['month'])
  if (!Number.isInteger(yearParam) || !Number.isInteger(monthParam) || monthParam < 1 || monthParam > 12) {
    res.status(400).json({ data: null, error: 'errors.validation.date_range_required', meta: {} })
    return
  }
  const target = await resolveTargetUserId(callerId, requestedUserId)
  if (!target) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  // Widen the window by ±8 days so the leading/trailing days from adjacent
  // months that fill out the 6-week calendar grid also get counts, and so
  // activities near local-midnight in the client's timezone still land in
  // range when the server runs in UTC.
  const rangeStart = new Date(Date.UTC(yearParam, monthParam - 1, 1) - 8 * 24 * 60 * 60 * 1000)
  const rangeEnd = new Date(Date.UTC(yearParam, monthParam, 1) + 8 * 24 * 60 * 60 * 1000)
  const rows = await db.select({ startDatetime: activities.startDatetime })
    .from(activities)
    .where(and(
      eq(activities.userId, target),
      eq(activities.isArchived, false),
      eq(activities.status, 'submitted'),
      gte(activities.startDatetime, rangeStart),
      lte(activities.startDatetime, rangeEnd),
      ...(teamId ? [eq(activities.teamId, teamId)] : []),
    ))
  const starts = rows.map((r) => new Date(r.startDatetime).toISOString())
  // v1.363.0: separately flag days carrying an activity still awaiting a
  // Keep/Delete decision after its Outlook meeting was deleted (§10) — the
  // MonthHeatmap renders a red dot on these cells so the pending queue is
  // visible without opening the week itself.
  const deletedRows = await db.select({ startDatetime: activities.startDatetime })
    .from(activities)
    .where(and(
      eq(activities.userId, target),
      eq(activities.isArchived, false),
      eq(activities.status, 'submitted'),
      eq(activities.outlookDeletedKept, false),
      sql`${activities.outlookDeletedAt} IS NOT NULL`,
      gte(activities.startDatetime, rangeStart),
      lte(activities.startDatetime, rangeEnd),
      ...(teamId ? [eq(activities.teamId, teamId)] : []),
    ))
  const outlookDeletedStarts = deletedRows.map((r) => new Date(r.startDatetime).toISOString())
  res.json({ data: { starts, outlookDeletedStarts }, error: null, meta: {} })
})

// GET /api/activities/search?q= — v1.420.0, the header's global search.
// The caller's own activities only (any status, not archived), matched on
// title and the linked CRM record names. Small and fixed-size: it feeds a
// command palette, not a report.
export const ACTIVITY_SEARCH_LIMIT = 8
export const ACTIVITY_SEARCH_MIN_LENGTH = 2

// Escape LIKE wildcards so a typed % or _ matches itself.
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

activitiesRouter.get('/search', async (req, res) => {
  const raw = typeof req.query['q'] === 'string' ? req.query['q'].trim() : ''
  if (raw.length < ACTIVITY_SEARCH_MIN_LENGTH) {
    res.json({ data: [], error: null, meta: {} })
    return
  }
  const term = likeContains(raw.slice(0, 100))
  const rows = await db.select({
    id: activities.id,
    title: activities.title,
    startDatetime: activities.startDatetime,
    status: activities.status,
    crmWhatName: activities.crmWhatName,
    crmWhatType: activities.crmWhatType,
    crmWhoName: activities.crmWhoName,
  })
    .from(activities)
    .where(and(
      eq(activities.userId, req.user!.id),
      eq(activities.isArchived, false),
      or(
        ilike(activities.title, term),
        ilike(activities.crmWhatName, term),
        ilike(activities.crmWhoName, term),
      ),
    ))
    .orderBy(desc(activities.startDatetime))
    .limit(ACTIVITY_SEARCH_LIMIT)
  res.json({
    data: rows.map((r) => ({ ...r, startDatetime: new Date(r.startDatetime).toISOString() })),
    error: null,
    meta: {},
  })
})

// GET /api/activities?teamId=&weekStart=&userId=
activitiesRouter.get('/', async (req, res) => {
  const teamId = req.query['teamId'] as string | undefined
  const weekStartParam = req.query['weekStart'] as string | undefined
  const requestedUserId = (req.query['userId'] as string | undefined) || null

  if (!teamId) {
    res.status(400).json({ data: null, error: 'errors.validation.team_id_required', meta: {} })
    return
  }

  const callerId = req.user!.id
  // When a userId is explicitly requested (person switcher), enforce the same
  // admin/team_admin gate used by the calendar route and filter to that user.
  // v1.321.0: default to the caller's own activities (not "all team,
  // unfiltered by status") when no userId is given, matching the sibling
  // /calendar and /suggestions routes. The previous "all team" default had
  // no legitimate caller (WeeklyView always passes its own or a
  // person-switched userId) and briefly went out unfiltered while
  // useCurrentUser() was still loading — a slower request scoped this way
  // could resolve after a faster, correctly-scoped one and overwrite it in
  // the UI, surfacing another team member's activity (including their
  // unsubmitted drafts, since this branch never filtered by status either)
  // as if it were the viewer's own. See useActivities.ts for the matching
  // client-side fix.
  let userFilter: string = callerId
  if (requestedUserId) {
    const target = await resolveTargetUserId(callerId, requestedUserId)
    if (!target) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
    userFilter = target
  }

  const weekStart = weekStartParam ? new Date(weekStartParam) : startOfWeek(new Date(), { weekStartsOn: 1 })
  // v1.456.2: the 7 days from the week start the client sent, not endOfWeek():
  // the Activities page sends a Sunday when its weeks start on Sunday, and
  // endOfWeek(Monday-anchored) of a Sunday is that same Sunday. endOfWeek also
  // ran in the server's timezone, so for a client west of UTC it ended the week
  // on Sunday afternoon local time.
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1)

  try {
  const rows = await db
    .select({
      id: activities.id,
      title: activities.title,
      status: activities.status,
      startDatetime: activities.startDatetime,
      endDatetime: activities.endDatetime,
      effortHours: activities.effortHours,
      notes: activities.notes,
      descriptionBody: activities.descriptionBody,
      locationMode: activities.locationMode,
      meetingOwner: activities.meetingOwner,
      meetingOwnerEmail: activities.meetingOwnerEmail,
      attendees: activities.attendees,
      acv: activities.acv,
      costTransportation: activities.costTransportation,
      costLodging: activities.costLodging,
      costFood: activities.costFood,
      incidentalCurrency: activities.incidentalCurrency,
      salesStage: activities.salesStage,
      forecastCategory: activities.forecastCategory,
      oppAmount: activities.oppAmount,
      oppCloseDate: activities.oppCloseDate,
      crmWhatId: activities.crmWhatId,
      crmWhatType: activities.crmWhatType,
      crmWhatName: activities.crmWhatName,
      crmAccountId: activities.crmAccountId,
      crmAccountName: activities.crmAccountName,
      crmAssignedSeName: activities.crmAssignedSeName,
      crmWhoId: activities.crmWhoId,
      crmWhoType: activities.crmWhoType,
      crmWhoName: activities.crmWhoName,
      crmRelatedType: activities.crmRelatedType,
      crmRelatedId: activities.crmRelatedId,
      crmRelatedName: activities.crmRelatedName,
      // v1.344.0: batch-computed disconnect flags — drives the "SF link
      // broken" badge on ActivityCard.tsx. Plain columns already on this
      // row, unlike notesCount/ticketCount below (which need their own
      // batch GROUP BY join against a separate table).
      crmWhatDeleted: activities.crmWhatDeleted,
      crmWhoDeleted: activities.crmWhoDeleted,
      crmRelatedDeleted: activities.crmRelatedDeleted,
      crmEvalStatus: activities.crmEvalStatus,
      crmEvalStage: activities.crmEvalStage,
      crmEvalType: activities.crmEvalType,
      crmEvalStartDate: activities.crmEvalStartDate,
      crmEvalEndDate: activities.crmEvalEndDate,
      crmEvalPrimaryEngineer: activities.crmEvalPrimaryEngineer,
      crmRecordId: activities.crmRecordId,
      crmSyncStatus: activities.crmSyncStatus,
      crmSyncError: activities.crmSyncError,
      crmSyncedAt: activities.crmSyncedAt,
      outlookSyncStatus: activities.outlookSyncStatus,
      outlookSyncError: activities.outlookSyncError,
      outlookSyncedAt: activities.outlookSyncedAt,
      activityTypeId: activities.activityTypeId,
      activityTypeName: teamActivityTypes.name,
      activityTypeSfObject: teamActivityTypes.crmObjectType,
      activityTypeColor: teamActivityTypes.color,
      activityTypeIcon: teamActivityTypes.icon,
      // v1.256.0: so the Edit drawer's Subtype picker (a second dropdown
      // next to Activity Type) can hydrate from the weekly-list row it
      // already has, with no extra round-trip.
      subtypeId: activities.subtypeId,
      subtypeName: activities.subtypeName,
      // v1.257.0: only ever populated/shown by the client when the chosen
      // activity type is named "Meeting" — see schema.ts for the rationale.
      meetingTypeReason: activities.meetingTypeReason,
      // v1.334.0: same convention, for activity type "Marketing".
      marketingEventName: activities.marketingEventName,
      // v1.262.0: drives the Private Meeting card treatment (masked title,
      // lock icon, pill) — see schema.ts for the rationale.
      isPrivateMeeting: activities.isPrivateMeeting,
      // v1.90.0: expose outlookEventId so the client's Edit form can
      // fall back to the live Outlook event when meetingOwner /
      // attendees / descriptionBody are blank on legacy rows.
      outlookEventId: activities.outlookEventId,
      userId: activities.userId,
      createdAt: activities.createdAt,
      updatedAt: activities.updatedAt,
      // v1.241.0: drives the "Approved on <date>" tooltip on the green check.
      submittedAt: activities.submittedAt,
      // v1.242.0: the user chose Keep for an activity whose Outlook meeting is
      // gone. Drives the gray right border on the calendar block — it lives in
      // ImpactIQ + Salesforce only.
      outlookDeletedKept: activities.outlookDeletedKept,
      // v1.363.0: still-pending (not yet Keep/Delete'd) deleted-Outlook flag —
      // drives the red day-number treatment on CalendarPanel's week header.
      outlookDeletedAt: activities.outlookDeletedAt,
    })
    .from(activities)
    // v1.165.0: leftJoin (was innerJoin) so an activity never silently
    // disappears from the list when its activity-type row has been deleted —
    // the type fields just come back null and are coalesced below.
    .leftJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(
      and(
        eq(activities.teamId, teamId),
        eq(activities.isArchived, false),
        gte(activities.startDatetime, weekStart),
        lte(activities.startDatetime, weekEnd),
        eq(activities.userId, userFilter),
      ),
    )
    .orderBy(desc(activities.startDatetime))

  // Batch-load product links so each row exposes { products: [{id, name, abbreviation}] }.
  const activityIds = rows.map((r) => r.id)
  const productRows = activityIds.length
    ? await db
        .select({
          activityId: activityProducts.activityId,
          id: products.id,
          name: products.name,
          abbreviation: products.abbreviation,
          iconDataUrl: products.iconDataUrl,
        })
        .from(activityProducts)
        .innerJoin(products, eq(activityProducts.productId, products.id))
        .where(inArray(activityProducts.activityId, activityIds))
    : []
  const productsByActivity = new Map<string, { id: string; name: string; abbreviation: string | null; iconDataUrl: string | null }[]>()
  for (const p of productRows) {
    const list = productsByActivity.get(p.activityId) ?? []
    list.push({ id: p.id, name: p.name, abbreviation: p.abbreviation, iconDataUrl: p.iconDataUrl })
    productsByActivity.set(p.activityId, list)
  }

  // Notes count per activity so the card icon renders gray/blue without a
  // per-card round-trip. Single GROUP BY over the activity_notes table.
  const noteCounts = activityIds.length
    ? await db.select({ activityId: activityNotes.activityId, cnt: sql<number>`count(*)::int` })
        .from(activityNotes)
        .where(inArray(activityNotes.activityId, activityIds))
        .groupBy(activityNotes.activityId)
    : []
  const notesCountByActivity = new Map<string, number>(noteCounts.map((n) => [n.activityId, Number(n.cnt) || 0]))

  // v1.342.0: attached Support Ticket count per activity (§7 Support Ticket
  // attachment), same batch-count-then-map shape as notesCount above — drives
  // the approved-card right rail in ActivityCard.tsx.
  const ticketCounts = activityIds.length
    ? await db.select({ activityId: activityCrmTickets.activityId, cnt: sql<number>`count(*)::int` })
        .from(activityCrmTickets)
        .where(inArray(activityCrmTickets.activityId, activityIds))
        .groupBy(activityCrmTickets.activityId)
    : []
  const ticketCountByActivity = new Map<string, number>(ticketCounts.map((n) => [n.activityId, Number(n.cnt) || 0]))

  // v1.460.0: linked Gong call count per activity, same batch-count shape as
  // notesCount — drives the gray/colored Transcripts icon on the card. Only a
  // count; who may read a transcript is still checked by the Gong routes.
  const gongCounts = activityIds.length
    ? await db.select({ activityId: activityGongCalls.activityId, cnt: sql<number>`count(*)::int` })
        .from(activityGongCalls)
        .where(inArray(activityGongCalls.activityId, activityIds))
        .groupBy(activityGongCalls.activityId)
    : []
  const gongCallCountByActivity = new Map<string, number>(gongCounts.map((n) => [n.activityId, Number(n.cnt) || 0]))

  const decorated = rows.map((r) => ({
    ...r,
    // Coalesce type fields for orphaned rows (leftJoin can yield nulls) so the
    // client renders a placeholder instead of breaking.
    activityTypeName: r.activityTypeName ?? '(Unknown type)',
    activityTypeSfObject: r.activityTypeSfObject ?? 'Event',
    products: productsByActivity.get(r.id) ?? [],
    notesCount: notesCountByActivity.get(r.id) ?? 0,
    ticketCount: ticketCountByActivity.get(r.id) ?? 0,
    gongCallCount: gongCallCountByActivity.get(r.id) ?? 0,
  }))

  res.json({ data: decorated, error: null, meta: { weekStart: weekStart.toISOString(), weekEnd: weekEnd.toISOString() } })
  } catch (err) {
    // Bubble the DB error up so the client stops showing a generic "Network
    // error" and users/admins can see what's actually broken (usually a
    // missing column when a migration hasn't run yet). Drizzle wraps the
    // failure with the SQL and hides Postgres's own message on .cause — pull
    // that out so admins actually see e.g. `column "attendees" does not exist`.
    const dbErr = err as { message?: string; cause?: { message?: string; code?: string; detail?: string; hint?: string } }
    const cause = dbErr.cause
    const parts = [cause?.message, cause?.detail, cause?.hint].filter(Boolean).join(' | ')
    const summary = parts || dbErr.message || String(err)
    console.error('[/api/activities] query failed:', summary, dbErr.cause ?? '')
    res.status(500).json({ data: null, error: `activities query failed: ${summary}`, meta: {} })
  }
})

// ─── Outlook-deleted approved activities (v1.242.0) ──────────────────────
//
// Review queue for APPROVED activities whose Outlook event has been deleted
// from the calendar. Detection lives in syncUserCalendar (see
// flagDeletedOutlookActivities); these routes are the Keep / Delete side.
//
// Registered ABOVE the `/:id` routes below — otherwise Express would match
// "outlook-deleted" as an :id and every one of these would 404.

/** Shared select for the review cards — same shape the weekly list returns. */
function outlookDeletedSelect() {
  return {
    id: activities.id,
    title: activities.title,
    status: activities.status,
    startDatetime: activities.startDatetime,
    endDatetime: activities.endDatetime,
    effortHours: activities.effortHours,
    notes: activities.notes,
    activityTypeId: activities.activityTypeId,
    activityTypeName: teamActivityTypes.name,
    activityTypeColor: teamActivityTypes.color,
    activityTypeIcon: teamActivityTypes.icon,
    activityTypeSfObject: teamActivityTypes.crmObjectType,
    crmWhatId: activities.crmWhatId,
    crmWhatType: activities.crmWhatType,
    crmWhatName: activities.crmWhatName,
    crmRecordId: activities.crmRecordId,
    crmSyncStatus: activities.crmSyncStatus,
    crmSyncedAt: activities.crmSyncedAt,
    outlookEventId: activities.outlookEventId,
    outlookDeletedAt: activities.outlookDeletedAt,
    isPrivateMeeting: activities.isPrivateMeeting,
    teamId: activities.teamId,
    userId: activities.userId,
    createdAt: activities.createdAt,
    submittedAt: activities.submittedAt,
  }
}

// GET /api/activities/outlook-deleted?weekStart=ISO
// `data` is scoped to the week when weekStart is given (for the in-week
// section); `meta.totalCount` is ALWAYS every week, because the bell and the
// header banner report a global count and shouldn't need a second request.
activitiesRouter.get('/outlook-deleted', async (req, res) => {
  const userId = req.user!.id
  const weekStartRaw = req.query['weekStart'] as string | undefined

  const baseWhere = and(
    eq(activities.userId, userId),
    eq(activities.status, 'submitted'),
    eq(activities.isArchived, false),
    eq(activities.outlookDeletedKept, false),
    sql`${activities.outlookDeletedAt} IS NOT NULL`,
  )

  const [{ c: totalCount } = { c: 0 }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(activities)
    .where(baseWhere)

  let rows
  if (weekStartRaw) {
    const ws = new Date(weekStartRaw)
    const we = new Date(ws)
    we.setDate(we.getDate() + 7)
    rows = await db
      .select(outlookDeletedSelect())
      .from(activities)
      .leftJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
      .where(and(baseWhere, gte(activities.startDatetime, ws), lte(activities.startDatetime, we)))
      .orderBy(activities.startDatetime)
  } else {
    rows = await db
      .select(outlookDeletedSelect())
      .from(activities)
      .leftJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
      .where(baseWhere)
      .orderBy(activities.startDatetime)
  }

  res.json({ data: rows, error: null, meta: { totalCount } })
})

/** Loads a flagged activity the caller actually owns, or null. */
async function loadFlagged(id: string, userId: string) {
  const [row] = await db
    .select({
      id: activities.id,
      title: activities.title,
      userId: activities.userId,
      teamId: activities.teamId,
      crmRecordId: activities.crmRecordId,
      startDatetime: activities.startDatetime,
      outlookEventId: activities.outlookEventId,
      outlookWritebackEventId: activities.outlookWritebackEventId,
      outlookDeletedAt: activities.outlookDeletedAt,
      crmObjectType: teamActivityTypes.crmObjectType,
    })
    .from(activities)
    .leftJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(and(
      eq(activities.id, id),
      eq(activities.userId, userId),
      eq(activities.status, 'submitted'),
      sql`${activities.outlookDeletedAt} IS NOT NULL`,
    ))
    .limit(1)
  return row ?? null
}

// POST /api/activities/outlook-deleted/keep  { ids?: string[], weekStart?: ISO }
// Keeps in ImpactIQ + Salesforce. Clears the flag and sets the permanent
// suppression so the next sync doesn't resurface the same decision.
activitiesRouter.post('/outlook-deleted/keep', async (req, res) => {
  const userId = req.user!.id
  const parsed = z.object({
    ids: z.array(z.string().uuid()).optional(),
    weekStart: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { ids, weekStart } = parsed.data
  if (!ids?.length && !weekStart) {
    // Refuse an unscoped bulk keep — "keep everything, everywhere" is not a
    // decision any button on this page offers, so treat it as a mistake.
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }

  const conds = [
    eq(activities.userId, userId),
    eq(activities.status, 'submitted'),
    sql`${activities.outlookDeletedAt} IS NOT NULL`,
  ]
  if (ids?.length) conds.push(inArray(activities.id, ids))
  if (weekStart) {
    const ws = new Date(weekStart)
    const we = new Date(ws)
    we.setDate(we.getDate() + 7)
    conds.push(gte(activities.startDatetime, ws), lte(activities.startDatetime, we))
  }

  const updated = await db
    .update(activities)
    .set({ outlookDeletedAt: null, outlookDeletedKept: true, updatedAt: new Date() })
    .where(and(...conds))
    .returning({ id: activities.id, title: activities.title })

  await logAudit(req, {
    action: 'activity.outlook_deleted.keep',
    targetType: 'activity',
    targetId: updated.length === 1 ? updated[0]!.id : null,
    meta: { count: updated.length, ids: updated.map((u) => u.id) },
  })
  res.json({ data: { kept: updated.length }, error: null, meta: {} })
})

// DELETE /api/activities/outlook-deleted  { ids?: string[], weekStart?: ISO }
// HARD delete — the row is removed from Postgres and the linked Salesforce
// Event/Task is deleted too. This is the only hard delete in the product; the
// audit row is the sole surviving record, which is why it carries the
// identifying fields rather than just an id.
activitiesRouter.delete('/outlook-deleted', async (req, res) => {
  const userId = req.user!.id
  const parsed = z.object({
    ids: z.array(z.string().uuid()).optional(),
    weekStart: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { ids, weekStart } = parsed.data
  if (!ids?.length && !weekStart) {
    res.status(400).json({ data: null, error: 'errors.validation.field_required', meta: {} })
    return
  }

  const conds = [
    eq(activities.userId, userId),
    eq(activities.status, 'submitted'),
    sql`${activities.outlookDeletedAt} IS NOT NULL`,
  ]
  if (ids?.length) conds.push(inArray(activities.id, ids))
  if (weekStart) {
    const ws = new Date(weekStart)
    const we = new Date(ws)
    we.setDate(we.getDate() + 7)
    conds.push(gte(activities.startDatetime, ws), lte(activities.startDatetime, we))
  }

  const targets = await db
    .select({
      id: activities.id,
      title: activities.title,
      teamId: activities.teamId,
      startDatetime: activities.startDatetime,
      effortHours: activities.effortHours,
      crmRecordId: activities.crmRecordId,
      crmRecordAdopted: activities.crmRecordAdopted,
      crmWhatId: activities.crmWhatId,
      crmWhatName: activities.crmWhatName,
      outlookEventId: activities.outlookEventId,
      activityTypeName: teamActivityTypes.name,
      crmObjectType: teamActivityTypes.crmObjectType,
    })
    .from(activities)
    .leftJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(and(...conds))

  if (targets.length === 0) {
    res.json({ data: { deleted: 0, sfDeleted: 0, sfFailed: [] }, error: null, meta: {} })
    return
  }

  // Delete the Salesforce record first, per target. A failure here does NOT
  // block the local delete: the user asked for this row to be gone, and
  // leaving it behind because Salesforce was unreachable would strand it in a
  // queue whose whole point is emptying. The failures are reported back and
  // recorded in the audit meta so an orphaned SF record is traceable.
  const { getSfConnection } = await import('../services/salesforce/client.js')
  const onHubspot = (await getCrmProviderId()) === 'hubspot'
  const conn = onHubspot ? null : await getSfConnection(userId).catch(() => null)
  const sfFailed: Array<{ id: string; crmRecordId: string; reason: string }> = []
  let sfDeleted = 0
  for (const tgt of targets) {
    if (!tgt.crmRecordId) continue
    // HubSpot: one portal-wide connection, so no per-user "not connected".
    if (onHubspot) {
      // A meeting ImpactIQ adopted from HubSpot's calendar sync was never
      // ImpactIQ's to delete; it stays in HubSpot.
      if (tgt.crmRecordAdopted) continue
      const { deleteHubspotEngagement } = await import('../services/hubspot/writeback.js')
      const reason = await deleteHubspotEngagement(tgt.crmRecordId, tgt.crmObjectType)
      if (reason) sfFailed.push({ id: tgt.id, crmRecordId: tgt.crmRecordId, reason: reason.slice(0, 200) })
      else sfDeleted += 1
      continue
    }
    if (!conn) {
      sfFailed.push({ id: tgt.id, crmRecordId: tgt.crmRecordId, reason: 'not_connected' })
      continue
    }
    try {
      await conn.sobject(tgt.crmObjectType ?? 'Event').destroy(tgt.crmRecordId)
      sfDeleted += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Already gone in Salesforce is a success for our purposes — the goal
      // state (no SF record) already holds.
      if (/ENTITY_IS_DELETED|INVALID_CROSS_REFERENCE_KEY|NOT_FOUND|entity is deleted/i.test(message)) {
        sfDeleted += 1
      } else {
        sfFailed.push({ id: tgt.id, crmRecordId: tgt.crmRecordId, reason: message.slice(0, 200) })
      }
    }
  }

  const targetIds = targets.map((t) => t.id)
  // Children first — activity_products / activity_notes / sync audit hang off
  // this row and would otherwise block the delete on their FKs.
  const { activityProducts: ap, activityNotes: an } = await import('../../../drizzle/schema.js')
  await db.delete(ap).where(inArray(ap.activityId, targetIds))
  await db.delete(an).where(inArray(an.activityId, targetIds))
  await db.delete(activityCrmTickets).where(inArray(activityCrmTickets.activityId, targetIds))
  await db.delete(activitySyncAudit).where(inArray(activitySyncAudit.activityId, targetIds))
  await db.delete(activities).where(inArray(activities.id, targetIds))

  await logAudit(req, {
    action: 'activity.outlook_deleted.purge',
    targetType: 'activity',
    targetId: targets.length === 1 ? targets[0]!.id : null,
    meta: {
      count: targets.length,
      sfDeleted,
      sfFailed,
      // The row is gone from Postgres — this is the only remaining record of
      // what was destroyed, so keep enough to reconstruct what happened.
      purged: targets.map((t) => ({
        id: t.id,
        title: t.title,
        teamId: t.teamId,
        activityType: t.activityTypeName,
        startDatetime: t.startDatetime?.toISOString() ?? null,
        effortHours: t.effortHours,
        crmRecordId: t.crmRecordId,
        crmWhatId: t.crmWhatId,
        crmWhatName: t.crmWhatName,
        outlookEventId: t.outlookEventId,
      })),
    },
  })

  res.json({ data: { deleted: targets.length, sfDeleted, sfFailed }, error: null, meta: {} })
})

// GET /api/activities/:id
activitiesRouter.get('/:id', async (req, res) => {
  const id = req.params['id']!
  const [row] = await db
    .select()
    .from(activities)
    // leftJoin so an activity with a deleted type row is still editable.
    .leftJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
    .where(and(eq(activities.id, id), eq(activities.isArchived, false)))
    .limit(1)

  // The owner, an admin over the owner, or (once submitted) anyone who can
  // see the team. Answers 404 either way so ids can't be probed (audit H2,
  // v1.422.0).
  if (!row || !(await canViewActivity(req.user!.id, row.activities))) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
    return
  }

  const { activityProducts } = await import('../../../drizzle/schema.js')
  const productLinks = await db.select({ productId: activityProducts.productId }).from(activityProducts).where(eq(activityProducts.activityId, id))
  const tickets = await db.select().from(activityCrmTickets).where(eq(activityCrmTickets.activityId, id))
  res.json({ data: { ...row, productIds: productLinks.map((r) => r.productId), tickets }, error: null, meta: {} })
})

// GET /api/activities/:id/sync-audit — per-activity Salesforce sync history
// (last 5 days, newest first). Auth: the activity's owner or any admin.
activitiesRouter.get('/:id/sync-audit', async (req, res) => {
  const id = req.params['id']!
  const [row] = await db.select({ userId: activities.userId }).from(activities).where(eq(activities.id, id)).limit(1)
  if (!row) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
    return
  }
  const callerId = req.user!.id
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  if (row.userId !== callerId && !caller?.isAppAdmin) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const rows = await db
    .select()
    .from(activitySyncAudit)
    .where(eq(activitySyncAudit.activityId, id))
    .orderBy(desc(activitySyncAudit.attemptedAt))
    .limit(200)
  res.json({ data: rows, error: null, meta: {} })
})

// POST /api/activities
activitiesRouter.post('/', async (req, res) => {
  const parsed = CreateActivitySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.message, meta: {} })
    return
  }

  const user = req.user!
  const data = parsed.data

  // v1.105.0: dedup by outlookEventId. Editing a Suggested Outlook card
  // and Saving used to POST a fresh row even when Approve had already
  // created one — leaving two "POC Work on Call" activities for the
  // same meeting. If we already have a non-archived row for this
  // outlookEventId under this user, PATCH it in place instead of
  // inserting a duplicate, and return the updated row with 200.
  if (data.outlookEventId) {
    // v1.167.0: match ANY prior row for this (user, outlookEventId), preferring
    // a non-archived one (isArchived asc → false first), else the most recent
    // archived one — which we REACTIVATE. Previously this only matched
    // non-archived rows, so deleting then re-approving a meeting left the old
    // row archived and inserted a fresh duplicate each time.
    const [existing] = await db.select().from(activities)
      .where(and(
        eq(activities.userId, user.id),
        eq(activities.outlookEventId, data.outlookEventId),
      ))
      .orderBy(activities.isArchived, desc(activities.updatedAt))
      .limit(1)
    if (existing) {
      // Only a type from one of the caller's own teams (audit M1, v1.422.0).
      if (data.activityTypeId !== existing.activityTypeId
        && !(await activityTypeVisibleToTeams(data.activityTypeId, await getAccessibleTeamIds(user.id)))) {
        res.status(400).json({ data: null, error: 'errors.activities.type_not_on_team', meta: {} })
        return
      }
      const blocked = await crmLinkBlockError(data, existing)
      if (blocked) {
        res.status(403).json({ data: null, error: blocked, meta: {} })
        return
      }
      const project = await checkProjectLink(data, existing, existing.teamId)
      if (!project.ok) {
        res.status(project.status).json({ data: null, error: project.error, meta: {} })
        return
      }
      const [updated] = await db.update(activities).set({
        isArchived: false,
        title: data.title,
        activityTypeId: data.activityTypeId,
        subtypeId: data.subtypeId !== undefined ? data.subtypeId : existing.subtypeId,
        subtypeName: data.subtypeId !== undefined ? await resolveSubtypeName(data.subtypeId) : existing.subtypeName,
        meetingTypeReason: data.meetingTypeReason ?? existing.meetingTypeReason,
        marketingEventName: data.marketingEventName ?? existing.marketingEventName,
        isPrivateMeeting: data.isPrivateMeeting ?? existing.isPrivateMeeting,
        startDatetime: new Date(data.startDatetime),
        endDatetime: new Date(data.endDatetime),
        effortHours: String(data.effortHours),
        notes: data.notes ?? existing.notes,
        descriptionBody: data.descriptionBody ?? existing.descriptionBody,
        locationMode: data.locationMode ?? existing.locationMode,
        meetingOwner: data.meetingOwner ?? existing.meetingOwner,
        meetingOwnerEmail: data.meetingOwnerEmail ?? existing.meetingOwnerEmail,
        attendees: data.attendees ?? existing.attendees,
        acv: data.acv != null ? String(data.acv) : existing.acv,
        costTransportation: data.costTransportation != null ? String(data.costTransportation) : existing.costTransportation,
        costLodging: data.costLodging != null ? String(data.costLodging) : existing.costLodging,
        costFood: data.costFood != null ? String(data.costFood) : existing.costFood,
        incidentalCurrency: data.incidentalCurrency ?? existing.incidentalCurrency,
        salesStage: data.salesStage ?? existing.salesStage,
        forecastCategory: data.forecastCategory ?? existing.forecastCategory,
        oppAmount: data.oppAmount != null ? String(data.oppAmount) : existing.oppAmount,
        oppCloseDate: data.oppCloseDate ?? existing.oppCloseDate,
        crmWhatId: data.crmWhatId ?? existing.crmWhatId,
        crmWhatType: data.crmWhatType ?? existing.crmWhatType,
        crmWhatName: data.crmWhatName ?? existing.crmWhatName,
        crmAccountId: data.crmAccountId ?? existing.crmAccountId,
        crmAccountName: data.crmAccountName ?? existing.crmAccountName,
        crmAssignedSeName: data.crmAssignedSeName ?? existing.crmAssignedSeName,
        crmWhoId: data.crmWhoId ?? existing.crmWhoId,
        crmWhoType: data.crmWhoType ?? existing.crmWhoType,
        crmWhoName: data.crmWhoName ?? existing.crmWhoName,
        crmRelatedType: data.crmRelatedType ?? existing.crmRelatedType,
        crmRelatedId: data.crmRelatedId ?? existing.crmRelatedId,
        crmRelatedName: data.crmRelatedName ?? existing.crmRelatedName,
        ...(project.snapshot ?? {}),
        updatedAt: new Date(),
      }).where(eq(activities.id, existing.id)).returning()
      res.status(200).json({ data: updated, error: null, meta: { deduped: true } })
      return
    }
  }

  // A new row may only go on a team the caller can see (its own teams, or
  // every team for App Admins and can-see-all-teams users). The dedup path
  // above keeps the existing row's team, so it needs no check.
  if (!(await getAccessibleTeamIds(user.id)).includes(data.teamId)) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  // The type must belong to that team too (audit M1, v1.422.0).
  if (!(await activityTypeVisibleToTeams(data.activityTypeId, [data.teamId]))) {
    res.status(400).json({ data: null, error: 'errors.activities.type_not_on_team', meta: {} })
    return
  }

  const blockedLink = await crmLinkBlockError(data)
  if (blockedLink) {
    res.status(403).json({ data: null, error: blockedLink, meta: {} })
    return
  }
  // Projects off or the wrong source refuse the link; with CriteriaIQ as the
  // primary source the project's snapshot is read here (primaryProjects.ts).
  const project = await checkProjectLink(data, null, data.teamId)
  if (!project.ok) {
    res.status(project.status).json({ data: null, error: project.error, meta: {} })
    return
  }

  const [inserted] = await db
    .insert(activities)
    .values({
      userId: user.id,
      teamId: data.teamId,
      title: data.title,
      activityTypeId: data.activityTypeId,
      subtypeId: data.subtypeId ?? null,
      subtypeName: await resolveSubtypeName(data.subtypeId),
      meetingTypeReason: data.meetingTypeReason,
      marketingEventName: data.marketingEventName,
      isPrivateMeeting: data.isPrivateMeeting ?? false,
      startDatetime: new Date(data.startDatetime),
      endDatetime: new Date(data.endDatetime),
      effortHours: String(data.effortHours),
      notes: data.notes,
      descriptionBody: data.descriptionBody,
      locationMode: data.locationMode ?? 'remote',
      meetingOwner: data.meetingOwner,
      meetingOwnerEmail: data.meetingOwnerEmail,
      attendees: data.attendees,
      acv: data.acv != null ? String(data.acv) : null,
      costTransportation: data.costTransportation != null ? String(data.costTransportation) : null,
      costLodging: data.costLodging != null ? String(data.costLodging) : null,
      costFood: data.costFood != null ? String(data.costFood) : null,
      incidentalCurrency: data.incidentalCurrency ?? null,
      salesStage: data.salesStage ?? null,
      forecastCategory: data.forecastCategory ?? null,
      oppAmount: data.oppAmount != null ? String(data.oppAmount) : null,
      oppCloseDate: data.oppCloseDate ?? null,
      outlookEventId: data.outlookEventId,
      crmWhatId: data.crmWhatId,
      crmWhatType: data.crmWhatType,
      crmWhatName: data.crmWhatName,
      crmAccountId: data.crmAccountId ?? null,
      crmAccountName: data.crmAccountName ?? null,
      crmAssignedSeName: data.crmAssignedSeName ?? null,
      crmWhoId: data.crmWhoId,
      crmWhoType: data.crmWhoType,
      crmWhoName: data.crmWhoName,
      // v1.72.0: SF child link (Evaluation__c and future related
      // pickers). Nulls when the SE cleared the picker or the parent
      // Opp was unlinked. Client already gates on Opp presence.
      crmRelatedType: data.crmRelatedType ?? null,
      crmRelatedId: data.crmRelatedId ?? null,
      crmRelatedName: data.crmRelatedName ?? null,
      ...(project.snapshot ?? {}),
      crmSyncStatus: (data.crmWhatId || data.crmWhoId) ? 'pending' : undefined,
    })
    .returning()

  if (inserted && data.productIds && data.productIds.length > 0) {
    const { activityProducts } = await import('../../../drizzle/schema.js')
    await db.insert(activityProducts).values(data.productIds.map((pid) => ({ activityId: inserted.id, productId: pid })))
  }

  if (inserted && data.tickets && data.tickets.length > 0) {
    await db.insert(activityCrmTickets).values(data.tickets.map((tk) => ({
      activityId: inserted.id,
      crmTicketId: tk.crmTicketId,
      crmTicketNumber: tk.crmTicketNumber,
      crmSubject: tk.crmSubject ?? null,
      crmDateOpened: tk.crmDateOpened ? new Date(tk.crmDateOpened) : null,
      crmStatus: tk.crmStatus ?? null,
      crmContact: tk.crmContact ?? null,
      crmDescription: tk.crmDescription ?? null,
      crmPlatform: tk.crmPlatform ?? null,
      crmOwner: tk.crmOwner ?? null,
      attachedBy: user.id,
    })))
  }

  if (inserted && (inserted.crmWhatId || inserted.crmWhoId) && inserted.status === 'submitted' && inserted.crmSyncStatus === 'pending') {
    queueCrmActivitySync(inserted.id)
  }
  await maybeKickOutlookWriteback(inserted)
  maybeSyncOutlookEvent(inserted)
  if (inserted?.status === 'submitted') void emitActivityEvent('activity.submitted', inserted.id)

  res.status(201).json({ data: inserted, error: null, meta: {} })
})

// PATCH /api/activities/:id
activitiesRouter.patch('/:id', async (req, res) => {
  const id = req.params['id']!
  const user = req.user!

  const [existing] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, id), eq(activities.isArchived, false)))
    .limit(1)

  if (!existing) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
    return
  }

  if (existing.userId !== user.id) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }

  const daysSinceCreation = (Date.now() - new Date(existing.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSinceCreation > 90) {
    res.status(403).json({ data: null, error: 'errors.activities.read_only_after_90_days', meta: {} })
    return
  }

  const parsed = UpdateActivitySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ data: null, error: parsed.error.message, meta: {} })
    return
  }

  const data = parsed.data
  // A changed type must belong to the activity's team (audit M1, v1.422.0).
  if (data.activityTypeId !== undefined && data.activityTypeId !== existing.activityTypeId
    && !(await activityTypeVisibleToTeams(data.activityTypeId, [existing.teamId]))) {
    res.status(400).json({ data: null, error: 'errors.activities.type_not_on_team', meta: {} })
    return
  }
  // Campaigns, Leads or Projects switched off (Admin → Integrations):
  // an existing link of that kind may be kept, never newly set.
  const blockedLink = await crmLinkBlockError(data, existing)
  if (blockedLink) {
    res.status(403).json({ data: null, error: blockedLink, meta: {} })
    return
  }
  const project = await checkProjectLink(data, existing, existing.teamId)
  if (!project.ok) {
    res.status(project.status).json({ data: null, error: project.error, meta: {} })
    return
  }
  // Determine whether sync should be kicked: client-driven retry (crmSyncStatus='pending')
  // OR transition to submitted with an SF link.
  const willRetry = data.crmSyncStatus === 'pending' && !!existing.crmWhatId
  const nowSubmitting = data.status === 'submitted' && (data.crmWhatId ?? existing.crmWhatId)

  const [updated] = await db
    .update(activities)
    .set({
      ...(data.title !== undefined && { title: data.title }),
      ...(data.activityTypeId !== undefined && { activityTypeId: data.activityTypeId }),
      ...(data.subtypeId !== undefined && { subtypeId: data.subtypeId, subtypeName: await resolveSubtypeName(data.subtypeId) }),
      ...(data.meetingTypeReason !== undefined && { meetingTypeReason: data.meetingTypeReason }),
      ...(data.marketingEventName !== undefined && { marketingEventName: data.marketingEventName }),
      ...(data.isPrivateMeeting !== undefined && { isPrivateMeeting: data.isPrivateMeeting }),
      ...(data.startDatetime !== undefined && { startDatetime: new Date(data.startDatetime) }),
      ...(data.endDatetime !== undefined && { endDatetime: new Date(data.endDatetime) }),
      ...(data.effortHours !== undefined && { effortHours: String(data.effortHours) }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.descriptionBody !== undefined && { descriptionBody: data.descriptionBody }),
      ...(data.locationMode !== undefined && { locationMode: data.locationMode }),
      ...(data.meetingOwner !== undefined && { meetingOwner: data.meetingOwner }),
      ...(data.meetingOwnerEmail !== undefined && { meetingOwnerEmail: data.meetingOwnerEmail }),
      ...(data.attendees !== undefined && { attendees: data.attendees }),
      ...(data.acv !== undefined && { acv: data.acv != null ? String(data.acv) : null }),
      ...(data.costTransportation !== undefined && { costTransportation: data.costTransportation != null ? String(data.costTransportation) : null }),
      ...(data.costLodging !== undefined && { costLodging: data.costLodging != null ? String(data.costLodging) : null }),
      ...(data.costFood !== undefined && { costFood: data.costFood != null ? String(data.costFood) : null }),
      ...(data.incidentalCurrency !== undefined && { incidentalCurrency: data.incidentalCurrency ?? null }),
      ...(data.salesStage !== undefined && { salesStage: data.salesStage }),
      ...(data.forecastCategory !== undefined && { forecastCategory: data.forecastCategory }),
      ...(data.oppAmount !== undefined && { oppAmount: data.oppAmount != null ? String(data.oppAmount) : null }),
      ...(data.oppCloseDate !== undefined && { oppCloseDate: data.oppCloseDate }),
      ...(data.crmWhatId !== undefined && { crmWhatId: data.crmWhatId }),
      ...(data.crmWhatType !== undefined && { crmWhatType: data.crmWhatType }),
      ...(data.crmWhatName !== undefined && { crmWhatName: data.crmWhatName }),
      ...(data.crmAccountId !== undefined && { crmAccountId: data.crmAccountId }),
      ...(data.crmAccountName !== undefined && { crmAccountName: data.crmAccountName }),
      ...(data.crmAssignedSeName !== undefined && { crmAssignedSeName: data.crmAssignedSeName }),
      ...(data.crmWhoId !== undefined && { crmWhoId: data.crmWhoId }),
      ...(data.crmWhoType !== undefined && { crmWhoType: data.crmWhoType }),
      ...(data.crmWhoName !== undefined && { crmWhoName: data.crmWhoName }),
      ...(data.crmRelatedType !== undefined && { crmRelatedType: data.crmRelatedType }),
      ...(data.crmRelatedId !== undefined && { crmRelatedId: data.crmRelatedId }),
      ...(data.crmRelatedName !== undefined && { crmRelatedName: data.crmRelatedName }),
      ...(project.snapshot ?? {}),
      ...(data.status !== undefined && { status: data.status }),
      // v1.241.0: stamp the approval date on the draft -> submitted
      // transition only. Guarded on the EXISTING status so a later edit of an
      // already-submitted activity (which resends status: 'submitted'
      // unchanged) doesn't keep pushing the date forward — that's exactly the
      // updatedAt behavior this column exists to avoid.
      ...(data.status === 'submitted' && existing.status !== 'submitted' && { submittedAt: new Date() }),
      ...(nowSubmitting && { crmSyncStatus: 'pending', crmSyncError: null, crmSyncAttempts: 0, crmNextRetryAt: null }),
      ...(willRetry && { crmSyncStatus: 'pending', crmSyncError: null, crmSyncAttempts: 0, crmNextRetryAt: null }),
      updatedAt: new Date(),
    })
    .where(eq(activities.id, id))
    .returning()

  if (updated && data.productIds !== undefined) {
    const { activityProducts } = await import('../../../drizzle/schema.js')
    await db.delete(activityProducts).where(eq(activityProducts.activityId, id))
    if (data.productIds.length > 0) {
      await db.insert(activityProducts).values(data.productIds.map((pid) => ({ activityId: id, productId: pid })))
    }
  }

  if (updated && data.tickets !== undefined) {
    await db.delete(activityCrmTickets).where(eq(activityCrmTickets.activityId, id))
    if (data.tickets.length > 0) {
      await db.insert(activityCrmTickets).values(data.tickets.map((tk) => ({
        activityId: id,
        crmTicketId: tk.crmTicketId,
        crmTicketNumber: tk.crmTicketNumber,
        crmSubject: tk.crmSubject ?? null,
        crmDateOpened: tk.crmDateOpened ? new Date(tk.crmDateOpened) : null,
        crmStatus: tk.crmStatus ?? null,
        crmContact: tk.crmContact ?? null,
        crmDescription: tk.crmDescription ?? null,
        crmPlatform: tk.crmPlatform ?? null,
        crmOwner: tk.crmOwner ?? null,
        attachedBy: user.id,
      })))
    }
  }

  if (updated && (nowSubmitting || willRetry) && updated.crmSyncStatus === 'pending') {
    queueCrmActivitySync(updated.id)
  }
  await maybeKickOutlookWriteback(updated)
  maybeSyncOutlookEvent(updated)
  if (updated && data.status === 'submitted' && existing.status !== 'submitted') void emitActivityEvent('activity.submitted', updated.id)

  res.json({ data: updated, error: null, meta: {} })
})

// DELETE /api/activities/:id (soft delete via archive)
activitiesRouter.delete('/:id', async (req, res) => {
  const id = req.params['id']!
  const user = req.user!
  const deleteNotes = req.query['deleteNotes'] === '1' || (req.body as { deleteNotes?: unknown } | undefined)?.deleteNotes === true
  const deleteOutlookEvent = req.query['deleteOutlookEvent'] === '1' || (req.body as { deleteOutlookEvent?: unknown } | undefined)?.deleteOutlookEvent === true

  const [existing] = await db
    .select()
    .from(activities)
    .innerJoin(teamActivityTypes, eq(teamActivityTypes.id, activities.activityTypeId))
    .where(and(eq(activities.id, id), eq(activities.isArchived, false)))
    .limit(1)

  if (!existing) {
    res.status(404).json({ data: null, error: 'errors.not_found', meta: {} })
    return
  }

  const row = existing.activities
  const objectType = existing.team_activity_types.crmObjectType
  if (row.userId !== user.id) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }

  // If the activity is synced to SF, delete the SF Event/Task first so
  // the caller can rely on a single confirmation to remove the record
  // from both systems. SF failures are non-fatal (we still archive
  // locally) but surface in the response so the client can flag it.
  let sfError: string | null = null
  const onHubspot = (await getCrmProviderId()) === 'hubspot'
  if (row.crmRecordId && onHubspot) {
    // An adopted meeting (logged by HubSpot's own calendar sync) stays.
    if (!row.crmRecordAdopted) {
      const { deleteHubspotEngagement } = await import('../services/hubspot/writeback.js')
      sfError = await deleteHubspotEngagement(row.crmRecordId, objectType)
      if (sfError) console.warn('[/api/activities] HubSpot delete failed for', id, sfError)
    }
  } else if (row.crmRecordId) {
    try {
      const { getSfConnection } = await import('../services/salesforce/client.js')
      const conn = await getSfConnection(row.userId)
      if (conn) {
        await conn.sobject(objectType).destroy(row.crmRecordId)
      } else {
        sfError = 'Salesforce not connected — SF record left in place.'
      }
    } catch (err) {
      sfError = err instanceof Error ? err.message : String(err)
      // Ignore "already deleted" so re-runs don't error.
      if (!/ENTITY_IS_DELETED|INVALID_CROSS_REFERENCE_KEY/i.test(sfError)) {
        console.warn('[/api/activities] SF delete failed for', id, sfError)
      } else {
        sfError = null
      }
    }
  }

  // Optional: hard-delete related notes when the user asks. Notes live
  // on activity_notes with an activity_id FK; we don't touch the notes
  // table when unchecked so historical context survives.
  let notesDeleted = 0
  if (deleteNotes) {
    const del = await db.delete(activityNotes).where(eq(activityNotes.activityId, id)).returning({ id: activityNotes.id })
    notesDeleted = del.length
  }

  // Optional: also remove the event we wrote to the user's Outlook calendar,
  // so an Outlook-only activity doesn't linger there (and reappear as an
  // unapproved suggestion) after it's deleted here. Non-fatal.
  let outlookDeleted = false
  if (deleteOutlookEvent && row.outlookWritebackEventId) {
    try {
      const { deleteCalendarEvent } = await import('../services/outlook/client.js')
      outlookDeleted = await deleteCalendarEvent(row.userId, row.outlookWritebackEventId)
    } catch (err) {
      console.warn('[/api/activities] Outlook event delete failed for', id, err instanceof Error ? err.message : String(err))
    }
  }

  await db.update(activities).set({ isArchived: true, updatedAt: new Date() }).where(eq(activities.id, id))

  res.json({ data: { id, sfDeleted: !!row.crmRecordId && !sfError, notesDeleted, outlookDeleted }, error: sfError, meta: {} })
})

// POST /api/activities/import { teamId, csv, dryRun? }
// Personal backlog import: activities are always assigned to the caller. The
// team must be one the caller is a member of.
// POST /api/activities/:id/resync — owner-scoped force-resync of a
// single activity. Flips crmSyncStatus to 'pending' and kicks the
// writeback worker. Also clears crmSyncError so retries don't carry
// stale messages.
activitiesRouter.post('/:id/resync', async (req, res) => {
  const id = req.params['id']!
  const callerId = req.user!.id
  const [row] = await db.select({ userId: activities.userId, teamId: activities.teamId, status: activities.status, outlookEventId: activities.outlookEventId, title: activities.title, isPrivateMeeting: activities.isPrivateMeeting }).from(activities).where(eq(activities.id, id)).limit(1)
  if (!row) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
  if (row.userId !== callerId && !caller?.isAppAdmin) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  await db.update(activities).set({ crmSyncStatus: 'pending', crmSyncError: null, crmSyncAttempts: 0, crmNextRetryAt: null, updatedAt: new Date() }).where(eq(activities.id, id))
  queueCrmActivitySync(id)
  // Also re-attempt Outlook write-back (owner-opt-in gated inside).
  await maybeKickOutlookWriteback({ id, userId: row.userId, status: row.status, outlookEventId: row.outlookEventId })
  maybeSyncOutlookEvent({ id, userId: row.userId, status: row.status, outlookEventId: row.outlookEventId, title: row.title, isPrivateMeeting: row.isPrivateMeeting })
  res.json({ data: { id }, error: null, meta: {} })
})

// POST /api/activities/relink-opportunity { teamId, fromOppId, toOppId }
// vNext: Opportunity Relink (CLAUDE.md §7). A rep closes an Opportunity as
// Closed Lost/Duplicate, but the real work continued under a different
// Opportunity — ImpactIQ has no way to know that relationship on its own, so
// an App Admin / Team Admin / Team Leader points it there explicitly.
//
// requireRole('leader','admin') is deliberately used instead of
// requireDashboardAccess — this is a bulk WRITE with Salesforce side
// effects, not a read-only dashboard tab a Contributor could be granted via
// the Role Management matrix. requireRole is already team-scoped off
// req.body.teamId (CLAUDE.md §18's repeated "gate says yes but the query
// isn't scoped to the right team" lesson), unlike requireAnyLeaderOrAdmin
// (leader/admin on ANY team).
activitiesRouter.post('/relink-opportunity', requireRole('leader', 'admin'), async (req, res) => {
  const parsed = RelinkOpportunitySchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const { teamId, fromOppId, toOppId } = parsed.data
  const crm = await getCrmProviderId()
  // HubSpot installs get the same messages in Deal/HubSpot words.
  const sfx = crm === 'hubspot' ? '_hubspot' : ''
  if (fromOppId === toOppId) { res.status(400).json({ data: null, error: `errors.activities.relink_same_opp${sfx}`, meta: {} }); return }

  // Live read of the TARGET Opportunity via the admin SF connection — same
  // "org-wide snapshot write, never per-clicking-user" convention as the
  // manual "Refresh from Salesforce" button (CLAUDE.md §13). This is a
  // validation gate, not optional enrichment: never trust a client-supplied
  // SfSearch selection for a write with audit-log stakes — abort before
  // touching the database if the live read fails.
  //
  // On HubSpot (phase 7) the target Deal is read with the install's HubSpot
  // key, the portal-wide counterpart of the admin connection. A merged Deal
  // answers as the surviving Deal, whose id is what gets linked.
  let snapshot: RelinkSnapshotPatch | null
  if (crm === 'hubspot') {
    if (!HUBSPOT_ID_RX.test(toOppId)) { res.status(400).json({ data: null, error: 'errors.activities.relink_target_not_found_hubspot', meta: {} }); return }
    if (!(await getHubspotConfig())) { res.status(422).json({ data: null, error: 'errors.hubspot.not_configured', meta: {} }); return }
    try {
      snapshot = await readHubspotDealForRelink(toOppId)
    } catch (err) {
      res.status(502).json({ data: null, error: err instanceof HubspotError ? err.code : 'errors.activities.relink_failed', meta: {} })
      return
    }
    if (!snapshot) { res.status(422).json({ data: null, error: 'errors.activities.relink_target_not_found_hubspot', meta: {} }); return }
    if (snapshot.crmWhatId === fromOppId) { res.status(400).json({ data: null, error: 'errors.activities.relink_same_opp_hubspot', meta: {} }); return }
  } else if (crm === 'salesforce') {
    const conn = await getAdminSfConnection()
    if (!conn) { res.status(422).json({ data: null, error: 'no_admin_sf_connection', meta: {} }); return }
    snapshot = await fetchLiveOpportunitySnapshot(conn, toOppId)
    if (!snapshot) { res.status(422).json({ data: null, error: 'errors.activities.relink_target_not_found', meta: {} }); return }
  } else {
    res.status(409).json({ data: null, error: 'errors.crm.provider_mismatch', meta: {} })
    return
  }

  const [existing] = await db.select({ id: activities.id }).from(activities)
    .where(and(eq(activities.teamId, teamId), eq(activities.crmWhatType, 'Opportunity'), eq(activities.crmWhatId, fromOppId)))
    .limit(1)
  if (!existing) { res.status(404).json({ data: null, error: `errors.activities.relink_nothing_to_move${sfx}`, meta: {} }); return }

  const [fromOpp] = await db.select({ crmWhatName: activities.crmWhatName }).from(activities)
    .where(and(eq(activities.teamId, teamId), eq(activities.crmWhatType, 'Opportunity'), eq(activities.crmWhatId, fromOppId)))
    .limit(1)

  // All-time, every activity ImpactIQ has on the old Opp — draft and
  // submitted alike (CLAUDE.md §7: a data CORRECTION, not a leader-dashboard
  // read, so the "submitted only" rule doesn't apply here). Re-queuing for
  // Salesforce write-back is scoped separately (crmRecordId IS NOT NULL only)
  // — see applyOpportunityRelink()'s own comment for why.
  const { movedIds, requeuedIds } = await applyOpportunityRelink({ teamId, fromOppId, toOppId: snapshot.crmWhatId, snapshot })

  // Kick the poller inline for each re-queued row rather than waiting up to
  // 30s for its next tick — same convention as POST /:id/resync.
  for (const id of requeuedIds) queueCrmActivitySync(id)

  await logAudit(req, {
    action: 'activity.relink_opportunity',
    targetType: 'sf_opportunity',
    targetId: fromOppId,
    meta: {
      teamId,
      fromOppId,
      fromOppName: fromOpp?.crmWhatName ?? null,
      toOppId: snapshot.crmWhatId,
      crm,
      toOppName: snapshot.crmWhatName,
      activitiesUpdated: movedIds.length,
      requeuedForSync: requeuedIds.length,
    },
  })

  res.json({
    data: { activitiesUpdated: movedIds.length, requeuedForSync: requeuedIds.length, toOpp: { id: snapshot.crmWhatId, name: snapshot.crmWhatName } },
    error: null,
    meta: {},
  })
})

activitiesRouter.post('/import', async (req, res) => {
  const parsed = z.object({ teamId: z.string().uuid(), csv: z.string().min(1), dryRun: z.boolean().optional() }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const [membership] = await db.select({ userId: teamMembers.userId }).from(teamMembers)
    .where(and(eq(teamMembers.userId, req.user!.id), eq(teamMembers.teamId, parsed.data.teamId))).limit(1)
  if (!membership) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
  const { importActivitiesFromCsv } = await import('../services/activities/csvImport.js')
  const result = await importActivitiesFromCsv(parsed.data.csv, {
    teamId: parsed.data.teamId,
    defaultUserId: req.user!.id,
    allowUserEmailColumn: false,
    dryRun: parsed.data.dryRun ?? false,
  })
  res.json({ data: result, error: null, meta: {} })
})
