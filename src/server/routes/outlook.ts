import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { db } from '../db/index.js'
import { activities, outlookEvents, teamActivityTypes, teamMembers, userIntegrations, users, nonActivityEvents } from '../../../drizzle/schema.js'
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm'
import { fetchCalendarEvents, fetchCalendarEventsAsApp, type GraphAttendee, type GraphCalendarEvent } from '../services/outlook/client.js'
import { isMicrosoftConfigured } from '../services/auth/microsoft.js'
import { demoCalendarFor, isDemoCalendarUser } from '../services/demo/generator.js'
import { isOutlookAppOnlyEnabled, getOutlookSyncSettings } from '../services/config/integrations.js'
import { syncUserCalendar } from '../services/outlook/sync.js'
import { matchKeywords, classifyManyWithAI, matchUserNonActivity, matchPrivateSensitivity, type ClassificationResult } from '../services/ai/classify.js'

export const outlookRouter = Router()

outlookRouter.use(requireAuth)

// GET /api/outlook/status — does the current user have a connected MS account?
outlookRouter.get('/status', async (req, res) => {
  const [row] = await db
    .select({ id: userIntegrations.id, updatedAt: userIntegrations.updatedAt })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, req.user!.id), eq(userIntegrations.provider, 'microsoft')))
    .limit(1)

  // Demo mode applies only to demo users and the admin who generated the
  // data; everyone else sees their real connection state.
  const demoMode = await isDemoCalendarUser(req.user!.id)
  res.json({
    data: {
      // In demo mode, report connected so the calendar panel renders fixture
      // events instead of the "Connect Microsoft" CTA.
      connected: !!row || demoMode,
      configured: isMicrosoftConfigured() || demoMode,
      connectedAt: row?.updatedAt ?? null,
      demoMode,
    },
    error: null,
    meta: {},
  })
})

// GET /api/outlook/calendar?start=ISO&end=ISO
// Returns Graph events for the window, each tagged with `alreadyLogged` based on the user's
// activities. The outlook_event_id is included so the UI can pass it back for prefill, but
// activities themselves never expose it (per CLAUDE.md §10).
outlookRouter.get('/calendar', async (req, res) => {
  const callerId = req.user!.id
  const startIso = typeof req.query['start'] === 'string' ? req.query['start'] : undefined
  const endIso = typeof req.query['end'] === 'string' ? req.query['end'] : undefined
  const requestedUserId = (req.query['userId'] as string | undefined) || null
  if (!startIso || !endIso) {
    res.status(400).json({ data: null, error: 'errors.validation.date_range_required', meta: {} })
    return
  }

  // Person-switcher: viewing someone else's calendar requires the caller to be
  // an app admin OR a team_admin/admin on a team the target belongs to.
  let targetUserId = callerId
  let targetPersonName: string | null = null
  let targetUpn: string | null = null
  if (requestedUserId && requestedUserId !== callerId) {
    const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
    let allowed = !!caller?.isAppAdmin
    if (!allowed) {
      // team_admin / admin on any shared team?
      const shared = await db.select({ role: teamMembers.role, teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, callerId))
      const callerAdminTeams = shared.filter((m) => m.role === 'admin' || m.role === 'team_admin').map((m) => m.teamId)
      if (callerAdminTeams.length > 0) {
        const [match] = await db.select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, requestedUserId), inArray(teamMembers.teamId, callerAdminTeams)))
          .limit(1)
        allowed = !!match
      }
    }
    if (!allowed) {
      res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
      return
    }
    const [tgt] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, requestedUserId)).limit(1)
    if (!tgt) { res.status(404).json({ data: null, error: 'errors.user_not_found', meta: {} }); return }
    targetUserId = requestedUserId
    targetPersonName = tgt.displayName
    targetUpn = tgt.email
  }

  let events
  // Demo Outlook mode short-circuits Graph fetch and returns fixture events,
  // but only for demo users and the admin who generated the demo data.
  if (await isDemoCalendarUser(targetUserId)) {
    // v1.240.0: pass the viewer's real name/email so demo events include
    // them as organizer/attendee — see generator.ts's comment on why this
    // matters for the Optional/Required filter and badge.
    events = (await demoCalendarFor(targetUserId, startIso, endIso)) ?? []
  } else if (targetUserId !== callerId) {
    // Person switcher path — real Graph requires app-only permissions.
    const appOnly = await isOutlookAppOnlyEnabled()
    if (!appOnly || !targetUpn) {
      res.json({
        data: [],
        error: null,
        meta: { fallback: 'no_app_only_graph', personName: targetPersonName },
      })
      return
    }
    try {
      events = await fetchCalendarEventsAsApp(targetUpn, startIso, endIso)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(502).json({ data: null, error: `Calendar fetch failed: ${message}`, meta: { fallback: 'no_app_only_graph', personName: targetPersonName } })
      return
    }
    if (events === null) {
      res.json({ data: [], error: null, meta: { fallback: 'no_app_only_graph', personName: targetPersonName } })
      return
    }
  } else {
    // Own-calendar path: sync from Graph into outlook_events (throttled), then
    // serve the requested window from the DB. Return 401 if the user isn't
    // connected (sync returns null in that case with no prior watermark).
    //
    // v1.242.0: but only when the requested window is actually COVERED by what
    // the sync pulls. syncUserCalendar fetches [now-7d, now+forwardDays]; any
    // week outside that (browse back two weeks, or past the forward horizon)
    // had no cached rows at all, so this panel rendered empty while the left
    // list — which fetches Graph live per requested window — showed the same
    // meetings fine. The day-header counts come from that live data too, which
    // is why the header could read "6 meetings" above an empty column.
    const { forwardDays } = await getOutlookSyncSettings()
    const coverStart = new Date(Date.now() - 7 * 86400_000)
    const coverEnd = new Date(Date.now() + forwardDays * 86400_000)
    const reqStart = new Date(startIso)
    const reqEnd = new Date(endIso)
    const covered = reqStart >= coverStart && reqEnd <= coverEnd

    if (!covered) {
      // Outside the cache's horizon — read Graph directly for this window,
      // exactly as /suggestions does, rather than serving an empty slice.
      try {
        const live = await fetchCalendarEvents(callerId, startIso, endIso)
        if (live === null) {
          res.status(401).json({ data: null, error: 'errors.outlook.not_connected', meta: { connected: false } })
          return
        }
        events = live
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        res.status(502).json({ data: null, error: `Calendar fetch failed: ${message}`, meta: {} })
        return
      }
    } else {
    const [wm] = await db.select({ last: users.outlookEventsLastSyncedAt }).from(users).where(eq(users.id, callerId)).limit(1)
    try {
      const syncResult = await syncUserCalendar(callerId, { maxAgeMs: 60_000 })
      if (syncResult === null && !wm?.last) {
        res.status(401).json({ data: null, error: 'errors.outlook.not_connected', meta: { connected: false } })
        return
      }
    } catch (err) {
      // If we already have prior data, still serve from DB — sync errors are
      // non-fatal to the read path.
      if (!wm?.last) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        res.status(502).json({ data: null, error: `Calendar fetch failed: ${message}`, meta: {} })
        return
      }
    }
    const rows = await db
      .select()
      .from(outlookEvents)
      .where(and(
        eq(outlookEvents.userId, callerId),
        gte(outlookEvents.startDatetime, new Date(startIso)),
        lte(outlookEvents.startDatetime, new Date(endIso)),
      ))
    events = rows.map((r): GraphCalendarEvent => {
      const ev: GraphCalendarEvent = {
        id: r.id,
        subject: r.subject ?? '(No subject)',
        start: r.startDatetime.toISOString(),
        end: r.endDatetime.toISOString(),
        isAllDay: r.isAllDay,
        bodyPreview: r.bodyPreview ?? '',
      }
      if (r.location) ev.location = r.location
      if (r.organizerEmail) ev.organizer = { name: r.organizerName ?? '', email: r.organizerEmail }
      if (Array.isArray(r.attendees)) ev.attendees = r.attendees as GraphAttendee[]
      if (r.eventType) ev.eventType = r.eventType
      if (r.seriesMasterId) ev.seriesMasterId = r.seriesMasterId
      // v1.242.0: these three are persisted by syncUserCalendar but were
      // never mapped back OUT here, so the own-calendar path (the normal
      // case) served them as undefined. That's why the tentative hatch showed
      // on the left list — /suggestions fetches Graph live — but never on the
      // right calendar, which reads this cache. Same class of bug the upsert
      // in sync.ts already carries a warning comment about: a column added to
      // one half of a mapping and not the other.
      if (r.responseStatus) ev.responseStatus = r.responseStatus
      if (r.showAs) ev.showAs = r.showAs
      if (r.isCancelled !== null) ev.isCancelled = r.isCancelled
      if (r.sensitivity) ev.sensitivity = r.sensitivity
      return ev
    })
    }
  }

  // Mark already-logged events by checking which outlook_event_ids exist in the target's activities,
  // and attach the linked activity type's color/icon for calendar tinting.
  const eventIds = events.map((e) => e.id)
  const linkedRows = eventIds.length
    ? await db
        .select({
          outlookEventId: activities.outlookEventId,
          outlookWritebackEventId: activities.outlookWritebackEventId,
          color: teamActivityTypes.color,
          icon: teamActivityTypes.icon,
        })
        .from(activities)
        .innerJoin(teamActivityTypes, eq(activities.activityTypeId, teamActivityTypes.id))
        .where(
          and(
            eq(activities.userId, targetUserId),
            eq(activities.isArchived, false),
            or(inArray(activities.outlookEventId, eventIds), inArray(activities.outlookWritebackEventId, eventIds)),
          ),
        )
    : []
  // Map BOTH the inbound-meeting id and the written-back event id to the
  // activity type color/icon so an ImpactIQ-created event shows as
  // already-logged on the calendar rather than a fresh untracked meeting.
  const linkedMap = new Map<string, { color: string | null; icon: string | null }>()
  for (const r of linkedRows) {
    if (r.outlookEventId) linkedMap.set(r.outlookEventId, { color: r.color, icon: r.icon })
    if (r.outlookWritebackEventId) linkedMap.set(r.outlookWritebackEventId, { color: r.color, icon: r.icon })
  }

  const decorated = events.map((e) => {
    const linked = linkedMap.get(e.id)
    return {
      ...e,
      alreadyLogged: !!linked,
      activityTypeColor: linked?.color ?? null,
      activityTypeIcon: linked?.icon ?? null,
      // v1.262.0: same derivation as /suggestions — see CLAUDE.md §7 Private
      // Meetings. Drives the masked title + lock icon on calendar blocks and
      // the event details modal. Cast because `events` can also be demo-mode
      // fixture rows, which never carry `sensitivity`.
      isPrivate: (e as { sensitivity?: string }).sensitivity === 'private' || (e as { sensitivity?: string }).sensitivity === 'confidential',
    }
  })
  const meta: Record<string, unknown> = { count: decorated.length }
  if (targetPersonName) meta['personName'] = targetPersonName
  res.json({ data: decorated, error: null, meta })
})

// GET /api/outlook/suggestions?teamId=&start=&end=&userId=
// Returns unlinked Outlook events (no matching activity) with a suggested
// activity type from the keyword rules first, AI classifier as fallback.
outlookRouter.get('/suggestions', async (req, res) => {
  const callerId = req.user!.id
  const teamId = req.query['teamId'] as string | undefined
  const startIso = typeof req.query['start'] === 'string' ? req.query['start'] : undefined
  const endIso = typeof req.query['end'] === 'string' ? req.query['end'] : undefined
  const requestedUserId = (req.query['userId'] as string | undefined) || null
  if (!teamId || !startIso || !endIso) { res.status(400).json({ data: null, error: 'errors.validation.date_range_required', meta: {} }); return }

  // Same permission model as /calendar for viewing another user's data.
  let targetUserId = callerId
  if (requestedUserId && requestedUserId !== callerId) {
    const [caller] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, callerId)).limit(1)
    let allowed = !!caller?.isAppAdmin
    if (!allowed) {
      const shared = await db.select({ role: teamMembers.role, teamId: teamMembers.teamId })
        .from(teamMembers).where(eq(teamMembers.userId, callerId))
      const callerAdminTeams = shared.filter((m) => m.role === 'admin' || m.role === 'team_admin').map((m) => m.teamId)
      if (callerAdminTeams.length > 0) {
        const [match] = await db.select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, requestedUserId), inArray(teamMembers.teamId, callerAdminTeams)))
          .limit(1)
        allowed = !!match
      }
    }
    if (!allowed) { res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} }); return }
    targetUserId = requestedUserId
  }

  let events
  if (await isDemoCalendarUser(targetUserId)) {
    events = (await demoCalendarFor(targetUserId, startIso, endIso)) ?? []
  } else {
    try {
      events = await fetchCalendarEvents(targetUserId, startIso, endIso)
    } catch {
      events = null
    }
    if (events === null) { res.json({ data: [], error: null, meta: {} }); return }
  }

  // Filter out events already linked to an activity — either the inbound
  // meeting an activity was created FROM (outlookEventId) or an event we
  // WROTE to the calendar for a logged activity (outlookWritebackEventId,
  // v1.156.0). Without the second, a written-back event reappears here as a
  // duplicate suggested card.
  const eventIds = events.map((e) => e.id)
  const linked = eventIds.length ? await db.select({ outlookEventId: activities.outlookEventId, outlookWritebackEventId: activities.outlookWritebackEventId })
    .from(activities)
    .where(and(
      eq(activities.userId, targetUserId),
      eq(activities.isArchived, false),
      or(inArray(activities.outlookEventId, eventIds), inArray(activities.outlookWritebackEventId, eventIds)),
    )) : []
  const linkedSet = new Set<string>()
  for (const r of linked) {
    if (r.outlookEventId) linkedSet.add(r.outlookEventId)
    if (r.outlookWritebackEventId) linkedSet.add(r.outlookWritebackEventId)
  }
  const unlinked = events.filter((e) => !linkedSet.has(e.id))

  // v1.91.0: pull the cached SF suggestions for every unlinked event in
  // one shot. Zero SF calls here — the batch compute runs inside
  // syncUserCalendar, so we just read the columns.
  const cachedSf = unlinked.length ? await db.select({
    id: outlookEvents.id,
    suggestedCrmAccountId: outlookEvents.suggestedCrmAccountId,
    suggestedCrmAccountName: outlookEvents.suggestedCrmAccountName,
    suggestedCrmOpportunityId: outlookEvents.suggestedCrmOpportunityId,
    suggestedCrmOpportunityName: outlookEvents.suggestedCrmOpportunityName,
    suggestedCrmOpportunityAccountId: outlookEvents.suggestedCrmOpportunityAccountId,
    suggestedCrmOpportunityAccountName: outlookEvents.suggestedCrmOpportunityAccountName,
    crmSuggestionCandidates: outlookEvents.crmSuggestionCandidates,
    userOverrideCrmWhatId: outlookEvents.userOverrideCrmWhatId,
    userOverrideCrmWhatType: outlookEvents.userOverrideCrmWhatType,
    userOverrideCrmWhatName: outlookEvents.userOverrideCrmWhatName,
  }).from(outlookEvents).where(and(eq(outlookEvents.userId, targetUserId), inArray(outlookEvents.id, unlinked.map((e) => e.id)))) : []
  const sfByEvent = new Map(cachedSf.map((r) => [r.id, r]))

  // Look up activity type meta for coloring the suggested cards.
  const types = await db.select().from(teamActivityTypes).where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.isActive, true)))
  const typeById = new Map(types.map((t) => [t.id, t]))
  // v1.240.0: the type the "nothing matched" fallback uses — ONLY when an
  // admin has explicitly set one. Previously this fell back to the lowest
  // sortOrder active type, which was still a guess nobody configured (it
  // just replaced one accidental default — "Demo", from an unordered query —
  // with another). When no default is configured the event stays UNTYPED and
  // the card renders a "No Match" pill.
  const defaultType = types.find((t) => t.isDefaultSuggestion) ?? null

  // v1.262.0: the seeded inactive "None" row (CLAUDE.md §7 — is_active=false,
  // sort_order=999) is the Non-Activity display anchor; its color drives the
  // Private Meeting card background when configured, falling back to plain
  // light gray otherwise. Looked up structurally (sortOrder, not by name —
  // same "don't hardcode a name check" rule the picker filter already
  // follows) since a team could have other inactive/deactivated types too.
  const [nonActivityAnchor] = await db.select({ color: teamActivityTypes.color })
    .from(teamActivityTypes)
    .where(and(eq(teamActivityTypes.teamId, teamId), eq(teamActivityTypes.isActive, false), eq(teamActivityTypes.sortOrder, 999)))
    .limit(1)

  // Classify each unlinked event. Pass 1 runs the rules per event (in
  // parallel, bounded by unlinked.length, typically ≤ 15 a week).
  const ruleResults = await Promise.all(unlinked.map(async (e): Promise<ClassificationResult | null> => {
    let result = await matchKeywords(teamId, e.subject, (e.bodyPreview ?? undefined))
    // v1.262.0: Outlook's own privacy marking, between the admin rules and
    // the user's own subject-keyword list — see matchPrivateSensitivity's
    // doc comment for why it sits in this exact spot. Scoped to
    // targetUserId, same reasoning as the keyword list below.
    if (!result) {
      try {
        result = await matchPrivateSensitivity(targetUserId, (e as { sensitivity?: string }).sensitivity)
      } catch { result = null }
    }
    // v1.243.0: the viewer's OWN Non-Activity subject keywords, between the
    // admin rules and the AI classifier. Scoped to targetUserId — these are
    // personal, so viewing another user's week correctly applies THEIR list,
    // not the caller's.
    if (!result) {
      try {
        result = await matchUserNonActivity(targetUserId, e.subject)
      } catch { result = null }
    }
    return result
  }))

  // Pass 2 (v1.473.0): every event no rule matched goes to the AI in ONE
  // request (classifyManyWithAI), not one request per meeting, charged to the
  // person whose calendar this is. Usage shows how many meetings it covered.
  const unmatched = unlinked.map((e, i) => ({ e, i })).filter(({ i }) => !ruleResults[i])
  if (unmatched.length > 0) {
    try {
      const aiResults = await classifyManyWithAI(
        teamId,
        unmatched.map(({ e }) => ({ subject: e.subject, body: e.bodyPreview ?? undefined })),
        targetUserId,
      )
      unmatched.forEach(({ i }, n) => { ruleResults[i] = aiResults[n] ?? null })
    } catch { /* AI is a suggestion only; fall through to the default below */ }
  }

  const suggestions = await Promise.all(unlinked.map(async (e, i) => {
    let result = ruleResults[i] ?? null
    // Fallback when nothing matched: the admin-configured default if there is
    // one, else NO type at all.
    //
    // v1.241.0: "no match" is deliberately NOT the same thing as Non-Activity.
    // v1.240.0 resolved it to mark_non_activity, which auto-hid these events
    // behind the Show Non-Activities toggle — so the meetings most in need of
    // a human decision were the ones that disappeared from the list. An
    // unmatched meeting is unclassified, not excluded: it stays visible,
    // approvable, and marked "No Match" so the contributor can pick a type.
    if (!result) {
      result = defaultType
        ? { activityTypeId: defaultType.id, activityTypeName: defaultType.name, confidence: 0.2, source: 'none' as const, action: 'suggest_type' as const }
        : { activityTypeId: null, activityTypeName: null, confidence: 0, source: 'none' as const, action: 'suggest_type' as const }
    }
    // v1.240.0: a keyword rule can auto-classify an event as Non-Activity
    // instead of suggesting a type. Mirrors exactly what the manual "Non-
    // Activity" button does — an upsert into the same per-user table — so
    // it's reversible via the existing "Mark as Activity" affordance and
    // never touches `activities` (CLAUDE.md §7). Idempotent + best-effort:
    // this route is polled, so a failed write here just retries next poll
    // rather than failing the whole suggestions response.
    if (result?.action === 'mark_non_activity') {
      try {
        await db.insert(nonActivityEvents).values({ userId: targetUserId, outlookEventId: e.id }).onConflictDoNothing()
      } catch { /* non-fatal — retried on next poll */ }
    }
    const type = result?.activityTypeId ? typeById.get(result.activityTypeId) : null
    return {
      outlookEventId: e.id,
      subject: e.subject,
      start: e.start,
      end: e.end,
      bodyPreview: e.bodyPreview ?? null,
      suggestedActivityTypeId: result?.activityTypeId ?? null,
      suggestedActivityTypeName: result?.activityTypeName ?? null,
      suggestedActivityTypeColor: type?.color ?? null,
      suggestedActivityTypeIcon: type?.icon ?? null,
      suggestionSource: result?.source ?? 'none',
      suggestionConfidence: result?.confidence ?? 0,
      matchedKeywords: result?.matchedKeywords ?? null,
      matchedRuleId: result?.matchedRuleId ?? null,
      matchedRuleField: result?.matchedRuleField ?? null,
      // v1.240.0: mirrors the non_activity_events upsert above so the client
      // can render/filter this correctly on the SAME response, rather than
      // waiting for the next poll of the separate useNonActivities() list to
      // catch up with the write that just happened.
      isNonActivitySuggestion: result?.action === 'mark_non_activity',
      // v1.262.0: independent of isNonActivitySuggestion above — a private
      // meeting still renders the Private Meeting card treatment (pill,
      // lock icon, masked title) even when the user has turned off
      // "Private meetings → Non-Activity" and it's showing as a normal
      // suggestion needing a type.
      isPrivate: (e as { sensitivity?: string }).sensitivity === 'private' || (e as { sensitivity?: string }).sensitivity === 'confidential',
      meetingOwner: e.organizer ? (e.organizer.name || e.organizer.email) : null,
      // v1.240.0: lets the client resolve "am I required/optional" even for
      // a meeting the current user organized — Graph omits the organizer
      // from `attendees` entirely, so without this an organizer-owned
      // meeting (a self-scheduled call later marked Non-Activity, say) had no
      // way to resolve as Required and got hidden by the Optional/Required
      // filter no matter which state was selected.
      // v1.241.0: the current user's own RSVP, so the card can render the
      // tentative hatch. Already on the Graph event; this route just wasn't
      // forwarding it.
      responseStatus: e.responseStatus ?? null,
      organizerEmail: e.organizer?.email ?? null,
      // v1.239.0: was stripped to {name,email} — the client's Log Activity
      // form now shows a read-only "meeting responses" summary when it opens
      // from a suggested meeting, so response/type need to survive this hop
      // (already present on GraphAttendee; this route was the one place
      // dropping them).
      attendees: (e.attendees ?? []).map((a) => ({ name: a.name, email: a.email, response: a.response, type: a.type })),
      // v1.91.0: cached SF Account + Opportunity chips + candidates + override
      suggestedAccount: sfByEvent.get(e.id)?.suggestedCrmAccountId
        ? { id: sfByEvent.get(e.id)!.suggestedCrmAccountId!, name: sfByEvent.get(e.id)!.suggestedCrmAccountName ?? '' }
        : null,
      suggestedOpportunity: sfByEvent.get(e.id)?.suggestedCrmOpportunityId
        ? {
            id: sfByEvent.get(e.id)!.suggestedCrmOpportunityId!,
            name: sfByEvent.get(e.id)!.suggestedCrmOpportunityName ?? '',
            accountId: sfByEvent.get(e.id)!.suggestedCrmOpportunityAccountId ?? null,
            accountName: sfByEvent.get(e.id)!.suggestedCrmOpportunityAccountName ?? null,
          }
        : null,
      suggestionCandidates: (sfByEvent.get(e.id)?.crmSuggestionCandidates ?? null) as Array<{ id: string; name: string; type: 'Account' | 'Opportunity'; detail?: string | null }> | null,
      userOverrideSfWhat: sfByEvent.get(e.id)?.userOverrideCrmWhatId
        ? {
            id: sfByEvent.get(e.id)!.userOverrideCrmWhatId!,
            type: sfByEvent.get(e.id)!.userOverrideCrmWhatType as 'Account' | 'Opportunity',
            name: sfByEvent.get(e.id)!.userOverrideCrmWhatName ?? '',
          }
        : null,
    }
  }))

  res.json({ data: suggestions, error: null, meta: { count: suggestions.length, nonActivityColor: nonActivityAnchor?.color ?? null } })
})

// v1.162.0: effective internal email domains for write-back — the configured
// list, or (when unset) the caller's own login-email domain as a fallback.
// Powers the "who gets an Outlook invite" note in the Log Activity drawer.
outlookRouter.get('/writeback-config', async (req, res) => {
  const { internalEmailDomains } = await getOutlookSyncSettings()
  let domains = internalEmailDomains
  if (domains.length === 0) {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user!.id)).limit(1)
    if (u?.email && u.email.includes('@')) domains = [u.email.split('@')[1]!.toLowerCase()]
  }
  res.json({ data: { internalDomains: domains }, error: null, meta: {} })
})

// v1.91.0: manual Outlook refresh. Client-side throttled to 1 per 10 min;
// server-side, syncUserCalendar's internal freshness check protects the
// shared Graph quota. Force=true bypasses the client-visible watermark so a
// user click always runs the sync — the internal per-user gate still stops
// runaway loops.
outlookRouter.post('/refresh', async (req, res) => {
  const userId = req.user!.id
  try {
    const result = await syncUserCalendar(userId, { force: true })
    if (result === null) {
      res.status(401).json({ data: null, error: 'errors.outlook.not_connected', meta: {} })
      return
    }
    res.json({ data: result, error: null, meta: {} })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ data: null, error: `Calendar refresh failed: ${message}`, meta: {} })
  }
})

// v1.91.0: recompute SF Account+Opportunity suggestion for a single event.
// Server-throttled to one recompute per event per 10s so click-spam on the
// chip Refresh icon doesn't hammer SF. Returns the fresh chip payload.
const recomputeLastAt = new Map<string, number>()
outlookRouter.post('/suggestions/:eventId/recompute', async (req, res) => {
  const { eventId } = req.params as { eventId: string }
  const userId = req.user!.id
  const key = `${userId}::${eventId}`
  const last = recomputeLastAt.get(key) ?? 0
  if (Date.now() - last < 10_000) {
    res.status(429).json({ data: null, error: 'errors.outlook.recompute_throttled', meta: {} })
    return
  }
  recomputeLastAt.set(key, Date.now())
  const { computeSfSuggestionsBatch } = await import('../services/outlook/sync.js')
  // Zero the cached timestamp for this event so the batch compute picks it up.
  await db.update(outlookEvents).set({ crmSuggestionComputedAt: null }).where(and(eq(outlookEvents.id, eventId), eq(outlookEvents.userId, userId)))
  await computeSfSuggestionsBatch(userId, [eventId], { force: true })
  const [row] = await db.select({
    suggestedCrmAccountId: outlookEvents.suggestedCrmAccountId,
    suggestedCrmAccountName: outlookEvents.suggestedCrmAccountName,
    suggestedCrmOpportunityId: outlookEvents.suggestedCrmOpportunityId,
    suggestedCrmOpportunityName: outlookEvents.suggestedCrmOpportunityName,
    suggestedCrmOpportunityAccountId: outlookEvents.suggestedCrmOpportunityAccountId,
    suggestedCrmOpportunityAccountName: outlookEvents.suggestedCrmOpportunityAccountName,
    crmSuggestionCandidates: outlookEvents.crmSuggestionCandidates,
  }).from(outlookEvents).where(and(eq(outlookEvents.id, eventId), eq(outlookEvents.userId, userId))).limit(1)
  res.json({
    data: {
      suggestedAccount: row?.suggestedCrmAccountId ? { id: row.suggestedCrmAccountId, name: row.suggestedCrmAccountName ?? '' } : null,
      suggestedOpportunity: row?.suggestedCrmOpportunityId
        ? { id: row.suggestedCrmOpportunityId, name: row.suggestedCrmOpportunityName ?? '', accountId: row.suggestedCrmOpportunityAccountId ?? null, accountName: row.suggestedCrmOpportunityAccountName ?? null }
        : null,
      suggestionCandidates: row?.crmSuggestionCandidates ?? null,
    },
    error: null,
    meta: {},
  })
})

// v1.91.0: persist the user's pick from the chip dropdown so it survives
// across resyncs (24h TTL doesn't clobber it). Approve() reads this first
// when writing the activity's crmWhatId/Type/Name.
outlookRouter.patch('/suggestions/:eventId/override', async (req, res) => {
  const { eventId } = req.params as { eventId: string }
  const userId = req.user!.id
  const body = req.body as { id?: string | null; type?: 'Account' | 'Opportunity' | null; name?: string | null }
  if (!body || (body.id && !body.type)) {
    res.status(400).json({ data: null, error: 'errors.validation.override_shape', meta: {} })
    return
  }
  await db.update(outlookEvents).set({
    userOverrideCrmWhatId: body.id ?? null,
    userOverrideCrmWhatType: body.type ?? null,
    userOverrideCrmWhatName: body.name ?? null,
  }).where(and(eq(outlookEvents.id, eventId), eq(outlookEvents.userId, userId)))
  res.json({ data: { ok: true }, error: null, meta: {} })
})
